Implement near-free internet multiplayer for CSMini using a static-site-compatible browser-host architecture.

Context:
- This work is on the independent branch/worktree `feature/webrtc-host-multiplayer` at `/home/rauter/code/cs-webrtc`.
- Do not modify or depend on the separate local `/home/rauter/code/cs` worktree.
- The current app is a Vite/TypeScript/Three.js browser-only tactical FPS prototype.
- It is deployed as a Render static site, so the primary solution must keep static hosting viable.
- The goal is hobby-scale multiplayer with nearly zero hosting cost, good feel, and acceptable trust for friends/small rooms.
- Do not introduce a paid or always-on authoritative game server.
- Do not copy Counter-Strike assets, names, maps, UI, sounds, or exact data.

Target architecture:
- Keep Render/static hosting for the frontend.
- Add WebRTC DataChannel multiplayer where one browser tab is the room host.
- Host owns canonical match state: players, teams, health, deaths, round state, objective state, AI state, and accepted damage.
- Clients predict/render locally for feel, but send compact input/intent messages to host.
- Host validates movement/commands enough to keep the room coherent.
- Host validates shots with bounded rewind, line-of-sight, weapon timing, ammo/reload state, spread/miss rules, and plausible aim.
- Clients may show provisional local shooting feedback, but only host-accepted events change real health, score, round outcome, or mission state.
- Keep the current BroadcastChannel same-browser mode as a local/dev transport if useful, but the new WebRTC path must support separate browsers/devices when WebRTC connectivity is possible.
- Add manual copy-paste offer/answer signaling as the zero-backend baseline.
- Add a clean abstraction for an optional future tiny signaling service, but do not require one for the feature to work.
- Do not implement witness/checkpoint host migration yet unless the core host-client WebRTC path is already stable; document it as a follow-up.

Implementation requirements:

1. Transport architecture
- Add a focused networking layer, likely under `src/net/`, with a transport abstraction that separates:
  - local same-browser transport, if retained
  - WebRTC peer transport
  - room/session message protocol
  - manual signaling UI state
- Define typed network messages for:
  - join/accept/reject
  - player identity and team assignment
  - input ticks
  - host snapshots
  - shot claims
  - shot validation result
  - objective/round events
  - ping/heartbeat/disconnect
- Keep messages compact and versioned enough that invalid or stale messages can be rejected safely.

2. Manual WebRTC room flow
- Add UI to create a hosted room:
  - host generates an offer blob/code
  - joining client pastes offer and generates answer blob/code
  - host pastes answer and connection opens
- Add UI to join a room:
  - paste host offer
  - generate answer
  - wait for host to complete connection
- Provide clear connection status, error states, and copy buttons.
- The flow should be understandable without accounts, backend, or command-line steps.
- The feature may be optimized for two-player first, but the protocol should not be designed in a way that blocks small-room expansion.

3. Host-authoritative match model
- Host is the only side that can accept:
  - health changes
  - deaths
  - respawns/round resets
  - objective progress
  - score/round outcome
  - AI behavior and AI damage
- Clients send inputs and shot claims, not authoritative state.
- Host broadcasts snapshots frequently enough for playable remote movement while avoiding wasteful full-state spam.
- Clients interpolate remote snapshots and keep local player prediction responsive.
- Handle disconnects gracefully:
  - host disconnect tells clients the room ended
  - client disconnect removes that player from host roster
  - UI returns to a recoverable state

4. Shot validation and low-latency feel
- Shooter client shows immediate local recoil, muzzle flash, sound, and provisional hit feedback.
- Shot claim packet must include enough information for validation:
  - shooter id
  - tick/time
  - origin
  - aim direction
  - weapon state
  - ammo/reload counter or command sequence
  - spread/random seed or deterministic spread index
  - recent input sequence/tick
- Host keeps a short rewind buffer of player transforms/capsules and collision context.
- Host validates:
  - line of sight against map collision/cover
  - fire rate
  - ammo/reload state
  - plausible aim delta
  - weapon spread/miss chance
  - target/team/round validity
  - max accepted latency window
- Host broadcasts accepted/rejected/adjusted hit results.
- Rejected provisional feedback must not leave real health/score changed.

5. Game behavior preservation
- Existing local solo play must still work.
- Existing current Render static build path must still work:
  - `npm install && npm run build`
  - publish `dist`
- Existing menu/map roster/match loop must remain usable.
- Existing QA hooks may be extended but should not be removed if the current final QA depends on them.
- Keep the project lightweight. Avoid adding heavy networking/game-engine dependencies.

6. Code organization
- Do not pile all multiplayer work into `src/game/localMatch.ts`.
- If localMatch is currently too broad, introduce focused modules rather than expanding it blindly.
- Suggested ownership boundaries:
  - `src/net/`: transport, WebRTC signaling helpers, message types
  - `src/game/`: host validation, snapshots, shot validation, room integration
  - `src/ui/`: create/join room UI and connection status
  - `scripts/qa/`: multiplayer smoke tests
  - `docs/`: architecture and testing notes
- Maintain TypeScript strictness and avoid `any` except where unavoidable at browser API boundaries.

7. Testing and validation
- `npm run typecheck` must pass.
- `npm run build` must pass.
- `npm test` must pass, or the test script must be intentionally updated to include the new multiplayer validation and then pass.
- Add browser-level QA coverage for at least:
  - Create-room manual signaling state can generate an offer.
  - Join-room manual signaling state can generate an answer from an offer.
  - Two browser contexts can connect through WebRTC in automation if browser support allows it.
  - Host accepts a joined client and assigns/records player identity.
  - Client input reaches host.
  - Host snapshot reaches client.
  - Client shot claim cannot directly mutate health without host acceptance.
  - Host accepts a valid shot in a clear line-of-sight setup.
  - Host rejects a shot through a wall/obstacle.
  - Host rejects impossible fire-rate/ammo/reload claims.
  - Disconnect removes remote player or ends room cleanly.
- If full WebRTC automation is blocked in headless Chrome, write the strongest feasible deterministic tests around message protocol, signaling state, and shot validation, and document the remaining manual browser test steps.

8. Documentation
- Update README with:
  - how to use browser-host multiplayer
  - how to create a room
  - how to join via manual offer/answer
  - what is host-authoritative
  - what is still trusted/social
  - limitations of WebRTC/NAT/manual signaling
- Add or update docs explaining:
  - near-free architecture
  - why there is no always-on server
  - what the host validates
  - what clients predict
  - future path for optional tiny signaling and witness/checkpoint migration
- Record validation commands and observed results.

Acceptance criteria:
- A user can open the static site, create a browser-hosted multiplayer room, and obtain a shareable offer/answer flow without any paid backend.
- A second browser context can join through WebRTC when connectivity permits.
- The host can see the remote player in roster/state and receive input.
- The client receives host snapshots and can render or represent the host-authoritative room state.
- Shooting uses client-local provisional feel but host-authoritative damage.
- At least one clear LOS shot acceptance and one blocked LOS shot rejection are proven by tests or durable QA evidence.
- The app still works as a static site and local solo game.
- The implementation is reviewable, typed, and modular enough to continue toward teams/objectives later.
- The final report explicitly states what works, what was verified, what remains manual, and what limitations remain.

Do not deploy to Render or merge to main as part of this run unless explicitly asked later.
