import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_URL = "http://127.0.0.1:4173/";
const PREVIEW_PORT = "4173";
const DEBUG_PORT = "9223";
const DEBUG_ORIGIN = `http://127.0.0.1:${DEBUG_PORT}`;
const SCREENSHOT_DIR = path.join(ROOT, "assets", "screenshots");

const SCREENSHOTS = [
  "01-menu-briefing.png",
  "02-map-select-roster.png",
  "03-sandline-spawn-view.png",
  "04-sandline-central-yard.png",
  "05-sandline-generator-hall.png",
  "06-sandline-drain-underpass.png",
  "07-sandline-east-catwalk.png",
  "08-weapon-idle-hud.png",
  "09-weapon-firing-hud.png",
  "10-opposing-player.png",
  "11-death-respawn-state.png",
  "12-two-player-multiplayer.png",
];

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
  if (!record?.child || record.child.killed) {
    return;
  }

  record.child.kill("SIGTERM");

  await Promise.race([
    new Promise((resolve) => record.child.once("exit", resolve)),
    delay(2_000).then(() => {
      if (!record.child.killed) {
        record.child.kill("SIGKILL");
      }
    }),
  ]);
}

class CdpPage {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
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
        return;
      }

      const handlers = this.eventHandlers.get(message.method);
      if (!handlers) {
        return;
      }

      for (const handler of handlers) {
        handler(message.params ?? {});
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

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
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

  async bringToFront() {
    await this.send("Page.bringToFront");
    await delay(120);
  }

  async captureScreenshot(filename) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });

    const outputPath = path.join(SCREENSHOT_DIR, filename);
    await writeFile(outputPath, Buffer.from(result.data, "base64"));
    return outputPath;
  }
}

async function createPage(url, initScript) {
  const target = await requestJsonNew("about:blank");
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.enablePage();

  if (initScript) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
  }

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

async function waitForMap(page, mapId) {
  await page.waitForExpression(
    `window.__dustlineQa__?.getState()?.mapId === ${JSON.stringify(mapId)}`,
    15_000,
  );
}

async function engageControls(page) {
  await page.waitForExpression("Boolean(window.__dustlineQa__?.getState())", 10_000);
  await page.evaluate("window.__dustlineQa__.engageControls()");
  await page.waitForExpression(
    "document.querySelector('[data-ui=\"prompt-panel\"]')?.hidden === true",
    5_000,
  );
  await delay(150);
}

async function ensureControlsEngaged(page) {
  const promptVisible = await page.evaluate(`
    Boolean(
      document.querySelector('[data-ui="prompt-panel"]')
        && !document.querySelector('[data-ui="prompt-panel"]').hidden
    )
  `);

  if (!promptVisible) {
    return;
  }

  await engageControls(page);
}

async function getState(page) {
  return page.evaluate("window.__dustlineQa__?.getState() ?? null");
}

async function openMap(page, mapId, mode) {
  await page.evaluate(
    `window.__dustlineQa__.openMap(${JSON.stringify(mapId)}, ${JSON.stringify(mode)})`,
  );
  await waitForMap(page, mapId);
  await page.waitForExpression("Boolean(document.querySelector('.screen--match'))", 10_000);
}

async function setView(page, from, to) {
  await page.evaluate(
    `window.__dustlineQa__.setView(${from.x}, ${from.y}, ${from.z}, ${to.x}, ${to.y}, ${to.z})`,
  );
  await delay(140);
}

async function stageSharedDuel(page, slot) {
  const pose = await page.evaluate(`window.__dustlineQa__.stageSharedDuel(${slot})`);
  assert(pose, `Could not stage shared duel pose for slot ${slot}`);
  await delay(180);
  return pose;
}

async function waitForRemotePosition(page, expected, timeoutMs = 5_000) {
  await page.waitForExpression(
    `
      (() => {
        const remote = window.__dustlineQa__?.getState()?.remotePlayers?.[0]?.position;
        return remote
          && Math.abs(remote.x - ${expected.x}) < 1
          && Math.abs(remote.z - ${expected.z}) < 1;
      })()
    `,
    timeoutMs,
  );
}

async function forceDeath(page, attackerName) {
  await page.evaluate(`window.__dustlineQa__.forcePlayerDeath(${JSON.stringify(attackerName)})`);
}

async function fire(page) {
  await page.evaluate("window.__dustlineQa__.fire()");
}

