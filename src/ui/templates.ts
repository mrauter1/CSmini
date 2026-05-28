import { renderPreviewSvg } from "./previewSvg";
import type { MapDefinition } from "../types";
import type {
  MatchMode,
  RoomConnectionKind,
  RoomConnectionUiSnapshot,
} from "../net/matchRoomConnection";

export interface RoomSetupRenderState {
  map: MapDefinition;
  selectedKind: RoomConnectionKind;
  supportError: string;
  copyStatus: string;
  connection?: RoomConnectionUiSnapshot;
  canEnterArena: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mapCard(map: MapDefinition, index: number): string {
  return `
    <article class="map-card ${map.mainMap ? "map-card--featured" : ""}">
      <div class="map-card__topline">
        <p class="map-card__index">0${index + 1}</p>
        <div class="map-card__actions">
          ${map.mainMap ? '<span class="chip chip--primary">Primary Arena</span>' : ""}
          <button class="button button--tiny button--primary" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Multiplayer</button>
          <button class="button button--tiny" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo Drill</button>
        </div>
      </div>
      <div class="map-card__preview">
        ${renderPreviewSvg(map.preview)}
      </div>
      <h3>${escapeHtml(map.name)}</h3>
      <p class="map-card__summary">${escapeHtml(map.shortDescription)}</p>
      <dl class="meta-grid">
        <div>
          <dt>Theme</dt>
          <dd>${escapeHtml(map.visualTheme)}</dd>
        </div>
        <div>
          <dt>Spawns</dt>
          <dd>${escapeHtml(map.spawnSetup)}</dd>
        </div>
        <div>
          <dt>Cover</dt>
          <dd>${escapeHtml(map.cover)}</dd>
        </div>
        <div>
          <dt>Chokes</dt>
          <dd>${escapeHtml(map.chokePoints)}</dd>
        </div>
        <div>
          <dt>Landmark</dt>
          <dd>${escapeHtml(map.landmark)}</dd>
        </div>
      </dl>
    </article>
  `;
}

function mapRibbonButton(map: MapDefinition, activeMapId: string, mode: MatchMode): string {
  return `
    <button
      class="ribbon-map ${map.id === activeMapId ? "ribbon-map--active" : ""}"
      data-action="swap-map"
      data-map-id="${map.id}"
      data-mode="${mode}"
    >
      <span>${escapeHtml(map.name)}</span>
      <small>${mode === "shared" ? "Room" : map.mainMap ? "Primary" : "Solo"}</small>
    </button>
  `;
}

function controlHint(label: string, text: string): string {
  return `
    <div class="control-hint">
      <p>${escapeHtml(label)}</p>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function roomKindButton(
  selectedKind: RoomConnectionKind,
  kind: RoomConnectionKind,
  label: string,
  note: string,
): string {
  return `
    <button
      class="room-setup__tab ${selectedKind === kind ? "room-setup__tab--active" : ""}"
      data-action="select-room-kind"
      data-room-kind="${kind}"
    >
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(note)}</span>
    </button>
  `;
}

function renderRoomStatus(state: RoomSetupRenderState): string {
  const detail = state.connection?.detail ?? "Choose a transport to prepare the room.";
  const supportError = state.supportError
    ? `<p class="room-setup__status room-setup__status--error">${escapeHtml(state.supportError)}</p>`
    : "";
  const copyStatus = state.copyStatus
    ? `<p class="room-setup__status room-setup__status--success">${escapeHtml(state.copyStatus)}</p>`
    : "";

  return `
    <div class="room-setup__status-card panel">
      <div class="panel__header panel__header--compact">
        <p>Connection Status</p>
        <span class="chip">${escapeHtml(state.connection?.phase ?? "idle")}</span>
      </div>
      <p class="panel__text">${escapeHtml(detail)}</p>
      ${supportError}
      ${copyStatus}
    </div>
  `;
}

function renderBroadcastPanel(state: RoomSetupRenderState): string {
  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Same-Browser Dev Room</p>
        <span class="chip">Local Transport</span>
      </div>
      <p class="panel__text">
        This path keeps the old same-browser local transport available for development and quick smoke tests.
        Open the same map in another tab or window after entering the arena.
      </p>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="enter-room-stage">Enter Arena</button>
        <button class="button" data-action="show-catalog">Back to Roster</button>
      </div>
    </section>
  `;
}

