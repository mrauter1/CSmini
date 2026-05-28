# AGENTS.md

## Project Identity

This repo is Dustline Protocol: a browser-only Vite/TypeScript/Three.js tactical FPS prototype that is intentionally and heavily inspired by Counter-Strike 1.5-era play.

The goal is to mimic the play style, pacing, mechanics, and feel of CS 1.5 as closely as this browser prototype can, while remaining fully original in assets, names, maps, UI, sounds, and implementation. Treat CS 1.5 as the mechanical and experiential north star: deliberate movement, readable recoil, crouch/jump commitment, short round tension, attacker/defender structure, objective pressure, sharp map readability, lethal but simple combat, and practical low-poly presentation.

Do not turn this into a generic Three.js demo, SaaS-like web app, modern military shooter, sci-fi arena, voxel/cartoon game, casual arcade shooter, or loosely tactical web toy. When in doubt, ask: "Would this make the game feel more like a faithful original CS 1.5-era browser homage?"

## Source Of Truth

Before significant changes, read:

- `README.md`
- `docs/visual-target.md`
- `docs/assets.md`
- relevant `docs/qa/*.md`
- `scripts/qa/finalVerification.mjs` for accepted runtime behavior

`goal.md` and `goal-v2.md` are historical direction docs. Prefer current `README.md`, current code, and passing QA behavior when they conflict. In particular, current crouch default is `Shift`; Ctrl is only an optional classic alias.

## CS 1.5 Feel Contract

Preserve and strengthen the classic CS 1.5-inspired feel wherever possible:

- Movement should feel deliberate, grounded, and tactical, not floaty, parkour-like, hero-shooter-like, or arena-shooter-like.
- Strafing, crouching, and jumping should require commitment and have readable tradeoffs.
- Do not add sprint as a separate movement layer; CS 1.5-style movement should stay based on walk/run speed, crouch, jump, positioning, and weapon discipline.
- Crouch should lower the camera, slow movement, and improve weapon handling/readability.
- Jump should be useful but not dominant; avoid bunnyhop-centric, air-control-heavy, or vertical-mobility gameplay.
- Weapon behavior should reward short controlled bursts, position, and timing rather than constant full-speed spraying.
- Combat should be lethal enough to create tension, but readable enough that deaths feel explainable.
- Rounds should stay short, pressured, and objective-driven.
- Maps should have clear lanes, choke points, cover, flank routes, landmarks, and distinct spawn identity.
- HUD and UI should be functional and tactical, not decorative or modern-dashboard-like.
- AI should approximate classic tactical pressure: patrol, hold, investigate, engage, reposition, pursue, miss sometimes, and respect cover/line-of-sight.

This is not a clone. It is an original homage whose design decisions should intentionally pursue the CS 1.5 play feel.

## Hard Product Rules

- Browser-only. Keep Render static deployment compatible with `npm install && npm run build`, publish `dist`.
- Runtime dependency discipline: `three` is the only runtime dependency unless there is a strong reason.
- No heavy game engines, native runtimes, server requirements, or matchmaking backends.
- Shared Room is intentionally same-browser/same-machine `BroadcastChannel`, not real network multiplayer.
- Keep controls browser-safe:
  - `WASD`: move
  - `Shift`: crouch
  - optional Ctrl crouch alias only via match controls
  - `Space`: jump
  - `E`: objective interaction
  - left click: fire
  - `R`: reload
  - `M`: map select
  - `Esc`: release controls
- Gameplay input must remain gated behind pointer lock or explicit armed viewport focus, with default browser behavior suppressed only while armed.

## Originality And IP Boundary

The project may be mechanically and aesthetically inspired by CS 1.5, but it must not copy Counter-Strike content.

Never use Counter-Strike assets, names, logos, sounds, textures, models, map files, UI, exact layouts, `de_`/`cs_` naming, site names, faction names, weapon models, radar art, or team names like Terrorists/Counter-Terrorists.

Acceptable: original systems and content that evoke the same era and feel.

Blocked: copied or near-copied Counter-Strike content, extracted commercial-game assets, or anything that turns the homage into infringement.

