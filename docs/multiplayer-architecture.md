# Multiplayer Architecture

## Goals

Dustline keeps the frontend deployable as a plain static site while still allowing small-room internet multiplayer. The current branch does that by making one browser tab the room host and using browser-to-browser transports for everything else.

## Why It Stays Static-Site-Compatible

- The deployed app is still just HTML, CSS, and client-side JavaScript.
- Room setup defaults to a Cloudflare Workers signaling service with one Durable Object per room code.
- The signaling service exchanges room presence, SDP offers/answers, and ICE candidates only.
- The WebRTC peer connection is still created directly between browsers; gameplay messages do not flow through Cloudflare.
- Manual copy-paste signaling remains available as a backend-free fallback.
- There is no always-on match server, relay, database, or paid authoritative backend in the current implementation.

## Runtime Model

- `Host Cloud Room`: one browser creates a room code, negotiates one WebRTC connection per guest through Cloudflare signaling, and becomes the canonical match host.
- `Join Cloud Room`: up to 13 guest browsers enter the host code and receive targeted WebRTC offers through signaling.
- `Manual Host`: one browser creates the offer, accepts exactly one answer in the fallback UX, and becomes the canonical match host.
- `Manual Join`: another browser pastes the host offer, generates an answer, and waits for the host to apply it.
- `Same-Browser Dev Room`: the older `BroadcastChannel` transport still exists for local tab-to-tab development and debugging.
- The room/session protocol lives under `src/net/` and is versioned so malformed or stale messages can be rejected.

## Room Transport Lanes

Room protocol `v3` splits browser-to-browser traffic into two explicit lanes per peer:

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

The reliable lane stays ordered and loss-intolerant so room control and combat events keep strict host-authoritative behavior. The latest-state lane is unordered with zero retransmits so old movement or snapshot traffic does not block fresher state behind it.

On top of the unreliable lane, the client transport keeps only the newest unsent latest-state payload per peer. If the browser DataChannel is still buffering an older state frame, the transport replaces the pending unsent frame instead of queueing a backlog. When the lane becomes writable again, the newest pending snapshot or input frame is what gets sent.

Inbound sequencing is also type-aware instead of peer-global:

- reliable control/combat traffic must still advance monotonically per peer
- late or duplicate `input-tick`, `host-snapshot`, and `heartbeat` frames are dropped quietly
- malformed, oversized, wrong-room, wrong-target, wrong-lane, role-forbidden, or out-of-order reliable traffic still counts as invalid room traffic

The signaling path never becomes a gameplay relay. Cloudflare only helps the peers discover each other and exchange SDP / ICE; all room messages above still travel directly on browser DataChannels.

## Input Timeout And Reconciliation

- The host records when each guest's latest accepted `input-tick` was received and clears only movement plus sprint if no fresh tick arrives for `320 ms`.
- That timeout is intentionally conservative relative to the normal guest resend cadence, so held movement continues normally while the network is healthy but a lost key-release does not leave a guest running forever.
- Host snapshots now include `lastProcessedInputSequence` for every player. Guests use that acknowledgement to drop already-processed local history, keep only a bounded replay window, and rebuild their authoritative local target from host position plus unacknowledged predicted deltas.
- Large divergence, first sync, death, respawn, and room-reset transitions still hard-snap so the branch does not try to replay across lifecycle boundaries.
- Local prediction is still pragmatic rather than full rollback: it smooths ordinary jitter and delayed snapshots, but the host remains authoritative.

## Signaling Abuse Controls

The Cloudflare Worker is intentionally narrow:

- `GET /health` stays lightweight and only reports service readiness plus the public 14-peer room cap.
- WebSocket signaling is only accepted on `GET /room/:roomId`, with bounded room ids plus bounded path and query lengths so cheap junk requests can be rejected before Durable Object dispatch.
- Each accepted socket is limited by raw message bytes, SDP bytes, ICE candidate bytes, per-window message count, per-window byte count, and invalid-message count.
- The Durable Object keeps the room at one host plus up to 13 guests, rejects duplicate peer ids and second hosts, expires sockets that never become ready, and closes idle sessions instead of letting abandoned room metadata accumulate.
- Relay is allowlist-based: only `offer`, `answer`, and `ice-candidate` pass through, every relay must target a specific peer, and the Worker rebuilds the forwarded payload instead of copying arbitrary client fields.

