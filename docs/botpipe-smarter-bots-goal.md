# Botpipe Goal: Smarter Bots With Player-Equivalent Mechanics

Implement a focused tactical-AI pass for Dustline Protocol that makes solo bots smarter while putting them on the same movement and mechanics contract as the player.

Read `AGENTS.md`, `README.md`, `docs/visual-target.md`, `docs/assets.md`, `docs/qa/*.md`, `src/game/playerMovement.ts`, `src/game/tacticalAi.ts`, `src/game/localMatch.ts`, and `scripts/qa/finalVerification.mjs` before editing. This repo is a browser-only Vite/TypeScript/Three.js tactical FPS prototype inspired by CS 1.5-era feel. Preserve original assets, names, teams, UI, sounds, and maps.

## Current Understanding

- Player movement is centralized in `src/game/playerMovement.ts`:
  - walk speed `PLAYER_WALK_SPEED = 8.6`
  - crouch multiplier `0.56`
  - air control `0.78`
  - gravity `13.6`
  - jump velocity `5.25`
  - crouch blend, grounded/airborne state, body height, collision-safe horizontal movement
- Current solo enemies in `src/game/localMatch.ts` are behaviorally tactical but mechanically separate:
  - bot speed is `ENEMY_SPEED = 2.35`, much slower than player walk speed
  - bot movement directly resolves horizontal deltas toward targets instead of using a bot/player shared movement state
  - bot stance is `standing | crouched`, but there is no bot-owned crouch blend, grounded state, vertical velocity, jump request, air control, or landing state
  - bots do not use the same jump/crouch mechanics as players
- Current AI already has useful tactical primitives:
  - behaviors: `objective`, `patrol`, `investigate`, `pursue`, `reposition`, `engage`
  - roles: `anchor`, `route`, `flank`
  - visibility sampling and line-of-sight blockers
  - deterministic shot profile and miss model affected by range, visibility, movement, crouch, and target speed
  - map tactical anchors, patrol routes, objective anchors, and cover/reposition choices
- There is currently no bot difficulty setting.
- `docs/qa/multiplayer.md` notes that tactical-AI multiplayer behavior is outside current coverage; this pass should stay focused on solo-local bots unless a shared-room fallback naturally uses local bots.

## Design Direction

The right fix is not to make bots faster through another bot-only constant. Bots should use the same movement constants and physical mechanics as the player, then make tactical choices that produce input-like intent:

- desired movement direction
- crouch intent
- jump intent
- hold/peek/reposition intent
- aim/fire/reload intent
- objective-interaction intent

Difficulty should affect perception delay, reaction time, aim/spread, memory, coordination, burst discipline, and tactical choices. Difficulty must not grant wall vision, impossible speed, instant turns, perfect aim, or movement mechanics the player cannot perform.

## Goal

Make solo bots feel like more believable classic tactical FPS opponents:

- They move with the same base speed and mechanics as players.
- They can crouch, jump, become airborne, land, and collide through the same movement rules or a clearly shared equivalent.
- They make smarter tactical decisions around objectives, cover, sound, last-known positions, peeking, holding, repositioning, and pressure.
- They support exactly three bot levels: `easy`, `medium`, and `hard`.
- `medium` is the default everywhere.
- The implementation remains browser-only, lightweight, deterministic enough for QA, and compatible with Render static deployment.

## Required Behavior

### 1. Add Bot Difficulty

- Add a typed difficulty model, for example `BotDifficulty = "easy" | "medium" | "hard"`.
- Default must be `medium`.
- Expose the current difficulty through the match debug snapshot.
- Provide a player-facing way to choose difficulty for solo play. Keep it compact and consistent with the current menu/catalog/match controls. Do not make the game UI feel like a SaaS settings dashboard.
- Persisting the choice in `localStorage` is acceptable, but storage failure must not break the game.
- Shared-room mode should not imply real network bots. If difficulty only affects solo-local bots, say so in UI/docs.
- Add QA hooks if needed so `scripts/qa/finalVerification.mjs` can set and verify each difficulty deterministically.

### 2. Bots Use Player-Equivalent Movement Mechanics

- Remove hidden bot-only movement advantages or penalties as the source of core locomotion.
- Bots must share the player movement constants:
  - walk speed `8.6u/s`
  - crouch speed derived from the same `PLAYER_CROUCH_MULTIPLIER`
  - same radius/body-height assumptions unless a visible avatar size difference justifies a documented exception
  - same gravity, jump velocity, grounded/airborne state, air control, and landing behavior
- Prefer extracting a shared movement helper from `src/game/playerMovement.ts` rather than duplicating physics in `localMatch.ts`.
- Bots should have their own movement state:
  - crouch blend
  - vertical velocity
  - grounded/airborne
  - body height and eye height derived from stance/crouch blend
  - jump request / jumped / landed result
- Bot movement should be generated from AI intent and passed through the shared mechanics:
  - move toward tactical target
  - crouch when holding cover, partial visibility, defusing/planting/guarding, or steadying fire
  - jump only when useful and readable, such as small obstruction handling, unstick recovery, or tactical route traversal if a map route needs it
- Do not add sprint. Do not add bunnyhop/parkour behavior. Jump should remain committed and limited, matching the player feel contract.
- Bot animation/posture must reflect crouch and airborne state. Alive bots must remain upright above ground while weapon pitch continues to apply only to the gun.

### 3. Make Bots Smarter Without Cheating

Improve the tactical controller while preserving the current readable CS 1.5-inspired feel:

