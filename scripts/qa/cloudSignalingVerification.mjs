import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_URL = "http://127.0.0.1:4173/";
const PREVIEW_PORT = "4173";
const DEBUG_PORT = "9225";
const DEBUG_ORIGIN = `http://127.0.0.1:${DEBUG_PORT}`;
const MAP_ID = "sandline-foundry";
const SIGNALING_URL = process.env.SIGNALING_URL ?? "";
const GUEST_COUNT = Number.parseInt(process.env.GUEST_COUNT ?? "1", 10);
const EXPECTED_PLAYER_COUNT = GUEST_COUNT + 1;

assert(Number.isInteger(GUEST_COUNT) && GUEST_COUNT >= 1, "GUEST_COUNT must be a positive integer.");

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
      // Keep polling.
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
      // Try the next method.
    }
  }

  throw new Error(`Could not create a new Chrome target for ${url}`);
}

function startProcess(command, args) {
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
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
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(250)]);
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
      if (typeof message.id !== "number") {
        return;
      }

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

    return new Promise((resolve, reject) => {
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
  if (SIGNALING_URL) {
    await page.evaluate(
      `window.__DUSTLINE_SIGNALING_URL__ = ${JSON.stringify(SIGNALING_URL)}`,
    );
  }
  return page;
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
  const chrome = startProcess("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=/tmp/dustline-cloud-signal-${Date.now()}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  await waitForHttp(`${DEBUG_ORIGIN}/json/version`);
  return chrome;
}

async function waitForRoomPhase(page, phase, timeoutMs = 20_000) {
  await page.waitForExpression(
    `window.__dustlineQa__?.getState()?.roomSetup?.phase === ${JSON.stringify(phase)}`,
    timeoutMs,
  );
}

async function waitForMatch(page, mapId, timeoutMs = 15_000) {
  await page.waitForExpression(
    `window.__dustlineQa__?.getState()?.match?.mapId === ${JSON.stringify(mapId)}`,
    timeoutMs,
  );
}

async function probeOutboundSignalingGuardrail(page) {
  await page.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
  );
  await page.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
  await waitForRoomPhase(page, "waiting");

  const sent = await page.evaluate(
    `window.__dustlineQa__.sendSignalingPayload(${JSON.stringify({
      type: "offer",
      toPeerId: "guardrail-guest",
      description: {
        type: "offer",
        sdp: "x".repeat(12 * 1024 + 128),
      },
    })})`,
  );
  assert(sent === false, "Oversized signaling offer should be rejected client-side before send.");

  await waitForRoomPhase(page, "error");
  const detail = await page.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.connection?.detail ?? ''");
  assert(
    typeof detail === "string" && detail.includes("oversized or invalid offer"),
    "Client should surface the rejected oversized signaling offer.",
  );

  return {
    sent,
    phase: await page.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase ?? null"),
    detail,
  };
}

async function probeInboundSignalingGuardrail(page) {
  await page.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
  );
  await page.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
  await waitForRoomPhase(page, "waiting");

  for (let index = 0; index < 4; index += 1) {
    const injected = await page.evaluate(
      `window.__dustlineQa__.injectSignalingMessage(${JSON.stringify("{not-json}")})`,
    );
    assert(injected === true, "QA hook should inject malformed signaling frames.");
  }

  await waitForRoomPhase(page, "error");
  const detail = await page.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.connection?.detail ?? ''");
  assert(
    typeof detail === "string" && detail.includes("invalid signaling message"),
    "Repeated malformed signaling should fail the client transport cleanly.",
  );

  return {
    phase: await page.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase ?? null"),
    detail,
  };
}

async function probeMalformedRoomPeerFailure(hostPage, joinPage) {
  const hostPeerId = await joinPage.evaluate(
    "window.__dustlineQa__?.getState()?.roomSetup?.connection?.hostPeerId ?? null",
  );
  assert(typeof hostPeerId === "string" && hostPeerId.length > 0, "Guest did not learn the host peer id.");

  for (let index = 0; index < 4; index += 1) {
    const sent = await joinPage.evaluate(
      `window.__dustlineQa__.sendRawRoomMessage(${JSON.stringify("{not-json}")}, ${JSON.stringify(hostPeerId)})`,
    );
    assert(sent === true, "Malformed room payload probe should still traverse the open data channel.");
  }

  await hostPage.waitForExpression(
    "(window.__dustlineQa__?.getState()?.roomSetup?.connection?.peerCount ?? -1) === 0",
    10_000,
  );
  await joinPage.waitForExpression(
    `(window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? "").length > 0`,
    10_000,
  );

  return {
    hostPeerCount: await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.connection?.peerCount ?? null",
    ),
    hostDetail: await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.connection?.detail ?? ''",
    ),
    guestPhase: await joinPage.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase ?? null"),
    guestDetail: await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? ''",
    ),
  };
}

