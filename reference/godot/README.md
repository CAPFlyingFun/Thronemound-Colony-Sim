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
