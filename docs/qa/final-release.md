# Final Release QA

Date: `2026-06-02`

## Scope

Final verification for the current presentation and release guardrail pass covered:

- browser-only architecture and dependency guardrails
- static `dist/` build output
- solo-local smarter-bot difficulty selection with `easy`, `medium`, and `hard` (`medium` default)
- solo bots using the same walk, crouch, jump, gravity, and collision contract as the player
- smarter tactical-AI coverage for blocked LOS safety, delayed communication, repositioning, stuck recovery, objective pressure, and bounded solo-round resolution
- human-like map-aware solo bot coverage for graph waypoint routing, non-repeated stuck jumps, independent strategies, damage-driven strategy switching, Relay carrier/support/defuse intent, and Evac hostage/extraction intent
- compact in-match HUD behavior, hold-Tab operations board, and viewport fullscreen control
- first-person weapon alignment, upright combatant posture, third-person weapon pitch, and team-specific avatar uniforms
- procedural opponent gunfire audio with a user-gesture unlock pulse and playable distance-normalized world-fire gain
- final browser QA coverage for movement, rounds, missions, AI, and shared-room sync
- Cloud/manual WebRTC room setup and in-arena host-authoritative multiplayer sync
- signaling Worker guardrails, `/turn-credentials` fallback behavior, and one-host-plus-13-guests cap
- guest prediction/reconciliation, host snapshots, latest-state backpressure, input timeout clearing, host-exit recovery, and host-side shot validation
- originality and asset-policy confirmation
- screenshot refresh for the shipped browser views
- README and docs sweep for controls, modes, missions, and limitations

Fresh smarter-bot verifier reruns were completed on `2026-06-02`, including a standalone `npm run qa:final` screenshot-refresh pass and the full `npm test` wrapper. Broader cloud/manual multiplayer command evidence remains from the earlier release pass and is not re-claimed as newly rerun in this bot-focused update.

## Commands Run

```bash
npm run typecheck
npm run build
npm run qa:final
npm test
```

Results on the current tree:

- `npm run typecheck`: passed
- `npm run build`: passed and produced static `dist/` output
- `npm run qa:final`: passed and refreshed `assets/screenshots/` from the current `dist/` output
- `npm test`: passed and returned successfully after rebuilding the app and running the full browser QA harness

Non-blocking note:

- The standalone build and the `npm test` build step repeated the existing Vite chunk-size warning for the minified `localMatch` bundle at `668.94 kB`. This did not block verification.

## Browser-Only Guardrails

- `package.json` still uses a lightweight browser stack:
  - runtime dependency: `three`
  - dev dependencies: `vite`, `typescript`, `@types/three`
- No heavy engine or native runtime was added.
- The current source remains separated across:
  - `src/data/` for map and mission metadata
  - `src/game/` for movement, rounds, objectives, AI, collision, audio, teams, and shared-room sync
  - `src/ui/` for briefing, roster, HUD, and browser-shell flow
  - `src/world/` for Three.js scene lifecycle and primitive construction
- `npm test` rebuilt successfully and produced `dist/index.html` plus hashed CSS and JS bundles suitable for static deployment.

## QA Coverage Summary

The passing browser summary from the fresh `npm test` rerun explicitly covered the required gameplay contract:

- Solo bot difficulty:
  - the menu and map-select flow exposed exactly three solo-local bot levels: `easy`, `medium`, and `hard`
  - default shell state reported `medium`, explicit selection persisted when storage worked, and blocked-storage fallback kept `medium` as the safe default while still allowing in-memory live selection
  - the live debug snapshot reported the selected difficulty in-menu and during the active round
  - the player-facing note stayed explicit that difficulty applies to solo rounds only and that shared-room sessions remain human-only across tabs
- HUD and fullscreen:
  - old `.hud-card` / `.hud-overlay` gameplay surfaces were absent from live play
  - compact startup hints disappeared after controls were armed
  - health stayed bottom-left, ammo stayed bottom-right, and round/mission timing stayed in the top strip
  - hold-`Tab` opened the operations board, repeated keydown did not toggle it closed, and keyup hid it again
  - armed `Tab` prevented browser focus navigation, while unarmed `Tab` kept browser defaults
  - the viewport fullscreen button was icon-only, inside the match viewport shell, and exposed fullscreen label/title text for accessibility
  - deterministic fullscreen mocking proved viewport-shell targeting, `1012 x 720` renderer/canvas resize, held-Tab usability while fullscreen, exit-state cleanup, and denied-request compact status feedback
