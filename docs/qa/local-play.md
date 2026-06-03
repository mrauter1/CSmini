# Local Play QA

Date: 2026-06-03

## Scope

Targeted verification for `round-core-and-movement-foundation`, `bomb-mission-mode`, and `hostage-mission-mode`:

- explicit team entry in the browser flow
- solo bot difficulty selection with `easy`, `medium`, and `hard`
- `medium` as the default solo bot level when storage is empty or unavailable
- best-effort solo bot difficulty persistence across reload when storage works
- safe solo-local fallback when bot-difficulty storage throws
- solo bots using the same walk, crouch, air-control, gravity, jump, and collision contract as the player
- roster-wide team spawn separation across every shipped playable map
- live round metadata driven from declared mission data
- crouch camera and speed change
- jump lift and safe landing
- dead-until-next-round behavior in the local round shell
- attacker-side relay charge ownership in live bomb rounds
- valid-site planting with a visible planted countdown
- bomb-round resolution by explosion in solo-local play
- rescue-side hostage securing on a live evac round
- named escort-route traversal from hostage cluster to extraction zone
- hostage extraction resolution and automatic next-round reset in solo-local play
- tactical AI opening behavior split between objective hold and route patrol
- blocked line-of-sight investigation without through-wall fire
- delayed squad contact sharing instead of instant omniscience
- bounded last-known pursuit memory and stuck-route recovery
- ordered `easy` / `medium` / `hard` shot-danger differences without movement-speed changes
- enemy-side bomb pressure through the same solo-local objective state
- live hit and miss behavior with spread and miss chance influenced by distance, movement, crouch, and visibility
- playable opponent gunfire world-audio events with distance-normalized gain
- bounded solo-round resolution after the AI overhaul
- map-aware route graph planning for blocked solo bot traversal
- independent solo bot strategies with deterministic role/profile debug data
- damage-driven strategy switching into cover or fallback decisions
- Relay Charge carrier, escort, flank-screen, and defuse-rotate intent
- Evac Escort hostage rescue, route extraction, escort support, and lane/cluster defense intent
- compact in-match HUD, hold-Tab operations board, and viewport-shell fullscreen control behavior
- team-specific opponent avatar uniforms

## Commands

```bash
npm run typecheck
npm run build
npm run qa:local-flow
npm run qa:final
npm test
```

`npm test` runs `node scripts/qa/finalVerification.mjs`, which starts `vite preview`, opens a WebGL-capable headless Chrome session, and drives the browser QA hooks exposed through `window.__dustlineQa__`.

Fresh 2026-06-02 reruns passed for the local surfaces that can regress during AI integration:

- `npm run qa:local-flow`: 5 map cards, local ammo `24 -> 23`, hidden control prompt after engage, death line `Down for the round.`, catalog return, and zero leftover canvases
- `npm run qa:final`: passed with solo bot difficulty default/persistence, canonical movement, HUD/Tab/fullscreen, solo bomb/hostage objective flows, AI, same-browser objective sync, fallback, and screenshot refresh
- `npm test`: passed after rebuilding and rerunning the final browser harness
- `npm run typecheck`: passed
- `npm run build`: passed with only the known non-blocking `localMatch` chunk-size warning

## Fresh Results

### Solo bot difficulty selection

- The menu and roster flow exposed exactly three solo bot controls: `easy`, `medium`, and `hard`.
- The default browser state reported `medium` through `window.__dustlineQa__.getState().botDifficulty`.
- A menu click changed the stored value to `hard`, and the same `hard` value carried into a live local round through the durable debug snapshot.
- A QA hook changed the live local round to `easy`, and the same debug snapshot updated in place without breaking the solo match shell.
- An explicit restore to `medium` kept the roster flow aligned with the default contract before the rest of the local-play pass continued.
- A reload-focused QA page kept `hard` selected after refresh when storage was available.
- A storage-failure QA page forced `localStorage` reads and writes for `dustline.soloBotDifficulty` to throw; the shell still defaulted to `medium`, accepted an in-memory `easy` selection, and opened a solo round without crashing.
- The player-facing note stayed explicit that the selector applies to solo rounds only and that shared-room sessions stay human-only across tabs.

### Roster-wide map pass

Each shipped playable map was opened twice in live local play: once as `Amber Vanguard` and once as `Cobalt Reach`. The harness confirmed a valid round state and mission label on load, then compared the resulting local spawn positions.

