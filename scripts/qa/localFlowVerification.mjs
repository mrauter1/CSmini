import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_URL = "http://127.0.0.1:4173/";
const PREVIEW_PORT = "4173";
const DEBUG_PORT = "9223";
const DEBUG_ORIGIN = `http://127.0.0.1:${DEBUG_PORT}`;
const MAP_ID = "sandline-foundry";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // Poll until the target is ready.
    }

    await delay(200);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJsonNew(url) {
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(`${DEBUG_ORIGIN}/json/new?${encodeURIComponent(url)}`, {
        method,
      });
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Try the next fallback method.
    }
  }

  throw new Error(`Could not create a new Chrome target for ${url}`);
}

function startProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  const stdout = [];
  const stderr = [];
  const pushLine = (lines, chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    lines.push(text);
    if (lines.length > 40) {
      lines.shift();
    }
  };

  child.stdout?.on("data", (chunk) => pushLine(stdout, chunk));
  child.stderr?.on("data", (chunk) => pushLine(stderr, chunk));

  return { child, stdout, stderr };
}

async function stopProcess(record) {
  const child = record?.child;
  if (!child?.pid) {
    return;
  }

  const processGroupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };

  const killTree = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };

  if (!processGroupExists()) {
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      delay(250),
    ]);
    return;
  }

  const waitForProcessGroupExit = async (timeoutMs) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (!processGroupExists()) {
        return true;
      }
      await delay(100);
    }

    return !processGroupExists();
  };

  killTree("SIGTERM");
  if (await waitForProcessGroupExit(2_000)) {
    return;
  }

  killTree("SIGKILL");
  await waitForProcessGroupExit(2_000);
}

class CdpPage {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.openPromise = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", (event) => reject(event.error ?? event));
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }

        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
          return;
        }

        pending.resolve(message.result ?? {});
      }
    });
  }

  async ready() {
    await this.openPromise;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    this.socket.close();
    await delay(50);
  }

  async send(method, params = {}) {
    await this.ready();

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
      setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}`));
      }, 10_000).unref?.();
    });

    return result;
  }

  async enablePage(width = 1440, height = 900) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
    });

    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Unknown evaluation error";
      throw new Error(description);
    }

    return result.result?.value;
  }

  async waitForExpression(expression, timeoutMs = 10_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const value = await this.evaluate(expression);
      if (value) {
        return value;
      }
      await delay(100);
    }

    throw new Error(`Timed out waiting for expression: ${expression}`);
  }
}

async function createPage(url) {
  const target = await requestJsonNew("about:blank");
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.enablePage();
  await page.send("Page.navigate", { url });
  await page.waitForExpression("document.readyState === 'complete'");
  await page.waitForExpression("Boolean(window.__dustlineQa__)", 15_000);
  return page;
}

async function click(page, selector) {
  const escaped = JSON.stringify(selector);
  const clicked = await page.evaluate(`
    (() => {
      const button = document.querySelector(${escaped});
      if (!button) {
        return false;
      }
      button.click();
      return true;
    })()
  `);

  assert(clicked, `Missing clickable selector: ${selector}`);
}

async function waitForMatch(page, mapId, timeoutMs = 15_000) {
  await page.waitForExpression(
    `window.__dustlineQa__?.getState()?.match?.mapId === ${JSON.stringify(mapId)}`,
    timeoutMs,
  );
}

async function engageControls(page) {
  await page.waitForExpression(
    "Boolean(window.__dustlineQa__?.getState()?.match?.localPlayer)",
    10_000,
  );
  await page.evaluate("window.__dustlineQa__.engageControls()");
  await page.waitForExpression(
    "document.querySelector('[data-ui=\"prompt-panel\"]')?.hidden === true",
    5_000,
  );
}

async function startPreview() {
  const preview = startProcess("npm", [
    "run",
    "preview",
    "--",
    "--host",
    "127.0.0.1",
    "--strictPort",
    "--port",
    PREVIEW_PORT,
  ]);
  await waitForHttp(ROOT_URL);
  return preview;
}

async function startChrome() {
  const userDataDir = path.join("/tmp", `dustline-local-flow-${Date.now()}`);
  await rm(userDataDir, { recursive: true, force: true });

  const chrome = startProcess("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  await waitForHttp(`${DEBUG_ORIGIN}/json/version`);
  return chrome;
}

async function main() {
  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    const page = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(page);

    await page.waitForExpression("Boolean(document.querySelector('.screen--menu'))", 10_000);
    await click(page, '[data-action="show-catalog"]');

    const mapCards = await page.waitForExpression(
      "document.querySelectorAll('.map-card').length === 5 && document.querySelectorAll('.map-card').length",
      10_000,
    );

    await page.evaluate(`window.__dustlineQa__.openMap(${JSON.stringify(MAP_ID)}, "local")`);
    await page.waitForExpression("Boolean(document.querySelector('.screen--match'))", 10_000);
    await waitForMatch(page, MAP_ID);

    const ammoBefore = await page.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.ammoInClip ?? -1",
    );
    assert(ammoBefore === 24, `Expected full local ammo, saw ${ammoBefore}`);

    await engageControls(page);
    const promptHidden = await page.evaluate(
      "document.querySelector('[data-ui=\"prompt-panel\"]')?.hidden === true",
    );
    assert(promptHidden === true, "Local control prompt did not hide after engage.");

    await page.evaluate("window.__dustlineQa__.fire()");
    await page.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.localPlayer?.ammoInClip ?? -1) === 23",
      5_000,
    );
    const ammoAfter = await page.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.ammoInClip ?? -1",
    );

    await page.evaluate("window.__dustlineQa__.forcePlayerDeath('QA Rig')");
    await page.waitForExpression(
      "document.querySelector('[data-ui=\"death-panel\"]') && !document.querySelector('[data-ui=\"death-panel\"]').hidden",
      5_000,
    );
    const deathLine = await page.evaluate(
      "document.querySelector('[data-ui=\"death\"]')?.textContent ?? ''",
    );

    await page.evaluate("window.__dustlineQa__.returnToCatalog()");
    await page.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'catalog'", 10_000);
    await page.waitForExpression("document.querySelectorAll('canvas').length === 0", 5_000);

    console.log(
      JSON.stringify(
        {
          mapCards,
          ammoBefore,
          ammoAfter,
          promptHidden,
          deathLine,
          finalScreen: await page.evaluate("window.__dustlineQa__?.getState()?.screen ?? null"),
          canvasCountAfterReturn: await page.evaluate("document.querySelectorAll('canvas').length"),
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled(pages.map((page) => page.close()));
    await stopProcess(chrome);
    await stopProcess(preview);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
