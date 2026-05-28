import { featuredMap, getMapById, mapCatalog } from "../data/maps";
import type { MapDefinition } from "../types";
import type { LocalMatch, LocalMatchSnapshot } from "../game/localMatch";
import type { MatchMode } from "../game/multiplayerRoom";
import { renderCatalog, renderMapStage, renderMenu } from "./templates";

type Screen = "menu" | "catalog" | "stage";

export class TacticalShellApp {
  private screen: Screen = "menu";
  private activeMapId = featuredMap.id;
  private activeMode: MatchMode = "shared";
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
    this.root.removeEventListener("click", this.handleClick);
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

  private escapeHtml(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  debugOpenMap(mapId: string, mode: MatchMode): void {
    this.activeMapId = getMapById(mapId).id;
    this.activeMode = mode;
    this.screen = "stage";
    this.render();
  }

  debugReturnToCatalog(): void {
    this.screen = "catalog";
    this.render();
  }

  debugGetState(): Record<string, unknown> | null {
    return this.match?.debugSnapshot() ?? null;
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

  debugForcePlayerDeath(attackerName?: string): void {
    this.match?.debugForcePlayerDeath(attackerName);
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
}
