# Multiplayer Architecture

## Current Scope

The browser runtime now has host-authoritative shared-room gameplay wired through the same room protocol for:

- private Cloud Rooms shared by code or invite URL
- public Cloud Rooms listed by the signaling Worker
- debug-only manual WebRTC and same-browser transports used by QA hooks

The canonical `LocalMatch` runtime consumes `MatchRoomConnection` directly. Guests send input ticks and shot claims. The host publishes snapshots, owns authoritative health/status/round state, validates guest shots, and sends shot results back to the claimant.

The frontend remains a static Vite build:

- `npm install`
- `npm run build`
- publish `dist`

No always-on gameplay server is added. The Cloudflare Worker is only for room signaling, TURN credential responses, and the short-lived public room registry. Gameplay traffic stays browser-to-browser over WebRTC DataChannels, or over `BroadcastChannel` for the debug same-browser transport.

## Room Flows

Cloud Room:

1. The host chooses `Create Room` for the selected map.
2. The host keeps the room private for code/URL sharing or marks it public for the Worker-backed room list.
3. Guests choose `Join Room`, enter a code, open an invite URL, or select a public room, then connect through targeted offer/answer/ICE signaling.
4. Once the room reaches `connected`, each player enters the arena; DataChannels carry gameplay directly between browsers.

Manual Room:

Manual offer/answer remains available through QA/debug hooks, but it is no longer part of the visible room setup UI.

Same-Browser Dev Room:

The local `BroadcastChannel` path remains available through QA/debug hooks for same-machine development, screenshot evidence, and deterministic shared objective QA.

Relay idle policy:

- Each browser samples selected WebRTC candidate pairs through transport debug telemetry.
- Relay/TURN usage remains visible through debug snapshots for diagnostics.
- Production relay-idle kicking is disabled by default because tactical inactivity can be legitimate gameplay.
- The old warning/disconnect policy remains available only through QA hooks that explicitly force relay-idle behavior.
- Cloud signaling sends a keepalive every 30 seconds; public-host keepalives refresh the Worker-backed public room listing.
- Public Cloud Rooms use deterministic per-map server slots. Server 1 always uses code `PXB875`; private rooms keep random codes.

## Transport And Protocol

The room foundation lives in `src/net/`:

- `protocol.ts`: typed, versioned room messages and payload validation
- `transport.ts`: transport abstraction
- `broadcastTransport.ts`: same-browser dev transport
- `webrtcTransport.ts`: manual offer/answer transport
- `signaledWebRtcTransport.ts`: Cloud Room signaling transport
- `matchRoomConnection.ts`: room/session orchestration, host authority, compact snapshots, relay diagnostics, and ownership checks
- `publicRooms.ts`: client fetch/validation for the public room registry
- `manualSignaling.ts`, `signalingConfig.ts`, `iceServers.ts`, `webrtcStats.ts`: setup and diagnostics helpers

The protocol keeps two traffic lanes:

- `latest-state`: `heartbeat`, `host-snapshot`, and `input-tick`
- `reliable`: joins, participant updates, shot claims/results, objective events, and disconnects

Host snapshots are compacted as full or delta payloads. Guests reject stale host snapshots, and `matchRoomConnection` rejects room messages that violate ownership, size, version, or role expectations.

## Host Authority

The host owns:

- participant roster and team assignment
- remote player movement integration from guest input ticks
- player health, down state, eliminations, deaths, and round phase
- authoritative host snapshots
- guest shot validation and shot-result messages

Guests own:

- local input capture
- local recoil, muzzle flash, firing audio, and provisional ammo feedback
- shot-claim submission to the host, including the firing look vector so reliable shot claims do not depend on latest-state look packets arriving first
- reconciliation from host snapshots and shot results

Rejected shot results restore the guest weapon snapshot supplied by the host. Accepted results apply host-authoritative target health/status. Host-local shots are already authoritative because they are fired by the authority peer.

## Social Trust Boundary

The host is authoritative inside a room, but the host is still a player-controlled browser. The implementation rejects malformed peer traffic, validates guest shots, owns snapshots, and recovers from guest disconnects, but it does not provide anti-cheat guarantees against a malicious host. Cloud/manual rooms are meant for trusted small-room play, not public matchmaking.

## Shared Shot Validation

Shared combat validation is implemented in `src/game/sharedShotValidation.ts` and adapted to canonical Dustline runtime state.

The host validates:

- shooter id and weapon id
- shooter alive/down status
- latency and future-skew windows
- input sequence freshness
- reload sequence/state
- fire-rate window
- ammo and reserve state
- spread sequence
- direction and aim delta
- origin drift against rewind state
- collision blockers and maximum range
- target team, alive/down status, health, and damage clamping

A blocked line-of-sight shot consumes host weapon state and returns `blocked-by-cover`. Invalid fire-rate, ammo, reload, input, aim, or origin claims are rejected before consuming a shot.

Shot claims include the guest look direction used at fire time. The host still validates direction, aim delta, origin drift, input freshness, and line of sight, but it can now validate a legitimate client shot even when the reliable shot claim arrives before the guest's latest-state movement/look tick.

## Objective State Boundary

Round phase, objective HUD state, and serialized round/bomb/hostage runtime state are carried in host snapshots, so guests receive live objective status text, progress value, phase transitions, and host-authored objective state from the authority peer.

The full bomb/hostage mutation stream is not yet a separate host-authored `objective-event` flow. The protocol has an `objective-event` message type and ownership guardrails, but the current canonical cloud/manual integration does not serialize every bomb carrier, plant, defuse, rescuer, escort, and extraction mutation as authoritative events.

For full bomb and hostage state synchronization evidence today, use the same-browser shared-room QA in `scripts/qa/finalVerification.mjs`. Cloud/manual rooms use the same snapshot state boundary; a later subgoal can split those mutations into dedicated reliable `objective-event` messages if needed.

## Signaling Worker Boundary

The Worker under `workers/signaling/` stays signaling-only.

Its boundary is limited to:

- room presence/readiness
- targeted SDP offer relay
- targeted SDP answer relay
- targeted ICE candidate relay
- `/health`
- `/turn-credentials`

It does not relay gameplay messages.

## Worker Guardrails

The Worker keeps hardened limits around:

- route validation before Durable Object dispatch
- bounded room ids, path lengths, and query lengths
- raw signaling message size caps
- SDP and ICE candidate byte caps
- per-socket message and byte budgets
- invalid-message close budgets
- role restrictions on offers and answers
- targeted-only relay behavior
- one host plus up to 13 guests per room

The local Worker probe in `scripts/qa/signalingWorkerProbe.mjs` verifies these guardrails, and `qa:cloud-signaling-14` verifies the 14-player room cap from the browser runtime.

## TURN Credentials

The Worker exposes `/turn-credentials`.

Behavior:

- if no TURN-related env values are configured, it falls back to default STUN servers
- if Metered-related env values are configured later, the Worker can mint or fetch ICE server data without committing secrets to the repo

This repository does not include real TURN credentials or deployment secrets.

NAT notes:

- same-network and many ordinary home-router cases can connect with host/server-reflexive ICE candidates
- restrictive NAT or firewall cases may require TURN relay service outside this repo
- `npm run qa:signaling-worker` verifies the no-secret STUN fallback path
- `npm run qa:turn-relay` exists as an optional deployed-service probe and expects a real TURN-enabled signaling URL

## Validation Surface

Fresh 2026-05-30 validation covered the current command surface:

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

Observed results:

- local flow passed with 5 map cards, local ammo `24 -> 23`, hidden control prompt after engage, death text `Down for the round.`, catalog return, and zero leftover canvases
- manual signaling passed with host and guest both `connected`, rosters at `2`, and one remote operator on each page
- Worker guardrails passed with `maxPeersPerRoom: 14`, 13 accepted guests, overflow rejection, targeted offer/answer/ICE relay, role validation, size/rate/ICE-budget closures, and default STUN `/turn-credentials`
- Cloud Room passed with host/guest `connected`, rosters at `2`, remotes at `1`, guest input cadence, delta host snapshots, client-side oversized offer rejection, malformed signaling rejection, and malformed room-message disconnect
- 14-player Cloud Room passed with one host plus 13 connected guests, rosters at `14`, host remote count `13`, guest remote counts `13`, and delta snapshots
- host-room state passed for guest input delivery, input timeout clearing, stale latest-state duplicate/drop tolerance, guest prediction and reconciliation under delayed snapshots, jump reconciliation, newest-held snapshot delivery after backpressure release, host movement snapshots, and host-exit recovery
- shot validation passed for local guest shot feel, blocked-cover rejection, clear-shot hit confirmation, fire-rate rejection, ammo-state rejection, reload-state rejection, host-owned health, and authoritative weapon restoration
- final browser QA and `npm test` passed, including solo bot difficulty default/persistence, canonical movement, HUD/Tab/fullscreen, solo objectives, same-browser bomb/hostage objective sync, screenshot refresh, and missing-`BroadcastChannel` fallback
