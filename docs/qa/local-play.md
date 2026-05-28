# Local Play QA

Date: 2026-05-28

## Scope

Targeted verification for `round-core-and-movement-foundation`, `bomb-mission-mode`, and `hostage-mission-mode`:

- explicit team entry in the browser flow
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

## Commands

```bash
npm run typecheck
npm run build
npm test
```

`npm test` runs `node scripts/qa/finalVerification.mjs`, which starts `vite preview`, opens a WebGL-capable headless Chrome session, and drives the browser QA hooks exposed through `window.__dustlineQa__`.

## Fresh Results

### Roster-wide map pass

Each shipped playable map was opened twice in live local play: once as `Amber Vanguard` and once as `Cobalt Reach`. The harness confirmed a valid round state and mission label on load, then compared the resulting local spawn positions.

- `Sandline Foundry`: spawn separation `29.17` units, live mission `Relay Charge`, objective `Kiln Yard`
- `Transit Crates`: spawn separation `30.41` units, live mission `Relay Charge`, objective `Gantry Console`
- `Breaker Vault`: spawn separation `28.16` units, live mission `Relay Charge`, objective `Turbine Rim`
- `Quarry Slip`: spawn separation `28.07` units, live mission `Relay Charge`, objective `Slip Cradle`
- `Ledger Annex`: spawn separation `28.16` units, live mission `Relay Charge`, objective `Archive Court Relay`

Result: every shipped map loaded a live round from the declared mission metadata and used clearly distinct team spawn areas in play, not just in static data.

### Movement checks

- Standing camera height: `1.62`
- Crouched camera height: `1.26`
- Standing forward sample over the same timed window: `1.69` units
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
- The harness started the relay-charge action, observed the bomb state move through `planting` into `planted`, and read a live HUD pressure line of `11.9s to breach`.
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
- Both hostage slots advanced their route progress to `2`, the debug state reported `extractedCount: 2`, the HUD exposed extraction progress (`1.3s to clear Water Tower Gate`), and the round resolved with `Nova-27 extracted Loading Crew.`
- After the rescue resolution, the normal round shell automatically reset into round `3` briefing without needing a forced-round QA shortcut.

Result: the solo-local hostage flow now supports live secure, escort, route traversal, extraction, readable HUD feedback, and a clean automatic reset into the next round.

## Notes

- The movement and round verification stayed inside the browser build; no extra engine or non-browser runtime was introduced.
- The jump sample in the QA harness uses the live movement integrator through a dedicated QA hook to avoid headless browser timing noise while still validating the same movement code path.
- The bomb proof uses QA-only hooks for `forceRoundActive`, `setInvulnerable`, and `startObjectiveAction` so the test can isolate the mission flow from headless timing and the intentionally lightweight current solo AI loop. The underlying plant, fuse, and round-resolution timers are still the shipped gameplay paths.
- The hostage proof also uses `forceNextRound`, `forceRoundActive`, `setInvulnerable`, `setCameraPose`, and `startObjectiveAction` so the harness can deterministically enter the round-2 evac mission, stage the escort path, and verify the real rescue timers and round-reset behavior without relying on manual headless navigation.
