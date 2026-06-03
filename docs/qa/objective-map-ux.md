# Objective Map UX Audit

Date: `2026-06-02`

Subgoal: `audit-objectives-routes-bots-and-localmatch`

## Scope

This audit covers the current implementation before objective/map/bot gameplay edits. It is based on the required source and documentation reads for the parent objective:

- `AGENTS.md`, `README.md`, `docs/visual-target.md`, `docs/assets.md`
- `docs/qa/local-play.md`, `docs/qa/classic-feel.md`, `docs/qa/final-release.md`, `docs/qa/human-like-map-aware-bots.md`
- `src/data/maps.ts`, `src/world/primitives.ts`, `src/game/localMatch.ts`, `src/game/tacticalAi.ts`, `src/game/tacticalNavigation.ts`, `src/game/collision.ts`
- `src/game/bombState.ts`, `src/game/hostageState.ts`, `src/game/missions.ts`, `src/game/rounds.ts`, `src/game/controls.ts`, `src/game/playerMovement.ts`, `src/game/avatar.ts`, `src/game/audio.ts`
- `src/ui/app.ts`, `scripts/qa/finalVerification.mjs`
- Shared-room implementation files: `src/net/matchRoomConnection.ts`, `src/net/broadcastTransport.ts`, `src/net/transport.ts`, `src/net/protocol.ts`, `src/net/signalingConfig.ts`

The parent goal's required-read reference to `src/game/sharedRoom.ts` is stale. That file is absent in the current repository. Shared-room behavior is implemented through `src/net/matchRoomConnection.ts`, transport/protocol modules under `src/net/`, `src/ui/app.ts` room setup, and `src/game/localMatch.ts` integration.

## Guardrails To Preserve

- Browser-only Vite/TypeScript/Three.js; `three` remains the only runtime dependency.
- Static Render-compatible build remains `npm install && npm run build`, publish `dist`.
- Original teams, map names, objectives, route labels, primitive geometry, UI, and procedural audio only. No Counter-Strike assets, names, copied layouts, copied UI, or copied objective markings.
- Controls remain `WASD`, `Shift` crouch, optional Ctrl crouch alias, `Space`, `E`, left click, `R`, `M`, `Esc`, and held `Tab` board. Input stays gated behind pointer lock or armed viewport focus.
- No sprint layer, no second movement model, no heavy engine, no imported pathfinding/runtime dependency.
- Same-browser dev rooms must keep the `BroadcastChannel` fallback path and must fall back to solo-local without crashing when unsupported.
- Cloud/shared rooms remain human-only; solo bot difficulty applies to solo-local only.
- Solo bot difficulty keeps `medium` as the clean-load default, restores valid `localStorage` values when storage works, and safely falls back when storage is unavailable.

## Current Objective Readability

The objective state machines and HUD labels exist, but world readability is mostly absent.

- Relay Charge sites are metadata-driven through `BombSiteDefinition` and runtime `BombRuntimeState`. The HUD can say `Kiln Yard`, `Shutter Lift`, and `Hold E to arm ...`, but `buildScene()` currently only instantiates map primitives from `map.scene.primitives`; it does not create bomb-site floor markings, relay panels, low signs, or active/inactive site states.
- Evac Escort clusters are represented by simple hostage actors after the hostage runtime state exists. The cluster, route, and extraction labels are visible through HUD/debug state, but the world has no dedicated holding-zone paint, worker-zone prop context, extraction threshold, gate sign, or route scuff treatment.
- Prompts are radius-gated and appear only when the player is already inside the action area. `bombHudSnapshot()` only returns `Hold E to arm ...` when the local carrier is at the site, and `hostageHudSnapshot()` only returns `Hold E to secure ...` when the local rescuer is already inside the cluster radius.
- HUD and world wording do not yet match in-world. Labels such as `Kiln Yard`, `Loading Crew`, `Generator Workers`, and `Water Tower Gate` exist in metadata and HUD/debug snapshots, but the primitive scene has no visible text, symbol, painted boundary, or prop cluster tying those words to locations.
- Active-state presentation is HUD/feed-only. Planting, defusing, securing, and extracting change state and progress bars, but no nearby world prop or marker visibly changes.
- Mission rotation adds confusion. `resolveActiveMission()` alternates mission type by round number and indexes the active site/cluster by the same round number. On Sandline, round 1 is bomb site index 0 (`Kiln Yard`), round 2 is hostage cluster index 1 (`Loading Crew`), round 3 is bomb site index 0 again, and round 4 is hostage cluster index 1 again. `Shutter Lift` and `Generator Workers` exist in metadata but do not appear in normal alternating play until the round/site selection logic changes.

