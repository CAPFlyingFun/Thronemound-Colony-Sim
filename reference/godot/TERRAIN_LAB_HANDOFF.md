# Thronemound Godot terrain lab

This is the first bounded Godot port of the browser prototype. It focuses on
the systems that need to agree before broader gameplay work begins:

1. three playable fire ant castes, each with six legs whose planted feet remain
   fixed in world space, and none of whose bones enter the soil;
2. climbing — she walks up a vertical face and mantles over the top; and
3. editable signed-density soil whose render mesh and collision rebuild
   together after a dig.

The implementation was matched against GitHub `main` at commit `1ebcf04`
(`Walk her with anchored tripods instead of a clock`, 2026-07-31). One Godot
world unit is 5 mm, and the density grid uses 0.5-unit (2.5 mm) cells, matching
the browser density-terrain lab.

## Run the lab

Open `project.godot` in Godot 4.7 and press Run Project. The default scene is
`scenes/terrain_lab.tscn`.

- WASD: move
- Shift: run
- Mouse: orbit camera
- F or left click: remove soil at the center reticle, if it is within reach of
  her mandible tips (not just within reach of her body). The reticle only
  picks which nearby surface she means; the bite is then re-anchored to land
  at her mouth, and its depth is fixed by her own mandible length rather than
  the bite radius (see below), so digging always reads as her jaws doing the
  work instead of a spot under the crosshair.
- O: switch caste — queen, major worker, minor worker
- T: show or hide the six procedural foot targets
- R: restore the original terrain and soil accounting
- X or Alt (hold): turn in place — snaps her facing to the camera and makes
  WASD strafe/backpedal relative to it instead of turning her to face travel
  direction. Release and she turns to face wherever she is walking again,
  same as always.
- Mouse wheel, or numpad `*` / `/`: cycle mode — Walking, Digging, Combat,
  Carrying. The mode decides what the same buttons do, so left click bites
  soil in Digging and will bite an enemy in Combat. Combat and Carrying are
  named and selectable but bound to nothing yet: the ring exists so adding
  the verb later costs one entry in `ant_mode.gd` instead of another flag
  threaded through every input branch. Starts in Digging.
