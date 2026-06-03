# Human-Like Map-Aware Bots Analysis

Date: 2026-06-03

## Scope

This artifact covers the planning subgoal for the human-like solo bot pass, plus the follow-up target-deconfliction slice implemented on 2026-06-03.

The active implementation target remains Dustline Protocol's browser-only Vite/TypeScript/Three.js tactical FPS homage. The plan preserves `three` as the only runtime dependency, static Render-compatible output, original maps/assets/names, current controls, short round structure, shared player-equivalent movement, and the solo bot difficulty contract where `medium` is the clean-load default and the latest valid value restores from `localStorage` when storage works.

## Required Read Findings

- `AGENTS.md`, `README.md`, `docs/visual-target.md`, and `docs/assets.md` require a classic CS 1.5-era inspired feel without copied Counter-Strike content, no sprint/parkour layer, no heavy engine, no server requirement for bots, and no external runtime assets.
- `docs/qa/local-play.md`, `docs/qa/classic-feel.md`, and `docs/qa/final-release.md` record the current accepted baseline: solo bot difficulty has `easy`, `medium`, `hard`; `medium` is default; bots use the same walk/crouch/jump/gravity/collision constants as the player; current QA proves LOS blocking, delayed squad contact, bounded pursuit memory, basic stuck recovery, difficulty ordering, enemy-side bomb pressure, and a bounded solo resolution.
- `src/game/botDifficulty.ts` cleanly owns difficulty persistence: invalid, missing, or unavailable storage falls back to `medium`, while valid writes are best-effort.
- `src/game/botDifficultyTuning.ts` expresses difficulty as tactical quality and danger: reaction bias, shot spread, communication delay, behavior hold, stuck windows, recovery commit time, burst discipline, and objective threat distance. It does not change movement speed.
- `src/game/playerMovement.ts` exposes the shared movement contract: walk `8.6`, crouch multiplier `0.56`, air control `0.78`, gravity `13.6`, jump velocity `5.25`, standing/crouched eye and body heights, and `updateSharedMovement()`.
- `src/game/collision.ts` builds an axis-aligned collision world from primitive geometry, ignores low walkable pieces, clamps bounds, resolves horizontal motion axis-by-axis, finds open anchor positions by radial samples, and checks visibility through collider ray tests.
- `src/game/rounds.ts` owns the round shell: briefing, active, resolution, elimination/timeout resolution, and mission rotation through `resolveActiveMission()`.
- `src/game/bombState.ts` owns Relay Charge runtime state: carrier assignment, carried/planting/planted/defusing phases, timers, serialization, carrier synchronization, and progress.
- `src/game/hostageState.ts` owns Evac Escort runtime state: cluster, extraction zone, route points built from declared route IDs, hostage slots, securing/escorting/extracting phases, serialization, and progress.
- `scripts/qa/finalVerification.mjs` now proves route-graph traversal, independent strategy/profile debug data, target-claim deconfliction for shared-contact responders and carrier escort support, objective-aware Relay/Evac intent, and the staged obstruction's non-repeated stuck-recovery jump behavior.

## Current Navigation Model

The current tactical AI is split between `src/game/tacticalAi.ts` and `src/game/localMatch.ts`.

`buildTacticalProfile()` converts map metadata into flat anchors. It creates spawn anchors from `map.teamSpawns`, route anchors from `map.tacticalRoutes`, and focus anchors from `map.scene.focusPoints`. Each anchor position is corrected with `findOpenGroundPosition()`, so anchors tend to be usable local points, but the profile does not record edges, route order, traversal cost, blocked segments, or preferred lane connectivity.

`resolveObjectiveAnchor()` chooses the active objective anchor. For Relay Charge it points at the live bomb site. For Evac Escort it points attackers toward extraction during escort/extract phases and otherwise points at the hostage cluster. Defenders point at the cluster. This is useful objective awareness, but still just produces one target anchor.

`buildPatrolRoute()` builds a small per-bot patrol list from the nearest spawn anchor, one nearby route anchor indexed by bot, the objective anchor, and one nearby focus anchor. This gives visible variety at round start, but it is not pathfinding. The route is an ordered list of disconnected destinations.

