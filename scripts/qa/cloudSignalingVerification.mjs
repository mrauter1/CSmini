import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_SEED = Date.now() % 1000;
const PREVIEW_PORT = String(4173 + (RUN_SEED % 200));
const DEBUG_PORT = String(9225 + (RUN_SEED % 200));
const DEFAULT_ROOT_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
const ROOT_URL = process.env.ROOT_URL ?? DEFAULT_ROOT_URL;
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

  async bringToFront() {
    await this.send("Page.bringToFront");
    await delay(120);
  }
}

async function createPage(url) {
  const target = await requestJsonNew("about:blank");
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.enablePage();
  if (SIGNALING_URL) {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__DUSTLINE_SIGNALING_URL__ = ${JSON.stringify(SIGNALING_URL)};`,
    });
  }
  await page.send("Page.navigate", { url });
  await page.waitForExpression(`location.href === ${JSON.stringify(url)}`);
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
  if (ROOT_URL !== DEFAULT_ROOT_URL) {
    await waitForHttp(ROOT_URL);
    return null;
  }

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

async function waitForRoomCode(page, timeoutMs = 8_000) {
  await page.waitForExpression(
    "typeof window.__dustlineQa__.getRoomCode() === 'string'",
    timeoutMs,
  );
  return page.evaluate("window.__dustlineQa__.getRoomCode()");
}

async function assertMatchViewportCentered(page, label) {
  const geometry = await page.evaluate(`
    (() => {
      const shell = document.querySelector('[data-world-shell]');
      const canvas = shell?.querySelector('canvas');
      const target = canvas ?? shell;
      if (!target) {
        return null;
      }

      const rect = target.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        scrollY: Number(window.scrollY.toFixed(2)),
        top: Number(rect.top.toFixed(2)),
        bottom: Number(rect.bottom.toFixed(2)),
        center: Number((rect.top + rect.height / 2).toFixed(2)),
        expectedCenter: Number((window.innerHeight / 2).toFixed(2)),
      };
    })()
  `);
  assert(geometry, `${label} did not render a match viewport.`);
  assert(
    geometry.scrollY <= 2,
    `${label} moved the page instead of keeping the browser scroll at the top: ${JSON.stringify(geometry)}.`,
  );
  const centerDelta = Math.abs(geometry.center - geometry.expectedCenter);
  assert(
    centerDelta <= 60,
    `${label} match viewport was not vertically centered: ${JSON.stringify(geometry)}.`,
  );
}

function withQaParam(url) {
  const target = new URL(url);
  target.searchParams.set("qa", "1");
  return target.toString();
}

async function probeRoomSetupExperience() {
  const hostPage = await createPage(`${ROOT_URL}?qa=1`);
  let joinPage;
  let closedPage;
  let codeFallbackPage;
  let publicListPage;

  try {
    await hostPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)})`,
    );
    await hostPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    const defaultKind = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.kind ?? null",
    );
    const tabLabels = await hostPage.evaluate(
      "[...document.querySelectorAll('.room-setup__tabs strong')].map((node) => (node.textContent?.trim() ?? '').toUpperCase())",
    );
    assert(defaultKind === "signal-join", `Room setup default kind was ${defaultKind}.`);
    assert(
      tabLabels[0] === "JOIN ROOM" && tabLabels[1] === "CREATE ROOM",
      `Room setup tab order was ${JSON.stringify(tabLabels)}.`,
    );

    await hostPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
    );
    await hostPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    await hostPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.roomSetup?.roomCode === 'PXB875'",
      8_000,
    );

    const setupText = await hostPage.evaluate("document.body.innerText.toLowerCase()");
    assert(setupText.includes("private room"), "Room setup should expose private room creation.");
    assert(setupText.includes("public room"), "Room setup should expose public room creation.");
    assert(!setupText.includes("manual host"), "Manual host should be hidden from the room setup UI.");
    assert(!setupText.includes("manual join"), "Manual join should be hidden from the room setup UI.");
    assert(!setupText.includes("same-browser dev room"), "Same-browser dev room should be hidden from the room setup UI.");
    assert(!setupText.includes("map preview"), "Room setup should not show a map preview image.");

    const defaultVisibility = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.visibility ?? null",
    );
    const visibilityLabels = await hostPage.evaluate(
      "[...document.querySelectorAll('.room-setup__visibility strong')].map((node) => (node.textContent?.trim() ?? '').toUpperCase())",
    );
    assert(defaultVisibility === "public", `Create Room default visibility was ${defaultVisibility}.`);
    assert(
      visibilityLabels[0] === "PUBLIC ROOM" && visibilityLabels[1] === "PRIVATE ROOM",
      `Room visibility order was ${JSON.stringify(visibilityLabels)}.`,
    );

    const publicSlot = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.roomSetup?.publicSlot ?? 0",
    );
    const roomCode = await hostPage.evaluate("window.__dustlineQa__.getRoomCode()");
    const roomUrl = await hostPage.evaluate(
      "document.querySelector('[data-room-field=\"room-url-output\"]')?.value ?? ''",
    );
    assert(publicSlot === 1, `First public room slot was ${publicSlot}.`);
    assert(roomCode === "PXB875", `First public room code was ${roomCode}.`);
    assert(
      typeof roomUrl === "string" && roomUrl.includes(`room=${roomCode}`) && roomUrl.includes(`map=${MAP_ID}`),
      "Room setup did not generate a usable invite URL.",
    );

    joinPage = await createPage(withQaParam(roomUrl));
    await waitForRoomPhase(hostPage, "connected");
    await waitForMatch(joinPage, MAP_ID);
    await assertMatchViewportCentered(joinPage, "Invite join");
    const guestInviteValue = await joinPage.evaluate(
      "document.querySelector('[data-room-field=\"arena-room-url\"]')?.value ?? ''",
    );
    const guestInviteButton = await joinPage.evaluate(
      "document.querySelector('[data-action=\"room-copy\"][data-field=\"arena-room-url\"]')?.textContent?.trim() ?? ''",
    );
    assert(
      guestInviteButton === "Copy Invite Link" &&
        guestInviteValue.includes(`room=${roomCode}`) &&
        guestInviteValue.includes(`map=${MAP_ID}`),
      `Guest arena invite copy control was missing or stale: ${JSON.stringify({ guestInviteButton, guestInviteValue })}.`,
    );

    closedPage = await createPage(
      withQaParam(`${ROOT_URL}?room=ZZZZZZ&map=${MAP_ID}`),
    );
    await waitForMatch(closedPage, MAP_ID, 12_000);
    await assertMatchViewportCentered(closedPage, "Closed invite auto-host");
    const closedState = await closedPage.evaluate("window.__dustlineQa__?.getState?.() ?? null");
    const closedInviteValue = await closedPage.evaluate(
      "document.querySelector('[data-room-field=\"arena-room-url\"]')?.value ?? ''",
    );
    assert(
      closedState?.roomSetup?.kind === "signal-host" &&
        closedState?.roomSetup?.roomCode === "ZZZZZZ" &&
        closedState?.roomSetup?.connection?.role === "host" &&
        closedInviteValue.includes("room=ZZZZZZ") &&
        closedInviteValue.includes(`map=${MAP_ID}`),
      `Closed invite did not auto-host the same room code: ${JSON.stringify({ roomSetup: closedState?.roomSetup, closedInviteValue })}.`,
    );

    codeFallbackPage = await createPage(`${ROOT_URL}?qa=1`);
    await codeFallbackPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-join")`,
    );
    await codeFallbackPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    const fallbackJoined = await codeFallbackPage.evaluate(
      `window.__dustlineQa__.joinSignalingRoom("YYYYYY")`,
    );
    assert(fallbackJoined === true, "Closed room code fallback did not start the signaling join flow.");
    await waitForMatch(codeFallbackPage, MAP_ID, 12_000);
    const codeFallbackState = await codeFallbackPage.evaluate("window.__dustlineQa__?.getState?.() ?? null");
    assert(
      codeFallbackState?.roomSetup?.kind === "signal-host" &&
        codeFallbackState?.roomSetup?.roomCode === "YYYYYY" &&
        codeFallbackState?.roomSetup?.connection?.role === "host",
      `Closed typed code did not auto-host the same room code: ${JSON.stringify(codeFallbackState?.roomSetup)}.`,
    );

    publicListPage = await createPage(`${ROOT_URL}?qa=1`);
    await publicListPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-join")`,
    );
    await publicListPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    await publicListPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roomSetup?.publicRooms?.length ?? 0) > 0",
      8_000,
    );
    const publicJoinButtons = await publicListPage.evaluate(
      "[...document.querySelectorAll('[data-action=\"room-join-public\"]')].map((node) => node.textContent?.trim() ?? '')",
    );
    const publicRoomText = await publicListPage.evaluate(
      "document.querySelector('.room-setup__public-room')?.textContent ?? ''",
    );
    assert(
      publicJoinButtons.includes("Join Room"),
      `Public room rows did not expose Join Room buttons: ${JSON.stringify(publicJoinButtons)}.`,
    );
    assert(
      publicRoomText.includes("Server 1") && publicRoomText.includes("PXB875"),
      `Public room row did not show fixed server/code text: ${JSON.stringify(publicRoomText)}.`,
    );
    await publicListPage.evaluate(
      "document.querySelector('[data-action=\"room-join-public\"]')?.click()",
    );
    await waitForMatch(publicListPage, MAP_ID);
    await assertMatchViewportCentered(publicListPage, "Public room join");

    return {
      roomCode,
      inviteUrlHasCode: roomUrl.includes(`room=${roomCode}`),
      hostPhase: await hostPage.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.phase ?? null"),
      joinScreen: await joinPage.evaluate("window.__dustlineQa__?.getState()?.screen ?? null"),
      guestInviteButton,
      closedInviteRole: closedState?.roomSetup?.connection?.role ?? null,
      closedCodeRole: codeFallbackState?.roomSetup?.connection?.role ?? null,
      publicJoinScreen: await publicListPage.evaluate("window.__dustlineQa__?.getState()?.screen ?? null"),
      publicJoinButtons,
      publicRoomText,
    };
  } finally {
    await Promise.allSettled([
      hostPage.close(),
      joinPage?.close(),
      closedPage?.close(),
      codeFallbackPage?.close(),
      publicListPage?.close(),
    ]);
  }
}

