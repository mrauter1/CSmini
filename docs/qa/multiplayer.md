# Multiplayer QA

Date: 2026-05-30

## Scope

Targeted verification for shared-room and WebRTC room behavior:

- cloud/manual room connection through the canonical arena runtime
- host-authoritative roster, input, snapshot, health, status, and round-state sync
- guest shot claims with local feedback and host-authoritative shot results
- clear shots, blocked line-of-sight shots, fire-rate rejection, ammo-state rejection, and reload-state rejection
- signaling Worker role, size, relay, rate, ICE budget, TURN fallback, and room-cap guardrails
- same-map roster membership
- shared-room remains human-only; solo bot difficulty does not apply in this mode
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
npm run qa:local-flow
npm run qa:manual-signaling
npm run qa:shot-validation
npm run qa:signaling-worker
npm run qa:cloud-signaling
npm run qa:cloud-signaling-14
npm run qa:host-room
npm run qa:final
npm test
```

`npm test` rebuilds the app and runs the broader final browser verification. The standalone `npm run qa:final` command also passed and refreshed `assets/screenshots/`.

## Fresh Results 2026-05-31

Targeted follow-up for cross-network Cloud Room setup fixed the client and Worker ICE-candidate guard so browser-generated end-of-candidates markers and nullable optional candidate fields no longer surface `Cloud signaling rejected an oversized or invalid ICE candidate.` The browser ICE event path skips empty completion markers during normal gathering, while the guarded signaling serializer and Worker sanitizer accept the nullable marker shape for manual/test payloads. Candidate payload size caps remain in place.

Observed results:

- `npm run build`: passed and repeated the known non-blocking large `localMatch` chunk warning
- `npm run qa:signaling-worker`: passed with `nullableCandidateFieldsDropped: true` on the ICE relay probe
- `npm run qa:cloud-signaling`: passed with host/guest phases `connected`, rosters at `2`, remotes at `1`, delta snapshots, and a client-side nullable ICE marker reaching signaling instead of failing local validation
- `npm run qa:cloud-signaling-14`: passed with one host plus 13 guests connected, rosters at `14`, host remote count `13`, every guest remote count `13`, and delta snapshots

The cloud-signaling browser harness now chooses run-specific preview/debug ports so an unrelated local server on `4173` cannot make it load the wrong app during QA.

## Fresh Results 2026-05-30

### Command surface

Observed results:

- `npm run typecheck`: passed
- `npm run build`: passed and produced static `dist/` output; Vite repeated the known non-blocking large `localMatch` chunk warning
- `npm run qa:local-flow`: passed with 5 map cards, local ammo `24 -> 23`, hidden prompt after controls engage, death line `Down for the round.`, return to catalog, and zero canvases after match disposal
- `npm run qa:manual-signaling`: passed with manual host offer length `2432`, guest answer length `1180`, host/guest phases `connected`, rosters at `2`, and one remote operator on each page
- `npm run qa:signaling-worker`: passed with Worker health/route guards, 14-player cap, targeted offer/answer/ICE relay, role rejection, size/rate/ICE budget closures, and default STUN `/turn-credentials`
- `npm run qa:cloud-signaling`: passed with host/guest phases `connected`, rosters at `2`, remotes at `1`, guest input cadence, delta host snapshots, client-side oversized offer rejection, malformed signaling rejection, and malformed room-message disconnect
- `npm run qa:cloud-signaling-14`: passed with one host plus 13 guests connected, rosters at `14`, host remote count `13`, each guest remote count `13`, and host snapshots staying `delta`
- `npm run qa:host-room`: passed after the harness waited for delayed-snapshot convergence; it verified guest input receipt, host deadman clearing, latest-state duplicate/drop tolerance, guest prediction and reconciliation, jump reconciliation, held latest-state release, host snapshots, and host-exit recovery
- `npm run qa:shot-validation`: passed with blocked-cover rejection, clear-shot acceptance, fire-rate rejection, ammo-state rejection, reload-state rejection, host-owned health, and authoritative guest weapon restoration
- `npm run qa:final`: passed with solo/local, shared objective, HUD, movement, AI, fallback, and screenshot-refresh evidence
- `npm test`: passed, repeating the production build and final browser QA wrapper

### Local and manual room smoke

`npm run qa:local-flow` proved the production local shell still returns cleanly to the catalog after opening a match, firing once, and forcing a death panel. This protects the solo flow while the room setup UI is present.

`npm run qa:manual-signaling` generated a manual host offer and guest answer, applied the answer, reached `connected` on both pages, entered `Sandline Foundry`, and showed rosters/remotes on both sides. This proves the fallback WebRTC path without room-code signaling.

### Shared shot validation

Two cloud-room pages were staged into deterministic clear and blocked fire lanes on `Sandline Foundry`.

Observed results:

- blocked guest shot emitted local shot feedback, `shared-sent` claim telemetry, `local-fire` audio, muzzle flash, and provisional ammo consumption before the host result
- blocked line-of-sight claim returned `decision: rejected`, `reason: blocked-by-cover`, consumed one host-side weapon shot, and left host health at `100`
- clear shot returned `decision: accepted`, `reason: hit-confirmed`, `damage: 34`, and reduced host health to `66`
- rapid follow-up claim returned `reason: fire-rate` and restored guest ammo from the host weapon snapshot
- forged `ammoInClip: 99` claim returned `reason: ammo-state` and left host health unchanged
- forged `reloadSequence: 99` claim returned `reason: reload-state` and left host health unchanged

Result: guest combat now has immediate local feel while health and authoritative weapon state remain host-owned.

### Signaling Worker guardrails

`npm run qa:signaling-worker` probed the local Worker directly.

Observed results:

- `maxPeersPerRoom: 14`
- 13 guests were accepted after the host, and an overflow guest was rejected
- targeted offer, answer, and ICE relay paths succeeded
- unsupported messages, missing targets, and bad targets were rejected
- guest-offer and host-answer role violations were rejected
- oversized messages, rate-limit abuse, and ICE-candidate budget abuse closed the socket with policy codes
- `/turn-credentials` returned the default STUN set when no TURN secrets were configured

Result: the Worker remains signaling-only and enforces the expected abuse boundaries.

### Cloud room arena sync

`npm run qa:cloud-signaling` connected one host and one guest through the local Worker and entered the arena.

Observed results:

- host and guest phases reached `connected`
- both rosters reached `2`
- both peers saw one remote operator
- guest fixed input cadence advanced
- host snapshots used delta encoding with bounded payload size
- outbound oversized/invalid signaling payloads were rejected
- malformed room messages disconnected the offending peer

Result: WebRTC cloud rooms now drive the canonical arena with host snapshots and guest input ticks.

### Host-room prediction and recovery

`npm run qa:host-room` connected a manual host and guest, then exercised the room after both entered the arena.

Observed results:

- guest fixed input cadence advanced 4 ticks in the sampled window
- host received guest diagonal movement, crouch intent, and input sequence data
- pausing guest input triggered host-side deadman clearing with drift below `0.25m`
- injected latest-state duplicate/drop faults did not disconnect the peer and later input was still processed
- delayed host snapshots allowed guest prediction to keep moving, retained unacknowledged history while delayed, and converged to `0.078m`
- guest jump prediction rose `0.35m`, stayed pending while snapshots were delayed, then reconciled to the host landing with `0` eye-height and XZ error in the passing run
- latest-state backpressure hold stopped new host snapshots, then released the newest held snapshot rather than stale intermediate state
- host movement snapshots advanced on the guest
- navigating the host away returned the guest to the room screen with `The host ended the room.`

Result: canonical movement prediction, reconciliation, stale latest-state handling, host input timeout, newest-state replacement, and host-exit recovery are covered by a durable script.

### Fourteen-player cap

`npm run qa:cloud-signaling-14` connected one host and 13 guests through the local Worker.

Observed results:

- `guestCount: 13`
- `expectedPlayerCount: 14`
- all guest phases reached `connected`
- host roster count reached `14`
- every guest roster count reached `14`
- host remote count reached `13`
- every guest remote count reached `13`
- host snapshot encoding stayed `delta`
- all 13 host-side peer transports reported `connected`

Result: the browser runtime and Worker guardrails cover the intended 14-player room limit.

### Same-browser objective sync

`npm test` ran `scripts/qa/finalVerification.mjs` against a fresh production build.

Observed results:

- shared bomb state reached `planted` on both pages
- the defending peer could defuse at the planted site
- bomb disarm resolution matched on both pages
- shared round two rotated into hostage mode through host-authored round state
- hostage rescuer ownership matched on both pages
- hostage route progress reached `[2, 2]`
- both hostages extracted
- hostage extraction resolution matched on both pages

Result: same-browser shared rooms now prove host-authoritative bomb disarm and hostage escort/extraction synchronization across peers.

## Objective Sync Boundary

Cloud/manual room snapshots currently sync round phase, objective HUD state, and serialized round/bomb/hostage runtime state from the host snapshot. The full bomb/hostage mutation stream is not yet serialized through a separate authoritative `objective-event` path.

Use the fresh same-browser shared-room evidence above for the retained BroadcastChannel objective path. Cloud/manual room objective state currently rides host snapshots rather than a separate objective-event stream.

## Historical Results 2026-05-29

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
- page 2 received the same shot as `shared-received`, marked the remote actor with a recent shot, and logged a playable `world-fire` audio event after its audio context was armed by the user-gesture unlock pulse
- the received world-fire event carried distance, normalized gain bounded inside the accepted `0.08..0.92` range, no blocked reason, and boosted output gain for audibility
- stale remote-fire audio is dropped if the receiving browser cannot resume audio immediately, avoiding delayed shots after a later unlock

Result: shared-room combat now distinguishes body yaw from weapon pitch and gives observers audible opponent gunfire feedback for remote shots, including misses.

### Shared bomb round

The same two pages then stayed on `Sandline Foundry` for a live relay-charge exchange:

- page 1 forced the shared round into `active`, stood in the declared `Kiln Yard` site, and began the relay-charge arm action as the attacking `Amber Vanguard` operator
- page 2 saw the same attacking operator listed as the bomb carrier before the plant
- both pages advanced to `planted`
- page 2 rendered the same planted-pressure HUD line (`12.0s to breach`) and then moved onto the live site as the `Cobalt Reach` defender
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
- Shared-room sessions remain human-only across tabs. The `easy` / `medium` / `hard` solo bot selector and smarter-bot tuning do not apply to this mode.
- Tactical-AI verification remains centered on solo-local rounds rather than shared-room bot opponents.