- `Sandline Foundry`: spawn separation `32.56` units, live mission `Relay Charge`, objective `Kiln Yard`
- `Transit Crates`: spawn separation `30.41` units, live mission `Relay Charge`, objective `Gantry Console`
- `Breaker Vault`: spawn separation `28.16` units, live mission `Relay Charge`, objective `Turbine Rim`
- `Quarry Slip`: spawn separation `28.07` units, live mission `Relay Charge`, objective `Slip Cradle`
- `Ledger Annex`: spawn separation `28.16` units, live mission `Relay Charge`, objective `Archive Court Relay`

Result: every shipped map loaded a live round from the declared mission metadata and used clearly distinct team spawn areas in play, not just in static data.

### HUD and viewport fullscreen checks

- The browser harness confirmed the old large in-match HUD card/overlay classes were absent from live play.
- The compact startup hint disappeared after controls were armed, health stayed bottom-left, ammo stayed bottom-right, and the round timer stayed in the top strip.
- The operations board stayed hidden by default, opened while `Tab` was held, ignored repeated `Tab` keydown as a toggle, and hid again on keyup.
- The final screenshot set includes `13-held-tab-operations-board.png`, captured by the browser harness while `Tab` was held, to preserve visual evidence of the detailed info panel.
- The fullscreen icon button was visible inside the match viewport shell with an accessible fullscreen label/title and no text label in the play view.
- A deterministic fullscreen mock proved the request target was the viewport shell, not the app root or page body; `fullscreenchange` resized the renderer host and canvas to `1012 x 720`; the held-Tab panel stayed usable while fullscreen was active; and exit returned the button to its enter state.
- A denied fullscreen request surfaced a compact status-line message and left debug fullscreen state inactive.
- `Esc` remained unprevented while controls were armed so the browser can release pointer lock or exit fullscreen through native behavior.

### Movement checks

- Standing camera height: `1.62`
- Crouched camera height: `1.18`
- Standing forward sample over the same timed window: `1.37` units
- Crouched forward sample over the same timed window: `0.79` units
- Jump sample peak camera height: `2.59`
- Jump sample landed camera height: `1.62`

Result: crouch lowered the camera and reduced speed; jump produced a clear airborne lift and returned to the original eye height on landing.

### Round-respawn case

- The harness forced player death in an active local round.
- After `1.5s`, the player was still down in the same round.
- A QA-only hook, `window.__dustlineQa__.forceNextRound()`, then advanced the match into the next round briefing.
- On the round reset, the player returned alive with `100 HP`, and the round counter advanced from `1` to `2`.

Result: default gameplay keeps the player out for the rest of the round. The forced next-round hook is a QA exception path used only to prove the reset behavior without waiting for the full objective timer.

### Local bomb round

- `Sandline Foundry` was reopened in local mode as `Amber Vanguard`.
- The harness forced the round into `active`, enabled a QA-only invulnerability flag so the current solo AI could not interrupt the objective proof, and snapped the local operator onto the declared `Kiln Yard` relay site.
- The live debug state reported `localCanPlant: true`, proving the declared bomb-site metadata was usable from the actual browser round state rather than only from static map data.
- The harness started the relay-charge action, observed the bomb state move through `planting` into `planted`, and read a live HUD pressure line of `14.6s to breach`.
- The round resolved by explosion with the result text ending in `breached Kiln Yard.`

Result: the solo-local path now assigns the attacking operator the relay charge, only allows arming inside the declared live site, exposes a planted countdown in the HUD, and resets cleanly after the explosion resolution.

### Local hostage round

- `Sandline Foundry` was reopened in local mode as `Cobalt Reach`.
- A QA-only `forceNextRound()` step advanced the map into round `2`, which rotated onto the declared hostage mission `Evac Escort` with the `Loading Crew` cluster and `Water Tower Gate` extraction zone.
- The harness forced the round into `active`, kept QA invulnerability enabled so the current solo AI could not interrupt the objective proof, and snapped the local operator into the live `Loading Crew` cluster.
- The debug state reported `localCanSecure: true`, proving the declared hostage-cluster metadata was usable from the live round state rather than only from static map data.
- The harness started the escort action, observed the hostage phase move through `securing` into `escorting`, then staged the rescuer at the extraction zone while the hostages traversed the named route:
  - `Loading Crew`
  - `Drain Underpass`
  - `Central Yard`
  - `Generator Hall`
  - `Water Tower Gate`
- Both hostage slots advanced their route progress to `2`, the debug state reported `extractedCount: 2`, the HUD exposed extraction progress (`0.7s to clear Water Tower Gate`), and the round resolved with `extracted Loading Crew.`
- After the rescue resolution, the normal round shell automatically reset into round `3` briefing without needing a forced-round QA shortcut.