- + / -: grow or shrink the current caste's dig bite WIDTH by 0.25 mm, shown
  live in the HUD. Provisional per-caste starting points (queen 1.5 mm,
  major 3.0 mm, minor worker 0.75 mm) live in `terrain_lab.gd`'s `_bite_mm`,
  not yet promoted into `AntCaste` -- feel them out in play first. Bite DEPTH
  is a separate axis and is not user-tunable: it is fixed at twice her own
  `mandible_reach()`, so a shorter-jawed caste always digs shallower than a
  longer-jawed one regardless of how wide the bite radius is set. Below
  about 2.5 mm (the density grid's own cell spacing) a bite reads as a
  shallow dimple rather than a crisp scoop; that is the grid's resolution
  floor, not a bug.
- Escape: release the mouse

She climbs. Walk into anything steeper than about 38 degrees and she rolls onto
it, goes up it vertically, and mantles over the lip at the top.

The upper-left readout shows planted-foot count, worst visible-foot IK error,
mesh size, rebuild time, removed volume, and frame rate. During locomotion,
exactly one tripod may be in the air. At rest all six feet settle onto the
terrain.

## The three castes

`scripts/ant_caste.gd` holds the table. Every export is normalised to 1.7 units
tall in its own space, so the GLB says nothing about how big the animal is —
each caste declares a body length in millimetres and the scale is derived from
that, never the other way round.

| caste | body | stands | walk | mandibles |
|---|---|---|---|---|
| Founding Queen | 9.25 mm | 3.50 mm | 4.5 vox/s | no |
| Major Worker | 5.50 mm | 2.60 mm | 5.2 vox/s | yes, 2 |
| Minor Worker | 3.20 mm | 1.13 mm | 6.0 vox/s | yes, 2 |

`gait_scale` carries that size into every length-dimensioned gait tunable —
stride, foot lift, belly clearance, probe reach. A worker a third of the queen's
size takes a third of her stride. The queen's factor is exactly 1.0, so none of
this changes her.

`AntCaste.get_caste()` also derives the collision capsule and camera distance,
so a worker is framed like a worker rather than filmed from three body-lengths
away. Switching caste rebuilds the ant rather than restocking a live one: the
gait caches the skeleton, the discovered anatomy and six IK chains at `_ready`,
and unpicking that in place is far more fragile than starting clean.

## Reading the rig, not naming it

The three exports do NOT share a bone table. The queen and the worker hang all
six legs off one hub bone; the **major worker hangs each pair off its own
thoracic segment**, has 64 bones to the queen's 53, and numbers everything
differently. Only the queen's import renames her skeleton to `GeneralSkeleton`;
the other two are plain `Skeleton3D`.

So `scripts/ant_rig.gd` reads the anatomy off the skeleton instead:

- **legs** — the six chains whose tips sit lowest AND furthest out to the side.
  Six is the strongest constraint available. The sideways test is what separates
  a foot from the gaster: on the major worker the gaster tip actually hangs
  *lower* than the feet, so height alone picks the wrong chain.
- **gaster** — of the rest, the chain reaching furthest backward.
- **antennae** — of what remains, the two reaching furthest out to the side.
- **mandibles** — the leftovers, near the midline of the head. The queen has
  one fused pair (root and tip, but nothing to hinge against); the worker and
  major have two independent ones each, which is what combat and carrying
  will hang off. `AntRig` exposes both `mandible_roots` and `mandible_tips`;
  `ProceduralAntGait.mouth_position()` averages the tips into a single point
  and is what the dig reach check is measured from (see below), not a guess
  at where her head roughly is.

Front/mid/rear comes from where each leg *joins the body*, not where it lands —
a foot can be planted anywhere, but a coxa is bolted to its segment.

`scripts/rig_report.gd` runs discovery over all three castes and checks the
queen's result against the bone table that was hand-written and verified against
the rendered model before discovery existed. Discovery reproduces it exactly. If
that check ever fails, discovery is what broke.

## Animation design

`scripts/procedural_ant_gait.gd` drives the actual 53-bone queen rig. The two
tripods are:

- A: front-left, middle-right, rear-left
- B: front-right, middle-left, rear-right

A stance foot stores a world-space anchor and therefore does not slide when the
body moves. A swing foot follows a lifted arc toward a terrain-raycast landing
point. The next tripod cannot start until the current tripod has planted.
Stride timing comes from travel distance, not from a free-running animation
clock.

**The GLB's bind pose is already a correct standing ant** — body carried high,
femurs raised, tarsi angled down onto the soil. Every frame therefore calls
`reset_bone_poses()` and asks IK for the *smallest correction* that puts each
claw on the ground under it. Nothing invents a pose from scratch. That is what
keeps the legs in the shape the artist drew, and it is why the solver needs a
generous iteration budget: it gets no warm start from the previous frame.

Each leg is one `CCDIK3D` chain running coxa to claw, ending **on** the claw
bone, because that is the bone the bind pose already rests on the ground. Only
the 0.017-unit terminal marker bones are excluded.

Do not add a second chain to plant the tarsus separately. An earlier build ran
one chain to the ankle plus a one-bone chain to rotate the foot flat onto the
soil; two solvers arguing over the same joint twisted the last segment through
180 degrees and tore the foot visibly off the leg.

Three rules keep a foot honest, in `_plant` and `_hold`:

- Every candidate foothold sits **on** the soil. `max_foot_rise`/`max_foot_drop`
  steer which candidate is chosen; they never clamp a claw to a height the
  terrain does not have, because that buries it in a rise or floats it over a
  dip.
- A vertical probe into a fresh scoop finds a pit floor no leg can reach. The
  contact walks back toward the hip until it finds soil the chain can stand on
  — a real foot feeling for the rim — stopping at 75% so she never plants
  underneath herself.
- At speed the body covers more ground per stride cycle than a leg can span, so
  a planted claw that passes `max_stance_extension` of its chain length **skids**
  toward the hip. A skid is what a real claw does when it loses purchase and at
  5 mm per world unit it is invisible; a leg stretched past its own length is
  not. Without this, peak stance reach hit 1.36x chain length.

Tripod scheduling prefers the tripod whose turn it is, but will step the other
one if it is the urgent one. Strict alternation deadlocks: turning on the spot
swings the hips a long way while the body barely travels, and the stretched leg
can be in the tripod that is not due.

### Head, gaster and feelers

`_animate_base_pose` looks every bone up through `AntRig`, never by name. It
used to hard-code the queen's numbers, which silently animated the **wrong
bones** on the major worker — her head is `Bone_037` and her petiole
`Bone_008`, where the queen's are `Bone_002` and `Bone_006`. It also paired
each antenna's soil measurement with the *other* antenna's bone, so the
damping was crossed the whole time.

- **Head** tracks the camera. Yaw always; pitch only in the modes that use her
  mandibles, because a head permanently tipped at whatever the camera points
  at reads as a bull walking with its head down. Nodding is what lets her
  reach soil *below* her rather than only straight ahead — her mouth sits
  0.7–1.7 mm clear of flat ground depending on caste, so without it she can
  only bite what is level with her face.
- **Gaster** counter-rotates against the head's yaw at 30%. An ant swinging her
  head to look at something balances it with her abdomen. Matching it outright
  reads as folding in half.
- **Feelers gate the head.** A buried antenna scales the whole head aim back,
  integrating (not proportional — see the trap below). The antennae hang off
  the head, so nothing else reaches them: the existing damping folds a feeler
  toward its *bind* pose, and once the head has turned that bind pose is
  already underground. Countering on the antenna bone does not work either,
  because its rotation axes do not line up with the head's — measured, not
  assumed. Backing the head off is also what a real ant does; the feelers find
  the ground before her face does.

Head yaw is capped at 22 degrees, and that cap is load-bearing rather than
cosmetic. Measured on flat soil, **yaw is what buries a feeler** — swinging the
head sideways sweeps an antenna down into the soil beside her, where nodding
mostly moves them fore-and-aft. At 42 degrees the queen's antenna tips were
buried on 14% of samples; at 22 with the gate, whole-skeleton clipping is
0.090%, better than the 0.121% measured before head tracking existed.

## Climbing

An ant does not care which way is down. `AntController` rotates the body node so
its own **+Y is the surface normal**, and everything else — camera, model
carriage, foot IK, the whole gait — keeps working unchanged in that frame. On
flat soil local +Y is world up and the arithmetic is exactly what it was before
climbing existed. `soil_clearance` and `_height` measure along her up axis, not
world Y, which is why the same clearance checks mean the same thing on a wall.

Gravity becomes **adhesion**: while she is on a surface it pulls along her own
-Y, so on a wall it holds her against the wall instead of dragging her off it.
Only when nothing is within reach of her feet does she fall, and falling is the
one thing that happens in world space rather than hers.

Mounting a wall is a **decision, not a blend**. An earlier version averaged a
forward feeler in with the five ground probes; the ground always outvoted it and
she leaned 12 degrees against the wall and stood there pushing. Now a face
ahead that is more than `mount_angle_deg` steeper than her current footing, and
that she is actually walking into, wins outright.

Cresting the lip is the mirror problem and **nothing that casts along -up can
see it** — past the edge there is no wall left, so she runs off the top still
pointing skyward. The crest probe reaches past the edge and casts back along her
own forward, which after the corner is "down" onto whatever she is about to
stand on. It has to be inset toward the surface: `eye` stands clear of the face,
and at a square edge the top begins exactly at that face, so a ray dropped from
eye height falls past the lip and touches nothing.

This is the smooth-surface cousin of the browser build's `SurfaceFrame`, not a
port of it. The browser model rests on every surface being an axis-aligned cube
face and the body being in one of six discrete orientations; a density mesh has
neither property, so the frame here is continuous. Keep that distinction in mind
when the voxel world lands — the six-axis model is still the right one there.

## Feel

Speed was already ramped through `WALK_ACCEL`/`WALK_DECEL`, but that alone still
snaps the *direction*: tap A while holding W and the velocity vector jumps 45
degrees in a single frame, which at ant scale reads as teleporting sideways. So
`_heading` eases toward the input at `heading_rate` and the body follows the
heading rather than the raw keys — she carves the corner, and the six planted
feet get a heading that changes at a rate their anchors can follow.

The camera rig eases toward the mouse at `camera_rate` for the same reason: the
body is simultaneously rolling to fit the ground under it, and a camera bolted
rigidly to a rolling body reads as jitter.

## Body carriage

`_apply_model_pose` is the other half of grounding a multi-legged creature.

Pitch and roll turn about the **mesosoma** (`tilt_pivot_height`), not about the
sole plane. Tilting about the feet is what swings the gaster underground on a
slope — with the gaster 0.9 units behind the pivot, a 0.3 rad lean buries it.

She is also lifted whenever soil under her body footprint would otherwise pass
through her lowest plate (`belly_height`). The capsule that carries her is a
fraction of her width, so without the lift the terrain beside the capsule simply
intersects the gaster.

Useful tuning values are at the top of `procedural_ant_gait.gd`: step trigger,
swing height and time, sole clearance, foot offset and vertical slack, the two
stance-extension fractions, belly height, tilt pivot and tilt limit. Keep the
world-anchored stance rule and the one-tripod-at-a-time rule intact while
tuning the style.

## Inspecting her

```powershell
& 'D:\Program Files (x86)\Godot Engine\Godot_v4.7-stable_win64_console.exe' --path . --script res://scripts/rig_views.gd
& 'D:\Program Files (x86)\Godot Engine\Godot_v4.7-stable_win64_console.exe' --path . --script res://scripts/rig_views.gd -- walk
```

Writes `_view_side/front/top/low/game.png` at rest, or mid-stride with `walk`.
`scripts/rig_diagnostic.gd` prints the bone chains and the IK settings built
from them.

## Terrain and digging design

`scripts/density_terrain.gd` stores a scalar field: positive values are packed
soil, negative values are air, and the zero crossing is rendered by a Surface
Nets mesh. The field is closed on all six outer sides so the initial terrain is
a watertight solid rather than an open height sheet.

Digging applies signed-distance subtraction with a spherical brush. The mesh
and concave collision shape are rebuilt from the same edited field in one
operation. Removed soil is estimated from the change in sample occupancy;
`scripts/terrain_lab.gd` creates one short-lived clod whose size comes from that
same volume. Terrain edits then invalidate and replant the six foot anchors.

The current grid is intentionally small (24 x 10 x 24 cells) so a complete
rebuild is simple and easy to inspect. The next terrain stage should split the
field into dirty chunks and rebuild only affected chunks. Do that before
expanding world size or adding persistent loose-soil particles.

## Automated confidence checks

All headless, all from the project directory. `-- worker` or `-- major` after a
bare `--` runs the caste checks against that caste instead of the queen.

```powershell
$godot = 'D:\Program Files (x86)\Godot Engine\Godot_v4.7-stable_win64_console.exe'
& $godot --headless --path . --script res://scripts/smoke_test.gd
& $godot --headless --path . --script res://scripts/climb_test.gd
& $godot --headless --path . --script res://scripts/clearance_audit.gd
& $godot --headless --path . --script res://scripts/rig_report.gd
```

| check | what it asserts |
|---|---|
| `smoke_test` | tripod discipline, six feet settled, planted error under 0.25 mm, terrain rebuild under 300 ms, reticle dig produces one volume-matched clod, head holds the authored pose in Walking and actually tracks in Digging |
| `climb_test` | reaches vertical, gains real height, crests onto the top, does not clip the wall |
| `clearance_audit` | every bone in the rig against the soil, ranked by offender; fails past 0.5% |
| `rig_report` | anatomy discovery on all three castes, checked against the queen's hand-verified table |

Rendered views, which need a display:

```powershell
& $godot --path . --script res://scripts/rig_views.gd          # add -- walk
& $godot --path . --script res://scripts/climb_views.gd
& $godot --path . --script res://scripts/caste_views.gd
```

### The trap these all avoid

**Every skeleton read happens inside `modification_processed`.** Reading bone
poses after `physics_frame` catches the pose *after* `_animate_base_pose` has
reset it to bind and *before* the solver has run, so it reports the bind pose no
matter what the gait is doing. Two separate investigations were derailed by
exactly that: measurements came back byte-identical across substantive logic
changes, which is the signature to watch for.

The claw is the soil contact; the ankle above it is not. Do not reinstate a
check that both must touch — demanding it is what forced the tarsus flat and
tore the foot off the leg.

`soil_clearance` measures along her up axis. In the concave crease where floor
meets wall that axis points along the wall, so a claw resting correctly on the
floor can read as buried. Treat the climb test's transition figure as an upper
bound, not a literal count of visible intersections.

## Where it still falls short

`clearance_audit` over a full walk of the mound, all bones, every caste:

| caste | bone samples in soil | worst |
|---|---|---|
| Founding Queen | 0.11% | 0.67 mm |
| Minor Worker | 0.36% | ~0.4 mm |

The worker is three times worse, and that is structural rather than a bug worth
chasing: the density grid samples every 2.5 mm no matter who is standing on it,
so a 1.13 mm ant crosses exactly the bumps a 3.5 mm queen steps over. All of the
remaining offenders are ankles and tarsi on the front legs. Finer terrain would
fix it; tuning the gait further will not.

The concave crease where a floor meets a wall is the other weak spot, at about
1.3% during the transition. Part of that is a measurement artefact (see the note
on `soil_clearance` above) and part is real — six legs in a corner is genuinely
the hardest case for this kind of grounding.

## Four traps worth knowing about

All four cost real time to find, and all four look like something else.

**Reading the skeleton at the wrong moment.** Every skeleton read has to happen
inside `modification_processed`. Reading after `physics_frame` catches the pose
*after* `_animate_base_pose` has reset it to bind and *before* the solver has
run, so it reports the bind pose whatever the gait is doing. The tell is
measurements coming back byte-identical across substantive logic changes.

**Deferred frees still occupy the world.** `_spawn_ant` calls `remove_child`
before `queue_free`. Freeing alone is deferred, so the outgoing ant keeps the
node name *and* keeps her collider standing exactly where the newcomer is about
to appear. The queen survives being shoved — she is wide enough that her capsule
still overlaps the surface — but a minor worker ends up entirely inside the
mound, and a concave collision shape has no interior to push out of, so she
falls through the world. Same reason her spawn position is set before she enters
the tree rather than after.

**A proportional correction cannot clear a contact it also causes.** Both the
per-leg clearance bias and the head-aim gate accumulate rather than scaling the
current error. The failure is a stable equilibrium, not an oscillation: less
nod lifts the feeler, lifting the feeler restores the nod, and it settles at a
fixed fraction of the burial forever. The tell is a correction that visibly
*engages* — the numbers move — but leaves the metric almost unchanged. Both
also need a deadband on the way back, or they release the instant the bone
clears and bury it again on the very next frame.

**Two owners for one deferred free.** The dig sound used to have both a
`finished` signal and a length-based fallback timer wired to free the same
player. Whichever fired first freed it out from under the other's lambda, and
Godot rejects a lambda whose captured reference has been freed *before running
the body* — so an `is_instance_valid()` guard inside never gets the chance to
help. That produced hundreds of `Lambda capture at index 0 was freed` errors.
One timer owns the cleanup now. The same session also produced clods flying
like rockets, which was unrelated and worth stating separately: the impulse was
a flat vector while `clod.mass` floors at 0.02, so the small mandible-depth
bites introduced later were getting a full-size shove into a much lighter body.
It applies a velocity times mass now.

## Deliberately deferred

- Ceiling traversal and the browser build's discrete six-axis surface frame
- Chunk streaming and save/load for edited density fields
- Persistent loose grains and exact one-to-many clod breakup
- **Mandible animation.** Nothing opens or closes them -- she always bites
  from the bind pose, and the reticle dig only borrows their geometry:
  `ProceduralAntGait.mandible_reach()` (root-to-tip, averaged across however
  many she has) sets how deep a bite sinks in, doubled, independent of the
  bite radius (see the controls section). Measured against a hand-posed
  55-degree gape rather than the bind pose, the tip itself only travels
  0.08-0.44 mm across the worker castes -- too small to matter for reach, but
  it would matter for an actual open/close animation, which is where combat
  and carrying still attach.
- Authored body-layer animation. There are still zero animation clips in every
  GLB; all motion is procedural.
- Antenna collision sensing (they currently fold away from soil, they do not
  report what they touched)
- Walking DOWN a face she reaches by stepping off an edge. Mounting and cresting
  work; stepping off a lip drops her.

Ground walking uses `move_and_slide()` with `up_direction` tracking the surface.
That is the right tool for a smooth density mesh. It is NOT the right tool for
the voxel world: the browser build's movement is an axis-separated sweep of an
axis-aligned box against the grid, and its six-axis wall walking rests on the
body being in one of six discrete orientations and never interpolating through
an in-between angle. A solver that resolves contacts continuously breaks that
invariant. Port `collides()`/`tryAxis()`/`moveOnSurface()` and drive the body
directly when the voxel world lands; keep the continuous frame here for the
density lab.

Likewise `LooseSoil` is a custom particle sim with a sleep model sized for 768
grains. Do not replace it with `RigidBody3D`.
