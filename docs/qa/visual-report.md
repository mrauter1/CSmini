# Visual QA Report

Date: 2026-05-28

## Scope

Final verification for the `verification-docs-and-final-reporting` subgoal covered:

- browser launch and map selection
- main-map visual match against the generated reference set
- first-person weapon and HUD presentation
- death and respawn feedback
- same-map two-tab multiplayer presence, damage, death, respawn, and fallback behavior
- asset-license posture and documentation completeness

## Reference Inputs

Generated reference set reviewed from `assets/references/`:

- `01-menu-map-select.png`
- `02-spawn-view.png`
- `03-central-courtyard.png`
- `04-corridor-route.png`
- `05-flank-route.png`
- `06-elevated-catwalk.png`
- `07-weapon-idle-hud.png`
- `08-weapon-firing-hud.png`
- `09-opposing-player.png`
- `10-death-respawn.png`
- `11-two-player-combat.png`

Visual target summary source:

- `docs/visual-target.md`

## Actual Browser Views Reviewed

Captured from the current browser build in `assets/screenshots/`:

- `01-menu-briefing.png`
- `02-map-select-roster.png`
- `03-sandline-spawn-view.png`
- `04-sandline-central-yard.png`
- `05-sandline-generator-hall.png`
- `06-sandline-drain-underpass.png`
- `07-sandline-east-catwalk.png`
- `08-weapon-idle-hud.png`
- `09-weapon-firing-hud.png`
- `10-opposing-player.png`
- `11-death-respawn-state.png`
- `12-two-player-multiplayer.png`

## Commands Run

```bash
npm run typecheck
npm run build
npm test
npm run qa:final
```

Results:

- `npm run typecheck`: passed
- `npm run build`: passed
- `npm test`: passed; rebuilt the app and completed the final browser QA harness
- `npm run qa:final`: passed again after the final screenshot framing adjustments

Non-blocking note:

- `vite build` emitted a chunk-size warning for the `localMatch` bundle at roughly 507 kB minified. This did not block runtime verification.

## Visual Target Summary

Accepted target characteristics from `docs/visual-target.md` and the reference set:

- muted beige, tan, dust-brown, concrete-gray, olive, rust, faded-blue palette
- dusty industrial compound atmosphere with old-PC roughness rather than modern glossy rendering
- low-poly angular geometry with readable crates, walls, lanes, shutters, and catwalks
- dark translucent tactical menu and HUD panels with condensed typography and restrained accent color
- boxy humanoid operators with clear facing direction and silhouette
- an original abstract low-poly first-person weapon anchored low-right with restrained recoil and muzzle flash
- simple daylight lighting with readable shadows and light haze
- explicit avoidance of Counter-Strike assets, copied layouts, photorealism, sci-fi styling, voxel/cartoon cues, and SaaS-like UI

## Reference-To-Implementation Comparison

Scoring rubric:

- `0`: wrong direction
- `1`: weak match
- `2`: acceptable match
- `3`: strong match

| Comparison | Reference | Actual | Score | Notes |
| --- | --- | --- | --- | --- |
| Menu reference vs actual menu | `01-menu-map-select.png` | `01-menu-briefing.png` | 3 | The final menu preserves the dark tactical panel treatment, restrained gold accent, and game-like information hierarchy even though it is intentionally simpler than the painted reference. |
| Map-select reference vs actual map select | `01-menu-map-select.png` | `02-map-select-roster.png` | 3 | The roster, preview-heavy layout, and five-card tactical catalog match the intended browser-map-select direction strongly, with flatter implementation rendering. |
| Spawn-view reference vs actual spawn view | `02-spawn-view.png` | `03-sandline-spawn-view.png` | 2 | The live scene clearly reads as a dusty spawn court with shutters, crates, a water-tower landmark, a crosshair, and the abstract weapon, but uses much simpler materials and geometry. |
| Central courtyard reference vs actual central area | `03-central-courtyard.png` | `04-sandline-central-yard.png` | 2 | The current map shows a readable central yard, crate cover, landmark silhouettes, and tactical space separation. It remains materially flatter than the reference. |
| Corridor reference vs actual corridor | `04-corridor-route.png` | `05-sandline-generator-hall.png` | 1 | The implementation has a valid tight route, but the captured hall is much more austere and less corridor-like than the reference target. This is the weakest comparison. |
| Flank reference vs actual flank route | `05-flank-route.png` | `06-sandline-drain-underpass.png` | 2 | The live underpass flank reads as a narrow side route with cover and route identity, even though the current lighting and material breakup are still sparse. |
| Weapon/HUD reference vs actual weapon/HUD | `07-weapon-idle-hud.png` and `08-weapon-firing-hud.png` | `08-weapon-idle-hud.png` and `09-weapon-firing-hud.png` | 2 | The abstract first-person weapon, ammo readout, health, status, and muzzle-flash feedback all land in the correct retro browser-FPS direction, with a much simpler presentation. |
| Character reference vs actual player model | `09-opposing-player.png` | `10-opposing-player.png` | 2 | The remote operator is a readable low-poly humanoid with team-accent color and a clear rifle silhouette. The implementation is much more lightweight than the painted reference. |
| Death/respawn reference vs actual death/respawn state | `10-death-respawn.png` | `11-death-respawn-state.png` | 3 | The live respawn state strongly matches the intended functional overlay, countdown, and tactical HUD interruption pattern. |
| Multiplayer reference vs actual two-tab multiplayer view | `11-two-player-combat.png` | `12-two-player-multiplayer.png` | 2 | The final browser capture visibly proves a same-map shared room with a second operator present in the scene and a two-operator roster, though the shot is calmer than the reference combat painting. |

