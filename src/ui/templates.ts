import {
  BOT_DIFFICULTIES,
  botDifficultyLabel,
  type BotDifficulty,
} from "../game/botDifficulty";
import { missionBadges } from "../game/missions";
import type { MatchMode } from "../game/multiplayerRoom";
import { TEAM_ORDER, getTeamDefinition, teamPreferenceLabel } from "../game/teams";
import { crouchControlLabel } from "../game/controls";
import type { MapDefinition, TeamPreference } from "../types";
import { renderPreviewSvg } from "./previewSvg";

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
          <button class="button button--tiny button--primary" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Join Room</button>
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
          Original early-2000s tactical FPS direction, rebuilt as a browser-native prototype with round timers, two original teams, mission-ready map metadata, and a same-map shared-room browser loop.
        </p>
        <div class="hero-panel__actions">
          <button class="button button--primary" data-action="show-catalog">Open Map Roster</button>
          <button class="button" data-action="open-map" data-mode="shared" data-map-id="${map.id}">Join ${escapeHtml(map.name)} Room</button>
          <button class="button" data-action="open-map" data-mode="local" data-map-id="${map.id}">Solo ${escapeHtml(map.name)}</button>
        </div>
      </header>

      <div class="hero-grid">
        <section class="hero-grid__brief">
          <div class="brief-panel">
            <p class="brief-panel__label">Flow</p>
            <p>Choose a team, deploy into a timed round, crouch or jump through the lane choices, and stay down until the next reset once you lose the duel.</p>
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
            Every entry now declares team spawns, tactical routes, and live mission metadata for both relay-charge and evac-escort round shells. Shared-room deploy syncs same-map tabs through the browser, while solo play keeps the local fallback combat loop available at all times.
          </p>
        </div>
        <div class="masthead__actions">
          <button class="button" data-action="show-menu">Back to Briefing</button>
          <button class="button button--primary" data-action="open-map" data-mode="shared" data-map-id="${maps[0]?.id ?? ""}">Join Featured Room</button>
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

export function renderMapStage(
  map: MapDefinition,
  maps: MapDefinition[],
  mode: MatchMode,
  teamPreference: TeamPreference,
  classicCrouchAlias: boolean,
  botDifficulty: BotDifficulty,
): string {
  const modeEyebrow = mode === "shared" ? "Shared Room Sync" : "Solo Round";
  const switchModeLabel = mode === "shared" ? "Switch to Solo Round" : "Switch to Shared Room";
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