`LocalMatch` assigns fixed roles by enemy index: `anchor`, `route`, and `flank`. `configureEnemyAi()` resets each bot to `objective` or `patrol`, sets the patrol index, clears memory, and resets deterministic RNG from bot index and round number. The behavior loop then selects among `objective`, `patrol`, `investigate`, `pursue`, `reposition`, and `engage`.

Movement toward every behavior target is currently direct. `updateEnemies()` computes a horizontal vector from enemy feet to the current target, converts it into local `moveX`/`moveZ`, and calls `updateSharedMovement()` with the same collision and movement contract as the player. This preserves the feel contract, but it means bots still try to walk straight at objective anchors, sound locations, last-known positions, patrol points, and recovery points.

Forced directives already exist. `setEnemyForcedDirective()` can temporarily override behavior, stance, target, label, and duration; recovery uses this to commit to a fallback reposition target. These directives are a good integration point for route recovery and strategy commits, but today they still point at one direct target.

Progress tracking is shallow but useful. Each bot tracks `lastProgressAt` and `lastProgressPosition`; progress resets when the bot moved enough, has target distance <= `1.1`, or should not move. If no progress is observed for `stuckSeconds`, the bot chooses a recovery anchor and forces `reposition` for `recoveryCommitSeconds`.

Recovery jumping happens before the repath timer. `chooseEnemyJumpReason()` allows a `stuck-recovery` jump only when the bot is grounded, moving, not crouched, in patrol/investigate/pursue/reposition, still far from target, slow, outside a short jump cooldown, and stalled for a narrow pre-recovery window. This bounds jumps, but there is no memory of failed jump locations or reasons, so the same obstruction can still invite repeated jump attempts across cycles.

Collision response does not report why motion failed. `resolveHorizontalMovement()` applies X and Z independently if each axis is unblocked. That is simple and browser-friendly, but the AI receives only final position and speed. It cannot tell whether it hit a wall, corner, bounds, narrow doorway, tactical hold, crouch slow, or airborne state without additional classification.

## Current Map Knowledge

`src/data/maps.ts` has strong tactical metadata:

- five original maps: `Sandline Foundry`, `Transit Crates`, `Breaker Vault`, `Quarry Slip`, and `Ledger Annex`
- distinct `teamSpawns` for Amber Vanguard and Cobalt Reach on every map
- `scene.focusPoints` for spawn courts, central yards, corridors, flanks, catwalks, extraction areas, and landmarks
- `tacticalRoutes` with `main`, `corridor`, and `flank` route kinds
- Relay Charge sites with `focusId`, radius, and related `routeIds`
- Evac Escort hostage clusters with route IDs, plus extraction zones with route IDs
- primitive scene geometry that can be converted into collision and segment traversal tests

The missing piece is connectivity. Route IDs say which lanes matter to an objective, and focus points provide target coordinates, but no data says "these two anchors are connected", "this segment is blocked by the west wall", "prefer this lane for a flank", or "this route is longer but safer." Current open-ground anchor generation confirms that individual nodes are not inside blockers; it does not prove that moving from one node to another is traversable.

This is enough for a lightweight deterministic route graph. Existing anchors can become graph nodes, while collision sampling can decide whether an edge is valid. Additional intermediate nodes can be generated from route/focus metadata and open-ground offsets only where long segments or known map geometry need them. A full navmesh is not justified by the current low-poly primitive maps.

## Failure Causes

Bots can walk into blockers because target choice and movement are separated. The AI often chooses sensible objective, patrol, sound, or recovery anchors, but the motor layer always tries the direct segment first. If a wall or crate sits between current position and target, axis-by-axis collision can leave the bot pressing into geometry until the progress timer expires.

Recovery can fail because the recovery target is another flat anchor, not a verified path. `chooseRecoveryAnchor()` scores anchors by visibility to the blocked target, distance to the target, objective distance, and travel distance. It does not verify that the bot can reach the chosen anchor from its current location or that the chosen anchor leads around the obstruction.

Repeated jump vulnerability comes from missing failed-jump memory. A `stuck-recovery` jump resets progress timing when the jump starts, but the bot does not compare post-jump route progress against the pre-jump obstruction, and it does not suppress future jumps at the same quantized location, blocker, target, or reason.

Exposure near walls comes from cover scoring without path and escape context. `chooseRepositionAnchor()` can find anchors that break sight or create a better angle, but it does not reason about connected escape routes, known player lines across the planned path, teammate support, objective urgency, or whether the bot will step through a dangerous open lane to reach the anchor.

