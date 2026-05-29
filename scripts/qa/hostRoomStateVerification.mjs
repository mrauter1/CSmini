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
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=/tmp/dustline-host-room-${Date.now()}`,
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

async function readRemotePosition(page) {
  return page.evaluate(
    "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.position ?? null",
  );
}

async function waitForRemoteMovement(page, initial, minimumDistance = 0.25, timeoutMs = 15_000) {
  assert(initial, "Remote player was missing before the movement check.");
  await page.waitForExpression(
    `(() => {
      const position = window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.position;
      if (!position) {
        return false;
      }
      return Math.hypot(position.x - ${initial.x}, position.z - ${initial.z}) > ${minimumDistance};
    })()`,
    timeoutMs,
  );
}

async function setInputState(page, movementX, movementZ, sprint = false) {
  await page.evaluate(
    `window.__dustlineQa__.setInputState(${movementX}, ${movementZ}, ${JSON.stringify(sprint)})`,
  );
}

async function sendInputTick(page, movementX, movementZ, sprint = false) {
  return page.evaluate(
    `window.__dustlineQa__.sendInputTick(${movementX}, ${movementZ}, ${JSON.stringify(sprint)})`,
  );
}

async function configureLatestStateQa(page, direction, config = null) {
  return page.evaluate(
    `window.__dustlineQa__.configureLatestStateQa(
      ${JSON.stringify(direction)},
      ${JSON.stringify(config)}
    )`,
  );
}

async function readLocalPosition(page) {
  return page.evaluate("window.__dustlineQa__?.getState()?.match?.localPlayer?.position ?? null");
}

async function hasRemoteMovementAndInputReceipt(
  page,
  initial,
  movementX,
  movementZ,
  sprint = false,
  minimumDistance = 0.25,
) {
  assert(initial, "Remote player was missing before the input-delivery check.");
  return page.evaluate(
    `(() => {
      const remote = window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0];
      if (!remote?.position) {
        return false;
      }

      const inputMatches =
        Math.abs((remote.inputMovement?.x ?? 0) - ${movementX}) < 0.01 &&
        Math.abs((remote.inputMovement?.z ?? 0) - ${movementZ}) < 0.01 &&
        Boolean(remote.inputSprint) === ${JSON.stringify(sprint)};
      const movedDistance = Math.hypot(
        remote.position.x - ${initial.x},
        remote.position.z - ${initial.z},
      );

      return inputMatches && movedDistance > ${minimumDistance};
    })()`,
  );
}

async function driveGuestInputUntilObserved(
  hostPage,
  joinPage,
  initialPosition,
  movementX,
  movementZ,
  sprint = false,
  timeoutMs = 10_000,
) {
  const startedAt = Date.now();

  await clearInputState(joinPage);
  await setInputState(joinPage, movementX, movementZ, sprint);
  await hostPage.bringToFront();

  while (Date.now() - startedAt < timeoutMs) {
    await sendInputTick(joinPage, movementX, movementZ, sprint);

    if (
      await hasRemoteMovementAndInputReceipt(
        hostPage,
        initialPosition,
        movementX,
        movementZ,
        sprint,
      )
    ) {
      return true;
    }

    await delay(120);
  }

  return false;
}

async function clearInputState(page) {
  await page.evaluate("window.__dustlineQa__.clearInputState()");
}

async function teleportHost(page, x, z, yaw = 0) {
  await page.evaluate(`window.__dustlineQa__.setPose(${x}, ${z}, ${yaw})`);
}

async function main() {
  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    const hostPage = await createPage(`${ROOT_URL}?qa=1`);
    const joinPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(hostPage, joinPage);

    await hostPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "webrtc-host")`,
    );
    await hostPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    const offer = await hostPage.evaluate("window.__dustlineQa__.createRoomOffer()");
    assert(typeof offer === "string" && offer.length > 100, "Host offer was not generated.");

    await joinPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "webrtc-join")`,
    );
    await joinPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
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

    const hostEntered = await hostPage.evaluate("window.__dustlineQa__.enterArena()");
    const joinEntered = await joinPage.evaluate("window.__dustlineQa__.enterArena()");
    assert(hostEntered === true, "Host could not enter the arena.");
    assert(joinEntered === true, "Guest could not enter the arena.");

    await waitForMatch(hostPage, MAP_ID);
    await waitForMatch(joinPage, MAP_ID);
    await hostPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === 2",
      10_000,
    );
    await joinPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.roster?.length ?? 0) === 2",
      10_000,
    );
    await hostPage.bringToFront();
    await hostPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.roomConnection?.lastSnapshotId ?? 0) > 0",
      10_000,
    );
    await joinPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0) > 0",
      10_000,
    );

    const initialGuestOnHost = await readRemotePosition(hostPage);
    assert(
      (await driveGuestInputUntilObserved(hostPage, joinPage, initialGuestOnHost, -1, 1, true)) ===
        true,
      "Diagonal guest input delivery was not reflected in the host state.",
    );
    const hostRemoteAfterGuestInput = await readRemotePosition(hostPage);
    const hostRemoteInputState = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0] ?? null",
    );
    assert(
      (hostRemoteInputState?.lastInputSequence ?? 0) > 0,
      "Host never recorded the guest input sequence.",
    );
    const guestAckAfterMovement = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.lastAcknowledgedInputSequence ?? 0",
    );

    await joinPage.evaluate("window.__dustlineQa__.setInputTickPaused(true)");
    await hostPage.waitForExpression(
      `(() => {
        const remote = window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0];
        if (!remote) {
          return false;
        }
        return (
          Math.abs(remote.inputMovement?.x ?? 0) < 0.01 &&
          Math.abs(remote.inputMovement?.z ?? 0) < 0.01 &&
          remote.inputSprint === false
        );
      })()`,
      5_000,
    );
    const hostRemoteAfterDeadman = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0] ?? null",
    );
    const hostRemoteAfterDeadmanPosition = await readRemotePosition(hostPage);
    await delay(250);
    const hostRemoteAfterDeadmanSettled = await readRemotePosition(hostPage);
    const deadmanDrift = Math.hypot(
      (hostRemoteAfterDeadmanSettled?.x ?? 0) - (hostRemoteAfterDeadmanPosition?.x ?? 0),
      (hostRemoteAfterDeadmanSettled?.z ?? 0) - (hostRemoteAfterDeadmanPosition?.z ?? 0),
    );
    assert(deadmanDrift < 0.25, `Host deadman allowed remote drift of ${deadmanDrift.toFixed(3)}m.`);
    await joinPage.evaluate("window.__dustlineQa__.setInputTickPaused(false)");
    await clearInputState(joinPage);

    const hostInputSequenceBeforeFaults = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.lastInputSequence ?? 0",
    );
    const duplicateDropConfigured = await configureLatestStateQa(hostPage, "inbound", {
      dropNextCount: 1,
      duplicateNextCount: 1,
    });
    assert(duplicateDropConfigured === true, "Could not enable inbound latest-state QA faults on the host.");
    await setInputState(joinPage, 1, 0, false);
    await sendInputTick(joinPage, 1, 0, false);
    await delay(140);
    await sendInputTick(joinPage, 1, 0, false);
    await hostPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.lastInputSequence ?? 0) > ${hostInputSequenceBeforeFaults}`,
      10_000,
    );
    const duplicateDropHostState = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0] ?? null",
    );
    const duplicateDropConnectionState = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.connection ?? null",
    );
    assert(
      duplicateDropConnectionState?.phase === "connected" &&
        duplicateDropConnectionState?.peerCount === 1,
      "Latest-state duplicate/drop faults should not disconnect a valid peer.",
    );
    assert(
      (duplicateDropHostState?.lastInputSequence ?? 0) > hostInputSequenceBeforeFaults,
      "Host did not recover from the injected latest-state input drop/duplicate.",
    );
    await configureLatestStateQa(hostPage, "inbound", null);
    await clearInputState(joinPage);

    const guestLocalBeforeJitter = await readLocalPosition(joinPage);
    assert(guestLocalBeforeJitter, "Guest local position was unavailable before the jitter test.");
    const jitterConfigured = await configureLatestStateQa(joinPage, "inbound", {
      delayScheduleMs: [420, 120, 380, 100, 340, 80],
    });
    assert(jitterConfigured === true, "Could not enable inbound latest-state jitter on the guest.");
    await setInputState(joinPage, 0, 1, true);
    await joinPage.bringToFront();
    for (let step = 0; step < 6; step += 1) {
      const sent = await sendInputTick(joinPage, 0, 1, true);
      assert(sent === true, `Guest input tick ${step + 1} was not sent during the jitter test.`);
      await delay(120);
      await hostPage.bringToFront();
      await delay(60);
      await joinPage.bringToFront();
    }
    const guestJitterMidState = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer ?? null",
    );
    const guestLocalAfterJitterDrive = await readLocalPosition(joinPage);
    assert(guestLocalAfterJitterDrive, "Guest local position was unavailable during the jitter test.");
    const guestJitterDriveDistance = Math.hypot(
      guestLocalAfterJitterDrive.x - guestLocalBeforeJitter.x,
      guestLocalAfterJitterDrive.z - guestLocalBeforeJitter.z,
    );
    assert(
      guestJitterDriveDistance > 0.35,
      `Guest local prediction stalled under delayed snapshots (${guestJitterDriveDistance.toFixed(3)}m).`,
    );
    assert(
      (guestJitterMidState?.lastSentInputSequence ?? 0) >
        (guestJitterMidState?.lastAcknowledgedInputSequence ?? 0) &&
        ((guestJitterMidState?.pendingReplayDeltaCount ?? 0) > 0 ||
          (guestJitterMidState?.pendingInputCount ?? 0) > 0),
      `Guest did not retain unacknowledged prediction history while snapshots were delayed: ${JSON.stringify(guestJitterMidState)}`,
    );
    await clearInputState(joinPage);
    await hostPage.bringToFront();
    await delay(180);
    const hostProcessedSequenceAfterJitter = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.remotePlayers?.[0]?.lastProcessedInputSequence ?? 0",
    );
    await joinPage.waitForExpression(
      `(() => {
        const local = window.__dustlineQa__?.getState()?.match?.localPlayer;
        return Boolean(local) && local.lastAcknowledgedInputSequence >= ${hostProcessedSequenceAfterJitter};
      })()`,
      15_000,
    );
    await delay(220);
    const guestJitterSettledState = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer ?? null",
    );
    const guestLocalAfterJitterSettle = await readLocalPosition(joinPage);
    const hostGuestAfterJitter = await readRemotePosition(hostPage);
    assert(
      guestLocalAfterJitterSettle && hostGuestAfterJitter,
      "Positions were unavailable after the delayed-snapshot jitter test.",
    );
    const guestJitterConvergenceError = Math.hypot(
      guestLocalAfterJitterSettle.x - hostGuestAfterJitter.x,
      guestLocalAfterJitterSettle.z - hostGuestAfterJitter.z,
    );
    assert(
      guestJitterConvergenceError < 0.35,
      `Guest reconciliation diverged by ${guestJitterConvergenceError.toFixed(3)}m after delayed snapshots.`,
    );
    await configureLatestStateQa(joinPage, "inbound", null);

    const guestSnapshotBeforeHold = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );
    const guestRemoteBeforeHold = await readRemotePosition(joinPage);
    const holdConfigured = await configureLatestStateQa(hostPage, "outbound", {
      hold: true,
    });
    assert(holdConfigured === true, "Could not enable outbound latest-state hold on the host.");
    await delay(180);
    const guestSnapshotAfterHoldActivation = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );
    await hostPage.bringToFront();
    const hostLocalBeforeHold = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.position ?? null",
    );
    assert(hostLocalBeforeHold, "Host local position was unavailable before the backpressure test.");
    await teleportHost(hostPage, hostLocalBeforeHold.x + 0.8, hostLocalBeforeHold.z, 0);
    await delay(120);
    await teleportHost(hostPage, hostLocalBeforeHold.x + 1.6, hostLocalBeforeHold.z + 0.2, 0);
    await delay(120);
    await teleportHost(hostPage, hostLocalBeforeHold.x + 2.3, hostLocalBeforeHold.z + 0.4, 0);
    const hostSnapshotDuringHold = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.lastSnapshotId ?? 0",
    );
    const guestSnapshotDuringHold = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );
    assert(
      guestSnapshotDuringHold === guestSnapshotAfterHoldActivation,
      "Guest continued receiving new host snapshots while latest-state backpressure hold was active.",
    );
    await configureLatestStateQa(hostPage, "outbound", null);
    await joinPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0) >= ${hostSnapshotDuringHold}`,
      15_000,
    );
    await delay(220);
    const guestSnapshotAfterHold = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );
    const guestRemoteAfterHold = await readRemotePosition(joinPage);
    assert(guestRemoteAfterHold && guestRemoteBeforeHold, "Guest remote position was unavailable after hold release.");
    const guestHoldDistance = Math.hypot(
      guestRemoteAfterHold.x - guestRemoteBeforeHold.x,
      guestRemoteAfterHold.z - guestRemoteBeforeHold.z,
    );
    assert(
      guestSnapshotAfterHold >= hostSnapshotDuringHold &&
        guestSnapshotAfterHold - guestSnapshotAfterHoldActivation >= 2,
      `Guest did not jump to the newest held host snapshot after release (${guestSnapshotAfterHold} < ${hostSnapshotDuringHold}).`,
    );

    const guestSnapshotBeforeHostMove = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );
    const initialHostOnGuest = await readRemotePosition(joinPage);
    const hostLocalBeforeMove = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.localPlayer?.position ?? null",
    );
    assert(hostLocalBeforeMove, "Host local position was unavailable before the host snapshot test.");
    await hostPage.bringToFront();
    await teleportHost(hostPage, hostLocalBeforeMove.x + 1.5, hostLocalBeforeMove.z, 0);
    await joinPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0) > ${guestSnapshotBeforeHostMove}`,
      10_000,
    );
    await joinPage.bringToFront();
    await delay(250);
    await waitForRemoteMovement(joinPage, initialHostOnGuest);
    const guestRemoteAfterHostInput = await readRemotePosition(joinPage);
    const guestSnapshotAfterHostMove = await joinPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.lastHostSnapshotId ?? 0",
    );

    await hostPage.send("Page.navigate", { url: "about:blank" });
    await joinPage.bringToFront();
    await joinPage.waitForExpression(
      `window.__dustlineQa__?.getState()?.screen === "room" &&
        Boolean(window.__dustlineQa__?.getState()?.roomSetup?.supportError)`,
      15_000,
    );

    const summary = {
      hostOfferLength: offer.length,
      guestAnswerLength: answer.length,
      hostPhase: await hostPage.evaluate("document.readyState"),
      guestRecoveryScreen: await joinPage.evaluate("window.__dustlineQa__?.getState()?.screen"),
      guestRecoveryError: await joinPage.evaluate(
        "window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? ''",
      ),
      guestAckAfterMovement,
      guestSnapshotAfterHostMove,
      duplicateDropHostState,
      duplicateDropConnectionState,
      guestJitterMidState,
      guestJitterSettledState,
      guestJitterDriveDistance,
      guestJitterConvergenceError,
      guestSnapshotBeforeHold,
      hostSnapshotDuringHold,
      guestSnapshotAfterHold,
      guestHoldDistance,
      hostRemoteInputState,
      hostRemotePositionBeforeGuestInput: initialGuestOnHost,
      hostRemoteAfterGuestInput,
      hostRemoteAfterDeadman,
      deadmanDrift,
      guestRemoteAfterHostInput,
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
