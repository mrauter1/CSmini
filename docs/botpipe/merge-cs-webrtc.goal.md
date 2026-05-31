# Botpipe Goal Prompt: Merge WebRTC Multiplayer Onto Canonical Gameplay

Merge the browser-hosted WebRTC multiplayer functionality from `/home/rauter/code/cs-webrtc` into this worktree, `/home/rauter/code/cs-merge-webrtc`, while treating `/home/rauter/code/cs` / branch `main` as canonical for gameplay, mechanics, UI, visual direction, controls, maps, missions, solo AI, and QA expectations.

This is an inspect, understand, adapt, and validate task. Do not mechanically overwrite the current `cs-merge-webrtc` code with the older multiplayer branch. The final result should feel and behave like the latest `cs` branch, with the full network feature set from `cs-webrtc` carefully adapted into it.

## Repositories And Branch Roles

- Canonical base and target worktree: `/home/rauter/code/cs-merge-webrtc`
  - branch: `merge/cs-webrtc`
  - based on `/home/rauter/code/cs` `main`
  - this is the only worktree to edit
- Multiplayer source worktree: `/home/rauter/code/cs-webrtc`
  - branch: `feature/webrtc-host-multiplayer`
  - inspect and copy/adapt from here, but do not edit it
- Original main worktree: `/home/rauter/code/cs`
  - branch: `main`
  - use only as a reference if needed

## Current Understanding

The canonical `cs` branch currently includes newer game behavior that must be preserved:

- `AGENTS.md` project contract and CS 1.5-inspired feel rules
- team model: `Amber Vanguard` and `Cobalt Reach`
- map and mission model with typed team spawns, bomb mode, hostage mode, objectives, and tactical route metadata
- solo bot difficulty: `easy`, `medium`, `hard`, with `medium` default
- bots using player-equivalent movement mechanics
- compact in-match HUD, Tab-held operations board, and viewport fullscreen behavior
- controls:
  - `WASD`: move
  - `Shift`: crouch
  - optional `Ctrl`: classic crouch alias
  - `Space`: jump
  - `E`: objective interaction
  - left click: fire
  - `R`: reload
  - `Tab`: hold operations board
  - `Alt+Enter` or viewport button: fullscreen
  - `M`: map select
  - `Esc`: release pointer lock / native fullscreen behavior
- modular gameplay files such as:
  - `src/game/playerMovement.ts`
  - `src/game/bombState.ts`
  - `src/game/hostageState.ts`
  - `src/game/rounds.ts`
  - `src/game/tacticalAi.ts`
  - `src/game/botDifficulty.ts`
  - `src/game/botDifficultyTuning.ts`
  - `src/game/teams.ts`
  - `src/game/missions.ts`
  - `src/game/controls.ts`

The `cs-webrtc` branch contains the network work to transplant and adapt:

- `src/net/`
  - `broadcastTransport.ts`
  - `iceServers.ts`
  - `manualSignaling.ts`
  - `matchRoomConnection.ts`
  - `protocol.ts`
  - `signaledWebRtcTransport.ts`
  - `signalingConfig.ts`
  - `transport.ts`
  - `webrtcStats.ts`
  - `webrtcTransport.ts`
- `workers/signaling/src/index.js`
- `workers/signaling/wrangler.jsonc`
- `src/game/sharedShotValidation.ts`
- multiplayer-oriented changes in:
  - `src/main.ts`
  - `src/ui/app.ts`
  - `src/ui/templates.ts`
  - `src/styles.css`
  - `src/game/localMatch.ts`
  - `src/game/avatar.ts`
  - `src/game/audio.ts`
  - `src/game/collision.ts`
  - `src/data/maps.ts`
  - `src/types.ts`
- QA scripts:
  - `scripts/qa/localFlowVerification.mjs`
  - `scripts/qa/manualSignalingVerification.mjs`
  - `scripts/qa/runWithLocalSignalingWorker.mjs`
  - `scripts/qa/signalingWorkerProbe.mjs`
  - `scripts/qa/cloudSignalingVerification.mjs`
  - `scripts/qa/hostRoomStateVerification.mjs`
  - `scripts/qa/shotValidationVerification.mjs`
  - `scripts/qa/turnRelayProbe.mjs`
