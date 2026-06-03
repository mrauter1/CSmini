import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUN_SEED = Date.now() % 1000;
const PREVIEW_PORT = String(4173 + (RUN_SEED % 200));
const DEBUG_PORT = String(9223 + (RUN_SEED % 200));
const ROOT_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
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
  "13-held-tab-operations-board.png",
  "14-sandline-loading-bay-marker.png",
  "15-sandline-water-tower-gate-marker.png",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function pointDistance2d(left, right) {
  return Math.hypot((left?.x ?? 0) - (right?.x ?? 0), (left?.z ?? 0) - (right?.z ?? 0));
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
  const child = record?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exitPromise.then(() => false),
    delay(2_000).then(() => true),
  ]);

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
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

    const closed = new Promise((resolve) => {
      const settle = () => resolve();
      this.socket.addEventListener("close", settle, { once: true });
      this.socket.addEventListener("error", settle, { once: true });
    });

    this.socket.close();
    await Promise.race([closed, delay(500)]);
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

  async trustedClick(selector) {
    const rect = await this.evaluate(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) {
          return null;
        }
        const box = element.getBoundingClientRect();
        return {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
          width: box.width,
          height: box.height,
        };
      })()
    `);

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: rect.x,
      y: rect.y,
      button: "none",
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: rect.x,
      y: rect.y,
      button: "left",
      clickCount: 1,
    });
    await delay(120);
    return true;
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

async function waitForQaReady(page) {
  await page.waitForExpression("document.readyState === 'complete'");
  await page.waitForExpression(
    `
      typeof window.__dustlineQa__?.getState === 'function'
        && typeof window.__dustlineQa__?.setTeamPreference === 'function'
        && typeof window.__dustlineQa__?.setBotDifficulty === 'function'
        && typeof window.__dustlineQa__?.openMap === 'function'
    `,
    15_000,
  );
}

async function createPage(url, initScript, options = {}) {
  const { resetStorage = true } = options;
  const target = await requestJsonNew("about:blank");
  const page = new CdpPage(target.webSocketDebuggerUrl);
  await page.enablePage();

  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      ${
        resetStorage
          ? `
      try {
        localStorage.removeItem("dustline.classicCrouchAlias");
        localStorage.removeItem("dustline.soloBotDifficulty");
      } catch {}
      `
          : ""
      }

      ${initScript ?? ""}
    `,
  });

  await page.send("Page.navigate", { url });
  await waitForQaReady(page);
  return page;
}

