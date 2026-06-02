# Botpipe Goal: Human-Like Map-Aware Solo Bots

Implement a deep tactical-AI improvement pass for Dustline Protocol so solo bots play more like believable human opponents in a classic CS 1.5-era tactical FPS homage.

This is not a generic "make bots harder" task. First analyze and understand the current AI, maps, collision, objective systems, QA hooks, and user-reported failure modes, then plan the best practical solution for this repo before editing code. The solution should improve bot navigation, stuck recovery, map knowledge, tactical strategy selection, objective pressure, and mid-round adaptation while preserving browser-only constraints and the existing CS 1.5-inspired feel.

## Required Reading Before Editing

Read these files before making code changes:

- `AGENTS.md`
- `README.md`
- `docs/visual-target.md`
- `docs/assets.md`
- `docs/qa/local-play.md`
- `docs/qa/classic-feel.md`
- other relevant `docs/qa/*.md`
- `src/data/maps.ts`
- `src/game/tacticalAi.ts`
- `src/game/localMatch.ts`
- `src/game/playerMovement.ts`
- `src/game/collision.ts`
- `src/game/botDifficulty.ts`
- `src/game/botDifficultyTuning.ts`
- `src/game/bombState.ts`
- `src/game/hostageState.ts`
- `src/game/rounds.ts`
- `scripts/qa/finalVerification.mjs`

Preserve all project constraints: browser-only Vite/TypeScript/Three.js, `three` as the only runtime dependency, no server requirement, original assets/names/maps/UI/sounds, no Counter-Strike content copying, no sprint layer, no heavy engine, and no deployment unless explicitly asked.

## Current Baseline

The existing implementation already has important foundations:

- Solo bot difficulty exists: `easy`, `medium`, `hard`, with `medium` default.
- Bots use the shared player-equivalent movement contract for walk, crouch, jump, gravity, body/eye height, and collision.
- Current behaviors include `objective`, `patrol`, `investigate`, `pursue`, `reposition`, and `engage`.
- Current tactical primitives include anchors, route anchors, focus anchors, objective anchors, visibility checks, line-of-sight blockers, last-known player memory, delayed squad contact, burst fire, difficulty-dependent tuning, and limited stuck recovery.
- QA already verifies difficulty, shared movement, crouch/jump, line-of-sight blocking, delayed contact, hit/miss readability, enemy-side objective pressure, and one bounded solo round resolution.

Treat those as useful foundations. Do not redo them unless analysis proves they are the cause of the remaining failures.

## User-Reported Problems To Investigate

Analyze these specific observed problems and reproduce or reason about them from code and QA:

- Bots get stuck against geometry or places they cannot pass through.
- When stuck, bots do not reliably rotate, back out, choose another route, or commit to a sensible fallback.
- Bots appear to lack real map/path knowledge; they move toward targets as if a direct line is always viable.
- Bots may repeatedly jump in the same spot or at the same obstruction, becoming predictable and vulnerable.
- Bots expose themselves to shots from behind or beside walls because they do not understand the tactical risk of a position.
- Bots can remain too synchronized or simplistic instead of each bot using an independent strategy.
- Bots do not always change strategy when the objective state, player position, health, teammate status, or round phase changes.
- Bots should be able to rotate, hold, probe, flank, fall back, guard objectives, investigate, pursue, or disengage depending on the live situation.

## Mandatory Analysis And Planning Step

Before implementation, produce a concise analysis and plan artifact in the Botpipe run output and, if useful for repo history, in `docs/qa/` or another appropriate docs path.

The analysis must cover:

- Current bot navigation model: direct movement, patrol anchors, reposition anchors, stuck tracking, recovery jumps, forced directives, and collision response.
- Current map knowledge: what route/focus/objective metadata exists in `src/data/maps.ts`, what is missing for pathfinding, and how it can be converted into reliable navigation without adding a heavy engine.
- Current failure causes: why direct movement can push bots into impassable geometry, why current recovery can fail, and why repeated jump recovery can make bots vulnerable.
- Strategy model gaps: what state each bot currently tracks, where independent role/strategy selection is too shallow, and what live signals should influence strategy changes.
- Objective-specific gaps for Relay Charge and Evac Escort.
- QA gaps: what deterministic hooks or browser harness assertions are needed to prove the new behavior without faking the gameplay.

The plan must justify the chosen approach and reject weaker alternatives. Prefer the simplest robust solution that fits this codebase. Do not start with a full navmesh or imported pathfinding dependency unless analysis proves no lighter option will work.

## Core Goal

Make solo bots feel like map-aware human opponents:

- They know the declared map routes and use them to move around blockers instead of walking straight into walls.
- They recover from blocked movement by rotating, backing out, selecting nearby route nodes, or replanning to a reachable waypoint.
- They avoid repeated jump loops; jumping is rare, committed, and only used when tactically justified or as a bounded recovery attempt.
- They choose positions with cover, visibility, objective pressure, flank value, and escape routes in mind.
- Each bot can run an independent strategy based on role, map, objective, health, player contact, teammate contact, bomb/hostage state, time pressure, and round phase.
- Bots can switch strategies mid-round when the situation demands it.
- They still miss, hesitate, commit to crouch/jump tradeoffs, and remain readable rather than becoming perfect or omniscient.

