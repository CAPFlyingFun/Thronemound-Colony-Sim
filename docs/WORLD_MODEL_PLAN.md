# World-model migration plan

Assessment of the proposal to replace the 5 mm cubic voxel world with a 3 mm
hexagonal-prism lattice. No code has been changed. Written against commit
`3d1ac27` (v0.26.0).

**Headline: the proposal bundles four separable decisions into one rewrite. Three
of them are good, cheap, and lattice-independent. The fourth — hexagons — is the
expensive one and it is the only one that does not address a complaint on the
list.** Recommendation is to unbundle, ship the cheap three on the cube grid,
and let hex earn its place afterwards on evidence. Details in §10.

---

## 1. Current architecture audit

### 1.1 Files, by size

| File | Lines | Role |
|---|---:|---|
| `src/scenes/DigScene.ts` | 2731 | The game. Controller, camera, targeting, collision, HUD, clod rendering, dig orchestration. |
| `tests/voxel.test.ts` | 1775 | Unit tests for every pure module. |
| `src/scenes/HexScene.ts` | 641 | Experimental hex room. Imported by nothing else. |
| `src/voxel/fracture.ts` | 608 | 4×4×4 sheet-peel pattern generation. Pure. |
| `src/anim/hexapod.ts` | 431 | Gait for three castes. Pure. Lattice-independent. |
| `src/voxel/SurfaceFrame.ts` | 415 | Six-axis wall-walking state machine. Pure. |
| `src/voxel/DigSession.ts` | 362 | Dig timing, mastery curve, carry accounting. Pure. |
| `src/voxel/mesher.ts` | 353 | Exposed-face mesher, per-vertex AO, cavity dishing. Pure. |
| `src/voxel/clod.ts` | 352 | Clod geometry/instancing. |
| `src/voxel/LooseSoil.ts` | 343 | Loose-piece physics, sleep/wake, pooling. Pure. |
| `src/voxel/VoxelWorld.ts` | 304 | Sparse 32³ chunk store, materials, generator. Pure. |
| `src/voxel/HexGrid.ts` | 304 | Experimental hex storage — `Map<string, number>`. |
| `src/voxel/tileTextures.ts` | 249 | Procedural soil textures. |
| `src/voxel/voxelMaterial.ts` | 131 | Shader/material setup. |
| `src/voxel/raycast.ts` | 102 | Amanatides & Woo cubic DDA. Pure. |
| `src/voxel/locomotion.ts` | 91 | Stick curve → speed. Lattice-independent. |
| `src/voxel/QueenFounding.ts` | 139 | Founding milestones. Pure. |

Total ~11.3k lines including tests and smoke scripts.

### 1.2 World ownership

`VoxelWorld` is the sole authority on packed soil. Storage is a `Map` of chunk
records keyed by chunk coordinate; each record is `{ data: Uint8Array | null,
fill: 'air' | 'solid' | 'mixed' }`. `data` stays `null` until something inside
is modified, so untouched soil costs one record, not 32 KB — the chunk is
reproducible from the deterministic `Generator`. Index is
`((y & 31) << 5 | (z & 31)) * 32 + (x & 31)`.

Everything downstream reads the world through a two-line structural interface:

```ts
interface Sampler { get(x: number, y: number, z: number): VoxelId }
```

This is the most valuable single design decision in the repository and it is
lattice-independent. `mesher`, `raycast`, `SurfaceFrame` and `LooseSoil` all
depend on `Sampler`, not on `VoxelWorld` — which is how the part-dug voxel mask
(`DigScene.meshSampler()`) works with zero mesher changes.

### 1.3 Digging ownership — and where the "large parent region" complaint comes from

Three objects share responsibility, which is the root of the interaction
problems:

- `fracture.ts` owns the *pattern*: which of the 64 sub-cells comes away at what
  fraction of progress. `thresholds[i]` is quantised so sheet *n* fully releases
  at progress `(n+1)/4`.
- `DigSession` owns *time and accounting*: `DIG_START 12.5 s` decaying by
  `DIG_STEP 0.34` per dig to `DIG_FLOOR 6.4 s` (mastered = 1.6 s/sheet), a
  `sheets: Map<string, number>` of how many sheets each cell has lost, and
  `carried` in pieces.
- `DigScene` owns the *visual*: a `chips: Map<string, ActiveDigVisual>` of
  part-dug voxels, each masked out of the mesh and replaced by 64 instanced
  sub-cubes.