Result: the solo-local hostage flow now supports live secure, escort, route traversal, extraction, readable HUD feedback, and a clean automatic reset into the next round.

### Local tactical AI round

- `Sandline Foundry` was reopened in local mode as `Amber Vanguard`, the round was forced live, and the AI fireteam opened with distinct roles: one enemy held `objective`, while the other two stayed on `patrol`.
- The opening objective bot was already in a live tactical crouch (`crouchBlend 0.814`) rather than only carrying a `standing | crouched` label.
- The live debug tuning reported a player-equivalent bot movement contract: walk `8.6u/s`, crouch `4.82u/s`, gravity `13.6`, jump velocity `5.25`, standing eye/body `1.62 / 1.72`, crouched eye/body `1.08 / 1.18`.
- A deterministic bot movement sample on that same round measured `5.16` units over `0.6s` standing (`8.6u/s`) and `2.89` units crouched (`4.816u/s`), confirming that crouch slows the bot through the same multiplier as the player while also lowering eye/body height.
- The same opening enemy samples exposed Cobalt Reach blue-gray uniform colors and no domino mask through the debug state.
- A QA-only `stageAiSightlineCase()` hook staged `enemy-0` behind the named blocker `Crate stack west`, with the player hidden on the `Generator Hall` side and a clear fallback pose at `Water Tower Court`.
- In the blocked pose, the debug state reported `visibility: 0` and `canSeePlayer: false`.
- Firing once from the blocked pose drew the enemy into `investigate`, but the same debug state kept `shotsFired: 0`, proving the bot reacted to sound without shooting through the crate stack.
- Moving to the clear pose on `hard` advanced the same enemy into `engage`; with QA invulnerability enabled, the bot fired `6` shots over `1.71s` while still producing both hits and misses.
- A deterministic bot jump sample for that same enemy started grounded, entered an airborne phase, peaked at feet `0.97` / eye `2.59`, then landed safely back at eye `1.62` after `0.767s`.
- A staged blocked-traversal recovery case now routes around the blocker through the tactical navigation graph before resorting to any jump. The final QA sample planned a non-direct `graph-route` through `Central Yard route offset`, kept the enemy upright, and recorded `jumpCount: 0` for the obstruction.
- A QA-only live jump request lifted the same engaged enemy to `feetY 0.355` while keeping root pitch at `0` and preserving the weapon-pitch aim contract, then landed back at `feetY 0` without breaking posture or aim separation.
- The live enemy shot path emitted a playable `world-fire` audio event with distance data, normalized gain in the accepted `0.08..0.92` range, and boosted output gain for audibility after the user-gesture unlock pulse armed the audio context.
- The live debug tuning reported bot fire interval `0.18s` and enemy damage `34`, matching the player fire interval and player damage while still applying difficulty-specific reaction, spread, hit chance, and burst pacing.
- Stale opponent-fire audio is not replayed after a late browser audio unlock; blocked shots are dropped rather than played out of time.
- After the player tagged that enemy once, the same bot switched into `reposition` with reason `angle`, then returned to objective pressure after the player ducked back behind cover.
- A staged observer/receiver pair proved squad contact stayed delayed: the receiver held `patrol` before delivery, then entered `pursue` only after the shared-contact lag elapsed.
- A bounded-memory follow-up proved the same last-known pursuit expired back out of `pursue` instead of lasting indefinitely.
- A staged blocked-traversal case forced the same enemy to use a graph waypoint rather than deadlocking or teleporting; the debug state exposed route reason, waypoint label, path labels, stuck classification, recovery action, and failed-jump suppression state.
- A deterministic difficulty sample on the same geometry produced ordered danger without changing locomotion:
  - `easy`: `reaction 0.487s`, `spread 7.124`, `hitChance 0.407`
  - `medium`: `reaction 0.377s`, `spread 6.037`, `hitChance 0.537`
  - `hard`: `reaction 0.237s`, `spread 4.951`, `hitChance 0.657`
- An enemy-side bomb-pressure case staged the attacking carrier onto `Kiln Yard`; the same live solo round moved through `planting` into `planted`, then resolved by breach as `Copper-2 breached Kiln Yard.`
- The shared shot model was sampled through the QA hook with three profiles:
  - close standing target: `hitChance 0.722`, `missChance 0.278`, `spread 3.479`
  - far moving target: `hitChance 0.262`, `missChance 0.738`, `spread 9.956`
  - crouched partial target: `hitChance 0.449`, `missChance 0.551`, `spread 6.176`