Recommended marker style: use original dusty industrial treatment such as worn circular floor boundaries, striped utility plates, relay boxes, low gate signs, worker-zone low barriers, and extraction threshold paint. Avoid modern waypoint beams, holograms, neon arrows, minimap/radar clone work, copied CS site markings, or tutorial cards.

## Map Audit

All five shipped maps declare two teams, main/corridor/flank route notes, focus points, Relay Charge sites, Evac Escort hostage clusters, and an extraction zone. Existing QA proves each map loads and has separated spawns, but it does not prove every route claim or objective sequence is reachable by player-equivalent collision.

### Sandline Foundry

- Spawns: Amber `Water Tower Court` at south focus; Cobalt `Blue Shutter Bay` at north focus.
- Route claims: main `Central Yard`, corridor `Generator Hall`, flank `Drain Underpass`.
- Focus points: south/north spawns, `Central Yard`, `Generator Hall`, `Drain Underpass`, `East Catwalk`, `Loading Bay`.
- Relay sites: `Kiln Yard` at `Central Yard`, routes `main-yard` + `generator-hall`; `Shutter Lift` at `Loading Bay`, routes `drain-underpass` + `main-yard`.
- Evac clusters/extraction: `Generator Workers` at `Generator Hall`; `Loading Crew` at `Loading Bay`; extraction `Water Tower Gate` at south spawn.
- Finding: the west `Generator Hall` claim is the highest-risk mismatch. Primitive geometry creates a west corridor slab, outer wall, inner north/south walls, and north/south caps. The south cap and south shed/low-spawn geometry visually and collision-wise close the Amber-side south approach into the corridor. The inner wall split leaves a center opening toward `Central Yard`, so the route can behave like a side pocket reached from mid rather than a true Amber-left flank. This matches the user report that Amber cannot access a west flank despite the summary promising one.
- Navigation implication: `findOpenGroundPosition()` and the tactical graph can correct individual anchors and may plan to the `Generator Hall` focus through a center-side opening, but that does not prove the claimed south-to-west lane exists. The layout needs a real, readable Amber-side entrance or a metadata/preview correction.
- Objective readability: `Kiln Yard` is not visibly tied to the crate island; `Shutter Lift` is not visibly marked at the north loading/awning area; `Generator Workers`, `Loading Crew`, and `Water Tower Gate` are HUD/debug labels without world treatment.

### Transit Crates

- Spawns: Amber `South Depot Apron`; Cobalt `North Wagon Bay`.
- Route claims: main `Container Lane`, corridor `Shutter Alley`, flank `Rail Flank`.
- Focus points: `South Depot Apron`, `North Wagon Bay`, `Container Lane`, `Shutter Alley`, `Rail Flank`.
- Relay sites: `Gantry Console` at main yard; `Wagon Switch` at rail flank.
- Evac clusters/extraction: `Shutter Staff` at shutter alley, `Gantry Riggers` at yard, extraction `North Wagon Lane` at rail flank.
- Findings: objective labels are metadata/HUD-only. `Shutter Alley` uses a west corridor wall/cap pattern similar to Sandline, so it needs a segment reachability audit from both spawns instead of assuming the preview route is truly traversable. `Rail Flank` has wagon cover and is likely the clearest alternate route, but extraction at `Rail Flank` needs visible release treatment and route validation.

### Breaker Vault

