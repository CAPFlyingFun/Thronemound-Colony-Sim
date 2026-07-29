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
| Jump | tap **JUMP** | `Space` |
| Grip / release wall | **CLIMB / RELEASE** button | `G` |
| Auto-climb | push into a wall | push into a wall |
| Step up | automatic | automatic |

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
src/voxel/locomotion.ts     stick speed curve + acceleration
src/voxel/SurfaceFrame.ts   six-axis orientation for wall walking (not yet wired)
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
npm run smoke:queen    # pre-carves a den, founds it, checks the colony handoff
npm run smoke:mobility # rotation resize, and digging into a hole then climbing out
```

The smoke test drives the **touch** path, since that's what ships to a phone,
and asserts the things unit tests can't reach: that WebGL initialises, that the
rendered frame changes when the world does, and that carry/mound accounting
survives a real round trip through the UI.

Playwright is a devDependency for that script only. CI sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so deploys don't pull browsers they never
launch; run `npx playwright install chromium` locally if you want it.

## Movement feel

Speed comes from **how far the stick is pushed**, not just its direction, so
precise positioning while digging is possible:

| Stick throw | Speed |
|---|---|
| 0 – 8% | dead zone |
| 8 – 35% | crawl, up to 3.5 voxels/s |
| 35 – 75% | walk, up to 9 |
| 75 – 100% | run, up to 16 |

The bands are landmarks for the thumb, but the response between them is
continuous — a unit test asserts monotonicity and that no single 0.5% step of
the stick changes speed by more than 0.35 voxels/s, so it can never feel like
three discrete gears.

Keyboard has no analogue axis, so it selects the walk band (`Shift` for run).

Movement accelerates (32 voxels/s²) and decelerates (40) rather than snapping
to velocity, which is what gives the ant any sense of mass.

The touch stick is **constrained floating**: it appears under your thumb
anywhere in the left 42% of the screen, but its centre is clamped into a
lower-left region so it can't spawn beside the HUD or halfway up the screen.

> **On frame rate:** `dt` is clamped to 50 ms, so below 20 fps the game runs in
> slow motion rather than dropping frames. That's deliberate — large physics
> steps would tunnel the ant through walls — but it means a struggling device
> gets a slow game rather than a janky one. It also means headless smoke tests
> (~8 fps under software rendering) measure ~0.39× real speed; compare ratios
> there, not absolutes.

`?debug=1` appends live position and speed to the readout, which is how those
numbers get measured rather than eyeballed.

## Getting out of holes

A jump clears **1.44 voxels** (`JUMP_SPEED 34` against `GRAVITY 400`), so
digging two voxels down used to trap you permanently. Two mechanics fix it
without changing the geometry:

- **Step-up** — walking into a one-voxel rise lifts you over it, so a dug
  staircase works as a ramp with no sloped faces required.
- **Wall climb** — pushing into a wall walks straight up it. This is what real
  ants do, and it's what makes a vertical shaft survivable. It eases in over
  ~150 ms and the camera leans into the wall with a slight crawl sway; without
  those cues, ascending a sheer face is indistinguishable from levitating.

Movement is tuned for an ant rather than a person. By the square-cube law an
ant has huge drag relative to its mass, so terminal velocity is low and falls
are effectively harmless — ants drop off things constantly and walk away.

| | before | after |
|---|---|---|
| Gravity | 400 voxels/s² | 90 |
| Terminal velocity | −1.30 m/s | −0.15 m/s |
| Climb speed | 4.0 cm/s | 2.25 cm/s (~1.1 body lengths/s) |
| Jump height | 1.45 voxels | 1.47 voxels |

Jump is expressed as a **height** with the launch speed derived from it
(`JUMP_SPEED = √(2·g·h)`), because the two are coupled and hand-tuning them
separately already went wrong once: softening gravity silently turned a
1.4-voxel hop into a 3.2-voxel leap, enough to jump out of shafts and make
climbing pointless. Gravity can now be retuned freely.

Small creatures reach terminal velocity almost instantly, so what you see of an
ant falling is a near-constant slow drift rather than a build-up — the terminal
value matters more to the feel than the acceleration does.

Climbing is gated on headroom. Without that check the ant pins against a
ceiling and *hovers* — the blocked move cancels her velocity but she never
becomes grounded, so she can neither rise nor fall. Refusing to climb lets
gravity drop her back to the floor, where she can walk to the shaft instead.

This is deliberately not literal 45° geometry. Real fire-ant nests are
near-vertical shafts with chambers budding off them, so forcing everything to
a ramp would make the nests look *less* like nests — and cost ~40% more digging
for the same depth. Ants don't need ramps because ants climb.

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

## Surface walking

`SurfaceFrame.ts` is the foundation for ant wall-walking. In a voxel world
every surface is an axis-aligned cube face, so "up" is always one of **six**
directions — never an arbitrary angle. That turns general gravity-walking into
a small discrete state machine, and it's the only reason the feature is
affordable here.

The governing rule: **physics is always one of the six discrete frames; only
the camera interpolates.** An axis-aligned collision box at 43° fits nowhere,
and allowing one in-between orientation collapses the whole simplification.

Two rules keep corners from misbehaving:

- **Commitment.** Proximity to an edge is never enough to cross it — movement
  must also point across, above `INPUT_COMMIT_THRESHOLD`. This is what lets you
  stand still low on a wall without being yanked onto the floor.
- **Hysteresis.** Once a transition starts, competing surface normals are
  ignored for `ORIENTATION_LOCK_MS`. In a corner two faces are legitimately
  "nearest" within a fraction of a voxel, and picking by distance alone is how
  orientation ping-pong starts. Candidates rank by current-support → direction
  of travel → alignment with current up, never by distance.

Fully unit tested, including that no code path can produce a non-axis
orientation.

**Wired in as of now.** Walk into a wall and the button changes from JUMP to
CLIMB; press it (or `G`) and the ant grips the wall — gravity, the collision
box, the movement plane and the camera all rotate into that face's frame.
Press again to RELEASE. One context-sensitive button rather than three,
because screen space is the scarce resource on a phone.

The camera **slerps** into the new frame and swings slightly outward mid-turn,
so it reads as the body crawling around the edge rather than the world spinning
about a stationary head. Physics still snaps between the six discrete frames.

**Ceilings are locked** (`CEILING_UP`). The maths handles all six directions,
but inverted movement, input expectations and release behaviour each need their
own pass — walls should feel excellent first.

`?debug=1` shows the live `up` alongside position and speed.

## Not yet

Phase C wires in the existing colony sim (`GameState`, `FoodNode`,
`PheromoneField`) and makes a hatched worker playable.

Known gaps: no ant model (you're a floating camera), no surface world beyond
the soil block, no save, no eggs or brood in the den yet, and spoil can't be
dropped into the cell you're standing in — which is correct, but means a
one-voxel-wide shaft has nowhere to backfill from the inside.
