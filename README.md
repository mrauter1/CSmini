# Dustline Protocol

Browser-only tactical FPS homage built on Vite, TypeScript, and Three.js. The current build ships five original arenas, two original teams, timed round flow, bomb and hostage mission variants, lightweight solo AI, and same-map shared-room sync between browser tabs.

## Gameplay Scope

- Teams: `Amber Vanguard` and `Cobalt Reach`
- Modes:
  - `Shared Room`: same-map tab-to-tab sync through `BroadcastChannel`
  - `Solo Round`: local play with a lightweight enemy fireteam
- Round shell:
  - briefing
  - active round
  - resolution/reset
- Mission rotation:
  - `Relay Charge`: attackers carry, arm, and defend a relay charge while defenders disarm
  - `Evac Escort`: rescuers secure hostages, escort them along a declared route, and extract them
- AI behaviors in solo play:
  - objective hold
  - patrol
  - investigate
  - engage
  - reposition
  - pursue

## Controls

- `WASD`: move
- `Shift`: crouch
- `Ctrl`: optional classic crouch alias when enabled in match controls
- `Space`: jump
- `E`: objective interaction
- Left click: fire
- `R`: reload
- `Tab`: hold in-match operations board
- Viewport corner button or `Alt+Enter`: toggle match viewport fullscreen
- `M`: return to map select
- `Esc`: release pointer lock and use native browser fullscreen exit behavior

## Run Locally

```bash
npm install
npm run dev
```

For a production-style local run:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
```

## Verification

Core release commands:

```bash
npm run typecheck
npm run build
npm test
npm run qa:final
```

- `npm test` rebuilds the app and runs the full browser QA harness.
- `npm run qa:final` reruns the browser QA harness against the current `dist/` output and refreshes `assets/screenshots/`.

Durable QA artifacts:

- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- `docs/qa/classic-feel.md`
- `docs/qa/visual-report.md`
- `docs/qa/final-release.md`

## Screenshots And Visual Review

- Final browser captures live in `assets/screenshots/`.
- The visual target summary is in `docs/visual-target.md`.
- The reference-to-implementation comparison and rubric live in `docs/qa/visual-report.md`.

## Originality And Asset Policy

- External runtime art assets: none
- External runtime audio assets: none
- Geometry: original low-poly primitive work
- Audio: original procedural browser synthesis
- Runtime dependency profile: `three` only

The current originality and asset-policy record is `docs/assets.md`. The project does not use Counter-Strike assets, names, logos, sounds, textures, models, copied UI, or copied map layouts.

## Project Layout

- `src/data/`: typed map metadata, mission declarations, previews, and scene blueprints
- `src/game/`: movement, rounds, missions, AI, collision, audio, teams, and shared-room sync
- `src/ui/`: briefing flow, roster, HUD, and browser-shell interactions
- `src/world/`: Three.js scene lifecycle and primitive construction
- `scripts/qa/finalVerification.mjs`: browser QA harness and screenshot refresh flow

## Known Limitations

- Shared-room multiplayer is intentionally same-browser and same-machine only; it is not networked matchmaking.
- Tactical AI verification is focused on solo-local rounds, not on shared-room opponent bots.
- The live art direction is intentionally flatter than the richer reference paintings, especially on walls and ground materials.
- `src/game/localMatch.ts` remains the largest gameplay file and the first refactor target if the prototype expands further.
- `vite build` still emits a non-blocking chunk-size warning for the `localMatch` bundle.
