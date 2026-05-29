# Local Play QA

Date: 2026-05-29

## Scope

Targeted verification for `round-core-and-movement-foundation`, `bomb-mission-mode`, and `hostage-mission-mode`:

- explicit team entry in the browser flow
- solo bot difficulty selection with `easy`, `medium`, and `hard`
- `medium` as the default solo bot level when storage is empty or unavailable
- best-effort solo bot difficulty persistence across reload when storage works
- safe solo-local fallback when bot-difficulty storage throws
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
- live hit and miss behavior with spread and miss chance influenced by distance, movement, crouch, and visibility
- playable opponent gunfire world-audio events with distance-normalized gain
- bounded solo-round elimination after the AI overhaul
- compact in-match HUD, hold-Tab operations board, and viewport-shell fullscreen control behavior
- team-specific opponent avatar uniforms

## Commands

```bash
npm run typecheck
npm run build
npm test
```

`npm test` runs `node scripts/qa/finalVerification.mjs`, which starts `vite preview`, opens a WebGL-capable headless Chrome session, and drives the browser QA hooks exposed through `window.__dustlineQa__`.

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

- `Sandline Foundry`: spawn separation `29.17` units, live mission `Relay Charge`, objective `Kiln Yard`
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
- Standing forward sample over the same timed window: `1.72` units
- Crouched forward sample over the same timed window: `0.98` units
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
- The harness started the relay-charge action, observed the bomb state move through `planting` into `planted`, and read a live HUD pressure line of `11.8s to breach`.
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
- Both hostage slots advanced their route progress to `2`, the debug state reported `extractedCount: 2`, the HUD exposed extraction progress (`1.3s to clear Water Tower Gate`), and the round resolved with `extracted Loading Crew.`
- After the rescue resolution, the normal round shell automatically reset into round `3` briefing without needing a forced-round QA shortcut.

Result: the solo-local hostage flow now supports live secure, escort, route traversal, extraction, readable HUD feedback, and a clean automatic reset into the next round.

### Local tactical AI round

- `Sandline Foundry` was reopened in local mode as `Amber Vanguard`, the round was forced live, and the AI fireteam opened with distinct roles: one enemy held `objective`, while the other two stayed on `patrol`.
- The same opening enemy samples exposed Cobalt Reach blue-gray uniform colors and no domino mask through the debug state.
- A QA-only `stageAiSightlineCase()` hook staged `enemy-0` behind the named blocker `Crate stack west`, with the player hidden on the `Generator Hall` side and a clear fallback pose at `Water Tower Court`.
- In the blocked pose, the debug state reported `visibility: 0` and `canSeePlayer: false`.
- Firing once from the blocked pose drew the enemy into `investigate`, but the same debug state kept `shotsFired: 0`, proving the bot reacted to sound without shooting through the crate stack.
- Moving to the clear pose advanced the same enemy into `engage`; with QA invulnerability enabled, the bot fired `4` shots and split them into `2` hits and `2` misses.
- The live enemy shot path emitted a playable `world-fire` audio event with distance data, normalized gain in the accepted `0.08..0.92` range, and boosted output gain for audibility after the user-gesture unlock pulse armed the audio context.
- Stale opponent-fire audio is not replayed after a late browser audio unlock; blocked shots are dropped rather than played out of time.
- After the player tagged that enemy once, the same bot switched into `reposition` with reason `angle`, then dropped into `pursue` after the player ducked back behind cover.
- The shared shot model was sampled through the QA hook with three profiles:
  - close standing target: `hitChance 0.722`, `missChance 0.278`, `spread 3.479`
  - far moving target: `hitChance 0.262`, `missChance 0.738`, `spread 9.956`
  - crouched partial target: `hitChance 0.449`, `missChance 0.551`, `spread 6.176`

Result: the solo AI now exposes observable `objective`, `patrol`, `investigate`, `engage`, `reposition`, and `pursue` behaviors in a controlled round; does not detect or fire through blocking geometry; uses a non-perfect shot model shaped by range, movement, crouch, and visibility; and produces playable distance-normalized opponent gunfire feedback after audio is armed.

### Bounded solo elimination round

- `Sandline Foundry` was reopened again in local mode with QA invulnerability disabled.
- The same `Crate stack west` sightline case staged the player onto the clear `Water Tower Court` angle and let the live round continue without forcing eliminations.
- The round resolved naturally with `Cobalt Reach cleared the roster.`
- At resolution, the player was dead, the staged enemy was still in `engage`, and that enemy alone had fired `13` live shots.

Result: at least one upgraded solo round now progresses from start to elimination without AI deadlock, stuck pathing, or wall-vision regressions.

## Notes

- The movement and round verification stayed inside the browser build; no extra engine or non-browser runtime was introduced.
- The jump sample in the QA harness uses the live movement integrator through a dedicated QA hook to avoid headless browser timing noise while still validating the same movement code path.
- The bomb proof uses QA-only hooks for `forceRoundActive`, `setInvulnerable`, and `startObjectiveAction` so the test can isolate the mission flow from headless timing while still exercising the shipped plant, fuse, and round-resolution code paths.
- The hostage proof also uses `forceNextRound`, `forceRoundActive`, `setInvulnerable`, `setCameraPose`, and `startObjectiveAction` so the harness can deterministically enter the round-2 evac mission, stage the escort path, and verify the real rescue timers and round-reset behavior without relying on manual headless navigation.
- The AI proof uses QA-only hooks for `stageAiSightlineCase()` and `evaluateEnemyShot()` so the harness can reproduce the same blocked-cover case and shot-profile comparisons on every run without weakening the live line-of-sight or combat code.
