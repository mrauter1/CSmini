import { featuredMap, getMapById, mapCatalog } from "../data/maps";
import {
  BOT_DIFFICULTIES,
  botDifficultyLabel,
  isBotDifficulty,
  readStoredBotDifficulty,
  writeStoredBotDifficulty,
  type BotDifficulty,
} from "../game/botDifficulty";
import {
  CLASSIC_CROUCH_STORAGE_KEY,
  crouchControlLabel,
} from "../game/controls";
import type { LocalMatch, LocalMatchSnapshot } from "../game/localMatch";
import type { MatchMode } from "../game/multiplayerRoom";
import { getTeamDefinition, isTeamId } from "../game/teams";
import type { MapDefinition, TeamPreference } from "../types";
import { renderCatalog, renderMapStage, renderMenu } from "./templates";

type Screen = "menu" | "catalog" | "stage";

function readClassicCrouchAlias(): boolean {
  try {
    return localStorage.getItem(CLASSIC_CROUCH_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeClassicCrouchAlias(enabled: boolean): void {
  try {
    localStorage.setItem(CLASSIC_CROUCH_STORAGE_KEY, String(enabled));
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

export class TacticalShellApp {
  private screen: Screen = "menu";
  private activeMapId = featuredMap.id;
  private activeMode: MatchMode = "shared";
  private teamPreference: TeamPreference = "auto";
  private botDifficulty = readStoredBotDifficulty();
  private classicCrouchAlias = readClassicCrouchAlias();
  private match?: LocalMatch;
  private renderToken = 0;

  constructor(private readonly root: HTMLElement) {
    this.root.addEventListener("click", this.handleClick);
    window.addEventListener("keydown", this.handleFullscreenShortcut);
  }

  mount(): void {
    this.render();
  }

  dispose(): void {
    this.teardownMatch();
    this.root.removeEventListener("click", this.handleClick);
    window.removeEventListener("keydown", this.handleFullscreenShortcut);
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionButton = target.closest<HTMLElement>("[data-action]");
    if (!actionButton) {
      if (target.closest("[data-world-shell]")) {
        this.match?.requestPointerLock();
      }
      return;
    }

    const action = actionButton.dataset.action;
    const mapId = actionButton.dataset.mapId;
    const mode = this.readMode(actionButton.dataset.mode);
    const team = this.readTeamPreference(actionButton.dataset.team);
    const botDifficulty = this.readBotDifficulty(actionButton.dataset.botDifficulty);

    switch (action) {
      case "show-menu":
        this.screen = "menu";
        this.render();
        return;
      case "show-catalog":
        this.screen = "catalog";
        this.render();
        return;
      case "lock-match":
        this.match?.requestPointerLock();
        return;
      case "toggle-fullscreen":
        void this.match?.toggleViewportFullscreen();
        return;
      case "toggle-classic-crouch":
        this.classicCrouchAlias = !this.classicCrouchAlias;
        writeClassicCrouchAlias(this.classicCrouchAlias);
        this.match?.setClassicCrouchAlias(this.classicCrouchAlias);
        this.syncClassicCrouchUi();
        return;
      case "set-team":
        if (!team) {
          return;
        }

        this.teamPreference = team;
        this.render();
        return;
      case "set-bot-difficulty":
        if (!botDifficulty) {
          return;
        }

        this.applyBotDifficulty(botDifficulty);
        return;
      case "open-map":
      case "swap-map":
        this.activeMapId = getMapById(mapId ?? featuredMap.id).id;
        this.activeMode = mode ?? this.activeMode;
        this.screen = "stage";
        this.render();
        return;
      default:
        return;
    }
  };

  private readonly handleFullscreenShortcut = (event: KeyboardEvent): void => {
    if (
      this.screen !== "stage" ||
      event.repeat ||
      event.code !== "Enter" ||
      !event.altKey ||
      this.isEditableEventTarget(event.target)
    ) {
      return;
    }

    event.preventDefault();
    void this.match?.toggleViewportFullscreen();
  };

  private render(): void {
    const token = ++this.renderToken;
    this.teardownMatch();

    if (this.screen === "menu") {
      this.root.innerHTML = renderMenu(
        getMapById(this.activeMapId),
        this.teamPreference,
        this.botDifficulty,
      );
      return;
    }

    if (this.screen === "catalog") {
      this.root.innerHTML = renderCatalog(mapCatalog, this.teamPreference, this.botDifficulty);
      return;
    }

    const map = getMapById(this.activeMapId);
    this.root.innerHTML = renderMapStage(
      map,
      mapCatalog,
      this.activeMode,
      this.teamPreference,
      this.classicCrouchAlias,
      this.botDifficulty,
    );

    const host = this.root.querySelector<HTMLElement>("[data-world-host]");
    if (!host) {
      throw new Error("Missing world host");
    }

    host.innerHTML = '<div class="world-stage__loading">Loading live arena...</div>';
    void this.mountMatch(host, map, token);
  }

  private teardownMatch(): void {
    this.match?.dispose();
    this.match = undefined;
  }

  private async mountMatch(
    host: HTMLElement,
    map: MapDefinition,
    token: number,
  ): Promise<void> {
    const { LocalMatch } = await import("../game/localMatch");

    if (token !== this.renderToken || this.screen !== "stage" || !host.isConnected) {
      return;
    }

    let match: LocalMatch;

    try {
      match = new LocalMatch(host, map, {
        mode: this.activeMode,
        teamPreference: this.teamPreference,
        botDifficulty: this.botDifficulty,
        classicCrouchAlias: this.classicCrouchAlias,
        onActionRequest: (action) => {
          if (token !== this.renderToken) {
            return;
          }

          this.screen = action === "catalog" ? "catalog" : "menu";
          this.render();
        },
        onSnapshot: (snapshot) => {
          if (token !== this.renderToken || this.screen !== "stage") {
            return;
          }

          this.syncMatchUi(snapshot);
        },
      });
    } catch (error) {
      if (token !== this.renderToken || this.screen !== "stage" || !host.isConnected) {
        return;
      }

      this.renderMatchStartupError(host, error);
      return;
    }

    if (token !== this.renderToken || this.screen !== "stage") {
      match.dispose();
      return;
    }

    this.match = match;
  }

  private renderMatchStartupError(host: HTMLElement, error: unknown): void {
    const isWebGlError = this.isWebGlStartupError(error);
    const detail =
      error instanceof Error && error.message
        ? error.message
        : "The browser rejected the match startup request.";
    const kicker = isWebGlError ? "Renderer unavailable" : "Match startup failed";
    const heading = isWebGlError ? "WebGL could not start" : "Match could not start";
    const message = isWebGlError
      ? "This browser session could not create the 3D context needed for the arena. Close extra tabs, make sure hardware acceleration or software WebGL is enabled, then reload the match."
      : "An unexpected runtime error stopped the arena before it finished mounting. Check the browser console for the underlying exception, then reload the match after fixing it.";

    if (!isWebGlError) {
      console.error("Match startup failed", error);
    }

    this.root
      .querySelectorAll<HTMLElement>(".match-hud, .hud-hint, .hud-downline")
      .forEach((node) => {
        node.hidden = true;
      });

    host.innerHTML = `
      <div class="world-stage__error" role="alert">
        <p class="world-stage__error-kicker">${kicker}</p>
        <h2>${heading}</h2>
        <p>${message}</p>
        <code>${this.escapeHtml(detail)}</code>
      </div>
    `;
  }

  private isWebGlStartupError(error: unknown): boolean {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);

    return /webgl|webglrenderer|creating webgl context|could not create a webgl context/i.test(
      text,
    );
  }

  private syncMatchUi(snapshot: LocalMatchSnapshot): void {
    const setText = (key: string, value: string): void => {
      this.root.querySelectorAll<HTMLElement>(`[data-ui="${key}"]`).forEach((node) => {
        node.textContent = value;
      });
    };

    setText("map-name", snapshot.mapName);
    setText("mode-notice", snapshot.modeNotice);
    setText("health", String(snapshot.health));
    setText("ammo", `${snapshot.ammoInClip} / ${snapshot.reserveAmmo}`);
    setText("firing-status", snapshot.firingStatus);
    setText("status", snapshot.statusLine);
    setText("player-count", `${snapshot.playerCount} ${snapshot.playerCount === 1 ? "operator" : "operators"}`);
    setText("prompt", snapshot.prompt);
    setText("death", snapshot.deathLine);
    setText("team-name", snapshot.teamName);
    setText("team-banner", snapshot.teamBanner);
    setText("round-number", `Round ${snapshot.roundNumber}`);
    setText("round-phase", snapshot.roundPhaseLabel);
    setText("round-timer", snapshot.roundTimer);
    setText("mission-label", snapshot.missionLabel);
    setText("objective-label", snapshot.objectiveLabel);
    setText("mission-summary", snapshot.missionSummary);
    setText("objective-status", snapshot.objectiveStatus);
    setText("objective-progress-label", snapshot.objectiveProgressLabel);
    setText("alive-state", snapshot.aliveState);

    const promptPanel = this.root.querySelector<HTMLElement>('[data-ui="prompt-panel"]');
    if (promptPanel) {
      promptPanel.hidden = snapshot.pointerLocked || snapshot.deathLine.length > 0;
    }

    const deathPanel = this.root.querySelector<HTMLElement>('[data-ui="death-panel"]');
    if (deathPanel) {
      deathPanel.hidden = snapshot.deathLine.length === 0;
    }

    const scoreboardPanel = this.root.querySelector<HTMLElement>('[data-ui="scoreboard-panel"]');
    if (scoreboardPanel) {
      scoreboardPanel.hidden = !snapshot.scoreboardVisible;
    }

    const worldShell = this.root.querySelector<HTMLElement>("[data-world-shell]");
    if (worldShell) {
      worldShell.classList.toggle("world-stage__viewport--locked", snapshot.pointerLocked);
      worldShell.classList.toggle(
        "world-stage__viewport--scoreboard",
        snapshot.scoreboardVisible,
      );
      worldShell.classList.toggle(
        "world-stage__viewport--fullscreen-active",
        snapshot.fullscreenActive,
      );
      worldShell.dataset.team = snapshot.teamId;
    }

    const fullscreenToggle = this.root.querySelector<HTMLButtonElement>(
      '[data-ui="fullscreen-toggle"]',
    );
    if (fullscreenToggle) {
      const fullscreenLabel = snapshot.fullscreenActive
        ? "Exit viewport fullscreen"
        : snapshot.fullscreenAvailable
          ? "Enter viewport fullscreen"
          : "Viewport fullscreen unavailable";
      fullscreenToggle.disabled = !snapshot.fullscreenAvailable;
      fullscreenToggle.classList.toggle(
        "hud-fullscreen-toggle--active",
        snapshot.fullscreenActive,
      );
      fullscreenToggle.dataset.fullscreenActive = String(snapshot.fullscreenActive);
      fullscreenToggle.setAttribute("aria-label", fullscreenLabel);
      fullscreenToggle.setAttribute("title", fullscreenLabel);
    }

    const hitIndicator = this.root.querySelector<HTMLElement>("[data-hit-indicator]");
    hitIndicator?.classList.toggle("hud-crosshair--hit", snapshot.hitActive);

    const damageOverlay = this.root.querySelector<HTMLElement>("[data-damage-overlay]");
    damageOverlay?.classList.toggle("hud-damage--active", snapshot.damageActive);

    const teamCounts = this.root.querySelector<HTMLElement>('[data-ui="team-counts"]');
    if (teamCounts) {
      teamCounts.innerHTML = snapshot.teamCounts
        .map((entry) => {
          const team = getTeamDefinition(entry.teamId);
          return `
            <div class="team-count" data-team="${entry.teamId}">
              <strong>${this.escapeHtml(team.name)}</strong>
              <span>${entry.alive} alive / ${entry.total}</span>
            </div>
          `;
        })
        .join("");
    }

    const roster = this.root.querySelector<HTMLElement>('[data-ui="roster"]');
    if (roster) {
      roster.innerHTML = snapshot.roster
        .map((entry) => {
          const statusLabel = entry.status === "alive" ? "Alive" : "Down";
          const objectiveRole = entry.objectiveRole
            ? `<small class="roster-row__badge">${this.escapeHtml(entry.objectiveRole)}</small>`
            : "";

          return `
            <div class="roster-row ${entry.local ? "roster-row--local" : ""}" data-team="${entry.teamId}">
              <div>
                <strong>${this.escapeHtml(entry.name)}${objectiveRole}</strong>
                <span>${this.escapeHtml(entry.teamLabel)} · ${statusLabel}</span>
              </div>
              <div>
                <small>${entry.health} HP</small>
                <small>${entry.eliminations} K / ${entry.deaths} D</small>
              </div>
            </div>
          `;
        })
        .join("");
    }

    const showObjectiveProgress =
      snapshot.objectiveProgressLabel.length > 0 || snapshot.objectiveProgress > 0;
    this.root.querySelectorAll<HTMLElement>('[data-ui="objective-progress"]').forEach((objectiveProgress) => {
      objectiveProgress.hidden = !showObjectiveProgress;
    });
    this.root.querySelectorAll<HTMLElement>('[data-ui="objective-progress-fill"]').forEach((objectiveProgressFill) => {
      objectiveProgressFill.style.width = `${Math.max(0, Math.min(1, snapshot.objectiveProgress)) * 100}%`;
    });

    this.syncClassicCrouchUi();
    this.syncBotDifficultyUi();
  }

  private syncClassicCrouchUi(): void {
    const label = crouchControlLabel(this.classicCrouchAlias);
    const crouchHint = this.root.querySelector<HTMLElement>('[data-ui="crouch-control"] span');
    if (crouchHint) {
      crouchHint.textContent = label;
    }

    const toggle = this.root.querySelector<HTMLButtonElement>('[data-ui="classic-crouch-toggle"]');
    if (toggle) {
      toggle.textContent = `Ctrl Crouch ${this.classicCrouchAlias ? "On" : "Off"}`;
      toggle.setAttribute("aria-pressed", String(this.classicCrouchAlias));
    }
  }

  private syncBotDifficultyUi(): void {
    const label = botDifficultyLabel(this.botDifficulty);
    const note = this.botDifficultyNote();

    this.root.querySelectorAll<HTMLElement>('[data-ui="bot-difficulty-current"]').forEach((node) => {
      node.textContent = label;
    });

    this.root.querySelectorAll<HTMLElement>('[data-ui="bot-difficulty-note"]').forEach((node) => {
      node.textContent = note;
    });

    this.root
      .querySelectorAll<HTMLButtonElement>('[data-action="set-bot-difficulty"]')
      .forEach((button) => {
        const difficulty = this.readBotDifficulty(button.dataset.botDifficulty);
        const active = difficulty === this.botDifficulty;
        button.classList.toggle("difficulty-pick--active", active);
        button.setAttribute("aria-pressed", String(active));
      });
  }

  private applyBotDifficulty(difficulty: BotDifficulty): void {
    this.botDifficulty = difficulty;
    writeStoredBotDifficulty(this.botDifficulty);
    this.match?.setBotDifficulty(this.botDifficulty);

    if (this.screen === "stage" && this.match) {
      this.syncBotDifficultyUi();
      return;
    }

    this.render();
  }

  private botDifficultyNote(): string {
    if (this.screen !== "stage") {
      return "Best-effort saved in this browser. Applies to solo rounds only. Shared Room stays human-only across tabs.";
    }

    if (this.activeMode === "local") {
      return "Applies to this solo-local fireteam only.";
    }

    return "Stored for solo rounds only. Shared Room stays human-only across tabs.";
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private isEditableEventTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  debugOpenMap(mapId: string, mode: MatchMode): void {
    this.activeMapId = getMapById(mapId).id;
    this.activeMode = mode;
    this.screen = "stage";
    this.render();
  }

  debugSetTeamPreference(teamPreference: TeamPreference): void {
    this.teamPreference = teamPreference;
    this.render();
  }

  debugSetBotDifficulty(botDifficulty: BotDifficulty): void {
    this.applyBotDifficulty(botDifficulty);
  }

  debugReturnToCatalog(): void {
    this.screen = "catalog";
    this.render();
  }

  debugGetState(): Record<string, unknown> | null {
    return {
      screen: this.screen,
      activeMapId: this.activeMapId,
      activeMode: this.activeMode,
      teamPreference: this.teamPreference,
      classicCrouchAlias: this.classicCrouchAlias,
      botDifficulty: this.botDifficulty,
      availableBotDifficulties: [...BOT_DIFFICULTIES],
      ...(this.match?.debugSnapshot() ?? {}),
    };
  }

  debugEngageControls(): void {
    this.match?.requestPointerLock();
  }

  debugSetPose(x: number, z: number, yaw: number, pitch = 0): void {
    this.match?.debugSetPose(x, z, yaw, pitch);
  }

  debugSetCameraPose(x: number, y: number, z: number, yaw: number, pitch = 0): void {
    this.match?.debugSetCameraPose(x, y, z, yaw, pitch);
  }

  debugSetView(
    x: number,
    y: number,
    z: number,
    targetX: number,
    targetY: number,
    targetZ: number,
  ): void {
    this.match?.debugSetView(x, y, z, targetX, targetY, targetZ);
  }

  debugStageSharedDuel(slot: 0 | 1, aimOffsetY = 0):
    | {
        self: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageSharedDuel(slot, aimOffsetY) ?? null;
  }

  debugFire(): void {
    this.match?.debugFire();
  }

  debugForcePlayerDeath(attackerName?: string): void {
    this.match?.debugForcePlayerDeath(attackerName);
  }

  debugForceNextRound(): void {
    this.match?.debugForceNextRound();
  }

  debugForceRoundActive(): void {
    this.match?.debugForceRoundActive();
  }

  debugSetInvulnerable(enabled: boolean): void {
    this.match?.debugSetInvulnerable(enabled);
  }

  debugStartObjectiveAction(): boolean {
    return this.match?.debugStartObjectiveAction() ?? false;
  }

  debugSetKey(code: string, active: boolean): void {
    this.match?.debugSetKey(code, active);
  }

  debugJump(): void {
    this.match?.debugJump();
  }

  debugJumpSample():
    | {
        peakY: number;
        landedY: number;
        landed: boolean;
        airborneSeconds: number;
      }
    | null {
    return this.match?.debugJumpSample() ?? null;
  }

  debugAimAt(combatantId: string): boolean {
    return this.match?.debugAimAt(combatantId) ?? false;
  }

  debugProbeShot():
    | {
        direction: { x: number; y: number; z: number };
        hits: Array<{ combatantId: string | null; objectName: string; distance: number }>;
      }
    | null {
    return this.match?.debugProbeShot() ?? null;
  }

  debugSharedTarget(): string | null {
    return this.match?.debugSharedTarget() ?? null;
  }

  debugStageAiSightlineCase():
    | {
        enemyId: string;
        enemyLabel: string;
        blockerName: string;
        enemyPosition: { x: number; y: number; z: number };
        blockedPlayerPosition: { x: number; y: number; z: number };
        clearPlayerPosition: { x: number; y: number; z: number };
        blockedPlayerLabel: string;
        clearPlayerLabel: string;
      }
    | null {
    return this.match?.debugStageAiSightlineCase() ?? null;
  }

  debugEvaluateEnemyShot(
    combatantId: string,
    overrides?: Partial<{
      distance: number;
      visibility: number;
      targetSpeed: number;
      shooterSpeed: number;
      targetCrouching: boolean;
      shooterCrouching: boolean;
    }>,
  ):
    | {
        distance: number;
        visibility: number;
        shooterSpeed: number;
        targetSpeed: number;
        targetCrouching: boolean;
        shooterCrouching: boolean;
        reactionSeconds: number;
        spreadDegrees: number;
        hitChance: number;
        missChance: number;
      }
    | null {
    return this.match?.debugEvaluateEnemyShot(combatantId, overrides) ?? null;
  }

  private readMode(value: string | undefined): MatchMode | undefined {
    if (value === "shared" || value === "local") {
      return value;
    }

    return undefined;
  }

  private readTeamPreference(value: string | undefined): TeamPreference | undefined {
    if (value === "auto" || isTeamId(value)) {
      return value;
    }

    return undefined;
  }

  private readBotDifficulty(value: string | undefined): BotDifficulty | undefined {
    return isBotDifficulty(value) ? value : undefined;
  }
}
