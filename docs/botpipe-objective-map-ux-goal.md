# Botpipe Goal: Clear Objectives, Better Maps, Reliable Objective Bots, And Modular Match Code

Improve Dustline Protocol so objectives are readable in the 3D map, routes feel like compact CS 1.5-era tactical spaces, solo bots can reliably complete Relay Charge and Evac Escort objectives during normal play, and the oversized `src/game/localMatch.ts` is split into well-designed logical modules.

This is a gameplay, map, UX, AI reliability, and architecture pass. Do not treat it as a decorative marker pass only, and do not treat the refactor as unrelated cleanup. First analyze the shipped maps, collision, tactical route metadata, objective runtime states, bot routing, `localMatch` ownership boundaries, and user-reported confusion. Then implement the smallest robust set of changes that makes objectives understandable, routes reachable, bot objective play believable, and match code more maintainable without breaking the browser-only CS 1.5-inspired feel.

## Required Reading Before Editing

Read these files before making code changes:

- `AGENTS.md`
- `README.md`
- `docs/visual-target.md`
- `docs/assets.md`
- `docs/qa/local-play.md`
- `docs/qa/classic-feel.md`
- `docs/qa/final-release.md`
- `docs/qa/human-like-map-aware-bots.md`
- `src/data/maps.ts`
- `src/world/primitives.ts`
- `src/game/localMatch.ts`
- `src/game/tacticalAi.ts`
- `src/game/tacticalNavigation.ts`
- `src/game/collision.ts`
- `src/game/bombState.ts`
- `src/game/hostageState.ts`
- `src/game/missions.ts`
- `src/game/rounds.ts`
- `src/game/controls.ts`
- `src/game/playerMovement.ts`
- `src/game/avatar.ts`
- `src/game/audio.ts`
- `src/game/sharedRoom.ts`
- `src/ui/app.ts`
- `scripts/qa/finalVerification.mjs`

Preserve the hard product constraints: browser-only Vite/TypeScript/Three.js, `three` as the only runtime dependency, static Render-compatible build, original assets/names/maps/UI/sounds, no Counter-Strike copied content, no sprint layer, no heavy engine, and no deployment unless explicitly asked.

## User-Reported Problems

Investigate and address these concrete reports:

- Objectives are hard to understand because there are no clear marks on the ground or in the world.
- The HUD names locations such as `Kiln Yard`, `Loading Crew`, and `Water Tower Gate`, but players cannot reliably identify where those places are while moving.
- Bots technically have objective hooks, but in normal play they rarely appear to plant, defuse, secure, escort, or extract successfully.
- Maps have confusing dead ends, unreachable points, and route metadata that does not always match the navigable 3D space.
- Map sizes are acceptable, but the maps should feel more like classic CS 1.5-era tactical maps: clear lanes, readable choke points, useful alternate routes, memorable objective sites, and distinct spawn exits.
- On `Sandline Foundry`, Amber Vanguard appears unable to flank or access the left/west side of the map, despite the map summary claiming a west `Generator Hall` route.
- `src/game/localMatch.ts` is too large and mixes too many responsibilities, making objective, bot, map, shared-room, input, rendering, HUD snapshot, debug, and QA behavior difficult to reason about safely.

## Current Baseline

The existing code already contains useful systems:

- Sandline Foundry defines `Central Yard`, `Generator Hall`, `Drain Underpass`, `East Catwalk`, `Loading Bay`, `Water Tower Court`, and `Blue Shutter Bay` focus points.
- Relay Charge sites are declared as `Kiln Yard` at the courtyard focus and `Shutter Lift` at the loading-bay focus.
- Evac Escort declares `Generator Workers`, `Loading Crew`, and `Water Tower Gate`.
- The HUD exposes objective labels, status text, and progress bars.
- Hostage units are represented by simple in-world actors.
- Bots use the player-equivalent movement contract and a tactical navigation graph.
- Bot objective hooks exist for enemy plant, defuse, secure, and extract.
- Several focused modules already exist, including `bombState.ts`, `hostageState.ts`, `rounds.ts`, `playerMovement.ts`, `tacticalAi.ts`, `tacticalNavigation.ts`, `controls.ts`, and shared-room helpers.
- `localMatch.ts` still owns too many integration details and remains the main architectural pressure point.
- QA proves staged objective states can resolve.

