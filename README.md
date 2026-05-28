# Dustline Protocol

Browser-only tactical FPS prototype built as an original early-2000s-inspired skirmish. The project ships a menu-to-match loop, a five-map roster, same-map shared-room multiplayer in two tabs, and a local solo-drill fallback with shooting, damage, death, respawn, and return-to-roster flow.

## What Was Built

- A browser-native briefing screen and map-select roster for five original tactical arenas
- `Sandline Foundry` as the main playable dusty industrial map with:
  - two distinct spawn courts
  - a central contested yard
  - a tighter west-side generator route
  - an east underpass flank that reconnects through a catwalk
  - named landmarks including Water Tower Court, Broken Arch, Crate Island, Blue Shutter Bay, and East Catwalk
- Same-map shared-room multiplayer using the browser `BroadcastChannel` API
- Solo-drill fallback with three lightweight hostile operators when shared-room sync is unavailable or when the user explicitly chooses local play
- First-person controls, collision, shooting, HUD, roster, hit feedback, death, respawn, and procedural audio

## Run Locally

```bash
npm install
npm run dev
```

Open the local Vite URL in a modern desktop browser.

For a production-style local run:

```bash
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
```

## Test Two-Tab Multiplayer

Manual same-browser check:

1. Open the same local URL in two tabs or windows.
2. In both clients, choose `Join Room` on `Sandline Foundry` or any other matching map card.
3. Move, aim, and fire in one tab and confirm the other tab reflects the roster, position, facing, damage, death, and respawn state.

Fallback check:

1. Use a browser context that does not expose `BroadcastChannel`, or remove it through automation.
2. Choose `Join Room`.
3. Confirm the app stays playable in `Solo Drill` mode and shows a clear HUD fallback notice instead of crashing.

Automated browser verification:

```bash
npm test
```

This rebuilds the app and runs the final browser QA harness. To refresh the screenshot set without rebuilding first:

```bash
npm run qa:final
```

## Maps And Visual Reference Process

Map data lives in `src/data/maps.ts`. Each map entry carries:

- name
- short description
- visual theme
- spawn setup
- cover summary
- choke-point summary
- landmark callout
- tactical summary
- SVG preview

The visual target was defined before implementation with generated reference art in `assets/references/` and the durable summary in `docs/visual-target.md`.

Reference categories covered:

- menu/map-selection
- spawn view
- central courtyard
- corridor route
- flank route
- elevated catwalk
- weapon idle
- weapon firing
- opposing player
- death/respawn
- two-player combat

The final implementation screenshots live in `assets/screenshots/`, and the scored comparison plus rubric live in `docs/qa/visual-report.md`.

## Assets And Licensing

- External environment assets used: none
- External character assets used: none
- External weapon assets used: none
- External audio assets used: none
- Geometry strategy: original low-poly primitive work only
- Audio strategy: original procedural browser synthesis only

License and asset-policy record:

- `docs/assets.md`

No Counter-Strike assets, names, logos, textures, models, sounds, or map layouts are used.

## Verification

Commands run in the final pass:

```bash
npm run typecheck
npm run build
npm test
npm run qa:final
```

Results:

- `npm run typecheck`: passed
- `npm run build`: passed
- `npm test`: passed
- `npm run qa:final`: passed

Verifier-gate outcome:

- build: pass
- browser launch: pass
- map selection: pass
- map quality: pass
- core gameplay: pass
- weapon feedback: pass
- multiplayer: pass
- error handling: pass
- asset licensing: pass
- documentation: pass

Visual QA summary:

- reference-to-implementation comparison: `2.2 / 3.0`
- visual rubric: `27 / 36`
- 60-second feel test: `10 / 10`
- two-tab multiplayer feel test: `6 / 6`
- map readability test: `8 / 8`

Detailed QA artifacts:

- `docs/qa/local-play.md`
- `docs/qa/multiplayer.md`
- `docs/qa/visual-report.md`

## Controls

- `WASD`: move
- `Shift`: sprint
- Mouse: look
- Left click or `Space`: fire
- `R`: reload
- `M`: return to map select
- `Esc`: release pointer lock

## Project Layout

- `src/data/maps.ts`: map roster metadata, previews, and scene blueprints
- `src/game/`: match runtime, collision, audio, avatars, and shared-room sync
- `src/ui/`: briefing, catalog, match HUD, and preview rendering
- `src/world/`: Three.js scene lifecycle and primitive construction
- `assets/references/`: generated visual target set
- `assets/screenshots/`: captured browser verification views
- `docs/qa/`: local, multiplayer, and final visual QA notes

## Known Limitations

- Shared-room multiplayer is intentionally same-browser and same-machine oriented through `BroadcastChannel`; it is not an internet matchmaking system.
- The live implementation is deliberately flatter and more abstract than the richer painted reference set, especially in walls and ground materials.
- `src/game/localMatch.ts` remains the largest file in the repo and is the first refactor target if the prototype grows further.
- `vite build` currently emits a non-blocking chunk-size warning for the `localMatch` bundle.
