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

## Signaling Abuse Controls

The Cloudflare Worker is intentionally narrow:

- `GET /health` stays lightweight and only reports service readiness plus the public 14-peer room cap.
- WebSocket signaling is only accepted on `GET /room/:roomId`, with bounded room ids plus bounded path and query lengths so cheap junk requests can be rejected before Durable Object dispatch.
- Each accepted socket is limited by raw message bytes, SDP bytes, ICE candidate bytes, per-window message count, per-window byte count, and invalid-message count.
- The Durable Object keeps the room at one host plus up to 13 guests, rejects duplicate peer ids and second hosts, expires sockets that never become ready, and closes idle sessions instead of letting abandoned room metadata accumulate.
- Relay is allowlist-based: only `offer`, `answer`, and `ice-candidate` pass through, every relay must target a specific peer, and the Worker rebuilds the forwarded payload instead of copying arbitrary client fields.

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

## Known Limits

- Cloud Rooms are capped at 14 total participants: one host plus up to 13 guests.
- NAT and firewall combinations can prevent the browser-to-browser connection from forming.
- Manual offer and answer exchange is still available for one guest if Cloudflare signaling is unavailable.
- There is no host migration in the current implementation.

## Follow-Up Path

- Add optional TURN configuration once the project is ready to spend on tougher NAT cases.
- Add load and feel testing for long 14-player sessions on independent networks.
- Consider witness or checkpoint-based host migration only after the base host-client path is stable enough to justify the added complexity.

## Evidence

- QA scripts: `scripts/qa/localFlowVerification.mjs`, `scripts/qa/manualSignalingVerification.mjs`, `scripts/qa/signalingWorkerProbe.mjs`, `scripts/qa/cloudSignalingVerification.mjs`, `scripts/qa/hostRoomStateVerification.mjs`, `scripts/qa/shotValidationVerification.mjs`, `scripts/qa/finalVerification.mjs`
- QA notes: `docs/qa/local-play.md`, `docs/qa/multiplayer.md`
