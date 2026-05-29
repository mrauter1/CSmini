# Dustline Protocol

Browser-native tactical FPS prototype built with Vite, TypeScript, and Three.js. This branch adds near-free multiplayer that still works from static hosting: one browser tab hosts the room, guests connect over WebRTC DataChannels, and the host owns the canonical match state.

## What Ships On This Branch

- Five original tactical arenas with a menu -> roster -> match loop
- Solo drill fallback with lightweight hostile operators
- Browser-hosted multiplayer with Cloudflare room-code signaling for rooms up to 14 players and manual offer/answer fallback
- Host-authoritative roster, movement, snapshots, and damage resolution
- Guest-local recoil and firing feel with host-validated shot claims
- Same-browser `BroadcastChannel` transport retained as a dev-room fallback

## Run Locally

```bash
npm install
npm run dev
```

Open the local Vite URL in a modern desktop browser.

For a production-style local run:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
```

## Host A Cloud Room

1. Open `Open Multiplayer Setup` from the menu or map roster.
2. Pick a map.
3. Choose `Host Cloud Room`.
4. Send the room code to the other players.
5. Wait for the status to show `connected`, then enter the arena.

## Join A Cloud Room

1. Open `Open Multiplayer Setup`.
2. Pick the same map as the host.
3. Choose `Join Cloud Room`.
4. Enter the host room code.
5. Wait for the status to show `connected`, then enter the arena.

## Manual WebRTC Fallback

Use `Manual Host` and `Manual Join` if the Cloudflare signaling service is unavailable. This keeps the old copy-paste offer/answer flow available for one guest without changing the match protocol.

## How Authority Works

- The host is authoritative for roster membership, team assignment, health, eliminations, respawns, score, and snapshots.
- Guests send input ticks and shot claims instead of authoritative state.
- The host validates guest movement and rejects stale or implausible room messages.
- The host validates shots for latency window, line of sight, aim plausibility, fire rate, ammo, reload sequencing, spread sequencing, and target validity.
- Guests still get immediate local recoil, muzzle flash, and provisional feedback, but only host-accepted results change real health or score.

## Why This Still Works As A Static Site

- The frontend remains a plain client-side build that can be published from `dist/`.
- Cloudflare signaling only exchanges room presence, SDP, and ICE candidates.
- No always-on authoritative game server was added.
- The only gameplay transport is still the browser-to-browser WebRTC DataChannel.

## Social Trust And Limitations

- The host can still cheat because the host owns the canonical state.
- There are no authenticated accounts or trusted identities yet.
- Manual offer and answer exchange is still available as a fallback.
- The current WebRTC transport uses Google STUN servers by default.
- NAT or firewall combinations can block connection establishment.
- Cloud Rooms support one host plus up to 13 guests; manual signaling remains a one-guest fallback.
- Host migration is not implemented yet.

## QA Commands

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

`npm run qa:final` is the deterministic final suite. It runs:

- local solo smoke coverage
- manual WebRTC signaling coverage
- host-authoritative room-state coverage
- host-authoritative shot-validation coverage

`npm test` rebuilds the app and then runs that same suite.

## Documentation

- `docs/multiplayer-architecture.md`
- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`

## Project Layout

- `src/net/`: room protocol, transports, signaling helpers, room/session wiring
- `src/game/`: match runtime, host validation, snapshots, shared combat, collision
- `src/ui/`: menu, roster, room setup, HUD, and QA wiring
- `scripts/qa/`: deterministic browser verification scripts
- `docs/`: architecture notes and QA evidence

## Controls

- `WASD`: move
- `Shift`: sprint
- Mouse: look
- Left click or `Space`: fire
- `R`: reload
- `M`: return to map select
- `Esc`: release pointer lock or fallback look

## Assets And Licensing

- External environment assets used: none
- External character assets used: none
- External weapon assets used: none
- External audio assets used: none
- Geometry strategy: original low-poly primitive work only
- Audio strategy: original procedural browser synthesis only

No Counter-Strike assets, names, logos, textures, models, sounds, or map layouts are used.