## Asset Rules

Default asset strategy is original primitive geometry and procedural browser audio. External assets are blocked unless `docs/assets.md` is updated with source, author, exact license, commercial/derivative/redistribution permissions, attribution, browser suitability, style fit, and acceptance reasoning.

Reject unclear, ripped, NonCommercial, NoDerivatives, editorial-only, high-poly, photorealistic, sci-fi, modern military, cartoon, or style-breaking assets.

## Visual Direction

Preserve the visual target:

- muted beige, tan, dust brown, concrete gray, charcoal
- olive, rust, faded blue, dark green, worn yellow accents
- low-poly, angular, old-PC/mod-like roughness
- dusty industrial/desert compounds
- readable lanes, spawn courts, central yards, corridors, flanks, catwalks, crates, shutters, water towers, low barriers
- compact dark tactical HUD/menu panels with restrained accents

The look should feel like an original browser-native CS 1.5-era mod: rough, functional, readable, low-poly, and tactical.

Avoid glossy PBR, heavy bloom, cinematic post-processing, oversized marketing hero pages, decorative UI, modern esports broadcast styling, and modern dashboard styling.

## Architecture Boundaries

Use existing ownership boundaries:

- `src/data/`: map metadata, mission declarations, previews, scene blueprints
- `src/game/`: movement, controls, rounds, objectives, AI, collision, audio, teams, shared-room sync
- `src/ui/`: menu, roster, HUD, browser-shell interactions
- `src/world/`: Three.js scene lifecycle and primitive construction
- `scripts/qa/finalVerification.mjs`: browser QA harness

`src/game/localMatch.ts` is already large. Do not grow it casually. For new gameplay systems, prefer focused modules like the existing `controls.ts`, `playerMovement.ts`, `bombState.ts`, `hostageState.ts`, `rounds.ts`, and `tacticalAi.ts`.

## Gameplay Invariants

Preserve or explicitly re-verify:

- crouch lowers camera, slows movement, affects recoil/readability
- jump has grounded/airborne state, gravity, landing, collision-safe behavior
- dead players stay down until next round unless QA hooks force otherwise
- two original teams spawn in distinct zones on every map
- round phases: briefing, active, resolution/reset
- bomb mode: carrier, valid-site plant, planted countdown, defuse/explosion resolution
- hostage mode: secure, escort, route progress, extraction/timeout/elimination resolution
- solo AI must patrol, hold objectives, investigate, engage, reposition, pursue, respect line-of-sight blockers, and miss under defined conditions
- missing `BroadcastChannel` must fall back to local play without crashing

## Map And Mission Changes

When adding or changing maps, update typed metadata consistently:

- team spawns
- tactical routes
- focus points
- mission support
- bomb sites and/or hostage clusters
- preview SVG data
- original labels and landmarks

Every shipped map should remain playable in the browser QA harness. Map edits should improve classic tactical readability: clear routes, cover, chokepoints, crossfire risk, flank value, and memorable landmarks.

## UI And Controls

HUD and prompts must match actual controls. Do not hard-code stale control text in one place while changing input elsewhere. Prefer shared constants from `src/game/controls.ts`.

Keep match UI dense, functional, and game-like. No landing-page treatment inside the game.

## Verification Expectations

For any gameplay, input, UI, mission, AI, map, or visual change:

- run `npm run build`
- run `npm test` when behavior or screenshots may change
- update `scripts/qa/finalVerification.mjs` instead of bypassing it when accepted behavior changes
- update README/docs when controls, modes, limitations, or verification evidence changes
- refresh screenshots through the QA harness when HUD/objective/visual presentation changes materially

Known non-blocking issue: Vite may warn about the `localMatch` chunk size. Do not treat that warning alone as failure.

## Deployment

Do not deploy unless explicitly asked. Render target is `https://csmini.onrender.com/`, static site from GitHub `main`, build command `npm install && npm run build`, publish directory `dist`.

## Working Style

Make scoped changes. Preserve user changes. Do not reset or revert unrelated work. Prefer extending existing systems and tests over inventing parallel paths.
