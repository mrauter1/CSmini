# Multiplayer QA

Date: 2026-05-29

## Scope

Targeted verification for shared-room behavior inside `round-core-and-movement-foundation`, `bomb-mission-mode`, and `hostage-mission-mode`:

- same-map roster membership
- explicit team assignment sync
- round phase sync
- third-person remote avatar aim sync with upright body roots
- team-specific remote avatar uniforms, including Amber's domino mask
- remote-player gunfire events and playable distance-normalized world-fire audio
- different-map isolation
- missing `BroadcastChannel` fallback
- bomb carrier sync, planted-state sync, and defender-side defuse resolution
- hostage rescuer assignment sync, escort-route progress sync, and extraction resolution

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

### Remote aim and fire feedback

The same two pages were staged into a direct duel pose with opposite vertical look offsets before objective testing continued.

Observed results:

- both pages kept the remote combatant root upright and above ground
- remote body yaw tracked the other player horizontally while root pitch stayed near zero
- the remote weapon aim pivot tracked the full look vector, including vertical pitch, so the gun points where the other player is looking instead of pitching the whole character
- page 1 saw the remote Cobalt operator with the blue-gray uniform and no domino mask
- page 2 saw the remote Amber operator with the warm rust/tan uniform and a dark domino mask
- page 1 fired a live shared-room shot and recorded a `shared-sent` shot event
- page 2 received the same shot as `shared-received`, marked the remote actor with a recent shot, and logged a playable `world-fire` audio event after its audio context was armed
- the received world-fire event carried distance, normalized gain bounded inside the accepted `0.08..0.92` range, no blocked reason, and boosted output gain for audibility

Result: shared-room combat now distinguishes body yaw from weapon pitch and gives observers audible opponent gunfire feedback for remote shots, including misses.

### Shared bomb round

The same two pages then stayed on `Sandline Foundry` for a live relay-charge exchange:

- page 1 forced the shared round into `active`, stood in the declared `Kiln Yard` site, and began the relay-charge arm action as the attacking `Amber Vanguard` operator
- page 2 saw the same attacking operator listed as the bomb carrier before the plant
- both pages advanced to `planted`
- page 2 rendered the same planted-pressure HUD line (`12.1s to breach`) and then moved onto the live site as the `Cobalt Reach` defender
- page 2 completed the disarm, and both pages resolved with matching `disarmed Kiln Yard` result text

Result: the retained shared-room path now propagates bomb carrier ownership, planted-site pressure, and defuse resolution without stale mission state between peers.

### Shared hostage round

The same two pages then advanced into round `2`, which rotated `Sandline Foundry` onto the hostage mission `Evac Escort`.

- page 1 stayed on `Amber Vanguard`
- page 2 stayed on `Cobalt Reach`, the rescue-side team for the hostage round
- page 2 secured the live `Loading Crew` cluster, and page 1 observed the same rescuer id (`operator-9bdbb2b0`) through shared state
- both pages exposed the same named escort route:
  - `Loading Crew`
  - `Drain Underpass`
  - `Central Yard`
  - `Generator Hall`
  - `Water Tower Gate`
- page 1 observed both hostage slots advance their route progress to `2`
- page 1 observed `extractedCountObserved: 2`
- both pages resolved with matching `extracted Loading Crew` result text
- page 1 rendered the live extraction HUD line `1.6s to clear Water Tower Gate`

Result: the retained shared-room path now synchronizes rescuer ownership, hostage escort progression, extraction pressure, and final rescue resolution between peers without leaving the hostage state stale or orphaned on the observing page.

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

- The forced next-round advance used in the harness is a QA-only control path used to deterministically rotate from the round-one relay-charge mission into the round-two hostage mission; the shipped gameplay still advances rounds through live resolution and reset.
- Tactical-AI multiplayer behavior remains outside this QA note and will be covered in the later AI-focused subgoal.
