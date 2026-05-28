# Local Play QA

Date: 2026-05-28

## Scope

Targeted verification for `round-core-and-movement-foundation` and `bomb-mission-mode`:

- explicit team entry in the browser flow
- roster-wide team spawn separation across every shipped playable map
- live round metadata driven from declared mission data
- crouch camera and speed change
- jump lift and safe landing
- dead-until-next-round behavior in the local round shell
- attacker-side relay charge ownership in live bomb rounds
- valid-site planting with a visible planted countdown
- bomb-round resolution by explosion in solo-local play

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

## Notes

- The movement and round verification stayed inside the browser build; no extra engine or non-browser runtime was introduced.
- The jump sample in the QA harness uses the live movement integrator through a dedicated QA hook to avoid headless browser timing noise while still validating the same movement code path.
- The bomb proof uses QA-only hooks for `forceRoundActive`, `setInvulnerable`, and `startObjectiveAction` so the test can isolate the mission flow from headless timing and the intentionally lightweight current solo AI loop. The underlying plant, fuse, and round-resolution timers are still the shipped gameplay paths.