Treat those as foundations, not finished player experience.

## Initial Analysis Findings

These findings should be verified during implementation:

- Objective guidance is primarily HUD-driven. There are no obvious CS-era world/floor markings for bomb sites, hostage clusters, extraction zones, or route direction.
- Objective prompts appear only when the player is already inside the objective radius. That is too late for navigation.
- Sandline objective names are stored in metadata, but the actual primitive scene does not visually brand those spaces enough.
- Sandline's west `Generator Hall` route is described as a usable corridor, but south-side access from Amber can feel blocked by the south generator cap, south shed/building pieces, and perimeter/corridor wall layout. Analyze the collision world before changing geometry.
- Mission rotation is confusing because mission type alternates by round number and site/cluster selection also uses round number. On Sandline this means players may repeatedly see `Kiln Yard` for bomb and `Loading Crew` for evac while `Shutter Lift` and `Generator Workers` exist in metadata.
- Bot objective completion is possible but conservative. Enemy objective actions require correct team, phase, radius, active local mode, and commitment gating. In live play, combat pressure, sightline interruptions, route issues, and extraction-chain complexity can prevent completion.
- QA currently proves "can complete when staged", not "can complete naturally and visibly in normal solo rounds".
- `localMatch.ts` has grown into a god module. It currently coordinates scene setup, input, movement, bots, objective actions, shared-room state, remote actors, HUD snapshots, debug snapshots, screenshots, and QA hooks. This makes objective fixes risky because unrelated behavior can be accidentally changed.
- Refactoring must be behavior-preserving first. Extract cohesive modules behind typed interfaces, then make objective/map/bot improvements through those modules where practical.

## Core Goal

Make objectives and routes legible in live play:

- A player should be able to look around Sandline Foundry and identify objective zones without already knowing the metadata.
- The map should show clear, original, low-poly, CS 1.5-era readable objective treatment: painted floor rings, worn stencils, low signs, utility panels, hostage holding zones, extraction gate markings, and subtle route callouts.
- Ground/world markers must be practical and tactical, not modern hero-shooter waypoints, giant glowing beams, minimap arrows, sci-fi holograms, or decorative UI.
- Each map should have reachable, useful lanes from both spawns: main route, tighter corridor/close route, and flank route where the metadata claims them.
- Bots should complete objectives often enough in solo play that players can understand the mode by watching or fighting them.
- `localMatch.ts` should become a thinner coordinator whose extracted modules own objective presentation, bot objective decisions, match HUD snapshots, reachability checks, and debug surfaces where those responsibilities are separable.
- QA should verify real navigability and objective completion without relying only on teleported staged success.

## Objective Marker Requirements

Add restrained in-world objective readability.

Required behavior:

1. Relay Charge sites need visible ground/site treatment.
   - Add original floor markings around each active site, such as a worn circular paint boundary, relay panel, striped utility plate, or low industrial marker.
   - `Kiln Yard` should be visibly tied to crate-island/courtyard pressure.
   - `Shutter Lift` should be visibly tied to the north loading/shutter area.
   - The marker should communicate "stand here and hold E" without needing a tutorial card.

2. Evac Escort locations need visible start and finish treatment.
   - Hostage clusters need clear holding-zone context: workers, tied-down crates, warning paint, low barriers, or simple shelter details.
   - Extraction zones need clear gate/release markings, such as a worn painted threshold and gate sign.
   - Escort route progress should be readable through subtle route landmarks or ground scuffs, not a modern GPS line.

3. Markers should be active-state aware where practical.
   - The active objective can be slightly more legible than inactive alternatives.
   - Planting/defusing/securing/extracting should visibly change the objective marker or nearby prop in a simple way.
   - Do not add bright permanent glows that break the dusty low-poly target.

