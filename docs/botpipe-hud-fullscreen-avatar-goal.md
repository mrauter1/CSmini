# Botpipe Goal: HUD, Fullscreen, Weapon, And Avatar Presentation Pass

Implement a CS 1.5-inspired in-match HUD, fullscreen, and character presentation pass for this repo.

Read `AGENTS.md`, `README.md`, `docs/visual-target.md`, `docs/assets.md`, relevant `docs/qa/*.md`, and inspect the current code before editing. This is Dustline Protocol: a browser-only Three.js tactical FPS heavily inspired by CS 1.5 feel, but all assets/UI/names must remain original.

Goal:
Remove the oversized in-game overlay/card HUD treatment, make always-visible stats match CS 1.5-style position/proportions, move extra match info behind a Tab-held info panel, add a YouTube-style viewport fullscreen option, fix first-person weapon orientation so the gun faces forward, and fix other-player/enemy avatars so alive actors stay upright above ground while walking/aiming.

Required behavior:

1. No big overlay during gameplay
- The match viewport must not show a large centered `hud-overlay` prompt/card during normal play.
- Startup/control hints must be compact and non-blocking, such as a small lower-center or lower-left hint that disappears once controls are armed.
- Death/down state must not be a large centered card. Use a compact classic-game-style message/status line that does not obscure the whole view.
- Do not turn the game view into a dashboard. Preserve gameplay visibility.

2. Always-visible HUD should mimic CS 1.5 layout and proportions
- Always-visible HUD should be compact and game-like:
  - crosshair centered
  - health at bottom-left
  - ammo at bottom-right
  - round timer/phase/objective summary compact near top-center or top edge
  - optional tiny status/feed line near bottom or top, but not a big card
- Remove or hide from always-visible play: map card, large round card, team count card, roster card, large status card.
- Keep styling original. Do not copy Counter-Strike assets, exact UI, icons, names, fonts, or layouts. The target is proportional/positional feel, not literal cloning.
- Update `src/ui/templates.ts`, `src/ui/app.ts`, and `src/styles.css` as needed.

3. Additional info appears only while Tab is held
- Team counts, roster, map/mode, detailed mission text, objective progress/status, controls, and other nonessential info should be shown in a compact scoreboard/info panel only while `Tab` is pressed.
- `Tab` should behave like a hold-to-show scoreboard: keydown shows it, keyup hides it.
- While gameplay input is armed/captured, prevent the browser's default Tab focus navigation.
- Keep this browser-safe and consistent with the existing input capture rules in `src/game/localMatch.ts`.
- Add/extend snapshot state if needed, for example `scoreboardVisible`.
- Update QA hooks/tests to verify the panel is hidden by default and visible while Tab is held.

4. Add YouTube-style viewport fullscreen
- Add a small fullscreen icon button inside the match viewport, similar in behavior to a video player fullscreen control.
- Fullscreen target should be the match viewport/canvas shell, not the entire app page.
- Do not bind fullscreen to `F`; it is too close to `WASD` and can cause accidental toggles during movement.
- Use a safer key, preferably `Enter` with `Alt` or no keyboard shortcut at all. If adding a shortcut, document it and avoid keys near movement/combat controls.
- Fullscreen must be user-gesture driven and browser-safe.
- Listen for `fullscreenchange` and resize the Three.js renderer/camera correctly.
- Fullscreen mode should preserve the compact HUD, crosshair, Tab scoreboard, and input behavior.
- If pointer lock is already active, fullscreen should not break movement/aim. If fullscreen is denied/unavailable, fail gracefully without crashing.
- `Esc` should keep native browser behavior: release pointer lock and/or exit fullscreen as the browser allows.
- Update CSS for fullscreen so the viewport fills the screen without page padding, decorative frame, or clipped canvas.

5. First-person weapon must face forward
- Inspect `src/game/avatar.ts`, especially `createWeaponRig()`.
- The current weapon appears incorrectly positioned/oriented. Fix the viewmodel so it is anchored low-right in camera space and points forward toward the crosshair/world.
- In Three.js camera-local space, forward is negative Z. Ensure the barrel/muzzle visually points down the camera's forward direction, not sideways.
- Preserve a simple original low-poly carbine/SMG silhouette. Do not introduce external assets.
- Keep recoil/bob/muzzle flash working and restrained.

6. Other players/enemies must stay upright and above ground
- Alive combatants must remain upright while walking, aiming, patrolling, engaging, repositioning, and syncing remote player movement.
- They must not pitch/tilt downward/upward because of `group.lookAt(...)`.
- They must not sink partially below ground.
- Likely fix: replace full-group `lookAt` usage for combatant avatars with yaw-only facing helpers. Compute horizontal direction in X/Z and set only `rotation.y`; keep `rotation.x = 0` and alive `rotation.z` limited to intended subtle animation only.
- Check all combatant-facing paths in `src/game/localMatch.ts`, including:
  - remote actors
  - enemies
  - debug staging/aim helpers if they rotate avatars
- Keep dead-player collapse behavior if intentional, but alive actors must be vertical.
- Ensure avatar root/group positions are feet-on-ground compatible with the mesh dimensions in `createCombatantAvatar()`.

Implementation constraints:
- Keep changes scoped.
- Prefer existing modules and patterns.
- Do not add runtime dependencies.
- Do not add sprint or unrelated gameplay changes.
- Keep current controls: WASD move, Shift crouch, optional Ctrl crouch alias, Space jump, E interact, left click fire, R reload, M map select, Esc release controls.
- Do not use `F` for fullscreen.
- Update docs only where behavior/user-visible UI changes require it.
- Update `scripts/qa/finalVerification.mjs` if screenshots or accepted HUD behavior change.
- Refresh screenshot artifacts through the QA harness if the visual presentation changes materially.
- Do not deploy unless explicitly asked.

Validation:
- Run `npm run build`.
- Run `npm test` because this changes HUD, screenshots, fullscreen behavior, weapon presentation, and player visuals.
- If QA screenshots change, ensure the new screenshots show:
  - no large gameplay overlay by default
  - compact CS 1.5-style always-visible HUD
  - Tab-held detailed info panel
  - viewport fullscreen control present and nonintrusive
  - first-person weapon facing forward
  - opposing players upright and fully above ground
- Search for stale UI assumptions, especially old large HUD card expectations.
- Report changed files, validation commands, and any remaining risks.
