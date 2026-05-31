# Merge Plan: `cs-webrtc` onto canonical `cs`

Date: `2026-05-29`
Active subgoal: `inspect-and-adaptation-plan`

## Purpose

Capture the current merge baseline and the adaptation boundaries before any gameplay or networking code is transplanted into `/home/rauter/code/cs-merge-webrtc`.

This plan preserves the canonical `cs` gameplay contract and treats `/home/rauter/code/cs-webrtc` as a source of multiplayer modules and algorithms, not as an overwrite target.

## Baseline Branch Shape

Baseline commands run against `/home/rauter/code/cs-merge-webrtc`:

```bash
git -C /home/rauter/code/cs-merge-webrtc status --short --branch
git -C /home/rauter/code/cs-merge-webrtc diff --name-status main..feature/webrtc-host-multiplayer
git -C /home/rauter/code/cs-merge-webrtc diff --stat main..feature/webrtc-host-multiplayer
```

Observed baseline:

- Current branch: `merge/cs-webrtc`
- Working tree note during planning: `?? docs/botpipe/`
- The multiplayer source diff adds the expected network surface:
  - `src/net/*.ts`
  - `src/game/sharedShotValidation.ts`
  - `workers/signaling/src/index.js`
  - `workers/signaling/wrangler.jsonc`
  - multiplayer QA scripts under `scripts/qa/`
  - multiplayer docs
- The multiplayer source diff also attempts unacceptable regressions:
  - deletes `AGENTS.md`
  - deletes canonical gameplay modules such as `bombState.ts`, `botDifficulty.ts`, `botDifficultyTuning.ts`, `controls.ts`, `hostageState.ts`, `missions.ts`, `playerMovement.ts`, `rounds.ts`, `tacticalAi.ts`, and `teams.ts`
  - rewrites `src/game/localMatch.ts`, `src/ui/app.ts`, `src/ui/templates.ts`, `src/styles.css`, `src/main.ts`, `src/data/maps.ts`, and `src/types.ts`
  - includes generated Worker state under `workers/signaling/.wrangler/`

Conclusion: this is an adaptation merge, not a branch fast-forward or file overwrite.

## Required Evidence Read

Canonical target reads completed:

- `AGENTS.md`
- `README.md`
- `docs/visual-target.md`
- `docs/assets.md`
- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- `scripts/qa/finalVerification.mjs`
- `package.json`
- `src/game/localMatch.ts`
- `src/ui/app.ts`
- `src/main.ts`
- `src/data/maps.ts`
- `src/game/controls.ts`
- `src/game/botDifficulty.ts`

Source worktree reads completed:

- `/home/rauter/code/cs-webrtc/docs/multiplayer-architecture.md`
- `/home/rauter/code/cs-webrtc/goal-webrtc-host-multiplayer.md`
- `/home/rauter/code/cs-webrtc/docs/botpipe/signaling-abuse-hardening.goal.md`
- `/home/rauter/code/cs-webrtc/src/net/broadcastTransport.ts`
- `/home/rauter/code/cs-webrtc/src/net/iceServers.ts`
- `/home/rauter/code/cs-webrtc/src/net/manualSignaling.ts`
- `/home/rauter/code/cs-webrtc/src/net/matchRoomConnection.ts`
- `/home/rauter/code/cs-webrtc/src/net/protocol.ts`
- `/home/rauter/code/cs-webrtc/src/net/signaledWebRtcTransport.ts`
- `/home/rauter/code/cs-webrtc/src/net/signalingConfig.ts`
- `/home/rauter/code/cs-webrtc/src/net/transport.ts`
- `/home/rauter/code/cs-webrtc/src/net/webrtcStats.ts`
- `/home/rauter/code/cs-webrtc/src/net/webrtcTransport.ts`
- `/home/rauter/code/cs-webrtc/src/game/sharedShotValidation.ts`
- `/home/rauter/code/cs-webrtc/workers/signaling/src/index.js`
- `/home/rauter/code/cs-webrtc/workers/signaling/wrangler.jsonc`

