# Multiplayer QA

Date: 2026-05-28

## Scope

Targeted verification for shared-room behavior inside `round-core-and-movement-foundation` and `bomb-mission-mode`:

- same-map roster membership
- explicit team assignment sync
- round phase sync
- different-map isolation
- missing `BroadcastChannel` fallback
- bomb carrier sync, planted-state sync, and defender-side defuse resolution

## Commands

```bash
npm run typecheck
npm run build
npm test
```

The shared-room checks are part of `scripts/qa/finalVerification.mjs`.

## Fresh Results

### Same-map shared-room sync

Two headless pages opened `Sandline Foundry` in shared mode with explicit opposing team picks:

- page 1 joined as `Amber Vanguard`
- page 2 joined as `Cobalt Reach`

Observed results:

- page 1 roster count: `2`
- page 2 roster count: `2`
- each page saw the remote operator on the expected opposing team
- both pages reported the same round number and round phase

Result: shared-room mode synchronized team assignment, roster membership, and round phase on the same map.

### Shared bomb round

The same two pages then stayed on `Sandline Foundry` for a live relay-charge exchange:

- page 1 forced the shared round into `active`, stood in the declared `Kiln Yard` site, and began the relay-charge arm action as the attacking `Amber Vanguard` operator
- page 2 saw the same attacking operator listed as the bomb carrier before the plant
- both pages advanced to `planted`
- page 2 rendered the same planted-pressure HUD line (`12.0s to breach`) and then moved onto the live site as the `Cobalt Reach` defender
- page 2 completed the disarm, and both pages resolved with matching `disarmed Kiln Yard` result text

Result: the retained shared-room path now propagates bomb carrier ownership, planted-site pressure, and defuse resolution without stale mission state between peers.

### Map isolation

A third page opened `Transit Crates` in shared mode while the first two stayed on `Sandline Foundry`.

- isolated roster count: `1`

Result: shared-room state remained map-isolated.

### Shared round advance

The harness forced a QA-only round advance on page 1 and waited for page 2 to adopt it.

- round before advance: `1`
- round after advance on both pages: `2`
- synchronized phase after advance: `briefing`

Result: the information required for team rounds propagated across the room, including round number and phase.

### Missing multiplayer support fallback

A fresh page disabled `BroadcastChannel` before document scripts ran and then requested shared mode on `Sandline Foundry`.

Observed results:

- active mode: `local`
- HUD notice: `Shared room requested, but BroadcastChannel is unavailable in this browser, so shared-room sync cannot start. Solo drill armed instead.`

Result: missing shared-room support fell back to the local path without crashing.

## Notes

- The shared-room QA here is intentionally scoped to the active subgoal: team rounds, roster membership, round phase, map isolation, relay-charge carrier sync, planted pressure, and defender-side defuse. Full hostage-mode and tactical-AI multiplayer verification remains for later subgoals.
- The forced next-round advance used in the harness is a QA-only control path and not the shipped gameplay default.
