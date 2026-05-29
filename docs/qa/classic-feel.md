# Classic Feel Tuning QA

Date: 2026-05-29

## Intent

This pass locks in the current gameplay values as an original early-2000s tactical FPS homage, not an exact Counter-Strike recreation. The target is deliberate lane commitment, readable crouch and jump states, short round pressure, simple but believable AI, and a HUD that keeps team and mission context visible without burying the firefight.

Evidence base for this note:

- fresh `npm test` on the current tree
- `scripts/qa/finalVerification.mjs` `classicFeel` summary
- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- live values surfaced through `window.__dustlineQa__.getState()`

## Tuning Note

### Movement

- Standing eye height: `1.62`
- Crouched eye height: `1.08`
- Walk speed: `8.6u/s`
- Crouch multiplier: `0.56x`
- Crouch speed: `4.82u/s`
- Air control: `0.78`
- Gravity: `13.6`
- Jump velocity: `5.25`
- Fresh jump sample: peak `2.59`, landing `1.62`, airtime `0.767s`

Rationale: the walk speed keeps rounds moving, but there is no sprint layer; the strong crouch penalty keeps corner clearing deliberate. The jump arc is readable and brief enough to avoid turning the prototype into an arena shooter.

### Weapon cadence

- Fire interval: `0.18s`
- Reload duration: `1.05s`
- Clip size: `24`
- Reserve ammo: `120`
- Standing recoil kick: `0.8`
- Crouched recoil kick: `0.58`
- Airborne recoil penalty: `0.12`
- Player damage: `34`

Rationale: the rifle cadence supports short controlled bursts instead of permanent full-speed spray, and crouch meaningfully steadies the weapon without removing the need to commit to cover.

### Round and objective timing

- Briefing phase: `4.5s`
- Active round: `72s`
- Resolution phase: `5.5s`
- Bomb plant window across shipped maps: `3.4-3.5s`
- Bomb defuse window across shipped maps: `4.1-4.4s`
- Bomb fuse window across shipped maps: `11.9-12.6s`
- Hostage secure window: `1.45s`
- Hostage extract window: `1.8s`

Rationale: the round shell stays short enough to keep pressure on the objective, while the bomb and extraction timers create a distinct late-round scramble instead of a slow attrition loop.

### AI pressure

- Bot locomotion contract: same as player walk/crouch/jump/gravity rules
- Standing bot stride sample: `8.6u/s`
- Crouched bot stride sample: `4.816u/s`
- Bot jump sample: feet peak `0.97`, eye peak `2.59`, landed eye `1.62`, airtime `0.767s`
- Enemy fire interval: `0.92s`
- Engage distance: `20u`
- Medium investigation window: `3.8s`
- Medium pursuit window: `4.8s`
- Medium post-contact reposition window: `1.2s`
- Medium squad-contact delay: `0.62s`
- Medium burst size / cooldown: `2-3 shots` / `0.76s`
- Medium behavior hold: `0.72s`
- Medium stuck-recovery window: `0.78s`
- Close standing reaction sample: `0.269s`, hit chance `0.722`
- Far moving reaction sample: `0.462s`, hit chance `0.262`
- Crouched partial sample: hit chance `0.449`
- Difficulty comparison sample at the same pose:
  - `easy`: `0.487s` reaction, `7.124` spread, `0.407` hit chance
  - `medium`: `0.377s` reaction, `6.037` spread, `0.537` hit chance
  - `hard`: `0.317s` reaction, `5.434` spread, `0.617` hit chance

Rationale: the solo fireteam now closes space, crouches, hops, and lands through the same grounded movement rules as the player, so the threat comes from angle choice, timing, delayed communication, burst discipline, and readable pressure rather than hidden bot-only locomotion. They still have time to react, miss, recover, reposition, and pressure objectives without snapping instantly into perfect hits.

## Classic-Feel Checklist

Test surfaces used for the checklist:

- Solo-local `Sandline Foundry` round 1 bomb flow
- Solo-local `Sandline Foundry` round 2 hostage flow
- Solo-local AI sightline and bounded elimination flow
- Shared-room `Sandline Foundry` bomb and hostage rounds across two pages

### Checklist Results

- Movement cadence: `pass`
  Evidence: fresh same-window travel sample was `1.72` standing vs `0.98` crouched, with walk `8.6u/s` and crouch `4.82u/s`.
- Crouch readability: `pass`
  Evidence: camera dropped from `1.62` to `1.18` in the live sample, crouch speed stayed below standing pace, and recoil kick dropped from `0.8` standing to `0.58` crouched.
- Jump readability: `pass`
  Evidence: the live jump sample peaked at `2.59`, landed back at `1.62`, and stayed airborne for `0.767s`, which reads as a committed hop rather than floaty traversal.
- Weapon timing/readability: `pass`
  Evidence: player fire interval stayed at `0.18s`, reload at `1.05s`, clip at `24`, and the live HUD kept `24 / 120` ammo plus `Ready` status visible during the round.
- Short round pacing: `pass`
  Evidence: the round shell stays at `4.5s` briefing / `72s` live / `5.5s` reset, while bomb fuse timing stays in the `11.9-12.6s` range and hostage secure/extract stays at `1.45s` / `1.8s`.
- Objective pressure: `pass`
  Evidence: fresh HUD samples showed solo bomb `11.8s to breach`, shared bomb `12.0s to breach`, solo hostage `1.3s to clear Water Tower Gate`, and shared hostage `1.6s to clear Water Tower Gate`.
- Cover-oriented combat: `pass`
  Evidence: the AI used `Crate stack west` as a real blocker, held fire at blocked visibility `0`, then switched through `reposition` and `pursue` after contact and broken sight.
- Squad coordination: `pass`
  Evidence: a staged receiver stayed on `patrol` before a delayed shared contact, then switched into `pursue` after the lag elapsed instead of gaining instant wall knowledge.
- Objective resolution: `pass`
  Evidence: a staged enemy carrier planted at `Kiln Yard` and the same solo-local round resolved by breach without a forced round advance.
- HUD clarity: `pass`
  Evidence: the solo HUD simultaneously exposed team `Amber Vanguard`, `Round 1`, `Round Live`, `Relay Charge`, and `Kiln Yard`; the shared HUD simultaneously exposed team context, `Round 2`, `Round Live`, `Evac Escort`, and `Loading Crew to Water Tower Gate`.

## Outcome

No player movement constant changes were required in this pass. The current values already land inside the intended feel target, and the solo fireteam now uses those same locomotion values instead of a separate slow-bot path. This note locks in that shared contract plus fresh pass/fail evidence so later verification can audit the homage target directly instead of relying on vague feel claims.