## Canonical Invariants To Preserve

These must survive every later subgoal:

- Preserve `AGENTS.md` exactly as the project contract. Do not delete or weaken it.
- Preserve canonical controls:
  - `WASD` move
  - `Shift` crouch
  - optional `Ctrl` classic crouch alias
  - `Space` jump
  - `E` objective interaction
  - left click fire
  - `R` reload
  - hold `Tab` operations board
  - viewport fullscreen button and `Alt+Enter`
  - `M` map select
  - `Esc` pointer-lock/fullscreen release path
- Preserve pointer-lock input gating and browser-safe keyboard behavior.
- Preserve canonical teams and terminology:
  - `Amber Vanguard`
  - `Cobalt Reach`
- Preserve typed map and mission metadata in `src/data/maps.ts` and the current map roster.
- Preserve modular gameplay ownership in `src/game/`, especially movement, rounds, bomb, hostage, AI, controls, teams, and bot difficulty modules.
- Preserve solo AI and solo difficulty options `easy` / `medium` / `hard`, with `medium` as the clean-load default plus storage restore behavior.
- Preserve current HUD structure, held-`Tab` operations board, and viewport fullscreen shell.
- Preserve current solo/local fallback behavior when `BroadcastChannel` or network features are unavailable.
- Preserve browser-only static-site compatibility with `npm install && npm run build` publishing `dist`.
- Preserve `three` as the only runtime dependency.

## What Can Be Transplanted Mostly As-Is

These source assets are structurally separate enough to copy first, then adjust only where target types or config differ:

- `src/net/broadcastTransport.ts`
- `src/net/iceServers.ts`
- `src/net/manualSignaling.ts`
- `src/net/protocol.ts`
- `src/net/signalingConfig.ts`
- `src/net/transport.ts`
- `src/net/webrtcStats.ts`
- `src/net/webrtcTransport.ts`
- `workers/signaling/src/index.js`
- `workers/signaling/wrangler.jsonc`
- Targeted QA helpers whose purpose is already isolated around signaling and transport:
  - `scripts/qa/runWithLocalSignalingWorker.mjs`
  - `scripts/qa/signalingWorkerProbe.mjs`
  - `scripts/qa/cloudSignalingVerification.mjs`
  - `scripts/qa/manualSignalingVerification.mjs`

Expected adaptation even on these copies:

- align import paths and strict TypeScript expectations
- keep client-side and Worker-side signaling caps consistent
- exclude generated `.wrangler` runtime state
- keep public configuration free of secrets

## What Requires Careful Adaptation

These surfaces cannot be overwritten from `cs-webrtc` without regressing canonical gameplay:

- `src/net/matchRoomConnection.ts`
  - source assumes protocol-level `alpha` / `bravo` / `observer` team assignment and a room lifecycle that must be mapped onto canonical `TeamId`, round phases, and mission state
- `src/game/localMatch.ts`
  - canonical file already owns movement, round shell, missions, AI, HUD snapshots, pointer-lock behavior, and QA hooks
  - networking must wrap canonical gameplay instead of replacing it
- `src/game/sharedShotValidation.ts`
  - source module is promising, but it must adapt to canonical collision, team ids, round validity, weapon state, and player/bot state
- `src/ui/app.ts`, `src/ui/templates.ts`, `src/styles.css`
  - room setup and connection state must fit the current compact shell instead of reverting to the older overlay-heavy multiplayer UI
- `src/main.ts`
  - QA hooks must expand to expose network verification without removing current local-play hooks used by `scripts/qa/finalVerification.mjs`
- `src/data/maps.ts` and `src/types.ts`
  - network snapshots and objective sync must respect the canonical typed map, spawn, route, bomb-site, hostage-cluster, and mission declarations
- `src/game/audio.ts`, `src/game/avatar.ts`, `src/game/collision.ts`
  - remote world-fire audio, avatar pose replication, and host-side line-of-sight checks must be merged without regressing current solo/shared behavior
- `package.json`
  - add network QA scripts while preserving canonical `build`, `typecheck`, `test`, and `qa:final` semantics
