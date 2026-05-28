# Asset Strategy

## Current Decision

This project is currently committed to original/simple geometry only for the implementation phase that follows this subgoal.

- Approved environment assets: none external
- Approved character assets: none external
- Approved weapon assets: none external
- Approved audio assets: none external
- Approved textures/materials: none external

Implementation should use:

- original low-poly geometry
- procedural or hand-authored simple materials
- abstract signage and markings
- original synthesized or browser-generated audio later in the goal

Reasoning:

- The reference set already establishes the target style without requiring imported content.
- The target aesthetic benefits from simple planar geometry more than from high-detail marketplace packs.
- Staying original by default is the cleanest way to meet the browser-lightweight, license-safe, and non-Counter-Strike requirements.

## Hard Rules

- Do not use Counter-Strike assets, extracted files, textures, sounds, models, UI art, names, or map geometry.
- Do not use ripped assets from any commercial game.
- Do not use assets whose original source, author, or license cannot be verified.
- Do not use CC BY-NC, CC BY-ND, editorial-only, or unclear custom-license assets.
- Do not import an external asset just because it exists; the default answer is still simple original geometry.

## External Asset Gate

If a later subgoal proposes an external asset, it is blocked until this file is updated with a record covering all of the following:

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
- the asset strengthens the low-poly dusty tactical target instead of modernizing it
- the same result cannot be reached more cleanly with simple original geometry

## Preferred Build Strategy By Asset Type

### Environment

- Build buildings, walls, ramps, catwalks, shutters, crates, barriers, and pipes from original primitives or simple authored meshes.
- Favor flat or lightly shaded materials with subtle wear instead of high-resolution scanned textures.

### Characters

- Build readable humanoid placeholders from simple modular body parts.
- Use team-color accents and silhouette clarity instead of detailed military gear.

### Weapons

- Build original abstract low-poly weapons from simple faceted shapes.
- Avoid direct replicas of recognizable real-world or Counter-Strike-associated gun silhouettes.

### Audio

- Prefer original synthesized or procedural browser audio for firing, hit confirmation, death, respawn, and menu cues.
- Keep sounds short, compressed, and retro.

## Current Manifest

No external assets are approved at this stage.

| Asset | Source | Author | License | Commercial Use | Derivatives | Redistribution/Embedding | Attribution | Browser Suitability | Style Fit | Decision | Date Checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | rejected by default until evaluated | 2026-05-27 |

## Candidate Record Template

Use this template if a later subgoal needs to evaluate an external asset:

| Asset | Source | Author | License | Commercial Use | Derivatives | Redistribution/Embedding | Attribution | Browser Suitability | Style Fit | Decision | Date Checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| example-asset | https://example.com | Example Author | CC0 | yes | yes | yes | none | low-poly, small download | good match / poor match | accept / reject with reason | YYYY-MM-DD |
