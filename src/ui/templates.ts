import {
  BOT_DIFFICULTIES,
  botDifficultyLabel,
  type BotDifficulty,
} from "../game/botDifficulty";
import { missionBadges } from "../game/missions";
import type {
  CloudRoomVisibility,
  MatchMode,
  RoomConnectionKind,
  RoomConnectionUiSnapshot,
} from "../net/matchRoomConnection";
import type { PublicRoomSummary } from "../net/publicRooms";
import { TEAM_ORDER, getTeamDefinition, teamPreferenceLabel } from "../game/teams";
import { crouchControlLabel } from "../game/controls";
import type { MapDefinition, TeamPreference } from "../types";
import { renderPreviewSvg } from "./previewSvg";

export interface RoomSetupRenderState {
  map: MapDefinition;
  selectedKind: RoomConnectionKind;
  visibility: CloudRoomVisibility;
  supportError: string;
  copyStatus: string;
  roomCode: string;
  roomUrl: string;
  signalingUrl: string;
  publicRooms: PublicRoomSummary[];
  publicRoomsStatus: string;
  publicRoomsError: string;
  connection?: RoomConnectionUiSnapshot;
  canEnterArena: boolean;
  teamLabel: string;
  operatorName: string;
  entryHint: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function missionChip(label: string): string {
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

function teamPreferenceButton(preference: TeamPreference, activePreference: TeamPreference): string {
  const team = preference === "auto" ? null : getTeamDefinition(preference);

  return `
    <button
      class="team-pick ${activePreference === preference ? "team-pick--active" : ""}"
      data-action="set-team"
      data-team="${preference}"
      ${team ? `data-team-tone="${team.id}"` : ""}
    >
      <strong>${escapeHtml(teamPreferenceLabel(preference))}</strong>
      <span>${escapeHtml(team ? team.summary : "Balance the room automatically or default to Amber Vanguard in solo play.")}</span>
    </button>
  `;
}

function renderTeamPicker(teamPreference: TeamPreference): string {
  return `
    <section class="team-panel panel">
      <div class="panel__header">
        <p>Round Entry</p>
        <span class="chip chip--primary">${escapeHtml(teamPreferenceLabel(teamPreference))}</span>
      </div>
      <h2>Choose Your Team</h2>
      <p class="panel__text">
        Team selection is locked in before the round loads. Pick a side directly or keep the room on explicit auto-assignment.
      </p>
      <div class="team-picks">
        ${teamPreferenceButton("auto", teamPreference)}
        ${TEAM_ORDER.map((teamId) => teamPreferenceButton(teamId, teamPreference)).join("")}
      </div>
    </section>
  `;
}

function botDifficultyButton(
  difficulty: BotDifficulty,
  activeDifficulty: BotDifficulty,
  compact = false,
): string {
  return `
    <button
      class="difficulty-pick ${activeDifficulty === difficulty ? "difficulty-pick--active" : ""}"
      data-action="set-bot-difficulty"
      data-bot-difficulty="${difficulty}"
      aria-pressed="${activeDifficulty === difficulty}"
    >
      <strong>${escapeHtml(botDifficultyLabel(difficulty))}</strong>
      ${
        compact
          ? ""
          : `<span>${escapeHtml(
              difficulty === "medium"
                ? "Default solo fireteam level."
                : "Stored for solo rounds in this browser.",
            )}</span>`
      }
    </button>
  `;
}

function renderBotDifficultyControls(
  activeDifficulty: BotDifficulty,
  note: string,
  compact = false,
): string {
  return `
    <section class="${compact ? "difficulty-strip" : "difficulty-panel panel"}">
      <div class="panel__header ${compact ? "panel__header--compact" : ""}">
        <p>Solo Fireteam</p>
        <span class="chip chip--primary" data-ui="bot-difficulty-current">${escapeHtml(botDifficultyLabel(activeDifficulty))}</span>
      </div>
      ${
        compact
          ? ""
          : `<h2>Set Bot Difficulty</h2>`
      }
      <p class="${compact ? "difficulty-strip__note" : "panel__text"}" data-ui="bot-difficulty-note">${escapeHtml(note)}</p>
      <div class="difficulty-picks">
        ${BOT_DIFFICULTIES.map((difficulty) => botDifficultyButton(difficulty, activeDifficulty, compact)).join("")}
      </div>
    </section>
  `;
}

function mapCard(map: MapDefinition, index: number): string {
  const missionLabels = missionBadges(map);
  const routeLabels = map.tacticalRoutes.map((route) => route.name).join(" / ");

  return `
    <article class="map-card ${map.mainMap ? "map-card--featured" : ""}">
      <div class="map-card__topline">
        <p class="map-card__index">0${index + 1}</p>
        <div class="map-card__actions">
          ${map.mainMap ? '<span class="chip chip--primary">Primary Arena</span>' : ""}
          <button class="button button--tiny button--primary" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Open Room Setup</button>
          <button class="button button--tiny" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo Round</button>
        </div>
      </div>
      <div class="map-card__preview">
        ${renderPreviewSvg(map.preview)}
      </div>
      <h3>${escapeHtml(map.name)}</h3>
      <p class="map-card__summary">${escapeHtml(map.shortDescription)}</p>
      <div class="map-card__chips">
        ${missionLabels.map(missionChip).join("")}
      </div>
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
          <dt>Routes</dt>
          <dd>${escapeHtml(routeLabels)}</dd>
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

function controlHint(label: string, text: string, dataUi?: string): string {
  return `
    <div class="control-hint" ${dataUi ? `data-ui="${dataUi}"` : ""}>
      <p>${escapeHtml(label)}</p>
      <span>${escapeHtml(text)}</span>
    </div>
  `;
}

function roomKindLabel(kind: RoomConnectionKind): string {
  switch (kind) {
    case "signal-host":
      return "Create Cloud Room";
    case "signal-join":
      return "Join Cloud Room";
    case "broadcast":
      return "Same-Browser Dev Room";
    case "webrtc-host":
      return "Manual Host";
    case "webrtc-join":
      return "Manual Join";
  }
}

function roomVisibilityButton(
  activeVisibility: CloudRoomVisibility,
  visibility: CloudRoomVisibility,
  label: string,
  note: string,
): string {
  return `
    <button
      class="room-setup__tab ${activeVisibility === visibility ? "room-setup__tab--active" : ""}"
      data-action="set-room-visibility"
      data-room-visibility="${visibility}"
    >
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(note)}</span>
    </button>
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

function roomEntryButton(state: RoomSetupRenderState): string {
  return `
    <button
      class="button ${state.canEnterArena ? "button--primary" : ""}"
      data-action="enter-room-stage"
      ${state.canEnterArena ? "" : "disabled"}
    >
      ${state.canEnterArena ? "Enter Arena" : "Arena Sync Pending"}
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
  const entryHint = state.entryHint
    ? `<p class="room-setup__status room-setup__status--note">${escapeHtml(state.entryHint)}</p>`
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
      ${entryHint}
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
        This keeps the original tab-to-tab development room available for quick smoke checks and local multiplayer iteration on one machine.
      </p>
      <div class="room-setup__actions">
        ${roomEntryButton(state)}
        <button class="button" data-action="show-catalog">Back to Roster</button>
      </div>
    </section>
  `;
}

function renderSignalHostPanel(state: RoomSetupRenderState): string {
  const roomCode = state.connection?.roomCode ?? state.roomCode;
  const roomUrl = state.roomUrl;

  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Create Cloud Room</p>
        <span class="chip chip--primary">${state.visibility === "public" ? "Public" : "Private"}</span>
      </div>
      <p class="panel__text">
        Private rooms are shared by code or URL. Public rooms also appear in the open room list while this host tab remains online.
      </p>
      <div class="room-setup__visibility">
        ${roomVisibilityButton(state.visibility, "private", "Private Room", "Share only by code or URL.")}
        ${roomVisibilityButton(state.visibility, "public", "Public Room", "Show this map room in the public list.")}
      </div>
      <label class="room-setup__field">
        <span>Room Code</span>
        <input readonly data-room-field="room-code-output" value="${escapeHtml(roomCode)}" />
      </label>
      <label class="room-setup__field">
        <span>Invite URL</span>
        <input readonly data-room-field="room-url-output" value="${escapeHtml(roomUrl)}" />
      </label>
      <p class="room-setup__endpoint">${escapeHtml(state.signalingUrl)}</p>
      <div class="room-setup__actions">
        <button class="button" data-action="room-copy" data-field="room-code-output">Copy Code</button>
        <button class="button" data-action="room-copy" data-field="room-url-output">Copy URL</button>
        ${roomEntryButton(state)}
      </div>
    </section>
  `;
}

function renderSignalJoinPanel(state: RoomSetupRenderState): string {
  const publicRoomStatus = state.publicRoomsStatus
    ? `<p class="room-setup__status room-setup__status--note">${escapeHtml(state.publicRoomsStatus)}</p>`
    : "";
  const publicRoomError = state.publicRoomsError
    ? `<p class="room-setup__status room-setup__status--error">${escapeHtml(state.publicRoomsError)}</p>`
    : "";
  const publicRooms = state.publicRooms.length
    ? state.publicRooms.map(publicRoomRow).join("")
    : `<p class="room-setup__empty">No open public rooms for this map.</p>`;

  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Join Cloud Room</p>
        <span class="chip chip--primary">Code Or URL</span>
      </div>
      <p class="panel__text">
        Enter a private room code, open an invite URL, or choose a public room for this map.
      </p>
      <label class="room-setup__field">
        <span>Host Room Code</span>
        <input data-room-field="room-code-input" value="${escapeHtml(state.roomCode)}" placeholder="ABC123" />
      </label>
      <p class="room-setup__endpoint">${escapeHtml(state.signalingUrl)}</p>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="room-connect-signaling">Join Room</button>
        ${roomEntryButton(state)}
      </div>
      <div class="room-setup__public">
        <div class="panel__header panel__header--compact">
          <p>Public Rooms</p>
          <button class="button button--tiny" data-action="room-refresh-public">Refresh</button>
        </div>
        ${publicRoomStatus}
        ${publicRoomError}
        <div class="room-setup__public-list">
          ${publicRooms}
        </div>
      </div>
    </section>
  `;
}

function publicRoomRow(room: PublicRoomSummary): string {
  const slots = `${room.participantCount}/${room.maxPeers}`;
  return `
    <button
      class="room-setup__public-room"
      data-action="room-join-public"
      data-room-code="${escapeHtml(room.roomCode)}"
    >
      <span class="room-setup__public-accent" style="background:${escapeHtml(room.hostAccentColor)}"></span>
      <strong>${escapeHtml(room.hostName)}</strong>
      <small>${escapeHtml(room.roomCode)} · ${escapeHtml(slots)}</small>
    </button>
  `;
}

function renderManualHostPanel(state: RoomSetupRenderState): string {
  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Manual Host Flow</p>
        <span class="chip chip--primary">Offer / Answer</span>
      </div>
      <p class="panel__text">
        Generate the host offer, send it to the guest, paste the guest answer back here, and wait for the transport to report <strong>connected</strong>.
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
        <textarea data-room-field="answer-input" placeholder="Paste the guest answer blob here."></textarea>
      </label>
      <div class="room-setup__actions">
        <button class="button button--primary" data-action="room-apply-answer">Apply Answer</button>
        ${roomEntryButton(state)}
      </div>
    </section>
  `;
}

function renderManualJoinPanel(state: RoomSetupRenderState): string {
  return `
    <section class="room-setup__workflow panel">
      <div class="panel__header">
        <p>Manual Join Flow</p>
        <span class="chip chip--primary">Paste Offer</span>
      </div>
      <p class="panel__text">
        Paste the host offer, generate the guest answer, and send the answer back to the host. The room will report <strong>connected</strong> once the browser-to-browser path is live.
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
        ${roomEntryButton(state)}
      </div>
    </section>
  `;
}

function roomWorkflow(state: RoomSetupRenderState): string {
  switch (state.selectedKind) {
    case "signal-host":
      return renderSignalHostPanel(state);
    case "signal-join":
      return renderSignalJoinPanel(state);
    case "broadcast":
      return renderBroadcastPanel(state);
    case "webrtc-host":
      return renderManualHostPanel(state);
    case "webrtc-join":
      return renderManualJoinPanel(state);
  }
}

export function renderMenu(
  map: MapDefinition,
  teamPreference: TeamPreference,
  botDifficulty: BotDifficulty,
): string {
  const missionLabels = missionBadges(map);

  return `
    <section class="screen screen--menu">
      <header class="hero-panel">
        <p class="hero-panel__kicker">Browser Tactical Prototype</p>
        <h1>Dustline Protocol</h1>
        <p class="hero-panel__lede">
          Original early-2000s tactical FPS direction, rebuilt as a browser-native prototype with round timers, two original teams, mission-ready map metadata, and Cloud Room signaling.
        </p>
        <div class="hero-panel__actions">
          <button class="button button--primary" data-action="show-catalog">Open Map Roster</button>
          <button class="button" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Open ${escapeHtml(map.name)} Room Setup</button>
          <button class="button" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo ${escapeHtml(map.name)}</button>
        </div>
      </header>

      <div class="hero-grid">
        <section class="hero-grid__brief">
          <div class="brief-panel">
            <p class="brief-panel__label">Flow</p>
            <p>Choose a team, set the solo fireteam level, then either open Cloud Room setup or drop straight into a solo round.</p>
          </div>
          <div class="brief-panel">
            <p class="brief-panel__label">Featured Arena</p>
            <h2>${escapeHtml(map.name)}</h2>
            <p>${escapeHtml(map.tacticalSummary)}</p>
            <p class="brief-panel__note">${missionLabels.map(missionChip).join("")}</p>
          </div>
          ${renderTeamPicker(teamPreference)}
          ${renderBotDifficultyControls(
            botDifficulty,
            "Best-effort saved in this browser. Applies to solo rounds only. Shared Room stays human-only across tabs.",
          )}
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

export function renderCatalog(
  maps: MapDefinition[],
  teamPreference: TeamPreference,
  botDifficulty: BotDifficulty,
): string {
  return `
    <section class="screen screen--catalog">
      <header class="masthead panel">
        <div>
          <p class="masthead__eyebrow">Map Select</p>
          <h1>Original Tactical Arenas</h1>
          <p>
            Every entry now declares team spawns, tactical routes, and live mission metadata for both relay-charge and evac-escort round shells. Multiplayer now routes through a dedicated Cloud Room setup step with private rooms, public listings, and invite URLs.
          </p>
        </div>
        <div class="masthead__actions">
          <button class="button" data-action="show-menu">Back to Briefing</button>
          <button class="button button--primary" data-action="open-map" data-mode="shared" data-map-id="${maps[0]?.id ?? ""}">Open Featured Room Setup</button>
          <button class="button" data-action="open-map" data-mode="local" data-map-id="${maps[0]?.id ?? ""}">Open Solo Round</button>
        </div>
      </header>

      ${renderTeamPicker(teamPreference)}
      ${renderBotDifficultyControls(
        botDifficulty,
        "Best-effort saved in this browser. Applies to solo rounds only. Shared Room stays human-only across tabs.",
      )}

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
              The selected map, team entry, and operator identity carry into this setup flow. Cloud signaling stays signaling-only while gameplay runs browser-to-browser over WebRTC.
            </p>
          </div>
          <div class="masthead__actions">
            <button class="button" data-action="show-catalog">Back to Roster</button>
            <button class="button" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo Round Instead</button>
          </div>
        </header>

        <div class="room-setup__grid">
          <section class="room-setup__brief panel">
            <div class="panel__header">
              <p>Transport Options</p>
              <span class="chip chip--primary">${escapeHtml(roomKindLabel(state.selectedKind))}</span>
            </div>
            <p class="panel__text">
              The current solo difficulty stays browser-saved for solo rounds only. Shared multiplayer remains human-only, and this setup keeps the canonical control scheme intact.
            </p>
            <div class="room-setup__identity">
              <div class="room-setup__identity-card">
                <p>Selected Side</p>
                <strong>${escapeHtml(state.teamLabel)}</strong>
              </div>
              <div class="room-setup__identity-card">
                <p>Operator</p>
                <strong>${escapeHtml(state.operatorName)}</strong>
              </div>
            </div>
            <div class="room-setup__tabs">
              ${roomKindButton(state.selectedKind, "signal-host", "Create Room", "Host a private or public Cloud Room.")}
              ${roomKindButton(state.selectedKind, "signal-join", "Join Room", "Use a room code, invite URL, or public list.")}
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

export function renderMapStage(
  map: MapDefinition,
  maps: MapDefinition[],
  mode: MatchMode,
  teamPreference: TeamPreference,
  classicCrouchAlias: boolean,
  botDifficulty: BotDifficulty,
): string {
  const modeEyebrow = mode === "shared" ? "Shared Room Sync" : "Solo Round";
  const switchModeLabel = mode === "shared" ? "Switch to Solo Round" : "Open Room Setup";
  const switchMode = mode === "shared" ? "local" : "shared";
  const crouchLabel = crouchControlLabel(classicCrouchAlias);
  const botDifficultyNote =
    mode === "local"
      ? "Applies to this solo-local fireteam only."
      : "Stored for solo rounds only. Shared Room stays human-only across tabs.";

  return `
    <section class="screen screen--match">
      <div class="match-frame">
        <div class="world-stage world-stage--match panel">
          <div class="world-stage__viewport world-stage__viewport--match" data-world-shell>
            <div class="world-stage__match-host" data-world-host></div>

            <div class="match-hud">
              <div class="hud-round-strip" aria-live="polite">
                <span data-ui="round-number">Round 1</span>
                <strong data-ui="round-timer">00:00</strong>
                <span data-ui="round-phase">Briefing</span>
                <small><span data-ui="mission-label">Relay Charge</span> / <span data-ui="objective-label">Objective</span></small>
              </div>

              <button
                class="hud-fullscreen-toggle"
                type="button"
                data-action="toggle-fullscreen"
                data-ui="fullscreen-toggle"
                aria-label="Enter viewport fullscreen"
                title="Enter viewport fullscreen"
              >
                <span class="hud-fullscreen-icon" aria-hidden="true"></span>
              </button>

              <div class="hud-vital hud-vital--health">
                <span>Health</span>
                <strong data-ui="health">100</strong>
                <small><span data-ui="team-name">${escapeHtml(teamPreferenceLabel(teamPreference))}</span> / <span data-ui="alive-state">Alive</span></small>
              </div>

              <div class="hud-vital hud-vital--ammo">
                <span>Ammo</span>
                <strong data-ui="ammo">24 / 120</strong>
                <small data-ui="firing-status">Hold</small>
              </div>

              <div class="hud-status-line" data-ui="status">Round feed pending.</div>

              <div class="hud-crosshair" data-hit-indicator>
                <span class="hud-crosshair__h"></span>
                <span class="hud-crosshair__v"></span>
                <span class="hud-crosshair__dot"></span>
              </div>

              <div class="hud-damage" data-damage-overlay></div>

              <div class="hud-hint" data-ui="prompt-panel">
                <p data-ui="prompt">
                  Click viewport or lock controls. WASD move, ${escapeHtml(crouchLabel)} crouch, Space jump, E objective, Mouse1 fire, R reload, M map, hold Tab info, Alt+Enter fullscreen.
                </p>
                <div class="hud-hint__actions">
                  <button class="button button--primary" data-action="lock-match">Lock Controls</button>
                </div>
              </div>

              <div class="hud-downline" data-ui="death-panel" hidden>
                <strong data-ui="death">Down for the round.</strong>
                <span>Wait for reset or press M for map roster.</span>
              </div>

              <div class="hud-info-panel" data-ui="scoreboard-panel" hidden>
                <div class="hud-info-panel__header">
                  <div>
                    <p>Operations Board</p>
                    <h2 data-ui="map-name">${escapeHtml(map.name)}</h2>
                  </div>
                  <div>
                    <span data-ui="round-number">Round 1</span>
                    <strong data-ui="round-timer">00:00</strong>
                    <small data-ui="round-phase">Briefing</small>
                  </div>
                </div>

                <div class="hud-info-grid">
                  <section class="hud-info-section hud-info-section--mission">
                    <p class="hud-label">Mission</p>
                    <strong><span data-ui="mission-label">Relay Charge</span> / <span data-ui="objective-label">Objective</span></strong>
                    <span data-ui="mode-notice">
                      ${mode === "shared" ? `Shared room armed for ${escapeHtml(map.name)}.` : "Solo round armed."}
                    </span>
                    <span data-ui="mission-summary">Mission briefing pending.</span>
                    <span class="hud-note--accent" data-ui="objective-status"></span>
                    <div class="hud-progress" data-ui="objective-progress" hidden>
                      <div class="hud-progress__bar">
                        <span data-ui="objective-progress-fill"></span>
                      </div>
                      <small data-ui="objective-progress-label"></small>
                    </div>
                  </section>

                  <section class="hud-info-section">
                    <div class="hud-info-section__title">
                      <p class="hud-label">Team Counts</p>
                      <span class="chip" data-ui="player-count">1 operator</span>
                    </div>
                    <div class="hud-team-counts" data-ui="team-counts"></div>
                  </section>

                  <section class="hud-info-section hud-info-section--roster">
                    <div class="hud-info-section__title">
                      <p class="hud-label">Roster</p>
                      <span class="chip" data-ui="team-banner">${escapeHtml(teamPreferenceLabel(teamPreference))}</span>
                    </div>
                    <div class="hud-roster" data-ui="roster"></div>
                  </section>

                  <section class="hud-info-section hud-info-section--controls">
                    <p class="hud-label">Controls</p>
                    <div class="scoreboard-controls">
                      ${controlHint("Move", "WASD")}
                      ${controlHint("Crouch", crouchLabel, "crouch-control")}
                      ${controlHint("Jump", "Space")}
                      ${controlHint("Interact", "E")}
                      ${controlHint("Fire", "Mouse1")}
                      ${controlHint("Reload", "R")}
                      ${controlHint("Info", "Hold Tab")}
                      ${controlHint("Fullscreen", "Alt+Enter")}
                      ${controlHint("Map", "M")}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="match-console match-console--compact panel">
          <div class="match-console__copy">
            <p class="masthead__eyebrow">${modeEyebrow}</p>
            <h2>Match Options</h2>
            <p class="panel__text">Hold Tab inside the viewport for roster, mission detail, objective state, and controls. Use the corner button or Alt+Enter for viewport fullscreen.</p>
            ${renderBotDifficultyControls(botDifficulty, botDifficultyNote, true)}
          </div>
          <div class="match-console__actions">
            <button class="button" data-action="show-catalog">Change Map</button>
            <button class="button" data-action="open-map" data-mode="${switchMode}" data-map-id="${map.id}">${switchModeLabel}</button>
            <button class="button" data-action="toggle-classic-crouch" data-ui="classic-crouch-toggle" aria-pressed="${classicCrouchAlias}">Ctrl Crouch ${classicCrouchAlias ? "On" : "Off"}</button>
            <button class="button button--primary" data-action="show-menu">Return to Briefing</button>
          </div>
        </div>

        <div class="map-ribbon panel">
          <div class="panel__header">
            <p>Quick Deploy</p>
            <span class="chip">${mode === "shared" ? "Shared Room" : "Solo Round"}</span>
          </div>
          <div class="map-ribbon__list">
            ${maps.map((entry) => mapRibbonButton(entry, map.id, mode)).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}
