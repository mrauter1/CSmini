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
import {
  buildRoomId,
  buildSignaledRoomId,
  createBroadcastMatchRoomConnection,
  createHostMatchRoomConnection,
  createJoinMatchRoomConnection,
  createRoomCode,
  createRoomIdentity,
  createSignaledHostMatchRoomConnection,
  createSignaledJoinMatchRoomConnection,
  detectSharedRoomSupport,
  normalizeRoomCode,
  type CloudRoomVisibility,
  type HostMatchRoomConnection,
  type JoinMatchRoomConnection,
  type LatestStateQaConfig,
  type LatestStateQaDirection,
  type MatchMode,
  type MatchRoomConnection,
  type RelayIdleQaConfig,
  type RoomConnectionKind,
  type SharedRoomHandlers,
} from "../net/matchRoomConnection";
import { fetchPublicRooms, type PublicRoomSummary } from "../net/publicRooms";
import {
  firstAvailablePublicRoomSlot,
  publicRoomSlotForCode,
  publicRoomSlotLabel,
} from "../net/publicRoomSlots";
import { getSignalingServiceUrl } from "../net/signalingConfig";
import { getTeamDefinition, isTeamId, resolveTeamPreference, teamPreferenceLabel } from "../game/teams";
import type { MapDefinition, TeamPreference } from "../types";
import {
  renderCatalog,
  renderMapStage,
  renderMenu,
  renderRoomSetup,
} from "./templates";

type Screen = "menu" | "catalog" | "room" | "stage";

interface RoomSetupState {
  kind: RoomConnectionKind;
  visibility: CloudRoomVisibility;
  publicSlot: number;
  roomCode: string;
  roomUrl: string;
  signalingUrl: string;
  publicRooms: PublicRoomSummary[];
  publicRoomsStatus: string;
  publicRoomsError: string;
  connection?: MatchRoomConnection;
  supportError: string;
  copyStatus: string;
  closedRoomMessage: string;
  autoEnterOnConnected: boolean;
  autoHostOnClosedJoin: boolean;
  linkJoin: boolean;
  closedJoinTimer?: number;
  unsubscribe?: () => void;
}