## Navigation And Pathfinding Requirements

Implement map-aware navigation using lightweight route knowledge derived from existing map metadata and collision.

Required behavior:

1. Build a tactical navigation graph or equivalent route planner.
   - Use existing `map.tacticalRoutes`, `scene.focusPoints`, team spawns, bomb sites, hostage clusters, extraction zones, and collision-opened anchor positions.
   - Connect anchors only when the segment is traversable or accepted by collision/line checks.
   - Include enough intermediate route nodes to avoid direct-line failures on current maps.
   - Keep the implementation lightweight and deterministic.
   - Do not add runtime dependencies.

2. Route to tactical targets through waypoints.
   - Bots should path to objectives, last-known positions, sounds, recovery targets, cover anchors, flank anchors, and patrol points using route graph waypoints rather than only direct vectors.
   - If the direct route is clear, direct movement is acceptable.
   - If direct movement is blocked, the bot should select the next graph waypoint or replan.

3. Detect and classify stuck cases.
   - Track intended movement, actual movement, target distance progress, repeated collision direction, failed jump attempts, and time spent near the same blocked position.
   - Distinguish "arrived", "holding", "blocked by geometry", "blocked by tactical choice", and "temporarily slowed by crouch/jump/airborne state".
   - Avoid treating valid holds, crouched peeks, planting/defusing/securing, and objective guarding as stuck.

4. Recover from stuck cases like a human.
   - First rotate/strafe/back out briefly if the bot is wedged against a local obstruction.
   - Then replan through a nearby reachable anchor or alternate lane.
   - Use a jump only as a rare bounded recovery attempt, with a cooldown and failed-jump memory.
   - Do not teleport.
   - Do not spam the same jump or recovery target.
   - Expose recovery state in debug snapshots.

5. Prevent predictable jump vulnerability.
   - Add per-bot memory of recent jump locations/reasons.
   - If a jump recovery does not improve position or route progress, suppress repeated jumps at that obstruction for a bounded time.
   - Prefer crouch/strafe/route change over jumping when the bot is under fire or near a wall that exposes it.

## Human-Like Strategy Requirements

Add or improve a strategy layer above raw behaviors. A bot strategy is a medium-term intent that can choose behavior, stance, route, and target selection.

Suggested strategies:

- `anchor_site`: hold an objective or defensive angle.
- `route_probe`: clear a route slowly and investigate sound/contact.
- `flank_rotate`: take an alternate lane toward last-known/player/objective pressure.
- `pressure_objective`: move decisively toward bomb/hostage objective when time or role requires it.
- `cover_reposition`: break line of sight, reload/recover, and take a new angle.
- `pursue_contact`: chase last-known information for a bounded time.
- `fallback_guard`: back out from low-health or exposed positions and guard a chokepoint.
- `escort_or_defuse`: commit to hostage extraction, bomb plant, or defuse only when tactically plausible.

You may choose different names, but the implementation must support equivalent behavior.

Each bot should evaluate strategy from:

- role: anchor, route, flank, carrier/rescuer/defuser if applicable
- map and route metadata
- current objective mode and phase
- bomb state: carried, planting, planted, defusing, resolved
- hostage state: awaiting rescue, securing, escorting, extracting, resolved
- round phase and remaining time
- health and recent damage
- ammo/reload/fire cadence if available
- player visibility, last-known position, sound contact, and lost-sight timing
- teammate contacts and current teammate strategies
- distance to objective, cover, escape route, and teammate support
- current difficulty tuning

Strategy switching must have hysteresis/cooldowns so bots do not jitter between strategies every frame. Urgent events such as being shot, seeing the player, bomb planted, low fuse time, or hostage extraction progress can override the cooldown.

## Independent Bot Behavior Requirements

Bots should not all make the same decision at the same time unless the objective forces it.

Required behavior:

- Assign or derive distinct squad roles at round start and after objective phase changes.
- Use per-bot deterministic variation seeded by bot id/map/round so QA remains stable.
- Avoid all bots selecting the same route anchor, same cover anchor, or same recovery target when alternatives exist.
- Allow one bot to anchor while another rotates, another investigates, and another pressures objective.
- Share information with existing delayed communication; do not grant instant omniscience.
- Preserve difficulty differences as tactical quality, not physical advantages.

## Objective-Specific Requirements

Relay Charge:

- Attackers should route the carrier toward valid bomb sites using route graph waypoints.
- Non-carrier attackers should escort, screen, flank, or hold angles near the carrier/site.
- Defenders should guard likely approach lanes, rotate to a planted charge, and attempt defuse when plausible.
- A planted charge should change strategy priorities immediately.
- Bots must not abandon objective pressure just because a stale sound happened far away.