- Spawns: Amber `South Bunker Apron`; Cobalt `North Bunker Apron`.
- Route claims: main `Pit Rim`, corridor `Blast Door Hall`, flank `Drain Route`.
- Focus points: south/north aprons, `Turbine Pit`, `Blast Door Hall`, `Drain Flank`.
- Relay sites: `Turbine Rim` at pit, `Blast Lock` at blast-door hall.
- Evac clusters/extraction: `Drain Crew` at drain flank, `Blast Staff` at blast-door hall, extraction `North Bunker Exit` at pit focus.
- Findings: the bunker identity is readable through pit/door/bridge primitives, but objective action zones are unmarked. `North Bunker Exit` resolves to the `pit` focus rather than a distinct north-apron focus, so the extraction label may not map to what the player expects from the world wording. The west blast hall and east drain route need route-graph segment checks from both spawns and objective positions.

### Quarry Slip

- Spawns: Amber `South Loading Pocket`; Cobalt `North Cargo Slip`.
- Route claims: main `Slip Yard`, corridor `Harbor Office Run`, flank `Pier Catwalk`.
- Focus points: south/north spawns, `Slip Yard`, `Harbor Office Run`, `Pier Catwalk`.
- Relay sites: `Slip Cradle` at slip yard, `Pier Winch` at pier catwalk.
- Evac clusters/extraction: `Office Staff` at office run, `Crane Team` at slip yard, extraction `North Cargo Release` at pier catwalk.
- Findings: landmark identity is stronger than most maps because the mooring crane and catwalk are visible concepts, but objective zones still rely on HUD names. The raised catwalk/flank must be validated as player/bot reachable without relying on jump/clipping; if not, route metadata should move objective/extraction focus to a ground-reachable point or add explicit ramp/stair geometry.

### Ledger Annex

- Spawns: Amber `South Admin Entry`; Cobalt `North Archive Wing`.
- Route claims: main `Archive Court`, corridor `Records Run`, flank `Archive Bridge`.
- Focus points: south/north spawns, `Archive Court`, `Records Run`, `Archive Bridge`.
- Relay sites: `Archive Court Relay`, `Bridge Lock`.
- Evac clusters/extraction: `Records Clerks`, `Archive Custody`, extraction `North Archive Wing`.
- Findings: labels are internally consistent and original, but visible objective treatment is absent. The bridge route is metadata-critical for both `Bridge Lock` and `North Archive Wing`; it needs collision/nav validation because the current collision system treats most boxes above the walkable threshold as solid AABBs, not ramps or true multi-level traversal.

## Collision And Navigation Findings

- `src/world/primitives.ts` creates plain Three.js boxes/cylinders with names and colors only. It does not encode gameplay intent, signs, labels, objective zones, route paint, or active state.
- `src/game/collision.ts` converts primitive boxes/cylinders into AABB colliders unless they are low walkable pieces. Rotated primitive collision is not represented; current maps mostly avoid rotated colliders.
- `findOpenGroundPosition()` can move a spawn/focus/objective anchor to a nearby open sample. This prevents immediate spawn-in-blocker failures, but it can hide bad map layout by making a blocked objective anchor look usable in debug snapshots.
- `src/game/tacticalNavigation.ts` builds a deterministic lightweight graph from tactical profile anchors, objective nodes, and offset nodes. Edges are accepted only when sampled with `isSegmentTraversable()` using player-equivalent radius/body height. This is the correct tool for future reachability QA.
- Current debug snapshots expose graph `nodeCount`/`edgeCount` and per-bot route plans, but there is no durable map-wide reachability report that checks every spawn, route, focus, bomb site, hostage cluster, extraction zone, and route sequence.
- Segment checks are runtime-only and not documented per shipped map. The remaining implementation should add a `mapReachability` helper/debug surface that reports reachable/blocked route claims with labels and blocker context.

## Solo Bot Objective Findings

Current strengths:

- Bots use `updateSharedMovement()` with the same walk, crouch, jump, gravity, and collision contract as the player.
- `tacticalAi.ts` exposes medium-term strategy and objective intent: Relay carrier/site/support/defuse and Evac cluster/extraction/route guard intents.
- `localMatch.ts` routes bot behavior targets through `planTacticalRoute()`, tracks route plans, classifies stuck state, and applies bounded recovery without teleporting.
- Relay state supports carrier reassignment via `synchronizeBombCarrier()`.
- Objective actions obey the same radius/team/phase rules as player/remote actors.

Gaps for natural completion:

- Enemy objective actions only start after a bot is already inside the relevant radius and `enemyCanCommitObjectiveAction()` permits commitment. A bot seeing a viable player threat can keep canceling or delaying action.
- `enemyCanCommitObjectiveAction()` treats a dead player as safe but otherwise can block objective actions when the bot has clear visibility and the player is within objective threat distance. That is human-like, but it also means solo completion frequency depends heavily on line-of-sight and route layout.
- Evac Escort extraction depends on hostages reaching extraction and the rescuer being in the extraction radius. Hostage movement advances along declared route points after securing, but QA currently stages the player/rescuer positions for deterministic proof.
- The current final QA has strong staged evidence, not enough natural-play evidence for the parent goal. `stageEnemyBombPlantCase()` teleports the carrier to the bomb site. `stageEnemyRelayDefuseCase()` plants the charge and teleports the defuser to the site before starting defuse. `stageEnemyHostageEscortCase()` teleports the rescuer to the cluster. `stageEnemyRelayRouteCase()` verifies intent/route debug from spawn, but does not wait for a carrier to naturally arrive and plant.
- Natural objective completion should be proven with bounded harness cases that start bots at spawn or plausible route positions and let the shipped movement/objective loops complete the action. If acceleration is needed, it should shorten timers or reduce combat interruption while preserving route travel and radius rules, not teleport between phases.

## LocalMatch Ownership Audit

`src/game/localMatch.ts` is `8227` lines and currently owns too many independent systems:

- Three.js renderer, scene, camera, lights, ground, primitive construction, resize, disposal.
- Pointer-lock/fallback-look input gating, key/mouse handlers, fullscreen handling, browser-safe prevent-default behavior.
- Local player movement, crouch/jump state, input history, prediction/reconciliation, debug input hooks.
- Weapon state, fire/reload, recoil, muzzle flash, shot debug, shared shot claim/result validation, rewind frames.
- Round state creation/ticking/reset, team counts, roster construction.
- Bomb and hostage runtime integration, action start/cancel/complete methods, HUD progress text, objective role labels.
- Hostage actor creation, update, visibility, and animation state.
- Solo enemy lifecycle, strategy evaluation integration, route planning, recovery, LOS, contact sharing, combat, objective-action hooks.
- Remote/shared-room actor lifecycle, host/guest input application, host snapshots, authoritative guest snapshot adoption.
- HUD snapshot formatting, default prompt/status text, mode notices, operations board data.
- Debug/QA snapshots and staging hooks for movement, AI, objectives, shared room, shots, screenshots, fullscreen.

Proposed extraction boundaries:

- `src/game/matchScene.ts`: create renderer/camera/lights/ground/map primitive root; return environment raycast meshes and dispose helpers. Typed inputs: host, map, pixel ratio cap. Typed outputs: renderer, scene, camera, environment meshes.
- `src/game/objectiveMarkers.ts`: create and update in-world objective markers from map mission metadata plus active `BombRuntimeState`/`HostageRuntimeState`. Typed output should include marker debug records with labels, positions, radii, active state, and visibility/state flags.
- `src/game/mapReachability.ts`: build map-wide reachability reports using `buildCollisionWorld()`, `buildTacticalProfile()`, `buildTacticalRouteGraph()`, and `planTacticalRoute()`. Typed report should cover spawns, focus points, route notes, bomb sites, hostage clusters, extraction zone, and hostage route sequences.
- `src/game/objectiveBotGoals.ts`: move objective target selection and action-commit decisions out of `LocalMatch`, including route-id anchor lookup, bomb site route IDs, hostage cluster/extraction route anchors, escort-progress anchor selection, and intent-to-target mapping. Keep movement and state-machine mutation in existing modules/local coordinator.
- `src/game/matchHudSnapshot.ts`: move `objectiveHudSnapshot()`, `bombHudSnapshot()`, `hostageHudSnapshot()`, status-line objective formatting, and possibly objective role labels into pure/typed helpers fed by local distances and input-capture state.
- `src/game/matchDebugSnapshot.ts`: assemble debug snapshots from typed state without owning gameplay mutation. Include bomb/hostage snapshots, map reachability, marker state, tactical navigation counts, and bot objective decisions.
- `src/game/hostageActors.ts`: create/update/dispose hostage avatars from `HostageRuntimeState` and scene, returning minimal actor debug state if needed.
- Keep `localMatch.ts` as the integration coordinator for the match loop, event handlers, state mutation order, and shared-room boundary. Do not create circular imports or a second movement/objective/shared-room model.

## Prioritized Implementation Plan

1. Behavior-preserving refactor slice:
   - Extract `hostageActors`, `matchHudSnapshot`, and objective target helper logic first. These are high-churn areas for the parent goal and can be validated by `npm run build` plus existing objective QA.
   - Keep public debug method names stable or update `scripts/qa/finalVerification.mjs` in the same slice.

2. Reachability/reporting slice:
   - Add `mapReachability.ts` and a debug/report surface.
   - Generate a durable per-map route/objective reachability table for all shipped maps.
   - Specifically prove or fail Sandline Amber spawn to `Generator Hall`, `Generator Hall` to `Central Yard`, and active objective routes without jump/clipping.

3. Sandline layout/metadata fix:
   - Open a real Amber-side west entrance into `Generator Hall` or revise the route claim if a side pocket is intentional.
   - Preserve a close-quarters choke; do not widen into an open hallway.
   - Re-check route graph and player-equivalent collision after geometry changes.

4. World objective markers:
   - Add `objectiveMarkers.ts` with original primitive floor/site/gate treatment.
   - Match marker labels to mission state and make active markers subtly clearer than inactive alternatives.
   - Add marker debug state and screenshot QA.

5. Natural bot objective completion:
   - Add bounded natural QA for Relay carrier travel to active site, plant, planted resolution or defender defuse attempt.
   - Add bounded natural QA for Evac rescuer travel to cluster, secure, escort route progress, extraction, and resolution.
   - Tune objective commitment only where evidence shows stale contact/combat interruption prevents believable completion.

6. Final QA/docs:
   - Run `npm run build`, `npm test`, and `npm run qa:final` when visual markers/screenshots change.
   - Update `README.md`, `docs/qa/local-play.md`, `docs/qa/classic-feel.md`, `docs/qa/final-release.md`, and `docs/qa/visual-report.md` as needed.

## Validation Strategy

- Keep existing final QA passing after every refactor slice.
- Add deterministic map reachability assertions before changing Sandline geometry so the failing route is explicit.
- After Sandline edits, assert:
  - Amber spawn can route to `Generator Hall` through a west/left path without jumping or clipping.
  - `Generator Hall` reconnects to `Central Yard` or north pressure.
  - Both teams can route to active bomb sites, hostage clusters, extraction, and route sequence points.
- Add marker debug assertions:
  - active Relay site marker exists and label matches HUD objective label;
  - hostage cluster and extraction markers exist and labels match HUD/debug state;
  - screenshots show low-poly dusty industrial treatment, not modern waypoint UI.
- Add natural bot objective assertions:
  - no teleported carrier/rescuer directly onto final action radius for the proof;
  - route plan remains reachable and uses player-equivalent movement/collision;
  - objective action starts and completes inside the same state machines/radius rules.

## Remaining Work For Later Subgoals

