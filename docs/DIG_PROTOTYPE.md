# Dig prototype (Phases A + B)

**Play:** append `?scene=dig` to the game URL —
`https://capflyingfun.github.io/Thronemound-Colony-Sim/?scene=dig`

First-person, at ant scale. Walk, look, dig soil, carry the spoil, drop it back
out. The default route (no `?scene=`) is still the 2D Phaser colony sim; the two
never load each other's bundle.

## Controls

| | Touch | Desktop |
|---|---|---|
| Walk | drag the **left half** of the screen | `WASD` / arrows, `Shift` to sprint |
| Look | drag the **right half** | move the mouse (click once to capture the cursor, `Esc` to release) |
| Dig / place | hold **ACTION** | hold left mouse button |
| Toggle mode | tap **REMOVE / ADD** | `E` or `Tab` |
| Jump | — | `Space` |

## Scale

One world unit = one voxel = **5 mm**. The volume is 128³ voxels, so:

- the ground patch is **64 cm × 64 cm**, about 128 ant-lengths across
- there are **96 voxels of diggable soil** beneath the surface (~48 cm), which is
  a realistic depth for a founding nest
- the ant stands ~1.6 voxels tall and reaches 5.5

Everything scales off `VOXEL_MM`, `WORLD_SIZE` and `SURFACE_Y` at the top of
`src/scenes/DigScene.ts`. Growing the world is a constant change, not a rewrite.

## Soil is conserved

The rule that makes this an ant game rather than Minecraft: **you cannot place a
voxel you did not first excavate.** Digging fills your carry load (12 voxels);
ADD mode drops one back. So the mound above ground is exactly the volume of the
tunnels below it, and the HUD's `Dug` and `Mound` counters are two views of the
same soil.

Strata dig at different speeds — topsoil 0.35 s, sand 0.5 s, clay 0.7 s — and
the deepest band is bedrock, which can't be dug at all and forms the floor of
the world. The sides and floor of the volume read as stone, so you can't tunnel
out of bounds.

## How it's built

```
src/voxel/VoxelWorld.ts   sparse chunked storage + world generation
src/voxel/raycast.ts      Amanatides & Woo grid traversal (targeting)
src/voxel/mesher.ts       face-culling mesher with per-vertex ambient occlusion
src/voxel/DigSession.ts   dig timing, carry load, place rules
src/voxel/QueenFounding.ts  depth + chamber requirements, den lock
src/voxel/tileTextures.ts   procedural ant-scale soil tiles
src/voxel/voxelMaterial.ts  texture-array material (the only three.js file here)
src/scenes/DigScene.ts    three.js renderer, camera, touch/desktop input, HUD
```

Everything except `voxelMaterial.ts` and `DigScene.ts` is **plain TypeScript with no three.js import**, the same way
`PheromoneField` and `FoodNode` are engine-free. They're unit tested headlessly
(`npm test`), and a future renderer swap wouldn't touch them.

Two properties keep an ant-scale world cheap:

1. **Untouched chunks cost zero bytes.** A chunk is reproducible from the
   generator until something inside it is modified, at which point it
   materialises its 32 KB array. Boot the scene and the HUD reads `0 KB voxels`.
   (Checking for *uniform* chunks instead would achieve nothing here — soil
   strata don't line up with chunk boundaries, so nearly every chunk holds two
   materials and would allocate immediately.)
2. **Only exposed faces are meshed.** A fully buried chunk emits no geometry at
   all, so render cost tracks how much has been **dug**, not how big the world
   is. A pristine flat world is 16 chunks of surface and nothing else.

## Verifying

```bash
npm test          # 40 voxel unit tests + the existing colony tests
npm run typecheck
npm run build
npm run preview   # then, in another shell:
npm run smoke:dig   # boots WebGL, digs, places, checks soil conservation
npm run smoke:queen # pre-carves a den, founds it, checks the colony handoff
```

The smoke test drives the **touch** path, since that's what ships to a phone,
and asserts the things unit tests can't reach: that WebGL initialises, that the
rendered frame changes when the world does, and that carry/mound accounting
survives a real round trip through the UI.

Playwright is a devDependency for that script only. CI sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so deploys don't pull browsers they never
launch; run `npx playwright install chromium` locally if you want it.

## Textures

Material choice travels per-vertex as a **texture-array layer**, not as a UV
offset into an atlas — an atlas bleeds neighbouring cells into each other once
mipmaps engage at distance, and that can't be fixed later without re-authoring
the art. The whole world still shares one `MeshStandardMaterial`.

One tile spans `TILE_VOXELS` (8) = **4 cm of real ground**, and UVs are world
space, so the pattern flows across neighbouring voxels of one material instead
of restarting on every cube face.

Placeholder tiles are generated procedurally in `tileTextures.ts`, and that's
deliberate: every feature size is quoted in **millimetres** and converted, so
"clods are 15–25% of tile width" is enforced in code rather than judged by eye.
Photographic tiles drop in against that same target.

> **Scale is the thing that makes or breaks a soil texture here.** A tile shot
> at human scale (a ~30 cm garden bed) compresses every feature 8× too small
> once mapped to a 4 cm tile: pebbles become sand grains and the ground reads
> as flat noise. Tiles must be macro shots of a few centimetres of dirt.

Albedo is sRGB, normal and roughness are linear. Base colours are authored in
sRGB bytes — feeding linear values through an sRGB texture renders everything
about half as bright, which is a mistake worth only making once.

## Phase B — founding the queen's den

You start as the queen. The objective line drives the whole sequence:

1. **Dig down** — 40 voxels (200 mm) below the surface
2. **Hollow a chamber** — 14 air voxels within radius 2, which a bare shaft
   can't satisfy (~5) but a 3×3×3 pocket comfortably can (19)
3. **Found the den** — the button appears *only* while the site qualifies, so
   stepping out withdraws the offer and teaches the requirement without a
   tooltip

Founding is irreversible. The queen sheds her wings, seals the chamber, and
stops being a character — the camera detaches and orbits the den. That's not a
game concession; it's claustral founding, which is what actually happens.

The colony view is a **cutaway**: orbiting from inside a solid volume means
back-face culling shows you through the soil, leaving the burrow readable in
cross-section like an ant farm. The background switches to dark earth so it
reads as intentional rather than as a rendering fault.

Threshold numbers were measured, not guessed — see the "den chamber threshold
is achievable by hand" test, which asserts the requirement is satisfiable from
where a player actually *stands* (the chamber floor), not from a theoretical
centre point. Measured from the floor of a **spherical** cavity you only get
11, which is why the debug carve is a box.

## Debug entry point

`?scene=dig&debug=den` pre-carves a qualifying shaft and chamber and drops the
queen into it. Founding otherwise needs 40 voxels of hand-digging, which makes
both manual iteration and the smoke test impractical.

## Not yet

Phase C wires in the existing colony sim (`GameState`, `FoodNode`,
`PheromoneField`) and makes a hatched worker playable.

Known gaps: no ant model (you're a floating camera), no surface world beyond
the soil block, no save, no eggs or brood in the den yet, and spoil can't be
dropped into the cell you're standing in — which is correct, but means a
one-voxel-wide shaft has nowhere to backfill from the inside.