- docs:
  - `docs/multiplayer-architecture.md`
  - `docs/qa/multiplayer.md`
  - `docs/botpipe/signaling-abuse-hardening.goal.md`
  - `goal-webrtc-host-multiplayer.md`
  - `improvenet.md`

Important observed mismatch: `cs-webrtc` predates or diverges from newer canonical gameplay. It deletes or replaces several canonical gameplay modules and still documents older controls such as `Shift` sprint / `Space` fire. Those older assumptions must not survive the merge.

## Goal

The final `cs-merge-webrtc` branch must have:

- all current single-player gameplay, maps, missions, controls, UI, HUD, fullscreen behavior, visual direction, bot difficulty, player-equivalent bot movement, and QA behavior from canonical `cs`
- full browser-hosted multiplayer features from `cs-webrtc`:
  - Cloudflare room-code signaling
  - manual WebRTC offer/answer fallback
  - same-browser `BroadcastChannel` development room support where still useful
  - host-authoritative roster, movement, snapshots, shots, health, deaths, respawns, score, disconnects, and recovery
  - reliable and latest-state DataChannel lanes
  - guest local prediction and reconciliation
  - host-side input timeout/deadman clearing
  - host-side shot validation using line of sight, fire rate, ammo/reload sequencing, spread sequencing, target/team/round validity, and latency/plausibility checks
  - signaling abuse controls and client-side network guardrails
  - local Worker-backed QA scripts for Cloud Room and 14-player verification

## Required Approach

Start by inspecting and understanding both worktrees before editing:

```bash
git -C /home/rauter/code/cs-merge-webrtc status --short --branch
git -C /home/rauter/code/cs-merge-webrtc diff --name-status main..feature/webrtc-host-multiplayer
git -C /home/rauter/code/cs-merge-webrtc diff --stat main..feature/webrtc-host-multiplayer
```

Also read at minimum:

- `AGENTS.md`
- `README.md`
- `docs/visual-target.md`
- `docs/assets.md`
- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md` if present in either branch
- `scripts/qa/finalVerification.mjs`
- `/home/rauter/code/cs-webrtc/docs/multiplayer-architecture.md`
- `/home/rauter/code/cs-webrtc/goal-webrtc-host-multiplayer.md`
- `/home/rauter/code/cs-webrtc/docs/botpipe/signaling-abuse-hardening.goal.md`
- `/home/rauter/code/cs-webrtc/src/net/*.ts`
- `/home/rauter/code/cs-webrtc/src/game/sharedShotValidation.ts`
- `/home/rauter/code/cs-webrtc/workers/signaling/src/index.js`

Make a short merge plan before implementation that identifies:

- files that should be copied mostly as-is
- files that require adaptation into newer canonical code
- obsolete `cs-webrtc` assumptions to reject
- QA scripts and docs that must be merged
- expected validation commands

## Merge Rules

- Edit only `/home/rauter/code/cs-merge-webrtc`.
- Preserve current `AGENTS.md`; do not delete or weaken it.
- Preserve canonical `README.md` content for current gameplay, controls, maps, missions, bot difficulty, visual direction, and limitations. Extend it with network multiplayer docs.
- Preserve canonical controls. Do not reintroduce sprint. Do not make `Space` fire. Do not remove jump, crouch, objective interaction, Tab scoreboard, or fullscreen behavior.
- Preserve canonical teams, mission types, objective behavior, and map metadata. Adapt networking code to `TeamId`, `MissionType`, team spawns, bomb sites, hostage clusters, and round/objective state.
- Preserve canonical solo AI and bot difficulty. Network multiplayer should not regress solo-local behavior or require bots to become network-only.
- Preserve canonical UI/HUD structure. Add room setup and connection UI into the current interface without reverting to older large-overlay or outdated multiplayer branch UI.
- Preserve pointer-lock/input gating and browser-safe keyboard behavior.
- Preserve `three` as the only runtime dependency unless a strong reason is documented and approved by the existing project rules.
- Do not add secrets, API keys, account ids, Worker tokens, or deployment credentials.
- Do not commit `.wrangler/cache`, `.wrangler/state`, `dist`, or other generated runtime artifacts. If such files appear in the source branch, leave them out unless a real source file requires a placeholder directory.
- Do not deploy to Render or Cloudflare.

## Implementation Guidance

Prefer transplanting complete network modules first, then adapting integration points:

1. Add `src/net/` from `cs-webrtc`.
2. Add `src/game/sharedShotValidation.ts`, adapting imports/types to the canonical game modules.
3. Add `workers/signaling/src/index.js` and `workers/signaling/wrangler.jsonc`, excluding `.wrangler` generated state/cache.
4. Merge `package.json` scripts for network QA while keeping canonical build/test semantics.
5. Merge network QA scripts under `scripts/qa/`, then adapt them to the canonical QA hook surface.
6. Integrate room setup and multiplayer state into `src/ui/app.ts`, `src/ui/templates.ts`, and `src/styles.css` without regressing the canonical HUD/menu.
7. Integrate multiplayer runtime behavior into `src/game/localMatch.ts` carefully. This is the highest-risk area. Preserve canonical movement, missions, rounds, bot AI, objective logic, and debug hooks; add host/guest room behavior around them.
8. Merge or adapt `src/main.ts` QA hooks so both canonical gameplay QA and network QA remain available.
9. Update docs after behavior is working.

Treat `cs-webrtc/src/game/localMatch.ts` as a source of network algorithms and room integration behavior, not as an overwrite target. The canonical `localMatch.ts` has newer gameplay and should remain the structural base unless inspection proves a narrower replacement is safer.

## Multiplayer Behavior Requirements

### Room Setup

- UI supports:
  - host Cloud Room
  - join Cloud Room by room code
  - manual host offer generation
  - manual join answer generation
  - host applying manual answer
  - recoverable error/status states
- The current menu/map/roster flow remains usable for solo and shared/dev rooms.
- The same selected map and current player/team identity should flow into multiplayer setup.

### Transport And Protocol

- Keep protocol messages typed, versioned, and rejected when malformed, stale, oversized, wrong-room, wrong-target, wrong-lane, wrong-role, or out of order.
- Preserve reliable ordered messages for join/accept/reject, participant updates, disconnects, shot claims/results, and objective/round events.
- Preserve latest-state handling for input ticks, host snapshots, and heartbeats.
- Keep latest-state delivery freshness-based so old movement/snapshot traffic does not block newer state.
- Preserve bounded DataChannel buffering and newest-unsent replacement for latest-state messages.

### Host Authority

- Host remains authoritative for:
  - roster membership
  - team assignment
  - positions after movement validation
  - health
  - eliminations/deaths
  - respawns and round resets
  - objective and round events
  - score
  - accepted or rejected shot results
- Guests send intent:
  - input ticks
  - shot claims
  - join/leave/control events
- Guests may render local recoil, muzzle flash, sound, and provisional feel immediately, but real health/score/round state changes only after host acceptance.

### Canonical Gameplay In Multiplayer

- Multiplayer must respect the canonical movement contract:
  - crouch is `Shift`
  - jump is `Space`
  - no sprint layer
  - movement remains deliberate and grounded
- Multiplayer snapshots and prediction must understand canonical player height, crouch blend, jump/airborne/landing, and collision behavior.
- Multiplayer shot validation must understand canonical line-of-sight, map blockers, team ids, alive/dead states, weapon state, spread/recoil rules, and round phase.
- Round/objective networking should preserve or reasonably synchronize canonical bomb and hostage state. If full objective sync cannot be completed in one pass, document the exact remaining limitation and keep local/solo objectives fully working.
- Remote actors must stay upright and above ground, with yaw-only facing where appropriate.

### Signaling Worker

- Add the Cloudflare Worker source and Wrangler config from `cs-webrtc`.
- Preserve static-site compatibility: the frontend remains deployable as `npm install && npm run build` with `dist` as the output.
- Worker should only exchange room presence, SDP offers/answers, ICE candidates, and `/turn-credentials` responses. Gameplay must stay browser-to-browser over WebRTC DataChannels.
- Keep abuse controls:
  - route validation
  - bounded room ids, URLs, and queries
  - message byte caps
  - SDP/ICE size caps
  - per-window message and byte budgets
  - invalid-message close budget
  - role restrictions for offers/answers
  - targeted offer/answer/ICE relay only
  - one host plus up to 13 guests
  - no arbitrary payload broadcasting
- Do not add secrets or deployment credentials.

## QA And Validation Requirements

Update or preserve QA so claims are evidenced by commands, not just docs.

Required commands:

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

If a command must be renamed or merged into another script, update `package.json`, README, and docs consistently and state the reason in the final report.

Validation must prove:

- canonical solo local flow still works
- canonical bot difficulty still defaults to `medium` and remains selectable
- canonical player and bot movement mechanics are preserved
- canonical HUD and Tab operations board still work
- canonical objective interactions still work in solo play
- Cloud Room host and guest reach `connected`
- manual signaling host and guest reach `connected`
- 14-player Cloud Room setup passes against the local Worker harness
- host sees guest input ticks
- guest receives host snapshots
- guest prediction/reconciliation does not break canonical movement
- stale latest-state traffic is dropped or superseded without disconnecting healthy peers
- host input timeout clears stale guest movement
- valid shots can be accepted by the host
- blocked/invalid shots are rejected by the host
- malformed room/signaling messages trigger guardrails
- disconnect and host-exit recovery work
- no secrets are present in committed source

Also run targeted searches before finishing:

```bash
rg -n "sprint|Shift.*sprint|Space.*fire|Terrorist|Counter-Terrorist|de_|cs_" README.md docs src
rg -n -i "account_id|api[_-]?key|client_secret|turnstile|credential|secret_access|workers_dev_token|cloudflare_api" workers/signaling src docs package.json
git status --short
```

Use judgment for the `credential` search because public docs may mention TURN credentials conceptually. The final source must not contain actual secrets.

## Documentation Requirements

Update:

- `README.md`
- `docs/multiplayer-architecture.md`
- `docs/qa/multiplayer.md`
- `docs/qa/local-play.md` if solo/local QA changes
- `docs/assets.md` only if asset policy statements changed

Docs must explain:

- how to host and join Cloud Rooms
- how manual offer/answer fallback works
- the static-site-compatible architecture
- host authority and guest prediction
- what the host validates
- signaling abuse controls
- 14-player Cloud Room cap
- NAT/TURN limitations
- host cheating/social trust limitations
- how current multiplayer relates to solo bots and objectives
- exact QA commands and observed results

Do not remove canonical docs for classic feel, visual target, assets, or local play unless those files truly no longer exist in the target branch.

## Done Criteria

The goal is complete only when:

- `/home/rauter/code/cs-merge-webrtc` contains the latest canonical gameplay/UI/mechanics from `cs`
- the WebRTC/cloud/manual multiplayer functionality from `cs-webrtc` is fully integrated and adapted
- obsolete `cs-webrtc` assumptions such as sprint controls, old map types, old simplified local-only gameplay, and stale docs are removed or rewritten
- all required QA scripts pass, or any blocked command is explained with concrete remaining risk
- generated `.wrangler` state/cache and secrets are absent from source control
- final report lists changed files, validation commands, observed results, and any deferred limitations

## Botpipe CLI

Run from the target worktree:

```bash
botpipe run goal \
  --workspace /home/rauter/code/cs-merge-webrtc \
  --provider codex \
  --model gpt-5.5 \
  --task merge-cs-webrtc \
  "$(cat docs/botpipe/merge-cs-webrtc.goal.md)"
```