The consequence the proposal correctly identifies: **the authoritative unit is a
5 mm voxel, so the highlight is a 5 mm box, so the crosshair — a point — selects
125 mm³.** The 64 sub-pieces are a *presentation* of that one unit, not units in
their own right, which is exactly why it "reads as one large cube breaking
apart." The proposal's diagnosis here is right.

### 1.4 Loose-soil ownership

`LooseSoil` holds an array of `Clod` records: `{ position, velocity, material,
source, asleep, restFor }`. `source` is documented as "shape identity, never
quantity." `CLOD_RADIUS 0.1`, `PIECES_PER_VOXEL 64`, `MAX_LOOSE_CLODS 768`.

Conservation is asserted as `excavated === carried + loose + deposited`, counted
in pieces, and there are tests for it. **The proposal's fear of "simultaneous
duplicate representations" is mostly already handled** — but not entirely: while
a voxel is part-dug, its soil exists as *both* a `chips` entry (still solid in
`VoxelWorld`, masked in the mesh) *and* as already-issued pieces. Reconciling
that is why `releaseActive()`/`onSheetFreed()` exist and why the
"cancelling minted soil" and "last sheet arrives 48-or-64" bugs happened. That
class of bug disappears entirely under one-press-one-cell.

### 1.5 The load-bearing invariant nobody has written down in the proposal

`DigScene.ts:45–57` documents why `EYE_HEIGHT = 0.7` and `BODY_RADIUS = 0.3`:

> At 0.7 × 0.6 (3.5 mm × 3 mm) the ant fits both standing AND lying in a single
> voxel, so a one-cube tunnel becomes fully wall-walkable.

**The ant is deliberately sized to fit inside one cell in every orientation.**
That is what makes a one-cell tunnel traversable *and* wall-walkable, and it is
load-bearing for `SurfaceFrame`: the frame-transition code lifts the body by
`BODY_RADIUS + 0.05`, `1`, and `EYE_HEIGHT` looking for a fit
(`DigScene.ts:2168`), and those candidate lifts assume the body is voxel-scale.

Shrinking the cell to 3 mm breaks this invariant **regardless of lattice.** See
§5.3 — this is the single largest under-costed item in the proposal.

---

## 2. Reusable systems

### Survives untouched (lattice-independent)
- `hexapod.ts`, `QueenModel.ts`, all three GLBs, the rig-derivation-from-inverse-bind-matrices technique, `rigScale()`.
- `locomotion.ts` (stick curve → speed).
- `tileTextures.ts`, `voxelMaterial.ts`.
- The `Sampler` interface as a *concept* — the new world should expose the same shape.
- `PheromoneField`, `FoodNode`, `GameState`.
- All four smoke scripts' *methodology*: touch-path driving, dpr 3, poll-never-single-sample, PNG-size-as-detail-proxy.

### Survives with parameter changes only
- `VoxelWorld`'s chunk strategy: lazy `data`, `fill` classification, deterministic generator, byte-per-cell. Directly portable to any lattice.
- `DigSession`'s mastery curve and hardness-as-ratio (`Material.hardness` is a multiplier, not seconds — correct, keep).
- `LooseSoil`'s sleep/wake/pool architecture, `wakeNear()`, `scoop()`, JSON round-trip.
- `QueenFounding` — its milestones are volume/enclosure based, which is lattice-agnostic. `DEN_MIN_CHAMBER = 14` would need requantising (§5.2).
- `mesher.ts`'s *structure* (exposed-face emission, per-vertex AO, `CAVITY_ENCLOSURE` cavity detection, `CAVITY_DISH` displacement with analytic normals and Gram-Schmidt tangents). The dishing maths generalises to any planar face.

### Needs rewriting if and only if the lattice changes
- `raycast.ts` (102 lines) — cubic DDA.
- `DigScene.collides()` / `tryAxis()` / `moveOnSurface()` — axis-separated AABB.
- `SurfaceFrame.ts` (415 lines) — the six `AxisDirection`s and `isPerpendicular`.
- `mesher.ts`'s `FACES` table and `tangentAxes()`.

### Dies under one-press-one-cell, regardless of lattice
- `fracture.ts` — all 608 lines. No sheets, no thresholds, no 64-cell ordering.
- `DigSession.sheets: Map<string, number>` — per-cell progress storage becomes a single active-cell record.
- `DigScene.chips: Map<string, ActiveDigVisual>` and `meshSampler()` — no part-dug cells to mask.
- `PIECES_PER_VOXEL`, `SCOOP_PIECES`, `LAYER_CELLS`, `releasedBetween()`, and the piece-vs-voxel unit confusion that caused four separate bugs.

