# Multiplayer QA

Date: 2026-05-29

## Scope

This note records the current durable evidence for the browser-hosted multiplayer branch:

- Cloudflare room-code signaling
- signaling abuse rejection and relay hardening
- manual WebRTC offer and answer signaling fallback
- room connection establishment
- join and accept flow
- 14-player Cloud Room capacity
- roster materialization on both peers
- guest input delivery to the host
- host snapshot delivery to the guest
- disconnect cleanup and guest recovery after host exit
- host-authoritative shot acceptance and rejection
- preserved local solo flow in the same final QA surface
- config hygiene for the static-site frontend plus signaling-Worker deployment model

## Commands

```bash
npm run typecheck
npm run build
npm run qa:local-flow
npm run qa:signaling-worker
npm run qa:cloud-signaling
npm run qa:cloud-signaling-14
npm run qa:manual-signaling
npm run qa:host-room
npm run qa:shot-validation
npm run qa:final
npm test
```

When `SIGNALING_URL` is unset, `qa:signaling-worker`, `qa:cloud-signaling`, and `qa:cloud-signaling-14` now launch a local `wrangler dev --local` signaling Worker automatically and point the browser QA harness at `http://127.0.0.1:8787`. Setting `SIGNALING_URL` still overrides that default when a verifier intentionally wants the deployed service or another custom endpoint.

## Current Hardened-Path Verification Run

The current abuse-hardening evidence was refreshed against a local Worker built from this repo so the verifier does not depend on the deployed service state:

```bash
npm run typecheck
npm run build
npm run qa:signaling-worker
npm run qa:cloud-signaling
npm run qa:cloud-signaling-14
npm run qa:manual-signaling
npm run qa:host-room
npm run qa:shot-validation
npm run qa:final
rg -n -i "account_id|api[_-]?key|client_secret|turnstile|credential|secret_access|workers_dev_token|cloudflare_api" \
  workers/signaling/wrangler.jsonc workers/signaling/src docs/multiplayer-architecture.md package.json
rg -n '"vars"|"env"|account_id|route|routes|kv_namespaces|r2_buckets|d1_databases|services' \
  workers/signaling/wrangler.jsonc
```

## Shipped Networking Model

The finished branch keeps the existing deployment model:

- the frontend still ships as a static Vite site
- the Cloudflare Worker remains signaling-only and does not relay gameplay
- one browser tab is still the authoritative host
- there is still no dedicated authoritative game server

Room protocol `v3` now uses two browser-to-browser delivery lanes:

- Reliable ordered lane:
  - join, accept, reject
  - participant updates
  - disconnects
  - shot claims and shot results
  - objective or round events
- Latest-state lane:
  - guest input ticks
  - host snapshots
  - heartbeats

Latest-state handling is freshness-based rather than peer-global ordered:

- late or duplicate `input-tick`, `host-snapshot`, and `heartbeat` messages are dropped quietly
- malformed, oversized, wrong-room, wrong-target, wrong-lane, role-forbidden, or out-of-order reliable traffic still counts as invalid room traffic
- if the state lane is backpressured, the transport keeps only the newest unsent latest-state payload instead of preserving a stale backlog

Host-side movement safety is also explicit:

- the host records when each accepted guest `input-tick` arrived
- if no fresh tick arrives for `320 ms`, the host clears only movement and sprint for that actor
- this prevents a lost release tick from leaving a guest moving indefinitely without clearing unrelated weapon or reload state

Guest prediction now reconciles against host acknowledgements:

- host snapshots include `lastProcessedInputSequence`
- the guest keeps a bounded local input and replay history
- when a host snapshot arrives, the guest drops acknowledged history and reapplies only unacknowledged local movement
- large divergence, first sync, death, respawn, and reset paths still hard-snap instead of replaying through lifecycle transitions

Remaining trust and connectivity limits are unchanged:

- NAT and firewall edge cases can still block direct browser-to-browser connectivity without TURN
- the host can still cheat because the host owns canonical gameplay state
- browser identities are still spoofable protocol labels rather than authenticated accounts
- manual signaling remains a one-guest fallback, not a dedicated-server path

## Automated Coverage

### `npm run typecheck`

Coverage:

- TypeScript validation across the browser client, QA hooks, and shared multiplayer protocol surfaces

Observed result on the current branch:

- passed with no diagnostics

### `npm run build`

Coverage:

- static production build for the existing Vite frontend deployment model
- fresh `dist/` output used by the browser QA scripts

Observed result on the current branch:

- passed and emitted a fresh production bundle under `dist/`
- Vite reported a large-chunk warning for `localMatch`, but the build still exited successfully

### `npm run qa:signaling-worker`

Coverage:

- local hardened Worker health endpoint and route validation
- room capacity metadata and 15th-peer rejection while 13 guests remain accepted
- host and guest WebSocket join
- `host-ready` and `peer-joined` room events
- targeted `offer`, `answer`, and `ice-candidate` relay
- unsupported message rejection
- missing or invalid `toPeerId` rejection
- guest-offer and host-answer rejection
- oversized raw-message close
- message-rate burst close
- per-pair ICE candidate budget close

Observed result on the current branch:

- `npm run qa:signaling-worker` passed against `signalingUrl = "http://127.0.0.1:8787"` with:
  - `postHealthStatus = 405`
  - `badRouteStatus = 404`
  - `oversizeQueryStatus = 414`
  - `acceptedGuests = 13`
  - `overflowRejected = true`
  - `unsupportedMessage.reason = "unsupported-message"`
  - `targetValidation.missingTarget = "target-required"`
  - `targetValidation.badTarget = "peer-not-found"`
  - `roleViolations.guestOffer = "guest-offer-forbidden"`
  - `roleViolations.hostAnswer = "host-answer-forbidden"`
  - `oversizedMessage.closeCode = 1009`
  - `oversizedMessage.closeReason = "message-too-large"`
  - `rateLimit.closeCode = 1008`
  - `rateLimit.closeReason = "rate-limit"`
  - `iceCandidateBudget.reason = "ice-candidate-limit"`
  - `iceCandidateBudget.closeCode = 1008`
  - `iceCandidateBudget.closeReason = "ice-candidate-limit"`

### `npm run qa:cloud-signaling`

Coverage:

- host room-code generation
- guest join by code
- automatic SDP and ICE exchange through Cloudflare signaling
- WebRTC DataChannel connection establishment
- roster population after both peers enter the arena
- client-side rejection of an oversized outbound signaling offer
- repeated malformed inbound signaling-frame escalation
- repeated malformed room-message escalation to peer failure

Observed result on the current branch:

- `npm run qa:cloud-signaling` passed with:
  - `roomCode` was non-empty
  - `hostPhase = "connected"`
  - `guestPhases = ["connected"]`
  - `hostRosterCount = 2`
  - `guestRosterCounts = [2]`
  - `hostRemoteCount = 1`
  - `guestRemoteCounts = [1]`
  - `guardrails.outboundOfferRejected.sent = false`
  - `guardrails.outboundOfferRejected.phase = "error"`
  - `guardrails.outboundOfferRejected.detail = "Cloud signaling rejected an oversized or invalid offer payload."`
  - `guardrails.repeatedInvalidSignaling.phase = "error"`
  - `guardrails.repeatedInvalidSignaling.detail = "Received an invalid signaling message."`
  - `guardrails.malformedRoomPeerFailure.hostPeerCount = 0`
  - `guardrails.malformedRoomPeerFailure.hostDetail = "A peer sent repeated malformed room messages."`
  - `guardrails.malformedRoomPeerFailure.guestPhase = "idle"`
  - `guardrails.malformedRoomPeerFailure.guestDetail = "The host ended the room."`

### `npm run qa:cloud-signaling-14`

Coverage:

- one Cloud Room host plus 13 guest browsers
- targeted WebRTC offer and answer exchange for every guest
- roster materialization across all 14 match clients
- host-visible remote player count for all 13 guests
- guest-visible remote player count for the other 13 operators

Observed result on the current branch:

- `npm run qa:cloud-signaling-14` passed with:
  - `guestCount = 13`
  - `expectedPlayerCount = 14`
  - host and all 13 guests reached `connected`
  - `hostRosterCount = 14`
  - every value in `guestRosterCounts` was `14`
  - `hostRemoteCount = 13`
  - every value in `guestRemoteCounts` was `13`

### `npm run qa:manual-signaling`

Coverage:

- host offer generation
- guest answer generation from the pasted offer
- host answer application
- WebRTC DataChannel connection establishment
- roster population after both peers enter the arena

Observed result on the current branch:

- offer and answer blobs were both generated with non-trivial payload length
- host and guest both reached `connected`
- both peers entered `sandline-foundry`
- both peers reported roster length `2`

### `npm run qa:host-room`

Coverage:

- two-browser room join
- guest input tick delivery
- host-side receipt of guest input sequencing
- quiet latest-state duplicate/drop handling without disconnecting the peer
- delayed snapshot jitter while guest local prediction keeps moving
- latest-wins snapshot release after artificial latest-state backpressure
- host snapshot delivery to the guest
- host deadman clearing after paused guest input
- guest recovery after host disconnect

Observed result on the current branch:

- both peers entered the room and saw roster length `2`
- the host recorded guest input sequences greater than `0`
- the guest received authoritative snapshot ids greater than `0`
- pausing guest input still cleared the host-side remote movement state with `deadmanDrift = 0.086`
- injecting one dropped and one duplicated latest-state input tick still left the room `connected` with `peerCount = 1`, and the host continued advancing to `lastInputSequence = 8`
- delayed-snapshot jitter still let the guest move `1.764 m` locally while `lastSentInputSequence = 27` temporarily stayed ahead of `lastAcknowledgedInputSequence = 26`
- after delayed snapshots drained, guest reconciliation converged back to host authority with only `0.010 m` of position error
- artificial latest-state hold on host snapshots kept the guest pinned during the hold window and then advanced the guest from snapshot `29` to at least the newest held host snapshot `40` immediately after release
- closing the host returned the guest to the room setup screen with a recoverable error message
- host movement still changed the guest-side replicated remote position through later snapshots

### `npm run qa:shot-validation`

Coverage:

- guest shot claims cannot directly mutate health
- clear line-of-sight shot acceptance
- blocked shot rejection through cover
- impossible follow-up fire-rate rejection
- authoritative shooter ammo reconciliation after rejection

Observed result on the current branch:

- blocked claim returned `decision: rejected` with `reason: blocked-by-cover`
- blocked claim preserved authoritative host health at `100`
- clear shot returned `decision: accepted` with `damage: 34`
- authoritative host health dropped to `66` after the accepted hit
- immediate forged follow-up returned `decision: rejected` with `reason: fire-rate`
- rejected follow-up preserved authoritative guest ammo at `22`

### `npm run qa:local-flow`

Coverage:

- menu -> roster -> solo match path
- control engagement
- ammo change after firing
- death overlay
- clean return to the roster

Observed result on the current branch:

- roster rendered `5` map cards
- engaging controls hid the prompt panel
- ammo changed from `24` to `23`
- forced death exposed the death overlay
- returning to the catalog left `0` gameplay canvases behind

### `npm run qa:final`

`qa:final` is now the deterministic aggregate suite. It runs:

- `qa:local-flow`
- `qa:manual-signaling`
- `qa:host-room`
- `qa:shot-validation`

This intentionally replaces the older screenshot-heavy final harness as the repo's primary verifier-facing QA hook. The older visual artifacts under `assets/screenshots/` and `docs/qa/visual-report.md` remain historical reference material, but the final gate for this branch is the deterministic room-state and combat suite above.