- Perception:
  - respect line-of-sight blockers and visibility fractions
  - hear player movement/fire through existing noise model, with difficulty-dependent confidence/delay
  - remember last-known player positions for a bounded time
  - communicate contact to squadmates with a small delay, not instant omniscience
- Movement and positioning:
  - use tactical anchors and route metadata to hold, patrol, flank, investigate, pursue, and reposition
  - avoid standing still in the open when under pressure
  - prefer cover or off-angles after firing, taking damage, losing sight, or reloading
  - do not jitter rapidly between states; state transitions need cooldowns/hysteresis
  - handle stuck cases through route replanning or a rare jump/step attempt, not teleporting
- Combat:
  - keep non-perfect aim with hits and misses
  - use short readable bursts rather than constant perfect fire
  - crouch can improve bot steadiness but should commit movement speed just like the player
  - hard bots may react faster and pick better angles, but still miss sometimes
  - easy bots should be slower to react and make more positioning/aim mistakes, but still use the same movement mechanics
- Objective play:
  - bots should respect bomb and hostage mission pressure, not only chase the player
  - defenders should prioritize site/hostage defense, rotations, and planted-bomb defuse opportunities when appropriate
  - attackers/rescuers should pressure objective space when the round requires it
  - if implementing full bot plant/defuse/rescue is too large, make that limitation explicit in docs and provide a clear follow-up path. Still ensure objective-aware positioning improves in this pass.

### 4. Difficulty Tuning Contract

All difficulty levels must use the same movement mechanics and max movement constants as the player. Difficulty changes tactical quality and combat readability, not physical rules.

Suggested tuning dimensions:

- `easy`
  - longer perception and reaction delays
  - lower hit chance / wider spread
  - shorter memory
  - less reliable cover choice
  - slower squad communication
  - more likely to hold predictable angles
- `medium` default
  - current intended baseline feel
  - believable patrol/investigate/engage/reposition behavior
  - clear misses under movement, range, crouch, or partial visibility
  - moderate objective awareness
- `hard`
  - faster but still human-readable reaction
  - better cover and off-angle selection
  - better burst discipline
  - longer but bounded memory
  - more decisive objective pressure
  - no wall vision, no instant perfect shots, no hidden speed boost

## Implementation Guidance

- Keep changes scoped and modular. `src/game/localMatch.ts` is already large; move reusable bot mechanics into focused modules where practical.
- Likely modules to touch or add:
  - `src/game/playerMovement.ts` or a new shared movement adapter
  - `src/game/tacticalAi.ts`
  - `src/game/localMatch.ts`
  - `src/ui/templates.ts`
  - `src/ui/app.ts`
  - `src/styles.css`
  - `scripts/qa/finalVerification.mjs`
  - `README.md`
  - relevant `docs/qa/*.md`
- Avoid adding runtime dependencies. `three` should remain the only runtime dependency.
- Preserve current browser-safe controls and pointer-lock/input-capture behavior.
- Preserve same-browser `BroadcastChannel` shared-room limits. Do not introduce a server or matchmaking backend.
- Preserve original team names, map names, audio, geometry, and UI.
- Do not deploy unless explicitly asked.

## QA And Acceptance Criteria

Update `scripts/qa/finalVerification.mjs` rather than bypassing it. Add deterministic QA hooks only when necessary.

Required verification:

- `npm run typecheck` passes.
- `npm run build` passes.
- `npm test` passes.
- QA proves default difficulty is `medium`.
- QA can select or force `easy`, `medium`, and `hard`, and the debug snapshot reports the selected value.
- QA proves bot movement uses player-equivalent movement constants:
  - bot tuning reports walk speed `8.6`
  - bot crouch speed derives from `PLAYER_CROUCH_MULTIPLIER`
  - bot jump sample has a grounded start, airborne phase, peak height, and safe landing comparable to the player jump sample
- QA proves bots can crouch during a tactical state and that crouch changes their eye/body height and movement speed.
- QA proves bots still remain upright and above ground while crouching, jumping, landing, aiming, patrolling, engaging, repositioning, and pursuing.
- QA preserves the blocked line-of-sight case:
  - bots cannot see or shoot through the staged blocker
  - they may investigate sound/contact without wall-firing
- QA preserves hit/miss readability:
  - easy, medium, and hard produce ordered shot-profile differences where hard is more dangerous than medium and medium more dangerous than easy
  - no level reaches perfect aim
- QA proves smarter behavior:
  - at least one bot chooses cover or a new angle after pressure
  - at least one bot investigates sound, then pursues last-known position after losing sight
  - at least one bot demonstrates objective-aware positioning or interaction in a live round
- QA verifies a bounded solo round still resolves without deadlock.
- Update docs to explain:
  - bot difficulty levels
  - medium default
  - bots using player-equivalent movement mechanics
  - any remaining AI limitations

If screenshots or visible UI settings change materially, refresh the screenshot artifacts through the QA harness.

## Done Criteria

- A local solo round has smarter, readable bots that move, crouch, jump, hold, investigate, pursue, reposition, and fight through the same movement mechanics as the player.
- `easy`, `medium`, and `hard` exist, with `medium` default.
- Difficulty changes are observable and documented without granting unfair hidden mechanics.
- Browser QA covers the new movement/mechanics contract, difficulty selection, line-of-sight safety, shot readability, and bounded round completion.
- The final report lists changed files, validation commands, and remaining risks or deferred AI limitations.

## Botpipe CLI

Run from the repository root:

```bash
botpipe run goal \
  --workspace /home/rauter/code/cs \
  --provider codex \
  --model gpt-5.5 \
  --task smarter-bots-player-mechanics \
  "$(cat docs/botpipe-smarter-bots-goal.md)"
```