**That is roughly 900 lines deleted for free.** It is the largest simplification available and it does not require hexagons.

---

## 3. Geometry check — is the proposal's maths right?

### 3.1 "3 mm across flats" — correct
For a regular hexagon of across-flats width *w*: side *s = w/√3*, corner-to-corner *= 2w/√3*, inradius *= w/2*, area *= (√3/2)w²*.

At *w* = 3 mm: *s* = 1.7321 mm, corner-to-corner = 3.4641 mm. **The proposal's 1.73 and 3.46 are right,** and the warning that across-flats ≠ side length is well taken.

### 3.2 "Eight face-connected neighbours" — correct
Six lateral + top + bottom = 8. But note what this means in context: **two messages ago the stated goal was *more* than the cube's six directions, and the octagon analysis landed on ten. A hex prism gives eight.** The proposal is a direction-count *regression* against its own originating motivation. That is only acceptable under the reading that direction count was a red herring all along — which I think is correct, and which the proposal half-concedes by asking for irregular tunnel boundaries and cosmetic variation. Worth stating out loud so the decision is made deliberately rather than by drift.

### 3.3 Depth = across-flats is the wrong choice — a real correction
With *w* = 3 mm and depth 3 mm, the six lateral faces are **1.73 mm wide × 3 mm tall** — a 1 : 1.73 sliver. Six vertical slivers per cell means a tunnel wall renders as **narrow vertical planks**, reading as a staved barrel or a palisade fence. Meanwhile the caps are regular hexagons, reading as honeycomb.

So a hex-prism tunnel has **two different artificial signatures depending on which surface you look at, and neither is soil.** Floors look like a beehive, walls look like a fence.

If you go hex, set **depth = side length (1.732 mm), not depth = across-flats.** Then lateral faces are 1.73 × 1.73 mm squares and the plank effect disappears. Cost: cell volume drops to 13.5 mm³ (§5.1 recomputes), so layer count rises. This is not in the proposal and it materially changes the look.

### 3.4 The honeycomb risk is worse than the proposal allows
The proposal says the result "must not look like a perfect underground honeycomb." It is worth being blunt: **hexagons do not read as more organic than cubes — they read as a different recognisable lattice, and for an ant game specifically, honeycomb is a worse false signal than blockiness.** A hex tiling's 120° vertices align into a visible triangular super-lattice that the eye locks onto readily.

What actually destroys lattice legibility is (a) sub-cell displacement noise, (b) irregular tunnel *boundaries*, and (c) cell size small enough that individual cells stop being individually resolvable. All three are available on the cube grid today. Only (c) is a lattice-adjacent question, and it is answered by cell size, not cell shape.

---

## 4. Soil identity model

The proposal's lifecycle is right and simpler than what exists. Recommended
ownership, one owner per state, no overlap:

| State | Owner | Representation |
|---|---|---|
| packed | `World` chunk byte | material id in the typed array; no object exists |
| targeted | `DigTarget` (transient, 1 per player) | coordinate + face + material; **world byte unchanged** |
| loosening | `ActiveDig` (transient, exactly 1) | coordinate + elapsed + duration; **world byte unchanged** |
| detached | `LooseSoil` record | world byte set to AIR **in the same call** that pushes the record |
| carried | `LooseSoil` record, `held = true` | physics skipped; transform driven by the mandible socket |
| dropped | `LooseSoil` record, `held = false` | physics resumes from the mandible transform |
| sleeping | `LooseSoil` record, `asleep = true` | transform frozen; instanced draw only |
| batched | `LooseSoil` record, `asleep = true`, far | same record, cheaper draw; **record is never discarded** |

Two invariants worth testing directly:

1. **Detachment is one atomic transition.** `world.set(cell, AIR)` and
   `soil.push(record)` happen in one function with no `await` and no event
   between them. Every duplication bug in the current system traces to the
   window where a cell was both solid and had issued pieces.
2. **Loosening changes no world state.** The visual sequence (dust, cracks,
   rocking) is driven entirely from `ActiveDig.elapsed`, so cancelling is a
   no-op by construction rather than by a reclaim path. This deletes
   `releaseActive()`, `onSheetFreed()`, `endChip()` and the bugs that lived
   in them.

`carried` as a flag on the *same record* (rather than an inventory count) is the
right call and is a change from today, where `DigSession.carried` is an integer
piece count divorced from any specific clod.

---

## 5. Performance and economy — the numbers

### 5.1 Cell size and count

Hex prism, across-flats *w*, depth *d*:

| | cube 5 mm | hex *w*=2, *d*=2 | hex *w*=3, *d*=3 | hex *w*=3, *d*=1.73 | hex *w*=4, *d*=4 |
|---|---:|---:|---:|---:|---:|
| Cell volume (mm³) | 125 | 6.93 | 23.38 | 13.50 | 55.43 |
| Cells per cube-voxel | 1 | 18.0× | 5.35× | 9.26× | 2.26× |
| Lateral face (mm²) | 25 | 2.31 | 5.20 | 3.00 | 9.24 |
| Faces per cm² of wall vs today | 1× | 10.8× | 4.8× | 8.3× | 2.7× |
| Cap face (mm²) | 25 | 3.46 | 7.79 | 7.79 | 13.86 |
| Faces per cm² of floor vs today | 1× | 7.2× | 3.2× | 3.2× | 1.8× |

**The dominant cost is cell size, not cell shape.** Surface-area-to-volume for a
3 mm hex prism is 2.0 mm⁻¹; for a 3 mm *cube* it is also 2.0 mm⁻¹. A 3 mm hex
prism and a 3 mm cube cost the same to store and very nearly the same to mesh.
Whatever the phone does at 3 mm hex, it does at 3 mm cube — which means the
scale question can be answered without writing a hex world at all (§6).

### 5.2 Dig economy, against the real founding requirement

`QueenFounding` requires `DEN_MIN_DEPTH = 4` voxels (20 mm) and
`DEN_MIN_CHAMBER = 14` air voxels inside a radius-2 ball. With the shaft that is
~19 voxels ≈ **2400 mm³** of excavation for the whole founding sequence.

| | presses | at 1.6 s/press | vs today |
|---|---:|---:|---:|
| today (19 voxels × 4 sheets) | 76 | 2.0 min | 1× |
| hex 2 mm | 346 | 9.2 min | 4.6× |
| **hex 3 mm** | **103** | **2.7 min** | **1.35×** |
| hex 3 mm, *d* = 1.73 | 178 | 4.7 min | 2.3× |
| hex 4 mm | 43 | 1.2 min | 0.57× |

**3 mm is nearly press-neutral.** That is the strongest quantitative argument in
favour of the proposal's preferred scale, and it holds for a 3 mm cube equally.

**2 mm is disqualified on this metric alone** — 4.6× the presses for the opening
tutorial. And note the self-contradiction: the only way to rescue 2 mm is
multi-cell digs, which reintroduces the "large parent region" the proposal
exists to remove.

### 5.3 The carry economy — the proposal's one serious design error

`DigSession` defaults to `capacityVoxels ?? 12` — the queen holds **12 voxels =
1500 mm³ = 768 pieces**. The entire founding is 2400 mm³, so today she does it
in **about two trips**.

The proposal says "Queen normally carries one detached soil cell." At 3 mm that
is 23.4 mm³ per trip, so founding becomes **103 round trips** down and up a
20 mm shaft. At a plausible 10 mm/s ant walk that is ~40 mm of travel plus
grab/drop per trip — call it 8–10 s — so **15 to 17 minutes of pure hauling** for
what is currently a two-trip errand, on top of the digging.

**This is a 50× regression in trip count and it has nothing to do with geometry.**
It is the single most likely thing to make the rewrite feel worse than what it
replaces, and it would be blamed on hexagons.