async function main() {
  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    let guardrails = null;
    if (GUEST_COUNT === 1) {
      const outboundProbePage = await createPage(`${ROOT_URL}?qa=1`);
      pages.push(outboundProbePage);
      const outboundOfferRejected = await probeOutboundSignalingGuardrail(outboundProbePage);
      await outboundProbePage.close();

      const inboundProbePage = await createPage(`${ROOT_URL}?qa=1`);
      pages.push(inboundProbePage);
      const repeatedInvalidSignaling = await probeInboundSignalingGuardrail(inboundProbePage);
      await inboundProbePage.close();

      guardrails = {
        outboundOfferRejected,
        repeatedInvalidSignaling,
      };
    }

    const hostPage = await createPage(`${ROOT_URL}?qa=1`);
    const joinPages = [];
    for (let index = 0; index < GUEST_COUNT; index += 1) {
      joinPages.push(await createPage(`${ROOT_URL}?qa=1`));
    }
    pages.push(hostPage, ...joinPages);

    await hostPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
    );
    await hostPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    const roomCode = await hostPage.evaluate("window.__dustlineQa__.getRoomCode()");
    assert(typeof roomCode === "string" && roomCode.length >= 6, "Host room code was not generated.");

    for (const [index, joinPage] of joinPages.entries()) {
      await joinPage.evaluate(
        `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-join")`,
      );
      await joinPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
      const joined = await joinPage.evaluate(
        `window.__dustlineQa__.joinSignalingRoom(${JSON.stringify(roomCode)})`,
      );
      assert(joined === true, `Guest ${index + 1} did not start the signaling join flow.`);
    }

    await waitForRoomPhase(hostPage, "connected");
    await Promise.all(joinPages.map((joinPage) => waitForRoomPhase(joinPage, "connected")));
    await hostPage.waitForExpression(
      `window.__dustlineQa__?.getState()?.roomSetup?.connection?.peerCount === ${GUEST_COUNT}`,
      30_000,
    );

    const hostEntered = await hostPage.evaluate("window.__dustlineQa__.enterArena()");
    assert(hostEntered === true, "Host could not enter the arena.");
    for (const [index, joinPage] of joinPages.entries()) {
      const joinEntered = await joinPage.evaluate("window.__dustlineQa__.enterArena()");
      assert(joinEntered === true, `Guest ${index + 1} could not enter the arena.`);
    }

    await waitForMatch(hostPage, MAP_ID);
    await Promise.all(joinPages.map((joinPage) => waitForMatch(joinPage, MAP_ID)));
    await hostPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === ${EXPECTED_PLAYER_COUNT}`,
      10_000,
    );
    await Promise.all(
      joinPages.map((joinPage) =>
        joinPage.waitForExpression(
          `(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === ${EXPECTED_PLAYER_COUNT}`,
          10_000,
        ),
      ),
    );
    await hostPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.match?.remotePlayers?.length ?? 0) === ${GUEST_COUNT}`,
      10_000,
    );
    await Promise.all(
      joinPages.map((joinPage) =>
        joinPage.waitForExpression(
          `(window.__dustlineQa__?.getState()?.match?.remotePlayers?.length ?? 0) === ${GUEST_COUNT}`,
          10_000,
        ),
      ),
    );

    const summary = {
      roomCode,
      guestCount: GUEST_COUNT,
      expectedPlayerCount: EXPECTED_PLAYER_COUNT,
      hostPhase: await hostPage.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase"),
      guestPhases: await Promise.all(
        joinPages.map((joinPage) =>
          joinPage.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase"),
        ),
      ),
      hostRosterCount: await hostPage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0",
      ),
      guestRosterCounts: await Promise.all(
        joinPages.map((joinPage) =>
          joinPage.evaluate("window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0"),
        ),
      ),
      hostRemoteCount: await hostPage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.remotePlayers?.length ?? 0",
      ),
      guestRemoteCounts: await Promise.all(
        joinPages.map((joinPage) =>
          joinPage.evaluate("window.__dustlineQa__?.getState()?.match?.remotePlayers?.length ?? 0"),
        ),
      ),
    };

    if (guardrails && joinPages[0]) {
      guardrails.malformedRoomPeerFailure = await probeMalformedRoomPeerFailure(hostPage, joinPages[0]);
    }

    if (guardrails) {
      summary.guardrails = guardrails;
    }

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const diagnostics = [];
    for (const [index, page] of pages.entries()) {
      try {
        diagnostics.push({
          index,
          state: await page.evaluate("window.__dustlineQa__?.getState?.() ?? null"),
        });
      } catch (diagnosticError) {
        diagnostics.push({
          index,
          error:
            diagnosticError instanceof Error
              ? diagnosticError.message
              : String(diagnosticError),
        });
      }
    }
    console.error(JSON.stringify({ diagnostics }, null, 2));
    throw error;
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
