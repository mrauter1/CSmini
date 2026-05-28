# Final Release QA

Date: `2026-05-28`

## Scope

Final verification for `verification-docs-and-final-reporting` covered:

- browser-only architecture and dependency guardrails
- static `dist/` build output
- final browser QA coverage for movement, rounds, missions, AI, and shared-room sync
- originality and asset-policy confirmation
- screenshot refresh for the shipped browser views
- README and docs sweep for controls, modes, missions, and limitations

Fresh current-tree verifier reruns were completed on `2026-05-28T15:48:18-03:00`.

## Commands Run

```bash
npm run typecheck
npm test
npm run qa:final
```

Results on the current tree:

- `npm run typecheck`: passed
- `npm test`: passed and returned successfully after rebuilding the app and running the full browser QA harness
- `npm run qa:final`: passed and returned successfully while refreshing `assets/screenshots/`

Non-blocking note:

- The `npm test` build step repeated the existing Vite chunk-size warning for `dist/assets/localMatch-*.js` after minification. This did not block verification.

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

The passing browser summaries from the fresh `npm test` and `npm run qa:final` reruns explicitly covered the required gameplay contract:

- Movement:
  - crouch lowered the camera from `1.62` to `1.18`
  - crouch reduced same-window travel from `1.72` to `0.98` in `npm test`
  - the standalone `qa:final` rerun also kept crouch slower than standing at `1.03` vs `0.6`
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
- Hostage mode:
  - local play proved secure, escort, route traversal, extraction, and automatic reset into round `3`
  - shared-room play proved rescuer sync, route progress sync, extraction progress, and matching rescue resolution on both pages
- Tactical AI:
  - observable `objective`, `patrol`, `investigate`, `engage`, `reposition`, and `pursue` behaviors
  - blocker `Crate stack west` prevented through-wall fire at `visibility: 0`
  - shot model produced both hits and misses, with hit-chance dropping from `0.722` close-standing to `0.262` far-moving and `0.449` crouched-partial
- Shared-room fallback:
  - removing `BroadcastChannel` kept the app playable in local mode with a clear fallback notice instead of a crash

## Originality And Screenshot Evidence

- `docs/assets.md` records the shipped originality posture for teams, mission labels, map names, route callouts, HUD treatment, procedural audio, and low-poly geometry.
- `assets/screenshots/` was refreshed by the final QA harness on `2026-05-28`, with the latest current-tree timestamps between `15:44` and `15:47 -03:00`, including:
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

## Remaining Limitations

- Shared-room multiplayer remains same-browser and same-machine only through `BroadcastChannel`.
- Tactical AI coverage is centered on solo-local rounds rather than shared-room bot opponents.
- The live visuals remain intentionally flatter than the painted reference set, especially in walls and ground materials.
- `src/game/localMatch.ts` is still the heaviest gameplay file and the next refactor target if the prototype grows further.