4. HUD and world wording must match.
   - If the HUD says `Water Tower Gate`, the world should visibly say or imply `Water Tower Gate`.
   - If a prompt says `Hold E to arm Kiln Yard`, the player should be inside a marked `Kiln Yard` site.
   - Avoid stale hard-coded labels; use existing mission/objective state where possible.

## Map UX And Layout Requirements

Improve maps so route metadata matches actual navigable space.

Required behavior:

1. Audit all shipped maps.
   - For each map, verify team spawns, main route, corridor route, flank route, objective sites, hostage clusters, extraction zone, and tactical route graph nodes.
   - Identify dead ends, blocked route claims, unreachable focus points, one-sided routes, and confusing objective placement.
   - Record findings in a concise QA/doc artifact.

2. Fix Sandline Foundry first.
   - Amber Vanguard must have a clear, usable west/left route into or through `Generator Hall`.
   - `Generator Hall` should not feel like a decorative blocked pocket from the Amber side.
   - Preserve a meaningful choke and close-quarters route; do not turn it into a wide open hallway.
   - Keep the existing map size roughly similar.
   - Maintain distinct route identities:
     - middle: `Central Yard`
     - west/left: `Generator Hall`
     - east/right: `Drain Underpass` / `East Catwalk`
   - Ensure both teams can contest and rotate through those lanes without requiring jumps, geometry clipping, or invisible knowledge.

3. Reduce dead ends and unreachable points.
   - Any dead end must be intentional cover, not a misleading route.
   - If a route preview or tactical summary promises a lane, make the lane traversable.
   - Focus points used by objectives and tactical routes must be reachable by player and bot collision.
   - Collision-safe anchor correction must not hide underlying layout problems.

4. Make route readability stronger.
   - Use primitive geometry, color, low signs, floor bands, shutters, towers, crates, ramps, and lighting/material contrast.
   - Routes should be readable within seconds from spawn.
   - Avoid clutter and photorealistic detail.
   - Avoid copied Counter-Strike layouts, names, signs, or exact site conventions.

5. Keep CS 1.5-era feel.
   - Compact, readable, grounded, lethal, tactical.
   - Clear spawn identity and fast route decisions.
   - Short sightlines broken by simple cover.
   - Useful flanks that cost time or expose risk.
   - No parkour, sprint routes, hero-shooter verticality, or modern neon objective design.

## Bot Objective Completion Requirements

Make bots complete objectives naturally in solo play.

Required behavior:

1. Relay Charge attackers.
   - The carrier must route to the active site and attempt to plant when tactically plausible.
   - Support bots should screen, escort, hold lane angles, or pressure alternate approaches.
   - If the carrier is blocked or killed, carrier reassignment and route recovery must remain reliable.
   - The carrier should not abandon the active site due to stale sound/contact unless survival clearly requires it.

2. Relay Charge defenders.
   - Defenders should guard site approaches before plant.
   - Once planted, defenders should rotate and attempt a defuse with urgency.
   - Defuse attempts should be visible and understandable, not silently canceled every frame.

3. Evac Escort rescuers.
   - Rescuers must route to the active hostage cluster, secure it, escort along declared route metadata, and extract at the extraction zone.
   - Escort route progress should remain tied to real movement and route points.
   - The rescuer should not endlessly fight or reposition while hostages are waiting if the player is not an immediate threat.

4. Evac Escort defenders.
   - Defenders should hold hostage clusters, contest route chokepoints, and rotate toward extraction pressure.
   - They should not all collapse into the same point unless the objective state demands it.

5. Objective commitment should be human-like but reliable.
   - Bots may delay, cover, or cancel when actively threatened.
   - Bots should still complete objectives often enough that solo rounds teach the mode.
   - Difficulty should affect tactical quality and timing, not movement speed or cheating.
   - Do not make bots omniscient, perfect, or able to use objective actions outside the same radius/phase rules as players.

## LocalMatch Modularization Requirements

Split `src/game/localMatch.ts` into well-designed logical modules as part of this goal. The split must make the objective/map/bot work safer and easier to verify. Do not perform a broad churn-only refactor that obscures behavior changes.

Required behavior:

1. Audit current `localMatch.ts` responsibilities.
   - Identify coherent ownership areas, including scene/environment setup, player input and control gating, local player movement, weapon/audio, objective runtime integration, objective HUD snapshots, bot objective actions, bot updates, hostage actor rendering, remote/shared-room actors, match snapshots, debug/QA hooks, and fullscreen/browser-shell integration.
   - Record the proposed extraction plan before editing code.

2. Extract modules around stable responsibilities.
   - Prefer focused modules with typed inputs/outputs over large class inheritance or hidden shared mutable state.
   - Good candidate modules include:
     - `src/game/objectiveMarkers.ts` for in-world objective marker creation/state.
     - `src/game/mapReachability.ts` for route/focus/objective reachability analysis.
     - `src/game/objectiveBotGoals.ts` for bot plant/defuse/secure/extract commitment decisions.
     - `src/game/matchHudSnapshot.ts` for HUD/objective snapshot formatting.
     - `src/game/matchDebugSnapshot.ts` for QA/debug data assembly.
     - `src/game/hostageActors.ts` for hostage avatar lifecycle if it can be cleanly separated.
     - `src/game/matchScene.ts` for environment/primitive scene construction if it can be extracted without spreading Three.js lifecycle ownership.
   - These names are suggestions, not mandatory. Choose boundaries that fit the code after inspection.

3. Keep the public behavior stable while extracting.
   - Refactor in behavior-preserving slices before changing objective/map/bot behavior.
   - Do not rewrite the whole match loop from scratch.
   - Do not introduce a second movement, objective, collision, or shared-room model.
   - Do not move code into modules that require circular imports or hard-to-test global state.
   - Keep `localMatch.ts` as the integration coordinator, but reduce its direct ownership of independent logic.

4. Protect shared-room behavior.
   - Same-browser and Cloud Room behavior must continue to use the existing host-authoritative snapshot/event boundaries.
   - Missing `BroadcastChannel` fallback must remain intact.
   - Human-only shared-room scope should not accidentally gain solo bots unless explicitly designed and documented.

5. Protect QA hooks while improving them.
   - Existing debug methods used by `scripts/qa/finalVerification.mjs` must keep working or be intentionally updated with matching QA changes.
   - New modules should expose concise debug state for objective markers, map reachability, bot objective decisions, and route completion.

6. Make the refactor measurable.
   - The final report must list extracted modules and what each now owns.
   - `localMatch.ts` should be materially smaller and easier to scan.
   - If the full split is too large for one pass, complete the highest-risk extractions for this goal and document the remaining `localMatch` responsibilities with a follow-up plan.

## QA And Verification Requirements

Update QA to prove the new behavior.

Required checks:

- `npm run build`
- `npm test`
- `npm run qa:final` when screenshot/world presentation changes materially

Browser QA should verify:

1. Objective markers exist and are visible.
   - Capture screenshots showing Sandline Relay site markers, hostage cluster markers, and extraction marker.
   - Assert marker objects/debug state exist for active objective zones.
   - Confirm HUD objective labels match world marker labels.

2. Sandline west route is reachable.
   - From Amber spawn, a player-equivalent or bot-equivalent navigation sample can reach `Generator Hall` without jumping or clipping.
   - From `Generator Hall`, the route reconnects toward `Central Yard` or north-side pressure.
   - The tactical graph reports reachable route plans for both teams through the west route.

3. No misleading objective dead ends.
   - Active objective focus points are reachable from both spawns.
   - Hostage cluster and extraction route points are reachable in sequence.
   - Bomb sites are reachable by the delivery team and defending team.

4. Bots complete Relay Charge naturally.
   - In a solo-local round without teleporting the carrier directly onto the site, an attacking bot routes to the active Relay site, starts planting, completes plant, and resolves by breach or forces a defender defuse attempt.
   - In a planted-state scenario, a defender routes to the site and starts a defuse when tactically plausible.

5. Bots complete Evac Escort naturally.
   - In a solo-local round without teleporting the rescuer directly onto extraction, a bot rescuer routes to the cluster, secures hostages, advances route progress, reaches extraction, and starts/completes extraction.
   - If full natural completion is too slow for one harness run, add a bounded accelerated QA mode that preserves route movement and objective rules instead of teleporting between phases.