Synchronized decisions come from fixed role labels and shared stimuli. The three bots start as anchor/route/flank and patrol routes vary by index, but the behavior tree, timers, objective anchor, sound priority, and contact handling are otherwise similar. The 2026-06-03 target-claim registry now avoids duplicate shared-contact and objective escort targets when route alternatives or offset lanes are available; broader cover and recovery reservations remain future work.

Stale sound/contact can override objective pressure too easily. Last-heard and last-known positions drive `investigate` and `pursue` for fixed windows. Bomb/hostage state changes update the objective anchor and range-gated action checks, but they do not yet produce a higher-level strategy priority such as "ignore stale sound and rotate to planted charge" or "screen the hostage rescuer."

Mid-round adaptation is shallow. Current live signals include visibility, last seen/heard/shared contact, recent damage, lost sight, behavior hold, objective anchor changes, and difficulty tuning. The strategy model does not yet explicitly account for health, teammate deaths, teammate roles, route reservations, bomb fuse urgency, hostage route progress, carrier/rescuer identity, support distance, or low-time objective pressure.

## Objective-Specific Gaps

Relay Charge already has carrier assignment, site radius checks, plant/defuse timers, and enemy-side objective actions when a bot reaches the site. The gap is getting bots there believably and assigning support. The carrier should route through a graph to a valid site; non-carriers should escort, screen, flank, or hold near the carrier/site; defenders should hold approach lanes, rotate urgently to a planted charge, and attempt defuse when line pressure is plausible.

Evac Escort already builds a named escort route from hostage cluster route IDs and extraction route IDs. Hostages move along that route once secured. The gap is bot intent around the route. Rescuers need to route to clusters, secure, escort toward extraction, and avoid direct walking through blockers. Defenders need to anchor cluster/extraction chokepoints, rotate when hostages move, and avoid abandoning the route because of stale sound far away.

## Strategy Model Gaps

The current `behavior` field is a short-term action, not a medium-term strategy. It answers what the bot is doing now, but not why it chose that lane or whether it is the carrier escort, route probe, flank rotate, fallback guard, defuser, or extraction guard.

The next layer should evaluate strategies from role, map route metadata, mission type, objective phase, bomb/hostage state, round timer, health, recent damage, player visibility, last-known and sound contact freshness, delayed teammate contacts, teammate alive counts, current teammate strategies, distance to objective, route cost, cover availability, and difficulty tuning. Strategy switches need hysteresis so bots do not jitter, while urgent events such as taking damage, seeing the player, bomb planted, low fuse time, hostage progress, or low health can override the cooldown.

## Chosen Plan

1. Add a lightweight route graph module, likely `src/game/tacticalNavigation.ts`.
   - Build deterministic nodes from tactical profile anchors, team spawns, route anchors, focus points, bomb sites, hostage clusters, extraction zones, and a small number of collision-opened intermediate anchors when needed.
   - Connect nodes only when the ground segment is traversable by sampling `isBlocked()` along the segment with the player radius/body height and by respecting world bounds.
   - Keep edge costs simple: distance plus small penalties/bonuses for route kind, objective relevance, exposure to known player lines, and difficulty quality.
   - Use deterministic A* or Dijkstra over this small graph. No runtime dependency is needed.
   - Allow direct movement when the direct segment is clear; otherwise move through graph waypoints.

2. Route all tactical targets through the planner.
   - Objective anchors, patrol points, sound contacts, last-known positions, reposition anchors, recovery anchors, bomb sites, hostage clusters, and extraction zones should produce a planned path.
   - Store per-bot path state: destination label, waypoint index, waypoint target, path node IDs/labels, replan reason, and route age.
   - Keep the existing shared movement model. The graph only chooses the next target; `updateSharedMovement()` remains the locomotion authority.

3. Replace the shallow stuck timer with classification.
   - Track intended movement, actual movement, target-distance delta, repeated blocked heading, time near the same quantized position, current behavior/strategy, stance, grounded/airborne state, and objective action state.
   - Classify at least `arrived`, `holding`, `moving`, `blocked_geometry`, `blocked_tactical`, and `temporarily_slowed`.
   - Do not count valid crouched objective holds, peeks, planting/defusing/securing/extracting, behavior holds, or airborne/crouch slowdowns as geometry stuck.

