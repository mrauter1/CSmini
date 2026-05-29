# Classic Feel Tuning QA

Date: 2026-05-28

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

- Enemy speed: `2.35u/s`
- Enemy fire interval: `0.92s`
- Engage distance: `20u`
- Investigation window: `3.8s`
- Pursuit window: `4.8s`
- Reposition window: `2.2s`
- Close standing reaction sample: `0.269s`, hit chance `0.722`
- Far moving reaction sample: `0.462s`, hit chance `0.262`
- Crouched partial sample: hit chance `0.449`

Rationale: the solo fireteam has time to react, miss, reposition, and pressure cover without snapping instantly into perfect hits. That keeps the round readable and tense instead of purely mechanical.

## Classic-Feel Checklist

Test surfaces used for the checklist:

- Solo-local `Sandline Foundry` round 1 bomb flow
- Solo-local `Sandline Foundry` round 2 hostage flow
- Solo-local AI sightline and bounded elimination flow
- Shared-room `Sandline Foundry` bomb and hostage rounds across two pages

### Checklist Results

- Movement cadence: `pass`
  Evidence: fresh same-window travel sample was `2.4` standing vs `1.18` crouched, with walk `8.6u/s` and crouch `4.82u/s`.
- Crouch readability: `pass`
  Evidence: camera dropped from `1.62` to `1.18` in the live sample, crouch speed stayed below standing pace, and recoil kick dropped from `0.8` standing to `0.58` crouched.
- Jump readability: `pass`
  Evidence: the live jump sample peaked at `2.59`, landed back at `1.62`, and stayed airborne for `0.767s`, which reads as a committed hop rather than floaty traversal.
- Weapon timing/readability: `pass`
  Evidence: player fire interval stayed at `0.18s`, reload at `1.05s`, clip at `24`, and the live HUD kept `24 / 120` ammo plus `Ready` status visible during the round.
- Short round pacing: `pass`
  Evidence: the round shell stays at `4.5s` briefing / `72s` live / `5.5s` reset, while bomb fuse timing stays in the `11.9-12.6s` range and hostage secure/extract stays at `1.45s` / `1.8s`.
- Objective pressure: `pass`
  Evidence: fresh HUD samples showed solo bomb `12.0s to breach`, shared bomb `12.0s to breach`, solo hostage `1.5s to clear Water Tower Gate`, and shared hostage `1.6s to clear Water Tower Gate`.
- Cover-oriented combat: `pass`
  Evidence: the AI used `Crate stack west` as a real blocker, held fire at blocked visibility `0`, then switched through `reposition` and `pursue` after contact and broken sight.
- HUD clarity: `pass`
  Evidence: the solo HUD simultaneously exposed team `Amber Vanguard`, `Round 1`, `Round Live`, `Relay Charge`, and `Kiln Yard`; the shared HUD simultaneously exposed team context, `Round 2`, `Round Live`, `Evac Escort`, and `Loading Crew to Water Tower Gate`.

## Outcome

No gameplay constant changes were required in this pass. The current values already land inside the intended feel target, and this subgoal formalizes those tuned values plus fresh pass/fail evidence so later verification can audit the homage target directly instead of relying on vague feel claims.
