# Local Play QA

Date: 2026-05-28

## Scope

Targeted verification for the preserved local solo flow on the multiplayer branch:

- menu -> roster navigation
- local arena startup
- control engagement without pointer-lock-only assumptions
- firing and ammo change
- death overlay
- return path back to the roster

## Commands

```bash
npm run typecheck
npm run build
npm run qa:local-flow
```

## Automated Evidence

`scripts/qa/localFlowVerification.mjs` runs against `vite preview` on `http://127.0.0.1:4173/?qa=1` with a headless Chrome session and the app's QA hooks enabled.

Observed results from the current branch:

- Menu loaded successfully.
- The roster rendered `5` map cards.
- Opening `sandline-foundry` in local mode mounted the arena and exposed a live match state.
- Engaging controls hid the prompt panel without requiring real pointer lock.
- Firing once changed ammo from `24` to `23`.
- Forcing a local death exposed the death overlay and countdown text.
- Returning to the catalog removed gameplay canvases and restored the roster screen.

## Notes

- Pointer lock remains the primary interaction path in normal browsers.
- The QA path intentionally uses the fallback-safe control engagement route so automation can validate solo play reliably.
- Multiplayer verification is recorded separately in `docs/qa/multiplayer.md`.
