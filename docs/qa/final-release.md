# Final Release QA

Date: `2026-05-29`

## Scope

Final verification for the current presentation and release guardrail pass covered:

- browser-only architecture and dependency guardrails
- static `dist/` build output
- compact in-match HUD behavior, hold-Tab operations board, and viewport fullscreen control
- first-person weapon alignment, upright combatant posture, and third-person weapon pitch
- procedural opponent gunfire audio with distance-normalized world-fire gain
- final browser QA coverage for movement, rounds, missions, AI, and shared-room sync
- originality and asset-policy confirmation
- screenshot refresh for the shipped browser views
- README and docs sweep for controls, modes, missions, and limitations

Fresh current-tree verifier reruns were completed on `2026-05-29T10:08-03:00`.

## Commands Run

```bash
npm run typecheck
npm run build
npm test
```

Results on the current tree:

- `npm run typecheck`: passed
- `npm run build`: passed and produced static `dist/` output
- `npm test`: passed and returned successfully after rebuilding the app and running the full browser QA harness

Non-blocking note:

- The standalone build and the `npm test` build step repeated the existing Vite chunk-size warning for `dist/assets/localMatch-BG0I1IuZ.js` at `576.86 kB` after minification. This did not block verification.

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
- Movement:
  - crouch lowered the camera from `1.62` to `1.18`
  - crouch reduced same-window travel from `1.72` to `0.79`
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
  - page 1 firing in shared mode recorded a sent shot event, page 2 received it, and page 2 logged distance-normalized world-fire audio while marking the remote actor's recent shot state
- Hostage mode:
  - local play proved secure, escort, route traversal, extraction, and automatic reset into round `3`
  - shared-room play proved rescuer sync, route progress sync, extraction progress, and matching rescue resolution on both pages
- Tactical AI:
  - observable `objective`, `patrol`, `investigate`, `engage`, `reposition`, and `pursue` behaviors
  - blocker `Crate stack west` prevented through-wall fire at `visibility: 0`
  - shot model produced both hits and misses, with hit-chance dropping from `0.722` close-standing to `0.262` far-moving and `0.449` crouched-partial
  - enemy live fire emitted a distance-normalized world-fire audio event
- Shared-room fallback:
  - removing `BroadcastChannel` kept the app playable in local mode with a clear fallback notice instead of a crash

## Originality And Screenshot Evidence

- `docs/assets.md` records the shipped originality posture for teams, mission labels, map names, route callouts, HUD treatment, procedural audio, and low-poly geometry.
- `assets/screenshots/` was refreshed by the final QA harness on `2026-05-29`, with the latest current-tree timestamps between `10:06` and `10:08 -03:00`, including:
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

- Shared-room multiplayer remains same-browser and same-machine only through `BroadcastChannel`.
- Tactical AI coverage is centered on solo-local rounds rather than shared-room bot opponents.
- The live visuals remain intentionally flatter than the painted reference set, especially in walls and ground materials.
- `src/game/localMatch.ts` is still the heaviest gameplay file and the next refactor target if the prototype grows further.
