# Botpipe Goal Prompt: Online Multiplayer Smoothness And Resilience

Improve the current browser-hosted WebRTC multiplayer protocol so gameplay stays smoother and more correct on real internet connections with jitter, packet loss, temporary stalls, and occasional DataChannel backpressure, while preserving the existing static-site deployment model and Cloudflare signaling Worker.

## Context

This repo is a Vite/TypeScript/Three.js browser tactical FPS prototype. Multiplayer currently uses one browser tab as the authoritative host. Guests connect over WebRTC DataChannels, either through the Cloudflare signaling Worker or manual copy-paste signaling. The host owns canonical room state, validates shot claims, and broadcasts snapshots. The frontend is deployed as a Render static site, and Cloud Rooms use the Cloudflare Worker only for signaling.

Relevant files:

- `src/net/protocol.ts`
- `src/net/transport.ts`
- `src/net/webrtcTransport.ts`
- `src/net/signaledWebRtcTransport.ts`
- `src/net/matchRoomConnection.ts`
- `src/net/signalingConfig.ts`
- `src/game/localMatch.ts`
- `src/game/sharedShotValidation.ts`
- `scripts/qa/hostRoomStateVerification.mjs`
- `scripts/qa/cloudSignalingVerification.mjs`
- `scripts/qa/shotValidationVerification.mjs`
- `scripts/qa/finalVerification.mjs`
- `docs/multiplayer-architecture.md`
- `docs/qa/multiplayer.md`

Current known behavior:

- Cloud Rooms support one host plus up to 13 guests.
- The Cloudflare signaling Worker is abuse-hardened and should not become an authoritative gameplay server.
- Manual copy-paste WebRTC signaling remains a one-guest fallback.
- The deployed static site is `https://csminionline.onrender.com/`.
- The deployed signaling Worker URL is `https://csmini-signaling.csmini.workers.dev`.
- A recent fix allows diagonal guest input such as W+A by accepting the normal two-axis vector length on the host.

## Objective

Make online multiplayer feel and behave better under unstable internet by improving protocol semantics, transport lanes, input handling, snapshot delivery, reconciliation, and QA coverage.

The goal is complete only when:

1. Movement/input and host snapshots no longer suffer avoidable head-of-line blocking behind old reliable messages.
2. Guests do not keep moving indefinitely when a release input is delayed or lost.
3. Guest-side prediction reconciles against host authority without obvious rubber-banding for ordinary latency and jitter.
4. Host snapshots use latest-state semantics and avoid sending or processing stale backlog under DataChannel backpressure.
5. Shot validation remains host-authoritative and reliable enough for combat correctness.
6. Cloud Room, 14-player, manual fallback, and static Render deployment behavior remain intact.
7. Deterministic QA proves the new behavior rather than only documenting it.

## Required Improvements

### 1. Separate Reliable Events From Latest-State Traffic

The current WebRTC DataChannel setup uses a single ordered reliable channel. That can cause head-of-line blocking: an old snapshot or input packet can delay newer state that should supersede it.

Implement a reviewable transport strategy that separates traffic classes:

- Reliable ordered lane for room control and combat events:
  - join/accept/reject
  - participant updates
  - disconnect/room closed
  - shot claims
  - shot results
  - objective/round events that must not be dropped
- Latest-state lane for high-frequency state:
  - guest input ticks
  - host snapshots
  - heartbeats that are only useful while fresh

Prefer two WebRTC DataChannels:

- a reliable ordered channel for control/combat
- an unordered or low-lifetime/low-retransmit channel for latest-state traffic

If browser support or the existing manual fallback makes a two-channel rollout risky, implement an equivalent explicit queue/backpressure policy that preserves latest-state semantics. The implementation must explain the tradeoff in code or docs.

Do not weaken message validation or allow arbitrary peers to send traffic classes they should not send.

### 2. Make Sequence Handling Type-Aware

The current room code uses a peer-wide sequence check. That is too strict for unordered latest-state traffic and too blunt for mixed reliability.

Update protocol handling so that:

- late or duplicate input ticks are dropped quietly, not counted as abuse
- late or duplicate host snapshots are dropped quietly, not counted as abuse
- reliable control/combat messages remain strictly validated
- per-type or per-lane sequence state is explicit and easy to audit
- protocol versioning is updated if the wire contract changes incompatibly

Malformed, oversized, wrong-room, wrong-target, or role-forbidden messages must still count as invalid room traffic.

### 3. Add Host-Side Input Deadman

The host currently keeps simulating a guest from the last accepted movement vector. On a lossy connection, a delayed or lost key-release tick can leave the guest moving longer than intended.

Add a bounded input timeout:

- record the host receipt time of the latest accepted input tick per remote actor
- if no fresh input arrives for a short interval, clear movement and sprint for that actor
- choose a conservative default such as 250-400 ms and document the reasoning
- do not clear weapon/reload state incorrectly
- do not break normal held-key movement while input ticks are flowing