async function reloadPage(page) {
  await page.send("Page.reload", { ignoreCache: true });
  await waitForQaReady(page);
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
  const alreadyEngaged = await page.evaluate(
    "window.__dustlineQa__?.getState()?.localPlayer?.pointerCaptured === true",
  );
  if (!alreadyEngaged) {
    const clicked = await page.trustedClick('[data-action="lock-match"]');
    if (!clicked) {
      await page.evaluate("window.__dustlineQa__.engageControls()");
    }
  }
  await page.waitForExpression(
    "window.__dustlineQa__?.getState()?.localPlayer?.pointerCaptured === true",
    5_000,
  );
  await page.waitForExpression(
    "window.__dustlineQa__?.getState()?.audioState?.contextState === 'running'",
    5_000,
  );
  await page.waitForExpression(
    "window.__dustlineQa__?.getState()?.audioState?.audioArmed === true",
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

async function readHud(page) {
  return page.evaluate(`
    (() => {
      const visible = (selector) => {
        const node = document.querySelector(selector);
        if (!node || node.hidden) {
          return false;
        }
        const style = window.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };

      return {
        mapName: document.querySelector('[data-ui="map-name"]')?.textContent?.trim() ?? '',
        modeNotice: document.querySelector('[data-ui="mode-notice"]')?.textContent?.trim() ?? '',
        roundNumber: document.querySelector('[data-ui="round-number"]')?.textContent?.trim() ?? '',
        roundPhase: document.querySelector('[data-ui="round-phase"]')?.textContent?.trim() ?? '',
        roundTimer: document.querySelector('[data-ui="round-timer"]')?.textContent?.trim() ?? '',
        missionLabel: document.querySelector('[data-ui="mission-label"]')?.textContent?.trim() ?? '',
        objectiveLabel: document.querySelector('[data-ui="objective-label"]')?.textContent?.trim() ?? '',
        missionSummary: document.querySelector('[data-ui="mission-summary"]')?.textContent?.trim() ?? '',
        objectiveStatus: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        objectiveProgress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? '',
        teamName: document.querySelector('[data-ui="team-name"]')?.textContent?.trim() ?? '',
        aliveState: document.querySelector('[data-ui="alive-state"]')?.textContent?.trim() ?? '',
        firingStatus: document.querySelector('[data-ui="firing-status"]')?.textContent?.trim() ?? '',
        health: document.querySelector('[data-ui="health"]')?.textContent?.trim() ?? '',
        ammo: document.querySelector('[data-ui="ammo"]')?.textContent?.trim() ?? '',
        playerCount: document.querySelector('[data-ui="player-count"]')?.textContent?.trim() ?? '',
        promptVisible: visible('[data-ui="prompt-panel"]'),
        deathVisible: visible('[data-ui="death-panel"]'),
        scoreboardVisible: visible('[data-ui="scoreboard-panel"]'),
        debugScoreboardVisible: Boolean(window.__dustlineQa__?.getState()?.scoreboardVisible),
        legacyHudSurfaces: document.querySelectorAll('.hud-card, .hud-overlay').length,
        fullscreenButtonVisible: visible('[data-ui="fullscreen-toggle"]'),
        fullscreenButtonLabel: document.querySelector('[data-ui="fullscreen-toggle"]')?.getAttribute('aria-label') ?? '',
        fullscreenButtonTitle: document.querySelector('[data-ui="fullscreen-toggle"]')?.getAttribute('title') ?? '',
        fullscreenButtonDisabled: Boolean(document.querySelector('[data-ui="fullscreen-toggle"]')?.disabled),
        fullscreenButtonInsideViewport: Boolean(document.querySelector('[data-ui="fullscreen-toggle"]')?.closest('[data-world-shell]')),
        fullscreenButtonActive: document.querySelector('[data-ui="fullscreen-toggle"]')?.dataset.fullscreenActive ?? '',
        fullscreenButtonText: document.querySelector('[data-ui="fullscreen-toggle"]')?.textContent?.trim() ?? '',
        teamCountsText: document.querySelector('[data-ui="team-counts"]')?.textContent?.trim() ?? '',
        rosterText: document.querySelector('[data-ui="roster"]')?.textContent?.trim() ?? '',
        controlsText: document.querySelector('[data-ui="scoreboard-panel"] .scoreboard-controls')?.textContent?.trim() ?? '',
      };
    })()
  `);
}

function objectiveMarkerEntries(state, kind) {
  return state?.objectiveMarkers?.entries?.filter((entry) => entry.kind === kind) ?? [];
}

function assertObjectiveMarker(state, { kind, label, active = undefined, hudLabelMatch = undefined }) {
  const marker = objectiveMarkerEntries(state, kind).find((entry) => entry.label === label);
  assert(marker, `Expected ${kind} marker for ${label}`);
  assert(marker.visible === true, `Expected ${label} marker to be visible`);
  assert(typeof marker.radius === "number" && marker.radius > 0, `Expected ${label} marker to expose radius`);
  assert(marker.position, `Expected ${label} marker to expose position`);
  if (active !== undefined) {
    assert(marker.active === active, `Expected ${label} active marker state ${active}, saw ${marker.active}`);
  }
  if (hudLabelMatch !== undefined) {
    assert(
      marker.hudLabelMatch === hudLabelMatch,
      `Expected ${label} marker HUD-label match ${hudLabelMatch}, saw ${marker.hudLabelMatch}`,
    );
  }
  return marker;
}

async function captureScreenshot(page, filename, capturedScreenshots) {
  assert(SCREENSHOTS.includes(filename), `Unexpected screenshot target: ${filename}`);
  await page.captureScreenshot(filename);
  capturedScreenshots.add(filename);
}

function findFocusPoint(state, focusId) {
  const focusPoint = state?.focusPoints?.find((entry) => entry.id === focusId) ?? null;
  assert(focusPoint, `Missing focus point ${focusId}`);
  return focusPoint;
}

async function setFocusView(page, state, focusId) {
  const focusPoint = findFocusPoint(state, focusId);
  await page.evaluate(
    `window.__dustlineQa__.setView(${focusPoint.cameraPosition.x}, ${focusPoint.cameraPosition.y}, ${focusPoint.cameraPosition.z}, ${focusPoint.target.x}, ${focusPoint.target.y}, ${focusPoint.target.z})`,
  );
  await delay(180);
}

async function setTeamPreference(page, teamPreference) {
  await page.evaluate(
    `window.__dustlineQa__.setTeamPreference(${JSON.stringify(teamPreference)})`,
  );
  await delay(120);
}

async function setBotDifficulty(page, botDifficulty) {
  await page.evaluate(
    `window.__dustlineQa__.setBotDifficulty(${JSON.stringify(botDifficulty)})`,
  );
  await delay(120);
}

async function readBotDifficultyUi(page) {
  return page.evaluate(`
    (() => {
      const activeButton = document.querySelector('[data-action="set-bot-difficulty"][aria-pressed="true"]');
      return {
        count: document.querySelectorAll('[data-action="set-bot-difficulty"]').length,
        active: activeButton?.getAttribute('data-bot-difficulty') ?? null,
        current: document.querySelector('[data-ui="bot-difficulty-current"]')?.textContent?.trim() ?? '',
        note: document.querySelector('[data-ui="bot-difficulty-note"]')?.textContent?.trim() ?? '',
      };
    })()
  `);
}

async function returnToCatalog(page) {
  await page.evaluate("window.__dustlineQa__.returnToCatalog()");
  await page.waitForExpression("Boolean(document.querySelector('.screen--catalog'))", 10_000);
}

async function dispatchWindowKey(page, type, code, key) {
  await page.evaluate(
    `window.__dustlineQa__.setKey(${JSON.stringify(code)}, ${type === "keydown" ? "true" : "false"})`,
  );
}

async function keyboardDefaultPrevented(page, type, code, key, repeat = false) {
  return page.evaluate(`
    (() => {
      const event = new KeyboardEvent(${JSON.stringify(type)}, {
        code: ${JSON.stringify(code)},
        key: ${JSON.stringify(key)},
        repeat: ${repeat ? "true" : "false"},
        bubbles: true,
        cancelable: true
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()
  `);
}

async function exerciseMockFullscreen(page) {
  return page.evaluate(`
    (async () => {
      const shell = document.querySelector('[data-world-shell]');
      const host = document.querySelector('[data-world-host]');
      const button = document.querySelector('[data-ui="fullscreen-toggle"]');
      if (!shell || !host || !button) {
        return null;
      }

      const originalRequest = shell.requestFullscreen;
      const originalExit = document.exitFullscreen;
      const hadOwnFullscreenElement = Object.prototype.hasOwnProperty.call(document, 'fullscreenElement');
      const originalFullscreenElement = hadOwnFullscreenElement
        ? Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
        : null;
      let fullscreenElement = null;
      let requestTargetMatchesShell = false;
      let requestCount = 0;
      let exitCount = 0;

      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => fullscreenElement,
      });

      shell.requestFullscreen = function () {
        requestTargetMatchesShell = this === shell;
        requestCount += 1;
        fullscreenElement = this;
        shell.style.width = '1012px';
        shell.style.height = '720px';
        shell.style.minHeight = '720px';
        shell.style.border = '0';
        shell.style.borderRadius = '0';
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };

      document.exitFullscreen = function () {
        exitCount += 1;
        fullscreenElement = null;
        shell.style.width = '';
        shell.style.height = '';
        shell.style.minHeight = '';
        shell.style.border = '';
        shell.style.borderRadius = '';
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };

      try {
        button.click();
        await nextFrame();
        const entered = window.__dustlineQa__?.getState()?.fullscreen ?? null;
        const enteredLabel = button.getAttribute('aria-label') ?? '';
        const enteredActive = button.dataset.fullscreenActive ?? '';

        window.__dustlineQa__?.setKey('Tab', true);
        await nextFrame();
        const tabPanelVisible = Boolean(
          document.querySelector('[data-ui="scoreboard-panel"]')
            && !document.querySelector('[data-ui="scoreboard-panel"]').hidden
        );
        window.__dustlineQa__?.setKey('Tab', false);

        button.click();
        await nextFrame();
        const exited = window.__dustlineQa__?.getState()?.fullscreen ?? null;
        const exitedLabel = button.getAttribute('aria-label') ?? '';
        const exitedActive = button.dataset.fullscreenActive ?? '';

        return {
          requestTargetMatchesShell,
          requestCount,
          exitCount,
          entered,
          enteredLabel,
          enteredActive,
          tabPanelVisible,
          exited,
          exitedLabel,
          exitedActive,
        };
      } finally {
        shell.requestFullscreen = originalRequest;
        document.exitFullscreen = originalExit;
        shell.style.width = '';
        shell.style.height = '';
        shell.style.minHeight = '';
        shell.style.border = '';
        shell.style.borderRadius = '';
        if (originalFullscreenElement) {
          Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
        } else if (!hadOwnFullscreenElement) {
          delete document.fullscreenElement;
        }
      }
    })()
  `);
}

async function exerciseDeniedFullscreen(page) {
  return page.evaluate(`
    (async () => {
      const shell = document.querySelector('[data-world-shell]');
      const button = document.querySelector('[data-ui="fullscreen-toggle"]');
      if (!shell || !button) {
        return null;
      }

      const originalRequest = shell.requestFullscreen;
      const hadOwnFullscreenElement = Object.prototype.hasOwnProperty.call(document, 'fullscreenElement');
      const originalFullscreenElement = hadOwnFullscreenElement
        ? Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
        : null;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => null,
      });
      shell.requestFullscreen = () => Promise.reject(new Error('Denied for QA'));

      try {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          active: window.__dustlineQa__?.getState()?.fullscreen?.active ?? null,
          status: document.querySelector('[data-ui="status"]')?.textContent?.trim() ?? '',
        };
      } finally {
        shell.requestFullscreen = originalRequest;
        if (originalFullscreenElement) {
          Object.defineProperty(document, 'fullscreenElement', originalFullscreenElement);
        } else if (!hadOwnFullscreenElement) {
          delete document.fullscreenElement;
        }
      }
    })()
  `);
}

async function tapKey(page, code, key, holdMs = 60) {
  await dispatchWindowKey(page, "keydown", code, key);
  await delay(holdMs);
  await dispatchWindowKey(page, "keyup", code, key);
}

async function holdKey(page, code, key, holdMs) {
  await dispatchWindowKey(page, "keydown", code, key);
  await delay(holdMs);
  await dispatchWindowKey(page, "keyup", code, key);
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

async function stageSharedDuel(page, slot, aimOffsetY = 0) {
  const pose = await page.evaluate(`window.__dustlineQa__.stageSharedDuel(${slot}, ${aimOffsetY})`);
  assert(pose, `Could not stage shared duel pose for slot ${slot}`);
  await delay(180);
  return pose;
}

async function stageSharedRemotePose(hostPage, peerId, x, y, z, yaw = 0) {
  const staged = await hostPage.evaluate(
    `window.__dustlineQa__.stageSharedRemotePose(${JSON.stringify(peerId)}, ${x}, ${y}, ${z}, ${yaw})`,
  );
  assert(staged === true, `Could not stage shared remote pose for ${peerId}`);
  await delay(180);
}

async function startSharedRemoteObjectiveAction(hostPage, peerId) {
  const started = await hostPage.evaluate(
    `window.__dustlineQa__.startSharedRemoteObjectiveAction(${JSON.stringify(peerId)})`,
  );
  assert(started === true, `Could not start shared remote objective action for ${peerId}`);
}

async function completeSharedRemoteObjectiveAction(hostPage, peerId) {
  const completed = await hostPage.evaluate(
    `window.__dustlineQa__.completeSharedRemoteObjectiveAction(${JSON.stringify(peerId)})`,
  );
  assert(completed === true, `Could not complete shared remote objective action for ${peerId}`);
}

async function forceDeath(page, attackerName) {
  await page.evaluate(`window.__dustlineQa__.forcePlayerDeath(${JSON.stringify(attackerName)})`);
}

async function forceRoundActive(page) {
  await page.evaluate("window.__dustlineQa__.forceRoundActive()");
}

async function setInvulnerable(page, enabled) {
  await page.evaluate(`window.__dustlineQa__.setInvulnerable(${enabled ? "true" : "false"})`);
}

async function startObjectiveAction(page) {
  const started = await page.evaluate("window.__dustlineQa__.startObjectiveAction()");
  assert(started, "Expected objective action to start from the current QA pose");
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

async function stageAiSightlineCase(page, options = {}) {
  const sightlineCase = await page.evaluate(
    `window.__dustlineQa__.stageAiSightlineCase(${JSON.stringify(Boolean(options.seedLastKnown))})`,
  );
  assert(sightlineCase, "Expected a deterministic AI sightline case");
  await delay(180);
  return sightlineCase;
}

async function stageAiCommunicationCase(page) {
  const communicationCase = await page.evaluate("window.__dustlineQa__.stageAiCommunicationCase()");
  assert(communicationCase, "Expected a deterministic AI communication case");
  await delay(180);
  return communicationCase;
}

async function stageAiRecoveryCase(page) {
  const recoveryCase = await page.evaluate("window.__dustlineQa__.stageAiRecoveryCase()");
  assert(recoveryCase, "Expected a deterministic AI recovery case");
  await delay(180);
  return recoveryCase;
}

async function stageEnemyBombPlantCase(page) {
  const plantCase = await page.evaluate("window.__dustlineQa__.stageEnemyBombPlantCase()");
  assert(plantCase, "Expected a deterministic enemy bomb-plant case");
  await delay(180);
  return plantCase;
}

async function stageEnemyRelayRouteCase(page) {
  const routeCase = await page.evaluate("window.__dustlineQa__.stageEnemyRelayRouteCase()");
  assert(routeCase, "Expected a deterministic enemy relay-route case");
  await delay(180);
  return routeCase;
}

async function stageEnemyObjectiveThreatCase(page) {
  const threatCase = await page.evaluate("window.__dustlineQa__.stageEnemyObjectiveThreatCase()");
  assert(threatCase, "Expected a deterministic enemy objective-threat case");
  await delay(180);
  return threatCase;
}

async function stageEnemyRelayDefuseCase(page) {
  const defuseCase = await page.evaluate("window.__dustlineQa__.stageEnemyRelayDefuseCase()");
  assert(defuseCase, "Expected a deterministic enemy relay-defuse case");
  await delay(180);
  return defuseCase;
}

async function stageEnemyHostageEscortCase(page) {
  const escortCase = await page.evaluate("window.__dustlineQa__.stageEnemyHostageEscortCase()");
  assert(escortCase, "Expected a deterministic enemy hostage-escort case");
  await delay(180);
  return escortCase;
}

async function evaluateEnemyShot(page, combatantId, overrides = undefined) {
  const profile = await page.evaluate(
    `window.__dustlineQa__.evaluateEnemyShot(${JSON.stringify(combatantId)}, ${JSON.stringify(overrides)})`,
  );
  assert(profile, `Expected an AI shot profile for ${combatantId}`);
  return profile;
}

async function enemyMovementSample(page, combatantId) {
  const sample = await page.evaluate(
    `window.__dustlineQa__.enemyMovementSample(${JSON.stringify(combatantId)})`,
  );
  assert(sample, `Expected a bot movement sample for ${combatantId}`);
  return sample;
}

async function requestEnemyJump(page, combatantId) {
  const requested = await page.evaluate(
    `window.__dustlineQa__.requestEnemyJump(${JSON.stringify(combatantId)})`,
  );
  assert(requested, `Expected live bot jump request to succeed for ${combatantId}`);
}

function assertWeaponViewAlignment(state, label) {
  const weapon = state?.weaponView;
  assert(weapon, `Expected ${label} to expose weapon view debug state`);
  assert(weapon.lowRight === true, `Expected ${label} weapon to stay anchored low-right`);
  assert(weapon.forwardAligned === true, `Expected ${label} weapon barrel to align with camera -Z`);
  assert(weapon.muzzleAheadOfRoot === true, `Expected ${label} muzzle to sit forward of the receiver`);
  assert(
    weapon.barrelForward?.z < -0.94,
    `Expected ${label} barrel forward Z below -0.94, saw ${weapon.barrelForward?.z}`,
  );
  assert(
    weapon.muzzleCameraPosition?.z < weapon.rootPosition?.z - 0.18,
    `Expected ${label} muzzle camera-space Z to be ahead of root`,
  );
}

function assertAlivePosture(entries, label) {
  const aliveEntries = (entries ?? []).filter(
    (entry) => entry && entry.alive !== false && entry.status !== "down",
  );
  assert(aliveEntries.length > 0, `Expected at least one live ${label} posture sample`);

  for (const entry of aliveEntries) {
    const posture = entry.posture;
    const actorLabel = entry.id ?? entry.name ?? "actor";
    assert(posture, `Expected ${label} ${actorLabel} to expose posture debug state`);
    assert(posture.upright === true, `Expected ${label} ${actorLabel} to stay upright`);
    assert(posture.aboveGround === true, `Expected ${label} ${actorLabel} to stay above ground`);
    assert(
      Math.abs(posture.rotation?.x ?? 999) <= 0.01,
      `Expected ${label} ${actorLabel} root pitch near zero, saw ${posture.rotation?.x}`,
    );
    assert(
      Math.abs(posture.rotation?.z ?? 999) <= 0.08,
      `Expected ${label} ${actorLabel} root roll near zero, saw ${posture.rotation?.z}`,
    );
    assert(
      posture.feetY >= -0.01,
      `Expected ${label} ${actorLabel} feet above ground, saw ${posture.feetY}`,
    );
  }
}

function assertAimContract(entries, label) {
  const aliveEntries = (entries ?? []).filter(
    (entry) => entry && entry.status !== "down" && entry.aim,
  );
  assert(aliveEntries.length > 0, `Expected at least one live ${label} aim sample`);

  for (const entry of aliveEntries) {
    const actorLabel = entry.id ?? entry.name ?? "actor";
    assert(
      Math.abs(entry.posture?.rotation?.x ?? 999) <= 0.01,
      `Expected ${label} ${actorLabel} root to stay unpitched while aiming`,
    );
    assert(
      entry.aim.bodyDot > 0.94,
      `Expected ${label} ${actorLabel} body forward to track horizontal look, saw ${entry.aim.bodyDot}`,
    );
    assert(
      entry.aim.weaponDot > 0.94,
      `Expected ${label} ${actorLabel} weapon to track full look vector, saw ${entry.aim.weaponDot}`,
    );
    assert(
      entry.aim.weaponTracksPitch === true,
      `Expected ${label} ${actorLabel} weapon pitch to track look pitch`,
    );
  }
}

const EXPECTED_TEAM_VISUALS = {
  amber: {
    jacketColor: "#735036",
    vestColor: "#C79258",
    trouserColor: "#4E3F30",
    hasDominoMask: true,
  },
  cobalt: {
    jacketColor: "#3F5863",
    vestColor: "#6F8FAA",
    trouserColor: "#273B45",
    hasDominoMask: false,
  },
};

function assertTeamVisual(entries, teamId, label) {
  const expected = EXPECTED_TEAM_VISUALS[teamId];
  const teamEntries = (entries ?? []).filter((entry) => entry?.teamId === teamId);
  assert(teamEntries.length > 0, `Expected at least one ${label} ${teamId} visual sample`);

  for (const entry of teamEntries) {
    const visual = entry.visual;
    const actorLabel = entry.id ?? entry.name ?? "actor";
    assert(visual, `Expected ${label} ${actorLabel} to expose team visual debug state`);
    assert(
      visual.jacketColor === expected.jacketColor,
      `Expected ${label} ${actorLabel} jacket ${expected.jacketColor}, saw ${visual.jacketColor}`,
    );
    assert(
      visual.vestColor === expected.vestColor,
      `Expected ${label} ${actorLabel} vest ${expected.vestColor}, saw ${visual.vestColor}`,
    );
    assert(
      visual.trouserColor === expected.trouserColor,
      `Expected ${label} ${actorLabel} trousers ${expected.trouserColor}, saw ${visual.trouserColor}`,
    );
    assert(
      visual.hasDominoMask === expected.hasDominoMask,
      `Expected ${label} ${actorLabel} domino mask ${expected.hasDominoMask}, saw ${visual.hasDominoMask}`,
    );
  }
}

function worldFireEvents(state) {
  return (state?.audio ?? []).filter((event) => event.type === "world-fire");
}

function playableWorldFireEvents(state) {
  return worldFireEvents(state).filter((event) => event.playable === true);
}

function shotEvents(state, type) {
  return (state?.shots?.events ?? []).filter((event) => event.type === type);
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
  const capturedScreenshots = new Set();

  try {
    const summary = {
      botDifficulty: {},
      mapCards: 0,
      mapChecks: [],
      movement: {},
      respawn: {},
      bombLocal: {},
      hostageLocal: {},
      aiLocal: {},
      aiSoloRound: {},
      bombShared: {},
      hostageShared: {},
      shared: {},
      presentation: {},
      fullscreen: {},
      fallback: {},
      classicFeel: {},
    };

    const localPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(localPage);

    await localPage.bringToFront();
    await localPage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    await captureScreenshot(localPage, "01-menu-briefing.png", capturedScreenshots);

    const defaultDifficultyState = await getState(localPage);
    const defaultDifficultyUi = await readBotDifficultyUi(localPage);
    assert(
      defaultDifficultyState?.botDifficulty === "medium",
      `Expected default solo bot difficulty to be medium, saw ${defaultDifficultyState?.botDifficulty}`,
    );
    assert(defaultDifficultyUi.count === 3, `Expected 3 solo bot difficulty controls, saw ${defaultDifficultyUi.count}`);
    assert(
      defaultDifficultyUi.active === "medium",
      `Expected medium difficulty button to be active by default, saw ${defaultDifficultyUi.active}`,
    );
    assert(
      /solo rounds only/i.test(defaultDifficultyUi.note) &&
        /human-only/i.test(defaultDifficultyUi.note),
      `Expected solo/shared scope note for bot difficulty, saw "${defaultDifficultyUi.note}"`,
    );

    await click(
      localPage,
      '[data-action="set-bot-difficulty"][data-bot-difficulty="hard"]',
    );
    const hardMenuState = await getState(localPage);
    const hardStoredValue = await localPage.evaluate(`
      (() => {
        try {
          return localStorage.getItem('dustline.soloBotDifficulty');
        } catch {
          return null;
        }
      })()
    `);
    assert(
      hardMenuState?.botDifficulty === "hard",
      `Expected hard difficulty selection to update shell state, saw ${hardMenuState?.botDifficulty}`,
    );
    assert(
      hardStoredValue === "hard",
      `Expected hard difficulty to persist in localStorage, saw ${hardStoredValue}`,
    );

    await setBotDifficulty(localPage, "medium");
    const restoredMenuState = await getState(localPage);
    assert(
      restoredMenuState?.botDifficulty === "medium",
      `Expected explicit medium selection to restore shell state, saw ${restoredMenuState?.botDifficulty}`,
    );

    await click(localPage, '[data-action="show-catalog"]');
    summary.mapCards = await localPage.waitForExpression("document.querySelectorAll('.map-card').length");
    assert(summary.mapCards === 5, `Expected 5 map cards, saw ${summary.mapCards}`);
    await captureScreenshot(localPage, "02-map-select-roster.png", capturedScreenshots);

    const catalogDifficultyUi = await readBotDifficultyUi(localPage);
    assert(
      catalogDifficultyUi.active === "medium",
      `Expected catalog difficulty state to stay on medium after restore, saw ${catalogDifficultyUi.active}`,
    );

    await click(
      localPage,
      '[data-action="set-bot-difficulty"][data-bot-difficulty="hard"]',
    );
    await openMap(localPage, "sandline-foundry", "local");
    const hardMatchState = await getState(localPage);
    const hardStageDifficultyUi = await readBotDifficultyUi(localPage);
    assert(
      hardMatchState?.botDifficulty === "hard",
      `Expected hard difficulty to flow into live local match debug state, saw ${hardMatchState?.botDifficulty}`,
    );
    assert(
      /solo-local fireteam/i.test(hardStageDifficultyUi.note),
      `Expected live local difficulty note to stay solo-local, saw "${hardStageDifficultyUi.note}"`,
    );

    await setBotDifficulty(localPage, "easy");
    const easyMatchState = await getState(localPage);
    assert(
      easyMatchState?.botDifficulty === "easy",
      `Expected easy difficulty hook to update live local match debug state, saw ${easyMatchState?.botDifficulty}`,
    );

    await returnToCatalog(localPage);
    await setBotDifficulty(localPage, "medium");
    const mediumCatalogState = await getState(localPage);
    assert(
      mediumCatalogState?.botDifficulty === "medium",
      `Expected explicit medium difficulty hook to restore catalog state, saw ${mediumCatalogState?.botDifficulty}`,
    );

    const persistencePage = await createPage(
      `${ROOT_URL}?qa=1`,
      `
        try {
          if (!sessionStorage.getItem("qa-bot-difficulty-reset")) {
            localStorage.removeItem("dustline.classicCrouchAlias");
            localStorage.removeItem("dustline.soloBotDifficulty");
            sessionStorage.setItem("qa-bot-difficulty-reset", "1");
          }
        } catch {}
      `,
      { resetStorage: false },
    );
    pages.push(persistencePage);

    await persistencePage.bringToFront();
    await persistencePage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    const persistenceInitialState = await getState(persistencePage);
    assert(
      persistenceInitialState?.botDifficulty === "medium",
      `Expected persistence test page to start from medium, saw ${persistenceInitialState?.botDifficulty}`,
    );
    await setBotDifficulty(persistencePage, "hard");
    await reloadPage(persistencePage);
    await persistencePage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    const persistenceReloadedState = await getState(persistencePage);
    assert(
      persistenceReloadedState?.botDifficulty === "hard",
      `Expected hard difficulty to survive reload, saw ${persistenceReloadedState?.botDifficulty}`,
    );

    const blockedStoragePage = await createPage(
      `${ROOT_URL}?qa=1`,
      `
        (() => {
          const originalGetItem = Storage.prototype.getItem;
          const originalSetItem = Storage.prototype.setItem;
          Storage.prototype.getItem = function (key) {
            if (key === "dustline.soloBotDifficulty") {
              throw new Error("Blocked by QA");
            }
            return originalGetItem.call(this, key);
          };
          Storage.prototype.setItem = function (key, value) {
            if (key === "dustline.soloBotDifficulty") {
              throw new Error("Blocked by QA");
            }
            return originalSetItem.call(this, key, value);
          };
        })();
      `,
    );
    pages.push(blockedStoragePage);

    await blockedStoragePage.bringToFront();
    await blockedStoragePage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    const blockedStorageDefaultState = await getState(blockedStoragePage);
    assert(
      blockedStorageDefaultState?.botDifficulty === "medium",
      `Expected blocked storage fallback to keep medium default, saw ${blockedStorageDefaultState?.botDifficulty}`,
    );
    await setBotDifficulty(blockedStoragePage, "easy");
    await openMap(blockedStoragePage, "sandline-foundry", "local");
    const blockedStorageMatchState = await getState(blockedStoragePage);
    assert(
      blockedStorageMatchState?.botDifficulty === "easy",
      `Expected blocked storage page to keep live easy selection in memory, saw ${blockedStorageMatchState?.botDifficulty}`,
    );
    assert(
      blockedStorageMatchState?.mapId === "sandline-foundry" &&
        blockedStorageMatchState?.activeMode === "local",
      "Expected blocked storage page to keep local match startup working",
    );

    summary.botDifficulty = {
      defaultValue: defaultDifficultyState?.botDifficulty ?? null,
      menuActive: defaultDifficultyUi.active,
      catalogRestoredValue: mediumCatalogState?.botDifficulty ?? null,
      liveHardValue: hardMatchState?.botDifficulty ?? null,
      liveEasyValue: easyMatchState?.botDifficulty ?? null,
      persistenceReloadedValue: persistenceReloadedState?.botDifficulty ?? null,
      blockedStorageDefaultValue: blockedStorageDefaultState?.botDifficulty ?? null,
      blockedStorageLiveValue: blockedStorageMatchState?.botDifficulty ?? null,
      scopeNote: hardStageDifficultyUi.note,
    };

    await persistencePage.close();
    await blockedStoragePage.close();
    await localPage.bringToFront();

    const mapIds = [
      "sandline-foundry",
      "transit-crates",
      "breaker-vault",
      "quarry-slip",
      "ledger-annex",
    ];

    for (const mapId of mapIds) {
      const positions = {};
      let lastState = null;

      for (const teamPreference of ["amber", "cobalt"]) {
        await setTeamPreference(localPage, teamPreference);
        await openMap(localPage, mapId, "local");
        await delay(220);

        const state = await getState(localPage);
        lastState = state;
        assert(state?.localPlayer?.teamId === teamPreference, `Expected ${mapId} to honor ${teamPreference} team selection`);
        assert(state?.round?.missionType === "bomb", `Expected ${mapId} round one to be bomb mode`);
        assert(state?.round?.missionLabel, `Expected ${mapId} to expose a live mission label`);
        assert(state?.round?.objectiveLabel, `Expected ${mapId} to expose a live objective label`);
        assert(state?.bomb?.siteLabel, `Expected ${mapId} to expose live bomb-site data`);
        assert(state?.teamCounts?.[teamPreference]?.alive >= 1, `Expected ${mapId} to spawn a live ${teamPreference} operator`);
        const reachability = state?.mapReachability?.report;
        assert(reachability?.totals, `Expected ${mapId} to expose map reachability report`);
        assert(
          reachability.totals.blocked === 0,
          `Expected ${mapId} route/objective reachability checks to pass, blocked: ${
            reachability.blocked?.map((check) => check.label).join(", ") || "unknown"
          }`,
        );

        if (mapId === "sandline-foundry") {
          const westRoute = reachability.sandlineWestRoute;
          assert(westRoute, "Expected Sandline to expose west Generator Hall reachability");
          assert(
            westRoute.amberToGeneratorHall?.graphReachable,
            "Expected Amber to graph-route to Sandline Generator Hall through player-equivalent navigation",
          );
          assert(
            westRoute.generatorHallToCentralYard?.graphReachable,
            "Expected Sandline Generator Hall to graph-route back toward Central Yard",
          );
          assert(
            westRoute.cobaltToGeneratorHall?.graphReachable,
            "Expected Cobalt to graph-route into Sandline Generator Hall through player-equivalent navigation",
          );
          assert(state?.objectiveMarkers?.readyForWorldMarkers, "Expected Sandline to expose world objective marker debug state");
          assertObjectiveMarker(state, {
            kind: "relay-site",
            label: "Kiln Yard",
            active: true,
            hudLabelMatch: true,
          });
          assertObjectiveMarker(state, {
            kind: "relay-site",
            label: "Shutter Lift",
            active: false,
          });
          assertObjectiveMarker(state, {
            kind: "hostage-cluster",
            label: "Generator Workers",
            active: false,
          });
          assertObjectiveMarker(state, {
            kind: "hostage-cluster",
            label: "Loading Crew",
            active: false,
          });
          assertObjectiveMarker(state, {
            kind: "extraction-zone",
            label: "Water Tower Gate",
            active: false,
          });
        }

        positions[teamPreference] = state.localPlayer.position;
        await returnToCatalog(localPage);
      }

      const spawnDistance = Math.hypot(
        positions.amber.x - positions.cobalt.x,
        positions.amber.z - positions.cobalt.z,
      );
      assert(
        spawnDistance > 8,
        `Expected ${mapId} to keep team spawns distinct. Distance: ${spawnDistance.toFixed(2)}`,
      );

      summary.mapChecks.push({
        mapId,
        spawnDistance: Number(spawnDistance.toFixed(2)),
        missionType: lastState?.round?.missionType ?? "",
        missionLabel: lastState?.round?.missionLabel ?? "",
        objectiveLabel: lastState?.round?.objectiveLabel ?? "",
        bombSite: lastState?.bomb?.siteLabel ?? "",
        bombPlantSeconds: lastState?.bomb?.plantSeconds ?? null,
        bombDefuseSeconds: lastState?.bomb?.defuseSeconds ?? null,
        bombFuseSeconds: lastState?.bomb?.fuseSeconds ?? null,
        reachabilityChecks: lastState?.mapReachability?.report?.totals?.checks ?? 0,
        reachabilityBlocked: lastState?.mapReachability?.report?.totals?.blocked ?? null,
      });
    }

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    const showcaseState = await getState(localPage);
    await setFocusView(localPage, showcaseState, "south-spawn");
    await captureScreenshot(localPage, "03-sandline-spawn-view.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "courtyard");
    await captureScreenshot(localPage, "04-sandline-central-yard.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "corridor");
    await captureScreenshot(localPage, "05-sandline-generator-hall.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "underpass");
    await captureScreenshot(localPage, "06-sandline-drain-underpass.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "catwalk");
    await captureScreenshot(localPage, "07-sandline-east-catwalk.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "loading-bay");
    await captureScreenshot(localPage, "14-sandline-loading-bay-marker.png", capturedScreenshots);
    await setFocusView(localPage, showcaseState, "south-spawn");
    const weaponIdleState = await getState(localPage);
    assertWeaponViewAlignment(weaponIdleState, "idle viewmodel");
    await captureScreenshot(localPage, "08-weapon-idle-hud.png", capturedScreenshots);
    await fire(localPage);
    const weaponFiringState = await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.weaponView?.muzzleFlashRecent === true ? state : false;
        })()
      `,
      1_000,
    );
    assertWeaponViewAlignment(weaponFiringState, "firing viewmodel");
    assert(
      weaponFiringState.weaponView?.muzzleFlashRecent === true,
      "Expected weapon firing debug state to expose a recent muzzle flash window",
    );
    summary.presentation.weapon = {
      idle: weaponIdleState.weaponView,
      firing: weaponFiringState.weaponView,
    };
    await delay(40);
    await captureScreenshot(localPage, "09-weapon-firing-hud.png", capturedScreenshots);

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    const unarmedHud = await readHud(localPage);
    assert(unarmedHud.legacyHudSurfaces === 0, "Expected old large HUD card/overlay surfaces to be absent");
    assert(!unarmedHud.scoreboardVisible, "Expected Tab info panel to be hidden before controls are armed");
    const unarmedTabPrevented = await keyboardDefaultPrevented(localPage, "keydown", "Tab", "Tab");
    assert(!unarmedTabPrevented, "Expected Tab to keep browser defaults before controls are armed");
    const unarmedTabHud = await readHud(localPage);
    assert(
      !unarmedTabHud.scoreboardVisible && !unarmedTabHud.debugScoreboardVisible,
      "Expected unarmed Tab press not to open the gameplay info panel",
    );

    const unarmedSpacePrevented = await keyboardDefaultPrevented(localPage, "keydown", "Space", " ", true);
    assert(!unarmedSpacePrevented, "Expected Space to keep browser defaults before controls are armed");
    await engageControls(localPage);
    const compactDefaultHud = await readHud(localPage);
    assert(compactDefaultHud.legacyHudSurfaces === 0, "Expected compact HUD to avoid legacy card/overlay classes");
    assert(!compactDefaultHud.promptVisible, "Expected compact startup hint to disappear after controls are armed");
    assert(!compactDefaultHud.scoreboardVisible, "Expected Tab info panel to stay hidden by default");
    assert(compactDefaultHud.health, "Expected compact bottom-left health to be present");
    assert(compactDefaultHud.ammo, "Expected compact bottom-right ammo to be present");
    assert(compactDefaultHud.roundTimer, "Expected compact top round timer to be present");
    assert(compactDefaultHud.fullscreenButtonVisible, "Expected viewport fullscreen control to be visible");
    assert(
      compactDefaultHud.fullscreenButtonInsideViewport,
      "Expected fullscreen control to live inside the match viewport shell",
    );
    assert(
      /fullscreen/i.test(compactDefaultHud.fullscreenButtonLabel),
      "Expected fullscreen control to expose an accessible fullscreen label",
    );
    assert(
      /fullscreen/i.test(compactDefaultHud.fullscreenButtonTitle),
      "Expected fullscreen control to expose a fullscreen title",
    );
    assert(
      compactDefaultHud.fullscreenButtonText.length === 0,
      "Expected fullscreen control to use an icon-only visual treatment",
    );

    const armedTabPrevented = await keyboardDefaultPrevented(localPage, "keydown", "Tab", "Tab");
    assert(armedTabPrevented, "Expected Tab to prevent browser focus navigation while controls are armed");
    const tabOpenHud = await readHud(localPage);
    assert(tabOpenHud.scoreboardVisible, "Expected held Tab to show the info panel");
    assert(tabOpenHud.debugScoreboardVisible, "Expected debug snapshot to expose scoreboardVisible=true");
    assert(tabOpenHud.teamCountsText, "Expected Tab panel to include team counts");
    assert(tabOpenHud.rosterText, "Expected Tab panel to include roster rows");
    assert(tabOpenHud.missionSummary, "Expected Tab panel to include detailed mission text");
    assert(tabOpenHud.controlsText.includes("WASD"), "Expected Tab panel to include controls");
    await delay(80);
    await captureScreenshot(localPage, "13-held-tab-operations-board.png", capturedScreenshots);

    const repeatTabPrevented = await keyboardDefaultPrevented(localPage, "keydown", "Tab", "Tab", true);
    assert(repeatTabPrevented, "Expected repeated Tab keydown to stay browser-safe while armed");
    const repeatedTabHud = await readHud(localPage);
    assert(repeatedTabHud.scoreboardVisible, "Expected repeated Tab keydown not to toggle the panel closed");

    const tabKeyUpPrevented = await keyboardDefaultPrevented(localPage, "keyup", "Tab", "Tab");
    assert(tabKeyUpPrevented, "Expected Tab keyup to prevent focus navigation while controls are armed");
    const tabClosedHud = await readHud(localPage);
    assert(!tabClosedHud.scoreboardVisible, "Expected Tab panel to hide after keyup");
    assert(!tabClosedHud.debugScoreboardVisible, "Expected debug snapshot to expose scoreboardVisible=false after keyup");

    const fullscreenDebugBefore = await getState(localPage);
    assert(
      fullscreenDebugBefore.fullscreen?.targetIsViewportShell,
      "Expected fullscreen target debug state to point at the viewport shell",
    );
    assert(
      fullscreenDebugBefore.fullscreen?.viewportWidth > 0 &&
        fullscreenDebugBefore.fullscreen?.viewportHeight > 0,
      "Expected fullscreen debug state to expose viewport dimensions",
    );

    const mockedFullscreen = await exerciseMockFullscreen(localPage);
    assert(mockedFullscreen, "Expected mocked fullscreen exercise to run");
    assert(
      mockedFullscreen.requestTargetMatchesShell,
      "Expected fullscreen request to target the viewport shell",
    );
    assert(mockedFullscreen.requestCount === 1, "Expected one viewport fullscreen enter request");
    assert(mockedFullscreen.exitCount === 1, "Expected one viewport fullscreen exit request");
    assert(mockedFullscreen.entered?.active, "Expected debug state to mark viewport fullscreen active");
    assert(
      mockedFullscreen.entered?.viewportWidth === 1012 &&
        mockedFullscreen.entered?.viewportHeight === 720,
      `Expected renderer host to resize to mocked fullscreen dimensions, saw ${JSON.stringify(mockedFullscreen.entered)}`,
    );
    assert(
      mockedFullscreen.entered?.canvasClientWidth === 1012 &&
        mockedFullscreen.entered?.canvasClientHeight === 720,
      "Expected canvas CSS size to follow fullscreen viewport dimensions",
    );
    assert(
      /exit/i.test(mockedFullscreen.enteredLabel) &&
        mockedFullscreen.enteredActive === "true",
      "Expected fullscreen button state to switch to exit while active",
    );
    assert(
      mockedFullscreen.tabPanelVisible,
      "Expected held Tab info panel to remain visible while fullscreen is active",
    );
    assert(!mockedFullscreen.exited?.active, "Expected debug state to clear viewport fullscreen on exit");
    assert(
      /enter/i.test(mockedFullscreen.exitedLabel) &&
        mockedFullscreen.exitedActive === "false",
      "Expected fullscreen button state to return to enter after exit",
    );

    const deniedFullscreen = await exerciseDeniedFullscreen(localPage);
    assert(deniedFullscreen, "Expected denied fullscreen exercise to run");
    assert(!deniedFullscreen.active, "Expected denied fullscreen request not to leave stale active state");
    assert(
      /denied/i.test(deniedFullscreen.status),
      `Expected denied fullscreen request to surface a compact status line, saw ${deniedFullscreen.status}`,
    );
    summary.fullscreen = {
      buttonInsideViewport: compactDefaultHud.fullscreenButtonInsideViewport,
      buttonLabel: compactDefaultHud.fullscreenButtonLabel,
      targetIsViewportShell: fullscreenDebugBefore.fullscreen?.targetIsViewportShell ?? false,
      mockedEnterActive: mockedFullscreen.entered?.active ?? false,
      mockedResize: {
        viewportWidth: mockedFullscreen.entered?.viewportWidth ?? null,
        viewportHeight: mockedFullscreen.entered?.viewportHeight ?? null,
        canvasClientWidth: mockedFullscreen.entered?.canvasClientWidth ?? null,
        canvasClientHeight: mockedFullscreen.entered?.canvasClientHeight ?? null,
      },
      tabPanelVisibleDuringFullscreen: mockedFullscreen.tabPanelVisible,
      deniedStatus: deniedFullscreen.status,
    };

    const armedSpacePrevented = await keyboardDefaultPrevented(localPage, "keydown", "Space", " ", true);
    assert(armedSpacePrevented, "Expected Space to prevent browser defaults while controls are armed");
    const armedEscapePrevented = await keyboardDefaultPrevented(localPage, "keydown", "Escape", "Escape");
    assert(
      !armedEscapePrevented,
      "Expected Esc to keep native browser pointer-lock/fullscreen defaults while controls are armed",
    );
    await engageControls(localPage);
    await delay(180);

    const standingState = await getState(localPage);
    const standingY = standingState.localPlayer.position.y;

    await dispatchWindowKey(localPage, "keydown", "ControlLeft", "Control");
    await delay(220);
    const defaultCtrlState = await getState(localPage);
    assert(
      defaultCtrlState.localPlayer.position.y > standingY - 0.1,
      "Expected Ctrl not to crouch unless the classic crouch alias is enabled",
    );
    await dispatchWindowKey(localPage, "keyup", "ControlLeft", "Control");

    await dispatchWindowKey(localPage, "keydown", "ShiftLeft", "Shift");
    await localPage.waitForExpression(
      `(() => (window.__dustlineQa__?.getState()?.localPlayer?.position?.y ?? ${standingY}) < ${standingY - 0.25})()`,
      2_000,
    );
    const crouchState = await getState(localPage);
    assert(
      crouchState.localPlayer.position.y < standingY - 0.25,
      `Expected crouch to lower the camera. Standing ${standingY}, crouched ${crouchState.localPlayer.position.y}`,
    );
    await dispatchWindowKey(localPage, "keyup", "ShiftLeft", "Shift");
    await localPage.waitForExpression(
      `Math.abs((window.__dustlineQa__?.getState()?.localPlayer?.position?.y ?? 0) - ${standingY}) < 0.08`,
      2_000,
    );

    await localPage.evaluate("window.__dustlineQa__.setPose(0, 14, 0)");
    await delay(120);
    const startStandingMove = await getState(localPage);
    await holdKey(localPage, "KeyW", "w", 900);
    const endStandingMove = await getState(localPage);
    const standingDistance = Math.abs(endStandingMove.localPlayer.position.z - startStandingMove.localPlayer.position.z);

    await localPage.evaluate("window.__dustlineQa__.setPose(0, 14, 0)");
    await delay(120);
    await dispatchWindowKey(localPage, "keydown", "ShiftLeft", "Shift");
    await localPage.waitForExpression(
      `(() => (window.__dustlineQa__?.getState()?.localPlayer?.position?.y ?? ${standingY}) < ${standingY - 0.25})()`,
      2_000,
    );
    const startCrouchMove = await getState(localPage);
    await holdKey(localPage, "KeyW", "w", 900);
    const endCrouchMove = await getState(localPage);
    await dispatchWindowKey(localPage, "keyup", "ShiftLeft", "Shift");
    await localPage.waitForExpression(
      `Math.abs((window.__dustlineQa__?.getState()?.localPlayer?.position?.y ?? 0) - ${standingY}) < 0.08`,
      3_000,
    );
    const crouchDistance = Math.abs(endCrouchMove.localPlayer.position.z - startCrouchMove.localPlayer.position.z);
    assert(
      crouchDistance < standingDistance * 0.85,
      `Expected crouch speed to be lower. Standing ${standingDistance.toFixed(2)}, crouched ${crouchDistance.toFixed(2)}`,
    );

    await localPage.evaluate(`window.__dustlineQa__.setCameraPose(0, ${standingY}, 14, 0)`);
    await delay(220);
    const jumpSample = await localPage.evaluate("window.__dustlineQa__.jumpSample()");
    assert(jumpSample, "Expected jump sample data");
    assert(jumpSample.peakY > standingY + 0.18, "Expected jump to raise the camera");
    assert(jumpSample.landed === true, "Expected jump to land safely");
    assert(
      Math.abs(jumpSample.landedY - standingY) < 0.12,
      `Expected landing height to recover. Standing ${standingY}, landed ${jumpSample.landedY}`,
    );

    summary.movement = {
      standingCameraY: standingY,
      crouchedCameraY: crouchState.localPlayer.position.y,
      standingDistance: Number(standingDistance.toFixed(2)),
      crouchDistance: Number(crouchDistance.toFixed(2)),
      jumpPeakY: jumpSample.peakY,
      landedY: jumpSample.landedY,
      airborneSeconds: jumpSample.airborneSeconds,
    };

    const roundBeforeDeath = (await getState(localPage)).round.roundNumber;
    await forceDeath(localPage, "QA Rig");
    await delay(220);
    const deadState = await getState(localPage);
    assert(deadState.localPlayer.dead === true, "Expected forcePlayerDeath to down the player");
    assert(deadState.localPlayer.health === 0, "Expected forcePlayerDeath to reduce health to 0");
    await delay(1500);
    const stillDeadState = await getState(localPage);
    assert(stillDeadState.localPlayer.dead === true, "Expected player to stay down during the same round");
    await captureScreenshot(localPage, "11-death-respawn-state.png", capturedScreenshots);

    await localPage.evaluate("window.__dustlineQa__.forceNextRound()");
    await delay(350);
    const revivedState = await getState(localPage);
    assert(revivedState.localPlayer.dead === false, "Expected next-round reset to revive the player");
    assert(revivedState.localPlayer.health === 100, "Expected next-round reset to restore health");
    assert(
      revivedState.round.roundNumber === roundBeforeDeath + 1,
      "Expected next-round reset to advance the round counter",
    );

    summary.respawn = {
      roundBeforeDeath,
      roundAfterReset: revivedState.round.roundNumber,
      deadState: deadState.localPlayer.dead,
      revived: revivedState.localPlayer.dead === false,
    };

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      15_000,
    );

    const localBombStart = await getState(localPage);
    assert(
      localBombStart.bomb?.carrierId === localBombStart.localPlayer.id,
      "Expected the attacking local operator to carry the relay charge",
    );
    assert(
      localBombStart.tuning?.ai?.fireInterval === localBombStart.tuning?.weapon?.fireInterval,
      `Expected bot base fire interval ${localBombStart.tuning?.ai?.fireInterval}s to match player fire interval ${localBombStart.tuning?.weapon?.fireInterval}s`,
    );
    assert(
      localBombStart.tuning?.weapon?.enemyDamage === localBombStart.tuning?.weapon?.playerDamage,
      `Expected bot damage ${localBombStart.tuning?.weapon?.enemyDamage} to match player damage ${localBombStart.tuning?.weapon?.playerDamage}`,
    );

    const site = localBombStart.bomb.sitePosition;
    await localPage.evaluate(
      `window.__dustlineQa__.setCameraPose(${site.x}, ${localBombStart.localPlayer.position.y}, ${site.z}, 0)`,
    );
    await delay(220);
    const localBombArmingPose = await getState(localPage);
    assert(localBombArmingPose.bomb.localCanPlant === true, "Expected the charge site to be usable in local play");

    await startObjectiveAction(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planting'",
      5_000,
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planted'",
      7_000,
    );

    const localBombPlanted = await getState(localPage);
    const localBombPlantedMarker = assertObjectiveMarker(localBombPlanted, {
      kind: "relay-site",
      label: localBombPlanted.bomb.siteLabel,
      active: true,
      hudLabelMatch: true,
    });
    assert(
      localBombPlantedMarker.stateHint === "site-armed",
      `Expected planted relay marker to expose site-armed state, saw ${localBombPlantedMarker.stateHint}`,
    );
    const localBombHudShell = await readHud(localPage);
    const localBombHud = await localPage.evaluate(`
      ({
        status: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        progress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? ''
      })
    `);
    assert(
      localBombHud.progress.includes("breach"),
      "Expected planted local HUD pressure to expose a breach countdown",
    );

    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /breached/i.test(state?.round?.result ?? '');
        })()
      `,
      16_000,
    );

    const localBombResolved = await getState(localPage);
    assert(
      /breached/i.test(localBombResolved.round.result ?? ""),
      "Expected the local planted charge to resolve by explosion",
    );

    summary.bombLocal = {
      carrierId: localBombStart.bomb.carrierId,
      siteLabel: localBombStart.bomb.siteLabel,
      localCanPlant: localBombArmingPose.bomb.localCanPlant,
      plantedPhase: localBombPlanted.bomb.phase,
      plantedCountdown: localBombPlanted.bomb.secondsRemaining,
      markerStateHint: localBombPlantedMarker.stateHint,
      resolution: localBombResolved.round.result,
      hudStatus: localBombHud.status,
      hudProgress: localBombHud.progress,
    };

    await setTeamPreference(localPage, "cobalt");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await localPage.evaluate("window.__dustlineQa__.forceNextRound()");
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.roundNumber === 2 && state?.round?.missionType === 'hostage';
        })()
      `,
      12_000,
    );
    await forceRoundActive(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );

    const localHostageStart = await getState(localPage);
    const localHostageCount = localHostageStart.hostage.hostages.length;
    assert(localHostageStart.round.missionType === "hostage", "Expected round two local play to rotate into hostage mode");
    assert(
      localHostageStart.hostage.route.length >= 3,
      "Expected hostage mode to expose a named escort route",
    );
    const localHostageClusterMarker = assertObjectiveMarker(localHostageStart, {
      kind: "hostage-cluster",
      label: localHostageStart.hostage.clusterLabel,
      active: true,
      hudLabelMatch: true,
    });
    const localExtractionMarker = assertObjectiveMarker(localHostageStart, {
      kind: "extraction-zone",
      label: localHostageStart.hostage.extractionLabel,
      active: true,
      hudLabelMatch: true,
    });
    assert(
      localHostageClusterMarker.stateHint === "secure-zone",
      `Expected hostage cluster marker to expose secure-zone state, saw ${localHostageClusterMarker.stateHint}`,
    );
    assert(
      localExtractionMarker.stateHint === "extract-threshold",
      `Expected extraction marker to expose extract-threshold state, saw ${localExtractionMarker.stateHint}`,
    );
    await localPage.evaluate("window.__dustlineQa__.setView(3, 5.8, 7, -1, 1.2, 16)");
    await delay(180);
    await captureScreenshot(localPage, "15-sandline-water-tower-gate-marker.png", capturedScreenshots);

    const localCluster = localHostageStart.hostage.clusterPosition;
    const localExtraction = localHostageStart.hostage.extractionPosition;
    await localPage.evaluate(
      `window.__dustlineQa__.setCameraPose(${localCluster.x}, ${localHostageStart.localPlayer.position.y}, ${localCluster.z}, 0)`,
    );
    await delay(220);
    const localHostageSecurePose = await getState(localPage);
    assert(
      localHostageSecurePose.hostage.localCanSecure === true,
      "Expected the local rescuer to stand inside the live hostage cluster",
    );

    await startObjectiveAction(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'securing'",
      5_000,
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'escorting'",
      5_000,
    );

    const localHostageEscort = await getState(localPage);
    const localRouteLabels = localHostageEscort.hostage.route.map((point) => point.label);
    await localPage.evaluate(
      `window.__dustlineQa__.setCameraPose(${localExtraction.x}, ${localHostageStart.localPlayer.position.y}, ${localExtraction.z}, 0)`,
    );
    await localPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.hostage?.hostages?.[0]?.pathIndex ?? 0) >= ${Math.min(2, localRouteLabels.length - 1)}`,
      28_000,
    );
    const localHostageRouteState = await getState(localPage);
    await localPage.waitForExpression(
      `(window.__dustlineQa__?.getState()?.hostage?.extractedCount ?? 0) === ${localHostageCount}`,
      28_000,
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'extracting'",
      5_000,
    );
    const localHostageExtractingMarkerState = await getState(localPage);
    const localHostageExtractingMarker = assertObjectiveMarker(localHostageExtractingMarkerState, {
      kind: "extraction-zone",
      label: localHostageExtractingMarkerState.hostage.extractionLabel,
      active: true,
      hudLabelMatch: true,
    });
    assert(
      localHostageExtractingMarker.stateHint === "extracting",
      `Expected extraction marker to expose extracting state, saw ${localHostageExtractingMarker.stateHint}`,
    );

    const localHostageHud = await localPage.evaluate(`
      ({
        status: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        progress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? ''
      })
    `);
    const localHostageHudShell = await readHud(localPage);
    assert(
      /clear/i.test(localHostageHud.progress),
      "Expected the local hostage HUD to expose extraction progress",
    );

    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /extracted/i.test(state?.round?.result ?? '');
        })()
      `,
      12_000,
    );
    const localHostageResolved = await getState(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.roundNumber === 3 && state?.round?.phase === 'briefing';
        })()
      `,
      10_000,
    );
    const localHostageReset = await getState(localPage);
    summary.hostageLocal = {
      missionType: localHostageStart.round.missionType,
      clusterLabel: localHostageStart.hostage.clusterLabel,
      extractionLabel: localHostageStart.hostage.extractionLabel,
      routeLabels: localRouteLabels,
      localCanSecure: localHostageSecurePose.hostage.localCanSecure,
      escortPhase: localHostageEscort.hostage.phase,
      routeProgress: localHostageRouteState.hostage.hostages.map((hostage) => hostage.pathIndex),
      extractedCount: localHostageResolved.hostage.extractedCount,
      markerStateHint: localHostageExtractingMarker.stateHint,
      resolution: localHostageResolved.round.result,
      hudStatus: localHostageHud.status,
      hudProgress: localHostageHud.progress,
      roundAfterReset: localHostageReset.round.roundNumber,
      phaseAfterReset: localHostageReset.round.phase,
    };

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const enemies = window.__dustlineQa__?.getState()?.enemies ?? [];
          return enemies.some((enemy) => enemy?.ai?.behavior === 'objective')
            && enemies.some((enemy) => enemy?.ai?.behavior === 'patrol');
        })()
      `,
      6_000,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const enemies = window.__dustlineQa__?.getState()?.enemies ?? [];
          return enemies.some(
            (enemy) => enemy?.ai?.behavior === 'objective' && (enemy?.movement?.crouchBlend ?? 0) > 0.55
          );
        })()
      `,
      4_000,
    );

    const aiOpeningState = await getState(localPage);
    const openingBehaviors = aiOpeningState.enemies.map((enemy) => enemy.ai.behavior);
    const openingStrategies = aiOpeningState.enemies.map((enemy) => enemy.ai.strategy);
    const openingStrategySet = new Set(openingStrategies);
    assert(
      openingStrategySet.size >= 2,
      `Expected at least two distinct opening bot strategies, saw ${openingStrategies.join(", ")}`,
    );
    assert(
      aiOpeningState.enemies.every(
        (enemy) =>
          typeof enemy.ai.profileSeed === "number" &&
          enemy.ai.profile &&
          typeof enemy.ai.strategyAge === "number" &&
          typeof enemy.ai.strategyCooldownRemaining === "number" &&
          typeof enemy.ai.objectiveIntent === "string",
      ),
      "Expected every bot debug snapshot to expose strategy profile, age/cooldown, and objective intent",
    );
    assert(
      aiOpeningState.enemies.some((enemy) => enemy.ai.strategy === "anchor_site") &&
        aiOpeningState.enemies.some(
          (enemy) => enemy.ai.strategy === "route_probe" || enemy.ai.strategy === "flank_rotate",
        ),
      `Expected opening fireteam to split anchor and route/flank strategies, saw ${openingStrategies.join(", ")}`,
    );
    const botMovementTuning = aiOpeningState.tuning?.botMovement;
    assert(botMovementTuning, "Expected bot movement tuning in debug snapshot");
    assert(
      botMovementTuning.walkSpeed === aiOpeningState.tuning?.movement?.walkSpeed,
      `Expected bot walk speed to match player walk speed, saw ${botMovementTuning.walkSpeed} vs ${aiOpeningState.tuning?.movement?.walkSpeed}`,
    );
    assert(
      botMovementTuning.crouchSpeed === aiOpeningState.tuning?.movement?.crouchSpeed,
      `Expected bot crouch speed to match player crouch speed, saw ${botMovementTuning.crouchSpeed} vs ${aiOpeningState.tuning?.movement?.crouchSpeed}`,
    );
    assert(
      botMovementTuning.jumpVelocity === aiOpeningState.tuning?.movement?.jumpVelocity,
      `Expected bot jump velocity to match player jump velocity, saw ${botMovementTuning.jumpVelocity} vs ${aiOpeningState.tuning?.movement?.jumpVelocity}`,
    );
    assert(
      botMovementTuning.gravity === aiOpeningState.tuning?.movement?.gravity,
      `Expected bot gravity to match player gravity, saw ${botMovementTuning.gravity} vs ${aiOpeningState.tuning?.movement?.gravity}`,
    );
    const openingObjectiveEnemy = aiOpeningState.enemies.find(
      (enemy) => enemy.ai.behavior === "objective" && (enemy.movement?.crouchBlend ?? 0) > 0.55,
    );
    assert(openingObjectiveEnemy, "Expected at least one opening objective bot to crouch tactically");
    assertAlivePosture(aiOpeningState.enemies, "opening solo enemy");
    assertTeamVisual(aiOpeningState.enemies, "cobalt", "opening solo enemy");
    const communicationCase = await stageAiCommunicationCase(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const enemies = window.__dustlineQa__?.getState()?.enemies ?? [];
          const observer = enemies.find((enemy) => enemy.id === ${JSON.stringify(communicationCase.observerEnemyId)});
          const receiver = enemies.find((enemy) => enemy.id === ${JSON.stringify(communicationCase.receiverEnemyId)});
          return observer?.ai?.canSeePlayer === true && receiver?.ai?.canSeePlayer === false;
        })()
      `,
      4_000,
    );
    const communicationImmediateState = await getState(localPage);
    const immediateReceiver = communicationImmediateState.enemies.find(
      (enemy) => enemy.id === communicationCase.receiverEnemyId,
    );
    assert(
      immediateReceiver?.ai?.lastSharedContactAgo === null,
      `Expected delayed squad contact instead of instant omniscience, saw ${immediateReceiver?.ai?.lastSharedContactAgo}`,
    );
    assert(
      immediateReceiver?.ai?.behavior === "patrol" || immediateReceiver?.ai?.behavior === "objective",
      `Expected receiver to stay on its opening task before contact delivery, saw ${immediateReceiver?.ai?.behavior}`,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const receiver = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(communicationCase.receiverEnemyId)});
          return receiver?.ai?.lastSharedContactAgo !== null
            && receiver?.ai?.canSeePlayer === false
            && (receiver?.ai?.behavior === 'investigate' || receiver?.ai?.behavior === 'pursue');
        })()
      `,
      5_000,
    );
    const communicationDelayedState = await getState(localPage);
    const delayedReceiver = communicationDelayedState.enemies.find(
      (enemy) => enemy.id === communicationCase.receiverEnemyId,
    );
    assert(
      delayedReceiver?.ai?.lastSharedContactAgo !== null,
      "Expected receiver to record delayed shared contact",
    );
    const sightlineCase = await stageAiSightlineCase(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.ai?.canSeePlayer === false && Boolean(enemy?.ai?.blockedBy);
        })()
      `,
      4_000,
    );
    const blockedSightState = await getState(localPage);
    const blockedEnemy = blockedSightState.enemies.find(
      (enemy) => enemy.id === sightlineCase.enemyId,
    );
    assert(blockedEnemy, "Expected blocked-sight AI state for the staged enemy");
    assertAlivePosture([blockedEnemy], "blocked solo enemy");
    assert(
      blockedEnemy.ai.canSeePlayer === false,
      "Expected the staged AI wall case to block direct detection",
    );
    const botMovementSample = await enemyMovementSample(localPage, sightlineCase.enemyId);
    assert(
      Math.abs(botMovementSample.standing.speed - botMovementTuning.walkSpeed) <= 0.35,
      `Expected standing bot stride near ${botMovementTuning.walkSpeed}u/s, saw ${botMovementSample.standing.speed}`,
    );
    assert(
      Math.abs(botMovementSample.crouched.speed - botMovementTuning.crouchSpeed) <= 0.35,
      `Expected crouched bot stride near ${botMovementTuning.crouchSpeed}u/s, saw ${botMovementSample.crouched.speed}`,
    );
    assert(
      botMovementSample.crouched.speed < botMovementSample.standing.speed * 0.72,
      `Expected crouched bot stride to be slower than standing, saw ${botMovementSample.crouched.speed} vs ${botMovementSample.standing.speed}`,
    );
    assert(
      Math.abs(botMovementSample.standing.eyeHeight - botMovementTuning.standingEyeHeight) <= 0.001,
      `Expected standing bot eye height ${botMovementTuning.standingEyeHeight}, saw ${botMovementSample.standing.eyeHeight}`,
    );
    assert(
      Math.abs(botMovementSample.crouched.eyeHeight - botMovementTuning.crouchEyeHeight) <= 0.001,
      `Expected crouched bot eye height ${botMovementTuning.crouchEyeHeight}, saw ${botMovementSample.crouched.eyeHeight}`,
    );
    assert(
      Math.abs(botMovementSample.standing.bodyHeight - botMovementTuning.standingBodyHeight) <= 0.001,
      `Expected standing bot body height ${botMovementTuning.standingBodyHeight}, saw ${botMovementSample.standing.bodyHeight}`,
    );
    assert(
      Math.abs(botMovementSample.crouched.bodyHeight - botMovementTuning.crouchBodyHeight) <= 0.001,
      `Expected crouched bot body height ${botMovementTuning.crouchBodyHeight}, saw ${botMovementSample.crouched.bodyHeight}`,
    );
    assert(botMovementSample.jump.groundedStart === true, "Expected bot jump sample to start grounded");
    assert(
      botMovementSample.jump.airborneObserved === true,
      "Expected bot jump sample to enter an airborne phase",
    );
    assert(botMovementSample.jump.landed === true, "Expected bot jump sample to land safely");
    assert(
      botMovementSample.jump.peakEyeY > botMovementSample.standing.eyeHeight + 0.18,
      `Expected bot jump sample peak ${botMovementSample.jump.peakEyeY} above standing eye ${botMovementSample.standing.eyeHeight}`,
    );
    assert(
      Math.abs(botMovementSample.jump.landedEyeY - botMovementSample.standing.eyeHeight) <= 0.12,
      `Expected bot jump sample to land near standing eye height ${botMovementSample.standing.eyeHeight}, saw ${botMovementSample.jump.landedEyeY}`,
    );

    await setBotDifficulty(localPage, "easy");
    const easyDifficultyShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 10,
      visibility: 0.7,
      shooterSpeed: 0.5,
      targetSpeed: 1.4,
      targetCrouching: false,
      shooterCrouching: false,
    });
    const easyDifficultyState = await getState(localPage);
    await setBotDifficulty(localPage, "medium");
    const mediumDifficultyShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 10,
      visibility: 0.7,
      shooterSpeed: 0.5,
      targetSpeed: 1.4,
      targetCrouching: false,
      shooterCrouching: false,
    });
    const mediumDifficultyState = await getState(localPage);
    await setBotDifficulty(localPage, "hard");
    const hardDifficultyShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 10,
      visibility: 0.7,
      shooterSpeed: 0.5,
      targetSpeed: 1.4,
      targetCrouching: false,
      shooterCrouching: false,
    });
    const hardDifficultyState = await getState(localPage);
    assert(
      easyDifficultyShot.hitChance < mediumDifficultyShot.hitChance &&
        mediumDifficultyShot.hitChance < hardDifficultyShot.hitChance,
      `Expected ordered difficulty danger for hit chance, saw easy=${easyDifficultyShot.hitChance}, medium=${mediumDifficultyShot.hitChance}, hard=${hardDifficultyShot.hitChance}`,
    );
    assert(
      easyDifficultyShot.reactionSeconds > mediumDifficultyShot.reactionSeconds &&
        mediumDifficultyShot.reactionSeconds > hardDifficultyShot.reactionSeconds,
      `Expected ordered reaction speeds, saw easy=${easyDifficultyShot.reactionSeconds}, medium=${mediumDifficultyShot.reactionSeconds}, hard=${hardDifficultyShot.reactionSeconds}`,
    );
    assert(
      easyDifficultyShot.spreadDegrees > mediumDifficultyShot.spreadDegrees &&
        mediumDifficultyShot.spreadDegrees > hardDifficultyShot.spreadDegrees,
      `Expected ordered spread by difficulty, saw easy=${easyDifficultyShot.spreadDegrees}, medium=${mediumDifficultyShot.spreadDegrees}, hard=${hardDifficultyShot.spreadDegrees}`,
    );
    assert(
      hardDifficultyShot.hitChance < 0.89,
      `Expected hard bots to stay imperfect, saw hit chance ${hardDifficultyShot.hitChance}`,
    );
    assert(
      easyDifficultyState.tuning?.botMovement?.walkSpeed === mediumDifficultyState.tuning?.botMovement?.walkSpeed &&
        mediumDifficultyState.tuning?.botMovement?.walkSpeed === hardDifficultyState.tuning?.botMovement?.walkSpeed,
      "Expected all bot difficulties to keep the same movement tuning",
    );
    await setBotDifficulty(localPage, "hard");

    await setView(localPage, sightlineCase.blockedPlayerPosition, {
      x: sightlineCase.blockedPlayerPosition.x + 2,
      y: sightlineCase.blockedPlayerPosition.y,
      z: sightlineCase.blockedPlayerPosition.z,
    });
    await fire(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.ai?.behavior === 'investigate';
        })()
      `,
      4_000,
    );
    const investigateState = await getState(localPage);
    const investigateEnemy = investigateState.enemies.find(
      (enemy) => enemy.id === sightlineCase.enemyId,
    );
    assertAlivePosture([investigateEnemy], "investigate solo enemy");
    assert(
      investigateEnemy?.ai?.shotsFired === 0,
      "Expected the blocked-sight investigate case to withhold fire through geometry",
    );

    const hardShotsBeforeClear = investigateEnemy.ai.shotsFired;
    await setView(localPage, sightlineCase.clearPlayerPosition, sightlineCase.enemyPosition);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.ai?.canSeePlayer === true;
        })()
      `,
      4_000,
    );
    await captureScreenshot(localPage, "10-opposing-player.png", capturedScreenshots);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.ai?.canSeePlayer === true
            && enemy?.ai?.shotsFired >= ${hardShotsBeforeClear + 6}
            && enemy?.ai?.shotHits >= 1
            && enemy?.ai?.shotMisses >= 1;
        })()
      `,
      6_000,
    );
    const engageState = await getState(localPage);
    const engageEnemy = engageState.enemies.find((enemy) => enemy.id === sightlineCase.enemyId);
    const hardShotEvents = shotEvents(engageState, "enemy")
      .filter((event) => event.sourceId === sightlineCase.enemyId)
      .slice(-6);
    assert(
      hardShotEvents.length >= 6,
      `Expected at least 6 hard-bot shot events, saw ${hardShotEvents.length}`,
    );
    const hardShotSpan = hardShotEvents.at(-1).at - hardShotEvents[0].at;
    assert(
      hardShotSpan <= 2.2,
      `Expected hard bot to sustain a human-like burst cadence, saw 6 shots over ${hardShotSpan.toFixed(2)}s`,
    );
    assert(
      engageEnemy?.ai?.behavior === "engage" || engageEnemy?.ai?.behavior === "reposition",
      `Expected the staged AI to take a clear-shot combat state, saw ${engageEnemy?.ai?.behavior}`,
    );
    assertAlivePosture([engageEnemy], "engage solo enemy");
    assertAimContract([engageEnemy], "engage solo enemy");
    const aiWorldFire = playableWorldFireEvents(engageState).at(-1);
    assert(aiWorldFire, "Expected solo enemy fire to create a playable world-fire audio event");
    assert(
      aiWorldFire.distance > 1 &&
        aiWorldFire.gain > 0.08 &&
        aiWorldFire.gain <= 0.92 &&
        aiWorldFire.outputGain >= aiWorldFire.gain,
      `Expected AI shot audio to carry distance-normalized gain, saw ${JSON.stringify(aiWorldFire)}`,
    );
    await setBotDifficulty(localPage, "medium");

    await requestEnemyJump(localPage, sightlineCase.enemyId);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.movement?.airborne === true && enemy?.posture?.feetY > 0.05;
        })()
      `,
      4_000,
    );
    const airborneState = await getState(localPage);
    const airborneEnemy = airborneState.enemies.find((enemy) => enemy.id === sightlineCase.enemyId);
    assertAlivePosture([airborneEnemy], "airborne solo enemy");
    assertAimContract([airborneEnemy], "airborne solo enemy");

    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.movement?.grounded === true && Math.abs(enemy?.posture?.feetY ?? 1) <= 0.06;
        })()
      `,
      15_000,
    );
    const landedState = await getState(localPage);
    const landedEnemy = landedState.enemies.find((enemy) => enemy.id === sightlineCase.enemyId);
    assertAlivePosture([landedEnemy], "landed solo enemy");
    assertAimContract([landedEnemy], "landed solo enemy");

    await aimAt(localPage, sightlineCase.enemyId);
    await fire(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(sightlineCase.enemyId)});
          return enemy?.ai?.behavior === 'reposition';
        })()
      `,
      5_000,
    );
    const repositionState = await getState(localPage);
    const repositionEnemy = repositionState.enemies.find(
      (enemy) => enemy.id === sightlineCase.enemyId,
    );
    assertAlivePosture([repositionEnemy], "reposition solo enemy");
    assert(
      repositionEnemy?.ai?.strategy === "cover_reposition" ||
        repositionEnemy?.ai?.strategy === "fallback_guard",
      `Expected damage to force a cover/fallback strategy switch, saw ${repositionEnemy?.ai?.strategy}`,
    );
    assert(
      repositionEnemy?.ai?.strategyReason === "recent-damage" ||
        repositionEnemy?.ai?.strategyReason === "low-health",
      `Expected strategy switch to cite damage or low health, saw ${repositionEnemy?.ai?.strategyReason}`,
    );

    const pursuitSightlineCase = await stageAiSightlineCase(localPage, { seedLastKnown: true });
    await setView(
      localPage,
      pursuitSightlineCase.blockedPlayerPosition,
      pursuitSightlineCase.enemyPosition,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(pursuitSightlineCase.enemyId)});
          const contactResponse =
            enemy?.ai?.behavior === 'pursue'
            || enemy?.ai?.behavior === 'reposition'
            || enemy?.ai?.strategy === 'pursue_contact'
            || (
              enemy?.ai?.lastSeenAgo !== null
              && enemy?.ai?.lastSeenAgo <= 4.8
              && enemy?.ai?.targetLabel
            );
          return (enemy?.ai?.canSeePlayer === false || (enemy?.ai?.visibility ?? 1) < 0.72)
            && contactResponse
        })()
      `,
      6_000,
    );
    const pursueState = await getState(localPage);
    const pursueEnemy = pursueState.enemies.find((enemy) => enemy.id === pursuitSightlineCase.enemyId);
    assertAlivePosture([pursueEnemy], "pursue solo enemy");
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(pursuitSightlineCase.enemyId)});
          const memoryExpired =
            enemy?.ai?.lastSeenAgo === null ||
            enemy?.ai?.lastSeenAgo >= ${Number((mediumDifficultyState.tuning.ai.pursuitWindow + 0.2).toFixed(2))} ||
            enemy?.ai?.targetLabel !== 'Last known position';
          return enemy
            && enemy.ai.behavior !== 'pursue'
            && memoryExpired;
        })()
      `,
      15_000,
    );
    const boundedMemoryState = await getState(localPage);
    const boundedMemoryEnemy = boundedMemoryState.enemies.find(
      (enemy) => enemy.id === pursuitSightlineCase.enemyId,
    );
    assert(
      boundedMemoryEnemy?.ai?.behavior !== "pursue",
      `Expected last-known pursuit memory to expire, saw ${boundedMemoryEnemy?.ai?.behavior}`,
    );

    const recoveryCase = await stageAiRecoveryCase(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(recoveryCase.enemyId)});
          const route = enemy?.ai?.route;
          return route
            && route.direct === false
            && (route.usesGraph === true || (route.pathNodeIds ?? []).length > 0)
            && route.waypointLabel !== ${JSON.stringify(recoveryCase.targetLabel)}
            && typeof enemy?.ai?.stuckClassification === 'string'
            && typeof enemy?.ai?.recoveryAction === 'string'
            && enemy?.ai?.failedJumpSuppression;
        })()
      `,
      6_000,
    );
    const recoveryRouteState = await getState(localPage);
    const recoveryRouteEnemy = recoveryRouteState.enemies.find(
      (enemy) => enemy.id === recoveryCase.enemyId,
    );
    assertAlivePosture([recoveryRouteEnemy], "route-planning solo enemy");
    assertAimContract([recoveryRouteEnemy], "route-planning solo enemy");
    await localPage.waitForExpression(
      `
        (() => {
          const enemy = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((entry) => entry.id === ${JSON.stringify(recoveryCase.enemyId)});
          if (!enemy?.position) {
            return false;
          }
          const dx = enemy.position.x - ${recoveryCase.enemyPosition.x};
          const dz = enemy.position.z - ${recoveryCase.enemyPosition.z};
          const distance = Math.hypot(dx, dz);
          const route = enemy.ai?.route;
          return distance > 0.6
            && distance < 10
            && route
            && (route.reachable === true || route.usesGraph === true || route.reason === 'partial-route')
            && (enemy.ai?.jumpCount ?? 0) <= 1;
        })()
      `,
      6_000,
    );
    await delay(1_500);
    const recoveryState = await getState(localPage);
    const recoveryEnemy = recoveryState.enemies.find((enemy) => enemy.id === recoveryCase.enemyId);
    assertAlivePosture([recoveryEnemy], "recovery solo enemy");
    assert(
      (recoveryEnemy?.ai?.jumpCount ?? 0) <= 1,
      `Expected stuck recovery not to repeat jumps at the same obstruction, saw ${recoveryEnemy?.ai?.jumpCount}`,
    );
    assert(
      recoveryEnemy?.ai?.route?.direct === false || recoveryEnemy?.ai?.route?.reachable === true,
      `Expected blocked recovery case to keep a graph route or finish on a clear segment, saw ${JSON.stringify(recoveryEnemy?.ai?.route)}`,
    );

    const closeStandingShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 6,
      visibility: 1,
      shooterSpeed: 0,
      targetSpeed: 0.2,
      targetCrouching: false,
      shooterCrouching: false,
    });
    const farMovingShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 18,
      visibility: 0.62,
      shooterSpeed: 1.8,
      targetSpeed: 3.8,
      targetCrouching: false,
      shooterCrouching: false,
    });
    const crouchedPartialShot = await evaluateEnemyShot(localPage, sightlineCase.enemyId, {
      distance: 10,
      visibility: 0.35,
      shooterSpeed: 0.3,
      targetSpeed: 1.2,
      targetCrouching: true,
      shooterCrouching: true,
    });

    assert(
      closeStandingShot.hitChance > farMovingShot.hitChance,
      "Expected long-range moving targets to lower AI hit chance",
    );
    assert(
      closeStandingShot.hitChance > crouchedPartialShot.hitChance,
      "Expected crouched partial exposure to lower AI hit chance",
    );
    assert(
      farMovingShot.spreadDegrees > closeStandingShot.spreadDegrees,
      "Expected movement and range to widen AI spread",
    );
    assert(
      crouchedPartialShot.missChance > closeStandingShot.missChance,
      "Expected crouch and visibility penalties to raise AI miss chance",
    );

    summary.aiLocal = {
      mapId: aiOpeningState.mapId,
      roundMission: aiOpeningState.round.missionLabel,
      botMovementTuning,
      communicationDelay: {
        blockerName: communicationCase.blockerName,
        observerEnemyId: communicationCase.observerEnemyId,
        receiverEnemyId: communicationCase.receiverEnemyId,
        immediateBehavior: immediateReceiver?.ai?.behavior ?? null,
        delayedBehavior: delayedReceiver?.ai?.behavior ?? null,
        delayedContactAgo: delayedReceiver?.ai?.lastSharedContactAgo ?? null,
      },
      difficultyShots: {
        easy: easyDifficultyShot,
        medium: mediumDifficultyShot,
        hard: hardDifficultyShot,
      },
      crouchedObjectiveEnemyId: openingObjectiveEnemy.id,
      botMovementSample,
      observedOpeningBehaviors: openingBehaviors,
      observedOpeningStrategies: openingStrategies,
      openingStrategyProfiles: aiOpeningState.enemies.map((enemy) => ({
        id: enemy.id,
        role: enemy.ai.role,
        seed: enemy.ai.profileSeed,
        strategy: enemy.ai.strategy,
        objectiveIntent: enemy.ai.objectiveIntent,
      })),
      sightlineCase: {
        blockerName: sightlineCase.blockerName,
        blockedPlayerLabel: sightlineCase.blockedPlayerLabel,
        clearPlayerLabel: sightlineCase.clearPlayerLabel,
      },
      blockedVisibility: blockedEnemy.ai.visibility,
      investigateBehavior: investigateEnemy.ai.behavior,
      engageBehavior: engageEnemy.ai.behavior,
      repositionBehavior: repositionEnemy?.ai?.behavior ?? null,
      repositionStrategy: repositionEnemy?.ai?.strategy ?? null,
      repositionStrategyReason: repositionEnemy?.ai?.strategyReason ?? null,
      repositionReason: repositionEnemy?.ai?.repositionReason ?? null,
      pursueBehavior: pursueEnemy?.ai?.behavior ?? null,
      boundedMemoryBehavior: boundedMemoryEnemy?.ai?.behavior ?? null,
      recovery: {
        enemyId: recoveryCase.enemyId,
        blockerName: recoveryCase.blockerName,
        routeReason: recoveryRouteEnemy?.ai?.route?.reason ?? null,
        routeWaypoint: recoveryRouteEnemy?.ai?.route?.waypointLabel ?? null,
        routePathLabels: recoveryRouteEnemy?.ai?.route?.pathLabels ?? [],
        routeUsesGraph: recoveryRouteEnemy?.ai?.route?.usesGraph ?? false,
        stuckClassification: recoveryEnemy?.ai?.stuckClassification ?? null,
        recoveryAction: recoveryEnemy?.ai?.recoveryAction ?? null,
        liveJumpReason: recoveryEnemy?.ai?.lastJumpReason ?? null,
        liveJumpCount: recoveryEnemy?.ai?.jumpCount ?? 0,
        failedJumpSuppression: recoveryEnemy?.ai?.failedJumpSuppression ?? null,
        reason: recoveryEnemy?.ai?.lastRecoveryReason ?? null,
        count: recoveryEnemy?.ai?.recoveryCount ?? 0,
        heldTarget: recoveryEnemy?.ai?.forcedTargetLabel ?? null,
      },
      posture: {
        opening: aiOpeningState.enemies.map((enemy) => enemy.posture),
        blocked: blockedEnemy.posture,
        investigate: investigateEnemy?.posture ?? null,
        engage: engageEnemy.posture,
        airborne: airborneEnemy?.posture ?? null,
        landed: landedEnemy?.posture ?? null,
        recoveryRoute: recoveryRouteEnemy?.posture ?? null,
        reposition: repositionEnemy?.posture ?? null,
        pursue: pursueEnemy?.posture ?? null,
      },
      shotTotals: {
        fired: engageEnemy.ai.shotsFired,
        hits: engageEnemy.ai.shotHits,
        misses: engageEnemy.ai.shotMisses,
      },
      hardCadence: {
        sixShotSpanSeconds: Number(hardShotSpan.toFixed(2)),
        shots: hardShotEvents.length,
      },
      closeStandingShot,
      farMovingShot,
      crouchedPartialShot,
    };

    await setTeamPreference(localPage, "cobalt");
    await setBotDifficulty(localPage, "medium");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );
    const enemyBombPlantCase = await stageEnemyBombPlantCase(localPage);
    const enemyBombPlantStart = await getState(localPage);
    assert(
      pointDistance2d(enemyBombPlantCase.startPosition, enemyBombPlantCase.sitePosition) >
        (enemyBombPlantStart.bomb?.siteRadius ?? 0),
      "Expected enemy bomb plant QA case to start outside the valid site radius",
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planting'",
      9_000,
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planted'",
      8_000,
    );
    const enemyBombPlantState = await getState(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && Boolean(state?.round?.result);
        })()
      `,
      20_000,
    );
    const enemyBombResolvedState = await getState(localPage);
    summary.aiObjectiveBomb = {
      carrierEnemyId: enemyBombPlantCase.carrierEnemyId,
      siteLabel: enemyBombPlantCase.siteLabel,
      phase: enemyBombPlantState.bomb.phase,
      plantedById: enemyBombPlantState.bomb.plantedById,
      plantedByName: enemyBombPlantState.bomb.plantedByName,
      hudStatus: enemyBombPlantState.objectiveStatus,
      hudProgress: enemyBombPlantState.objectiveProgressLabel,
      resolution: enemyBombResolvedState.round.result,
    };
    summary.aiSoloRound = {
      resolution: enemyBombResolvedState.round.result,
      playerDead: enemyBombResolvedState.localPlayer.dead,
      enemyBehaviorAtResolution:
        enemyBombResolvedState.enemies.find((enemy) => enemy.id === enemyBombPlantCase.carrierEnemyId)?.ai
          ?.behavior ?? null,
      enemyShotsFired:
        enemyBombResolvedState.enemies.find((enemy) => enemy.id === enemyBombPlantCase.carrierEnemyId)?.ai
          ?.shotsFired ?? 0,
      blockerName: enemyBombPlantCase.siteLabel,
    };

    await setTeamPreference(localPage, "cobalt");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    const enemyObjectiveThreatCase = await stageEnemyObjectiveThreatCase(localPage);
    const enemyObjectiveThreatStart = await getState(localPage);
    const objectiveThreatCarrierStart = enemyObjectiveThreatStart.enemies.find(
      (enemy) => enemy.id === enemyObjectiveThreatCase.carrierEnemyId,
    );
    assert(
      objectiveThreatCarrierStart?.ai?.canSeePlayer === true &&
        objectiveThreatCarrierStart?.ai?.objectiveIntent === "carrier_site_commit",
      `Expected carrier to keep objective intent while seeing a close threat, saw ${objectiveThreatCarrierStart?.ai?.objectiveIntent}/${objectiveThreatCarrierStart?.ai?.canSeePlayer}`,
    );
    assert(
      objectiveThreatCarrierStart?.ai?.behavior === "objective",
      `Expected close-threat carrier to remain objective-driven, saw ${objectiveThreatCarrierStart?.ai?.behavior}`,
    );
    const objectiveThreatShotsBefore = objectiveThreatCarrierStart.ai.shotsFired;
    await localPage.waitForExpression(
      `
        (() => {
          const carrier = (window.__dustlineQa__?.getState()?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyObjectiveThreatCase.carrierEnemyId)});
          return carrier?.ai?.canSeePlayer === true
            && carrier?.ai?.objectiveIntent === 'carrier_site_commit'
            && carrier?.ai?.behavior === 'objective'
            && carrier?.ai?.shotsFired > ${objectiveThreatShotsBefore}
            && carrier?.ai?.lastShotProfile;
        })()
      `,
      4_000,
    );
    const enemyObjectiveThreatState = await getState(localPage);
    const objectiveThreatCarrier = enemyObjectiveThreatState.enemies.find(
      (enemy) => enemy.id === enemyObjectiveThreatCase.carrierEnemyId,
    );
    summary.aiObjectiveThreat = {
      carrierEnemyId: enemyObjectiveThreatCase.carrierEnemyId,
      siteLabel: enemyObjectiveThreatCase.siteLabel,
      behavior: objectiveThreatCarrier?.ai?.behavior ?? null,
      objectiveIntent: objectiveThreatCarrier?.ai?.objectiveIntent ?? null,
      shotsFired: objectiveThreatCarrier?.ai?.shotsFired ?? 0,
      lastShotProfile: objectiveThreatCarrier?.ai?.lastShotProfile ?? null,
    };

    await setTeamPreference(localPage, "cobalt");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    const enemyRelayRouteCase = await stageEnemyRelayRouteCase(localPage);
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          const carrier = (state?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyRelayRouteCase.carrierEnemyId)});
          const supports = (state?.enemies ?? [])
            .filter((enemy) => ${JSON.stringify(enemyRelayRouteCase.supportEnemyIds)}.includes(enemy.id));
          return carrier?.ai?.objectiveIntent === 'carrier_site_commit'
            && carrier?.ai?.route
            && carrier.ai.route.destinationLabel === ${JSON.stringify(enemyRelayRouteCase.siteLabel)}
            && supports.some((enemy) => enemy?.ai?.objectiveIntent === 'carrier_escort')
            && supports.some((enemy) => enemy?.ai?.objectiveIntent === 'carrier_flank_screen')
            && new Set(supports.map((enemy) => enemy?.ai?.targetLabel)).size >= 2;
        })()
      `,
      8_000,
    );
    const enemyRelayRouteState = await getState(localPage);
    const relayCarrier = enemyRelayRouteState.enemies.find(
      (enemy) => enemy.id === enemyRelayRouteCase.carrierEnemyId,
    );
    const relaySupports = enemyRelayRouteState.enemies.filter((enemy) =>
      enemyRelayRouteCase.supportEnemyIds.includes(enemy.id),
    );
    const relaySupportTargets = new Set(relaySupports.map((enemy) => enemy.ai.targetLabel));
    assert(
      relaySupportTargets.size >= 2,
      `Expected relay support bots to avoid clustering on one target, saw ${[...relaySupportTargets].join(", ")}`,
    );
    assert(
      relayCarrier?.ai?.route?.pathLabels?.length >= 1,
      "Expected relay carrier to expose a planned route path toward the active site",
    );

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await forceRoundActive(localPage);
    const enemyRelayDefuseCase = await stageEnemyRelayDefuseCase(localPage);
    const enemyRelayDefuseStart = await getState(localPage);
    assert(
      pointDistance2d(enemyRelayDefuseCase.startPosition, enemyRelayDefuseCase.sitePosition) >
        (enemyRelayDefuseStart.bomb?.siteRadius ?? 0),
      "Expected enemy relay defuse QA case to start outside the valid site radius",
    );
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          const defuser = (state?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyRelayDefuseCase.defuserEnemyId)});
          return defuser
            && Math.hypot(
              (defuser.position?.x ?? 999) - ${JSON.stringify(enemyRelayDefuseCase.sitePosition.x)},
              (defuser.position?.z ?? 999) - ${JSON.stringify(enemyRelayDefuseCase.sitePosition.z)}
            ) <= (state?.bomb?.siteRadius ?? 0);
        })()
      `,
      9_000,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.bomb?.phase === 'defusing'
            || (state?.round?.phase === 'resolution' && /disarmed/i.test(state?.round?.result ?? ''));
        })()
      `,
      5_000,
    );
    const enemyRelayDefuseState = await getState(localPage);
    const relayDefuser = enemyRelayDefuseState.enemies.find(
      (enemy) => enemy.id === enemyRelayDefuseCase.defuserEnemyId,
    );
    assert(
      relayDefuser?.ai?.objectiveIntent === "defuse_rotate" &&
        relayDefuser?.ai?.strategyReason === "planted-objective",
      `Expected planted charge to force defuse intent, saw ${relayDefuser?.ai?.objectiveIntent}/${relayDefuser?.ai?.strategyReason}`,
    );

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await setInvulnerable(localPage, true);
    await localPage.evaluate("window.__dustlineQa__.forceNextRound()");
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.missionType === 'hostage'",
      5_000,
    );
    await forceRoundActive(localPage);
    const enemyHostageEscortCase = await stageEnemyHostageEscortCase(localPage);
    const enemyHostageEscortStart = await getState(localPage);
    assert(
      pointDistance2d(enemyHostageEscortCase.startPosition, enemyHostageEscortCase.clusterPosition) >
        (enemyHostageEscortStart.hostage?.clusterRadius ?? 0),
      "Expected enemy hostage escort QA case to start outside the valid cluster radius",
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'securing'",
      9_000,
    );
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'escorting'",
      8_000,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          const rescuer = (state?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyHostageEscortCase.rescuerEnemyId)});
          const supports = (state?.enemies ?? [])
            .filter((enemy) => ${JSON.stringify(enemyHostageEscortCase.supportEnemyIds)}.includes(enemy.id));
          const routeLabels = ${JSON.stringify(enemyHostageEscortCase.routeLabels)};
          return rescuer?.ai?.objectiveIntent === 'escort_extract'
            && rescuer?.ai?.route
            && routeLabels.includes(rescuer.ai.route.destinationLabel)
            && rescuer.ai.route.reason !== 'unreachable'
            && supports.some((enemy) => String(enemy?.ai?.objectiveIntent ?? '').includes('escort'));
        })()
      `,
      8_000,
    );
    const enemyHostageEscortState = await getState(localPage);
    const hostageRescuer = enemyHostageEscortState.enemies.find(
      (enemy) => enemy.id === enemyHostageEscortCase.rescuerEnemyId,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return (state?.hostage?.extractedCount ?? 0) === (state?.hostage?.hostages?.length ?? -1);
        })()
      `,
      28_000,
    );
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          const rescuer = (state?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyHostageEscortCase.rescuerEnemyId)});
          const extraction = state?.hostage?.extractionPosition;
          return rescuer
            && extraction
            && Math.hypot(
              (rescuer.position?.x ?? 999) - extraction.x,
              (rescuer.position?.z ?? 999) - extraction.z
            ) <= (state?.hostage?.extractionRadius ?? 0);
        })()
      `,
      45_000,
    );
    try {
      await localPage.waitForExpression(
        "window.__dustlineQa__?.getState()?.hostage?.phase === 'extracting'",
        5_000,
      );
    } catch (error) {
      const hostageExtractionDebug = await localPage.evaluate(`
        (() => {
          const state = window.__dustlineQa__?.getState();
          const rescuer = (state?.enemies ?? [])
            .find((enemy) => enemy.id === ${JSON.stringify(enemyHostageEscortCase.rescuerEnemyId)});
          const extraction = state?.hostage?.extractionPosition;
          const distanceToExtraction = rescuer && extraction
            ? Math.hypot(
                (rescuer.position?.x ?? 0) - extraction.x,
                (rescuer.position?.z ?? 0) - extraction.z
              )
            : null;
          return {
            phase: state?.hostage?.phase ?? null,
            roundPhase: state?.round?.phase ?? null,
            roundResult: state?.round?.result ?? null,
            extractedCount: state?.hostage?.extractedCount ?? null,
            hostageCount: state?.hostage?.hostages?.length ?? null,
            extractionRadius: state?.hostage?.extractionRadius ?? null,
            rescuer: rescuer
              ? {
                  alive: rescuer.alive,
                  position: rescuer.position,
                  distanceToExtraction,
                  objectiveIntent: rescuer.ai?.objectiveIntent ?? null,
                  behavior: rescuer.ai?.behavior ?? null,
                  strategy: rescuer.ai?.strategy ?? null,
                  targetLabel: rescuer.ai?.targetLabel ?? null,
                  targetDistance: rescuer.ai?.targetDistance ?? null,
                  route: rescuer.ai?.route ?? null,
                  stuckClassification: rescuer.ai?.stuckClassification ?? null,
                  recoveryAction: rescuer.ai?.recoveryAction ?? null,
                }
              : null,
          };
        })()
      `);
      throw new Error(
        `Timed out waiting for enemy hostage extraction start: ${JSON.stringify(hostageExtractionDebug)}`,
        { cause: error },
      );
    }
    await localPage.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /extracted/i.test(state?.round?.result ?? '');
        })()
      `,
      9_000,
    );
    const enemyHostageExtractedState = await getState(localPage);

    await setTeamPreference(localPage, "cobalt");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await localPage.evaluate("window.__dustlineQa__.forceNextRound()");
    await localPage.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.missionType === 'hostage'",
      5_000,
    );
    await forceRoundActive(localPage);
    await delay(600);
    const enemyHostageDefenseState = await getState(localPage);
    const hostageDefenseIntents = enemyHostageDefenseState.enemies.map(
      (enemy) => enemy.ai.objectiveIntent,
    );
    assert(
      hostageDefenseIntents.some((intent) => intent === "hostage_cluster_anchor") &&
        hostageDefenseIntents.some((intent) => intent === "hostage_lane_probe"),
      `Expected hostage defenders to guard cluster/lane, saw ${hostageDefenseIntents.join(", ")}`,
    );

    summary.aiObjectiveRelayAware = {
      carrierEnemyId: enemyRelayRouteCase.carrierEnemyId,
      carrierIntent: relayCarrier?.ai?.objectiveIntent ?? null,
      carrierRoute: relayCarrier?.ai?.route ?? null,
      supportIntents: relaySupports.map((enemy) => enemy.ai.objectiveIntent),
      supportTargets: relaySupports.map((enemy) => enemy.ai.targetLabel),
      defuserEnemyId: enemyRelayDefuseCase.defuserEnemyId,
      defuserIntent: relayDefuser?.ai?.objectiveIntent ?? null,
      defusePhase: enemyRelayDefuseState.bomb.phase,
    };
    summary.aiObjectiveHostageAware = {
      rescuerEnemyId: enemyHostageEscortCase.rescuerEnemyId,
      rescuerIntent: hostageRescuer?.ai?.objectiveIntent ?? null,
      rescuerRoute: hostageRescuer?.ai?.route ?? null,
      routeLabels: enemyHostageEscortCase.routeLabels,
      supportIntents: enemyHostageEscortState.enemies
        .filter((enemy) => enemyHostageEscortCase.supportEnemyIds.includes(enemy.id))
        .map((enemy) => enemy.ai.objectiveIntent),
      defenderIntents: hostageDefenseIntents,
      phase: enemyHostageEscortState.hostage.phase,
      extractedCount: enemyHostageExtractedState.hostage.extractedCount,
      resolution: enemyHostageExtractedState.round.result,
    };

    const sharedPageOne = await createPage(`${ROOT_URL}?qa=1`);
    const sharedPageTwo = await createPage(`${ROOT_URL}?qa=1`);
    const isolationPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(sharedPageOne, sharedPageTwo, isolationPage);

    await setTeamPreference(sharedPageOne, "amber");
    await openMap(sharedPageOne, "sandline-foundry", "shared");

    await setTeamPreference(sharedPageTwo, "cobalt");
    await openMap(sharedPageTwo, "sandline-foundry", "shared");

    await setTeamPreference(isolationPage, "amber");
    await openMap(isolationPage, "transit-crates", "shared");

    await sharedPageOne.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 2",
      15_000,
    );
    await sharedPageTwo.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 2",
      15_000,
    );
    await isolationPage.waitForExpression(
      "(window.__dustlineQa__?.getState()?.roster?.length ?? 0) === 1",
      15_000,
    );

    const sharedStateOne = await getState(sharedPageOne);
    const sharedStateTwo = await getState(sharedPageTwo);
    const isolatedState = await getState(isolationPage);

    assert(sharedStateOne.localPlayer.teamId === "amber", "Expected shared page one to stay on Amber Vanguard");
    assert(sharedStateTwo.localPlayer.teamId === "cobalt", "Expected shared page two to stay on Cobalt Reach");
    assert(
      sharedStateOne.remotePlayers?.[0]?.teamId === "cobalt",
      "Expected shared page one to see the remote Cobalt Reach operator",
    );
    assert(
      sharedStateTwo.remotePlayers?.[0]?.teamId === "amber",
      "Expected shared page two to see the remote Amber Vanguard operator",
    );
    assert(
      sharedStateOne.round.roundNumber === sharedStateTwo.round.roundNumber &&
        sharedStateOne.round.phase === sharedStateTwo.round.phase,
      "Expected shared pages to synchronize round phase",
    );
    assert(
      isolatedState.roster.length === 1,
      "Expected a different map to remain isolated from the shared room",
    );

    await stageSharedDuel(sharedPageOne, 0, 0.75);
    await stageSharedDuel(sharedPageTwo, 1, -0.45);
    await delay(500);
    const sharedDuelStateOne = await getState(sharedPageOne);
    const sharedDuelStateTwo = await getState(sharedPageTwo);
    assertAlivePosture(sharedDuelStateOne.remotePlayers, "shared remote actor page one");
    assertAlivePosture(sharedDuelStateTwo.remotePlayers, "shared remote actor page two");
    assertAimContract(sharedDuelStateOne.remotePlayers, "shared remote actor page one");
    assertAimContract(sharedDuelStateTwo.remotePlayers, "shared remote actor page two");
    assertTeamVisual(sharedDuelStateOne.remotePlayers, "cobalt", "shared remote actor page one");
    assertTeamVisual(sharedDuelStateTwo.remotePlayers, "amber", "shared remote actor page two");
    await captureScreenshot(sharedPageTwo, "12-two-player-multiplayer.png", capturedScreenshots);

    await engageControls(sharedPageOne);
    await engageControls(sharedPageTwo);
    await forceRoundActive(sharedPageOne);
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );

    const sharedSentBefore = shotEvents(await getState(sharedPageOne), "shared-sent").length;
    const sharedReceivedBefore = shotEvents(await getState(sharedPageTwo), "shared-received").length;
    const worldFireBefore = playableWorldFireEvents(await getState(sharedPageTwo)).length;
    await fire(sharedPageOne);
    await sharedPageOne.waitForExpression(
      `((window.__dustlineQa__?.getState()?.shots?.events ?? []).filter((event) => event.type === 'shared-sent').length) > ${sharedSentBefore}`,
      5_000,
    );
    await sharedPageTwo.waitForExpression(
      `((window.__dustlineQa__?.getState()?.shots?.events ?? []).filter((event) => event.type === 'shared-received').length) > ${sharedReceivedBefore}`,
      5_000,
    );
    await sharedPageTwo.waitForExpression(
      `((window.__dustlineQa__?.getState()?.audio ?? []).filter((event) => event.type === 'world-fire' && event.playable === true).length) > ${worldFireBefore}`,
      5_000,
    );
    const sharedShotAudioState = await getState(sharedPageTwo);
    const sharedShotEvent = shotEvents(sharedShotAudioState, "shared-received").at(-1);
    assert(sharedShotEvent, "Expected shared remote shot event to be received");
    assert(
      sharedShotEvent.distance > 1,
      `Expected shared remote shot event to carry distance, saw ${JSON.stringify(sharedShotEvent)}`,
    );
    const sharedWorldFire = playableWorldFireEvents(sharedShotAudioState).at(-1);
    assert(sharedWorldFire, "Expected shared remote shot to create a playable world-fire audio event");
    assert(
      sharedWorldFire.distance > 1 &&
        sharedWorldFire.gain > 0.08 &&
        sharedWorldFire.gain <= 0.92 &&
        sharedWorldFire.outputGain >= sharedWorldFire.gain &&
        sharedWorldFire.blockedReason === null,
      `Expected shared shot audio to carry distance-normalized gain, saw ${JSON.stringify(sharedWorldFire)}`,
    );
    assert(
      sharedShotAudioState.remotePlayers?.[0]?.lastShotAgo !== null,
      "Expected shared remote actor to record a recent remote shot",
    );

    const sharedBombStartOne = await getState(sharedPageOne);
    const sharedBombStartTwo = await getState(sharedPageTwo);
    assert(
      sharedBombStartOne.bomb?.carrierId === sharedBombStartOne.localPlayer.id,
      "Expected the attacking shared operator to carry the relay charge",
    );
    assert(
      sharedBombStartTwo.bomb?.carrierId === sharedBombStartOne.localPlayer.id,
      "Expected the defending shared page to see the remote bomb carrier",
    );

    const sharedSite = sharedBombStartOne.bomb.sitePosition;
    await sharedPageOne.evaluate(
      `window.__dustlineQa__.setCameraPose(${sharedSite.x}, ${sharedBombStartOne.localPlayer.position.y}, ${sharedSite.z}, 0)`,
    );
    await delay(220);
    await engageControls(sharedPageOne);
    const sharedBombPlantPose = await getState(sharedPageOne);
    assert(
      sharedBombPlantPose.bomb.localCanPlant === true,
      "Expected the shared attacker to stand inside a valid bomb site",
    );

    await sharedPageOne.bringToFront();
    await startObjectiveAction(sharedPageOne);
    await sharedPageOne.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planting'",
      5_000,
    );
    await sharedPageOne.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planted'",
      7_000,
    );
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'planted'",
      7_000,
    );

    const sharedBombPlantedOne = await getState(sharedPageOne);
    const sharedBombPlantedTwo = await getState(sharedPageTwo);
    const sharedBombHudShell = await readHud(sharedPageTwo);
    const sharedBombHudTwo = await sharedPageTwo.evaluate(`
      ({
        status: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        progress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? ''
      })
    `);
    assert(
      sharedBombHudTwo.progress.includes("breach"),
      "Expected the defending shared HUD to show planted pressure",
    );

    await sharedPageTwo.evaluate(
      `window.__dustlineQa__.setCameraPose(${sharedSite.x}, ${sharedBombStartTwo.localPlayer.position.y}, ${sharedSite.z}, 0)`,
    );
    await stageSharedRemotePose(
      sharedPageOne,
      sharedBombStartTwo.localPlayer.id,
      sharedSite.x,
      sharedBombStartTwo.localPlayer.position.y,
      sharedSite.z,
      0,
    );
    await delay(220);
    await engageControls(sharedPageTwo);
    const sharedBombDefusePose = await getState(sharedPageTwo);
    assert(
      sharedBombDefusePose.bomb.localCanDefuse === true,
      "Expected the shared defender to stand inside the planted relay site",
    );

    await sharedPageTwo.bringToFront();
    await startObjectiveAction(sharedPageTwo);
    await startSharedRemoteObjectiveAction(sharedPageOne, sharedBombStartTwo.localPlayer.id);
    await sharedPageOne.bringToFront();
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'defusing'",
      5_000,
    );
    await completeSharedRemoteObjectiveAction(sharedPageOne, sharedBombStartTwo.localPlayer.id);
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /disarmed/i.test(state?.round?.result ?? '');
        })()
      `,
      10_000,
    );
    await sharedPageTwo.bringToFront();
    try {
      await sharedPageTwo.waitForExpression(
        `
          (() => {
            const state = window.__dustlineQa__?.getState();
            return state?.round?.phase === 'resolution' && /disarmed/i.test(state?.round?.result ?? '');
          })()
        `,
        10_000,
      );
    } catch (error) {
      const [hostState, guestState] = await Promise.all([
        getState(sharedPageOne),
        getState(sharedPageTwo),
      ]);
      console.error(
        "Shared bomb disarm resolution did not reach guest:",
        JSON.stringify(
          {
            host: {
              round: hostState?.round,
              bomb: hostState?.bomb,
              roomConnection: hostState?.roomConnection,
            },
            guest: {
              round: guestState?.round,
              bomb: guestState?.bomb,
              roomConnection: guestState?.roomConnection,
            },
          },
          null,
          2,
        ),
      );
      throw error;
    }

    const sharedBombResolvedOne = await getState(sharedPageOne);
    const sharedBombResolvedTwo = await getState(sharedPageTwo);
    summary.bombShared = {
      carrierId: sharedBombStartOne.bomb.carrierId,
      siteLabel: sharedBombStartOne.bomb.siteLabel,
      plantedPhasePageOne: sharedBombPlantedOne.bomb.phase,
      plantedPhasePageTwo: sharedBombPlantedTwo.bomb.phase,
      defenderCanDefuse: sharedBombDefusePose.bomb.localCanDefuse,
      resolutionPageOne: sharedBombResolvedOne.round.result,
      resolutionPageTwo: sharedBombResolvedTwo.round.result,
      defenderHudStatus: sharedBombHudTwo.status,
      defenderHudProgress: sharedBombHudTwo.progress,
    };

    const sharedRoundBefore = sharedBombResolvedOne.round.roundNumber;
    await sharedPageOne.evaluate("window.__dustlineQa__.forceNextRound()");
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.roundNumber === ${sharedRoundBefore + 1};
        })()
      `,
      10_000,
    );
    const sharedAfterOne = await getState(sharedPageOne);
    const sharedAfterTwo = await getState(sharedPageTwo);
    assert(
      sharedAfterOne.round.roundNumber === sharedAfterTwo.round.roundNumber &&
        sharedAfterOne.round.phase === sharedAfterTwo.round.phase,
      "Expected shared round advances to propagate",
    );

    summary.shared = {
      pageOneRoster: sharedStateOne.roster.length,
      pageTwoRoster: sharedStateTwo.roster.length,
      isolationRoster: isolatedState.roster.length,
      roundBeforeAdvance: sharedRoundBefore,
      roundAfterAdvance: sharedAfterTwo.round.roundNumber,
      phaseAfterAdvance: sharedAfterTwo.round.phase,
      remotePosturePageOne: sharedDuelStateOne.remotePlayers?.[0]?.posture ?? null,
      remotePosturePageTwo: sharedDuelStateTwo.remotePlayers?.[0]?.posture ?? null,
    };

    assert(sharedAfterTwo.round.missionType === "hostage", "Expected shared round two to rotate into hostage mode");
    await forceRoundActive(sharedPageOne);
    await sharedPageOne.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
    );

    const sharedHostageStartOne = await getState(sharedPageOne);
    const sharedHostageStartTwo = await getState(sharedPageTwo);
    const sharedHostageCount = sharedHostageStartTwo.hostage.hostages.length;
    const sharedCluster = sharedHostageStartTwo.hostage.clusterPosition;
    const sharedExtraction = sharedHostageStartTwo.hostage.extractionPosition;

    await sharedPageTwo.evaluate(
      `window.__dustlineQa__.setCameraPose(${sharedCluster.x}, ${sharedHostageStartTwo.localPlayer.position.y}, ${sharedCluster.z}, 0)`,
    );
    await stageSharedRemotePose(
      sharedPageOne,
      sharedHostageStartTwo.localPlayer.id,
      sharedCluster.x,
      sharedHostageStartTwo.localPlayer.position.y,
      sharedCluster.z,
      0,
    );
    await delay(220);
    await engageControls(sharedPageTwo);
    const sharedHostageSecurePose = await getState(sharedPageTwo);
    assert(
      sharedHostageSecurePose.hostage.localCanSecure === true,
      "Expected the shared rescuer to stand inside the live hostage cluster",
    );

    await sharedPageTwo.bringToFront();
    await startObjectiveAction(sharedPageTwo);
    await startSharedRemoteObjectiveAction(sharedPageOne, sharedHostageStartTwo.localPlayer.id);
    await sharedPageOne.bringToFront();
    await sharedPageOne.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'securing'",
      5_000,
    );
    await completeSharedRemoteObjectiveAction(sharedPageOne, sharedHostageStartTwo.localPlayer.id);
    await sharedPageOne.waitForExpression(
      `window.__dustlineQa__?.getState()?.hostage?.rescuerId === ${JSON.stringify(sharedHostageStartTwo.localPlayer.id)}`,
      5_000,
    );
    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      `(() => {
        const state = window.__dustlineQa__?.getState();
        return state?.hostage?.phase === 'escorting' &&
          state?.hostage?.rescuerId === ${JSON.stringify(sharedHostageStartTwo.localPlayer.id)};
      })()`,
      5_000,
    );
    const sharedHostageEscortOne = await getState(sharedPageOne);
    const sharedRouteLabels = sharedHostageEscortOne.hostage.route.map((point) => point.label);

    await sharedPageTwo.evaluate(
      `window.__dustlineQa__.setCameraPose(${sharedExtraction.x}, ${sharedHostageStartTwo.localPlayer.position.y}, ${sharedExtraction.z}, 0)`,
    );
    await stageSharedRemotePose(
      sharedPageOne,
      sharedHostageStartTwo.localPlayer.id,
      sharedExtraction.x,
      sharedHostageStartTwo.localPlayer.position.y,
      sharedExtraction.z,
      0,
    );
    await sharedPageOne.bringToFront();
    await sharedPageOne.waitForExpression(
      `(window.__dustlineQa__?.getState()?.hostage?.hostages?.[0]?.pathIndex ?? 0) >= ${Math.min(2, sharedRouteLabels.length - 1)}`,
      18_000,
    );
    const sharedHostageRouteState = await getState(sharedPageOne);
    await sharedPageOne.waitForExpression(
      `(window.__dustlineQa__?.getState()?.hostage?.extractedCount ?? 0) === ${sharedHostageCount}`,
      28_000,
    );
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'extracting'",
      5_000,
    );

    const sharedHostageHudOne = await sharedPageOne.evaluate(`
      ({
        status: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        progress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? ''
      })
    `);
    const sharedHostageHudShell = await readHud(sharedPageOne);
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /extracted/i.test(state?.round?.result ?? '');
        })()
      `,
      12_000,
    );
    await sharedPageTwo.bringToFront();
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /extracted/i.test(state?.round?.result ?? '');
        })()
      `,
      12_000,
    );

    const sharedHostageResolvedOne = await getState(sharedPageOne);
    const sharedHostageResolvedTwo = await getState(sharedPageTwo);
    summary.hostageShared = {
      clusterLabel: sharedHostageStartTwo.hostage.clusterLabel,
      extractionLabel: sharedHostageStartTwo.hostage.extractionLabel,
      routeLabels: sharedRouteLabels,
      rescuerId: sharedHostageStartTwo.localPlayer.id,
      localCanSecure: sharedHostageSecurePose.hostage.localCanSecure,
      observerRescuerId: sharedHostageEscortOne.hostage.rescuerId,
      routeProgressObserved: sharedHostageRouteState.hostage.hostages.map((hostage) => hostage.pathIndex),
      extractedCountObserved: sharedHostageResolvedOne.hostage.extractedCount,
      resolutionPageOne: sharedHostageResolvedOne.round.result,
      resolutionPageTwo: sharedHostageResolvedTwo.round.result,
      observerHudStatus: sharedHostageHudOne.status,
      observerHudProgress: sharedHostageHudOne.progress,
      observerMissionType: sharedHostageStartOne.round.missionType,
    };

    const fallbackPage = await createPage(`${ROOT_URL}?qa=1`, `
      Object.defineProperty(window, 'BroadcastChannel', {
        value: undefined,
        configurable: true,
      });
    `);
    pages.push(fallbackPage);

    await setTeamPreference(fallbackPage, "amber");
    await openMap(fallbackPage, "sandline-foundry", "shared");
    const fallbackState = await getState(fallbackPage);
    const fallbackNotice = await fallbackPage.evaluate(`
      document.querySelector('[data-ui="mode-notice"]')?.textContent?.trim() ?? ''
    `);

    assert(fallbackState.activeMode === "local", "Expected BroadcastChannel fallback to open solo mode");
    assert(
      fallbackNotice.includes("BroadcastChannel is unavailable"),
      "Expected BroadcastChannel fallback notice",
    );

    summary.fallback = {
      activeMode: fallbackState.activeMode,
      notice: fallbackNotice,
    };

    for (const hud of [
      localBombHudShell,
      localHostageHudShell,
      sharedBombHudShell,
      sharedHostageHudShell,
    ]) {
      assert(hud.teamName, "Expected HUD team name to be visible");
      assert(hud.roundNumber, "Expected HUD round number to be visible");
      assert(hud.roundPhase, "Expected HUD round phase to be visible");
      assert(hud.roundTimer, "Expected HUD round timer to be visible");
      assert(hud.missionLabel, "Expected HUD mission label to be visible");
      assert(hud.objectiveLabel, "Expected HUD objective label to be visible");
      assert(hud.objectiveStatus, "Expected HUD objective status to be visible");
      assert(hud.ammo, "Expected HUD ammo readout to be visible");
    }

    const bombPlantTimes = summary.mapChecks
      .map((entry) => entry.bombPlantSeconds)
      .filter((value) => typeof value === "number");
    const bombDefuseTimes = summary.mapChecks
      .map((entry) => entry.bombDefuseSeconds)
      .filter((value) => typeof value === "number");
    const bombFuseTimes = summary.mapChecks
      .map((entry) => entry.bombFuseSeconds)
      .filter((value) => typeof value === "number");
    const formatRange = (values, digits = 1) =>
      `${Math.min(...values).toFixed(digits)}-${Math.max(...values).toFixed(digits)}s`;

    summary.classicFeel = {
      tuning: {
        movement: localBombStart.tuning.movement,
        botMovement: localBombStart.tuning.botMovement,
        weapon: localBombStart.tuning.weapon,
        round: localBombStart.tuning.round,
        bombTimerRange: {
          plantSeconds: formatRange(bombPlantTimes),
          defuseSeconds: formatRange(bombDefuseTimes),
          fuseSeconds: formatRange(bombFuseTimes),
        },
        hostageTimers: {
          secureSeconds: localHostageStart.hostage.secureSeconds,
          extractSeconds: localHostageStart.hostage.extractSeconds,
        },
        ai: {
          ...localBombStart.tuning.ai,
          closeStandingReactionSeconds: closeStandingShot.reactionSeconds,
          farMovingReactionSeconds: farMovingShot.reactionSeconds,
          closeStandingHitChance: closeStandingShot.hitChance,
          farMovingHitChance: farMovingShot.hitChance,
          crouchedPartialHitChance: crouchedPartialShot.hitChance,
        },
      },
      checklist: {
        movementCadence: {
          result: "pass",
          evidence: `Walk ${localBombStart.tuning.movement.walkSpeed}u/s, crouch ${localBombStart.tuning.movement.crouchSpeed}u/s; same-window move sample ${summary.movement.standingDistance} vs ${summary.movement.crouchDistance}.`,
        },
        crouchReadability: {
          result: "pass",
          evidence: `Camera ${summary.movement.standingCameraY} -> ${summary.movement.crouchedCameraY}, crouch multiplier ${localBombStart.tuning.movement.crouchMultiplier}, recoil kick ${localBombStart.tuning.weapon.recoilKickStanding} standing vs ${localBombStart.tuning.weapon.recoilKickCrouched} crouched.`,
        },
        jumpReadability: {
          result: "pass",
          evidence: `Jump peak ${summary.movement.jumpPeakY}, landed ${summary.movement.landedY}, airtime ${summary.movement.airborneSeconds}s with gravity ${localBombStart.tuning.movement.gravity} and jump velocity ${localBombStart.tuning.movement.jumpVelocity}.`,
        },
        weaponTimingReadability: {
          result: "pass",
          evidence: `Player and bot fire interval ${localBombStart.tuning.weapon.fireInterval}s, damage ${localBombStart.tuning.weapon.playerDamage}; reload ${localBombStart.tuning.weapon.reloadDuration}s, clip ${localBombStart.tuning.weapon.clipSize}; HUD kept ammo ${localBombHudShell.ammo} and status ${localBombHudShell.firingStatus} readable in live play.`,
        },
        shortRoundPacing: {
          result: "pass",
          evidence: `Round phases ${localBombStart.tuning.round.briefingSeconds}s briefing / ${localBombStart.tuning.round.activeSeconds}s live / ${localBombStart.tuning.round.resolutionSeconds}s reset, with bomb fuse ${formatRange(bombFuseTimes)} and hostage secure/extract ${localHostageStart.hostage.secureSeconds}s / ${localHostageStart.hostage.extractSeconds}s.`,
        },
        objectivePressure: {
          result: "pass",
          evidence: `Solo bomb HUD "${localBombHud.progress}", shared bomb HUD "${sharedBombHudTwo.progress}", solo hostage HUD "${localHostageHud.progress}", shared hostage HUD "${sharedHostageHudOne.progress}".`,
        },
        coverOrientedCombat: {
          result: "pass",
          evidence: `AI used blocker ${summary.aiLocal.sightlineCase.blockerName}, held shots at blocked visibility ${summary.aiLocal.blockedVisibility}, then entered ${summary.aiLocal.repositionBehavior} and ${summary.aiLocal.pursueBehavior} after contact and broken sight.`,
        },
        hudClarity: {
          result: "pass",
          evidence: `Solo HUD showed ${localBombHudShell.teamName}, ${localBombHudShell.roundNumber}, ${localBombHudShell.roundPhase}, ${localBombHudShell.missionLabel}, ${localBombHudShell.objectiveLabel}; shared HUD showed ${sharedHostageHudShell.teamName}, ${sharedHostageHudShell.roundNumber}, ${sharedHostageHudShell.roundPhase}, ${sharedHostageHudShell.missionLabel}, ${sharedHostageHudShell.objectiveLabel}.`,
        },
      },
      hudExamples: {
        soloBomb: localBombHudShell,
        soloHostage: localHostageHudShell,
        sharedBomb: sharedBombHudShell,
        sharedHostage: sharedHostageHudShell,
      },
    };

    assert(
      SCREENSHOTS.every((filename) => capturedScreenshots.has(filename)),
      `Expected all screenshots to refresh. Captured ${capturedScreenshots.size} of ${SCREENSHOTS.length}.`,
    );

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await Promise.allSettled(pages.map((page) => page.close()));
    await stopProcess(chrome);
    await stopProcess(preview);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
