import { featuredMap, getMapById, mapCatalog } from "../data/maps";
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
  type HostMatchRoomConnection,
  type JoinMatchRoomConnection,
  type MatchMode,
  type MatchRoomConnection,
  type RoomConnectionKind,
  type SharedRoomHandlers,
} from "../net/matchRoomConnection";
import { getSignalingServiceUrl } from "../net/signalingConfig";
import type { MapDefinition } from "../types";
import {
  renderCatalog,
  renderMapStage,
  renderMenu,
  renderRoomSetup,
  type RoomSetupRenderState,
} from "./templates";

type Screen = "menu" | "catalog" | "room" | "stage";

interface RoomSetupState {
  kind: RoomConnectionKind;
  roomCode: string;
  signalingUrl: string;
  connection?: MatchRoomConnection;
  supportError: string;
  copyStatus: string;
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

export class TacticalShellApp {
  private screen: Screen = "menu";
  private activeMapId = featuredMap.id;
  private activeMode: MatchMode = "shared";
  private roomSetup?: RoomSetupState;
  private match?: LocalMatch;
  private renderToken = 0;

  constructor(private readonly root: HTMLElement) {
    this.root.addEventListener("click", this.handleClick);
  }

  mount(): void {
    this.render();
  }

  dispose(): void {
    this.teardownMatch();
    this.disposeRoomSetup();
    this.root.removeEventListener("click", this.handleClick);
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const actionButton = target.closest<HTMLElement>("[data-action]");
    if (!actionButton) {
      return;
    }

    const action = actionButton.dataset.action;
    const mapId = actionButton.dataset.mapId;
    const mode = this.readMode(actionButton.dataset.mode);

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
      case "open-map":
      case "swap-map":
        this.openMapRoute(getMapById(mapId ?? featuredMap.id), mode ?? this.activeMode);
        return;
      case "select-room-kind":
        this.selectRoomKind(this.readRoomKind(actionButton.dataset.roomKind));
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

  private render(): void {
    const token = ++this.renderToken;
    this.teardownMatch();

    if (this.screen === "menu") {
      this.root.innerHTML = renderMenu(getMapById(this.activeMapId));
      return;
    }

    if (this.screen === "catalog") {
      this.root.innerHTML = renderCatalog(mapCatalog);
      return;
    }

    if (this.screen === "room") {
      this.root.innerHTML = renderRoomSetup(
        getMapById(this.activeMapId),
        this.currentRoomSetupRenderState(),
      );
      return;
    }

    const map = getMapById(this.activeMapId);
    this.root.innerHTML = renderMapStage(map, mapCatalog, this.activeMode);

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
        sharedRoom: this.activeMode === "shared" ? this.roomSetup?.connection : undefined,
        sharedRoomFallbackReason:
          this.activeMode === "shared" ? this.roomSetup?.supportError || undefined : undefined,
        onActionRequest: (action) => {
          if (token !== this.renderToken) {
            return;
          }

          this.exitMatchFlow(action === "catalog" ? "catalog" : "menu");
        },
        onRoomEnded: (reason) => {
          if (token !== this.renderToken || this.screen !== "stage") {
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
      .querySelectorAll<HTMLElement>(".match-hud, .hud-overlay")
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
      const node = this.root.querySelector<HTMLElement>(`[data-ui="${key}"]`);

      if (node) {
        node.textContent = value;
      }
    };

    setText("map-name", snapshot.mapName);
    setText("mode-notice", snapshot.modeNotice);
    setText("health", String(snapshot.health));
    setText("ammo", `${snapshot.ammoInClip} / ${snapshot.reserveAmmo}`);
    setText("firing-status", snapshot.firingStatus);
    setText("status", snapshot.statusLine);
    setText(
      "player-count",
      `${snapshot.playerCount} ${snapshot.playerCount === 1 ? "operator" : "operators"}`,
    );
    setText("prompt", snapshot.prompt);
    setText("death", snapshot.deathLine);

    const promptPanel = this.root.querySelector<HTMLElement>('[data-ui="prompt-panel"]');
    if (promptPanel) {
      promptPanel.hidden = snapshot.pointerLocked || snapshot.deathLine.length > 0;
    }

    const deathPanel = this.root.querySelector<HTMLElement>('[data-ui="death-panel"]');
    if (deathPanel) {
      deathPanel.hidden = snapshot.deathLine.length === 0;
    }

    const worldShell = this.root.querySelector<HTMLElement>("[data-world-shell]");
    if (worldShell) {
      worldShell.classList.toggle("world-stage__viewport--locked", snapshot.pointerLocked);
    }

    const hitIndicator = this.root.querySelector<HTMLElement>("[data-hit-indicator]");
    hitIndicator?.classList.toggle("hud-crosshair--hit", snapshot.hitActive);

    const damageOverlay = this.root.querySelector<HTMLElement>("[data-damage-overlay]");
    damageOverlay?.classList.toggle("hud-damage--active", snapshot.damageActive);

    const roster = this.root.querySelector<HTMLElement>('[data-ui="roster"]');
    if (roster) {
      roster.innerHTML = snapshot.roster
        .map((entry) => {
          const statusLabel =
            entry.status === "alive"
              ? "Alive"
              : entry.status === "respawning"
                ? "Respawning"
                : "Down";

          return `
            <div class="roster-row ${entry.local ? "roster-row--local" : ""}">
              <div>
                <strong>${this.escapeHtml(entry.name)}</strong>
                <span>${statusLabel}</span>
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
    this.selectRoomKind(this.roomSetup?.kind ?? "signal-host");
  }

  private selectRoomKind(kind: RoomConnectionKind): void {
    const map = getMapById(this.activeMapId);

    if (this.roomSetup?.kind === kind && this.roomSetup.connection) {
      this.screen = "room";
      this.render();
      return;
    }

    this.disposeRoomSetup();

    const support = detectSharedRoomSupport(kind);
    const roomCode = kind === "signal-host" ? createRoomCode() : "";
    const signalingUrl = getSignalingServiceUrl();
    const state: RoomSetupState = {
      kind,
      roomCode,
      signalingUrl,
      supportError: support.supported ? "" : support.reason,
      copyStatus: "",
    };

    if (support.supported && kind !== "signal-join") {
      this.attachRoomConnection(state, this.createRoomConnection(kind, map, roomCode));
    }

    this.roomSetup = state;

    if (this.screen !== "room") {
      this.screen = "room";
    }

    this.render();
  }

  private createRoomConnection(
    kind: RoomConnectionKind,
    map: MapDefinition,
    roomCode = "",
  ): MatchRoomConnection | undefined {
    switch (kind) {
      case "signal-host": {
        const normalizedCode = normalizeRoomCode(roomCode || createRoomCode());
        return createSignaledHostMatchRoomConnection(
          buildSignaledRoomId(map.id, normalizedCode),
          map.id,
          this.roomIdentity(),
          NOOP_ROOM_HANDLERS,
          `${map.name} Host Room`,
          getSignalingServiceUrl(),
          normalizedCode,
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
          this.roomIdentity(),
          NOOP_ROOM_HANDLERS,
          getSignalingServiceUrl(),
          normalizedCode,
        );
      }
      case "broadcast":
        return createBroadcastMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.roomIdentity(),
          NOOP_ROOM_HANDLERS,
        );
      case "webrtc-host":
        return createHostMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.roomIdentity(),
          NOOP_ROOM_HANDLERS,
          `${map.name} Host Room`,
        );
      case "webrtc-join":
        return createJoinMatchRoomConnection(
          buildRoomId(map.id),
          map.id,
          this.roomIdentity(),
          NOOP_ROOM_HANDLERS,
        );
      default:
        return undefined;
    }
  }

  private attachRoomConnection(
    state: RoomSetupState,
    connection: MatchRoomConnection | undefined,
  ): void {
    state.unsubscribe?.();
    state.connection = connection;
    state.unsubscribe = state.connection?.subscribe(() => {
      if (this.screen === "room") {
        this.render();
      }
    });
  }

  private roomIdentity() {
    return this.roomSetup?.connection?.identity ?? createRoomIdentity();
  }

  private currentRoomSetupRenderState(): RoomSetupRenderState {
    return {
      map: getMapById(this.activeMapId),
      selectedKind: this.roomSetup?.kind ?? "signal-host",
      supportError: this.roomSetup?.supportError ?? "",
      copyStatus: this.roomSetup?.copyStatus ?? "",
      roomCode: this.roomSetup?.roomCode ?? "",
      signalingUrl: this.roomSetup?.signalingUrl ?? getSignalingServiceUrl(),
      connection: this.roomSetup?.connection?.uiSnapshot,
      canEnterArena: this.canEnterStage(),
    };
  }

  private canEnterStage(): boolean {
    if (this.activeMode !== "shared") {
      return true;
    }

    if (!this.roomSetup?.connection) {
      return false;
    }

    if (this.roomSetup.kind === "broadcast") {
      return true;
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

  private connectSignalingRoom(roomCode?: string): void {
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
    this.roomSetup.copyStatus = "";
    this.roomSetup.supportError = "";
    this.roomSetup.connection?.dispose();
    this.attachRoomConnection(
      this.roomSetup,
      this.createRoomConnection("signal-join", getMapById(this.activeMapId), normalizedCode),
    );

    if (this.screen === "room") {
      this.render();
    }
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
      error instanceof Error ? error.message : typeof error === "string" ? error : "Unexpected room error.";
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
    if (this.screen === "room") {
      this.render();
    }
  }

  private disposeRoomSetup(): void {
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

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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
          roomCode: "",
          signalingUrl: getSignalingServiceUrl(),
          supportError: support.reason,
          copyStatus: "",
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

  debugOpenRoomSetup(mapId: string, kind: RoomConnectionKind = "signal-host"): void {
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

  debugReturnToCatalog(): void {
    this.exitMatchFlow("catalog");
  }

  debugGetState(): Record<string, unknown> | null {
    const matchState = this.match?.debugSnapshot() ?? null;
    const roomSetupState = this.roomSetup
      ? {
          kind: this.roomSetup.kind,
          supportError: this.roomSetup.supportError,
          copyStatus: this.roomSetup.copyStatus,
          phase: this.roomSetup.connection?.uiSnapshot.phase ?? "idle",
          connection: this.roomSetup.connection?.debugSnapshot() ?? null,
        }
      : null;

    return {
      screen: this.screen,
      activeMode: this.activeMode,
      roomSetup: roomSetupState,
      mapId:
        this.screen === "stage"
          ? ((matchState?.mapId as string | undefined) ?? null)
          : this.activeMapId,
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

  debugStageSharedDuel(slot: 0 | 1):
    | {
        self: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageSharedDuel(slot) ?? null;
  }

  debugFire(): void {
    this.match?.debugFire();
  }

  debugStageBlockedSharedShot(slot: 0 | 1):
    | {
        self: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      }
    | null {
    return this.match?.debugStageBlockedSharedShot(slot) ?? null;
  }

  debugStageAuthoritativeSharedPair(
    kind: "clear" | "blocked",
  ):
    | {
        host: { x: number; y: number; z: number };
        guest: { x: number; y: number; z: number };
        guestId: string;
      }
    | null {
    return this.match?.debugStageAuthoritativeSharedPair(kind) ?? null;
  }

  debugSubmitShotClaim(overrides?: {
    tick?: number;
    ammoInClip?: number;
    reserveAmmo?: number;
    reloadSequence?: number;
    spreadIndex?: number;
    inputSequence?: number;
    weaponId?: string;
    origin?: { x: number; y: number; z: number };
    direction?: { x: number; y: number; z: number };
  }): boolean {
    return this.match?.debugSubmitShotClaim(overrides) ?? false;
  }

  debugStartReload(): void {
    this.match?.debugStartReload();
  }

  debugForcePlayerDeath(attackerName?: string): void {
    this.match?.debugForcePlayerDeath(attackerName);
  }

  debugSetInputState(movementX: number, movementZ: number, sprint = false): void {
    this.match?.debugSetInputState(movementX, movementZ, sprint);
  }

  debugSendInputTick(movementX: number, movementZ: number, sprint = false): boolean {
    return this.match?.debugSendInputTick(movementX, movementZ, sprint) ?? false;
  }

  debugClearInputState(): void {
    this.match?.debugClearInputState();
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

    return "signal-host";
  }
}