function renderHostPanel(state: RoomSetupRenderState): string {
  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Host Flow</p>
        <span class="chip chip--primary">Offer / Answer</span>
      </div>
      <p class="panel__text">
        Generate the offer, send it to the joining player, paste their answer back here, then wait for the data channel to reach
        <strong>connected</strong>.
      </p>
      <label class="room-setup__field">
        <span>Host Offer</span>
        <textarea readonly data-room-field="offer-output">${escapeHtml(state.connection?.offerCode ?? "")}</textarea>
      </label>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="room-generate-offer">Generate Offer</button>
        <button class="button" data-action="room-copy" data-field="offer-output">Copy Offer</button>
      </div>
      <label class="room-setup__field">
        <span>Paste Guest Answer</span>
        <textarea data-room-field="answer-input" placeholder="Paste the answer blob from the joining browser."></textarea>
      </label>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="room-apply-answer">Apply Answer</button>
        <button class="button ${state.canEnterArena ? "button--primary" : ""}" data-action="enter-room-stage" ${state.canEnterArena ? "" : "disabled"}>Enter Arena</button>
      </div>
    </section>
  `;
}

function renderJoinPanel(state: RoomSetupRenderState): string {
  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Join Flow</p>
        <span class="chip chip--primary">Paste Offer</span>
      </div>
      <p class="panel__text">
        Paste the host offer, generate an answer, copy it back to the host, then wait here until the connection status turns
        <strong>connected</strong>.
      </p>
      <label class="room-setup__field">
        <span>Paste Host Offer</span>
        <textarea data-room-field="offer-input" placeholder="Paste the host offer blob here."></textarea>
      </label>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="room-generate-answer">Generate Answer</button>
      </div>
      <label class="room-setup__field">
        <span>Guest Answer</span>
        <textarea readonly data-room-field="answer-output">${escapeHtml(state.connection?.answerCode ?? "")}</textarea>
      </label>
      <div class="room-setup__actions">
        <button class="button" data-action="room-copy" data-field="answer-output">Copy Answer</button>
        <button class="button ${state.canEnterArena ? "button--primary" : ""}" data-action="enter-room-stage" ${state.canEnterArena ? "" : "disabled"}>Enter Arena</button>
      </div>
    </section>
  `;
}

function roomWorkflow(state: RoomSetupRenderState): string {
  switch (state.selectedKind) {
    case "broadcast":
      return renderBroadcastPanel(state);
    case "webrtc-host":
      return renderHostPanel(state);
    case "webrtc-join":
      return renderJoinPanel(state);
  }
}

export function renderMenu(map: MapDefinition): string {
  return `
    <section class="screen screen--menu">
      <header class="hero-panel">
        <p class="hero-panel__kicker">Browser Tactical Prototype</p>
        <h1>Dustline Protocol</h1>
        <p class="hero-panel__lede">
          Original early-2000s tactical FPS direction, rebuilt as a browser-native prototype with a five-map roster, a static-site-compatible multiplayer room flow, and a solo-drill fallback that stays playable without any backend.
        </p>
        <div class="hero-panel__actions">
          <button class="button button--primary" data-action="show-catalog">Open Map Roster</button>
          <button class="button" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Open Multiplayer Setup</button>
          <button class="button" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo ${escapeHtml(map.name)}</button>
        </div>
      </header>

      <div class="hero-grid">
        <section class="hero-grid__brief">
          <div class="brief-panel">
            <p class="brief-panel__label">Flow</p>
            <p>Menu → map select → host or join through manual signaling → exchange offer and answer blobs → enter the arena once the connection is live.</p>
          </div>
          <div class="brief-panel">
            <p class="brief-panel__label">Featured Arena</p>
            <h2>${escapeHtml(map.name)}</h2>
            <p>${escapeHtml(map.tacticalSummary)}</p>
            <p class="brief-panel__note">${escapeHtml(map.landmark)}</p>
          </div>
        </section>

        <section class="hero-grid__preview panel">
          <div class="panel__header">
            <p>Map Preview</p>
            <span class="chip chip--primary">Main Compound</span>
          </div>
          ${renderPreviewSvg(map.preview)}
        </section>
      </div>
    </section>
  `;
}