Observed result on the current branch:

- `npm run qa:final` passed
- the returned suite id was `dustline-multiplayer-final`
- all four step ids were present and passed: `local-flow`, `manual-signaling`, `host-room`, `shot-validation`
- the embedded `manual-signaling` summary still reported `hostPhase = "connected"`, `guestPhase = "connected"`, `hostRosterCount = 2`, and `guestRosterCount = 2`
- the embedded `host-room` summary still reported guest recovery with `guestRecoveryScreen = "room"` and `guestRecoveryError = "The host ended the room."`, plus the latest-state resilience probes above
- the embedded `shot-validation` summary still reported `blockedResult.reason = "blocked-by-cover"`, `acceptedResult.reason = "hit-confirmed"`, and `fireRateResult.reason = "fire-rate"`

### `npm test`

`npm test` runs:

```bash
npm run build
npm run qa:final
```

That means the finished multiplayer branch now gates on the static build plus the deterministic end-to-end suite above.

## Automated Vs Manual Evidence

Automated today:

- `typecheck` and `build` on the hardened branch
- local solo flow
- Cloudflare signaling health, route policy, WebSocket relay, abuse rejection, and 14-player room-code coverage
- room-code WebRTC connection establishment
- manual signaling state
- WebRTC connection establishment
- join and accept flow
- roster replication
- guest input -> host movement
- quiet latest-state drop / duplicate handling
- delayed-snapshot guest prediction and reconciliation
- latest-wins host snapshot release after artificial backpressure
- host snapshot -> guest replication
- disconnect cleanup
- blocked and accepted shot validation
- fire-rate rejection and ammo reconciliation

Still manual:

- real remote-device testing across independent home or mobile networks
- NAT and firewall edge cases that may need STUN or TURN later
- subjective feel checks for latency, packet loss, and long sessions

## Signaling Abuse Hardening Vs Gameplay Anti-Cheat

- `qa:signaling-worker` and the guardrail probes inside `qa:cloud-signaling` prove signaling abuse controls: route gating, size caps, rate caps, relay allowlisting, peer-target validation, and bounded failure for malformed traffic.
- `qa:host-room` and `qa:shot-validation` prove gameplay authority, latest-state resilience, and message validation inside the browser host. They are separate from signaling hardening and do not turn this branch into an anti-cheat service.
- A malicious host can still cheat because the host owns the canonical gameplay state.
- Browser-generated identities are still protocol-level labels, not authenticated accounts, so browser-spoofed identity remains out of scope for this hardening pass.

## Current Limitations

- The transport currently uses Google STUN by default, but direct connectivity can still fail on tougher NAT combinations without TURN.
- Manual signaling remains available but is now a fallback, not the default user flow.
- Cloud Rooms support one host plus up to 13 guests; manual signaling remains a one-guest fallback.
- There is still no dedicated authoritative game server; the browser host remains the canonical authority.
- Host migration is still a follow-up item, not part of the shipped implementation.

## Config Hygiene

- `workers/signaling/wrangler.jsonc` only declares the Worker name, entrypoint, compatibility date, observability toggle, Durable Object binding, and migration. It does not declare `account_id`, `vars`, `routes`, or other secret-bearing runtime configuration.
- The targeted secret scan intentionally excludes this QA note itself so the search strings embedded below do not self-match the evidence surface.
- `rg -n -i "account_id|api[_-]?key|client_secret|turnstile|credential|secret_access|workers_dev_token|cloudflare_api" workers/signaling/wrangler.jsonc workers/signaling/src docs/multiplayer-architecture.md package.json` produced no output and exited with the expected `rg` status `1` for no matches.
- `rg -n '"vars"|"env"|account_id|route|routes|kv_namespaces|r2_buckets|d1_databases|services' workers/signaling/wrangler.jsonc` produced no output and exited with the expected `rg` status `1` for no matches.