- Presentation:
  - idle and firing weapon debug states reported `lowRight: true`, `forwardAligned: true`, and `muzzleAheadOfRoot: true`
  - idle `barrelForward.z` was `-0.99`; firing `barrelForward.z` was `-0.97`
  - firing reported `muzzleFlashRecent: true` and `flashVisible: true`
  - live solo enemies across objective, patrol, blocked, investigate, engage, reposition, and pursue states stayed upright and above ground
  - shared-room remote actors on both pages stayed upright and above ground
  - shared-room remote body yaw tracked horizontal look while weapon aim tracked the full vertical look vector
  - Cobalt avatars exposed blue-gray uniforms without masks, while Amber avatars exposed warm rust/tan uniforms with dark domino masks
- Movement:
  - crouch lowered the camera from `1.62` to `1.18`
  - crouch reduced same-window travel from `2.06` to `1.18`
  - jump peaked at `2.59`, landed at `1.62`, and stayed airborne for `0.767s`
- Teams and spawns:
  - all five shipped maps loaded round-one bomb metadata live
  - each map preserved distinct spawn separation: `29.17`, `30.41`, `28.16`, `28.07`, and `28.16` units
- Round shell:
  - forced death kept the player down for the active round
  - next-round reset revived the player and advanced the counter from round `1` to round `2`
- Bomb mode:
  - local play proved carrier ownership, valid-site arming, planted countdown, and explosion resolution
  - shared-room play proved carrier sync, planted-state sync, defender defuse, and matching resolution text on both pages
- Shared combat:
  - page 1 firing in shared mode recorded a sent shot event, page 2 received it, and page 2 logged playable distance-normalized world-fire audio with no blocked reason after its audio context was armed while marking the remote actor's recent shot state
  - the browser QA uses a trusted match-control click and asserts page 2's audio context is both `running` and `audioArmed` before counting remote-fire audio as audible
  - stale remote-fire audio is not queued for delayed replay; blocked shots are dropped unless the audio context resumes inside the short freshness window
- Hostage mode:
  - local play proved secure, escort, route traversal, extraction, and automatic reset into round `3`
  - shared-room play proved rescuer sync, route progress sync, extraction progress, and matching rescue resolution on both pages
- Tactical AI:
  - observable `objective`, `patrol`, `investigate`, `engage`, `reposition`, and `pursue` behaviors
  - opening strategy diversity proved `anchor_site`, `route_probe`, and `flank_rotate` in one live fireteam, with per-bot role/profile debug fields and objective intent
  - the opening objective bot already held a live crouch state, and deterministic bot movement samples matched the player-equivalent tuning: walk `8.6u/s`, crouch `4.82u/s`, gravity `13.6`, jump velocity `5.25`
  - deterministic bot jump samples proved grounded start, airborne phase, readable peak, safe landing, and upright posture with root-pitch/body-yaw separated from weapon pitch while aiming
  - blocker `Crate stack west` prevented through-wall fire at `visibility: 0`
  - delayed shared contact kept the staged receiver on `patrol` before delivery, then let it switch to `investigate` or `pursue` only after the communication lag elapsed
  - pressure on the staged enemy produced a real `reposition` with reason `angle`, then a `pursue` state after lost sight
  - a blocked traversal case recovered through a graph route to `Central Yard route offset` instead of teleporting, with `routeUsesGraph: true`, `routeReason: partial-route`, and `jumpCount: 0`
  - player damage forced a strategy switch to `cover_reposition` with reason `recent-damage`
  - ordered difficulty danger stayed fair: `easy` `0.487s / 7.124 / 0.407`, `medium` `0.377s / 6.037 / 0.537`, `hard` `0.237s / 4.951 / 0.657`
  - bot fire interval now matches the player fire interval at `0.18s`, and enemy damage now matches player damage at `34`
  - staged hard combat fired `6` shots over `1.66s` while still producing both hits and misses
  - an enemy-side `Kiln Yard` plant case proved objective-aware pressure and bounded solo-round resolution without deadlock
  - Relay-aware staging proved carrier intent `carrier_site_commit`, support intents `carrier_escort` and `carrier_flank_screen`, distinct support targets, and defender `defuse_rotate` during planted/defusing state
  - Evac-aware staging proved rescuer `escort_extract`, a graph route to declared route label `Drain Underpass` through `Loading Bay route offset`, escort support intent, and defender `hostage_cluster_anchor` / `hostage_lane_probe` intent
  - shot model produced both hits and misses, with hit-chance dropping from `0.722` close-standing to `0.262` far-moving and `0.449` crouched-partial
  - enemy live fire emitted a playable distance-normalized world-fire audio event