Current threshold rationale:

- `24 KiB` raw, `12 KiB` SDP, and `2 KiB` ICE caps stay above ordinary browser-generated signaling payloads while keeping oversize relays cheap to reject.
- The `10 s` / `384 messages` / `256 KiB` per-socket window is sized for one host to fan out normal setup traffic to a full 14-player room, but it still cuts off sustained spam quickly instead of letting one socket monopolize the Durable Object.
- `4` invalid messages gives a real client enough room to receive actionable `room-error` feedback, but it stops malformed-message loops before they can linger.
- `5 s` ready timeout removes hoarded upgrades quickly because a valid socket should become ready almost immediately; `10 min` idle timeout is acceptable because gameplay moves to browser-to-browser DataChannels after setup; `30 s` sweeps keep cleanup coarse but prompt.
- `2` offers and `2` answers per peer pair allow the initial exchange plus one retry or restart, while `64` ICE candidates per pair leaves headroom for noisy candidate gathering without permitting endless trickle spam.
- Close codes follow the WebSocket intent: `1008` for policy and protocol breaches, `1009` for oversized frames, and `1011` for internal send failures.

These controls harden signaling abuse and bandwidth amplification. They are not gameplay anti-cheat. They also do not solve tough NAT traversal or replace TURN, and they do not authenticate browser identities beyond the room protocol itself.

## Host Authority

The host is the only side that accepts or publishes authoritative room state:

- roster membership, identity, and team assignment
- movement after host-side validation and clamping
- snapshots that guests reconcile against
- health, eliminations, deaths, respawns, and score changes
- accepted or rejected shot results

Guests stay responsive locally, but they only send intent:

- input ticks
- room join and leave events
- shot claims with weapon state and sequencing data

Combat stays on the reliable lane even after the latest-state split. Guests may show cosmetic recoil or provisional hit feedback immediately, but health, eliminations, respawns, score, and accepted shot outcomes only change after the host sends a reliable `shot-result`.

## What The Host Validates

Movement and session validation:

- stale or out-of-order room messages
- guest movement deltas that exceed plausible limits
- disconnect and stale-peer cleanup

Shot validation:

- message freshness and latency window
- line of sight against world collision
- aim plausibility and origin drift
- fire-rate timing
- ammo and reload sequencing
- spread index sequencing
- target and team validity

Clients can show local recoil, muzzle flash, and provisional hit feedback immediately, but real damage only exists after the host accepts the claim.

## What Is Still Socially Trusted

This is a hobby-scale host-authoritative design, not an anti-cheat service.

- The host can still cheat because the host owns the canonical state.
- Browser-generated identities are not authenticated accounts.
- Room codes are unauthenticated, so anyone with the code can attempt to join.
- Google STUN servers are configured by default, but no TURN relay is bundled yet.
- A browser can still spoof its chosen display name and accent color because the room protocol has no account or device attestation layer.

## Known Limits

- Cloud Rooms are capped at 14 total participants: one host plus up to 13 guests.
- NAT and firewall combinations can prevent the browser-to-browser connection from forming.
- Manual offer and answer exchange is still available for one guest if Cloudflare signaling is unavailable.
- There is no host migration in the current implementation.
- There is still no dedicated authoritative server, so the host can cheat and can intentionally publish false state.

## Follow-Up Path

- Add optional TURN configuration once the project is ready to spend on tougher NAT cases.
- Add load and feel testing for long 14-player sessions on independent networks.
- Consider witness or checkpoint-based host migration only after the base host-client path is stable enough to justify the added complexity.

## Evidence

- QA scripts: `scripts/qa/localFlowVerification.mjs`, `scripts/qa/manualSignalingVerification.mjs`, `scripts/qa/signalingWorkerProbe.mjs`, `scripts/qa/cloudSignalingVerification.mjs`, `scripts/qa/hostRoomStateVerification.mjs`, `scripts/qa/shotValidationVerification.mjs`, `scripts/qa/finalVerification.mjs`
- QA notes: `docs/qa/local-play.md`, `docs/qa/multiplayer.md`