Average score: `2.2 / 3.0`

Critical category floor check:

- Menu/HUD: pass
- Main map atmosphere: pass
- Player character readability: pass
- First-person weapon: pass
- Tactical map readability: pass
- No comparison scored `0`

## Visual Style Self-Test

1. Retro tactical FPS read in 5 seconds: yes
2. Closer to an early tactical-shooter mod than a generic web demo: yes
3. Environment feels like a compact tactical map rather than random boxes: yes
4. Recognizable lanes, cover, and landmarks: yes
5. Muted, dusty, industrial palette: yes
6. Angular low-poly shapes: yes
7. HUD and menus feel game-like rather than SaaS-like: yes
8. Characters read as humanoid combatants: yes
9. First-person weapon is visible and coherent: yes
10. The map feels original rather than copied: yes

## Visual Rubric

| Category | Score | Notes |
| --- | --- | --- |
| Retro tactical FPS identity | 2 | The prototype reads correctly as a retro browser-native tactical FPS homage. |
| Low-poly early-2000s feel | 2 | The geometry and gun model are intentionally angular and lightweight. |
| Dusty/industrial/desert compound atmosphere | 2 | The environment stays in the correct beige/olive/rust industrial space, though with flatter surfaces. |
| Map readability | 3 | Spawn courts, central yard, corridor, flank, catwalk, and cover silhouettes remain easy to parse. |
| Meaningful cover and sightlines | 2 | Crates, barriers, divider walls, and the catwalk create usable tactical decisions. |
| Recognizable landmarks | 2 | Water Tower Court, Broken Arch, Crate Island, Blue Shutter Bay, and East Catwalk all read in screenshots and play. |
| Originality of layout and assets | 3 | Geometry, maps, HUD styling, audio, and weapon shapes remain original. |
| HUD/menu style | 3 | The UI is consistently dark, tactical, and game-like across briefing, roster, and match HUD. |
| Character readability | 2 | Remote operators are understandable low-poly humanoids, albeit very simple. |
| First-person weapon presentation | 2 | The gun is visible, stable, low-right anchored, and provides coherent muzzle-flash feedback. |
| Lighting and material coherence | 2 | The lighting direction is readable and consistent, but materials remain intentionally sparse. |
| Overall browser-game polish | 2 | The app feels cohesive and lightweight, with some visual roughness still visible. |

Total rubric score: `27 / 36`

Critical fail-condition check:

- no generic SaaS UI
- no sci-fi, fantasy, voxel, or mobile-cartoon drift
- no missing weapon
- no unreadable characters
- no copied Counter-Strike assets or layouts
- no category scored `0`

## Feel Test

60-second main-map feel test:

1. Tactical FPS read within 5 seconds: pass
2. At least two routes understood within 10 seconds: pass
3. Meaningful combat area reached within 15 seconds: pass
4. Movement feels responsive: pass
5. Cover is usable: pass
6. Crosshair, weapon, and shot direction feel aligned: pass
7. Firing gives immediate visual and audio feedback: pass
8. Getting hit, dying, and respawning are understandable: pass
9. The map feels compact but not single-room: pass
10. At least four landmarks remain memorable after exploring: pass

Result: `10 / 10` pass

Two-tab multiplayer feel test:

1. Both players appear in the same environment: pass
2. Other-player movement is readable: pass
3. Other-player facing direction is understandable: pass
4. Shooting the other player feels plausible: pass
5. Damage, death, and respawn reflect clearly: pass
6. The experience still reads as a tactical FPS rather than two cubes moving around: pass

Result: `6 / 6` pass

Map readability test:

1. Two spawn areas identifiable: pass
2. Central contested area identifiable: pass
3. Main lane identifiable: pass
4. Corridor/interior route identifiable: pass
5. Flank route identifiable: pass
6. At least four landmarks identifiable: pass
7. At least three meaningful cover positions identifiable: pass
8. At least one elevated or semi-elevated position identifiable: pass

Result: `8 / 8` pass

## Gate Summary

Passed:

- build gate
- browser-launch gate
- map-selection gate
- map-quality gate
- core-gameplay gate
- weapon-feedback gate
- multiplayer gate
- error-handling gate
- asset-licensing gate
- documentation gate

Cross-cutting technical quality review:

- pass on separation of concerns across `src/data`, `src/game`, `src/ui`, and `src/world`
- pass on dependency discipline: the runtime remains browser-only with `three` as the only runtime dependency
- residual maintainability note: `src/game/localMatch.ts` remains the heaviest file and is the main refactor candidate if the prototype expands

## Assets And Licensing

- External art assets used in the shipped prototype: none
- External audio assets used: none
- All geometry is original primitive work
- All game audio is procedural/original in-browser synthesis
- Licensing posture: pass, corroborated by `docs/assets.md`

## Visual Weaknesses That Remain

- The live map is intentionally flatter and more abstract than the painted references, especially in walls and ground materials.
- The corridor route capture is the weakest style match because the hall reads more like a simplified lane than a richly dressed interior.
- The remote operator silhouette is readable, but still much less detailed than the reference character sheet.

## Specific Changes Made In This Verification Pass

- Added a repeatable final QA harness at `scripts/qa/finalVerification.mjs`.
- Added QA-only camera, control-engagement, death, and shared-target hooks so screenshot capture and two-tab checks are reproducible.
- Added `npm run qa:final` and `npm test` to make the strongest available browser verification part of the project commands.
- Captured the final browser screenshot set in `assets/screenshots/`.