async function probeOutboundSignalingGuardrail(page) {
  await page.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
  );
  await page.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
  await waitForRoomCode(page);
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

async function probeOutboundNullableIceCandidate(page) {
  await page.evaluate(
    `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
  );
  await page.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
  await waitForRoomCode(page);
  await waitForRoomPhase(page, "waiting");

  const sent = await page.evaluate(
    `window.__dustlineQa__.sendSignalingPayload(${JSON.stringify({
      type: "ice-candidate",
      toPeerId: "missing-guest",
      candidate: {
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
    })})`,
  );
  assert(sent === true, "End-of-candidates ICE marker with nullable fields should pass the client guard.");

  await waitForRoomPhase(page, "error");
  const detail = await page.evaluate("window.__dustlineQa__?.getState()?.roomSetup?.connection?.detail ?? ''");
  assert(
    typeof detail === "string" && detail.includes("Target peer is not connected"),
    "Nullable ICE marker should reach signaling instead of failing client-side validation.",
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
  await waitForRoomCode(page);
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

  const guestPeerId = await joinPage.evaluate(
    "window.__dustlineQa__?.getState()?.match?.localPlayer?.id ?? null",
  );
  const roomId = await joinPage.evaluate(
    "window.__dustlineQa__?.getState()?.match?.roomId ?? null",
  );
  assert(typeof guestPeerId === "string" && guestPeerId.length > 0, "Guest peer id was unavailable.");
  assert(typeof roomId === "string" && roomId.length > 0, "Room id was unavailable.");

  for (let index = 0; index < 4; index += 1) {
    const staleClockHeartbeat = JSON.stringify({
      protocol: "dustline-room",
      version: 3,
      type: "heartbeat",
      roomId,
      fromPeerId: guestPeerId,
      toPeerId: hostPeerId,
      seq: 1_000_000 + index,
      sentAt: Date.now() - 60_000,
      payload: {
        rosterCount: 2,
        phase: "active",
      },
    });
    const sent = await joinPage.evaluate(
      `window.__dustlineQa__.sendRawRoomMessage(${JSON.stringify(staleClockHeartbeat)}, ${JSON.stringify(hostPeerId)})`,
    );
    assert(sent === true, "Clock-skewed heartbeat should traverse the open data channel.");
  }

  await delay(200);
  const hostPeerCountAfterSkew = await hostPage.evaluate(
    "window.__dustlineQa__?.getState()?.roomSetup?.connection?.peerCount ?? null",
  );
  assert(hostPeerCountAfterSkew === 1, "Clock-skewed but ordered reliable messages should not disconnect a peer.");

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

async function probeRelayIdlePolicy() {
  const hostPage = await createPage(`${ROOT_URL}?qa=1`);
  const joinPage = await createPage(`${ROOT_URL}?qa=1`);

  try {
    await hostPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-host")`,
    );
    await hostPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    await hostPage.waitForExpression(
      "typeof window.__dustlineQa__.getRoomCode() === 'string'",
      8_000,
    );
    const roomCode = await hostPage.evaluate("window.__dustlineQa__.getRoomCode()");
    assert(typeof roomCode === "string" && roomCode.length >= 6, "Relay-idle host room code was not generated.");

    await joinPage.evaluate(
      `window.__dustlineQa__.openRoomSetup(${JSON.stringify(MAP_ID)}, "signal-join")`,
    );
    await joinPage.waitForExpression("window.__dustlineQa__?.getState()?.screen === 'room'");
    const joined = await joinPage.evaluate(
      `window.__dustlineQa__.joinSignalingRoom(${JSON.stringify(roomCode)})`,
    );
    assert(joined === true, "Relay-idle guest did not start the signaling join flow.");

    await waitForRoomPhase(hostPage, "connected");
    await waitForRoomPhase(joinPage, "connected");

    assert((await hostPage.evaluate("window.__dustlineQa__.enterArena()")) === true, "Relay-idle host could not enter.");
    assert((await joinPage.evaluate("window.__dustlineQa__.enterArena()")) === true, "Relay-idle guest could not enter.");
    await waitForMatch(hostPage, MAP_ID);
    await waitForMatch(joinPage, MAP_ID);
    await hostPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.remotePlayers?.length ?? 0) === 1",
      10_000,
    );
    const defaultRelayIdle = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.relayIdle ?? null",
    );
    assert(defaultRelayIdle?.disabled === true, "Relay-idle kicking should be disabled by default.");

    const configured = await hostPage.evaluate(
      `window.__dustlineQa__.configureRelayIdleQa(${JSON.stringify({
        forceRelay: true,
        warningMs: 1_200,
        disconnectMs: 2_600,
      })})`,
    );
    assert(configured === true, "Could not configure relay-idle QA policy.");

    await hostPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.relayIdle?.peers?.[0]?.warned === true",
      3_000,
    );
    const warningDetail = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.detail ?? ''",
    );
    assert(
      typeof warningDetail === "string" && warningDetail.includes("Relay idle warning"),
      "Relay-idle warning did not surface in the room detail.",
    );

    const resetSent = await joinPage.evaluate("window.__dustlineQa__.sendInputTick(0, 1, false)");
    assert(resetSent === true, "Relay-idle reset input tick was not sent.");
    await hostPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.relayIdle?.peers?.[0]?.warned === false",
      2_000,
    );
    const resetDetail = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.detail ?? ''",
    );
    assert(
      typeof resetDetail === "string" && !resetDetail.includes("Relay idle warning"),
      "Relay-idle warning did not clear after gameplay input.",
    );

    await joinPage.evaluate("window.__dustlineQa__.clearInputState()");
    await hostPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.match?.roomConnection?.peerCount ?? -1) === 0",
      5_000,
    );
    await joinPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? "").includes("relay") ||
        (window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? "").includes("Relay")`,
      5_000,
    );

    return {
      warningDetail,
      resetDetail,
      hostPeerCount: await hostPage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.roomConnection?.peerCount ?? null",
      ),
      guestSupportError: await joinPage.evaluate(
        "window.__dustlineQa__?.getState()?.roomSetup?.supportError ?? ''",
      ),
    };
  } finally {
    await Promise.allSettled([hostPage.close(), joinPage.close()]);
  }
}

async function main() {
  const preview = await startPreview();
  const chrome = await startChrome();
  const pages = [];

  try {
    let guardrails = null;
    if (GUEST_COUNT === 1) {
      const roomSetupExperience = await probeRoomSetupExperience();

      const outboundProbePage = await createPage(`${ROOT_URL}?qa=1`);
      pages.push(outboundProbePage);
      const outboundOfferRejected = await probeOutboundSignalingGuardrail(outboundProbePage);
      await outboundProbePage.close();

      const nullableCandidateProbePage = await createPage(`${ROOT_URL}?qa=1`);
      pages.push(nullableCandidateProbePage);
      const nullableIceCandidateAccepted = await probeOutboundNullableIceCandidate(nullableCandidateProbePage);
      await nullableCandidateProbePage.close();

      const inboundProbePage = await createPage(`${ROOT_URL}?qa=1`);
      pages.push(inboundProbePage);
      const repeatedInvalidSignaling = await probeInboundSignalingGuardrail(inboundProbePage);
      await inboundProbePage.close();

      const relayIdlePolicy = await probeRelayIdlePolicy();

      guardrails = {
        outboundOfferRejected,
        nullableIceCandidateAccepted,
        repeatedInvalidSignaling,
        roomSetupExperience,
        relayIdlePolicy,
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
    const roomCode = await waitForRoomCode(hostPage);
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

    let guestInputCadenceTicks = null;
    if (joinPages[0]) {
      const cadencePage = joinPages[0];
      const beforeCadence = await cadencePage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.localPlayer?.lastSentInputSequence ?? 0",
      );
      await cadencePage.evaluate("window.__dustlineQa__.clearInputState()");
      await cadencePage.evaluate("window.__dustlineQa__.setInputState(0, 1, false)");
      await cadencePage.bringToFront();
      const cadenceWindowMs = GUEST_COUNT > 1 ? 500 : 180;
      const requiredCadenceTicks = GUEST_COUNT > 1 ? 1 : 2;
      await delay(cadenceWindowMs);
      const afterCadence = await cadencePage.evaluate(
        "window.__dustlineQa__?.getState()?.match?.localPlayer?.lastSentInputSequence ?? 0",
      );
      guestInputCadenceTicks = afterCadence - beforeCadence;
      assert(
        guestInputCadenceTicks >= requiredCadenceTicks,
        `Guest fixed input cadence only advanced ${guestInputCadenceTicks} ticks in ${cadenceWindowMs}ms.`,
      );
      await cadencePage.evaluate("window.__dustlineQa__.clearInputState()");
    }

    await hostPage.bringToFront();
    const hostSnapshotIdBeforeDelta = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection?.lastSnapshotId ?? 0",
    );
    if (joinPages[0]) {
      for (let index = 0; index < 4; index += 1) {
        const sent = await joinPages[0].evaluate("window.__dustlineQa__.sendInputTick(0, 1, false)");
        assert(sent === true, "Guest manual input tick should send while the host tab is active.");
        await delay(60);
      }
    }
    await hostPage.waitForExpression(
      `(() => {
        const connection = window.__dustlineQa__?.getState()?.match?.roomConnection;
        return (
          connection?.lastSnapshotEncoding === "delta" &&
          (connection?.lastSnapshotBytes ?? 0) > 0 &&
          (connection?.lastSnapshotId ?? 0) > ${hostSnapshotIdBeforeDelta}
        );
      })()`,
      10_000,
    );
    await hostPage.waitForExpression(
      `(() => {
        const peers = window.__dustlineQa__?.getState()?.match?.roomConnection?.transport?.peers;
        return Array.isArray(peers) && peers.length > 0 && (peers[0]?.sampledAt ?? 0) > 0;
      })()`,
      12_000,
    );
    const hostRoomConnectionDebug = await hostPage.evaluate(
      "window.__dustlineQa__?.getState()?.match?.roomConnection ?? null",
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
      guestInputCadenceTicks,
      hostSnapshotEncoding: hostRoomConnectionDebug?.lastSnapshotEncoding ?? null,
      hostSnapshotBytes: hostRoomConnectionDebug?.lastSnapshotBytes ?? null,
      hostTransport: hostRoomConnectionDebug?.transport ?? null,
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
        const state = await page.evaluate(`
          (() => {
            const state = window.__dustlineQa__?.getState?.() ?? null;
            if (!state) {
              return null;
            }

            return {
              screen: state.screen,
              activeMapId: state.activeMapId,
              activeMode: state.activeMode,
              roomSetup: state.roomSetup
                ? {
                    kind: state.roomSetup.kind,
                    phase: state.roomSetup.phase,
                    supportError: state.roomSetup.supportError,
                    closedRoomMessage: state.roomSetup.closedRoomMessage,
                    connection: state.roomSetup.connection
                      ? {
                          kind: state.roomSetup.connection.kind,
                          phase: state.roomSetup.connection.phase,
                          detail: state.roomSetup.connection.detail,
                          participantCount: state.roomSetup.connection.participantCount,
                          peerCount: state.roomSetup.connection.peerCount,
                          peerIds: state.roomSetup.connection.peerIds,
                          transportPeerCount: state.roomSetup.connection.transport?.peers?.length ?? null,
                        }
                      : null,
                  }
                : null,
              match: state.match
                ? {
                    mapId: state.match.mapId,
                    activeMode: state.match.activeMode,
                    sharedRole: state.match.sharedRole,
                    rosterCount: state.match.roster?.length ?? 0,
                    remoteCount: state.match.remotePlayers?.length ?? 0,
                    localPlayerId: state.match.localPlayer?.id ?? null,
                    roomConnection: state.match.roomConnection
                      ? {
                          phase: state.match.roomConnection.phase,
                          detail: state.match.roomConnection.detail,
                          participantCount: state.match.roomConnection.participantCount,
                          peerCount: state.match.roomConnection.peerCount,
                          peerIds: state.match.roomConnection.peerIds,
                          transportPeerCount: state.match.roomConnection.transport?.peers?.length ?? null,
                        }
                      : null,
                  }
                : null,
              startupError:
                document.querySelector(".world-stage__error code")?.textContent?.trim() ??
                document.querySelector(".world-stage__error")?.textContent?.trim() ??
                "",
            };
          })()
        `);
        diagnostics.push({
          index,
          state,
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