4. Use human-style recovery sequencing.
   - First rotate/strafe/back out briefly from a local obstruction.
   - Then replan to a nearby reachable route node or alternate lane.
   - Use jump only as a rare bounded recovery attempt with cooldown and failed-jump suppression.
   - Record recent failed jumps by quantized position, target label/node, reason, and blocker if known. If the jump does not improve route progress, suppress similar jumps for a bounded window and prefer backout/replan.
   - Never teleport.

5. Add a medium-term strategy layer.
   - Introduce strategy names equivalent to `anchor_site`, `route_probe`, `flank_rotate`, `pressure_objective`, `cover_reposition`, `pursue_contact`, `fallback_guard`, and `escort_or_defuse`.
   - Derive deterministic per-bot profiles from bot id, map id, round number, role, and difficulty.
   - Reserve or bias route/cover choices so bots do not all pick the same anchor when alternatives exist.
   - Keep current behavior names as the lower-level action surface where practical, but expose both `strategy` and `behavior` in debug snapshots.

6. Improve objective-specific bot intent.
   - Relay Charge: carrier paths to a valid site; support bots screen/flank/hold; defenders guard approach lanes; planted charge triggers immediate rotate/defuse strategies.
   - Evac Escort: rescuers path to hostage clusters and extraction route nodes; defenders guard hostage/extraction chokepoints; route progress changes strategy priority.
   - If full hostage bot execution must be staged over multiple passes, document the exact limitation and keep current hostage flow non-regressed.

7. Extend QA hooks without bypassing AI.
   - Add deterministic staging that places bots and targets in realistic live states, then lets the AI choose graph paths, recovery actions, strategies, and objective commits.
   - Assert that debug snapshots expose current strategy, route/waypoint labels, path IDs, stuck classification, recovery action/count, failed-jump suppression, selected cover reason, objective intent, role, and variation seed/profile.
   - Preserve existing QA for `medium` default/persistence, shared movement, crouch/jump, LOS blocking, delayed communication, pursuit expiry, enemy bomb pressure, bounded solo round resolution, and difficulty ordering.

## Rejected Alternatives

- Heavy navmesh, imported pathfinding libraries, or game engines: unnecessary for five small primitive maps and incompatible with dependency discipline.
- Teleport recovery: hides the failure and breaks the classic tactical feel.
- Making bots faster, giving hidden sprint, or adding parkour/bunnyhop behavior: violates the movement contract and would make bots feel less like grounded tactical opponents.
- Perfect aim, instant wall knowledge, or shooting through blockers: conflicts with current QA and the readable combat contract.
- Copying Counter-Strike route names, map layouts, team names, or assets: outside the originality boundary.
- Growing `src/game/localMatch.ts` with all new systems inline: the file is already large; new graph/strategy logic should live in focused modules with small integration points.
- Using only more patrol anchors without connectivity: it would not solve direct-line wall pushes, failed recovery targets, or reliable objective routing.

## QA Plan For Later Subgoals

Later implementation subgoals should update `scripts/qa/finalVerification.mjs` to prove:

- `medium` remains the default when storage is empty or unavailable, and valid stored difficulty still restores.
- Bot movement constants still match player movement constants across difficulties.
- Bots still crouch, jump, land, and remain upright.
- Bots still do not see or shoot through blockers.
- A blocked direct route triggers backout/rotate/replan/path waypoint behavior rather than deadlock.
- At least one bot follows route graph waypoints around geometry to a tactical target.
- The same obstruction does not cause repeated recovery jumps after a failed jump.
- At least two bots choose different strategies or routes in the same live round.
- A bot changes strategy mid-round because of a meaningful state change.
- Relay Charge bots expose carrier/site/escort/defuse intent.
- Evac Escort bots expose hostage/extraction route intent or a documented, verified partial implementation.
- A bounded solo round still resolves without AI deadlock.
- Easy/medium/hard remain ordered by tactical quality and combat danger without hidden movement changes or perfect aim.

## Implementation Invariants

- Keep `updateSharedMovement()` as the bot movement path.
- Keep current controls and browser-safe input gating.
- Keep round modes, objective timers, and current mission labels.
- Keep same-browser `BroadcastChannel` fallback behavior and shared-room human-only bot scope.
- Keep `three` as the only runtime dependency.
- Keep all assets original and procedural/primitive unless the asset record is explicitly updated.
- Keep QA evidence truthful; hooks should stage live situations and observe shipped AI decisions, not force the desired result.