async function aimAt(page, combatantId) {
  const aimed = await page.evaluate(
    `window.__dustlineQa__.aimAt(${JSON.stringify(combatantId)})`,
  );
  assert(aimed, `Could not aim at combatant ${combatantId}`);
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
  const userDataDir = path.join("/tmp", `dustline-final-${Date.now()}`);
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
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    const summary = {
      mapCards: 0,
      localState: null,
      sharedRosterCounts: {},
      isolationRosterCount: 0,
      probeHits: [],
      sharedRespawnObserved: false,
      fallbackMode: null,
      fallbackNotice: "",
      screenshots: SCREENSHOTS.map((filename) => path.join("assets", "screenshots", filename)),
    };

    const localPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(localPage);

    await localPage.bringToFront();
    await localPage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    await localPage.captureScreenshot("01-menu-briefing.png");

    await click(localPage, '[data-action="show-catalog"]');
    summary.mapCards = await localPage.waitForExpression("document.querySelectorAll('.map-card').length");
    assert(summary.mapCards === 5, `Expected 5 map cards, saw ${summary.mapCards}`);
    await localPage.captureScreenshot("02-map-select-roster.png");

    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await delay(300);
    await localPage.captureScreenshot("03-sandline-spawn-view.png");

    await setView(
      localPage,
      { x: 18, y: 12, z: 19 },
      { x: 0, y: 2, z: -6 },
    );
    await ensureControlsEngaged(localPage);
    await localPage.captureScreenshot("04-sandline-central-yard.png");

    await setView(
      localPage,
      { x: -30, y: 7, z: 6 },
      { x: -16, y: 2, z: 1 },
    );
    await ensureControlsEngaged(localPage);
    await localPage.captureScreenshot("05-sandline-generator-hall.png");

    await setView(
      localPage,
      { x: 26, y: 6, z: 14 },
      { x: 15, y: 2, z: 3 },
    );
    await ensureControlsEngaged(localPage);
    await localPage.captureScreenshot("06-sandline-drain-underpass.png");

    await setView(
      localPage,
      { x: 30, y: 10, z: -3 },
      { x: 17, y: 4, z: -9 },
    );
    await ensureControlsEngaged(localPage);
    await localPage.captureScreenshot("07-sandline-east-catwalk.png");

    await setView(
      localPage,
      { x: 0, y: 1.62, z: 6 },
      { x: 0, y: 2, z: -10 },
    );
    await ensureControlsEngaged(localPage);
    await localPage.captureScreenshot("08-weapon-idle-hud.png");

    await ensureControlsEngaged(localPage);
    await fire(localPage);
    await delay(20);
    await localPage.captureScreenshot("09-weapon-firing-hud.png");

    await forceDeath(localPage, "Copper-2");
    await localPage.waitForExpression(
      "Boolean(document.querySelector('[data-ui=\"death-panel\"]') && !document.querySelector('[data-ui=\"death-panel\"]').hidden)",
      5_000,
    );
    await localPage.captureScreenshot("11-death-respawn-state.png");
    summary.localState = await getState(localPage);

    const sharedPageOne = await createPage(`${ROOT_URL}?qa=1`);
    const sharedPageTwo = await createPage(`${ROOT_URL}?qa=1`);
    const isolationPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(sharedPageOne, sharedPageTwo, isolationPage);

    await sharedPageOne.bringToFront();
    await openMap(sharedPageOne, "sandline-foundry", "shared");
    await engageControls(sharedPageOne);

    await sharedPageTwo.bringToFront();
    await openMap(sharedPageTwo, "sandline-foundry", "shared");
    await engageControls(sharedPageTwo);

    await isolationPage.bringToFront();
    await openMap(isolationPage, "transit-crates", "shared");
    await engageControls(isolationPage);

    await sharedPageOne.bringToFront();
    await sharedPageOne.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 2",
      15_000,
    );
    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 2",
      15_000,
    );
    await isolationPage.bringToFront();
    await isolationPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 1",
      15_000,
    );
    summary.isolationRosterCount = (await getState(isolationPage))?.roster?.length ?? 0;

    await sharedPageOne.bringToFront();
    await setView(
      sharedPageOne,
      { x: -2, y: 1.62, z: 14 },
      { x: 6, y: 1.62, z: 14 },
    );
    await sharedPageTwo.bringToFront();
    await setView(
      sharedPageTwo,
      { x: 6, y: 1.62, z: 14 },
      { x: -2, y: 1.62, z: 14 },
    );

    await delay(350);
    const stateOne = await getState(sharedPageOne);
    const stateTwo = await getState(sharedPageTwo);
    summary.sharedRosterCounts.pageOne = stateOne?.roster?.length ?? 0;
    summary.sharedRosterCounts.pageTwo = stateTwo?.roster?.length ?? 0;

    const remoteId = stateOne?.remotePlayers?.[0]?.id;
    assert(remoteId, "Expected one remote operator on shared page one");

    const duelLayout = await sharedPageOne.evaluate(
      "window.__dustlineQa__.stageAuthoritativeSharedPair('clear')",
    );
    assert(duelLayout, "Shared-room host could not stage an authoritative duel pair.");

    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState()?.match;
          const local = state?.localPlayer?.position;
          if (!local) {
            return false;
          }
          return Math.hypot(local.x - ${duelLayout.guest.x}, local.z - ${duelLayout.guest.z}) < 0.35;
        })()
      `,
      4_000,
    );

    await sharedPageOne.bringToFront();
    await setView(sharedPageOne, duelLayout.host, duelLayout.guest);
    await aimAt(sharedPageOne, remoteId);
    await ensureControlsEngaged(sharedPageOne);
    const initialSharedTargetId = await sharedPageOne.evaluate("window.__dustlineQa__.sharedTarget()");
    summary.probeHits =
      (await sharedPageOne.evaluate("window.__dustlineQa__.probeShot()?.hits ?? []")) ?? [];
    assert(
      initialSharedTargetId === remoteId,
      `Shared-room target lock did not resolve to the remote combatant. Target: ${initialSharedTargetId}`,
    );

    await sharedPageOne.bringToFront();
    await setView(
      sharedPageOne,
      {
        x: duelLayout.host.x - 4.5,
        y: 3.4,
        z: duelLayout.host.z + 4.5,
      },
      {
        x: duelLayout.guest.x,
        y: 1.3,
        z: duelLayout.guest.z,
      },
    );
    await ensureControlsEngaged(sharedPageOne);
    await sharedPageOne.captureScreenshot("10-opposing-player.png");
    await sharedPageOne.captureScreenshot("12-two-player-multiplayer.png");
    await sharedPageOne.evaluate("window.__dustlineQa__.stageAuthoritativeSharedPair('clear')");
    await setView(sharedPageOne, duelLayout.host, duelLayout.guest);
    await ensureControlsEngaged(sharedPageOne);

    let remoteDown = false;
    for (let shot = 0; shot < 6; shot += 1) {
      await sharedPageOne.bringToFront();
      await sharedPageOne.evaluate("window.__dustlineQa__.stageAuthoritativeSharedPair('clear')");
      await setView(sharedPageOne, duelLayout.host, duelLayout.guest);
      await ensureControlsEngaged(sharedPageOne);
      await aimAt(sharedPageOne, remoteId);
      const liveSharedTargetId = await sharedPageOne.evaluate("window.__dustlineQa__.sharedTarget()");

      const liveProbeHits =
        (await sharedPageOne.evaluate("window.__dustlineQa__.probeShot()?.hits ?? []")) ?? [];
      assert(
        liveSharedTargetId === remoteId,
        `Lost the shared-room shot lane before firing. Target: ${liveSharedTargetId}; hits: ${JSON.stringify(liveProbeHits)}`,
      );

      await fire(sharedPageOne);
      await delay(260);

      const remoteState = await getState(sharedPageTwo);
      if (remoteState?.localPlayer?.health === 0) {
        remoteDown = true;
        break;
      }
    }

    assert(remoteDown, "Shared-room kill verification never reduced the remote player to 0 HP");

    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.localPlayer?.health === 0
            && state?.roster?.[0]?.status === 'respawning';
        })()
      `,
      10_000,
    );

    await sharedPageOne.bringToFront();
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.remotePlayers?.[0]?.status === 'respawning'
            && state?.remotePlayers?.[0]?.health === 0;
        })()
      `,
      10_000,
    );

    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.localPlayer?.health === 100 && state?.localPlayer?.dead === false;
        })()
      `,
      10_000,
    );
    await sharedPageOne.bringToFront();
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.remotePlayers?.[0]?.status === 'alive'
            && state?.remotePlayers?.[0]?.health === 100;
        })()
      `,
      10_000,
    );
    summary.sharedRespawnObserved = true;

    const fallbackPage = await createPage(`${ROOT_URL}?qa=1`, `
      Object.defineProperty(window, 'BroadcastChannel', {
        value: undefined,
        configurable: true,
      });
    `);
    pages.push(fallbackPage);

    await fallbackPage.bringToFront();
    await openMap(fallbackPage, "sandline-foundry", "shared");
    await engageControls(fallbackPage);
    const fallbackState = await getState(fallbackPage);
    summary.fallbackMode = fallbackState?.activeMode ?? null;
    summary.fallbackNotice = await fallbackPage.evaluate(`
      document.querySelector('[data-ui="mode-notice"]')?.textContent?.trim() ?? ''
    `);
    assert(summary.fallbackMode === "local", "Expected BroadcastChannel fallback to open solo mode");
    assert(
      summary.fallbackNotice.includes("BroadcastChannel is unavailable"),
      "Expected BroadcastChannel fallback notice",
    );

    console.log(JSON.stringify(summary, null, 2));
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