Fix: keep a **bundle** — one held object containing *n* cell records. That is
compatible with "one cell = one authoritative unit" (a bundle is a container of
records, not a fourth representation), it is what the current `scoop()` already
does, and it is what real ants do. Recommend the queen's bundle hold ~64 cells
(1500 mm³, preserving today's two-trip founding) and make it data-driven per
caste as the proposal asks.

### 5.4 Loose soil — the cap gets easier, not harder

Today a piece is 125/64 = **1.95 mm³**, roughly a 1.25 mm grain. That is *sand*,
and it is why the chipping "feels artificial": the game is emitting dust, not
clods.

A 3 mm hex cell is 23.4 mm³ — **12× the volume, 2.3× across**. Chunky pellets an
ant carries in her mandibles, which is the actual reference.

| | piece volume | pieces to hold 1500 mm³ | founding spoil (2400 mm³) |
|---|---:|---:|---:|
| today | 1.95 mm³ | 768 (= the cap) | 1229 pieces — **over cap** |
| hex 3 mm | 23.38 mm³ | 64 | 103 pieces |

So today's `MAX_LOOSE_CLODS = 768` is already tight enough that founding spoil
cannot all exist at once. Under the new model 103 pieces covers the whole
founding. **Recommend capping by volume with a count backstop of 256** — 4× the
soil headroom of today at 1/3 the simulated objects. Do not scale 768 up; scale
it *down*.

### 5.5 Chunking at 3 mm

Keep 32³ cells per chunk and byte-per-cell, so a chunk stays 32 KB and lazy
allocation still works. But note the extent shrinks: 32 × 5 mm = 160 mm today
versus 32 × 3 mm = 96 mm. Covering the same world volume needs **(160/96)³ ≈
4.6× more chunks**, which means ~4.6× the chunk records, dirty-set churn, and —
if the mesher stays one mesh per chunk per material — **~4.6× the draw calls.**

That is the number most likely to break the 60 fps target, and it is a
consequence of cell size, not lattice. Mitigations, in order of preference:
merge adjacent chunk meshes into one draw call per material per 2×2×2 region;
or raise chunk size to 48³ (108 KB, worse lazy-allocation granularity).

Coordinates: axial `q, r` plus `layer`. A **rhombus** chunk in axial space tiles
perfectly — no hex-shaped chunks needed. Chunk id via arithmetic shift
(`q >> 5`), local index via mask (`q & 31`); both are correct for negatives in
two's complement, which is the same trick `VoxelWorld` already uses. Recommended
layout:

```ts
// One cell, one byte: material in the low nibble, cosmetic seed in the high.
index = ((layer & 31) << 10) | ((r & 31) << 5) | (q & 31)
```

Damage/loosening needs **no chunk storage at all** under one-press-one-cell —
there is exactly one loosening cell at a time, so it lives in the transient
`ActiveDig`. This deletes `DigSession.sheets` outright.

### 5.6 Budgets

Targets for a phone, to be asserted by instrumentation rather than eyeballed:

| Metric | Budget | Where measured |
|---|---|---|
| Frame time, p50 | ≤ 12 ms | rAF delta histogram |
| Frame time, p99 | ≤ 16.6 ms | same |
| Terrain draw calls | ≤ 60 | `renderer.info.render.calls` |
| Visible triangles | ≤ 150 k | `renderer.info.render.triangles` |
| Active chunks meshed | ≤ 120 | world instrumentation |
| Single chunk remesh | ≤ 4 ms | `performance.now()` around `meshChunk` |
| Remesh per dig (owner + seams) | ≤ 8 ms total | dig handler |
| Awake loose pieces | ≤ 48 | `LooseSoil.awake` |
| Total loose records | ≤ 256 | `LooseSoil.count` |
| Raycast | ≤ 0.15 ms | targeting path |
| Collision per frame | ≤ 0.3 ms | controller |
| JS heap growth, steady state | ≤ 1 MB/min | `performance.memory` where available |

Instrumentation: extend the existing `.dig-hud` readout (already polled by the
smoke suites every 6th frame) with a `?perf=1` panel emitting p50/p99 frame
time, draw calls, triangles, max remesh ms, awake/total soil, and heap. That
makes the phone test a matter of reading a number off the screen and makes the
same numbers assertable headlessly. **Do this before any world-model work** — it
is the only way the 2/3/4 mm comparison produces a decision rather than an
argument.

---

## 6. Scale comparison — run it on the cube grid first

The proposal asks for a 2 / 3 / 4 mm comparison. **That test does not need a hex
world.** Per §5.1, a 3 mm hex prism and a 3 mm cube have identical
surface-to-volume and near-identical cell counts, so the cube grid answers every
question in the proposal's comparison list except "does hex look better," and it
answers them in an afternoon instead of a month.

Making the cube grid scale-parametric is a small change because scale flows
through few places. `VOXEL_MM` appears in 9 lines. The physics constants are in
voxel units and scale by `5/mm`:

| Constant | today | at 3 mm |
|---|---:|---:|
| `EYE_HEIGHT` | 0.7 | 1.17 |
| `BODY_RADIUS` | 0.3 | 0.50 |
| `REACH` | 2.2 | 3.67 |
| `GRAVITY` | 12 | 20 |
| `STEP_HEIGHT`, speeds, `CLOD_RADIUS`, `SCOOP_RANGE` | — | × 5/3 |

`rigScale()` already derives from `CASTE_LENGTH_MM / VOXEL_MM / lengthUnits`, so
the ant rescales automatically. `GRAVITY` must scale linearly or the ant's jump
arc changes physical meaning.

### The finding that must be checked first

Per §1.5, the ant is currently sized to fit inside **one** voxel in every
orientation. At 3 mm she is 1.17 cells tall and 1.0 wide, so:

- A one-cell tunnel stops being traversable. Minimum bore becomes **2 cells**.
- Lying against a wall she needs 3.5 mm of clearance along the wall normal — 1.17 cells → 2 cells. **Wall-walking in a minimal tunnel must be revalidated.**
- Presses per mm of *tunnel length* (as opposed to per mm³) rise **1.25×–2.9×** depending on bore, on top of the §5.2 volume figures.
- The candidate lifts at `DigScene.ts:2168` (`BODY_RADIUS + 0.05`, `1`, `EYE_HEIGHT`) are tuned to a voxel-scale body and will need re-deriving.

This is *the* risk of the smaller cell and it applies to hex and cube equally.
The upside is real too: tunnel width becomes an expressive variable (6 mm tight
squeeze vs 12 mm gallery), where today every tunnel is exactly one voxel. That
is plausibly a bigger contributor to "tunnels look like plumbing" than the
lattice is.

### Test scene

`?scene=scale&mm=2|3|4` — same seed, same camera path, same queen:

1. 20 mm entrance shaft, minimum viable bore for that scale.
2. Founding chamber meeting the requantised `DEN_MIN_CHAMBER`.
3. Scripted traversal: floor → wall → ceiling → wall → floor.
4. One-cell crosshair dig, 20 presses.
5. 100+ detached pieces and a spoil pile.
6. First person; third-person stub if cheap.
7. `?perf=1` panel from §5.6.

### Pass/fail

| Criterion | Pass |
|---|---|
| p99 frame time | ≤ 16.6 ms on the actual phone |
| Draw calls | ≤ 60 |
| Max remesh | ≤ 4 ms |
| Founding presses | ≤ 1.5× today's 76 |
| Wall-walk traversal | completes at minimum bore, no penetration, no frame flicker |
| Crosshair precision | highlighted cell is the one the reticle covers at 1 body-length |
| Clod read | a carried piece reads as a pellet, not a grain and not a boulder |

Any scale failing frame time or the wall-walk traversal is out, regardless of
how it looks in a screenshot.

---

## 7. Migration phases

The proposal's Phase 0–10 ordering is sound *for a hex rewrite*. My
recommendation reorders around the insight that three of the four decisions are
lattice-independent, so they can ship on the working game and de-risk everything
after them.

**Phase 0 — instrumentation.** `?perf=1` panel, headless assertions for the §5.6
budgets, recorded baseline on the phone at 5 mm. Rollback: none needed, additive.
*Smallest milestone: a number on screen.*

**Phase 1 — collapse the hierarchy (cube grid, 5 mm).** One press = one cell.
Delete `fracture.ts`, `DigSession.sheets`, `DigScene.chips`, `meshSampler()`.
One cell → one `LooseSoil` record; carry becomes a bundle of records. Adopt the
§4 ownership table and its two invariants. *Deletes ~900 lines. Fixes: "reads as
one large cube breaking apart", "chipping feels artificial", the whole
minted/reclaimed-soil bug class.* Rollback: single revert; the world model is
untouched.

**Phase 2 — scale-parametric cube grid + the §6 test.** Make `VOXEL_MM` real,
scale the physics constants, revalidate the §1.5 invariant at 2/3/4 mm, run the
comparison on the phone. *Fixes: "wants smaller ant-scale soil units",
"excavation area larger than the crosshair point".* Rollback: it is one
constant.

**Phase 3 — meshing for organic tunnels (cube grid, chosen scale).** Per-cell
render jitter with exact logical centres, heavier corner chamfering, irregular
tunnel boundaries, material-driven displacement. *This is the phase that
addresses "tunnels look square and Roblox-like" — the only complaint Phases 1–2
do not.* Rollback: render-only, revert freely.

**Decision gate.** Re-evaluate on the phone and by eye. If tunnels now read as
soil, the hex rewrite is unnecessary and the remaining budget goes to founding,
brood and workers. If they still read as square, continue.

**Phase 4 — hex world core, isolated.** `src/hex/` + `?scene=hex2`. Coordinates,
chunk storage per §5.5, neighbour lookup, exposed-face mesher, deterministic
materials. No player. Rollback: delete a directory.

**Phase 5 — hex targeting.** Three-family analytic DDA (§8), highlight, debug
readout. Reject mesh-BVH raycasting: it needs a BVH rebuild on every dig.

**Phase 6 — hex collision + floor movement.** Circle-in-plane + vertical
interval; pushout against the deepest penetrating lateral plane, capped
iterations. Note this is a change in *character* from today's three independent
axis sweeps — there are no separating axes to iterate — and concave corners can
oscillate.

**Phase 7 — eight-frame SurfaceFrame.** See §8.3. **Prerequisite: the
`rollOffset` accumulator fix must land first.**

**Phase 8 — hex dig + loose soil + carry.** Port Phase 1's ownership model.

**Phase 9 — founding vertical slice on hex, phone profile, side-by-side.**

**Phase 10 — promote or abandon.** Explicit, evidence-based.

Phases 0–3 leave a shippable game at every commit. Phases 4–9 live in a
parallel directory and cannot break it.

---

## 8. Hex technical design (for Phases 4–7, if reached)

### 8.1 Coordinates
```ts
interface HexCell { q: number; r: number; layer: number }
```
Axial `q, r` pointy-top, `layer` along Y. Cube coordinates (`x + y + z = 0`) for
distance and rotation only, converted on demand — do not store three components
where two suffice.

`hexCentre()` in the existing `HexGrid.ts` is correct and reusable.
`HEX_NEIGHBOURS` is correct **and its ordering is load-bearing** — the file
documents that the conventional `[1,0]`-first ordering puts every entry one step
out of phase and culls the wrong faces, producing walls with visible gaps. Carry
that comment forward.

### 8.2 Raycasting — analytic, and it is the same algorithm family
A hex grid's cell boundaries are **three families of parallel lines** (one per
axial direction). Amanatides & Woo generalises directly: maintain `tMax` for the
three in-plane families plus one for the layer boundary, step the minimum of
four instead of the current three. Which family you crossed identifies which of
the six lateral faces was entered, which is exactly what targeting needs.

