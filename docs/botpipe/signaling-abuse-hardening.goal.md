# Botpipe Goal Prompt: Cloudflare Signaling Abuse Hardening

Harden the Cloudflare signaling Worker and WebRTC client against bandwidth and protocol abuse while preserving the current static-site deployment model, Cloud Room UX, 14-player room cap, and manual WebRTC fallback.

## Context

This repo is a Vite/TypeScript/Three.js browser multiplayer prototype. Cloud Rooms use `workers/signaling/src/index.js` as a Cloudflare Worker with a Durable Object per room. The Worker should only exchange room presence, SDP offers/answers, and ICE candidates; gameplay stays browser-to-browser over WebRTC DataChannels.

Relevant files:

- `workers/signaling/src/index.js`
- `workers/signaling/wrangler.jsonc`
- `src/net/signaledWebRtcTransport.ts`
- `src/net/matchRoomConnection.ts`
- `src/net/signalingConfig.ts`
- `scripts/qa/signalingWorkerProbe.mjs`
- `scripts/qa/cloudSignalingVerification.mjs`
- `docs/multiplayer-architecture.md`
- `docs/qa/multiplayer.md`

Current known behavior:

- Cloud Rooms support `MAX_ROOM_PEERS = 14`.
- Manual copy-paste signaling remains a one-guest fallback.
- Google STUN is configured by default in the WebRTC transport.
- The deployed signaling URL is `https://csmini-signaling.csmini.workers.dev`.

## Objective

Implement layered abuse prevention for signaling and client-side networking:

1. Reject invalid traffic cheaply before it reaches room state where possible.
2. Enforce strict per-room, per-socket, per-peer, and per-message budgets inside the Durable Object.
3. Prevent oversized SDP/ICE payloads, relay amplification, room-code probing, WebSocket hoarding, and malformed-message loops.
4. Add client-side send/receive guardrails so a malicious peer cannot cause unbounded buffering or processing.
5. Keep normal 1-host/13-guest Cloud Room setup working.

## Required Server-Side Hardening

Add explicit Worker/Durable Object constraints with named constants. Choose conservative values and document the reasoning in code or docs.

Required guards:

- Request/route validation before Durable Object dispatch:
  - Only allow `GET` WebSocket upgrades on `/room/:roomId`.
  - Keep `/health` lightweight and do not expose secrets.
  - Reject malformed room IDs and excessive URL/query lengths.
- WebSocket message caps:
  - Maximum raw message bytes.
  - Maximum SDP description bytes.
  - Maximum ICE candidate bytes.
  - Maximum signaling messages per time window per socket.
  - Maximum signaling bytes per time window per socket.
  - Maximum invalid messages before closing the socket.
- Protocol phase caps:
  - Guests may not send offers.
  - Host may not send answers.
  - Offers/answers must be targeted.
  - ICE candidates must be targeted.
  - Limit offer, answer, and ICE candidate counts per peer/target pair.
- Room lifecycle caps:
  - Keep the 14-peer max.
  - Close duplicate IDs, second hosts, full rooms, malformed sessions, and timed-out unready sessions with policy close codes.
  - Clean up empty or stale room state.
- Relay hardening:
  - Relay only whitelisted message types.
  - Rebuild relayed messages server-side instead of forwarding arbitrary fields.
  - Never broadcast offer/answer/ICE payloads.
  - Include useful `room-error` details for valid clients, but do not leak internal state.

Optional but desirable if practical within the repo:

- Worker-minted or signed room codes that make random room-code scanning cheap to reject before room state is loaded.
- Soft abuse counters that can later trigger Turnstile without requiring a secret in this change.
- A simple kill-switch or environment variable to disable new room creation while allowing `/health` to respond.

Do not hardcode API keys, Turnstile secrets, Cloudflare account IDs, or deployment credentials.

## Required Client-Side Hardening

Add defensive checks around the signaled WebRTC transport and room protocol handling:

- Refuse to send signaling payloads that exceed the Worker caps.
- Avoid unbounded send attempts when a DataChannel is not open.
- Treat repeated malformed signaling/room messages as a peer failure.
- Keep `icecandidateerror` non-fatal; rely on WebRTC connection state for real failure.
- Preserve targeted host-to-guest sends and host broadcast for gameplay room messages.
- Preserve manual signaling behavior.

## QA And Evidence

Update or add deterministic QA so the hardening is verified, not just claimed.

Required verification:

- `npm run typecheck`
- `npm run build`
- `npm run qa:signaling-worker`
- `npm run qa:cloud-signaling`
- `npm run qa:cloud-signaling-14`
- `npm run qa:final`

Add negative tests to `scripts/qa/signalingWorkerProbe.mjs` or a new focused script that prove:

- Oversized messages are rejected or closed.
- Unsupported message types are rejected.
- Guest offers and host answers are rejected.
- Missing or invalid `toPeerId` is rejected.
- Excess ICE candidates or message-rate bursts are rejected.
- The 15th peer is rejected while 13 guests remain accepted.

## Documentation

Update docs to describe the abuse controls at a practical level:

- `docs/multiplayer-architecture.md`
- `docs/qa/multiplayer.md`
- README only if user-facing commands or limits change.

Document:

- What the Worker limits protect.
- What they do not protect, especially NAT/TURN failure, host cheating, and browser-spoofed identity.
- The difference between signaling abuse controls and gameplay anti-cheat.

## Done Criteria

The goal is complete only when:

- The Worker rejects abusive signaling without breaking normal room creation/join.
- A 14-player Cloud Room still passes browser QA.
- Manual signaling still passes the final suite.
- Abuse cases have automated evidence.
- Documentation reflects the shipped behavior.
- No secrets are added to the repo.
