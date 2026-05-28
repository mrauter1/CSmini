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
  await page.waitForExpression(
    `
      typeof window.__dustlineQa__?.getState === 'function'
        && typeof window.__dustlineQa__?.setTeamPreference === 'function'
        && typeof window.__dustlineQa__?.openMap === 'function'
    `,
    15_000,
  );
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
    "window.__dustlineQa__?.getState()?.localPlayer?.pointerCaptured === true",
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

async function setTeamPreference(page, teamPreference) {
  await page.evaluate(
    `window.__dustlineQa__.setTeamPreference(${JSON.stringify(teamPreference)})`,
  );
  await delay(120);
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
      mapChecks: [],
      movement: {},
      respawn: {},
      bombLocal: {},
      hostageLocal: {},
      bombShared: {},
      hostageShared: {},
      shared: {},
      fallback: {},
    };

    const localPage = await createPage(`${ROOT_URL}?qa=1`);
    pages.push(localPage);

    await localPage.bringToFront();
    await localPage.waitForExpression("Boolean(document.querySelector('.screen--menu'))");
    await click(localPage, '[data-action="show-catalog"]');
    summary.mapCards = await localPage.waitForExpression("document.querySelectorAll('.map-card').length");
    assert(summary.mapCards === 5, `Expected 5 map cards, saw ${summary.mapCards}`);

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
      });
    }

    await setTeamPreference(localPage, "amber");
    await openMap(localPage, "sandline-foundry", "local");
    await engageControls(localPage);
    await delay(180);

    const standingState = await getState(localPage);
    const standingY = standingState.localPlayer.position.y;

    await dispatchWindowKey(localPage, "keydown", "ControlLeft", "Control");
    await delay(240);
    const crouchState = await getState(localPage);
    assert(
      crouchState.localPlayer.position.y < standingY - 0.25,
      `Expected crouch to lower the camera. Standing ${standingY}, crouched ${crouchState.localPlayer.position.y}`,
    );
    await dispatchWindowKey(localPage, "keyup", "ControlLeft", "Control");
    await delay(180);

    await localPage.evaluate("window.__dustlineQa__.setPose(0, 14, 0)");
    await delay(120);
    const startStandingMove = await getState(localPage);
    await holdKey(localPage, "KeyW", "w", 900);
    const endStandingMove = await getState(localPage);
    const standingDistance = Math.abs(endStandingMove.localPlayer.position.z - startStandingMove.localPlayer.position.z);

    await localPage.evaluate("window.__dustlineQa__.setPose(0, 14, 0)");
    await delay(120);
    await dispatchWindowKey(localPage, "keydown", "ControlLeft", "Control");
    await delay(500);
    const startCrouchMove = await getState(localPage);
    await holdKey(localPage, "KeyW", "w", 900);
    const endCrouchMove = await getState(localPage);
    await dispatchWindowKey(localPage, "keyup", "ControlLeft", "Control");
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
      5_000,
    );

    const localBombStart = await getState(localPage);
    assert(
      localBombStart.bomb?.carrierId === localBombStart.localPlayer.id,
      "Expected the attacking local operator to carry the relay charge",
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
      5_000,
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
      18_000,
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

    const localHostageHud = await localPage.evaluate(`
      ({
        status: document.querySelector('[data-ui="objective-status"]')?.textContent?.trim() ?? '',
        progress: document.querySelector('[data-ui="objective-progress-label"]')?.textContent?.trim() ?? ''
      })
    `);
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
      resolution: localHostageResolved.round.result,
      hudStatus: localHostageHud.status,
      hudProgress: localHostageHud.progress,
      roundAfterReset: localHostageReset.round.roundNumber,
      phaseAfterReset: localHostageReset.round.phase,
    };

    await setInvulnerable(localPage, false);

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

    await engageControls(sharedPageOne);
    await engageControls(sharedPageTwo);
    await forceRoundActive(sharedPageOne);
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.round?.phase === 'active'",
      5_000,
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
    await delay(220);
    await engageControls(sharedPageTwo);
    const sharedBombDefusePose = await getState(sharedPageTwo);
    assert(
      sharedBombDefusePose.bomb.localCanDefuse === true,
      "Expected the shared defender to stand inside the planted relay site",
    );

    await sharedPageTwo.bringToFront();
    await startObjectiveAction(sharedPageTwo);
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.bomb?.phase === 'defusing'",
      5_000,
    );
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /disarmed/i.test(state?.round?.result ?? '');
        })()
      `,
      10_000,
    );
    await sharedPageTwo.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /disarmed/i.test(state?.round?.result ?? '');
        })()
      `,
      10_000,
    );

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
    };

    assert(sharedAfterTwo.round.missionType === "hostage", "Expected shared round two to rotate into hostage mode");
    await forceRoundActive(sharedPageTwo);
    await sharedPageOne.waitForExpression(
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
    await delay(220);
    await engageControls(sharedPageTwo);
    const sharedHostageSecurePose = await getState(sharedPageTwo);
    assert(
      sharedHostageSecurePose.hostage.localCanSecure === true,
      "Expected the shared rescuer to stand inside the live hostage cluster",
    );

    await sharedPageTwo.bringToFront();
    await startObjectiveAction(sharedPageTwo);
    await sharedPageTwo.waitForExpression(
      "window.__dustlineQa__?.getState()?.hostage?.phase === 'escorting'",
      5_000,
    );
    await sharedPageOne.waitForExpression(
      `window.__dustlineQa__?.getState()?.hostage?.rescuerId === ${JSON.stringify(sharedHostageStartTwo.localPlayer.id)}`,
      5_000,
    );
    const sharedHostageEscortOne = await getState(sharedPageOne);
    const sharedRouteLabels = sharedHostageEscortOne.hostage.route.map((point) => point.label);

    await sharedPageTwo.evaluate(
      `window.__dustlineQa__.setCameraPose(${sharedExtraction.x}, ${sharedHostageStartTwo.localPlayer.position.y}, ${sharedExtraction.z}, 0)`,
    );
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
    await sharedPageOne.waitForExpression(
      `
        (() => {
          const state = window.__dustlineQa__?.getState();
          return state?.round?.phase === 'resolution' && /extracted/i.test(state?.round?.result ?? '');
        })()
      `,
      12_000,
    );
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