## Route Graph Navigation Implementation Evidence

Implemented on 2026-06-02 for subgoal `route-graph-navigation-and-stuck-recovery`.

- Added `src/game/tacticalNavigation.ts`, a deterministic no-dependency route graph built from tactical profile anchors, focus points, team spawns, bomb sites, hostage clusters, extraction zones, and collision-opened offset nodes.
- Graph edges are accepted only when sampled against the existing collision world with player-equivalent radius/body height. Direct movement is still allowed when the segment is clear.
- `src/game/localMatch.ts` now plans per-bot route waypoints for behavior targets, then feeds only the selected waypoint direction into `updateSharedMovement()`.
- Bot debug snapshots expose graph node/edge counts, route reason, current waypoint, path node IDs/labels, stuck classification, recovery action/timing/count, and failed-jump suppression state.
- Stuck classification distinguishes arrived/holding/moving/blocked geometry/blocked tactical/temporary slowdown and excludes objective actions from geometry-stuck classification.
- Recovery sequencing now prefers local backout/strafe/rotate, then graph-aware replan through a recent-target-aware recovery point, with stuck-recovery jumps gated behind prior recovery work and suppression memory.
- Fresh `npm test` passed. The final QA recovery sample staged `Crate stack west` as the blocker and observed a `graph-route` to `Central Yard route offset`, `routeUsesGraph: true`, `jumpCount: 0`, and no teleport/deadlock.

## Strategy Layer Implementation Evidence

Implemented on 2026-06-02 for subgoal `strategy-layer-and-independent-squads`.

- `src/game/tacticalAi.ts` now owns explicit medium-term strategy names: `anchor_site`, `route_probe`, `flank_rotate`, `pressure_objective`, `cover_reposition`, `pursue_contact`, `fallback_guard`, and `objective_commit`.
- Each solo bot receives a deterministic strategy profile derived from bot id, map id, team, round number, and squad role. The profile exposes seed, aggression, cover discipline, route patience, and flank preference without changing movement speed or adding hidden physical advantages.
- `src/game/localMatch.ts` evaluates strategy from role/profile, mission type, bomb phase and carrier state, hostage phase and route progress, round phase/time remaining, health, recent damage, fire cadence readiness, player visibility, last-known contact, sound contact, lost sight, delivered shared contact, nearby teammate support, teammate strategy counts, objective distance, cover availability, escape availability, and difficulty.
- Strategy switching uses a per-bot cooldown, while urgent events such as visual contact, recent damage, low health, planted charge, hostage escort/extraction, and late-round pressure override the cooldown.
- The existing delayed squad-contact model remains the information boundary: teammate-contact influence only uses contact that has already been delivered to that bot, not raw teammate line of sight.
- Debug snapshots now expose `strategy`, `strategyReason`, `strategyAge`, `strategyCooldownRemaining`, `profileSeed`, profile values, `objectiveIntent`, `teammateInfluence`, route details, cover/reposition reason, behavior, and stance.
- `scripts/qa/finalVerification.mjs` now asserts opening strategy diversity across the live fireteam, verifies every bot exposes deterministic strategy debug data, and verifies a live damage event switches a bot into `cover_reposition` or `fallback_guard` with a damage/low-health reason.
- The strategy layer feeds the existing behavior, route planning, movement, LOS, and shot systems rather than replacing them, so bots still use player-equivalent movement, miss, hesitate, withhold fire through blockers, and use graph waypoints for blocked travel.

## Objective-Aware Bot Implementation Evidence

Implemented on 2026-06-02 for subgoal `objective-aware-relay-and-evac-bots`.