- No code changes were made in this audit subgoal.
- All route reachability claims still need a current executable report.
- Sandline west route needs a concrete geometry/metadata fix.
- Objective markers need runtime creation, state updates, debug state, and screenshots.
- Natural bot objective completion needs stronger non-teleport QA.
- `localMatch.ts` needs measurable extraction and post-refactor validation.

## World Objective Marker Update

Date: `2026-06-02`

Subgoal: `add-world-objective-markers-and-label-match`

### Implementation

`src/game/objectiveMarkers.ts` now owns Sandline-compatible world objective marker creation, visual state updates, and typed marker debug records.

- Relay Charge sites are created from `map.objectives.bomb.sites`, so both `Kiln Yard` and `Shutter Lift` get procedural floor rings, utility plates, low state panels, and readable low signs tied to their mission labels.
- Evac Escort markers are created from `map.objectives.hostage`, so `Generator Workers`, `Loading Crew`, and `Water Tower Gate` get holding-zone or extraction-threshold treatment from the same objective metadata used by the HUD.
- Marker visuals are original primitive/procedural geometry and canvas text only. No external assets, copied Counter-Strike site marks, minimap/radar clone, waypoint beam, hologram, or neon objective UI was added.
- Active objectives are slightly more legible than inactive alternatives. Runtime phases such as planted/defusing/securing/extracting change the marker state panel color/scale in a restrained way.
- `src/game/localMatch.ts` creates the marker set after scene construction and updates it from live `BombRuntimeState`, `HostageRuntimeState`, and `RoundState`.
- `debugSnapshot().objectiveMarkers` now reports marker `id`, `kind`, `label`, `focusId`, position, radius, active/visible flags, phase, team role, state hint, and HUD-label match evidence.

### Browser QA Evidence

`scripts/qa/finalVerification.mjs` now asserts marker debug records before relying on screenshots:

- Sandline round-one Relay Charge exposes active `Kiln Yard`, inactive `Shutter Lift`, inactive hostage cluster markers for `Generator Workers` and `Loading Crew`, and inactive extraction marker `Water Tower Gate`.
- The active Relay marker label matches the live HUD objective label.
- After local planting, the active Relay marker reports `stateHint: site-armed`.
- Sandline round-two Evac Escort exposes active `Loading Crew` and active `Water Tower Gate`, with marker labels matching `Loading Crew to Water Tower Gate`.
- The active hostage marker reports `stateHint: secure-zone`; the extraction marker reports `extract-threshold`, then `extracting` during extraction progress.

The QA harness also refreshes marker screenshots:

- `assets/screenshots/04-sandline-central-yard.png`: active `Kiln Yard` marker in the central/crate-island pressure space.
- `assets/screenshots/14-sandline-loading-bay-marker.png`: `Shutter Lift`/loading-bay marker treatment near the north shutter area.
- `assets/screenshots/15-sandline-water-tower-gate-marker.png`: active `Water Tower Gate` extraction threshold with hostage/low-barrier context.

### Commands

Fresh commands run for this marker subgoal:

```bash
npm run typecheck
npm run build
npm run qa:final
npm test
```

Results:

- `npm run typecheck`: passed.
- `npm run build`: passed with the known non-blocking Vite `localMatch` chunk-size warning.
- Initial marker-subgoal reruns exposed a later AI sightline/recovery wait outside the marker work.
- Final 2026-06-02 reruns now pass that later section: `npm test` rebuilt successfully and completed the full browser QA harness, and a bounded standalone `npm run qa:final` returned exit `0` while refreshing screenshots from current `dist`.

## Reachability Update: Sandline West Route

Date: `2026-06-02`

Subgoal: `fix-map-reachability-and-sandline-west-route`

### Deterministic Reachability Surface

`src/game/mapReachability.ts` now builds a map-wide report from current map metadata, collision, tactical profile, tactical graph, and player-equivalent dimensions:

- radius: `0.62`
- standing body height: `1.72`
- checks include team spawns to tactical routes, spawns to focus points, delivery/hold teams to Relay Charge sites, rescue/hold teams to Evac Escort clusters, extraction access, declared bomb route links, and hostage route sequences.
- each check records graph route evidence and collision-grid reachability. The collision grid uses `isSegmentTraversable()` and the existing collision world, so it catches true blockers without treating sparse graph failures as geometry failures.

