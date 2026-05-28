# Multiplayer QA

## Scope

This note captures the current verification evidence for `multiplayer-rooms-and-shared-combat`.

- Same-map shared-room presence
- Different-map room isolation
- Cross-tab shooting, damage, death, and respawn
- Join / leave / disconnect cleanup
- Shared-room fallback when `BroadcastChannel` is unavailable

## Commands

```bash
npm run typecheck
npm run build
npm run preview -- --host 127.0.0.1 --strictPort --port 4173
google-chrome --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --enable-webgl --ignore-gpu-blocklist --remote-debugging-port=9222 --user-data-dir=/tmp/dustline-chrome7 about:blank
```

Targeted browser verification then ran against `http://127.0.0.1:4173/?qa=1` using a small Chrome DevTools Protocol harness that:

- opened three pages in one browser profile
- joined `Sandline Foundry` in page 1 and page 2 with `Join Room`
- joined `Transit Crates` in page 3 to confirm map-based room isolation
- moved page 1 and page 2 into a clear shared line of sight on `Sandline Foundry`
- fired three page-1 shots into page 2
- waited through page-2 death and respawn
- closed page 2 to confirm remote cleanup
- separately forced `BroadcastChannel` missing on a fresh page and requested `Join Room` to confirm a clean `Solo Drill` fallback

Note: headless Chrome throttles background tabs, so the harness explicitly brought the active verification tab to the foreground before pose, death, respawn, and disconnect observations. This is a harness constraint, not a user-facing gameplay requirement.

## Fresh Results

### Same-map presence and isolation

- Page 1 roster on `Sandline Foundry`: local `Cinder-45` plus remote `Nova-37`
- Page 2 roster on `Sandline Foundry`: local `Nova-37` plus remote `Cinder-45`
- Page 3 roster on `Transit Crates`: only local `Rivet-36`
- Result: same-map tabs shared presence; different-map tab stayed isolated

### Shared combat

- Page 1 moved to `(-2, 14)` and page 2 moved to `(6, 14)` on `Sandline Foundry`
- Page 1 fired three shots after aiming at the replicated page-2 operator
- Page 2 local roster changed to:
  - `Nova-37`, `0 HP`, `respawning`, `1 death`
- Page 1 roster changed to:
  - `Cinder-45`, `1 elimination`
  - remote `Nova-37`, `0 HP`, `respawning`
- Result: damage, death, and score propagation held across the room

### Respawn

- After the respawn timer elapsed, page 2 local roster returned to:
  - `Nova-37`, `100 HP`, `alive`
- Page 1 remote roster returned to:
  - remote `Nova-37`, `100 HP`, `alive`
- Result: respawn propagated cleanly across clients

### Leave / disconnect

- Closing page 2 removed the remote operator from page 1
- Page 1 roster returned to only the local `Cinder-45`
- Result: leave / disconnect cleanup worked without crashes or stale room entries

### Missing multiplayer support fallback

- A fresh page was loaded with `BroadcastChannel` disabled before document scripts ran
- Requesting `Join Room` on `Sandline Foundry` produced:
  - `activeMode: local`
  - `remotePlayers: 0`
  - HUD note: `Shared room requested, but BroadcastChannel is unavailable in this browser, so shared-room sync cannot start. Solo drill armed instead.`
- Result: missing shared-room support fell back to the local drill without crashing

### Runtime errors

- Captured JavaScript exceptions: none
- Captured Chrome log-level errors from the app pages: none

## Current Evidence Summary

- Shared-room presence works for two tabs on the same map
- Map id cleanly isolates rooms
- Shooting, death, and respawn propagate across clients
- Disconnect cleanup removes stale remote operators
- Missing shared-room support falls back to a working solo drill with an explicit HUD message