- `src/game/localMatch.ts` now resolves objective targets from live mission state before handing movement to the existing tactical route planner.
- Relay Charge attackers distinguish carrier and support duties. The carrier keeps `carrier_site_commit` intent toward the active site, one support bot can escort the carrier, and another can screen through a site route anchor instead of clustering on the same point.
- Relay Charge carriers and other objective-driven bots keep their objective movement/intent when a close visible player appears, but they are now allowed to fire through the normal LOS, reaction, burst, miss, and cooldown gates instead of staring without shooting.
- Relay Charge defenders treat both `planted` and active `defusing` states as urgent defuse rotation. Debug intent exposes `defuse_rotate`, and the existing bomb action path still owns plant, defuse, fuse, and round resolution.
- Evac Escort attackers route rescuers through declared escort route labels before extraction. The resolver chooses the first declared route point the current bot can actually plan to through the graph, so a staged rescuer avoided a direct unreachable extraction path and planned to `Drain Underpass` through graph waypoints.
- Evac Escort support and defender intents are explicit in debug snapshots: `escort_extract`, `escort_flank_screen`, `hostage_cluster_anchor`, and `hostage_lane_probe`.
- QA staging hooks in `scripts/qa/finalVerification.mjs` place bots in realistic live objective states, then let the shipped AI/update loop expose strategy, route, and objective-action behavior. The hooks do not add a second movement model or bypass the underlying plant/defuse/secure/escort/extract state machines.
- Fresh `npm test` passed. The final QA summary reported:
  - Relay route: carrier intent `carrier_site_commit`, support intents `carrier_escort` and `carrier_flank_screen`, support targets `Copper-2 escort` and `Generator Hall`.
  - Relay defuse: defender intent `defuse_rotate`, bomb phase `defusing`.
  - Evac escort: rescuer intent `escort_extract`, route destination `Drain Underpass`, graph route via `Loading Bay route offset`, support intents `escort_extract` and `escort_flank_screen`, defender intents `hostage_cluster_anchor` and `hostage_lane_probe`.
  - Existing solo/shared objective flows still resolved: enemy-side Relay breach, local/shared Relay defuse, local/shared Evac extraction, and bounded solo round resolution.

## Final Browser QA And Docs Evidence

Completed on 2026-06-02 for subgoal `browser-qa-docs-and-final-evidence`.

- `scripts/qa/finalVerification.mjs` covers the full accepted smarter-bot behavior through realistic staged live states and debug snapshots:
  - clean-load solo bot difficulty default `medium`, valid `localStorage` restore to `hard`, blocked-storage fallback to `medium`, and live in-memory difficulty changes
  - player-equivalent bot movement constants, crouched bot slowdown/lowered body and eye height, bot jump lift/land, and no difficulty-specific movement speed
  - dead-until-next-round behavior, blocker LOS/fire prevention, delayed squad contact, bounded pursuit memory, missing `BroadcastChannel` local fallback, and ordered `easy` / `medium` / `hard` danger without perfect hard-bot aim
  - blocked direct route planning through graph waypoints, stuck recovery debug state, failed-jump suppression debug state, and no repeated stuck-recovery jump at the staged obstruction
  - independent opening strategies and deterministic role/profile debug data
  - damage-driven strategy switching into cover/fallback logic
  - Relay Charge carrier/site/support/defuse intent
  - Evac Escort hostage route/extraction/support/defense intent
  - bounded solo-round resolution without AI deadlock
- Fresh `npm run qa:final` passed and refreshed screenshots from current `dist` output.
- Fresh `npm test` passed after rebuilding and rerunning the browser harness. The run reported:
  - opening strategies `anchor_site`, `route_probe`, `flank_rotate`
  - recovery route `graph-route` via `Central Yard route offset`, `routeUsesGraph: true`, and `jumpCount: 0`
  - strategy switch `cover_reposition` with `strategyReason: recent-damage`
  - Relay carrier intent `carrier_site_commit`, support intents `carrier_escort` and `carrier_flank_screen`, support targets `Copper-2 escort lane` and `Drain Underpass`, and defender intent `defuse_rotate`
  - Evac rescuer intent `escort_extract`, route destination `Drain Underpass`, graph waypoint `Loading Bay route offset`, support intents `escort_extract` and `escort_flank_screen`, and defender intents `hostage_cluster_anchor` plus `hostage_lane_probe`
  - local Relay breach, local Evac extraction/reset, shared Relay defuse, shared Evac extraction, and bounded solo enemy Relay breach
- Fresh guardrail checks confirmed `three` remains the only runtime dependency and source/content additions did not introduce sprint, copied Counter-Strike names/assets/UI/maps/sounds, a second movement model, or a server/matchmaking requirement for solo bots.

Remaining limitation: tactical AI verification is intentionally solo-local. Shared-room sessions remain human-only, and bot strategy/objective debug surfaces are QA/debug evidence rather than a player-facing command layer.