Evac Escort:

- Rescuers should route to hostage clusters, secure hostages, escort along declared route metadata, and extract when plausible.
- Defenders should hold or rotate around hostage clusters, extraction lanes, and chokepoints.
- Bots should not get stuck trying to walk directly through blockers to hostages/extraction.
- Hostage escort strategy should respect route progress and danger.

If full human-like objective execution is too large for one pass, implement the highest-impact slice and document the remaining limitation with a specific follow-up path. Do not leave objective behavior worse than the current baseline.

## Combat And Exposure Requirements

Improve tactical survivability without making bots unfair:

- Prefer cover/off-angles after taking damage, finishing a burst, losing sight, reloading, or being exposed in the open.
- Avoid choosing cover positions that expose the bot to known player lines without a reason.
- When behind a wall or partial blocker, bots should hold, shoulder-peek, rotate, or investigate rather than jumping in place.
- Bots must not shoot through blockers.
- Bots must not get wall vision from route graph knowledge.
- Hard bots may choose better routes/angles faster, but still miss and remain readable.
- Easy bots should make more tactical mistakes while still using the same navigation system.

## Implementation Guidance

Keep `src/game/localMatch.ts` from growing casually. Prefer focused modules where practical, for example:

- `src/game/tacticalAi.ts` for strategy scoring and tactical decisions.
- a new `src/game/tacticalNavigation.ts` for graph construction, waypoint planning, route scoring, and stuck classification.
- `src/game/botDifficultyTuning.ts` for tuning values.
- small integration changes in `src/game/localMatch.ts`.
- QA hooks in `scripts/qa/finalVerification.mjs` only where needed to prove real behavior.

Do not introduce a second movement model. Bots must keep using `updateSharedMovement()` and the current player-equivalent movement constants.

Do not add:

- sprint
- bunnyhop/parkour behavior
- real network multiplayer bots
- backend matchmaking
- external assets
- copied Counter-Strike content
- heavy pathfinding/game-engine dependencies

## Debug Snapshot And QA Hook Requirements

Expose enough debug information for deterministic QA:

- bot current strategy
- current behavior and stance
- current route/waypoint target
- planned path labels or ids
- stuck state classification
- recovery action and recovery count
- recent failed jump suppression state
- selected cover/reposition reason
- objective-specific intent, such as carrier escort, defuse rotate, hostage escort, extraction guard
- per-bot role and deterministic variation seed or profile

Add QA hooks only if needed. Hooks must stage realistic live states and then verify shipped behavior, not bypass the AI logic being tested.

## Required Verification

Run:

- `npm run typecheck`
- `npm run build`
- `npm test`

Update `scripts/qa/finalVerification.mjs` instead of bypassing it when accepted runtime behavior changes.

QA should prove at least:

- Default difficulty remains `medium`.
- Bots still use player-equivalent movement constants.
- Bots still crouch, jump, land, and remain upright above ground.
- Bots do not see or shoot through a known blocker.
- Stuck recovery no longer repeats the same jump at the same obstruction.
- A blocked direct route causes rotate/back-out/replan/path waypoint behavior instead of deadlock.
- At least one bot uses a route graph or planned waypoint path around geometry to reach a tactical target.
- At least two bots choose different strategies or routes in the same live round when alternatives exist.
- A bot changes strategy mid-round because of a meaningful state change, such as damage, lost sight, planted charge, hostage progress, low health, or time pressure.
- Relay Charge bots show objective-aware carrier/site/defuse behavior.
- Evac Escort bots show objective-aware hostage/extraction route behavior or a documented partial implementation with a verified non-regression.
- A bounded solo round still resolves without AI deadlock.
- Easy/medium/hard remain ordered by tactical quality and combat danger without perfect aim or hidden speed.

Update `README.md` and relevant `docs/qa/*.md` if user-visible bot behavior, limitations, QA evidence, or debug surfaces change. Refresh screenshots only if visual/HUD presentation changes materially.

## Done Criteria

- The implementation is based on an explicit analysis and plan, not a superficial tweak.
- Solo bots use map-aware route planning or an equivalent lightweight navigation system.
- Bots recover from blocked paths by rotating/backing out/replanning before any bounded jump attempt.
- Bots do not repeatedly jump in place at the same obstruction.
- Each bot can independently choose and switch strategy based on objective, map, health, player contact, teammates, and round state.
- Objective behavior is improved for both Relay Charge and Evac Escort or remaining limitations are clearly documented with targeted follow-up work.
- Browser QA proves the new behavior and all required baseline behavior still passes.
- The final report lists changed files, validation commands, observed QA evidence, and remaining risks.

## Botpipe CLI

Run from the repository root:

```bash
botpipe run goal \
  --workspace /home/rauter/code/cs-dev \
  --provider codex \
  --model gpt-5.5 \
  --task human-like-map-aware-bots \
  "$(cat docs/botpipe-smarter-bots-goal.md)"
```
