# Local Play QA

Date: 2026-05-28

## Scope

Targeted verification for the `local-fps-loop-and-presentation` subgoal:

- first-person controls
- visible weapon and retro HUD
- shooting and ammo change
- local enemy damage against the player
- return path to map select
- runtime cleanliness during normal local play

## Commands

```bash
npm run typecheck
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
```

## Headless Runtime Evidence

Validated against `vite preview` on `http://127.0.0.1:4173/` using a WebGL-capable headless Chrome session with the app's fallback mouse-look path enabled under `navigator.webdriver`.

Observed results:

- Menu loaded successfully.
- Map roster rendered 5 map cards.
- Deploying `Sandline Foundry` mounted exactly 1 gameplay canvas.
- Engaging the match hid the control prompt and activated the local control path.
- Firing once via the keyboard fallback changed ammo from `24 / 120` to `23 / 120`.
- Moving into combat reduced player health from `100` to `16`, proving enemy damage, HUD health updates, and the local combat loop.
- Pressing `M` returned to the catalog, and the DOM retained `0` gameplay canvases afterward, confirming clean teardown on map exit.
- The successful run reported no page errors and no runtime exceptions.

## Notes

- Pointer lock is still the primary interaction path in normal browsers.
- The app also supports a browser-safe fallback mouse-look mode so local play remains testable when pointer lock is unavailable or blocked by automation environments.
- Multiplayer presence, shared combat, and room isolation are intentionally deferred to the next subgoal.
