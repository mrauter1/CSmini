# Dustline Protocol

Browser-only tactical FPS homage built on Vite, TypeScript, and Three.js. The current build ships five original arenas, two original teams with distinct avatar uniforms, timed round flow, bomb and hostage mission variants, lightweight solo AI, and host-authoritative Cloud Rooms over WebRTC.

## Gameplay Scope

- Teams: `Amber Vanguard` and `Cobalt Reach`
- Modes:
  - `Room Setup`: shared-mode entry exposes `Create Room` and `Join Room`
  - `Cloud Room`: a host creates a private or public room through the signaling Worker; private rooms are shared by random code or invite URL, public rooms use fixed server slots/codes in the room list, and gameplay runs peer-to-peer over WebRTC DataChannels
  - `Solo Round`: local play with a lightweight enemy fireteam and a browser-saved `easy` / `medium` / `hard` bot selector (`medium` default)
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
  - graph waypoint routing around blocked direct paths
  - independent anchor, route, and flank strategy selection
  - target deconfliction so shared-contact responders and objective escorts avoid stacking on the same point when a useful lane is available
  - map-aware Relay Charge carrier/escort/defuse intent
  - map-aware Evac Escort rescue/escort/extraction guard intent

Solo bots use the same walk, crouch, jump, gravity, and collision contract as the player. `easy`, `medium`, and `hard` change tactical quality instead: reaction time, communication delay, memory, burst discipline, cover choice, and shot spread. `medium` remains the default.

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
npm run qa:local-flow
npm run qa:manual-signaling
npm run qa:signaling-worker
npm run qa:cloud-signaling
npm run qa:cloud-signaling-14
npm run qa:host-room
npm run qa:shot-validation
npm run qa:final
npm test
```

- `npm test` rebuilds the app and runs the full browser QA harness.
- `npm run qa:final` reruns the browser QA harness against the current `dist/` output and refreshes `assets/screenshots/`.
- `npm run qa:local-flow` verifies the production local menu/match return path.
- `npm run qa:manual-signaling` verifies manual offer/answer host and guest connection.
- `npm run qa:signaling-worker` validates the local Cloudflare signaling Worker boundary, TURN fallback, room cap, and abuse guards.
- `npm run qa:cloud-signaling` verifies room-code signaling through the local Worker and in-arena host/guest sync.
- `npm run qa:cloud-signaling-14` verifies one host plus 13 guests.
- `npm run qa:host-room` verifies guest input delivery, host snapshots, prediction/reconciliation, latest-state backpressure, input timeout clearing, and host-exit recovery.
- `npm run qa:shot-validation` verifies host-side shared shot acceptance/rejection.

Durable QA artifacts:

- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- `docs/qa/classic-feel.md`
- `docs/qa/human-like-map-aware-bots.md`
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

- Cloud Rooms are browser-hosted peer sessions with a public listing, not neutral-server matchmaking. The host is authoritative for game state, but a malicious host can still cheat because there is no neutral server authority.
- NAT traversal depends on browser WebRTC. The Worker returns default public STUN servers when TURN configuration is absent; relay-only connectivity requires externally configured TURN credentials and is not committed to this repo.
- Cloud Room capacity is one host plus up to 13 guests.
- Public Cloud Rooms use fixed per-map server slots. Server 1 always uses code `PXB875`; private rooms keep random codes.
- Joining a stale or closed room link/code now promotes the joining browser into the host for that same map/code and drops directly into the arena.
- Shared-room arena pages include a copyable invite link above Match Options for hosts and guests.
- The signaling socket sends a keepalive every 30 seconds so active public rooms stay listed while the host tab remains online.
- Relay/TURN usage is still detected for diagnostics, but relay-idle kicking is disabled by default while the room stability policy is refined.
- Cloud objective state currently rides host snapshots. The protocol reserves reliable objective-event messages, but full per-mutation bomb/hostage event streaming is still a future split.
- Solo bot difficulty is currently a solo-local setting only; shared-room sessions remain human-only across tabs.
- Tactical AI verification is focused on solo-local rounds, not on shared-room opponent bots.
- The live art direction is intentionally flatter than the richer reference paintings, especially on walls and ground materials.
- `src/game/localMatch.ts` remains the largest gameplay file, but objective markers, reachability evidence, objective-bot goal evidence, HUD/debug snapshots, hostage actors, and scene setup now live in focused `src/game/` modules.
- `vite build` still emits a non-blocking chunk-size warning for the `localMatch` bundle.