Cost is the same complexity class as the current cubic DDA. **The proposal's
worry that "cubic DDA cannot be reused unchanged" is true of the code and
misleading about the difficulty** — this is a rewrite of ~130 lines, not a new
research problem. Reject the mesh-triangle-mapping and hybrid options.

### 8.3 Eight-frame SurfaceFrame — workable, with two concrete hazards

Six lateral normals at 0°/60°/…/300°, plus floor and ceiling. Represent as an
integer index 0–7 with a **precomputed basis table**, never as accumulated
rotation. Lateral frames all share world-Y as their in-plane vertical tangent,
which is *simpler* than the cube case where the tangent basis varies per axis.

Hazard 1 — **`isPerpendicular` becomes a lie.** `SurfaceFrame.ts:66` returns
"neither equal nor opposite," and `:228` uses it as the convex/concave
classifier. On cubes those coincide: not-equal-and-not-opposite *is* 90° *is*
convex. On hexes, adjacent lateral walls are **60°** apart and opposite walls
180°, with 120° pairs in between — so the binary becomes a three-way
classification and line 228 silently mislabels shallow corners. This is the
precise place the 90° assumption is baked in.

Hazard 2 — **the `rollOffset` accumulator gets worse.** `DigScene.ts:1994` does
`this.rollOffset += rollBetween(look, from, up)`, which is the barrel-roll bug
already identified. Walking around a hex column crosses **six** corners per
circuit instead of four, so accumulated error grows 1.5× faster per unit
distance. **Fix `reorient()` to transport the look through the hinge rotation
and delete the accumulator before Phase 7, not after.**

