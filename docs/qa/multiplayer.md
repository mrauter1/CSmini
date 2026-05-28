# Multiplayer QA

Date: 2026-05-28

## Scope

This note records the current durable evidence for the browser-hosted multiplayer branch:

- manual WebRTC offer and answer signaling
- room connection establishment
- join and accept flow
- roster materialization on both peers
- guest input delivery to the host
- host snapshot delivery to the guest
- disconnect cleanup and guest recovery after host exit
- host-authoritative shot acceptance and rejection
- preserved local solo flow in the same final QA surface

## Commands

```bash
npm run typecheck
npm run build
npm run qa:local-flow
npm run qa:manual-signaling
npm run qa:host-room
npm run qa:shot-validation
npm run qa:final
npm test
```

## Automated Coverage

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
- host snapshot delivery to the guest
- guest recovery after host disconnect

Observed result on the current branch:

- both peers entered the room and saw roster length `2`
- the host recorded guest input sequences greater than `0`
- the guest received authoritative snapshot ids greater than `0`
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

### `npm test`

`npm test` runs:

```bash
npm run build
npm run qa:final
```

That means the finished multiplayer branch now gates on the static build plus the deterministic end-to-end suite above.

## Automated Vs Manual Evidence

Automated today:

- local solo flow
- manual signaling state
- WebRTC connection establishment
- join and accept flow
- roster replication
- guest input -> host movement
- host snapshot -> guest replication
- disconnect cleanup
- blocked and accepted shot validation
- fire-rate rejection and ammo reconciliation

Still manual:

- real remote-device testing across independent home or mobile networks
- NAT and firewall edge cases that may need STUN or TURN later
- subjective feel checks for latency, packet loss, and long sessions

## Current Limitations

- The transport currently uses `RTCPeerConnection` with `iceServers: []`, so direct connectivity can fail on tougher NAT combinations.
- Manual signaling is intentionally zero-backend and therefore still awkward for users.
- The UX is polished for one host plus one guest first.
- Host migration is still a follow-up item, not part of the shipped implementation.