The report is exposed at `debugSnapshot().mapReachability.report`, and `scripts/qa/finalVerification.mjs` now asserts every shipped map reports zero blocked route/objective reachability checks during the existing map startup loop. Sandline additionally asserts graph-route reachability for:

- `Water Tower Court` to `Generator Hall`.
- `Generator Hall` reconnecting toward `Central Yard`.
- `Blue Shutter Bay` contesting `Generator Hall`.

### Current Report Summary

Generated through a targeted temporary TypeScript compile into `/tmp` and `buildMapReachabilityReport()`:

| Map | Checks | Blocked | Notes |
| --- | ---: | ---: | --- |
| Sandline Foundry | 38 | 0 | West `Generator Hall` route is collision-reachable and graph-reachable from Amber, reconnects to `Central Yard` through the west/mid return, and remains contestable from Cobalt. |
| Transit Crates | 34 | 0 | Route claims, objectives, hostage route, and extraction are collision-reachable and graph-reachable. |
| Breaker Vault | 34 | 0 | Route claims, objectives, hostage route, and extraction are collision-reachable and graph-reachable. |
| Quarry Slip | 34 | 0 | Route claims, objectives, hostage route, and extraction are collision-reachable and graph-reachable. |
| Ledger Annex | 34 | 0 | Route claims, objectives, hostage route, and extraction are collision-reachable and graph-reachable. |

Sandline west-route graph evidence:

- `Water Tower Court` to `Generator Hall`: `graphReachable: true`, `reason: graph-route`, path `Water Tower Court > Tactical connector > Generator Hall > Generator Hall`, cost `19.53`.
- `Generator Hall` to `Central Yard`: `graphReachable: true`, `reason: graph-route`, path `Generator Hall > Tactical connector > Tactical connector > Central Yard > Central Yard`, cost `17.18`.
- `Blue Shutter Bay` to `Generator Hall`: `graphReachable: true`, `reason: graph-route`, path `Blue Shutter Bay > Loading Bay route offset > Tactical connector > Generator Hall > Generator Hall`, cost `32.43`.

### Sandline Layout Changes

Sandline Foundry now has a real Amber-side west entry into `Generator Hall`:

- The former solid `Generator hall south cap` was split into two jambs, leaving a narrow south threshold.
- Low, walkable route-band primitives were added at the south Generator Hall entry to make the left route readable from `Water Tower Court` without using modern waypoint treatment.
- The `South shed` was narrowed and shifted east so it screens the spawn court without sealing the west threshold.
- The `Generator hall inner south` wall was shortened into a south choke segment, opening a compact mid return from Generator Hall without turning the lane into a wide hallway.
- `Central Yard`, `Generator Hall`, and `Loading Bay` focus targets were moved from inside solid landmark geometry to adjacent open floor positions, so metadata anchors match navigable space instead of relying on collision correction.
- Sandline copy now describes the west route as a narrow south Generator Hall entry from Water Tower Court, preserving the lane identity and choke.
- `src/game/tacticalNavigation.ts` now adds sparse collision-validated tactical connector nodes to the existing anchor/offset graph, so bot-equivalent route plans can traverse real open floor between anchors while still respecting collision and player dimensions.

### Verification Notes

- `npm run typecheck`: passed.
- `npm run build`: passed with the known non-blocking Vite chunk-size warning.
- Initial map-reachability reruns passed the strengthened map assertions and then exposed the same later bot-behavior wait.
- Final 2026-06-02 browser reruns passed the full harness after the bot-objective subgoal: Sandline graph-route checks, roster-wide zero-blocked reachability totals, marker debug assertions, natural/bounded bot objective evidence, local/shared regressions, and screenshot refresh all completed.

## Final Browser QA, Docs, And Evidence

Date: `2026-06-02`

Subgoal: `final-browser-qa-docs-and-evidence`