Result: the solo AI now exposes observable `objective`, `patrol`, `investigate`, `engage`, `reposition`, and `pursue` behaviors in a controlled round; moves, crouches, jumps, lands, and routes a blocked traversal through graph waypoints before any bounded jump recovery; does not detect or fire through blocking geometry; uses a non-perfect shot model shaped by range, movement, crouch, and visibility; and produces playable distance-normalized opponent gunfire feedback after audio is armed.

### Human-like map-aware bot pass

Fresh `npm run qa:final` and `npm test` runs on 2026-06-02, plus a full `npm test` rerun on 2026-06-03, extended the local tactical AI proof:

- Opening fireteam strategies split into `anchor_site`, `route_probe`, and `flank_rotate`, with per-bot roles `anchor`, `route`, and `flank`, deterministic profile seeds, and objective intents in the debug snapshot.
- Delayed shared-contact responders split away from the same last-known point into separate target-claim buckets (`Central Yard` and `Drain Underpass`) with `claimed-contact-route` adjustments.
- A blocked direct route at `Crate stack west` planned a non-direct graph route through `Central Yard route offset`; the staged obstruction kept `routeUsesGraph: true`, `routeReason: graph-route`, `jumpCount: 0`, and no teleport/deadlock.
- The same staged sightline kept `visibility: 0`, `canSeePlayer: false`, and `shotsFired: 0` through the blocker, then entered readable combat only from the clear pose.
- After the player damaged a bot, the bot switched to `cover_reposition` with `strategyReason: recent-damage`, proving meaningful mid-round strategy change rather than frame-by-frame jitter.
- Relay Charge enemy staging produced carrier intent `carrier_site_commit`, support intents `carrier_escort` and `carrier_flank_screen`, an offset `Copper-2 escort lane` claim with reason `carrier-escort-offset`, a separate `Drain Underpass` screen, and defender intent `defuse_rotate` during the planted/defusing state.
- Evac Escort enemy staging produced rescuer intent `escort_extract`, a graph route toward declared route label `Drain Underpass` through `Loading Bay route offset`, support intents `escort_extract` and `escort_flank_screen`, defender intents `hostage_cluster_anchor` plus `hostage_lane_probe`, and extraction completion once an attacking escort reached the zone with all hostages extracted.

Result: browser QA now proves the new map-aware route, recovery, strategy, and objective intent surfaces through staged live states that observe the shipped AI/update loop.

### Bounded solo resolution round

- The same staged enemy-side `Kiln Yard` plant case was allowed to continue into its natural solo-local round resolution.
- The round resolved without a forced advance as `Copper-2 breached Kiln Yard.`
- The carrier stayed on the live solo AI roster, and the round shell advanced to `resolution` without hanging.

Result: at least one upgraded solo round now progresses from live objective pressure to natural round resolution without AI deadlock, stuck pathing, or wall-vision regressions.

## Notes

- The movement and round verification stayed inside the browser build; no extra engine or non-browser runtime was introduced.
- The jump sample in the QA harness uses the live movement integrator through a dedicated QA hook to avoid headless browser timing noise while still validating the same movement code path.
- The shared bot-movement proof uses QA-only `enemyMovementSample()` and `requestEnemyJump()` hooks for deterministic sampling, while the staged recovery case separately proves that a shipped solo bot can use a non-direct graph waypoint around a blocked route and avoid repeated stuck-recovery jumps at that obstruction.
- The bomb proof uses QA-only hooks for `forceRoundActive`, `setInvulnerable`, and `startObjectiveAction` so the test can isolate the mission flow from headless timing while still exercising the shipped plant, fuse, and round-resolution code paths.
- The hostage proof also uses `forceNextRound`, `forceRoundActive`, `setInvulnerable`, `setCameraPose`, and `startObjectiveAction` so the harness can deterministically enter the round-2 evac mission, stage the escort path, and verify the real rescue timers and round-reset behavior without relying on manual headless navigation.
- The AI proof uses QA-only hooks for `stageAiSightlineCase()` and `evaluateEnemyShot()` so the harness can reproduce the same blocked-cover case and shot-profile comparisons on every run without weakening the live line-of-sight or combat code.
- The smarter-bot pass adds QA-only staging hooks:
  - `stageAiCommunicationCase()` for delayed squad-contact proof
  - `stageAiRecoveryCase()` for blocked-route recovery proof
  - `stageEnemyBombPlantCase()` for deterministic enemy-side objective pressure and bounded solo-round resolution
  - `stageEnemyRelayRouteCase()` for carrier/escort/flank-screen intent
  - `stageEnemyRelayDefuseCase()` for planted-charge defender rotation
  - `stageEnemyHostageEscortCase()` for hostage route extraction and support intent