- Shared-room fallback:
  - removing `BroadcastChannel` kept the app playable in local mode with a clear fallback notice instead of a crash
- Cloud/manual multiplayer:
  - manual offer/answer host and guest both reached `connected`, rosters reached `2`, and each page saw one remote operator
  - Cloud Room host and guest reached `connected`, rosters reached `2`, each page saw one remote operator, guest input cadence advanced, and host snapshots used delta encoding
  - 14-player Cloud Room verification connected one host plus 13 guests, all rosters reached `14`, host saw 13 remotes, each guest saw 13 remotes, and host snapshots stayed delta encoded
  - host-room verification proved host receipt of guest input, input-timeout/deadman clearing, stale latest-state duplicate/drop tolerance, guest prediction/reconciliation under delayed snapshots, jump reconciliation, newest-held snapshot delivery, host movement snapshots, and host-exit recovery
  - shared shot validation accepted a clear hit for `34` damage, rejected blocked line-of-sight, fire-rate, ammo-state, and reload-state claims, kept host health authoritative, and restored rejected guest weapon state
  - signaling Worker verification kept gameplay off the Worker, enforced targeted offer/answer/ICE relay, rejected role violations and malformed/oversized/rate-abusive traffic, capped rooms at one host plus 13 guests, and returned default STUN servers from `/turn-credentials` when no TURN secrets were configured

## Originality And Screenshot Evidence

- `docs/assets.md` records the shipped originality posture for teams, mission labels, map names, route callouts, HUD treatment, procedural audio, and low-poly geometry.
- `assets/screenshots/` was refreshed by the final QA harness on `2026-06-02`, including:
  - `01-menu-briefing.png`
  - `02-map-select-roster.png`
  - `03-sandline-spawn-view.png`
  - `04-sandline-central-yard.png`
  - `05-sandline-generator-hall.png`
  - `06-sandline-drain-underpass.png`
  - `07-sandline-east-catwalk.png`
  - `08-weapon-idle-hud.png`
  - `09-weapon-firing-hud.png`
  - `10-opposing-player.png`
  - `11-death-respawn-state.png`
  - `12-two-player-multiplayer.png`
  - `13-held-tab-operations-board.png`

## Remaining Limitations

- Cloud/manual rooms are peer-hosted browser sessions, not public matchmaking; the host is authoritative but remains socially trusted.
- Restrictive NAT/firewall cases may require external TURN service configuration. The repo contains no real TURN credentials or deployment secrets; no-secret `/turn-credentials` falls back to STUN.
- Same-Browser Dev Room remains the local `BroadcastChannel` path and continues to provide deterministic shared objective QA evidence.
- Cloud/manual objective state is serialized through host snapshots today; a future split can move every bomb/hostage mutation into dedicated reliable `objective-event` messages.
- Solo bot difficulty remains a solo-local setting only; shared-room tabs remain human-only.
- Tactical AI coverage is centered on solo-local rounds rather than shared-room bot opponents.
- Solo bot strategy/objective debug surfaces are QA/debug evidence; they are not exposed as a player-facing tactical command UI.
- The live visuals remain intentionally flatter than the painted reference set, especially in walls and ground materials.
- `src/game/localMatch.ts` is still the heaviest gameplay file and the next refactor target if the prototype grows further.
