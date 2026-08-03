# The Godot build, kept here for reference

This is the ant-and-terrain half of the parallel Godot project, copied in
verbatim. It is **not** built, run or imported by anything in this repo — it is
here so the browser build can be checked against a version of the same systems
that is known to work well, and so the code survives. Two previous copies were
lost before they could be used.

What is here is the game code only. The zip it came from also contained an
editor AI-assistant plugin and an MCP server, several times larger than the
game, and none of it is relevant.

| file | what it is |
|---|---|
| `TERRAIN_LAB_HANDOFF.md` | the design document — read this first |
| `density_terrain.gd` | the signed-density field, Surface Nets mesher, and the spherical subtraction brush |
| `terrain_lab.gd` | the lab scene: reticle digging, the clod, the HUD |
| `procedural_ant_gait.gd` | the two-tripod gait, world-anchored feet, IK |
| `ant_controller.gd` | movement, the surface frame, climbing, adhesion |
| `ant_rig.gd` | reads the anatomy off the skeleton rather than naming bones |
| `ant_caste.gd` | the three castes and everything derived from body length |
| `ant_mode.gd`, `ant_scale.gd` | the mode ring, and the millimetre scale |
| `queen_controller.gd` | the queen's own controller |
| `smoke_test.gd`, `climb_test.gd`, `clearance_audit.gd`, `rig_report.gd` | the headless checks the handoff describes |
| `rig_views.gd`, `climb_views.gd`, `caste_views.gd`, `rig_diagnostic.gd` | rendered and printed inspection |
| `*.tscn` | the scenes, for the node layout and exported values |

## Where the two builds genuinely differ

Worth knowing before copying anything across, because some of it does not
transfer and the handoff says so itself.

**Units agree.** One world unit is 5 mm in both. Godot samples the field every
0.5 units (2.5 mm); this repo samples every 0.1 units (0.5 mm), five times
finer. Anything expressed in cells rather than millimetres changes meaning
between them.

**The sign convention agrees.** Positive is packed soil, negative is air, and
the zero crossing is the surface — the same as `src/voxel/carve.ts`.

**Godot's terrain is a height field closed on six sides.** It builds
`height - y` and then clamps against each face. This repo builds a solid box
and subtracts a nest from it. Both end up watertight; they start from opposite
ends.

**Movement does not transfer, and the handoff is explicit about it.** Godot
uses `move_and_slide()` with `up_direction` tracking the surface, which suits a
smooth density mesh. The browser build's six-axis wall walking rests on the
body being in one of six discrete orientations and never interpolating through
an in-between angle, and a solver that resolves contacts continuously breaks
that invariant.

**Head yaw does not transfer either**, by explicit instruction: Godot caps it at
22 degrees to keep the antennae out of the soil, and this build keeps 60 because
that is what an ant's head movement looks like.

## The dig is already shared, in all three

Worth writing down because it is not obvious and it was nearly ported twice.

`subtract_sphere` in `density_terrain.gd`, `DensityField.subtractSphere` and the
streamed field the colony sim digs are **the same function** — the same
occupancy formula `clamp(0.5 + density / (2 * cellSize), 0, 1)`, the same
per-sample volume, the same `min(old, brushDistance)`. Godot's was ported FROM
here. There is nothing to unify.

The clod is where the three differ, and only in how a removed volume becomes a
drawn radius:

| | formula | for a real bite |
|---|---|---|
| Godot / `?scene=block` | `cbrt(v·3/4π) · 0.72`, clamped 0.08–0.32 | 1.99–2.22 mm across |
| `?map=densityterrainlab` | `cbrt(v/PELLET_SOLIDITY) · 0.5`, cbrt clamped 0.004–0.4 | 1.72–1.92 mm across |

A constant **1.158×** apart across the whole useful range, because both are the
cube root of the volume with a different constant in front. The difference is
entirely that Godot treats the clod as a sphere it is not drawn as, at 72%,
while the colony sim divides by the volume of the icosahedral solid it actually
draws — squash included — and keeps its look adjustment in a separately named
`CLOD_DISPLAY_SCALE` so it cannot be mistaken for geometry.

So the colony sim's is the same idea done more carefully, and replacing it with
Godot's would be a step back. The one real difference is at the top end: the
colony sim's clamp flattens its clod at 2.0 mm across where Godot's keeps
growing to 3.2, so a very large bite reads as smaller there.

Its throw direction is also a measured fix and should not be replaced by
Godot's. Godot throws along the surface normal; the colony sim throws over her
shoulder, because straight back out of the hole points at her own face — the
comment records that clods spawned inside her thorax and flew through her.