### 4. Improve Guest Prediction And Reconciliation

The guest currently predicts local movement and then lerps/snaps toward host authority. This can rubber-band under latency because it does not replay local inputs after a correction.

Implement a simple client prediction replay loop:

- host snapshots include the last processed input sequence for each player, or at least for the receiving guest
- the guest keeps a bounded history of recent local input ticks and simulated deltas
- when an authoritative local snapshot arrives, the guest corrects to host state and reapplies unacknowledged inputs
- cap history size and correction distance to avoid unbounded memory or wild replays
- preserve the existing snap behavior for large errors, respawns, deaths, and map resets
- keep shot claims tied to recent input sequence so combat validation remains coherent

The solution can be pragmatic; it does not need a full physics rollback engine. It must make ordinary movement feel smoother under moderate jitter.

### 5. Make Host Snapshot Delivery Latest-Wins

Host snapshots are currently full roster snapshots at a fixed interval. Improve this path so old snapshots do not queue behind newer ones:

- if a state lane is backpressured, avoid sending old snapshots that are already obsolete
- prefer sending the newest snapshot when the channel becomes available
- drop stale unsent snapshots rather than preserving backlog
- consider lowering precision or compacting snapshot payloads if it materially helps
- preserve 14-player room behavior

Full snapshots are acceptable if they remain small and latest-wins behavior is correct. Delta snapshots are optional unless they become necessary to pass QA or keep payloads bounded.

### 6. Preserve Shot Correctness

Do not move shot claims onto an unreliable latest-state path. Combat events must remain reliably delivered and host-validated.

Maintain or improve:

- fire-rate validation
- ammo/reload validation
- spread sequence validation
- latency/future skew checks
- input sequence linkage
- rewind-based target validation
- line-of-sight and cover rejection
- provisional local shot feedback that does not mutate real health/score until host accepts

If client prediction changes affect shot timing or origin validation, update the validation logic and tests accordingly.

### 7. Keep Existing Deployment And Signaling Constraints

Do not introduce an always-on authoritative game server.

Preserve:

- Render/static-site frontend build
- Cloudflare Worker as signaling-only, not gameplay relay
- manual copy-paste WebRTC fallback
- existing Cloud Room UX
- 14-player Cloud Room cap
- abuse hardening in the signaling Worker
- no secrets, API keys, TURN credentials, Cloudflare account IDs, or Render credentials in the repo

TURN support can be documented as a follow-up unless a no-secret, user-configurable path is practical.

## QA And Evidence

Update or add deterministic QA that exercises network-resilience behavior. Prefer focused browser-level tests under `scripts/qa/` that can run locally against Vite preview and, where needed, the local signaling Worker.

Required verification commands:

- `npm run typecheck`
- `npm run build`
- `npm run qa:host-room`
- `npm run qa:cloud-signaling`
- `npm run qa:cloud-signaling-14`
- `npm run qa:shot-validation`
- `npm run qa:final`

Add or extend QA coverage to prove:

- diagonal and multi-key guest movement still reaches host authority
- when guest input stops, the host clears remote movement after the input timeout
- late or duplicate latest-state packets are dropped without disconnecting valid peers
- reliable control/combat messages are still rejected when out of order or malformed
- backpressure or artificial send failure does not queue stale host snapshots indefinitely
- guest local movement stays smooth across at least a deterministic simulated jitter or delayed-snapshot scenario
- shot claims/results still work after transport lane changes
- manual signaling still connects and passes the final suite
- 14-player Cloud Room still reaches expected roster/remote counts

If the current QA harness lacks a way to simulate DataChannel loss/jitter/backpressure, add a small test hook or debug transport shim that is only available in QA mode and is documented.

## Documentation

Update documentation to describe the shipped networking model:

- `docs/multiplayer-architecture.md`
- `docs/qa/multiplayer.md`
- README only if user-facing commands or behavior change

Document:

- which messages are reliable vs latest-state
- how stale/duplicate packets are handled
- host input timeout behavior
- guest prediction/reconciliation behavior
- remaining limitations, including NAT/TURN failure, host cheating, browser-spoofed identity, and lack of a dedicated authoritative game server

## Non-Goals

Do not implement these unless needed to complete the required work:

- dedicated authoritative game server
- paid infrastructure
- account system or identity authentication
- full anti-cheat
- host migration
- large dependency additions
- complete binary protocol rewrite
- TURN deployment with secrets checked into the repo

## Done Criteria

The parent goal is complete only when:

- protocol and transport changes are implemented with clear ownership boundaries
- unstable-network failure modes listed above have deterministic QA evidence
- all required commands pass
- docs describe the actual shipped behavior
- Cloud Room, 14-player capacity, manual signaling fallback, shot validation, and static deployment compatibility are preserved
- no secrets or deployment credentials are added to the repo