### Fresh Validation

Commands run on the final tree:

```bash
npm run typecheck
npm run build
npm test
npm run qa:final
```

Results:

- `npm run typecheck`: passed.
- `npm run build`: passed and produced static `dist/` output; Vite repeated the known non-blocking chunk-size warning for `localMatch-csJT0ADS.js` at `689.10 kB`.
- `npm test`: passed after rebuilding and completing `scripts/qa/finalVerification.mjs`.
- `npm run qa:final`: passed as a standalone command and refreshed the current screenshot set.

Verifier rework had found standalone `npm run qa:final` failing while waiting for `weaponView.muzzleFlashRecent === true`. The fix was limited to the QA-only `debugFire()` hook: it now guarantees an active, reload-free one-shot state before invoking the same internal fire path. Fresh standalone `qa:final` and `npm test` reruns both report `muzzleFlashRecent: true` and `flashVisible: true` in the firing weapon snapshot.

### Accepted Browser Evidence

- Objective markers: Sandline exposes marker debug state for active `Kiln Yard`, inactive `Shutter Lift`, hostage cluster markers, and `Water Tower Gate`; marker labels match HUD objective labels; planting and extraction update marker state hints.
- Screenshots refreshed: `04-sandline-central-yard.png`, `14-sandline-loading-bay-marker.png`, and `15-sandline-water-tower-gate-marker.png` show the Relay site, loading/shutter site, and extraction threshold marker treatments.
- Reachability: all shipped maps report zero blocked reachability checks in browser QA. Sandline reports 38 checks with 0 blocked; the other shipped maps report 34 checks with 0 blocked.
- Sandline west route: browser QA confirms graph-route access from `Water Tower Court` to `Generator Hall`, `Generator Hall` back toward `Central Yard`, and `Blue Shutter Bay` into `Generator Hall`.
- Relay bots: QA observes carrier intent `carrier_site_commit`, support intents `carrier_escort` and `carrier_flank_screen`, support targets `Copper-2 escort` and `Generator Hall`, plant through the live state machine, planted state, defender `defuse_rotate`, and `defusing`.
- Evac bots: QA observes rescuer intent `escort_extract`, a graph route toward `Drain Underpass` via `Loading Bay route offset`, route labels `Loading Crew > Drain Underpass > Central Yard > Generator Hall > Water Tower Gate`, extracted count `2`, and resolution `Vale-3 extracted Loading Crew.`
- Regression surfaces: local bomb/hostage objective flows, same-browser shared objective sync/fallback, movement/crouch/jump, dead-until-next-round, LOS blocker behavior, delayed contact, difficulty default/persistence/fallback, HUD snapshots, fullscreen/Tab behavior, and human-only shared-room bot scope remain covered by the passing harness.

### Modularization Ownership

- `src/game/matchScene.ts`: Three.js match scene/environment setup.
- `src/game/hostageActors.ts`: hostage actor creation, sync, update, and disposal.
- `src/game/matchHudSnapshot.ts`: objective HUD snapshot formatting and HUD-label evidence.
- `src/game/matchDebugSnapshot.ts`: debug snapshot helper formatting.
- `src/game/objectiveMarkers.ts`: procedural world objective marker creation, active-state updates, and marker debug records.
- `src/game/mapReachability.ts`: route/objective reachability report generation and Sandline west-route evidence.
- `src/game/objectiveBotGoals.ts`: objective-bot goal evidence from live strategy/route state.
- `src/game/localMatch.ts`: remains the integration coordinator for match loop order, input, movement, combat, objective state mutation, shared-room boundaries, and QA hooks.

### Guardrail Confirmation

- `package.json` still lists only `three` under runtime dependencies.
- No external runtime assets were added; `docs/assets.md` remains the current originality/asset-policy record.
- No Counter-Strike names/assets/UI/maps/sounds were added. Policy references to blocked names remain negative assertions only.
- No sprint layer, parkour route, bunnyhop-centric movement, heavy engine, server requirement for solo bots, or deployment action was introduced.