- `docs/*`
  - keep canonical gameplay and feel docs, then extend them with multiplayer architecture and QA evidence instead of replacing them with stale source phrasing

## Source Assumptions To Reject

The merge must explicitly reject these stale or invalid `cs-webrtc` assumptions:

- deleting `AGENTS.md`
- deleting canonical gameplay modules and folding behavior back into a simplified multiplayer branch
- `Shift` sprint
- `Space` fire
- any removal of jump, crouch, objective interaction, held-`Tab` operations board, or viewport fullscreen behavior
- any reversion to old terminology or stale docs that do not match the current project contract
- large overlay-centric UI that displaces the canonical compact match shell
- gameplay relaying through the signaling Worker
- any Worker or client design that treats Cloudflare as the gameplay transport instead of signaling only
- committing `dist`
- committing `workers/signaling/.wrangler/cache`
- committing `workers/signaling/.wrangler/state`
- committing any other generated runtime artifacts, screenshots-as-source, cache files, or local SQLite state
- committing Cloudflare credentials, account ids, Metered secret keys, API keys, or other deployment secrets
- replacing canonical team names or reintroducing blocked Counter-Strike terms like `Terrorist`, `Counter-Terrorist`, `de_`, or `cs_`

## Generated And Secret-Bearing Artifacts To Exclude

Never transplant these source-side artifacts into the target branch:

- `workers/signaling/.wrangler/cache/**`
- `workers/signaling/.wrangler/state/**`
- `dist/**`
- local Worker caches, Durable Object SQLite state, or preview artifacts
- any `.env`-style secret material not already part of the canonical target

Allowed Worker source surface:

- `workers/signaling/src/index.js`
- `workers/signaling/wrangler.jsonc`

Worker secret policy:

- no committed Cloudflare tokens
- no committed account identifiers beyond public service URLs already documented
- no committed Metered secret keys
- TURN credentials may be described conceptually, but actual credential values must stay out of source control

## Adaptation Plan

1. Add the isolated network modules under `src/net/` and the Worker source/config under `workers/signaling/`, excluding `.wrangler` state.
2. Merge network QA helper scripts and `package.json` entries so the transport and Worker can be validated independently from the gameplay runtime.
3. Introduce or adapt connection-layer bridging between source room protocol concepts and canonical gameplay concepts:
   - source `alpha` / `bravo` room teams to canonical `Amber Vanguard` / `Cobalt Reach`
   - source room snapshots to canonical player, round, bomb, and hostage state
   - source room lifecycle to canonical briefing / active / resolution-reset flow
4. Integrate room-entry UI into the current `TacticalShellApp` and templates without regressing team select, bot difficulty, classic crouch alias, or the current menu-to-stage flow.
5. Merge host-authoritative room behavior into canonical `LocalMatch` incrementally:
   - connection bootstrap
   - roster and remote avatar replication
   - guest input and host snapshots
   - authoritative shot validation
   - objective and round synchronization
6. Extend QA hooks in `src/main.ts` and the runtime so both the canonical local-flow suite and the new multiplayer suites can run against the same build.
7. Update README and QA/docs only after the runtime path matches the shipped behavior.

## Validation Plan For Later Subgoals

Required commands before the parent goal can close:

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

Required terminology, secret, and generated-artifact sweeps before final close:

```bash
rg -n "sprint|Shift.*sprint|Space.*fire|Terrorist|Counter-Terrorist|de_|cs_" README.md docs src
rg -n -i "account_id|api[_-]?key|client_secret|turnstile|credential|secret_access|workers_dev_token|cloudflare_api" workers/signaling src docs package.json
git status --short
```

## Immediate Merge Guidance

- Start from the canonical target structure, not from the multiplayer branch structure.
- Treat `src/net/` and the signaling Worker as the first safe landing zone.
- Treat `src/game/localMatch.ts` as the highest-risk file and keep it structurally canonical.
- Preserve existing QA hooks until replacement evidence exists.
- Do not mark the parent goal complete from this plan step.
