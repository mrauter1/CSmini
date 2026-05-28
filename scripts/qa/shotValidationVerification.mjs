import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_URL = "http://127.0.0.1:4173/";
const PREVIEW_PORT = "4173";
const DEBUG_PORT = "9226";
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

  async bringToFront() {
    await this.send("Page.bringToFront");
    await delay(120);
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
    `--user-data-dir=/tmp/dustline-shot-validation-${Date.now()}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  await waitForHttp(`${DEBUG_ORIGIN}/json/version`);
  return chrome;
}

async function waitForRoomPhase(page, phase, timeoutMs = 15_000) {
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

async function currentResultId(page) {
  return page.evaluate("window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotResult?.claimId ?? 0");
}

async function waitForResult(page, previousId, timeoutMs = 10_000) {
  await page.waitForExpression(
    `(window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotResult?.claimId ?? 0) > ${previousId}`,
    timeoutMs,
  );
  return page.evaluate("window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotResult ?? null");
}

async function currentResultCount(page) {
  return page.evaluate(
    "window.__dustlineQa__?.getState()?.match?.sharedCombat?.recentShotResults?.length ?? 0",
  );
}

async function waitForNewResults(page, previousCount, addedCount, timeoutMs = 10_000) {
  await page.waitForExpression(
    `(window.__dustlineQa__?.getState()?.match?.sharedCombat?.recentShotResults?.length ?? 0) >= ${previousCount + addedCount}`,
    timeoutMs,
  );
  const history = await page.evaluate(
    "window.__dustlineQa__?.getState()?.match?.sharedCombat?.recentShotResults ?? []",
  );
  return history.slice(previousCount);
}

async function waitForSnapshot(page, previousId, timeoutMs = 10_000) {
  await page.waitForExpression(
    `(window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0) > ${previousId}`,
    timeoutMs,
  );
}

async function readMatch(page) {
  return page.evaluate("window.__dustlineQa__?.getState()?.match ?? null");
}

async function connectTwoPlayerRoom(hostPage, joinPage) {
  await hostPage.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "webrtc-host")`,
  );
  const offer = await hostPage.evaluate("window.__dustlineQa__.createRoomOffer()");
  assert(typeof offer === "string" && offer.length > 100, "Host offer was not generated.");

  await joinPage.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "webrtc-join")`,
  );
  const answer = await joinPage.evaluate(
    `window.__dustlineQa__.generateRoomAnswer(${JSON.stringify(offer)})`,
  );
  assert(typeof answer === "string" && answer.length > 100, "Guest answer was not generated.");

  const applied = await hostPage.evaluate(
    `window.__dustlineQa__.applyRoomAnswer(${JSON.stringify(answer)})`,
  );
  assert(applied === true, "Host did not accept the guest answer.");

  await waitForRoomPhase(hostPage, "connected");
  await waitForRoomPhase(joinPage, "connected");

  assert((await hostPage.evaluate("window.__dustlineQa__.enterArena()")) === true, "Host could not enter the arena.");
  assert((await joinPage.evaluate("window.__dustlineQa__.enterArena()")) === true, "Guest could not enter the arena.");

  await waitForMatch(hostPage, MAP_ID);
  await waitForMatch(joinPage, MAP_ID);
  await hostPage.waitForExpression("(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === 2");
  await joinPage.waitForExpression("(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === 2");
  await joinPage.waitForExpression("(window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0) > 0");

  return { offerLength: offer.length, answerLength: answer.length };
}

async function stagePair(hostPage, joinPage, kind) {
  const guestSnapshotId = await joinPage.evaluate("window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0");
  const layout = await hostPage.evaluate(
    `window.__dustlineQa__.stageAuthoritativeSharedPair(${JSON.stringify(kind)})`,
  );
  assert(layout && typeof layout.guestId === "string", `Host could not stage the ${kind} shot pair.`);
  await waitForSnapshot(joinPage, guestSnapshotId);
  return layout;
}

async function aimGuestAtHost(joinPage) {
  const hostId = await joinPage.evaluate("window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.id ?? null");
  assert(typeof hostId === "string" && hostId.length > 0, "Guest could not resolve the host target id.");
  const aimed = await joinPage.evaluate(
    `window.__dustlineQa__.aimAt(${JSON.stringify(hostId)})`,
  );
  assert(aimed === true, "Guest could not aim at the host.");
}

async function main() {
  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    const hostPage = await createPage(`${ROOT_URL}?qa=1`);
    const joinPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(hostPage, joinPage);

    const connection = await connectTwoPlayerRoom(hostPage, joinPage);

    const blockedLayout = await stagePair(hostPage, joinPage, "blocked");
    await joinPage.evaluate(
      `window.__dustlineQa__.setView(
        ${blockedLayout.guest.x},
        ${blockedLayout.guest.y},
        ${blockedLayout.guest.z},
        ${blockedLayout.host.x},
        ${blockedLayout.host.y},
        ${blockedLayout.host.z}
      )`,
    );
    await delay(350);
    const blockedBeforeId = await currentResultId(joinPage);
    const blockedHostHealthBefore = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.health ?? -1",
    );
    const blockedSent = await joinPage.evaluate(
      `window.__dustlineQa__.submitShotClaim({
        origin: ${JSON.stringify(blockedLayout.guest)},
        direction: {
          x: ${blockedLayout.host.x - blockedLayout.guest.x},
          y: 0,
          z: ${blockedLayout.host.z - blockedLayout.guest.z}
        }
      })`,
    );
    assert(blockedSent === true, "Guest could not submit the blocked shot claim.");
    const blockedResult = await waitForResult(joinPage, blockedBeforeId);
    const blockedHostHealthAfter = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.health ?? -1",
    );

    assert(blockedResult?.decision === "rejected", `Blocked shot decision was ${blockedResult?.decision}`);
    assert(blockedResult?.reason === "blocked-by-cover", `Blocked shot reason was ${blockedResult?.reason}`);
    assert(blockedHostHealthBefore === 100 && blockedHostHealthAfter === 100, "Blocked shot mutated host health.");

    const clearLayout = await stagePair(hostPage, joinPage, "clear");
    await aimGuestAtHost(joinPage);
    await delay(350);
    const acceptedBeforeId = await currentResultId(joinPage);
    const acceptedBeforeCount = await currentResultCount(joinPage);
    const acceptedSent = await joinPage.evaluate(
      `window.__dustlineQa__.submitShotClaim({
        origin: ${JSON.stringify(clearLayout.guest)},
        direction: {
          x: ${clearLayout.host.x - clearLayout.guest.x},
          y: 0,
          z: ${clearLayout.host.z - clearLayout.guest.z}
        }
      })`,
    );
    assert(acceptedSent === true, "Guest could not submit the clear shot claim.");
    const acceptedClaimTick = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotClaim?.tick ?? 0",
    );
    assert(acceptedClaimTick > 0, "Guest did not record the accepted claim tick.");
    const forgedSent = await joinPage.evaluate(
      `window.__dustlineQa__.submitShotClaim({ tick: ${acceptedClaimTick} + 40 })`,
    );
    assert(forgedSent === true, "Guest could not submit the immediate forged shot claim.");
    const acceptedLastResult = await waitForResult(joinPage, acceptedBeforeId);
    const newResults = await waitForNewResults(joinPage, acceptedBeforeCount, 2);
    const acceptedResult = newResults.find((result) => result.decision === "accepted") ?? acceptedLastResult;
    const fireRateResult = newResults.find((result) => result.reason === "fire-rate");
    assert(acceptedResult?.decision === "accepted", `Accepted shot results were ${JSON.stringify(newResults)}`);
    assert(fireRateResult?.reason === "fire-rate", `Fire-rate results were ${JSON.stringify(newResults)}`);
    await hostPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.localPlayer?.health ?? 0) === 66",
      10_000,
    );
    const acceptedHostHealth = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.health ?? -1",
    );
    const guestAmmoAfterAccepted = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.ammoInClip ?? -1",
    );

    assert(acceptedResult?.damage === 34, `Accepted shot damage was ${acceptedResult?.damage}`);
    assert(acceptedHostHealth === 66, `Accepted shot host health was ${acceptedHostHealth}`);
    const hostHealthAfterFireRate = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.health ?? -1",
    );
    const guestAmmoAfterFireRate = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.ammoInClip ?? -1",
    );

    assert(fireRateResult?.reason === "fire-rate", `Fire-rate shot reason was ${fireRateResult?.reason}`);
    assert(hostHealthAfterFireRate === 66, `Fire-rate rejection changed host health to ${hostHealthAfterFireRate}`);
    assert(
      guestAmmoAfterFireRate === guestAmmoAfterAccepted,
      `Rejected fire-rate claim changed guest ammo from ${guestAmmoAfterAccepted} to ${guestAmmoAfterFireRate}`,
    );

    const summary = {
      offerLength: connection.offerLength,
      answerLength: connection.answerLength,
      blockedLayout,
      blockedResult,
      clearLayout,
      acceptedResult,
      fireRateResult,
      hostHealthAfterAccepted: acceptedHostHealth,
      guestAmmoAfterAccepted,
      guestAmmoAfterFireRate,
      guestLastShotClaim: await joinPage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotClaim ?? null",
      ),
      guestLastShotResult: await joinPage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.sharedCombat?.lastShotResult ?? null",
      ),
      hostMatch: await readMatch(hostPage),
      guestMatch: await readMatch(joinPage),
    };

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