Neither hazard makes eight frames unstable. Both are reasons the 415 most
delicate lines in the project would be re-earned for a cosmetic payoff.

### 8.4 The existing hex scene
**Retire it.** `HexGrid` uses `Map<string, number>` as production storage (the
proposal correctly forbids this), `HexScene` has its own controller, targeting
and collision sharing nothing with `DigScene`, and it has no digging, clods or
wall-walking. Its own header says "no route back into the cube world."

Keep three things from it as *reference, not code*: `hexCentre()`,
`hexCorners()`, and the `HEX_NEIGHBOURS` phase-ordering comment plus the winding
test that catches inside-out fans. Preserve them by tagging the commit before
deletion — `git tag hex-prototype-reference` — rather than by keeping 945 lines
of dead scene alive. There is no argument for the other side that survives "the
new architecture should avoid maintaining two independent world models," which is
the proposal's own constraint.

---

## 9. Risk register

| Risk | Sev | Lik | Mitigation | Abandon signal |
|---|---|---|---|---|
| Carry-one-cell makes founding a 100-trip chore (§5.3) | **High** | **High** | Bundles from day one; keep 1500 mm³ queen capacity | — (fix it, don't ship it) |
| Ant no longer fits one cell; wall-walking regresses (§1.5, §6) | **High** | Med | Revalidate traversal at minimum bore in Phase 2, on the cube grid, before any hex work | Traversal fails at 2-cell bore after re-tuning |
| Draw calls ×4.6 from smaller chunks (§5.5) | High | Med | Merge chunk meshes per region; measure in Phase 0 | > 60 draw calls after merging |
| Honeycomb/plank read (§3.3–3.4) | Med | **High** | depth = side length; per-cell jitter; irregular boundaries | Playtesters say "beehive" |
| `isPerpendicular` mislabels 60° corners (§8.3) | Med | High | Three-way classifier + tests per corner class | — |
| `rollOffset` drift worsens (§8.3) | Med | High | Land the `reorient()` fix before Phase 7 | — |
| Concave-corner pushout oscillation (Phase 6) | Med | Med | Deepest-plane-only resolution, ≤3 iterations, hysteresis | Jitter survives capped iteration |
| Two world models coexist indefinitely | **High** | Med | Hard decision gate after Phase 3; `src/hex/` deleted if not promoted | Phase 4+ open >4 weeks with no gate |
| 2 mm chosen on looks, then needs multi-cell digs | High | Low | §5.2 disqualifies it numerically before anyone sees a screenshot | — |

**Abandon the hex rewrite if:** Phase 3 makes tunnels read as soil (then it is
unnecessary); or Phase 6 collision cannot hold ≤0.3 ms/frame with stable
wall-walking; or Phase 7 needs continuous normals to work at all — the discrete
frame model is a *feature*, and losing it costs more than any lattice gains.

---

## 10. Recommendation

**Do not proceed with the hex rewrite yet. Unbundle it.**

The proposal contains four independent decisions:

| Decision | Fixes | Cost | Verdict |
|---|---|---|---|
| 1. One cell = one authoritative unit (drop the 64-piece hierarchy) | "reads as one large cube breaking apart", "chipping feels artificial", the whole duplicate-soil bug class | **−900 lines** | **Do it now.** Phase 1. |
| 2. Bigger loose pieces (1.95 → ~23 mm³) | "chipping feels artificial" | free, falls out of 1 | **Do it now.** |
| 3. Smaller authoritative cell (5 → 3 mm) | "excavation area larger than the crosshair", "wants ant-scale soil units", partly "tunnels look square" | ~10 constants + revalidating §1.5 | **Do it now, measured.** Phase 2. |
| 4. Hex lattice instead of cube | nothing on the complaint list that 1–3 and better meshing do not | rewrite of raycast, collision, SurfaceFrame; new mesher; ~1000 new lines | **Defer behind a gate.** Phase 4+. |

Decisions 1–3 are lattice-independent, cost less than a week, delete more code
than they add, keep the game shippable at every commit, and address **four of the
five** stated problems. The fifth — "tunnels look square and Roblox-like" — is a
*meshing* problem, and the honest reading of §3.3–3.4 is that swapping the
lattice trades a blocky signature for a honeycomb-and-palisade signature rather
than removing signature altogether.

**Is 3 mm a reasonable initial target? Yes — and better supported than the
proposal knows.** It is nearly press-neutral for the founding sequence (1.35×,
§5.2), it makes the loose piece a pellet instead of a grain (§5.4), and it makes
the loose-soil cap easier rather than harder. 2 mm is disqualified numerically
(4.6× the presses, and rescuing it requires the multi-cell digs the proposal
exists to remove). Validate 3 vs 4 mm on the phone.

**What must be proven before the cube world is replaced:**

1. Phase 0 instrumentation is running on the actual phone, with a recorded 5 mm baseline.
2. Phases 1–3 shipped, and tunnels *still* read as square by eye at the chosen scale.
3. Wall-walking revalidated at 3 mm minimum bore on the cube grid — because if the §1.5 invariant cannot be re-established on the *simple* lattice, it will not be re-established on the hard one.
4. Hex Phases 4–7 hit the §5.6 budgets in isolation, at the same scale, on the same device.
5. A side-by-side of the same founding chamber in both worlds, judged on a phone.

Only then does the cube world get deleted.

**On the genre question:** first-person ant + third-person ant + AI nestmates is
coherent, and it is not two games. It is the Subnautica/Grounded shape — you
inhabit one body and the world runs around you — rather than the *Empires of the
Undergrowth* shape, where the camera is the player. Take the marker/order queue
and the tap-to-dig affordance from EotU without taking its camera. Keeping a
playable ant means `SurfaceFrame` stays, which is another reason to protect it
rather than rewrite it for a lattice change.

**Sequencing note:** the `reorient()` / `rollOffset` fix is currently optional
and becomes a prerequisite the moment 60° hinges exist (§8.3). It is worth doing
in Phase 0 either way, since it fixes a bug that exists today.