const NOOP_ROOM_HANDLERS: SharedRoomHandlers = {
  onParticipant: () => undefined,
  onLeave: () => undefined,
  onInput: () => undefined,
  onShotClaim: () => undefined,
  onShotResult: () => undefined,
  onSnapshot: () => undefined,
  onRoomClosed: () => undefined,
};

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
  private readonly operatorIdentity = createRoomIdentity();
  private roomSetup?: RoomSetupState;
  private match?: LocalMatch;
  private renderToken = 0;

  constructor(private readonly root: HTMLElement) {
    this.root.addEventListener("click", this.handleClick);
    window.addEventListener("keydown", this.handleFullscreenShortcut);
  }

  mount(): void {
    if (this.applyInitialRoomLink()) {
      return;
    }

    this.render();
  }

  dispose(): void {
    this.teardownMatch();
    this.disposeRoomSetup();
    this.root.removeEventListener("click", this.handleClick);
    window.removeEventListener("keydown", this.handleFullscreenShortcut);
  }

  private applyInitialRoomLink(): boolean {
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(window.location.search);
    } catch {
      return false;
    }

    const roomCode = normalizeRoomCode(
      params.get("room") ?? params.get("roomCode") ?? params.get("code") ?? "",
    );
    if (!roomCode) {
      return false;
    }

    this.activeMapId = getMapById(params.get("map") ?? this.activeMapId).id;
    this.activeMode = "shared";
    this.screen = "room";
    this.selectRoomKind("signal-join");
    this.connectSignalingRoom(roomCode, { autoEnter: true, linkJoin: true });
    return true;
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
    const roomVisibility = this.readRoomVisibility(actionButton.dataset.roomVisibility);

    switch (action) {
      case "show-menu":
        this.exitMatchFlow("menu");
        return;
      case "show-catalog":
        this.exitMatchFlow("catalog");
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
        this.openMapRoute(getMapById(mapId ?? featuredMap.id), mode ?? this.activeMode);
        return;
      case "select-room-kind":
        this.selectRoomKind(this.readRoomKind(actionButton.dataset.roomKind));
        return;
      case "set-room-visibility":
        if (roomVisibility) {
          this.selectRoomVisibility(roomVisibility);
        }
        return;
      case "room-generate-offer":
        void this.generateRoomOffer();
        return;
      case "room-apply-answer":
        void this.applyRoomAnswer();
        return;
      case "room-generate-answer":
        void this.generateRoomAnswer();
        return;
      case "room-copy":
        void this.copyRoomField(actionButton.dataset.field);
        return;
      case "room-connect-signaling":
        this.connectSignalingRoom();
        return;
      case "room-refresh-public":
        void this.refreshPublicRooms();
        return;
      case "room-join-public":
        if (actionButton.dataset.roomCode) {
          this.connectSignalingRoom(actionButton.dataset.roomCode, { autoEnter: true });
        }
        return;
      case "room-join-another":
        this.showJoinAnotherRoom();
        return;
      case "enter-room-stage":
        if (this.canEnterStage()) {
          this.screen = "stage";
          this.render();
        }
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

    if (this.screen === "room") {
      const map = getMapById(this.activeMapId);
      this.root.innerHTML = renderRoomSetup(
        map,
        {
          map,
          selectedKind: this.roomSetup?.kind ?? "signal-join",
          visibility: this.roomSetup?.visibility ?? "public",
          publicSlot: this.roomSetup?.publicSlot ?? 0,
          supportError: this.roomSetup?.supportError ?? "",
          copyStatus: this.roomSetup?.copyStatus ?? "",
          roomCode: this.roomSetup?.roomCode ?? "",
          roomUrl: this.roomSetup?.roomUrl ?? this.buildRoomUrl(this.roomSetup?.roomCode ?? "", map.id),
          signalingUrl: this.roomSetup?.signalingUrl ?? getSignalingServiceUrl(),
          publicRooms: this.roomSetup?.publicRooms ?? [],
          publicRoomsStatus: this.roomSetup?.publicRoomsStatus ?? "",
          publicRoomsError: this.roomSetup?.publicRoomsError ?? "",
          closedRoomMessage: this.roomSetup?.closedRoomMessage ?? "",
          connection: this.roomSetup?.connection?.uiSnapshot,
          canEnterArena: this.canEnterStage(),
          teamLabel: teamPreferenceLabel(this.teamPreference),
          operatorName: this.operatorIdentity.name,
          entryHint:
            this.roomSetup?.kind === "signal-host"
              ? "Host rooms can enter the arena immediately. Public rooms appear in the listing while the host tab stays open."
              : "Joiners can enter once the transport reaches connected.",
        },
      );
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
      this.activeMode === "shared" ? this.roomSetup?.roomUrl ?? "" : "",
      this.activeMode === "shared" ? this.roomSetup?.copyStatus ?? "" : "",
    );

    const host = this.root.querySelector<HTMLElement>("[data-world-host]");
    if (!host) {
      throw new Error("Missing world host");
    }

    host.innerHTML = '<div class="world-stage__loading">Loading live arena...</div>';
    this.resetMatchScroll();
    void this.mountMatch(host, map, token);
  }

  private resetMatchScroll(): void {
    if (typeof window === "undefined") {
      return;
    }

    const token = this.renderToken;
    window.requestAnimationFrame(() => {
      if (token !== this.renderToken || this.screen !== "stage") {
        return;
      }

      window.scrollTo(0, 0);
    });
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
        sharedRoom: this.activeMode === "shared" ? this.roomSetup?.connection : undefined,
        sharedRoomFallbackReason: this.roomSetup?.supportError,
        onActionRequest: (action) => {
          if (token !== this.renderToken) {
            return;
          }

          this.exitMatchFlow(action === "catalog" ? "catalog" : "menu");
        },
        onRoomEnded: (reason) => {
          if (token !== this.renderToken) {
            return;
          }

          this.handleRoomEnded(reason);
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
    setText("objective-action-progress-label", snapshot.objectiveActionProgressLabel);
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
    const showObjectiveActionProgress =
      snapshot.objectiveActionProgressVisible &&
      snapshot.objectiveActionProgressLabel.length > 0;
    this.root.querySelectorAll<HTMLElement>('[data-ui="objective-action-progress"]').forEach((objectiveActionProgress) => {
      objectiveActionProgress.hidden = !showObjectiveActionProgress;
      objectiveActionProgress.dataset.actionKind = snapshot.objectiveActionProgressKind ?? "";
    });
    this.root.querySelectorAll<HTMLElement>('[data-ui="objective-action-progress-fill"]').forEach((objectiveActionProgressFill) => {
      objectiveActionProgressFill.style.width = `${Math.max(0, Math.min(1, snapshot.objectiveActionProgress)) * 100}%`;
    });

    this.syncClassicCrouchUi();
    this.syncBotDifficultyUi();
  }

  private openMapRoute(map: MapDefinition, mode: MatchMode): void {
    this.activeMapId = map.id;

    if (mode === "local") {
      this.disposeRoomSetup();
      this.activeMode = "local";
      this.screen = "stage";
      this.render();
      return;
    }

    this.activeMode = "shared";
    this.screen = "room";
    this.selectRoomKind(this.roomSetup?.kind ?? "signal-join");
  }

  private selectRoomKind(kind: RoomConnectionKind): void {
    const map = getMapById(this.activeMapId);

    if (this.roomSetup?.kind === kind && this.roomSetup.connection) {
      this.screen = "room";
      this.render();
      return;
    }

    const previousRoomCode = this.roomSetup?.roomCode ?? "";
    const previousVisibility =
      this.roomSetup?.kind === "signal-host" ? this.roomSetup.visibility : "public";
    const previousPublicRooms = this.roomSetup?.publicRooms ?? [];
    this.disposeRoomSetup();

    const support = detectSharedRoomSupport(kind);
    const visibility = kind === "signal-host" ? previousVisibility : "public";
    const roomCode =
      kind === "signal-host"
        ? visibility === "private"
          ? createRoomCode()
          : ""
        : kind === "signal-join"
          ? previousRoomCode
          : "";
    const state: RoomSetupState = {
      kind,
      visibility,
      publicSlot: 0,
      roomCode,
      roomUrl: this.buildRoomUrl(roomCode, map.id),
      signalingUrl: getSignalingServiceUrl(),
      publicRooms: previousPublicRooms,
      publicRoomsStatus: "",
      publicRoomsError: "",
      supportError: support.supported ? "" : support.reason,
      copyStatus: "",
      closedRoomMessage: "",
      autoEnterOnConnected: false,
      autoHostOnClosedJoin: false,
      linkJoin: false,
    };

    this.roomSetup = state;
    this.screen = "room";
    this.render();

    if (support.supported && kind === "signal-host" && visibility === "public") {
      void this.preparePublicHostRoom(state, map);
      return;
    }

    if (support.supported && kind !== "signal-join") {
      this.attachRoomConnection(
        state,
        this.createRoomConnection(kind, map, roomCode, state.visibility, state.publicSlot),
      );
      if (this.screen === "room") {
        this.render();
      }
    }
    if (kind === "signal-join") {
      void this.refreshPublicRooms();
    }
  }

  private selectRoomVisibility(visibility: CloudRoomVisibility): void {
    if (!this.roomSetup || this.roomSetup.kind !== "signal-host") {
      return;
    }

    if (this.roomSetup.visibility === visibility) {
      return;
    }

    const map = getMapById(this.activeMapId);
    this.roomSetup.connection?.dispose();
    this.roomSetup.unsubscribe?.();
    this.roomSetup.connection = undefined;
    this.roomSetup.unsubscribe = undefined;
    this.roomSetup.visibility = visibility;
    this.roomSetup.copyStatus = "";
    this.roomSetup.supportError = "";
    this.roomSetup.publicRoomsError = "";
    this.roomSetup.publicRoomsStatus = "";

    if (visibility === "public") {
      this.roomSetup.publicSlot = 0;
      this.roomSetup.roomCode = "";
      this.roomSetup.roomUrl = "";
      this.render();
      void this.preparePublicHostRoom(this.roomSetup, map);
      return;
    }

    const roomCode = createRoomCode();
    this.roomSetup.publicSlot = 0;
    this.roomSetup.roomCode = roomCode;
    this.roomSetup.roomUrl = this.buildRoomUrl(roomCode, map.id);
    this.attachRoomConnection(
      this.roomSetup,
      this.createRoomConnection("signal-host", map, roomCode, visibility, 0),
    );
    this.render();
  }

  private createRoomConnection(
    kind: RoomConnectionKind,
    map: MapDefinition,
    roomCode = "",
    visibility: CloudRoomVisibility = "private",
    publicSlot = 0,
  ): MatchRoomConnection | undefined {
    const preferredTeam = resolveTeamPreference(this.teamPreference, []);
    switch (kind) {
      case "signal-host": {
        const normalizedCode = normalizeRoomCode(roomCode || createRoomCode());
        return createSignaledHostMatchRoomConnection(
          buildSignaledRoomId(map.id, normalizedCode),
          map.id,
          this.operatorIdentity,
          NOOP_ROOM_HANDLERS,
          `${map.name} Host Room`,
          getSignalingServiceUrl(),
          normalizedCode,
          preferredTeam,
          visibility,
          map.name,
          publicSlot,
        );
      }
      case "signal-join": {
        const normalizedCode = normalizeRoomCode(roomCode);
        if (!normalizedCode) {
          return undefined;
        }

        return createSignaledJoinMatchRoomConnection(
          buildSignaledRoomId(map.id, normalizedCode),
          map.id,
          this.operatorIdentity,
          NOOP_ROOM_HANDLERS,
          getSignalingServiceUrl(),
          normalizedCode,
          preferredTeam,
        );
      }
      case "broadcast":
        return createBroadcastMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.operatorIdentity,
          NOOP_ROOM_HANDLERS,
          preferredTeam,
        );
      case "webrtc-host":
        return createHostMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.operatorIdentity,
          NOOP_ROOM_HANDLERS,
          `${map.name} Host Room`,
          preferredTeam,
        );
      case "webrtc-join":
        return createJoinMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.operatorIdentity,
          NOOP_ROOM_HANDLERS,
          preferredTeam,
        );
    }
  }

  private async preparePublicHostRoom(state: RoomSetupState, map: MapDefinition): Promise<void> {
    if (state.kind !== "signal-host" || state.visibility !== "public") {
      return;
    }

    state.publicRoomsStatus = "Selecting public server slot.";
    state.publicRoomsError = "";
    state.supportError = "";
    if (this.screen === "room" && this.roomSetup === state) {
      this.render();
    }

    try {
      const rooms = await fetchPublicRooms(state.signalingUrl, map.id);
      if (this.roomSetup !== state || state.kind !== "signal-host" || state.visibility !== "public") {
        return;
      }

      state.publicRooms = rooms;
      const slot = firstAvailablePublicRoomSlot(rooms);
      if (!slot) {
        state.publicRoomsStatus = "";
        state.supportError = "All public server slots for this map are occupied. Create a private room instead.";
        if (this.screen === "room") {
          this.render();
        }
        return;
      }

      state.publicSlot = slot.slot;
      state.roomCode = slot.code;
      state.roomUrl = this.buildRoomUrl(slot.code, map.id);
      state.publicRoomsStatus = `${publicRoomSlotLabel(slot.slot)} assigned as ${slot.code}.`;
      state.publicRoomsError = "";
      state.supportError = "";
      this.attachRoomConnection(
        state,
        this.createRoomConnection("signal-host", map, slot.code, "public", slot.slot),
      );
    } catch (error) {
      if (this.roomSetup !== state || state.kind !== "signal-host" || state.visibility !== "public") {
        return;
      }

      state.publicRoomsStatus = "";
      state.publicRoomsError =
        error instanceof Error ? error.message : "Could not select a public server slot.";
    }

    if (this.screen === "room" && this.roomSetup === state) {
      this.render();
    }
  }

  private attachRoomConnection(
    state: RoomSetupState,
    connection: MatchRoomConnection | undefined,
  ): void {
    this.clearClosedJoinTimer(state);
    state.unsubscribe?.();
    state.connection = connection;
    state.unsubscribe = connection?.subscribe(() => {
      this.handleRoomConnectionUpdate(state);
      if (this.screen === "room") {
        this.render();
      }
    });
    this.handleRoomConnectionUpdate(state);
  }

  private canEnterStage(): boolean {
    if (this.activeMode !== "shared") {
      return true;
    }

    if (!this.roomSetup?.connection) {
      return false;
    }

    if (this.roomSetup.connection.role === "host") {
      return this.roomSetup.connection.uiSnapshot.phase !== "error";
    }

    return this.roomSetup.connection.uiSnapshot.phase === "connected";
  }

  private async generateRoomOffer(): Promise<void> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-host") {
      return;
    }

    try {
      await (connection as HostMatchRoomConnection).createOfferCode();
      this.setRoomCopyStatus("Offer ready.");
    } catch (error) {
      this.setRoomSupportError(error);
    }
  }

  private connectSignalingRoom(
    roomCode?: string,
    options: { autoEnter?: boolean; linkJoin?: boolean } = {},
  ): void {
    if (!this.roomSetup || this.roomSetup.kind !== "signal-join") {
      return;
    }

    const field = this.root.querySelector<HTMLInputElement>('[data-room-field="room-code-input"]');
    const normalizedCode = normalizeRoomCode(roomCode ?? field?.value ?? "");
    if (!normalizedCode) {
      this.setRoomSupportError("Enter the host room code before joining.");
      return;
    }

    this.roomSetup.roomCode = normalizedCode;
    this.roomSetup.roomUrl = this.buildRoomUrl(normalizedCode, this.activeMapId);
    this.roomSetup.copyStatus = "";
    this.roomSetup.supportError = "";
    this.roomSetup.closedRoomMessage = "";
    this.roomSetup.autoEnterOnConnected = Boolean(options.autoEnter);
    this.roomSetup.autoHostOnClosedJoin = true;
    this.roomSetup.linkJoin = Boolean(options.linkJoin);
    this.roomSetup.connection?.dispose();
    this.attachRoomConnection(
      this.roomSetup,
      this.createRoomConnection("signal-join", getMapById(this.activeMapId), normalizedCode),
    );
    if (this.roomSetup.linkJoin) {
      this.scheduleClosedJoinTimer(this.roomSetup);
    }

    if (this.screen === "room") {
      this.render();
    }
  }

  private handleRoomConnectionUpdate(state: RoomSetupState): void {
    const phase = state.connection?.uiSnapshot.phase ?? "idle";
    const canAutoEnter =
      state.autoEnterOnConnected &&
      state.connection &&
      (phase === "connected" || (state.connection.role === "host" && phase !== "error"));

    if (canAutoEnter && this.screen === "room") {
      state.autoEnterOnConnected = false;
      state.autoHostOnClosedJoin = false;
      state.linkJoin = false;
      this.clearClosedJoinTimer(state);
      this.screen = "stage";
      this.render();
      return;
    }

    const detail = state.connection?.uiSnapshot.detail.toLowerCase() ?? "";
    if (
      state.autoHostOnClosedJoin &&
      state.kind === "signal-join" &&
      phase === "waiting" &&
      detail.includes("waiting for the host")
    ) {
      this.promoteClosedJoinToHost(state);
      return;
    }

    if (
      state.linkJoin &&
      state.autoHostOnClosedJoin &&
      state.kind === "signal-join" &&
      phase === "error"
    ) {
      this.promoteClosedJoinToHost(state);
    }
  }

  private scheduleClosedJoinTimer(state: RoomSetupState): void {
    this.clearClosedJoinTimer(state);
    if (typeof window === "undefined") {
      return;
    }

    state.closedJoinTimer = window.setTimeout(() => {
      if (this.roomSetup !== state || !state.autoHostOnClosedJoin || state.kind !== "signal-join") {
        return;
      }

      if (state.connection?.uiSnapshot.phase !== "connected") {
        this.promoteClosedJoinToHost(state);
      }
    }, 5_000);
  }

  private clearClosedJoinTimer(state: RoomSetupState): void {
    if (!state.closedJoinTimer || typeof window === "undefined") {
      return;
    }

    window.clearTimeout(state.closedJoinTimer);
    state.closedJoinTimer = undefined;
  }

  private promoteClosedJoinToHost(state: RoomSetupState): void {
    if (this.roomSetup !== state || state.kind !== "signal-join") {
      return;
    }

    const roomCode = normalizeRoomCode(
      state.roomCode || state.connection?.uiSnapshot.roomCode || "",
    );
    if (!roomCode) {
      this.setRoomSupportError("The closed room code was unavailable.");
      return;
    }

    const publicSlot = publicRoomSlotForCode(roomCode);
    const visibility: CloudRoomVisibility = publicSlot ? "public" : "private";
    const map = getMapById(this.activeMapId);

    this.clearClosedJoinTimer(state);
    state.linkJoin = false;
    state.autoHostOnClosedJoin = false;
    state.closedRoomMessage = "";
    state.supportError = "";
    state.copyStatus = "Closed room recovered. Hosting this room code.";
    state.connection?.dispose();
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.connection = undefined;
    state.kind = "signal-host";
    state.visibility = visibility;
    state.publicSlot = publicSlot?.slot ?? 0;
    state.roomCode = roomCode;
    state.roomUrl = this.buildRoomUrl(roomCode, map.id);
    state.autoEnterOnConnected = true;

    const attachHost = (): void => {
      if (this.roomSetup !== state || state.kind !== "signal-host") {
        return;
      }

      this.attachRoomConnection(
        state,
        this.createRoomConnection("signal-host", map, roomCode, visibility, state.publicSlot),
      );
      if (this.screen === "room") {
        this.render();
      }
    };

    if (typeof window === "undefined") {
      attachHost();
    } else {
      state.closedJoinTimer = window.setTimeout(() => {
        state.closedJoinTimer = undefined;
        attachHost();
      }, 180);
    }

    if (this.screen === "room") {
      this.render();
    }
  }

  private showJoinAnotherRoom(): void {
    this.disposeRoomSetup();
    this.activeMapId = getMapById(this.activeMapId).id;
    this.activeMode = "shared";
    this.screen = "room";
    this.selectRoomKind("signal-join");
  }

  private async refreshPublicRooms(): Promise<void> {
    if (!this.roomSetup) {
      return;
    }

    const state = this.roomSetup;
    state.publicRoomsStatus = "Checking public rooms.";
    state.publicRoomsError = "";
    if (this.screen === "room") {
      this.render();
    }

    try {
      const rooms = await fetchPublicRooms(state.signalingUrl, this.activeMapId);
      if (this.roomSetup !== state) {
        return;
      }

      state.publicRooms = rooms;
      state.publicRoomsStatus = rooms.length
        ? `${rooms.length} public room${rooms.length === 1 ? "" : "s"} found for this map.`
        : "No public rooms are open for this map.";
      state.publicRoomsError = "";
    } catch (error) {
      if (this.roomSetup !== state) {
        return;
      }

      state.publicRoomsStatus = "";
      state.publicRoomsError =
        error instanceof Error ? error.message : "Could not load public rooms.";
    }

    if (this.screen === "room") {
      this.render();
    }
  }

  private buildRoomUrl(roomCode: string, mapId: string): string {
    if (!roomCode || typeof window === "undefined") {
      return "";
    }

    const url = new URL(window.location.pathname || "/", window.location.origin);
    url.searchParams.set("room", normalizeRoomCode(roomCode));
    url.searchParams.set("map", mapId);
    url.hash = "";
    return url.toString();
  }

  private async applyRoomAnswer(): Promise<void> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-host") {
      return;
    }

    const field = this.root.querySelector<HTMLTextAreaElement>('[data-room-field="answer-input"]');
    const value = field?.value.trim() ?? "";
    if (!value) {
      this.setRoomSupportError("Paste a guest answer before applying it.");
      return;
    }

    try {
      await (connection as HostMatchRoomConnection).applyAnswerCode(value);
      this.setRoomCopyStatus("Answer applied.");
    } catch (error) {
      this.setRoomSupportError(error);
    }
  }

  private async generateRoomAnswer(): Promise<void> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-join") {
      return;
    }

    const field = this.root.querySelector<HTMLTextAreaElement>('[data-room-field="offer-input"]');
    const value = field?.value.trim() ?? "";
    if (!value) {
      this.setRoomSupportError("Paste a host offer before generating the answer.");
      return;
    }

    try {
      await (connection as JoinMatchRoomConnection).acceptOfferCode(value);
      this.setRoomCopyStatus("Answer generated.");
    } catch (error) {
      this.setRoomSupportError(error);
    }
  }

  private async copyRoomField(field: string | undefined): Promise<void> {
    if (!field) {
      return;
    }

    const node = this.root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-room-field="${field}"]`,
    );
    const value = node?.value.trim() ?? "";
    if (!value) {
      this.setRoomSupportError("Nothing is available to copy yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      this.setRoomCopyStatus("Copied to clipboard.");
    } catch {
      node?.select();
      this.setRoomCopyStatus("Clipboard access was blocked. The text is selected for manual copy.");
    }
  }

  private setRoomSupportError(error: unknown): void {
    if (!this.roomSetup) {
      return;
    }

    this.roomSetup.supportError =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unexpected room error.";
    this.roomSetup.closedRoomMessage = "";
    this.roomSetup.copyStatus = "";
    if (this.screen === "room") {
      this.render();
    }
  }

  private setRoomCopyStatus(message: string): void {
    if (!this.roomSetup) {
      return;
    }

    this.roomSetup.copyStatus = message;
    this.roomSetup.supportError = "";
    this.roomSetup.closedRoomMessage = "";
    if (this.screen === "room") {
      this.render();
      return;
    }

    if (this.screen === "stage") {
      this.syncRoomCopyStatus(message);
    }
  }

  private syncRoomCopyStatus(message: string): void {
    this.root.querySelectorAll<HTMLElement>('[data-ui="room-copy-status"]').forEach((node) => {
      node.textContent = message;
      node.hidden = message.length === 0;
    });
  }

  private disposeRoomSetup(): void {
    if (this.roomSetup) {
      this.clearClosedJoinTimer(this.roomSetup);
    }
    this.roomSetup?.unsubscribe?.();
    this.roomSetup?.connection?.dispose();
    this.roomSetup = undefined;
  }

  private handleRoomEnded(reason: string): void {
    const kind = this.roomSetup?.kind ?? "signal-join";
    this.teardownMatch();
    this.disposeRoomSetup();
    this.activeMode = "shared";
    this.screen = "room";
    this.selectRoomKind(kind);
    this.setRoomSupportError(reason);
  }

  private exitMatchFlow(screen: "menu" | "catalog"): void {
    this.teardownMatch();
    this.disposeRoomSetup();
    this.screen = screen;
    this.render();
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
    const map = getMapById(mapId);
    if (mode === "shared") {
      this.activeMapId = map.id;
      this.activeMode = "shared";
      const support = detectSharedRoomSupport("broadcast");
      if (!support.supported) {
        this.disposeRoomSetup();
        this.roomSetup = {
          kind: "broadcast",
          visibility: "public",
          publicSlot: 0,
          roomCode: "",
          roomUrl: "",
          signalingUrl: getSignalingServiceUrl(),
          publicRooms: [],
          publicRoomsStatus: "",
          publicRoomsError: "",
          supportError: support.reason,
          copyStatus: "",
          closedRoomMessage: "",
          autoEnterOnConnected: false,
          autoHostOnClosedJoin: false,
          linkJoin: false,
        };
      } else {
        this.selectRoomKind("broadcast");
      }
      this.screen = "stage";
      this.render();
      return;
    }

    this.openMapRoute(map, mode);
  }

  debugOpenRoomSetup(mapId: string, kind: RoomConnectionKind = "signal-join"): void {
    this.activeMapId = getMapById(mapId).id;
    this.activeMode = "shared";
    this.screen = "room";
    this.selectRoomKind(kind);
  }

  debugGetRoomCode(): string | null {
    return this.roomSetup?.roomCode || this.roomSetup?.connection?.uiSnapshot.roomCode || null;
  }

  debugJoinSignalingRoom(roomCode: string): boolean {
    if (this.roomSetup?.kind !== "signal-join") {
      return false;
    }

    this.connectSignalingRoom(roomCode);
    return Boolean(this.roomSetup.connection);
  }

  debugSendRawRoomMessage(raw: string, toPeerId?: string): boolean {
    return this.roomSetup?.connection?.debugSendRawRoomMessage?.(raw, toPeerId) ?? false;
  }

  debugConfigureLatestStateQa(
    direction: LatestStateQaDirection,
    config?: LatestStateQaConfig | null,
  ): boolean {
    return this.roomSetup?.connection?.debugConfigureLatestStateQa?.(direction, config) ?? false;
  }

  debugConfigureRelayIdleQa(config?: RelayIdleQaConfig | null): boolean {
    return this.roomSetup?.connection?.debugConfigureRelayIdleQa?.(config) ?? false;
  }

  debugSendSignalingPayload(payload: Record<string, unknown>): boolean {
    return this.roomSetup?.connection?.debugSendSignalingPayload?.(payload) ?? false;
  }

  debugInjectSignalingMessage(raw: string): boolean {
    return this.roomSetup?.connection?.debugInjectSignalingMessage?.(raw) ?? false;
  }

  async debugCreateRoomOffer(): Promise<string | null> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-host") {
      return null;
    }

    return (connection as HostMatchRoomConnection).createOfferCode();
  }

  async debugApplyRoomAnswer(answer: string): Promise<boolean> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-host") {
      return false;
    }

    await (connection as HostMatchRoomConnection).applyAnswerCode(answer);
    return true;
  }

  async debugGenerateRoomAnswer(offer: string): Promise<string | null> {
    const connection = this.roomSetup?.connection;
    if (!connection || connection.kind !== "webrtc-join") {
      return null;
    }

    return (connection as JoinMatchRoomConnection).acceptOfferCode(offer);
  }

  debugEnterArena(): boolean {
    if (!this.canEnterStage()) {
      return false;
    }

    this.screen = "stage";
    this.render();
    return true;
  }

  debugSetTeamPreference(teamPreference: TeamPreference): void {
    this.teamPreference = teamPreference;
    this.render();
  }

  debugSetBotDifficulty(botDifficulty: BotDifficulty): void {
    this.applyBotDifficulty(botDifficulty);
  }

  debugReturnToCatalog(): void {
    this.exitMatchFlow("catalog");
  }

  debugGetState(): Record<string, unknown> | null {
    const matchState = this.match?.debugSnapshot() ?? null;
    const roomSetupState = this.roomSetup
      ? {
          kind: this.roomSetup.kind,
          visibility: this.roomSetup.visibility,
          publicSlot: this.roomSetup.publicSlot,
          supportError: this.roomSetup.supportError,
          closedRoomMessage: this.roomSetup.closedRoomMessage,
          copyStatus: this.roomSetup.copyStatus,
          roomUrl: this.roomSetup.roomUrl,
          publicRooms: this.roomSetup.publicRooms,
          publicRoomsStatus: this.roomSetup.publicRoomsStatus,
          publicRoomsError: this.roomSetup.publicRoomsError,
          phase: this.roomSetup.connection?.uiSnapshot.phase ?? "idle",
          roomCode: this.roomSetup.connection?.uiSnapshot.roomCode ?? this.roomSetup.roomCode,
          connection: this.roomSetup.connection?.debugSnapshot() ?? null,
        }
      : null;

    return {
      screen: this.screen,
      activeMapId: this.activeMapId,
      activeMode: this.activeMode,
      teamPreference: this.teamPreference,
      classicCrouchAlias: this.classicCrouchAlias,
      botDifficulty: this.botDifficulty,
      availableBotDifficulties: [...BOT_DIFFICULTIES],
      roomSetup: roomSetupState,
      match: matchState,
      ...(matchState ?? {}),
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

  debugStageSharedRemotePose(peerId: string, x: number, y: number, z: number, yaw = 0): boolean {
    return this.match?.debugStageSharedRemotePose(peerId, x, y, z, yaw) ?? false;
  }

  debugStartSharedRemoteObjectiveAction(peerId: string): boolean {
    return this.match?.debugStartSharedRemoteObjectiveAction(peerId) ?? false;
  }

  debugCompleteSharedRemoteObjectiveAction(peerId: string): boolean {
    return this.match?.debugCompleteSharedRemoteObjectiveAction(peerId) ?? false;
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

  debugStageAuthoritativeSharedPair(kind: "clear" | "blocked"):
    | {
        host: { x: number; y: number; z: number };
        guest: { x: number; y: number; z: number };
        guestId: string;
      }
    | null {
    return this.match?.debugStageAuthoritativeSharedPair(kind) ?? null;
  }

  debugFire(): void {
    this.match?.debugFire();
  }

  debugForcePlayerDeath(attackerName?: string): void {
    this.match?.debugForcePlayerDeath(attackerName);
  }

  debugSetInputState(
    movementX: number,
    movementZ: number,
    crouching = false,
    jumpRequested = false,
  ): void {
    this.match?.debugSetInputState(movementX, movementZ, crouching, jumpRequested);
  }

  debugSetInputTickPaused(paused: boolean): void {
    this.match?.debugSetInputTickPaused(paused);
  }

  debugSendInputTick(
    movementX: number,
    movementZ: number,
    crouching = false,
    jumpRequested = false,
  ): boolean {
    return (
      this.match?.debugSendInputTick(movementX, movementZ, crouching, jumpRequested) ?? false
    );
  }

  debugSubmitShotClaim(overrides?: Parameters<LocalMatch["debugSubmitShotClaim"]>[0]): boolean {
    return this.match?.debugSubmitShotClaim(overrides) ?? false;
  }

  debugClearInputState(): void {
    this.match?.debugClearInputState();
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

  debugRequestEnemyJump(combatantId: string): boolean {
    return this.match?.debugRequestEnemyJump(combatantId) ?? false;
  }

  debugEnemyMovementSample(combatantId: string):
    | {
        standing: { distance: number; speed: number; eyeHeight: number; bodyHeight: number };
        crouched: { distance: number; speed: number; eyeHeight: number; bodyHeight: number };
        live: {
          crouchBlend: number;
          grounded: boolean;
          eyeHeight: number;
          bodyHeight: number;
          speed: number;
        };
        jump: {
          groundedStart: boolean;
          airborneObserved: boolean;
          peakFeetY: number;
          peakEyeY: number;
          landedFeetY: number;
          landedEyeY: number;
          landed: boolean;
          airborneSeconds: number;
        };
      }
    | null {
    return this.match?.debugEnemyMovementSample(combatantId) ?? null;
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

  debugStageAiSightlineCase(seedLastKnown = false):
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
    return this.match?.debugStageAiSightlineCase(seedLastKnown) ?? null;
  }

  debugStageAiCommunicationCase():
    | {
        observerEnemyId: string;
        receiverEnemyId: string;
        playerPosition: { x: number; y: number; z: number };
        observerPosition: { x: number; y: number; z: number };
        receiverPosition: { x: number; y: number; z: number };
        blockerName: string;
      }
    | null {
    return this.match?.debugStageAiCommunicationCase() ?? null;
  }

  debugStageAiRecoveryCase():
    | {
        enemyId: string;
        enemyLabel: string;
        blockerName: string;
        targetLabel: string;
        enemyPosition: { x: number; y: number; z: number };
        blockedTargetPosition: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageAiRecoveryCase() ?? null;
  }

  debugStageEnemyBombPlantCase():
    | {
        carrierEnemyId: string;
        siteLabel: string;
        sitePosition: { x: number; y: number; z: number };
      }
  | null {
    return this.match?.debugStageEnemyBombPlantCase() ?? null;
  }

  debugStageEnemyRelayRouteCase():
    | {
        carrierEnemyId: string;
        supportEnemyIds: string[];
        siteLabel: string;
        sitePosition: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageEnemyRelayRouteCase() ?? null;
  }

  debugStageEnemyObjectiveThreatCase():
    | {
        carrierEnemyId: string;
        carrierEnemyLabel: string;
        siteLabel: string;
        playerPosition: { x: number; y: number; z: number };
        carrierPosition: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageEnemyObjectiveThreatCase() ?? null;
  }

  debugStageEnemyRelayDefuseCase():
    | {
        defuserEnemyId: string;
        siteLabel: string;
        sitePosition: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageEnemyRelayDefuseCase() ?? null;
  }

  debugStageEnemyHostageEscortCase():
    | {
        rescuerEnemyId: string;
        supportEnemyIds: string[];
        clusterLabel: string;
        extractionLabel: string;
        routeLabels: string[];
        clusterPosition: { x: number; y: number; z: number };
        extractionPosition: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageEnemyHostageEscortCase() ?? null;
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

  private readRoomKind(value: string | undefined): RoomConnectionKind {
    if (
      value === "signal-host" ||
      value === "signal-join" ||
      value === "broadcast" ||
      value === "webrtc-host" ||
      value === "webrtc-join"
    ) {
      return value;
    }

    return "signal-join";
  }

  private readRoomVisibility(value: string | undefined): CloudRoomVisibility | undefined {
    if (value === "private" || value === "public") {
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
