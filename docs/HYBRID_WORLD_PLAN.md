# Hybrid streamed surface + local diggable underground — inspection & plan

Written after inspecting the current code, before building the prototype.
The single most important finding first:

**Most of this architecture already exists in the repo, working and
test-proven.** `src/density/TerrainStream.ts` + `labWorld.ts` already
implement: a fixed-size resident window of fine soil sliding over an
unbounded, *function-defined* world; sparse edit storage ("base world +
deltas" is literally how it stores digging); recentring as a memmove of
retained soil plus regeneration of the arrived strip plus replay of edits;
staleness reporting so only the right mesh chunks rebuild; and a height
function that defines the top of the soil (`density = height − y`, closed at
the world's sides). The colony sim (`?map=densityterrainlab`) walks an ant on
this streamed soil today, and `labWorld.ts` itself names the missing piece:
*"coarse soil beyond the fine window is a level-of-detail question — a
different question from this one."*

So the prototype is not a new architecture. It is the existing streaming
architecture re-parameterised to the proposed scales, plus the two genuinely
missing layers: a **macro surface** beyond the fine window, and **nest-graph
carving folded into the world function**.

## Where the request's assumptions conflict with the code

1. **The memory arithmetic.** "64×64×256 = 1,048,576 positions" is not how
   the field stores soil. `DensityField` stores corner **samples** as
   Float32: a standalone 64×64×256 mm chunk at 1 mm spacing is 65×65×257
   samples = 4.34 MB. More importantly the existing design does not store
   nine chunks — it stores **one window field**, which is what makes the
   memmove recentre and seamless meshing possible. A 3×3-of-64 mm window,
   256 mm deep, at 1 mm cells is (193)²×257 samples = **38.3 MB**.

2. **"9.4 M < 256³ = 16.7 M" compares against a number that never existed.**
   The 256 cube that ran well on the iPhone auto-coarsened to 1.5 mm cells:
   177³ = 5.55 M samples = **22.2 MB**, not 16.7 M samples. The proposed
   window at 1 mm is therefore ~1.7× the *proven* memory, not smaller. Still
   plausible — but it is an increase to measure, not a saving to bank.

3. **Fire-ant scale is already true.** `CASTE_LENGTH_MM` is queen 9 mm,
   major 6, worker 4. Nothing assumes a 20 mm ant. All soil systems are
   mm-explicit already (`WORLD_UNIT_MM = 5`, `CELL_MM`, etc.).

4. **The staircase fear does not apply to this codebase.** The underground is
   not Minecraft blocks: density samples a *continuous* function of the
   heightfield and Surface Nets interpolates the zero crossing inside each
   cell. The streamed lab surface is visibly smooth today. At 1 mm cells the
   surface facets by well under half a millimetre — smooth at ant eye height.
   No conforming/clipping machinery is needed for the top of the fine soil.

5. **"Digging through the surface" is only a problem for the macro layer.**
   Inside the fine window, the visible surface *is* the density mesh — bites
   and the Nest Designer's mound-and-vent entrance already open real holes in
   it (the anthill vent is exactly this, shipped). The only new problem is
   ensuring the macro sheet is never drawn where the fine window is
   authoritative. That is a clip, not a hole system.

6. **Streaming currently triggers on tile indices** — precisely what the
   request warns against. `recentreOn` fires when the ant's *tile* changes.
   Distance-based prefetch/hysteresis is new work, but it layers on top: lead
   the recentre target by velocity, deadband the return.

## Answers to the ten questions

**1. Can DensityField be chunked/streamed cleanly?** It already is — by
`TerrainStream`, whose design (one window field + world-as-function + sparse
edits + memmove slide) is the right storage layer. What it lacks is
parameterisation: it imports the lab's constants and height function
directly. The prototype generalises it (config + injected base function) as
`src/world/WorldStream.ts`, leaving the lab's stream untouched. Do **not**
build per-chunk DensityFields: separate fields reintroduce every seam problem
the single window already solves.

**2. Sample spacing inside the window?** **1 mm.** Tunnels (4–10 mm bores)
and chambers read cleanly; the surface is smooth; the window fits memory. The
cost is *bite* fidelity: a queen's 1.75 mm mandible spans 1.75 cells and
reads as a dent (the lab uses 0.25 mm cells for that reason and pays for it
with a 48 mm window). At the streamed-world scale, digging is designer-first;
the fine-bite experience stays in the lab room. If bites must be first-class
here later, that is a micro-window-within-the-window question.

**3. Real memory per loaded chunk?** One window allocation of 38.3 MB
(3×3 of 64 mm, 256 mm deep, 1 mm cells, Float32 corner samples) ≈ 4.25 MB
per 64 mm tile equivalent — plus meshes (measured in the prototype HUD), plus
the macro tiles (trivial: tens of KB each). Edits cost ~9 bytes/changed
sample in the sparse store.

**4. Is 3×3 reasonable on an iPhone?** Almost certainly: 38 MB vs the proven
22 MB, and meshing scales with surface area, not volume. The prototype's HUD
reports heap and rebuild times so the phone answers definitively. Fallbacks
if needed: 1.25 mm cells with 80 mm tiles (24.5 MB) or 192 mm depth.

**5. One 256 mm column or divided vertically?** **Store one column; mesh in
vertical sub-chunks.** The memmove recentre depends on the single allocation,
and vertical storage slices would complicate it for little gain. Meshing
already happens in 32-cell chunks (BlockScene) — the window meshes as a 3D
grid of ~32 mm chunk regions, so deep all-solid slabs mesh to nothing
quickly and a bite only rebuilds its own chunk.

**6. Cleanest way for digging to cut the smooth heightmap?** **Hand-off, not
holes.** Inside the fine window the density mesh is the only surface drawn;
macro tiles intersecting the window are clipped per-fragment against the
window's XZ rectangle (one vec4 uniform, updated on scroll). Since macro and
fine sample the *same* height function, the fine surface meets the macro
sheet at the rim to within mesh resolution. Holes then need no special
machinery anywhere: anything that opens the fine mesh (bite, vent, tunnel
breakthrough) is simply visible, because there is no blanket over it.

**7. Can NestGraph reconstruct tunnels deterministically on stream-in?**
Yes, and better than replaying edits: **fold the carve into the base
function**. `planHollow(plan)` is a pure function with per-part bounding-box
rejects (`within`), and `carve(soil, hollow)` is one `min`. Streaming a strip
back in re-evaluates the same function → identical tunnels, zero save data
beyond the plan JSON. `planBounds` culls the whole plan per strip cheaply.
The prototype proves round-trip reconstruction sample-for-sample.

**8. Seams between separately meshed underground chunks?** Non-issue under
the chosen storage: chunks are mesh *regions of one field*, and
`densityWatertight.test` already proves region meshing produces exactly the
whole-field surface. The visible seam that does exist is the window's own cut
face at the rim (`CAP_PLANES`) meeting the macro sheet — same height
function, so the top edges align; the prototype draws it honestly and the
HUD shows it. (A cosmetic skirt can soften it later.)

**9. Should surface and underground rendering share geometry?** No. Separate
representations, local hand-off at the window rectangle (Q6). Sharing
geometry would force one representation to solve all three problems — the
exact thing the request's architectural principle forbids.

**10. Surface tile size?** **256 mm tiles, 8 mm vertex pitch near, 32 mm
pitch far** (two rings by distance). Fully decoupled from the 64 mm
underground tile. A 4 m world is 16×16 = 256 tiles; near ring ~1.5 m radius.
Draw calls stay double-digit with frustum culling; the HUD counts them.

## Streaming-window numbers, restated against the implementation

- Resident fine window: 192×192 mm footprint, 256 mm deep (the "3×3 of
  64 mm"), but the *slide granularity* is an internal knob — the prototype
  uses 32 mm tiles (6×6 window) so each scroll regenerates half the strip
  volume, halving the hitch and doubling the frequency. Same resident span.
- Distance rings map cleanly: 0–96 mm *is* the fine window; beyond it macro
  tiles at two pitches cover 96 mm → world edge. "Unload" for the fine layer
  means "slid out of the window" — the world function plus edits store means
  nothing else needs unloading.
- Prefetch: recentre on the ant's position **led by velocity** (capped
  ~24 mm), with a deadband so hovering on a line cannot ping-pong. Scroll
  cost is measured and shown; if the strip regen hitches on phone, the next
  lever is generating the strip in Y-slabs across frames.

## What stays untouched

The lab room, its 0.25 mm bite fidelity, and its stream; BlockScene and the
Nest Designer; locomotion (the prototype room uses a deliberately simple
surface walker — proving terrain streaming, not porting the climb).

## Prototype (`?scene=world`)

`src/world/worldScape.ts` — the world as functions, mm-first: height,
ground, base density with the nest plan carved in (mound + vent entrance
included). `src/world/WorldStream.ts` — parameterised stream.
`src/world/MacroSurface.ts` — clipped macro tiles + debug boxes.
`src/scenes/WorldScene.ts` — walker, camera, dig, mesh job queue,
distance/velocity recentring, diagnostics HUD, probe hooks.
`scripts/probe-world.mjs` — the fourteen-step list, condensed: tunnel
crossing tile boundaries open before/after a leave-and-return; entrance open
through the surface; scroll counts and timings; a dig opening the fine
surface; no errors.
