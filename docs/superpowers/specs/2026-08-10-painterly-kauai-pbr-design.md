# Painterly Kauai PBR Terrain Pack Design

## Goal
Create a new optional PBR terrain texture pack for the seven existing Kauai terrain types without replacing the live JPG assets yet. The visual target is the approved D-style HD hand-painted naturalism: rich, stylized, readable at ant-eye distance, but not cartoony and not flat procedural noise.

## Scope
The branch adds assets only. It does not change locomotion, antenna sensing, shaders, terrain geometry, camera behavior, gameplay logic, or the current `public/kauai-tex` files.

## Asset Layout
Create a parallel directory under `public/kauai-tex-pbr/` with one folder per existing terrain name:
- cliff
- grass
- jungle
- mountain
- reef
- sand
- snow

Each terrain folder contains:
- `<terrain>_basecolor.png`
- `<terrain>_normal_opengl.png`
- `<terrain>_roughness.png`
- `<terrain>_ao.png`
- `<terrain>_height16.png`
- `<terrain>_moisture.png`

Add a root README and preview/contact sheet.

## Visual Direction
The base-color textures must be authored as distinct terrain images, not as recolored noise. Each should contain biome-appropriate micro-detail that remains believable around a 10 mm viewing distance while still tiling cleanly.

Cliff: dark compact rock, chips, mineral variation, shallow cracks, embedded dirt.
Grass: dark soil, mossy growth, tiny organic fragments and subtle ground vegetation.
Jungle: rich damp soil, tiny twigs, leaf fragments, moss and decomposed organic material.
Mountain: gravel, angular stone fragments, compact dirt and muted mineral variation.
Reef: coastal rock/sand, shell/coral fragments, damp mineral color variation.
Sand: visible fine grains, tiny pebbles, subtle ripples and disturbances.
Snow: granular snow, small embedded stones/twigs, soft depressions and cool shadow variation.

Large leaves, sticks, rocks, roots, and other forms that should affect ant foot placement are not baked as large fake-height obstacles. Those belong to real geometry later.

## PBR Derivation
Normal, AO, roughness, height, and moisture maps must correspond to the actual details visible in each base-color texture. A visible pebble or crack should have compatible normal/height/AO information rather than unrelated procedural noise.

Height is intended initially for subtle visual micro-relief only. Recommended first integration is BaseColor + Normal + Roughness + AO. Height should begin as shallow parallax/relief, approximately 0.05–0.20 mm apparent relief, not collision-changing displacement. This avoids visible ground height disagreeing with LegDrive and SurfaceWalker.

Moisture is optional metadata for later wetness, roughness modulation, rain response, scent retention, or biome gameplay.

## Technical Requirements
- 1024x1024 per map to match the current terrain source scale.
- Seamless/tileable edges.
- Base color in sRGB.
- Data maps treated as linear.
- OpenGL tangent-space normal convention, Y+.
- Height stored as 16-bit grayscale PNG.
- No baked directional sunlight or cast shadows in base color.
- Asset names must match the seven current terrain names exactly.

## Validation
Before opening the PR:
1. Visually inspect every base-color texture at 100% and as a repeated 2x2 tile.
2. Verify there are no obvious seams or repeated edge discontinuities.
3. Verify each normal map is valid OpenGL orientation and visibly corresponds to the base-color relief.
4. Verify 16-bit height files are truly 16-bit.
5. Verify no asset exceeds the intended 1024x1024 resolution.
6. Verify the old `public/kauai-tex/*.jpg` files are untouched.
7. Include a contact sheet so Claude/user can compare all seven sets before integration.

## Integration Strategy
This PR is deliberately asset-only. After merge, Claude can pull it and integrate one terrain, preferably jungle, as the first material test. If that succeeds visually and performs well on iPhone, the material system can be expanded to all seven biomes in a separate code change.
