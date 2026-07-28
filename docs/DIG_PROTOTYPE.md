# Dig prototype (Phase A)

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
src/scenes/DigScene.ts    three.js renderer, camera, touch/desktop input, HUD
```

The first four are **plain TypeScript with no three.js import**, the same way
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
npm test          # 22 voxel unit tests + the existing colony tests
npm run typecheck
npm run build
npm run preview   # then, in another shell:
npm run smoke:dig # headless Chromium: boots WebGL, digs, places, checks conservation
```

The smoke test drives the **touch** path, since that's what ships to a phone,
and asserts the things unit tests can't reach: that WebGL initialises, that the
rendered frame changes when the world does, and that carry/mound accounting
survives a real round trip through the UI.

Playwright is a devDependency for that script only. CI sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so deploys don't pull browsers they never
launch; run `npx playwright install chromium` locally if you want it.

## Not in Phase A

Phase B is the queen founding sequence — dig to a target depth, "Found Queen's
Den", lock the location, and hand off from a playable queen to a free camera.
That mirrors real claustral founding: a mated queen sheds her wings, seals
herself in a chamber, and never leaves again.

Phase C wires in the existing colony sim (`GameState`, `FoodNode`,
`PheromoneField`) and makes a hatched worker playable.

Known gaps in A: no ant model (you're a floating camera), no surface world
beyond the soil block, no save, and spoil can't be dropped into the cell you're
standing in — which is correct, but means a one-voxel-wide shaft has nowhere to
backfill from the inside.