6. Screenshots stay faithful to the visual target.
   - Marker treatment must look like original dusty industrial map art.
   - No bright modern waypoint arrows, holograms, copied site markings, or UI clutter.

7. Modularization is behavior-preserving.
   - Existing local play, shared-room fallback, objective state, bot movement, HUD snapshots, and debug QA surfaces still pass after extraction.
   - New modules are covered by either browser QA, targeted unit tests, or deterministic debug assertions where practical.
   - No new runtime dependencies are added.

Update docs after verification:

- `README.md` if objective readability, controls, or limitations change.
- `docs/qa/local-play.md`
- `docs/qa/classic-feel.md`
- `docs/qa/final-release.md`
- `docs/qa/visual-report.md` if screenshots are refreshed.
- Add a focused QA artifact if needed, for example `docs/qa/objective-map-ux.md`.

## Implementation Guidance

Prefer focused modules and existing ownership boundaries:

- `src/data/`: map metadata, focus points, objective definitions, route notes, preview updates.
- `src/world/`: primitive construction helpers if needed.
- `src/game/`: runtime objective markers, bot objective decision/routing, collision/nav checks, match HUD/debug helpers, and extracted `localMatch` logic.
- `src/ui/`: HUD prompt wording only when needed.
- `scripts/qa/finalVerification.mjs`: accepted runtime behavior and screenshot refresh.

Actively reduce `src/game/localMatch.ts` where doing so clarifies ownership and reduces risk. If objective marker creation, route validation, HUD snapshot logic, bot objective commitment, hostage actor lifecycle, or debug snapshot assembly gets large, move it into focused modules such as:

- `src/game/objectiveMarkers.ts`
- `src/game/mapReachability.ts`
- `src/game/objectiveBotGoals.ts`
- `src/game/matchHudSnapshot.ts`
- `src/game/matchDebugSnapshot.ts`
- `src/game/hostageActors.ts`
- `src/game/matchScene.ts`

Keep all visual assets procedural/primitive unless `docs/assets.md` is updated through the external asset gate. No external assets are expected for this goal.

## Acceptance Criteria

This goal is complete when:

- Sandline Foundry has visible, original, low-poly objective-zone markings for Relay Charge and Evac Escort.
- Sandline's west/left `Generator Hall` route is clearly accessible from Amber Vanguard and tactically useful.
- All shipped maps are audited for objective reachability, misleading dead ends, and route/focus consistency.
- At least Sandline has concrete layout/UX improvements based on the audit.
- Bots can visibly and reliably complete Relay Charge and Evac Escort objectives in solo-local play under QA-observed conditions.
- `src/game/localMatch.ts` is split into logical modules for the objective/map/bot work, with behavior-preserving validation and a clear ownership summary.
- QA evidence proves reachability, objective marker visibility, bot objective completion, and classic-feel preservation.
- Documentation accurately explains objective locations, route readability, bot behavior, and any remaining limitations.

## Non-Goals

- Do not add a minimap, radar clone, or copied Counter-Strike objective visuals.
- Do not add sprint, mantle, parkour, bunnyhop-centric movement, or route shortcuts that require special movement tech.
- Do not add external art packs, sounds, fonts, map files, or non-`three` runtime dependencies.
- Do not convert the game into a modern objective-marker-heavy shooter.
- Do not make bots cheat by teleporting, ignoring collision, seeing through walls, or using objective actions from outside valid zones.
- Do not do an unbounded rewrite of `localMatch.ts` that changes unrelated gameplay without evidence.
- Do not split modules only to hide complexity behind vague utility files; extracted modules need coherent ownership and typed contracts.
- Do not deploy as part of this goal unless explicitly requested.

## Botpipe CLI

Run from the repository root:

```bash
botpipe run goal "$(cat docs/botpipe-objective-map-ux-goal.md)" \
  --workspace /home/rauter/code/cs-dev \
  --provider codex \
  --model gpt-5.5 \
  --task objective-map-ux-bots-localmatch-modules
```
