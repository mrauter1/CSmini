# Asset And Originality Record

Date reviewed: `2026-05-29`

## Shipped Asset Posture

- External environment assets: none
- External character assets: none
- External weapon assets: none
- External audio assets: none
- External textures/materials: none
- Runtime dependency profile: browser-only Vite/TypeScript/Three.js stack with `three` as the only runtime dependency

The shipped build stays on original low-poly geometry, simple authored materials, abstract signage, and procedural browser audio. No heavy engine, marketplace content pack, or imported art/audio bundle was added.

## Final Originality Review

This pass reviewed the current maps, mission content, HUD labels, geometry, UI treatment, audio, and gameplay data against the project’s non-Counter-Strike constraint.

### Teams, mission names, and labels

- Team names are original: `Amber Vanguard` and `Cobalt Reach`.
- Team avatar colors are original: Amber uses a warm rust/tan field uniform with a dark domino mask, while Cobalt uses a colder blue-gray field uniform without the mask.
- Mission names are original: `Relay Charge` and `Evac Escort`.
- Objective labels and route callouts are original, including `Kiln Yard`, `Water Tower Gate`, `Loading Crew`, `Generator Hall`, `Drain Underpass`, `Archive Court Relay`, and the rest of the shipped roster landmarks.
- The project does not use `Terrorists`, `Counter-Terrorists`, `de_`, `cs_`, or copied site labels.

### Maps and objective spaces

- The shipped roster uses five original map entries declared in `src/data/maps.ts`:
  - `Sandline Foundry`
  - `Transit Crates`
  - `Breaker Vault`
  - `Quarry Slip`
  - `Ledger Annex`
- Each map declares original team spawns, tactical routes, bomb sites, or hostage spaces through typed metadata instead of relying on copied layouts or legacy naming.
- The final screenshots in `assets/screenshots/` and the live QA notes in `docs/qa/local-play.md` and `docs/qa/multiplayer.md` confirm those objective spaces in the running build rather than only in static data.

### HUD, UI, audio, and weapon presentation

- The menu, roster, HUD, and prompt treatment are original browser-authored UI surfaces implemented in `src/ui/templates.ts`, `src/ui/app.ts`, and `src/styles.css`.
- Weapon, character, and environment geometry are built from original primitives in the current Three.js scene blueprints, including the team-specific avatar uniforms and Amber domino mask.
- Audio remains procedural browser synthesis from `src/game/audio.ts`; local fire, remote world-fire, opponent-fire distance gain, and pending-fire replay after audio unlock use generated oscillator voices with no imported gunshots, voice lines, or commercial sound effects.
- The current UI and HUD do not copy Counter-Strike branding, logos, fonts, icons, radar art, or panel layouts.

### Gameplay data and tuning

- Round timing, movement values, bomb timers, hostage timers, and AI behavior tuning are project-authored gameplay data documented in `docs/qa/classic-feel.md`.
- The classic-feel target is an original early-2000s tactical FPS homage, not a claim of exact Counter-Strike equivalence.

## Hard Rules

- Do not use Counter-Strike assets, extracted files, textures, sounds, models, UI art, names, or map geometry.
- Do not use ripped assets from any commercial game.
- Do not use assets whose original source, author, or license cannot be verified.
- Do not use CC BY-NC, CC BY-ND, editorial-only, or unclear custom-license assets.
- Do not import an external asset just because it exists; the default answer remains original lightweight content.

## Evidence Surfaces

- `src/data/maps.ts`
- `src/game/audio.ts`
- `src/ui/templates.ts`
- `src/ui/app.ts`
- `src/styles.css`
- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- `docs/qa/classic-feel.md`
- `docs/qa/visual-report.md`
- `assets/screenshots/`

## External Asset Gate

If a later pass proposes an external asset, it is blocked until this file is updated with a record covering all of the following:

- asset name
- source page
- author or publisher
- exact license
- commercial-use compatibility
- derivative-use allowance
- redistribution or project-embedding compatibility
- attribution requirements
- lightweight browser suitability
- fit with the visual target
- acceptance or rejection reasoning
- date checked

An external asset is acceptable only if all of these are true:

- the source is original and verifiable
- the license is clearly permissive for this project
- attribution, if required, is practical and documented
- the asset is lightweight enough for a browser FPS prototype
- the asset strengthens the original dusty tactical target instead of modernizing it away from the intended feel
- the same result cannot be reached more cleanly with simple original geometry or procedural audio

## Current Manifest

No external runtime assets are approved in the shipped build.

| Asset | Source | Author | License | Commercial Use | Derivatives | Redistribution/Embedding | Attribution | Browser Suitability | Style Fit | Decision | Date Checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | rejected by default until evaluated | 2026-05-29 |
