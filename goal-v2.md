Upgrade the existing CSMini browser tactical FPS prototype into a stronger original 1.5-era tactical FPS homage with round-based team play, mission objectives, better movement, and
  believable AI.

  Important IP constraint:
  Do not copy Counter-Strike assets, maps, names, sounds, textures, models, layouts, UI, logos, or exact data. Implement original mechanics and content that evoke the feel of classic
  early-2000s tactical FPS play through original code, original maps, original presentation, and original lightweight assets.

  Primary gameplay requirements:

  1. Movement controls
  - Control key crouches/ducks.
  - Space bar jumps.
  - Crouch must lower camera height, reduce movement speed, and affect weapon handling/readability.
  - Jump must have grounded/airborne state, gravity, landing, and collision-safe behavior.
  - Existing WASD, mouse look, fire, reload, pointer lock, return-to-roster flow must keep working.

  2. Teams and rounds
  - Add two opposing teams inspired by classic tactical attacker/defender structure, but with original names, styling, and character presentation.
  - Each team spawns in a distinct area of every playable map.
  - HUD must clearly show current team, round timer, round state, team counts, alive/dead status, and mission state.
  - Implement round start, active round, win/loss, round reset, and return-to-map flow.
  - Dead players should respawn at the next round, not instantly, unless local QA/debug hooks explicitly force state.

  3. Mission types
  - Add two mission types:
    - Bomb planting/defusal.
    - Hostage rescue/extraction.
  - Each map entry must declare which mission type it supports, objective sites/zones, team spawn zones, and relevant tactical routes.
  - Bomb mode must include carrying/planting, planted timer, defuse interaction, explosion/defuse win conditions, and HUD feedback.
  - Hostage mode must include hostages, rescue/extraction zone, interaction/rescue state, escort/follow behavior, and rescue/timeout/elimination win conditions.
  - Do not use CS names like Terrorists/Counter-Terrorists, de_/cs_ prefixes, or copied site names. Use original names.

  4. AI behavior
  - AI enemies must move around the map instead of standing still.
  - AI must patrol, seek cover, react to sound/contact, pursue known positions, and respect mission objectives.
  - AI line of sight must be blocked by walls, cover, and major obstacles. They must not see through geometry.
  - AI shooting must include accuracy spread and a configurable chance to miss, affected by range, movement, crouch/standing state, and visibility.
  - AI should not instantly lock onto the player through walls or fire with perfect precision.
  - Local solo mode must remain playable and lightweight.

  5. Classic tactical FPS feel target
  - Tune movement, crouch, jump, weapon timing, AI reaction, round pacing, objective timing, and HUD feedback to feel like a classic 1.5-era tactical FPS homage.
  - This means deliberate movement, readable recoil/spread, tactical cover, short round loop, clear objective pressure, and simple but tense AI combat.
  - Do not claim exact equivalence unless verified through gameplay checks. Prefer “classic tactical FPS feel” over copied implementation.

  Technical requirements:
  - Preserve browser-only Vite/TypeScript/Three.js architecture.
  - Keep rendering, input, gameplay rules, AI, map data, objectives, UI, and multiplayer logic reasonably separated.
  - Avoid growing `src/game/localMatch.ts` into an unmaintainable monolith; refactor or introduce focused modules where it meaningfully reduces complexity.
  - Keep dependencies minimal. Do not add heavy game engines.
  - Existing Render static deployment must remain compatible: `npm install && npm run build`, publish `dist`.
  - Existing QA harness should be extended instead of discarded.

  Validation requirements:
  - `npm run typecheck` passes.
  - `npm run build` passes.
  - `npm test` passes or is updated to cover the new accepted behavior and then passes.
  - Add or update browser QA to verify:
    - Control crouch changes player state/camera/movement.
    - Space jump works and lands safely.
    - Two teams exist and spawn in distinct areas.
    - Round timer counts down and round reset works.
    - Bomb plant and defuse win conditions work.
    - Hostage rescue/extraction win condition works.
    - AI moves between patrol/combat/objective states.
    - AI cannot detect/shoot through walls in a controlled line-of-sight test.
    - AI misses some shots under defined conditions.
  - Update README and docs/qa with controls, mission rules, AI behavior, validation commands, and limitations.
  - Capture updated screenshots if HUD/objective presentation changes materially.

  Done criteria:
  - The deployed app remains a polished browser game, not just code paths.
  - A player can start a map, pick or be assigned a team, play a timed round, crouch, jump, fight moving AI, and complete or lose bomb/hostage objectives.
  - The final report explicitly lists what was implemented, what was verified, and any remaining limitations.