export function renderCatalog(maps: MapDefinition[]): string {
  return `
    <section class="screen screen--catalog">
      <header class="masthead panel">
        <div>
          <p class="masthead__eyebrow">Map Select</p>
          <h1>Original Tactical Arenas</h1>
          <p>
            Every entry includes a theme, spawn setup, cover language, choke-point summary, a distinctive landmark, and a top-down preview. Multiplayer now runs through a dedicated room setup step so the same static site can host local dev rooms or manual WebRTC browser links.
          </p>
        </div>
        <div class="masthead__actions">
          <button class="button" data-action="show-menu">Back to Briefing</button>
          <button class="button button--primary" data-action="open-map" data-mode="shared" data-map-id="${maps[0]?.id ?? ""}">Open Multiplayer Setup</button>
          <button class="button" data-action="open-map" data-mode="local" data-map-id="${maps[0]?.id ?? ""}">Open Solo Drill</button>
        </div>
      </header>

      <div class="map-grid">
        ${maps.map(mapCard).join("")}
      </div>
    </section>
  `;
}

export function renderRoomSetup(map: MapDefinition, state: RoomSetupRenderState): string {
  return `
    <section class="screen screen--room-setup">
      <div class="room-setup">
        <header class="masthead panel">
          <div>
            <p class="masthead__eyebrow">Room Setup</p>
            <h1>${escapeHtml(map.name)}</h1>
            <p>
              Manual signaling keeps the project static-site-compatible: one browser can host, another browser can join, and the offer and answer blobs are exchanged directly without an account or always-on server.
            </p>
          </div>
          <div class="masthead__actions">
            <button class="button" data-action="show-catalog">Back to Roster</button>
            <button class="button" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo Drill Instead</button>
          </div>
        </header>

        <div class="room-setup__grid">
          <section class="room-setup__brief panel">
            <div class="panel__header">
              <p>Transport Options</p>
              <span class="chip">${escapeHtml(state.selectedKind)}</span>
            </div>
            <div class="room-setup__tabs">
              ${roomKindButton(state.selectedKind, "webrtc-host", "Host via WebRTC", "Generate the offer and accept one guest answer.")}
              ${roomKindButton(state.selectedKind, "webrtc-join", "Join via WebRTC", "Paste an offer and produce the answer blob.")}
              ${roomKindButton(state.selectedKind, "broadcast", "Same-Browser Dev Room", "Keep the old local room transport for tab-to-tab testing.")}
            </div>
            <div class="room-setup__preview">
              ${renderPreviewSvg(map.preview)}
            </div>
          </section>

          <div class="room-setup__workflow-stack">
            ${renderRoomStatus(state)}
            ${roomWorkflow(state)}
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderMapStage(map: MapDefinition, maps: MapDefinition[], mode: MatchMode): string {
  const modeEyebrow = mode === "shared" ? "Multiplayer Arena" : "Solo Drill";
  const modeNotice =
    mode === "shared"
      ? `Multiplayer room armed for ${escapeHtml(map.name)}. The host or join flow must already be connected before the arena begins.`
      : "Local fallback mode: solo skirmish with procedural audio and lightweight hostile operators.";
  const switchModeLabel = mode === "shared" ? "Switch to Solo Drill" : "Open Multiplayer Setup";
  const switchMode = mode === "shared" ? "local" : "shared";

  return `
    <section class="screen screen--match">
      <div class="match-frame">
        <div class="world-stage world-stage--match panel">
          <div class="world-stage__viewport world-stage__viewport--match" data-world-shell>
            <div class="world-stage__match-host" data-world-host></div>

            <div class="match-hud">
              <div class="hud-card hud-card--map">
                <p class="hud-label">Map</p>
                <h1 class="hud-map" data-ui="map-name">${escapeHtml(map.name)}</h1>
                <p class="hud-note" data-ui="mode-notice">
                  ${modeNotice}
                </p>
              </div>

              <div class="hud-card hud-card--stats">
                <div class="hud-stat">
                  <span>Health</span>
                  <strong data-ui="health">100</strong>
                </div>
                <div class="hud-stat">
                  <span>Ammo</span>
                  <strong data-ui="ammo">24 / 120</strong>
                </div>
                <div class="hud-stat">
                  <span>Status</span>
                  <strong data-ui="firing-status">Ready</strong>
                </div>
              </div>

              <div class="hud-card hud-card--roster">
                <div class="panel__header panel__header--compact">
                  <p>Roster</p>
                  <span class="chip" data-ui="player-count">4 operators</span>
                </div>
                <div class="hud-roster" data-ui="roster"></div>
              </div>

              <div class="hud-card hud-card--status">
                <p class="hud-label">Status Feed</p>
                <p data-ui="status">Solo skirmish active.</p>
              </div>

              <div class="hud-crosshair" data-hit-indicator>
                <span class="hud-crosshair__h"></span>
                <span class="hud-crosshair__v"></span>
                <span class="hud-crosshair__dot"></span>
              </div>

              <div class="hud-damage" data-damage-overlay></div>

              <div class="hud-overlay" data-ui="prompt-panel">
                <p class="hud-label">Deploy Controls</p>
                <h2>Pointer Lock Ready</h2>
                <p data-ui="prompt">
                  Click the viewport to lock the mouse. WASD moves, Shift sprints, left click or Space fires, R reloads, and M reopens map select.
                </p>
                <div class="hud-overlay__actions">
                  <button class="button button--primary" data-action="lock-match">Lock Controls</button>
                  <button class="button" data-action="open-map" data-mode="${switchMode}" data-map-id="${map.id}">${switchModeLabel}</button>
                  <button class="button" data-action="show-catalog">Map Roster</button>
                </div>
              </div>

              <div class="hud-overlay hud-overlay--death" data-ui="death-panel" hidden>
                <p class="hud-label">Operator Down</p>
                <h2 data-ui="death">Respawn in 3.2s</h2>
                <p>Wait for reinsertion or press <strong>M</strong> to reopen the roster.</p>
              </div>
            </div>
          </div>
        </div>

        <div class="match-console panel">
          <div class="match-console__copy">
            <p class="masthead__eyebrow">${modeEyebrow}</p>
            <h2>${escapeHtml(map.shortDescription)}</h2>
            <p class="panel__text">${escapeHtml(map.tacticalSummary)}</p>
          </div>
          <div class="match-console__actions">
            <button class="button" data-action="show-catalog">Change Map</button>
            <button class="button" data-action="open-map" data-mode="${switchMode}" data-map-id="${map.id}">${switchModeLabel}</button>
            <button class="button button--primary" data-action="show-menu">Return to Briefing</button>
          </div>
          <div class="control-grid">
            ${controlHint("Move", "WASD + Shift")}
            ${controlHint("Look", "Pointer lock or fallback")}
            ${controlHint("Shoot", "Left click or Space")}
            ${controlHint("Reload", "R")}
            ${controlHint("Map Select", "M or button")}
            ${controlHint("Mode", mode === "shared" ? "Connected room" : "Local fallback")}
            ${controlHint("HUD", "HP, ammo, roster, hit cue")}
          </div>
        </div>

        <div class="map-ribbon panel">
          <div class="panel__header">
            <p>Quick Deploy</p>
            <span class="chip">${mode === "shared" ? "Multiplayer" : "Solo Drill"}</span>
          </div>
          <div class="map-ribbon__list">
            ${maps.map((entry) => mapRibbonButton(entry, map.id, mode)).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}
