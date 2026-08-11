/**
 * KAUAI FOR ANTS — `?scene=island`. Beyond Extinction's island, 1:1000,
 * now wearing BE's real biome textures and carrying the DIGGABLE SOIL
 * WINDOW with a pre-authored nest under the summit spawn.
 *
 * The island itself stays the anti-hole design the last round proved: all
 * 64 sections built once from the baked grid, never hidden, faded or
 * swapped; normals from central differences (no section seams); the walker
 * grounded on the DRAWN triangles (BE's own rule). On top of that, three
 * additions this round:
 *
 *  TEXTURES — BE's seven-band biome shader, ported verbatim in
 *  islandBiome.ts. The same material paints the soil chunks: tunnel walls
 *  are steep so the slope term dresses them as cliff rock for free, and
 *  their tops share the island's elevation bands, so the fine window is
 *  not a visible patch.
 *
 *  THE SOIL WINDOW — IslandStream: the streamed-world architecture with a
 *  floating 256 mm depth band riding under the local surface. Inside the
 *  window's rectangle the island sheet discards (the world room's hand-off)
 *  and the density mesh is the only ground — so the nest's entrance and any
 *  bite are simply visible. The clip NEVER outruns the meshes: it shrinks
 *  to retained soil on every scroll and only widens back when the rebuild
 *  queue drains. Nothing can hole.
 *
 *  THE PRE-TUNNEL — islandSoil folds a gate/hall/bend/store nest into the
 *  soil function at the spawn, mound stamped into the island grid so the
 *  anthill shows from afar, vent bored through it so the entrance is a real
 *  hole underfoot. Streaming away and back rebuilds it from zero saved
 *  samples, exactly as the world room proved.
 */

import * as THREE from 'three';

import './DensityTerrainLabScene.css';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import {
  FOOT_CLEARANCE_MM, LegDrive, type DriveReport, type Ground, type LegSetup,
} from '../anim/legDrive';
import { CASTE_LENGTH_MM, VOXEL_MM, stanceRadius } from '../anim/hexapod';
import { TELEMETRY_MAX_SECONDS, TelemetryRecorder } from './IslandTelemetry';
import { buildNestView, type NestView } from '../nest/nestView';
import { NestDesigner } from '../nest/NestDesigner';
import { planBounds } from '../nest/nestCarve';
import { addNode } from '../nest/nestEdit';
import { type NestPlan } from '../nest/nestPlan';
import { chamberBox, chamberNorm, type ChamberBox } from './ChamberMovement';
import { BoreRig, YAW_RATE } from './BoreControl';
import { Dodge, readFlick } from './dodge';
import {
  CLEARANCE_MM, posture, PROBES, Spine, type SpinePose, type SpineReading,
} from '../anim/spine';
import { DebugStatsPanel } from './DebugStatsPanel';
import { LoadingOverlay } from './LoadingOverlay';
import { SENSE_EASE, makeSensed, type SenseUniforms } from './undergroundSense';
import { IslandStream, type IslandScrollReport } from '../world/IslandStream';
import { SurfaceWalker } from '../world/surfaceWalk';
import {
  BARKS, PBR_BARKS, TILING_BARKS, bakeTree, buildTree, sidesAt, trunkProfile,
  type BuiltTree, type TreeSpec,
  type TrunkProfile,
} from '../world/tree';
import {
  burialMm, plantsIn, solidStand, SPECIES, type ForestSolid, type Species,
} from '../world/forest';
import { makeIslandSoil, type IslandSoil } from '../world/islandSoil';
import {
  loadBiomeTextures, makeBiomeMaterial, type BiomeTextureSet,
} from '../world/islandBiome';
import {
  CAP_PLANES, CELLS_Y, CELL_SIZE, MM, SAMPLES_Y, TILE_CELLS, WINDOW_CELLS,
  WINDOW_MM, WINDOW_BYTES,
} from '../world/worldScape';
import { guardContext } from '../render/contextGuard';
import { markLoaded } from '../pwa';

/** The island: 56 km of Kauai at 1:1000. Real metres ARE in-world mm. */
const SPAN_MM = 56000;

/** The baked grid: 1025² int16 decimetres (see scripts/bakeKauai.py). */
const N = 1025;
const STEP_MM = SPAN_MM / (N - 1);

/** The rendered grid: every second sample — 513², 64 sections of 65². */
const MESH_N = 513;
const SECTIONS = 8;
const SEC_VERTS = (MESH_N - 1) / SECTIONS + 1;

/** 15 mm/s — an unhurried queen. The first cut copied the world room's
 *  40 mm/s sprint and the island blurred past; playtest said so. Shift (or
 *  full stick) sprints at three times that for covering ground. */
/*
 * HALVED, and the gait halves with it.
 *
 * The legs cycle at a rate proportional to how fast she travels, so there
 * is no separate animation speed to turn down — slowing the animation by
 * half means slowing HER by half, which is the only way to do it with her
 * feet still landing where they touch. Three world units a second was 15
 * mm/s walking and 45 sprinting, near double the block room's pace on an
 * animal a third the size of its stride.
 */
const WALK_SPEED = 1.5;
const SPRINT = 3;
/*
 * HOW FAST SHE TURNS, ALL IN — and until now there was no such number.
 *
 * The stick was integrated TWICE: `BoreControl` swings the heading at its
 * own `YAW_RATE` of 1.5 rad/s and the island rotates her nose by that
 * change, and then `LegDrive` was handed the same stick and spun her again
 * at 2.4. Measured: 223 degrees a second out of a control that was set to
 * ask for 137. That is the turn feeling twitchy, and no amount of tuning
 * either constant alone could have found it.
 *
 * One owner now — the rig — and one number here, which is what the rig is
 * scaled to deliver. 2.53 rad/s is 145 deg/s: 35% below the 223 that was
 * actually happening, which is what was asked for.
 */
const TURN_RATE = 2.53;

/**
 * THE CAMERA MOVES THE CAMERA. It used to move HER.
 *
 * A pan was read as a side step every frame — `strafe = -lookYaw * gain` —
 * which meant you could not look at anything without travelling toward it,
 * and letting go left her gliding while the view swung home. It went
 * through three rounds of gating (idle stick, finger down) and each one made
 * it less wrong without making it right, because the premise was wrong:
 * looking is not moving.
 *
 * A deliberate GESTURE moves her instead — see `dodge.ts`. Nothing here
 * reads `lookYaw` for movement any more.
 */

/**
 * THE AIR UNDER HER FEET — a floor, not a fudge.
 *
 * She used to ride a calibrated 1.4 mm above the wood's collision because
 * the collision was the limb's CIRCLE while the mesh was a polygon tangent
 * to it: the drawn bark stood proud by up to a facet's sagitta, 7 mm at the
 * landmark's foot, and she seated on the circle. A lift tuned to the
 * average could only ever be right on average, which is why she was still
 * half in the trunk from some angles.
 *
 * The collision is now built at the DRAWN ring radius and the near level is
 * tessellated finely enough that the ring is barely wider than the wood, so
 * there is nothing left to calibrate. This is only the last hundredth: the
 * ring MITRE where two sections meet at a bend still puts the drawn skin up
 * to 0.035 mm outside the collision, and a floor under that is not a floor.
 *
 * IT IS DELIBERATELY SMALL, and raising it does not buy what it looks like
 * it would. Measured on soil, where a rear claw reads about 0.15 mm under
 * the drawn hillside: 0.05 mm of floor gave -0.19, 0.25 gave -0.12, and
 * 0.60 gave -0.09 while pushing a swing foot to 1.96 mm of daylight. That
 * residual is not seating — it is the terrain's MESHER and the density
 * field it is built from disagreeing by about that much, so the anchor the
 * leg reaches for is not quite on the triangle that gets drawn. Lifting her
 * body cannot close it; referencing the leg anchors to the drawn mesh
 * would, and that is a different job.
 */
const FOOT_AIR = 0.05 / MM;

/**
 * THE STICK'S RESPONSE, which is not the same thing as her top speed.
 *
 * The throw is 48 px — about half an inch of thumb — and the reading was
 * LINEAR past a 12% dead zone, so a quarter of that throw was already a
 * quarter of full pelt. Measured: 12 px out ran her at 1.87 mm/s, which is
 * a fifth of her body length every second from the smallest deliberate
 * nudge a thumb can make. Fine positioning — lining a dig up, stepping onto
 * a trunk — was all in the first few pixels.
 *
 * Squaring the deflection past the dead zone spends the throw where it is
 * wanted: the bottom half of the stick gets a quarter of the speed it used
 * to, the top of the stick is untouched, and the curve is smooth so there
 * is no step to feel. Keys are unaffected — a key is already all or
 * nothing, and squaring one is squaring one.
 */
function stickCurve(raw: number): number {
  const size = Math.abs(raw);
  if (size < 0.12) return 0;
  /* Re-based off the dead zone, so the first pixel PAST it is a crawl and
   * not a jump to 12% — a dead zone that does not rebase is a step. */
  const t = Math.min(1, (size - 0.12) / (1 - 0.12));
  return Math.sign(raw) * t * t;
}
const RIDE = 1.3 / MM;

/* Scratch space for the per-frame hot paths (rail, pose, camera) —
 * allocated once and reused, so a minute of riding feeds the garbage
 * collector nothing (the GC pauses read as hitches on the playtest PC). */
const S_PERP = new THREE.Vector3();
const S_RAD = new THREE.Vector3();
const S_CENTER = new THREE.Vector3();
/** Head-clearance and bone-follow scratches — theirs alone, read across
 *  frames of the pose and never shared with the S_ pool. */
const HEAD_PROBE_AT = new THREE.Vector3();
const HEAD_PROBE_DIR = new THREE.Vector3();
const HEAD_PROBE_RIGHT = new THREE.Vector3();
const BONE_FWD = new THREE.Vector3();

/** The first-person lens's roll axis. Its OWN scratch: it is read after
 *  `S_UP` has been filled with her surface normal in the same block, and
 *  sharing one would have quietly clobbered the other. */
const S_ROLL = new THREE.Vector3();
const S_TARGET = new THREE.Vector3();
/** The ghost's own, so it cannot be trampled by whatever the cameras are
 *  doing with the shared scratch in the same frame. */
const S_SPOT = new THREE.Vector3();
const S_LEAN = new THREE.Vector3();

/**
 * The LEAST fold the tail believes while the rear feet are still crossing a
 * corner — about 23 degrees of lift at the sting once staggered through
 * `posture`. Enough, measured, to carry the gaster over the crease sweep it
 * was sitting down into; released the frame the corner completes, and the
 * gaster's own slow follow rate turns that release into a settle.
 */
const TAIL_HOLD_RAD = 1.5;

/**
 * The first-person lens's own flinch: how much camera-only up-tilt the view
 * gains as her head's measured clearance closes from `SOFT` to `HARD`
 * millimetres, and how fast the tilt eases in and out. Five degrees was the
 * player's own estimate from the device, and it reads right: enough to lift
 * the terrain off the bottom third of the frame, small enough that the
 * horizon never visibly tips. See its use where the view pitch is built.
 */
const FPV_LIFT_RAD = (5 * Math.PI) / 180;
const FPV_LIFT_SOFT_MM = 2.5;
const FPV_LIFT_HARD_MM = 0.5;
const FPV_LIFT_RATE = 6;

/** The orbit arm's own, so it can be asked to write into any of the others
 *  without quietly aliasing its working vector. */
const S_NOSE = new THREE.Vector3();

/**
 * The chase camera's fan, in radians off where it would like to be.
 *
 * Swing is across her, rise is over her. Wide enough to find its way round
 * a trunk (a metre of it, from a hand's breadth away, is most of the sky),
 * and biased upward because the one direction that is nearly always open is
 * off her own back.
 */
const FAN_SWING = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35] as const;
const FAN_RISE = [0, 0.4, 0.8, -0.3] as const;

/** A ray that got less than this found no room worth having. */
const CHASE_MIN = 4 / MM;

/** What is behind an unbuilt chunk once she is under the ground: packed
 *  earth in shadow, rather than the void. */
const SOIL_DARK = new THREE.Color(0x140f0a);

/**
 * THE TREE. Three feet through and eighty feet up, in the game's own
 * millimetres — a metre of girth and twenty-six of height.
 *
 * It is planted a hand's breadth from where she starts (700 mm, far enough
 * to see the whole thing lean away overhead and near enough to walk to),
 * and its foot is sunk a hundred millimetres INTO the ground. That burial
 * is not decoration: the island's drawn surface is a 109 mm mesh and the
 * fine soil window redraws the ground underneath it as she moves, so a tree
 * seated exactly on the surface would be left hanging in the air the moment
 * the ground beneath it resolved to something lower. Sunk deep enough to
 * swallow that difference, the base stays buried whatever the terrain does.
 */
const TREE_GIRTH_MM = 1000;
const TREE_HEIGHT_MM = 26000;
const TREE_FROM_HER_MM = 700;
const TREE_BURIED_MM = 100;

/**
 * How far around her the small tiers are grown, in millimetres.
 *
 * The landmarks and the canopy are few enough to plant over the whole
 * island at once — a hundred and forty of them. Saplings and bushes run to
 * thousands, and thousands of anything is worth generating only where she
 * can see it. Twelve metres is far enough that the edge of the window is
 * past anything she can make out at her size, and near enough that the
 * regrow costs a few milliseconds.
 */
const SCRUB_WINDOW_MM = 9000;

/** She has to walk this far before the scrub is grown again. */
const SCRUB_REGROW_MM = 3000;

/** How far out plants are SOLID — comfortably past the regrow distance, so
 *  she can never outrun her own collision between rebuilds. */
const STAND_REACH_MM = 5000;
const S_FWD = new THREE.Vector3();
const S_UP = new THREE.Vector3();
const S_RIGHT = new THREE.Vector3();
const S_MAT = new THREE.Matrix4();

/*
 * A ledge she may step up, and the rate she scaled a wall at, both gone.
 * They were the heightfield walker's whole theory of vertical: a wall was a
 * thing to refuse and then creep up by a special case. She stands ON walls
 * now, so there is nothing left for either number to decide.
 */

/** How far below the drawn island counts as "underground" for the camera. */
const UNDER_MM = 5;

/** Soil mesh chunks: the slide tile IS the chunk, the world room's trick. */
const CH = TILE_CELLS;
const CHUNKS_XZ = WINDOW_CELLS / CH;
const CHUNKS_Y = CELLS_Y / CH;
const MESH_BUDGET = 3;

/** Recentre lead and thrash guards, straight from the world room. */
const LEAD_S = 0.45;
const LEAD_MAX = 24 / MM;
/* Longer than one scroll's own measured cost, so two can never overlap. */
const SCROLL_COOLDOWN_MS = 600;

/**
 * THE SHOVEL 🪏 — dig mode's mouthful, sized for making progress.
 *
 * 6 mm wide, 6 mm tall, 9 mm deep per stroke: a bore she can walk straight
 * into, not a mandible-true nibble. The 1.75 mm bite was honest and it also
 * took all day, and a passage barely her own width made walking a squeeze —
 * so dig mode trades the biology for a tunnel that opens at playable speed
 * with clearance to move in. Cut as three 3 mm-radius spheres stepped along
 * the aim, because spheres are what the field subtracts.
 */
/**
 * ONE MOUTHFUL, as asked: 10 mm wide, 5 mm tall, 3 mm deep.
 *
 * Wide and low, which is what a walking tunnel wants — a floor broader
 * than her stride and a roof just clear of her back.
 */
const SCOOP_WIDE_MM = 10;
const SCOOP_TALL_MM = 5;
const SCOOP_DEEP_MM = 3;

/**
 * How hard each stroke's own hole is relaxed afterwards, and how often.
 *
 * Halfway to the neighbourhood mean, twice — one gentle pass took the
 * worst off the ridge between two overlapping scoops and still left
 * enough to catch a foot on. Two passes at a half is roughly a wider
 * kernel without the cost of actually widening one.
 */
const SMOOTH_STRENGTH = 0.5;
const SMOOTH_PASSES = 2;

/**
 * The smoothing brush's reach, in mm.
 *
 * This used to be a slider running four to thirty, defaulting to ten.
 * Played, thirty was better everywhere — so it is thirty, and the slider
 * that only ever wanted pushing to its end is gone.
 */
const SMOOTH_RADIUS_MM = 30;

/**
 * The most any one sample may move per pass, in field units.
 *
 * A blur cannot tell the tunnel's air from the sky's, so a slab of soil
 * between the two averages with the OUTSIDE and thins — near the surface
 * it thinned right through, and the roof came down. A third of a cell
 * still relaxes the shallow ridges a foot catches on, and refuses the
 * large correction that a one-sample roof would need to collapse.
 */
const SMOOTH_MAX_SHIFT = CELL_SIZE / 3;

/**
 * How far OUTSIDE the cut the relaxation reaches, in samples.
 *
 * The ridge that matters is not inside this stroke's hole — it is the
 * seam where this stroke meets the last one, which by definition lies on
 * the boundary of the box the brush just touched. Smoothing only what was
 * cut leaves exactly the join that trips her.
 */
const SMOOTH_GROW = 2;

/** How much soil the lens keeps off itself, so the eye never sits in a
 *  wall — the near plane is tiny, but a camera INSIDE soil renders the
 *  whole world inside-out. */
const EYE_SKIN = 0.5 / MM;

/**
 * How far clear of the dirt every drawn bone is kept, and the step the
 * guard searches in. Small on purpose: this is a fail-safe for the parts
 * no solver owns, and a big lift would carry six correctly planted feet
 * off the ground with it.
 */
const BONE_CLEARANCE = 0.02 / MM;

/**
 * How far above the ground the camera is never allowed below.
 *
 * The asked-for number is 0.05 mm; the near plane is 0.1 mm, so a
 * clearance under that still lets the ground poke through the lens. The
 * floor is whichever is larger, which honours the intent — the camera is
 * never under the dirt — and actually shows nothing through it.
 */
const CAMERA_SKIN = Math.max(0.05 / MM, 0.02 * 1.5);

/** How far forward of her centre the eye rides, along the AIM. */
const EYE_FORWARD = 1.3 / MM;

/**
 * How far ABOVE her centre the eye rides, along her own up.
 *
 * There was no rise at all: the lens sat on her centre-line, which is the
 * middle of her thorax, and the view read as low and close to the floor
 * ("a little taller"). Her head is the top of her, so the eye goes there.
 */
const EYE_RISE = 1.1 / MM;

/**
 * HOW THE FIRST-PERSON LENS FOLLOWS HER HEAD.
 *
 * Rates in hertz, turned into an exponential rate below. Position follows
 * faster than roll because a lag in WHERE the lens is reads as swimming,
 * while a lag in which way is up reads as nothing at all — the surface
 * normal only changes when she crosses onto something new.
 *
 * These filter LOCOMOTION only. The look direction is taken straight off
 * the aim and never smoothed, so turning has no lag whatever these are set
 * to. That split is deliberate: filter the body, never the intent.
 */
/*
 * MEASURED, then set. The first pass used 15 and 10 "hertz" turned into
 * exponential rates by 2*pi, and at 60 fps that is 79% of the way to the
 * target every frame — very nearly a pass-through. It cut the lens's own
 * jitter from 0.099 mm to 0.081, which is 18%, and the player still saw
 * shake.
 *
 * Time constants in MILLISECONDS instead, because that is the number this
 * can be reasoned about in: at 60 fps a 45 ms constant moves 31% a frame
 * and a 70 ms one 21%. Slow enough to eat lattice noise, far too fast to
 * feel as lag on something the size of a head.
 */
const EYE_FOLLOW_MS = 45;
const EYE_AIM_MS = 70;
const EYE_FOLLOW_RATE = 1000 / EYE_FOLLOW_MS;
const EYE_ROLL_RATE = 1000 / EYE_AIM_MS;

/**
 * Past this, the lens SNAPS instead of chasing.
 *
 * A filter is for noise. A respawn, a rail grab or an embed rescue moves
 * her metres in a frame, and easing across that would fly the camera
 * through the island. Three millimetres is a third of her body — far more
 * than any step, far less than any teleport.
 */
const EYE_SNAP = 3 / MM;

/**
 * How finely the eye's retreat from a wall is resolved.
 *
 * Ten halvings of `EYE_FORWARD` is about a thousandth of it, which is well
 * under anything visible. The number that mattered was that it is a
 * BISECTION at all: the five fixed steps it replaced were the shake.
 */
const EYE_BISECTIONS = 10;
/*
 * The march that keeps the eye on HER side of every wall: EYE_FORWARD is
 * 1.3 mm, so eight steps test roughly every 0.16 mm — finer than any crust
 * the surface nets can build, so a wall cannot fit between two samples.
 */
const EYE_MARCH_STEPS = 8;

/**
 * THE PAN COMES HOME.
 *
 * A swipe moves the view off neutral and, three seconds after the finger
 * lifts, it eases back — behind her in third person, along her nose in
 * first. The hold is what makes it usable rather than fidgety: long enough
 * to look at something, short enough that you never have to put the camera
 * away by hand.
 *
 * Held indefinitely while DIGGING, because there the look is the aim and an
 * aim that drifts home on its own is a shovel that will not stay pointed.
 */
const LOOK_HOLD_S = 3;
const LOOK_RETURN_RATE = 2.4;

/**
 * Where the chase arm sits when nothing is asking otherwise: a little above
 * her, directly off her tail. It used to be `0.28 - aimPitch`, which is why
 * the third-person view could not be brought behind her — see `orbitBack`.
 */
const CHASE_PITCH = 0.28;
/*
 * The FULL dial again: down past her flank to nearly under her, up to
 * nearly overhead. The 0.06 floor was the reported limiter — the orbit
 * could never drop below a polite hover, so "swing around and look UP at
 * her on the trunk" was unreachable. What keeps the lens out of the dirt
 * is not this clamp; it is the ground ride below (`chaseCamera`) and
 * `liftCameraClear`, which are made for exactly that job.
 */
const CHASE_PITCH_MIN = -1.35;
const CHASE_PITCH_MAX = 1.35;

/** Third person never sits closer to the ground than this, in wu — the
 *  classic chase-camera floor: when terrain rises into the shot, the lens
 *  rides a fixed height over it and slides in toward her instead. */
const CHASE_GROUND_CLEAR = 1.6;

/** The arm lengths the chase tries, longest first — full distance unless
 *  a ridge blocks the sight line, then progressively closer to her. */
const CHASE_REACH = [1, 0.75, 0.55, 0.4, 0.25, 0.14] as const;

/**
 * How far a shell clearance probe looks before calling it clear.
 *
 * A body length. Past that the answer cannot matter to a body this size,
 * and the march is the only per-frame cost the spine's proximity half has.
 */
const SHELL_REACH = 2;

/** How much of a segment's widest radius actually hangs below it. See
 *  `shellClearance` for the measurement this comes from. */
const SHELL_SHARE = 0.5;

/** How fast the terrain rises are low-passed, per second. Slow enough to
 *  swallow a lattice step, fast enough to meet a real slope. */
const RISE_RATE = 9;

/** How far past her centre the jaws reach when the model has not loaded. */
const NOSE_REACH = 4.5 / MM;

/**
 * Her half-WIDTH in a bore. The measured oval's 4.4 mm half-width is her
 * LEG SPAN — wider than the whole 6 mm tube — but an ant in a tunnel walks
 * with her feet ON the wall, legs flexed to its curve, not sticking out to
 * her open-ground stance. So the tube fit uses a tucked body-core width;
 * the open-ground oval keeps the full span.
 */
const BORE_HUG_WIDE = 2.4 / MM;

/** The collision oval wears the measured body 20% small — legs are not
 *  walls, and a shell-sized fit perched her on every rim and pedestal. */
const BODY_FIT_SCALE = 0.8;

/*
 * THE FOUNDING QUESTS — the prologue's spine, straight from the design
 * brief: the queen finds a spot, digs an entrance, hollows her chamber,
 * and the first worker emerges. Three beats, each read off what she has
 * ACTUALLY done to the soil, never off a checkbox.
 */
/** Deep enough that the entrance counts as an entrance, in mm. */
const QUEST_DEPTH_MM = 25;
/** Soil samples carved OUT while deep — the chamber, measured in work.
 *  Calibrated against the rig: ~10 s of held digging at depth. */
const QUEST_CHAMBER_SAMPLES = 30000;

/**
 * How far PAST HER NOSE the jaws close — not how far past her centre.
 *
 * This was 1.4 mm from her middle, on a body whose half-length is 4.5 mm,
 * which put her mandibles inside her own thorax. She could only ever chew a
 * pocket she was already standing in, and never the slab of soil in front
 * that she has to move into, so digging deadlocked: measured, 637 of 643
 * strokes cut nothing at all and she advanced 0.00 mm in five minutes.
 *
 * Her mouth is at the front of her, so the reach is measured from there.
 */
const JAW_PAST_NOSE = 0.6 / MM;
const BODY_HALF_TALL = 1.6 / MM;

/**
 * Where the oval is tested, as fractions of its half-extents: nose, tail,
 * both shoulders, back and belly, and the four diagonals of her waist. Her
 * outline, in eleven questions.
 */
/** How far clear of her own feet the oval's belly rides. */
const BODY_FLOOR_MARGIN = 0.3 / MM;

/** How far up or down she may point: not quite the poles, where a heading
 *  stops meaning anything. */
/**
 * How far up and down she may point: a QUARTER TURN, exactly.
 *
 * It was 1.4 radians — eighty degrees — and the gauge sat there pegged.
 * That is fine while the world is a hill and wrong the moment there is a
 * tree in it: going up a trunk IS ninety degrees, and a dial that cannot
 * reach it cannot look where she is going. The degenerate case at the poles
 * is already handled — the first-person eye rotates its own up by the same
 * pitch, so its up and its look stay perpendicular at every angle including
 * this one.
 */
const AIM_LIMIT = Math.PI / 2;

/** The room camera starts blending in at norm 1.25 (~3 mm out) and is all
 *  the way in by 0.75 — distance-driven, so walking pace sets the feel. */
const CHAMBER_CAM_FAR = 1.25;
const CHAMBER_CAM_NEAR = 0.75;


/** How fast a colonist walks, and how fast she comes round. */
const COLONIST_SPEED = 1.1;
const COLONIST_TURN = 1.6;
/** Close enough to a wander target to call it arrived, in world units. */
const COLONIST_ARRIVE = 1.2;
/** How far from her birthplace a colonist will wander, in world units. */
const COLONIST_ROAM = 12;

/**
 * A COLONIST — a worker or a major, walking the island on her own legs.
 *
 * The first worker was a JIG: a fixed circle, a hard-coded speed handed
 * straight to the gait, and a height read off the heightfield. It looked
 * like a toy beside a queen whose legs carry her, and the note under it
 * said so — "not yet a colonist with jobs; that part arrives with the
 * sandbox mechanics".
 *
 * This is those mechanics. She gets the same `LegDrive` the player has, so
 * her gait comes out of the step she actually took rather than a number
 * hoped into agreement with it; the same leg-rest seating and the same
 * `FOOT_AIR` floor, so she stands ON the ground; and a heading of her own.
 *
 * She does NOT get the queen's jaws. Digging wants two mandibles and a bore
 * rig, and a colonist has neither — which is why the caste split is here
 * and not a flag on one shared body.
 */
class Colonist {
  readonly model: QueenModel;

  ready = false;

  readonly at = new THREE.Vector3();

  readonly up = new THREE.Vector3(0, 1, 0);

  readonly fwd = new THREE.Vector3(0, 0, 1);

  private drive: LegDrive | null = null;

  private ride = RIDE;

  /** Where she is headed, and how long before she picks somewhere else. */
  private readonly want = new THREE.Vector3();

  private dwell = 0;

  private speed = 0;

  private readonly wasAt = new THREE.Vector3();

  private readonly right = new THREE.Vector3();

  private readonly basis = new THREE.Matrix4();

  constructor(
    readonly caste: 'worker' | 'major',
    private readonly rand: () => number,
  ) {
    this.model = new QueenModel(caste);
    this.model.root.visible = false;
  }

  async load(): Promise<boolean> {
    const ok = await this.model.load();
    this.ready = ok;
    this.model.root.visible = ok;
    if (ok) this.buildDrive();
    return ok;
  }

  /** Her legs' own rest plane, measured the same way the queen's is. */
  private buildDrive(): void {
    const setup: LegSetup[] = this.model.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.ride = -meanFootY + FOOT_AIR;
    this.drive = new LegDrive(setup);
  }

  place(x: number, z: number, groundAt: (px: number, pz: number) => number): void {
    this.at.set(x, groundAt(x, z) + this.ride, z);
    this.want.set(x, 0, z);
    this.dwell = 0;
  }

  step(
    dt: number,
    home: THREE.Vector3,
    roam: number,
    groundAt: (x: number, z: number) => number,
    normalAt: (p: THREE.Vector3, into: THREE.Vector3) => void,
    ground: Ground,
  ): void {
    if (!this.ready) return;

    this.dwell -= dt;
    if (this.dwell <= 0) {
      /* Somewhere else within reach of where she hatched — a colonist with
       * no leash is over the horizon in a minute. */
      const a = this.rand() * Math.PI * 2;
      const r = roam * (0.35 + this.rand() * 0.65);
      this.want.set(home.x + Math.cos(a) * r, 0, home.z + Math.sin(a) * r);
      this.dwell = 3 + this.rand() * 5;
    }

    const dx = this.want.x - this.at.x;
    const dz = this.want.z - this.at.z;
    const far = Math.hypot(dx, dz);
    let yaw = 0;
    let walk = 0;
    if (far > COLONIST_ARRIVE) {
      /*
       * Which side her target is on, about her OWN up.
       *
       * `up . (forward x target)` is positive when the target lies toward
       * `up x forward`, and a positive spin about up carries her nose that
       * same way — so the sign passes straight through with no convention
       * to get backwards.
       */
      const ux = dx / far;
      const uz = dz / far;
      const cx = this.fwd.y * uz;
      const cy = this.fwd.z * ux - this.fwd.x * uz;
      const cz = -this.fwd.y * ux;
      const side = this.up.x * cx + this.up.y * cy + this.up.z * cz;
      const ahead = (this.fwd.x * ux + this.fwd.z * uz);
      yaw = Math.max(-1, Math.min(1, side * 3));
      /* Walk once she is roughly pointed at it, and ease off as she lands,
       * or she paces back and forth across the spot for ever. */
      walk = ahead > 0.3 ? Math.min(1, far / (COLONIST_ARRIVE * 3)) : 0;
    } else {
      this.dwell = Math.min(this.dwell, 0);
    }

    this.wasAt.copy(this.at);
    this.drive?.step(
      dt,
      { at: this.at, up: this.up, forward: this.fwd },
      {
        walk,
        yaw,
        speed: COLONIST_SPEED,
        yawRate: COLONIST_TURN,
        settle: false,
        /*
         * NOT YET, and for a reason about this class rather than about the
         * scheduler — which is caste-agnostic and would run a worker's legs
         * on their own measured homes perfectly well.
         *
         * A colonist's body is PINNED: three lines below, her height is
         * written from the heightfield and her up from its normal, every
         * frame. Feet on a trunk would be dragged straight back off it by
         * that, so she would stage a transition she could never finish. The
         * queen is seated by the walker, which is what a corner needs.
         * Roaming NPCs get this when they get her seating.
         */
        mayTransition: false,
      },
      ground,
    );

    /* Seated on the island and leaning with it: a colonist on a bank stands
     * square to the bank, not plumb through it. */
    normalAt(this.at, this.up);
    if (this.up.lengthSq() < 1e-9) this.up.set(0, 1, 0);
    this.up.normalize();
    this.at.y = groundAt(this.at.x, this.at.z) + this.ride;
    this.fwd.addScaledVector(this.up, -this.fwd.dot(this.up));
    if (this.fwd.lengthSq() < 1e-9) this.fwd.set(0, 0, 1).addScaledVector(this.up, -this.up.z);
    this.fwd.normalize();

    /* What she TRAVELLED, across her own tangent plane — the honest number
     * the gait runs on, so a colonist stopped by a trunk stops her legs
     * instead of running on the spot. */
    this.wasAt.sub(this.at);
    this.wasAt.addScaledVector(this.up, -this.wasAt.dot(this.up));
    const went = this.wasAt.length() / Math.max(dt, 1e-6);
    this.speed += (went - this.speed) * Math.min(1, dt * 12);

    this.right.crossVectors(this.up, this.fwd).normalize();
    this.model.root.position.copy(this.at);
    this.model.root.quaternion.setFromRotationMatrix(
      this.basis.makeBasis(this.right, this.up, this.fwd),
    );
    this.model.update(dt, {
      speed: this.speed,
      turn: yaw * COLONIST_TURN,
      digging: 0,
      carrying: 0,
      headYaw: 0,
      headPitch: 0,
    });
    this.model.solveFeet(
      (x, z) => groundAt(x, z), FOOT_CLEARANCE_MM / MM, this.ride * 2,
    );
  }

  dispose(): void { this.model.dispose(); }
}

export class IslandScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly queen = new QueenModel('queen');

  /** Stamped grid (mound included) — what the island mesh and walker use. */
  private heights: Int16Array | null = null;

  /** Pristine grid — what the soil function calls "the natural surface". */
  private heightsBase: Int16Array | null = null;

  private soil: IslandSoil | null = null;

  private stream: IslandStream | null = null;

  private nestView: NestView | null = null;

  private textures: BiomeTextureSet | null = null;

  private islandMaterial: THREE.MeshStandardMaterial | null = null;

  private soilMaterial: THREE.MeshStandardMaterial | null = null;

  /**
   * THE UNDERGROUND SENSE, the density lab's answer to a problem this room
   * had too: inside the soil every wall is the same brown, a tunnel is a
   * featureless void, and a camera that dips below the surface shows empty
   * space rather than dirt. Underground the terrain stops being lit and
   * becomes SENSED — near surfaces keep their shading, everything further
   * reads as contours on darkness, past her reach is unknown. A bubble
   * around her rather than an x-ray, so where the nest goes next is still
   * a decision and not a readout.
   */
  private sense: SenseUniforms | null = null;

  /** The fine window's rectangle, in world units. Island fragments inside die. */
  private readonly clip = { value: new THREE.Vector4(0, 0, 0, 0) };

  /** The top of the streamed soil's depth band, in world units — see
   *  `refreshBandTop`. Out of reach until the stream exists, so until then
   *  the island cuts out as before and no soil is thrown away. */
  private readonly bandTop = { value: 1e9 };

  /** The sky's own colour, kept so the underground blend has something to
   *  come back to. */
  private readonly skyColour = new THREE.Color(0x9cc4e0);

  private tree: BuiltTree | null = null;

  /** One instanced mesh per species — a whole tier in a single draw call. */
  private readonly stands = new Map<string, THREE.InstancedMesh>();

  /**
   * The unit-height trunk line each tier was baked from.
   *
   * The collision reads THIS rather than approximating it. A straight cone
   * from base radius to a fraction of it — which is what stood in for a
   * trunk before — measured up to 33 per cent fatter than the drawn wood at
   * mid-height and modelled none of the lean, so she stood on the invisible
   * one and floated over the visible one.
   */
  private readonly standProfiles = new Map<string, TrunkProfile>();

  /** Where she was when the small tiers were last grown. */
  private readonly scrubAt = new THREE.Vector3(Infinity, 0, Infinity);

  private forestMaterial: THREE.MeshStandardMaterial | null = null;

  /** The stand near enough to walk into, rebuilt with the scrub. */
  private stand: ForestSolid | null = null;

  private readonly chunkMeshes = new Map<string, THREE.Mesh>();

  private readonly queue: { cx: number; cy: number; cz: number }[] = [];

  private readonly queued = new Set<string>();

  private clipPending = false;

  /** Every chunk that has been MESHED since the last invalidation — the
   *  empties included. Two jobs: scrolls skip re-meshing chunks that built
   *  to nothing (most of the column is air or solid interior, and requeueing
   *  them every scroll was the bulk of the phone's backlog), and the clip's
   *  no-holes invariant is checked against THIS set, not the mesh map. */
  private readonly builtChunks = new Set<string>();

  /** The window-local cell rect (chunk-aligned) proven covered by built
   *  chunks. The clip may only ever expose THIS; it grows to the full
   *  window in reveal() and shrinks by intersection on every scroll. */
  private readonly meshedRect = { x0: 0, z0: 0, x1: 0, z1: 0 };

  private meshBudgetCapForTest = Infinity;

  private terrainVerts = 0;

  private terrainTris = 0;

  private readonly at = new THREE.Vector3();

  private facing = Math.PI;

  private readonly velocity = new THREE.Vector3();

  readonly input = { walk: 0, yaw: 0, strafe: 0, dig: false, sprint: false };

  /*
   * There is no TURN/STEER latch any more. It existed to choose which of
   * two things left-and-right meant; now the stick always turns and the
   * view always side-steps, so there is nothing left to choose.
   */

  /** The WALK/RUN latch, which is the only sprint a thumb has. */
  private running = false;

  private paceChip: HTMLButtonElement | null = null;

  /**
   * THE BORE — the dig room's control, brought over whole rather than
   * re-invented: hold DIG and she strokes, soil leaves at the bottom of
   * each stroke, steering is slow while cutting because a tunnel is a
   * committed shape, and pitch is a dial from straight down to straight up.
   *
   * The rule that makes it a tunnel rather than a trench is that the aim
   * steers TRAVEL, not just the bite — and the rule that makes it honest is
   * that digging never moves her by itself. Each stroke clears a little
   * more, and she can only walk into what has been cleared, so how fast a
   * tunnel grows is a property of her jaws and not of how long the stick
   * is held.
   */
  private readonly bore = new BoreRig(Math.PI);

  /** DIG is a MODE now: the DIG chip arms it, the 🪏 button strokes. */
  private digMode = false;

  /** The shovel, revealed once DIG is armed. */
  private scoopBtn: HTMLButtonElement | null = null;

  /** The smoothing brush's radius, in millimetres — the slider's value. */
  private brushMm = SMOOTH_RADIUS_MM;

  /** Where the next press will act, drawn before it acts: the cut, and
   *  the halo the same stroke shaves around it. */
  private toolGhost: THREE.Mesh | null = null;

  private smoothGhost: THREE.Mesh | null = null;


  private readonly keysDown = new Set<string>();

  private spaceWasDown = false;

  /**
   * WHICH WAY IS UP FOR HER — and it is not the world's answer.
   *
   * An ant has no down; it has a surface, and the surface is down. This is
   * the outward normal of whatever she is standing on: the hillside, a
   * tunnel floor, a shaft's wall, the roof of a chamber. Everything that
   * used to hard-code world +Y — the walk, her orientation, the leg solver's
   * frame, both cameras — reads this instead, which is the whole of walking
   * up a wall and across a ceiling.
   */
  private readonly up = new THREE.Vector3(0, 1, 0);

  /**
   * Her nose, in the world, always square to `up`.
   *
   * `facing` is a yaw about world +Y and cannot describe an ant on a
   * ceiling — the same heading means two different directions depending on
   * which way up she is. The rig still owns the RATE she turns at; what it
   * hands over is a change in heading, which is applied as a rotation about
   * her own up. On level ground the two are identical to the digit.
   */
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  /** The rig's heading last frame, so a step of it can be applied as a turn
   *  about her own up rather than the world's. */
  private headingWas = 0;

  private walker: SurfaceWalker | null = null;

  /** How fast she is actually travelling over the ground, eased — the gait's
   *  input, and never the stick's. */
  private groundSpeed = 0;

  private readonly wasAt = new THREE.Vector3();

  /**
   * THE LEGS, DRIVING.
   *
   * The island had the foot solver but not this, and the difference is the
   * whole of the reported skating. `solveFeet` can only move a foot up and
   * down — the gait owns where it sits fore and aft — so with nothing
   * telling it where a foot IS in the world from one frame to the next,
   * nothing could hold one still. The drive plants a stance foot on a world
   * point and puts it back there every frame, which makes its ground speed
   * exactly zero however fast the cycle runs. It also means the LEGS move
   * her: the stick proposes, the planted feet refuse what they cannot
   * reach, and what survives is her displacement.
   */
  private drive: LegDrive | null = null;

  private driveReport: DriveReport | null = null;

  /**
   * THE FLIGHT RECORDER.
   *
   * Arms itself the first frame she actually moves and keeps sixty seconds of
   * every frame, because the float and the snap we are chasing last a handful
   * of frames each and a once-a-second sample reports a smooth run straight
   * over the top of them. See `IslandTelemetry.ts`.
   */
  private readonly telemetry = new TelemetryRecorder();

  private telemetryChip: HTMLButtonElement | null = null;

  /** Scratch for the seating measurement — no per-frame allocation. */
  private readonly seatFrom = new THREE.Vector3();

  /** How far the walker re-seated her along her up, this frame, in mm. */
  private seatLiftMm = 0;

  /** How high her body rides, taken from her own rig once it has loaded. */
  private legRide = RIDE;

  /**
   * What the legs may ask of the world: the nearest solid to a point,
   * searched down her own up and then back along it. Null is a real answer
   * and means nothing to stand on here, which is how a foot knows to stay
   * up rather than reach into space.
   */
  private readonly groundForLegs = {
    nearest: (at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number) => {
      const walker = this.walker;
      if (!walker) return null;
      const from = S_RAD.copy(at).addScaledVector(up, rise);
      const dir = S_SPOT.copy(up).negate();
      return walker.cast(from, dir, rise + down);
    },
    /*
     * AND THE SAME QUESTION IN A DIRECTION THAT IS NOT HER UP.
     *
     * The one above is the right question for the ground she is standing on
     * and cannot answer for the one she is not. Measured at the landmark:
     * from a front foot's home, with a trunk 14 down to 5 mm away, it
     * returns SOIL every frame, while a ray along her forward finds bark the
     * whole time. So the corner scheduler gets a direction of its own.
     *
     * It is the SAME FIELD — the walker's own cast, over the union of soil,
     * landmark, scrub and anything dug. No second collision world, no tree.
     *
     * The null on a solid origin is not defensive tidying. `cast` reports a
     * hit at zero range when it starts inside something, which is correct
     * for a ray and is a foothold 2.5 mm inside the wood here; that is
     * exactly what the gait's downward cast hands back once a front foot's
     * home crosses the bark.
     */
    probeContact: (origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number) => {
      const walker = this.walker;
      if (!walker) return null;
      if (walker.solidAt(origin.x, origin.y, origin.z)) return null;
      const hit = walker.cast(origin, dir, maxDistance);
      if (!hit) return null;
      const normal = new THREE.Vector3();
      walker.normalAt(hit, normal);
      return { point: hit, normal };
    },
  };

  /** How far the third-person camera is swung off her tail by a drag; it
   *  decays back to zero, which is how the view returns behind her. */
  /**
   * THE PLAYER'S PAN, as an offset from neutral in her own frame.
   *
   * Not a world bearing and not the aim. Both decay to zero after
   * `LOOK_HOLD_S`, which is what makes the camera come home; and being HER
   * frame is what lets them keep meaning something on a wall, where a world
   * bearing stops meaning anything at all.
   */
  private lookYaw = 0;
  private lookPitch = 0;
  /** Seconds since the last look drag. Reset while a finger is down. */
  private lookIdle = 0;

  /** Last measured head-shell clearance, in mm — reused by the FPV lift. */
  private headClearMm = Infinity;

  /** The eased camera-only up-tilt, in radians. See `FPV_LIFT_RAD`. */
  private fpvLift = 0;
  /**
   * The direction the first-person lens actually looks, in world space.
   *
   * Published because the DIG reads it: the crosshair sits at the centre of
   * the frame, so the cut has to happen along the line the frame is built
   * on or the two disagree the moment her head is not level with her body.
   */
  private readonly lookDir = new THREE.Vector3(0, 0, 1);


  private camPitch = 0.5;

  private camDist = 30 / MM;

  /**
   * THE CAMERA'S OWN SMOOTHED STATE — a target, a look point, and an up,
   * each following the real thing over time rather than being copied from
   * it every frame.
   *
   * The lens position was already eased. Everything else was not, and that
   * is where the shake was: `lookAt` was pointed at her RAW centre and
   * `camera.up` copied her RAW up, so every millimetre the walker re-seated
   * her — and it re-seats her every frame, on a lattice — went straight
   * into the view as angular jitter, magnified by the length of the arm.
   * The chosen SPOT jittered too, both from `clearRun`'s step quantisation
   * and from the hard switch between the straight arm and the fan.
   *
   * Three low-pass filters, so the picture moves like a camera on a rig and
   * not like one bolted to her thorax. `null` until the first frame places
   * them, because starting them at the origin would sweep the whole island.
   */
  private camWant: THREE.Vector3 | null = null;

  private camLook: THREE.Vector3 | null = null;

  private camRoll = new THREE.Vector3(0, 1, 0);

  /** The first-person lens's own filtered state — see `settleEye`. */
  private eyeAt: THREE.Vector3 | null = null;

  private readonly eyeRoll = new THREE.Vector3(0, 1, 0);

  /** Her NOSE, filtered — the body half of the first-person look. */
  private readonly eyeFwd = new THREE.Vector3(0, 0, 1);

  /** Last frame's ground-guard lift, in world units. Diagnostics only. */
  private guardLift = 0;

  /** The spine's inputs and raw targets last frame. Diagnostics only. */
  private spineRead: SpineReading | null = null;

  private spineWant: SpinePose | null = null;

  /** The terrain rises, low-passed — see `readSpine`. */
  private riseAhead = 0;

  private riseBehind = 0;

  private firstPerson = false;

  /**
   * WHERE SHE IS POINTED, up and down — and it STAYS there.
   *
   * Taking this from the camera's own look direction was a mistake with
   * teeth: a third-person camera sits behind and above her, so its look is
   * permanently tilted down, and "forward" therefore meant "downward" for
   * as long as she was underground. She dug, sank, and could not aim back
   * out of the hole she was making. A dial the player sets and the game
   * leaves alone is the only thing that can mean ""along the tunnel"".
   */
  private aimPitch = 0;

  /** The last bearing the aim line actually had — held through plumb, where
   *  a bearing stops meaning anything. */
  private aimBearing = 0;

  private underground = false;

  /** The room camera's share of the underground view, eased 0..1. */
  private chamberCam = 0;

  /** The tunnel designer — built fresh each time DIG opens it, because its
   *  working box is fitted around wherever the plan has grown to. */
  private designer: NestDesigner | null = null;

  /** The designer's plan-local origin in island mm, for translating the
   *  plan into its working box and back. */
  private readonly designOriginMm = new THREE.Vector3();

  /** Render scale breathes with the frame rate (phones): capped at retina,
   *  never below 1x. */
  private readonly pixelCap = Math.min(window.devicePixelRatio, 2);

  private pixelRatioNow = this.pixelCap;

  /** The last position whose centre provably sampled AIR — the anchor the
   *  anti-embed safety net snaps back to. */
  private readonly lastSafe = new THREE.Vector3();

  private hasSafe = false;

  private embedFrames = 0;

  private queenReady = false;

  /** The queen's GLB has RESOLVED — loaded or failed, either way settled.
   *  `ready` is the WORLD (probes wait on it); the player-facing loading
   *  screen waits for this too, so the reveal never shows a queenless hill. */
  private queenSettled = false;

  /** worldReady && queenSettled — the moment the loading screen lets go. */
  playerReady = false;

  private paused = false;

  private previous = performance.now();

  private frame = 0;
  /** True while the GPU context is gone and the loop is stopped. */
  private contextLost = false;
  /** The "device dropped the 3D display" bar, once it has been raised. */
  private gpuNotice: HTMLElement | null = null;
  private stopContextGuard: (() => void) | null = null;

  private lastScrollAt = 0;

  private biteAt = 0;

  /** Did the LAST bite actually remove soil? Surface engagement hangs on
   *  it — digging at open air must not grip her to the aim line. */
  private biteTouched = false;

  /* ------------------------------------------------- the founding quests */

  /** 0 dig the entrance · 1 hollow the chamber · 2 cinematic · 3 done. */
  private questStage = 0;

  /** Soil removed while deep — the chamber's progress, in samples. */
  private deepCarved = 0;

  private questEl: HTMLElement | null = null;

  private cineEl: HTMLElement | null = null;

  private cineUntil = 0;

  /** The first worker — spawned when the chamber is made. */
  /** The colony on the surface — a worker and a major, each walking on her
   *  own legs. See `Colonist`. */
  private readonly colony: Colonist[] = [];


  private readonly workerAnchor = new THREE.Vector3();



  private showPlan = true;

  private readonly stats = {
    fps: 0,
    frames: 0,
    fpsAt: performance.now(),
    scrolls: 0,
    lastScrollMs: 0,
    rebases: 0,
    treeTris: 0,
  };

  private readonly hud: HTMLElement;

  /** The telemetry, folded behind a small STATS chip (collapsed default). */
  private readonly statsPanel: DebugStatsPanel;

  /** The full-screen curtain that hides the raw start-up. */
  private readonly loading: LoadingOverlay;

  private stickPointer: number | null = null;

  private lookPointer: number | null = null;

  /**
   * The look pointer's stroke so far — where it went down, when, and how
   * far it has actually travelled. Read once, on release, to decide whether
   * that was a pan or a flick. See `readFlick`.
   */
  private stroke = {
    x: 0, y: 0, lastX: 0, lastY: 0, at: 0, travel: 0,
  };

  /** The evasive burst, and the numbers behind it. See `dodge.ts`. */
  private readonly dodge = new Dodge();

  /** Head, thorax and gaster, each chasing the terrain at its own rate.
   *  See `src/anim/spine.ts`. */
  private readonly spine = new Spine();

  private readonly stickOrigin = { x: 0, y: 0 };

  private readonly stickEl = document.createElement('div');

  private readonly stickKnob = document.createElement('div');

  private readonly crosshair = document.createElement('div');

  private aimReadout: HTMLElement | null = null;

  private headingReadout: HTMLElement | null = null;

  private depthReadout: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    /*
     * Safari in a TAB ignores `user-scalable=no` on purpose, and answers a
     * pinch with its own `gesture*` events rather than with touches — so
     * `touch-action` never sees them and the page magnifies anyway.
     * Refusing the gesture outright is the only thing that stops it.
     */
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      host.addEventListener(name, this.refuseGesture, { passive: false });
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.watchContext();

    this.scene.background = new THREE.Color(0x9cc4e0);
    this.skyColour.copy(this.scene.background as THREE.Color);
    /* Haze, not blindness: from the summit the coast is ~5,600 world units
     * away and should read as distant blue land, the way islands do. */
    this.scene.fog = new THREE.Fog(0xb9c9d6, 1200, 11000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 16000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
    sun.position.set(4000, 6000, 2500);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.8));

    // The sea: one plane at real sea level. The baked grid keeps true
    // bathymetry, so the seafloor falls away beneath it instead of meeting a
    // shelf — BE's own trick against z-fighting the shoreline.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry((SPAN_MM / MM) * 1.6, (SPAN_MM / MM) * 1.6),
      new THREE.MeshLambertMaterial({
        color: 0x2e6f8e, transparent: true, opacity: 0.82,
        /*
         * PUSHED BACK, so the shore always wins.
         *
         * The sea is one flat plane at zero and the island meets it along
         * every coastline, which is thousands of triangles sitting at the
         * same depth as the water. From high up the depth buffer cannot
         * separate them and they flicker against each other — the reported
         * z-fighting on land. Nudging the sea away from the camera breaks
         * the tie the same way every frame, and being a hair deeper than it
         * really is costs nothing on something you look down through.
         */
        polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(SPAN_MM / MM / 2, 0, SPAN_MM / MM / 2);
    this.scene.add(sea);

    this.scene.add(this.queen.root);

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.statsPanel = new DebugStatsPanel(this.hud);
    this.buildControls();

    /* The curtain goes up LAST in the DOM and FIRST in importance: plain
     * DOM, so it paints before any of the heavy lifting below, and opaque,
     * so the HUD and the blue empty canvas never flash through. */
    this.loading = new LoadingOverlay(host);

    this.load().catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err);
      this.loading.fail(`The island failed to load — ${why}. Refresh to try again.`);
      /*
       * ONLY ON THE FAILING PATH. `load()` resolving is NOT the app being
       * loaded: it resolves the moment the world is standing, and leaves the
       * queen's model — a megabyte, and the longest fetch of the boot — still
       * in flight behind it. Marking loaded here on success would hand a
       * waiting update the app precisely during the download that is worst to
       * interrupt. The success signal is where the curtain actually lifts,
       * after the queen has settled. Failure has no such moment and needs
       * one: an update held behind a load that has already given up is an
       * update that never arrives, and a fresh build is exactly what a failed
       * load most wants.
       */
      markLoaded();
    });

    (window as unknown as { islandScene?: unknown }).islandScene = this;
    /*
     * `?ik=off` — the leg solver's off switch, read once at startup so it can
     * be reached from a phone, where there is no console. See `setIK`.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('ik') === 'off') this.setIK(false);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.animate();
  }

  private async load(): Promise<void> {
    this.loading.setStatus('Preparing the island…');
    const url = `${import.meta.env.BASE_URL}kauai-1025.bin`;
    const [raw, textures] = await Promise.all([
      (await fetch(url)).arrayBuffer(),
      /*
       * EIGHT, NOT SIXTEEN, and the difference is measured rather than
       * taste. The bark asks for sixteen because bark is ONE texture on a
       * trunk. The ground is the heaviest shader in the game — a six-way
       * elevation/slope splat where every band is sampled twice for
       * anti-repeat and the rock bands three times for triplanar, so a
       * pixel of ground can cost a dozen samples before anisotropy
       * multiplies any of them.
       *
       * Time for the queen's model to finish loading, which under a
       * software rasteriser is a fair proxy for how much of the frame the
       * shading is eating: 46 s at 4, 57 s at 8, 106 s at 16. Eight buys
       * most of the grazing-angle win for a quarter of sixteen's cost, and
       * a phone is bandwidth-bound in exactly the way that measurement is.
       */
      loadBiomeTextures(
        import.meta.env.BASE_URL,
        Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      ),
    ]);
    this.loading.setStatus('Raising the island…');
    this.heights = new Int16Array(raw);
    this.heightsBase = this.heights.slice();
    this.textures = textures;
    /* BOTH surfaces band by the stride-1 data slope (aGroundNy): the
     * island's LOD rings and the soil window then agree on where rock
     * meets sand, instead of each mesh reading its own normals. */
    this.islandMaterial = makeBiomeMaterial(textures, this.clip, true, this.bandTop);
    this.soilMaterial = makeBiomeMaterial(textures, undefined, true, this.bandTop);
    /* The soil window's rim lies coplanar with the island surface it
     * replaces — polygon offset pulls the soil forward a hair so the
     * seam is a line, not a z-fight shimmer. */
    this.soilMaterial.polygonOffset = true;
    this.soilMaterial.polygonOffsetFactor = -1;
    this.soilMaterial.polygonOffsetUnits = -1;
    /* The soil only: the island's own surface sheet is the lit world she
     * is standing on, and contouring that would be an x-ray of the hill. */
    this.sense = makeSensed(this.soilMaterial);

    /*
     * The soil's "natural surface" is the DRAWN base island (triangle-exact
     * over the pristine grid) so the fine soil's top meets the island mesh
     * at the window rim with nothing to stitch.
     */
    this.soil = makeIslandSoil((xMm, zMm) => this.renderedOn(this.heightsBase!, xMm, zMm));

    /*
     * Stamp the nest's mound into the STAMPED grid: the island mesh and the
     * far view get a coarse tent of a hill (the grid is 55 mm-a-sample), and
     * the fine window redraws the real mound shape whenever you are close
     * enough to care — the world room's macro/fine split, in data.
     */
    const r = this.soil.reject;
    for (let row = Math.max(0, Math.floor(r.min[2] / STEP_MM));
      row <= Math.min(N - 1, Math.ceil(r.max[2] / STEP_MM)); row += 1) {
      for (let col = Math.max(0, Math.floor(r.min[0] / STEP_MM));
        col <= Math.min(N - 1, Math.ceil(r.max[0] / STEP_MM)); col += 1) {
        const natural = this.heights[row * N + col]! / 10;
        const top = this.soil.moundTopMm(col * STEP_MM, row * STEP_MM, natural);
        if (top > natural) this.heights[row * N + col] = Math.round(top * 10);
      }
    }

    this.buildIsland();
    this.loading.setStatus('Streaming the soil…');

    // The middle of the island: the Waiʻaleʻale plateau, ~1,300 m up,
    // with the pre-tunnel's gate 40 mm to the east.
    this.at.set(SPAN_MM / 2 / MM, 0, SPAN_MM / 2 / MM);
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;

    this.stream = new IslandStream(
      this.soil,
      (xMm, zMm) => this.renderedOn(this.heightsBase!, xMm, zMm),
      this.at.x, this.at.z,
    );
    /*
     * The walker is built once the soil exists, because the only thing it
     * needs is a way to ask how solid a point is — and that answer is the
     * live field where there is one and the island's own heightfield where
     * there is not. Its numbers are the island's, not the block room's: her
     * ride height, the field's cell, and a reach that spans a tunnel.
     */
    this.walker = new SurfaceWalker(
      (x, y, z) => this.soilDensityAt(x, y, z),
      {
        cell: CELL_SIZE,
        ride: RIDE,
        gripLift: 3 / MM,
        gripReach: 9 / MM,
        align: 12,
        maxTiltRate: (240 * Math.PI) / 180,
        /* The fold is a trapezoid now, not a switch — see `aimUp`. This
         * accel keeps the corner inside its measured timing while taking
         * the slam off both ends of the turn. */
        tiltAccel: (2400 * Math.PI) / 180,
        /* And the goal it chases is low-passed — see `SurfaceWalkTuning.
         * goalGain`. At an inside crease the raw contact normal alternates
         * faces on alternate frames; the filter turns that into its
         * average, and it is what took the lurch out of the fold. */
        goalGain: 1000,
        snap: 14,
        /* 0.3 mm: the stand-still dead-band — see SurfaceWalkTuning. */
        deadband: 0.06,
        gravity: 9,
      },
      (x, y, z) => this.soilSolidAt(x, y, z),
    );
    this.remeshEverything();
    this.clipToWindow();

    void this.plantTree();

    this.nestView = buildNestView(this.soil.plan);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.visible = this.showPlan;
    this.scene.add(this.nestView.root);

    /* The WORLD is ready here; the queen's model arrives when it arrives.
     * Gating `ready` on her GLB made every probe hostage to one slow fetch —
     * so the split is explicit: `ready` is the world (probes wait on it),
     * `playerReady` also waits for the queen to settle (loaded OR failed),
     * and only THAT lifts the curtain. The player never sees a queenless
     * island; the probes never hang on a model fetch. */
    this.ready = true;
    this.loading.setStatus('Waking the queen…');
    void this.queen.load().then((ok) => {
      this.queen.root.visible = ok;
      this.queenReady = ok;
      if (ok) this.buildLegDrive();
    }).finally(() => {
      this.queenSettled = true;
      this.playerReady = true;
      void this.loading.finish();
      /* The curtain is up: a waiting update may now take the app, because
       * from here a reload costs nothing but the load it already finished. */
      markLoaded();
    });
  }

  /**
   * ONE TREE, beside her, sunk into the hill.
   *
   * Loaded off the main thread of the boot: the bark is a megapixel and the
   * island is already playable without it, so the tree arrives when it
   * arrives rather than holding the curtain up. Which bark is a throw of the
   * dice, but a repeatable one — seeded off the spawn, so the tree that
   * grows here is this tree every time you load, not a different one each
   * run.
   */
  /** Which detail level the tree is actually showing, for the stats chip. */
  private treeLevel(): number {
    if (!this.tree) return -1;
    return this.tree.root.getCurrentLevel();
  }

  private async plantTree(): Promise<void> {
    const seed = Math.floor(this.at.x * 7919 + this.at.z * 104729) >>> 0;
    /*
     * `?bark=bark-ridged` — look at ONE of them.
     *
     * Which bark a tree wears is a hash of where it stands, which is right
     * for the world and useless for judging a new texture: the only way to
     * see the one you just added is to keep reloading until the island hands
     * it to you. An unknown name falls through to the seed rather than
     * leaving a tree with no bark.
     */
    const asked = new URLSearchParams(window.location.search).get('bark');
    const bark = (asked && (BARKS as readonly string[]).includes(asked)
      ? asked as typeof BARKS[number]
      : BARKS[seed % BARKS.length]!);
    const loader = new THREE.TextureLoader();
    const barkUrl = (suffix: string) => (
      `${import.meta.env.BASE_URL}tree-tex/${bark}${suffix}.jpg`
    );
    let map: THREE.Texture;
    try {
      map = await loader.loadAsync(barkUrl(''));
    } catch {
      return; // A missing bark is not worth failing the island over.
    }
    /*
     * The depth maps, for the barks that have them. A failure here costs the
     * relief and not the tree.
     */
    const pbr = PBR_BARKS.has(bark);
    const [normalMap, roughnessMap] = pbr
      ? await Promise.all([
        loader.loadAsync(barkUrl('_normal')).catch(() => undefined),
        loader.loadAsync(barkUrl('_rough')).catch(() => undefined),
      ])
      : [undefined, undefined];
    /*
     * MIRRORED BOTH WAYS, and that is a decision rather than a default.
     *
     * None of these images tile — measured, the wrap join on the newest
     * three was five to nine times worse than an ordinary interior join,
     * which on a trunk that wraps its texture six times is six hard lines
     * running the height of the tree. Blending the edges into agreement
     * fixes the join and leaves a blurred stripe down the middle that is
     * more obvious than the seam was. Mirroring costs neither: the join is
     * exactly continuous by construction, the image stays as sharp as it
     * came, and what it buys instead is a line of symmetry per tile, which
     * on bark disappears into the grain.
     *
     * It also means a new bark has to satisfy nothing at all beyond being
     * square.
     */
    /* Sixteen, not eight: the trunk is almost always seen at a grazing
     * angle — she is standing on it — and grazing angles are exactly what
     * anisotropy is for. Free on anything made this decade. */
    const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    /*
     * A NON-SQUARE bark would otherwise be stretched. The wrap gives one unit
     * of U and one of V the same number of world millimetres, which is right
     * for the square photographs and wrong for a 512x1024 library tile: its
     * texels would be twice as dense up the trunk as around it and the grain
     * would read squashed. Scaling V by the image's own aspect makes a texel
     * square again whatever shape the file is, and leaves 1:1 images alone.
     */
    const aspect = map.image && map.image.height
      ? map.image.width / map.image.height : 1;
    /* Whether it TILES, not whether it has depth — see `TILING_BARKS`. */
    const wrap = TILING_BARKS.has(bark)
      ? THREE.RepeatWrapping : THREE.MirroredRepeatWrapping;
    for (const tex of [map, normalMap, roughnessMap]) {
      if (!tex) continue;
      tex.wrapS = wrap;
      tex.wrapT = wrap;
      tex.anisotropy = aniso;
      if (aspect !== 1) tex.repeat.set(1, aspect);
    }
    /* Colour is the only one that is colour: a normal map is a direction and
     * a roughness map is a number, and sRGB-decoding either corrupts it. */
    map.colorSpace = THREE.SRGBColorSpace;

    this.tree = buildTree({
      girth: TREE_GIRTH_MM / MM,
      height: TREE_HEIGHT_MM / MM,
      seed,
    }, map, bark, { normalMap, roughnessMap });

    /*
     * SEVEN HUNDRED MILLIMETRES OUT — but WHICH WAY matters.
     *
     * The first cut picked a fixed bearing and landed on the Waiʻaleʻale
     * headwall: measured, the ground fell 572 mm over those 700, so the tree
     * was correctly buried into a forty-five degree cliff and grew out of
     * the rock below her like a flagpole. Walking a ring of bearings and
     * taking the one whose ground sits closest to her own costs sixteen
     * height lookups and puts the tree on the flattest thing within reach.
     */
    /*
     * SEVEN HUNDRED MILLIMETRES OF CLEAR GROUND, not seven hundred to the
     * pin — the term that was missing is the tree's own foot.
     *
     * This measured to the trunk's ORIGIN while the bole's flared base is
     * 640 mm of radius (girth/2 x 1.28, tree.ts), whose axis then wanders a
     * further 0.35 of the base radius off that origin. Measured on the
     * shipped seed: her spawn stood 49.6 mm from BARK — five body lengths —
     * so holding the stick forward walked her into a 1.26 m wall of wood
     * 5.7 seconds after her first step, every single time.
     *
     * That is what a whole field telemetry session turned out to be. Every
     * corner-phase row in it sits 1.4-1.7 mm from the bark: the four climbs
     * and returns, the 240 deg/s body rotations, the backward lurch — all
     * of it was her wrapping on and off this trunk, and none of it was the
     * walking-on-open-ground it was read as. The scheduler was never at
     * fault: over 4,669 frames of ordinary terrain the corner's look-ahead
     * found no candidate face at all, while the bark reads 82-87 degrees.
     *
     * Adding one girth covers both terms at any seed and restores what the
     * comment above always claimed: a landmark you walk TO.
     */
    const away = (TREE_FROM_HER_MM + TREE_GIRTH_MM) / MM;
    const here = this.walkGroundAt(this.at.x, this.at.z);
    let tx = this.at.x + away;
    let tz = this.at.z;
    let best = Infinity;
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      const cx = this.at.x + Math.sin(a) * away;
      const cz = this.at.z + Math.cos(a) * away;
      const drop = Math.abs(this.walkGroundAt(cx, cz) - here);
      if (drop < best) { best = drop; tx = cx; tz = cz; }
    }
    /*
     * And DOWN into the ground by its burial depth. The island's drawn
     * surface is a 109 mm mesh while the fine soil window redraws the same
     * ground at one millimetre as she approaches, so the two disagree by a
     * few millimetres wherever the hill curves — a tree seated exactly on
     * the coarse surface would be left standing in air the moment the fine
     * one resolved underneath it. A hundred millimetres swallows that with
     * room to spare, and at a metre of girth it costs nothing visible.
     */
    this.tree.root.position.set(
      tx,
      this.walkGroundAt(tx, tz) - TREE_BURIED_MM / MM,
      tz,
    );
    /* Solid AFTER placing: the collision is built in world space, and until
     * the tree has a position there is nothing to build it around. */
    this.tree.makeSolid(this.tree.root.position);
    this.scene.add(this.tree.root);
    this.stats.treeTris = this.tree.triangles[0] ?? 0;

    /*
     * ONE MATERIAL FOR THE WHOLE FOREST. The bake marks its leaves with a
     * vertex colour rather than a second material, so wood and foliage
     * share a shader and a tier stays one draw call. Fog off for the same
     * reason the landmark's is: the island's curve is tuned for fifty-six
     * kilometres and would swallow a two-metre sapling standing beside her.
     */
    this.forestMaterial = new THREE.MeshStandardMaterial({
      map, vertexColors: true, roughness: 0.95, metalness: 0, fog: false,
    });
    this.growForest();
  }


  /**
   * Hand her legs the job of moving her.
   *
   * Only once her rig is loaded, because the drive is built out of where
   * her feet actually rest — `legPlan` is read off the model, not guessed.
   * Until then the walker steps her along her nose as it always did, which
   * is what the first second of a session looks like either way.
   */
  private buildLegDrive(): void {
    const setup: LegSetup[] = this.queen.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    /*
     * SEAT HER AT THE HEIGHT HER OWN LEGS IMPLY.
     *
     * Measured: her rig rests its feet 0.26 mm ABOVE her body origin, and
     * the island was seating that origin 1.3 mm above the contact — so her
     * feet hovered 1.56 mm off the ground, against a downward reach of 1.1
     * to 1.8 mm, with the search starting higher still. All six legs came
     * back groping: nothing to stand on, every frame. A leg that never
     * plants is never anchored, and a foot that is never anchored is free
     * to slide, which is the skating.
     *
     * The ride the legs want is minus their own rest height — her origin a
     * hair BELOW the contact, because that is where this rig puts the sole
     * plane. Handing that to the walker makes the body height and the leg
     * geometry one number instead of two that have to be hoped into
     * agreement.
     */
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.legRide = -meanFootY;
    if (this.walker) {
      this.at.addScaledVector(this.up, this.legRide - this.walker.tune.ride);
      (this.walker.tune as { ride: number }).ride = this.legRide;
    }
    this.drive = new LegDrive(setup);
    this.drive.plantAll(
      { at: this.at, up: this.up, forward: this.fwd }, this.groundForLegs,
    );
  }

  /* -------------------------------------------------------- the forest */

  /**
   * The ground, as the scatter needs to see it: how high and how level.
   *
   * Read off the DRAWN island rather than the streamed soil, because the
   * scatter covers the whole map and the soil window is a hundred and
   * ninety millimetres wide. A plant a metre out would otherwise have no
   * ground to stand on.
   */
  private forestGround(xMm: number, zMm: number): { elevMm: number; flat: number } | null {
    if (!this.heights) return null;
    const x = xMm / MM;
    const z = zMm / MM;
    const elevMm = this.renderedGroundAt(x, z) * MM;
    if (elevMm <= 0) return null;
    const d = STEP_MM / MM;
    const dhx = (this.renderedGroundAt(x + d, z) - this.renderedGroundAt(x - d, z)) / (2 * d);
    const dhz = (this.renderedGroundAt(x, z + d) - this.renderedGroundAt(x, z - d)) / (2 * d);
    return { elevMm, flat: 1 / Math.hypot(dhx, 1, dhz) };
  }

  /**
   * Grow one tier and hand it to the GPU as a single instanced mesh.
   *
   * Every plant in a tier shares one baked geometry, which is what makes
   * three thousand bushes one draw call rather than three thousand. They
   * differ by their MATRIX — where, how big, which way round — and by
   * nothing else, so the tier's shape is one tree's shape at many sizes.
   * At a bush's size on screen that reads as variety; at a landmark's it
   * would not, which is why the landmarks are real trees and not instances.
   */
  private growStand(species: Species, box: {
    x0: number; z0: number; x1: number; z1: number;
  }): void {
    const plants = plantsIn(species, box, (x, z) => this.forestGround(x, z));
    let mesh = this.stands.get(species.name) ?? null;
    if (!mesh || mesh.count < plants.length || mesh.instanceMatrix.count < plants.length) {
      if (mesh) {
        this.scene.remove(mesh);
        mesh.dispose();
      }
      /*
       * A baked plant is one unit tall and one unit through, so the matrix
       * carries the whole of its size. Building it at the tier's MIDDLE
       * height keeps the taper and the branching honest for the sizes it
       * will actually be stretched to.
       */
      const mid = (species.minHeight + species.maxHeight) * 0.5 / MM;
      const spec: TreeSpec = {
        girth: mid * species.girthOfHeight,
        height: mid,
        seed: 0x5eed ^ species.name.length,
        rings: species.rings,
        boughs: species.boughs,
        twigs: species.twigs,
      };
      const geo = bakeTree(spec, species.detail);
      geo.scale(1 / mid, 1 / mid, 1 / mid);
      /* The SAME spec gives the collision its line, so the two can never be
       * describing different trees. */
      /* At the tier's OWN tessellation: a bush is baked with four sides and
       * is 41% wider at its corners than the stem it was grown from, so a
       * profile taken off the circle describes a plant she can stand
       * inside. */
      this.standProfiles.set(species.name, trunkProfile(spec, sidesAt(species.detail)));
      /* Room for growth, so an ordinary step does not rebuild the buffer. */
      const room = Math.max(16, Math.ceil(plants.length * 1.4));
      mesh = new THREE.InstancedMesh(geo, this.forestMaterial!, room);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.scene.add(mesh);
      this.stands.set(species.name, mesh);
    }
    const m = S_MAT;
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const at = new THREE.Vector3();
    for (let i = 0; i < plants.length; i += 1) {
      const p = plants[i]!;
      const h = p.heightMm / MM;
      at.set(p.xMm / MM, (p.groundMm - burialMm(p.heightMm)) / MM, p.zMm / MM);
      q.setFromAxisAngle(S_UP.set(0, 1, 0), p.spin);
      /*
       * UNIFORM. The bake is already the right shape — it was grown at the
       * tier's own girth-to-height ratio and then divided down to one unit
       * tall, so its width is that ratio and nothing more is owed. Putting
       * the ratio on again here multiplied it by itself and turned every
       * plant on the island into a needle a few millimetres through.
       */
      scale.setScalar(h);
      m.compose(at, q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = plants.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  /**
   * Plant the island: the big tiers once, the small ones around her.
   *
   * The split is a measurement, not a preference. Landmarks and canopy come
   * to about a hundred and forty over the whole map and cost nothing to
   * hold; saplings and bushes run past three thousand, and three thousand
   * of anything is worth generating only where she can see it.
   */
  private growForest(): void {
    if (!this.forestMaterial) return;
    const span = SPAN_MM;
    for (const species of SPECIES) {
      if (species.spacing >= 3000) {
        this.growStand(species, { x0: 0, z0: 0, x1: span, z1: span });
      }
    }
    this.regrowScrub(true);
  }

  /** The small tiers, kept in a window that follows her. */
  private regrowScrub(force = false): void {
    if (!this.forestMaterial) return;
    if (!force && this.scrubAt.distanceTo(this.at) * MM < SCRUB_REGROW_MM) return;
    this.scrubAt.copy(this.at);
    const cx = this.at.x * MM;
    const cz = this.at.z * MM;
    const r = SCRUB_WINDOW_MM;
    for (const species of SPECIES) {
      if (species.spacing >= 3000) continue;
      this.growStand(species, {
        x0: Math.max(0, cx - r), z0: Math.max(0, cz - r),
        x1: Math.min(SPAN_MM, cx + r), z1: Math.min(SPAN_MM, cz + r),
      });
    }
    /*
     * And the SOLID stand, on a much tighter radius. Drawing a plant she can
     * see and colliding with one she can reach are different questions with
     * very different budgets: the field is probed hundreds of times a frame,
     * so what it holds is only what she could walk into before the next
     * regrow.
     */
    this.stand = solidStand(
      { xMm: cx, zMm: cz }, STAND_REACH_MM, MM, (x, z) => this.forestGround(x, z),
      (species) => this.standProfiles.get(species.name) ?? null,
    );
  }

  /* ------------------------------------------------------------ the land */

  /** Height in mm (= real metres) at a data-grid index, clamped to edges. */
  private sampleOf(data: Int16Array, col: number, row: number): number {
    const c = Math.min(N - 1, Math.max(0, col));
    const rw = Math.min(N - 1, Math.max(0, row));
    return data[rw * N + c]! / 10;
  }

  private sample(col: number, row: number): number {
    return this.sampleOf(this.heights!, col, row);
  }

  /** Bilinear ground height in WORLD units at a world-unit position. */
  groundHeightAt(x: number, z: number): number {
    if (!this.heights) return 0;
    const gx = Math.min(N - 1.001, Math.max(0, (x * MM) / STEP_MM));
    const gz = Math.min(N - 1.001, Math.max(0, (z * MM) / STEP_MM));
    const c = Math.floor(gx);
    const rw = Math.floor(gz);
    const fx = gx - c;
    const fz = gz - rw;
    const h = this.sample(c, rw) * (1 - fx) * (1 - fz)
      + this.sample(c + 1, rw) * fx * (1 - fz)
      + this.sample(c, rw + 1) * (1 - fx) * fz
      + this.sample(c + 1, rw + 1) * fx * fz;
    return h / MM;
  }

  /**
   * The surface the GPU actually draws, in mm, over a chosen grid: locate
   * the quad on the MESH grid, pick the triangle the way the index buffer
   * splits it (a–c–b / b–c–d, diagonal along fx+fz=1), interpolate that
   * plane. BE's terrainSampling rule; the walker sank without it.
   */
  private renderedOn(data: Int16Array, xMm: number, zMm: number): number {
    const stride = (N - 1) / (MESH_N - 1);
    const stepMm = STEP_MM * stride;
    const gx = Math.min(MESH_N - 1.001, Math.max(0, xMm / stepMm));
    const gz = Math.min(MESH_N - 1.001, Math.max(0, zMm / stepMm));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const ha = this.sampleOf(data, i * stride, j * stride);
    const hb = this.sampleOf(data, (i + 1) * stride, j * stride);
    const hc = this.sampleOf(data, i * stride, (j + 1) * stride);
    const hd = this.sampleOf(data, (i + 1) * stride, (j + 1) * stride);
    return fx + fz <= 1
      ? ha + (hb - ha) * fx + (hc - ha) * fz
      : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  private renderedGroundAt(x: number, z: number): number {
    if (!this.heights) return 0;
    return this.renderedOn(this.heights, x * MM, z * MM) / MM;
  }

  /** Where the ant may stand: the drawn land, or wading depth at the shore. */
  private walkGroundAt(x: number, z: number): number {
    return Math.max(this.renderedGroundAt(x, z), 0.5 / MM);
  }

  /**
   * The first floor BELOW a height at this column, or null when the soil
   * has none to offer (out of window, or solid wall from there down). A
   * column the depth band cannot reach — steep country where the surface
   * climbs past the band's ceiling — caps flat at the ceiling, and standing
   * there must mean the drawn island, not the cap.
   */
  private floorBelow(x: number, z: number, fromY: number): number | null {
    const stream = this.stream;
    if (!stream) return null;
    const fine = stream.surfaceBelowY(x, z, fromY);
    if (fine === null) return null;
    const ceiling = stream.bandFloorWu + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
    if (fine >= ceiling - CELL_SIZE) return Math.max(fine, this.walkGroundAt(x, z));
    return fine;
  }

  /** Underfoot at HER height: tunnel floors are real, roofs above are not. */
  private footingAt(x: number, z: number): number {
    return this.floorBelow(x, z, this.at.y + 0.4) ?? this.walkGroundAt(x, z);
  }

  /**
   * Underfoot at THE FOOT'S OWN height, which is a different question and
   * the one the solver actually asks.
   *
   * Passing her body's height for all six feet asks about HER, not about
   * them — the solver's own note warns of exactly this: a foot pressed
   * against the wall of a shaft is inside soil, so the query climbs out of
   * it, and climbing out from her body's height in a column that is solid
   * all the way up lands on the rim overhead. The island had been throwing
   * the third argument away and handing every foot her own elevation,
   * which is why her legs reached for the surface while she was down a
   * hole.
   */
  private footingFrom(x: number, z: number, y: number): number {
    return this.floorBelow(x, z, y + 0.4) ?? this.walkGroundAt(x, z);
  }

  /**
   * HOW SOLID A WORLD POINT IS — positive in the soil, negative in the air,
   * zero at the drawn surface. The one question the walker asks, and it must
   * have an answer EVERYWHERE.
   *
   * Inside the streamed window that is the live field, dug tunnels and all.
   * Outside it there is no field, and a walker that loses its footing at the
   * window's edge drops her out of the world — so out there the island's own
   * heightfield answers the identical question in the identical form. It is
   * not an approximation: the window is FILLED from `surface(x, z) - y`, so
   * the fallback is the same expression the field was built out of, and the
   * two stitch together with no seam to fall through.
   */
  private groundDensityAt(x: number, y: number, z: number): number {
    const fine = this.stream?.densityAtWu(x, y, z);
    if (fine !== null && fine !== undefined) return fine;
    return this.walkGroundAt(x, z) - y;
  }

  /**
   * THE GROUND, AND THE WOOD STANDING IN IT.
   *
   * The walker takes exactly one question — how solid is this point — and
   * turns the answer into standing, climbing, cornering and falling. So the
   * tree does not need a collision system of its own; it needs to be part of
   * this answer. Unioned in, she bumps into the trunk, walks round it and
   * CLIMBS it, entirely through the code that already carries her up the
   * wall of a shaft: her up comes off this field's gradient, and the
   * gradient of a trunk points out of the trunk.
   *
   * A union is the larger of the two, because both are positive inside.
   */
  private soilDensityAt(x: number, y: number, z: number): number {
    let best = this.groundDensityAt(x, y, z);
    const landmark = this.tree?.solid?.densityAt(x, y, z);
    if (landmark !== undefined && landmark > best) best = landmark;
    const scrub = this.stand?.densityAt(x, y, z);
    if (scrub !== undefined && scrub > best) best = scrub;
    return best;
  }

  /**
   * IS this point in soil — the same question, asked the cheap way.
   *
   * Nearly every probe in the frame wants a yes or no: the walker's casts,
   * the leg solver's footing, the shovel's reach, the bone guard's escape.
   * Interpolating eight lattice samples to answer one of those is seven
   * reads of waste, and it is asked hundreds of times a frame — measured at
   * 0.033 µs against 0.094 for the smooth read. Only the surface NORMAL
   * genuinely needs what lies between the samples, and that is six probes.
   */
  private groundSolidAt(x: number, y: number, z: number): boolean {
    const fine = this.stream?.solidAtWu(x, y, z);
    if (fine !== null && fine !== undefined) return fine;
    return this.walkGroundAt(x, z) - y > 0;
  }

  private soilSolidAt(x: number, y: number, z: number): boolean {
    if (this.groundSolidAt(x, y, z)) return true;
    if (this.tree?.solid?.solidAt(x, y, z) === true) return true;
    return this.stand?.solidAt(x, y, z) === true;
  }

  /**
   * HER FRAME IN A BURROW — which way is up for her, and where the surface
   * under a point is measured ALONG that up.
   *
   * On open ground up is world vertical and a foot falls to a height. In a
   * tunnel neither is true: she is inside a tube, her up is whatever her
   * body is pressed against, and the surface under a foot may be a wall or
   * a ceiling. The solver has always been able to take this frame; the
   * island simply never gave it one, so her legs went on solving against a
   * floor that was not underneath her.
   *
   * The up is now HERS — the one the walker maintains off the soil's own
   * gradient — rather than one inferred from where she is pointed. Those two
   * agree in a level drift and disagree everywhere interesting: standing on
   * a wall while looking along it, the aim says up is sideways-ish and the
   * body says up is off the wall, and only the body is right.
   */
  private boreFrame(): {
    up: readonly [number, number, number];
    surface: (x: number, y: number, z: number) => number;
  } {
    const up = this.up;
    const REACH = BODY_HALF_TALL * 2 + BODY_FLOOR_MARGIN;
    /*
     * COARSE, THEN REFINED. The solver asks this once per joint per CCD
     * iteration — hundreds of times a frame — so a flat fourteen-step march
     * was the single most-called loop in the game. Seven strides to bracket
     * the surface and three bisections to place it inside them is the same
     * answer to a third of a stride, for half the probes.
     */
    const COARSE = 7;
    const REFINE = 3;
    return {
      up: [up.x, up.y, up.z] as const,
      surface: (x: number, y: number, z: number): number => {
        const elevOf = (t: number) =>
          (x - up.x * t) * up.x + (y - up.y * t) * up.y + (z - up.z * t) * up.z;
        /* Feel DOWN her own up until the soil starts, and report where it
         * started. Nothing found means open tube — she keeps her stance. */
        let lo = 0;
        let hit = -1;
        for (let i = 0; i <= COARSE; i += 1) {
          const t = (i / COARSE) * REACH;
          if (this.soilSolidAt(x - up.x * t, y - up.y * t, z - up.z * t)) { hit = t; break; }
          lo = t;
        }
        if (hit < 0) return elevOf(REACH);
        for (let i = 0; i < REFINE; i += 1) {
          const mid = (lo + hit) * 0.5;
          if (this.soilSolidAt(x - up.x * mid, y - up.y * mid, z - up.z * mid)) hit = mid;
          else lo = mid;
        }
        return elevOf(hit);
      },
    };
  }

  /** All sixty-four sections, built once, never touched again. */
  private buildIsland(): void {
    for (let sz = 0; sz < SECTIONS; sz += 1) {
      for (let sx = 0; sx < SECTIONS; sx += 1) {
        this.scene.add(this.buildSection(sx, sz));
      }
    }
  }

  private buildSection(sx: number, sz: number): THREE.Mesh {
    const positions = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
    const normals = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
    const elev = new Float32Array(SEC_VERTS * SEC_VERTS);
    const groundNy = new Float32Array(SEC_VERTS * SEC_VERTS);
    const stride = (N - 1) / (MESH_N - 1);
    let at = 0;
    for (let j = 0; j < SEC_VERTS; j += 1) {
      for (let i = 0; i < SEC_VERTS; i += 1) {
        const g = (sx * (SEC_VERTS - 1) + i) * stride;
        const gz = (sz * (SEC_VERTS - 1) + j) * stride;
        const h = this.sample(g, gz);
        positions[at] = (g * STEP_MM) / MM;
        positions[at + 1] = h / MM;
        positions[at + 2] = (gz * STEP_MM) / MM;
        /* Central differences on the DATA grid: both sides of a section
         * border compute from the same samples, so shading cannot seam. */
        const dx = (this.sample(g + stride, gz) - this.sample(g - stride, gz))
          / (2 * STEP_MM * stride);
        const dz = (this.sample(g, gz + stride) - this.sample(g, gz - stride))
          / (2 * STEP_MM * stride);
        const inv = 1 / Math.hypot(dx, 1, dz);
        normals[at] = -dx * inv;
        normals[at + 1] = inv;
        normals[at + 2] = -dz * inv;
        /* The BAND slope is measured at stride 1, whatever this section's
         * LOD stride is. Banding off the mesh normal made the rock/sand
         * split move with the LOD rings — the same hillside wore
         * different ground on each side of a detail boundary, and never
         * quite agreed with the soil window's fine-grid slopes either. */
        const dx1 = (this.sample(g + 1, gz) - this.sample(g - 1, gz))
          / (2 * STEP_MM);
        const dz1 = (this.sample(g, gz + 1) - this.sample(g, gz - 1))
          / (2 * STEP_MM);
        groundNy[at / 3] = 1 / Math.hypot(dx1, 1, dz1);
        elev[at / 3] = h; // mm IS real metres at 1:1000 — the biome bands read it raw
        at += 3;
      }
    }
    const index: number[] = [];
    for (let j = 0; j < SEC_VERTS - 1; j += 1) {
      for (let i = 0; i < SEC_VERTS - 1; i += 1) {
        const a = j * SEC_VERTS + i;
        const b = a + 1;
        const c = a + SEC_VERTS;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('aElev', new THREE.BufferAttribute(elev, 1));
    geometry.setAttribute('aGroundNy', new THREE.BufferAttribute(groundNy, 1));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.islandMaterial!);
    mesh.matrixAutoUpdate = false;
    this.terrainVerts += SEC_VERTS * SEC_VERTS;
    this.terrainTris += (SEC_VERTS - 1) * (SEC_VERTS - 1) * 2;
    return mesh;
  }

  /* ------------------------------------------------------------ the soil */

  private key(cx: number, cy: number, cz: number): string { return `${cx},${cy},${cz}`; }

  private remeshEverything(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.builtChunks.clear();
    this.queue.length = 0;
    this.queued.clear();
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) this.meshChunk(cx, cy, cz);
      }
    }
  }

  private meshChunk(cx: number, cy: number, cz: number): void {
    const stream = this.stream!;
    const key = this.key(cx, cy, cz);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    const data = buildSurfaceNets(stream.field, 0, {
      x0: cx * CH, y0: cy * CH, z0: cz * CH,
      x1: Math.min(WINDOW_CELLS, (cx + 1) * CH),
      y1: Math.min(CELLS_Y, (cy + 1) * CH),
      z1: Math.min(WINDOW_CELLS, (cz + 1) * CH),
    });
    // Built is built, even when the region meshes to NOTHING (all air or
    // solid interior — most of the column). Forgetting the empties meant
    // every scroll requeued them all, which WAS the phone's backlog.
    this.builtChunks.add(key);
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    // The biome shader wants per-vertex elevation in real metres; a soil
    // vertex's world Y in wu times MM is exactly that.
    const elev = new Float32Array(data.positions.length / 3);
    for (let v = 0; v < elev.length; v += 1) {
      elev[v] = (data.positions[v * 3 + 1]! + stream.bandFloorWu) * MM;
    }
    geometry.setAttribute('aElev', new THREE.BufferAttribute(elev, 1));
    // ...and the ORIGINAL surface elevation at each vertex, so the shader
    // can tell an undug top (paint the biome, match the island seamlessly)
    // from an excavated wall or floor (paint dirt, whatever the altitude).
    const orig = new Float32Array(elev.length);
    // ...and the original terrain's SLOPE (its normal's Y), so undug soil
    // bands by the same slope the island does. Surface-nets normals read
    // flatter than the data grid's, and the flat reading turned the mound's
    // dark cliff bands into open mountain/snow — white ground at her feet.
    const groundNy = new Float32Array(elev.length);
    const d = STEP_MM / MM; // one data cell, in world units
    for (let v = 0; v < orig.length; v += 1) {
      const wx = stream.originWorldX + data.positions[v * 3]!;
      const wz = stream.originWorldZ + data.positions[v * 3 + 2]!;
      /*
       * THE SAME SURFACE THE FIELD WAS BUILT FROM — measured, 4.31 mm out
       * on average and 22.9 mm at worst when it was not.
       *
       * `groundHeightAt` is bilinear on the FULL 1025-sample grid. The soil
       * window is generated from `renderedOn`, which is triangle-exact on
       * the DRAWN 513 grid — a different surface, and on curved ground they
       * disagree by millimetres. The dug test starts at 1.5 mm and is
       * saturated by 4.0 mm, so undug ground was reading as fully
       * excavated and the whole window painted itself rock: the patch of
       * wrong texture around her. Read off the drawn grid and an untouched
       * soil top is exactly its own original, to the digit, everywhere.
       */
      orig[v] = this.renderedOn(this.heights!, wx * MM, wz * MM);
      const dhx = (this.groundHeightAt(wx + d, wz) - this.groundHeightAt(wx - d, wz)) / (2 * d);
      const dhz = (this.groundHeightAt(wx, wz + d) - this.groundHeightAt(wx, wz - d)) / (2 * d);
      groundNy[v] = 1 / Math.hypot(dhx, 1, dhz);
    }
    geometry.setAttribute('aOrig', new THREE.BufferAttribute(orig, 1));
    geometry.setAttribute('aGroundNy', new THREE.BufferAttribute(groundNy, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.soilMaterial!);
    /* World position is fixed at BUILD time — retained chunks keep their
     * mesh untouched across scrolls, which is what makes scrolls pop-free. */
    mesh.position.set(stream.originWorldX, stream.bandFloorWu, stream.originWorldZ);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  private enqueue(cx: number, cy: number, cz: number): void {
    const key = this.key(cx, cy, cz);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ cx, cy, cz });
  }

  private onScroll(scroll: IslandScrollReport): void {
    this.stats.scrolls += 1;
    this.stats.lastScrollMs = scroll.ms;
    if (scroll.rebased) this.stats.rebases += 1;
    const moved = new Map<string, THREE.Mesh>();
    const keep = scroll.retained;
    for (const [key, mesh] of this.chunkMeshes) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      const nx = cx - scroll.tilesX;
      const nz = cz - scroll.tilesZ;
      const inside = !scroll.rebased
        && nx >= 0 && nx < CHUNKS_XZ && nz >= 0 && nz < CHUNKS_XZ
        && nx * CH >= keep.x0 && (nx + 1) * CH <= keep.x1
        && nz * CH >= keep.z0 && (nz + 1) * CH <= keep.z1;
      if (inside) {
        moved.set(this.key(nx, cy, nz), mesh);
      } else {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.chunkMeshes.clear();
    for (const [key, mesh] of moved) this.chunkMeshes.set(key, mesh);
    // The built set (empties included) rekeys by the same rule the meshes do.
    const movedBuilt = new Set<string>();
    for (const key of this.builtChunks) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      const nx = cx - scroll.tilesX;
      const nz = cz - scroll.tilesZ;
      const inside = !scroll.rebased
        && nx >= 0 && nx < CHUNKS_XZ && nz >= 0 && nz < CHUNKS_XZ
        && nx * CH >= keep.x0 && (nx + 1) * CH <= keep.x1
        && nz * CH >= keep.z0 && (nz + 1) * CH <= keep.z1;
      if (inside) movedBuilt.add(this.key(nx, cy, nz));
    }
    this.builtChunks.clear();
    for (const key of movedBuilt) this.builtChunks.add(key);
    this.queue.length = 0;
    this.queued.clear();
    const jobs: { cx: number; cy: number; cz: number; d: number }[] = [];
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) {
          if (this.builtChunks.has(this.key(cx, cy, cz))) continue;
          const wx = this.stream!.originWorldX + (cx + 0.5) * CH * CELL_SIZE;
          const wz = this.stream!.originWorldZ + (cz + 0.5) * CH * CELL_SIZE;
          jobs.push({ cx, cy, cz, d: Math.hypot(wx - this.at.x, wz - this.at.z) });
        }
      }
    }
    jobs.sort((a, b) => a.d - b.d);
    for (const job of jobs) this.enqueue(job.cx, job.cy, job.cz);
    /*
     * THE CLIP MUST NEVER OUTRUN THE MESHES — the island sheet keeps
     * covering everything but the retained, still-meshed soil until the
     * queue drains (reveal). The world room's law, inherited verbatim.
     */
    if (scroll.rebased) {
      this.meshedRect.x1 = this.meshedRect.x0;
      this.meshedRect.z1 = this.meshedRect.z0;
    } else {
      /* The one rectangle provably covered after this scroll: what was
       * covered BEFORE, shifted, intersected with what was retained. The
       * keep rect alone is NOT proof — on a backlogged phone it claims
       * chunks still sitting in the queue from earlier scrolls, and every
       * claimed-but-unbuilt chunk was a see-through hole to the sea plane
       * (the playtest teal). */
      const sx = scroll.tilesX * CH;
      const sz = scroll.tilesZ * CH;
      this.meshedRect.x0 = Math.max(this.meshedRect.x0 - sx, Math.ceil(keep.x0 / CH) * CH, 0);
      this.meshedRect.x1 = Math.min(this.meshedRect.x1 - sx, Math.floor(keep.x1 / CH) * CH, WINDOW_CELLS);
      this.meshedRect.z0 = Math.max(this.meshedRect.z0 - sz, Math.ceil(keep.z0 / CH) * CH, 0);
      this.meshedRect.z1 = Math.min(this.meshedRect.z1 - sz, Math.floor(keep.z1 / CH) * CH, WINDOW_CELLS);
    }
    this.applyClipFromMeshedRect();
    this.clipPending = true;
  }

  private reveal(): void {
    if (!this.clipPending || this.queue.length > 0) return;
    this.clipPending = false;
    this.clipToWindow();
  }

  /**
   * Where the streamed band's ceiling currently sits, for both shaders.
   *
   * The band moves — it re-anchors under whatever the window's centre is
   * standing on — so this has to be refreshed with it, or the island keeps
   * its cut-out at the old altitude and a strip of hill goes missing.
   */
  private refreshBandTop(): void {
    if (!this.stream) return;
    this.bandTop.value = this.stream.bandFloorWu
      + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
  }

  private clipToWindow(): void {
    this.refreshBandTop();
    this.meshedRect.x0 = 0;
    this.meshedRect.z0 = 0;
    this.meshedRect.x1 = WINDOW_CELLS;
    this.meshedRect.z1 = WINDOW_CELLS;
    this.applyClipFromMeshedRect();
  }

  private applyClipFromMeshedRect(): void {
    const r = this.meshedRect;
    const inset = CELL_SIZE * 2;
    if (r.x1 - r.x0 > 0 && r.z1 - r.z0 > 0) {
      this.clip.value.set(
        this.stream!.originWorldX + r.x0 * CELL_SIZE + inset,
        this.stream!.originWorldZ + r.z0 * CELL_SIZE + inset,
        this.stream!.originWorldX + r.x1 * CELL_SIZE - inset,
        this.stream!.originWorldZ + r.z1 * CELL_SIZE - inset,
      );
    } else {
      this.clip.value.set(0, 0, 0, 0);
    }
  }

  /** The no-holes invariant, checkable from a probe: every soil chunk the
   *  clip rectangle exposes must have been BUILT (empties count). */
  clipCoveredForTest(): boolean {
    const c = this.clip.value;
    if (!this.stream || (c.x === 0 && c.y === 0 && c.z === 0 && c.w === 0)) return true;
    const x0 = Math.floor((c.x - this.stream.originWorldX) / CELL_SIZE / CH);
    const z0 = Math.floor((c.y - this.stream.originWorldZ) / CELL_SIZE / CH);
    const x1 = Math.ceil((c.z - this.stream.originWorldX) / CELL_SIZE / CH);
    const z1 = Math.ceil((c.w - this.stream.originWorldZ) / CELL_SIZE / CH);
    for (let cz = Math.max(0, z0); cz < Math.min(CHUNKS_XZ, z1); cz += 1) {
      for (let cx = Math.max(0, x0); cx < Math.min(CHUNKS_XZ, x1); cx += 1) {
        for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
          if (!this.builtChunks.has(this.key(cx, cy, cz))) return false;
        }
      }
    }
    return true;
  }

  setMeshBudgetCapForTest(cap: number): void { this.meshBudgetCapForTest = cap; }

  loadingStateForTest(): {
    world: number; queenSettled: number; player: number; overlayGone: number;
  } {
    return {
      world: this.ready ? 1 : 0,
      queenSettled: this.queenSettled ? 1 : 0,
      player: this.playerReady ? 1 : 0,
      overlayGone: this.loading.done ? 1 : 0,
    };
  }

  /* ------------------------------------------------------------ the walk */

  private simulate(dt: number): void {
    if (!this.heights) return;
    /* The rig owns the heading: it steers slowly while she is cutting and
     * at walking rate otherwise. Its yaw runs the other way to the stick's,
     * hence the sign. */
    /*
     * THE VIEW SIDE-STEPS HER; THE STICK TURNS HER.
     *
     * `lookYaw` is the orbit arm's swing off her tail, and it comes back to
     * zero on its own — so holding the view dragged slides her that way and
     * letting go stops her, with no latch and no mode. Negated because a
     * rightward drag DECREASES lookYaw (`lookYaw -= movementX`) while a
     * positive strafe is screen-right.
     */
    const bore = this.bore.step(dt, {
      /*
       * Scaled so the rig delivers TURN_RATE at full stick rather than its
       * own YAW_RATE, which other rooms share and this one should not be
       * quietly redefining.
       *
       * BOTH TERMS ARE POSITIVE, and that is a correction. The stick's yaw
       * carried a minus inherited from the rig's own convention and the
       * camera's pull carried the opposite of it, so pushing right turned
       * her left and dragging the view right swung her nose away from it.
       * Measured against a FROZEN screen-right — the camera follows her, so
       * a live screen axis chases its own tail — the two read -1.58 and
       * -0.99 where they should have read positive. `shot-hands.mjs`.
       */
      yaw: -this.input.yaw * (TURN_RATE / YAW_RATE),
      forward: this.input.walk,
      dig: this.input.dig,
    });
    /*
     * THE RIG STEERS; HER OWN UP IS THE AXIS IT TURNS ABOUT.
     *
     * The rig's heading is a yaw about world +Y, and there is no such thing
     * for an ant on a ceiling: the same number means two opposite directions
     * depending on which way up she is. So what is taken from it is the
     * CHANGE, applied as a rotation of her nose about her own up. On level
     * ground the two are identical to the digit; upside down, only this one
     * is a turn.
     */
    let swing = bore.heading - this.headingWas;
    while (swing > Math.PI) swing -= Math.PI * 2;
    while (swing < -Math.PI) swing += Math.PI * 2;
    this.headingWas = bore.heading;
    if (Math.abs(swing) > 1e-9) this.fwd.applyAxisAngle(this.up, swing).normalize();
    /*
     * HER COMPASS BEARING, and it HOLDS when she has none.
     *
     * `atan2(fwd.x, fwd.z)` is the direction her nose points on the map,
     * which is meaningless the moment her nose is vertical: up a shaft or a
     * trunk the horizontal part of it is almost nothing and the bearing
     * spins on rounding. Everything world-referenced reads this — the aim,
     * the gauge, the scroll's look-ahead — so it keeps the last bearing it
     * could actually measure rather than inventing one.
     */
    const flat = Math.hypot(this.fwd.x, this.fwd.z);
    if (flat > 0.15) this.facing = Math.atan2(this.fwd.x, this.fwd.z);
    const speed = this.input.walk * WALK_SPEED * (this.input.sprint ? SPRINT : 1);
    this.velocity.copy(this.fwd).multiplyScalar(speed);

    /*
     * ONE MOVEMENT LAW: HER LEGS, EVERYWHERE.
     *
     * There were three — a rail that owned the tunnels, a gravity-free
     * bore travel that owned the digging, and this walker that owned the
     * surface — and they handed her between one another on heuristics.
     * Nearly every movement bug reported over a week lived in those
     * hand-offs rather than inside any one system, so each fix moved the
     * failure instead of removing it.
     *
     * The walker is the one that always worked, so it is the one that
     * stayed. It reads floors out of the dug soil, steps up small ledges,
     * refuses walls and climbs one it is pressed against — underground
     * exactly as above it, because underground is only more soil. The
     * scoop is wider than she is, so a stroke opens something she can
     * simply walk into and nothing has to gate her.
     */
    this.wasAt.copy(this.at);
    this.moveSurface(dt, speed);
    /*
     * Measured ACROSS her up: being re-seated along it by a fraction of a
     * millimetre a frame is not walking, and counting it had a motionless
     * ant reporting a jog.
     */
    const moved = S_RAD.copy(this.at).sub(this.wasAt);
    moved.addScaledVector(this.up, -moved.dot(this.up));
    const went = moved.length() / Math.max(dt, 1e-6);
    this.groundSpeed += (went - this.groundSpeed) * Math.min(1, dt * 12);

    this.underground = this.at.y + RIDE
      < this.walkGroundAt(this.at.x, this.at.z) - UNDER_MM / MM;

    this.questTick(dt);
    /* The small tiers follow her; the big ones were planted once. */
    this.regrowScrub();

    /*
     * Which ROOM she is loose in, if any. It is DERIVED from where she is,
     * it is only ever asked below ground, and it decides exactly one
     * thing: that the rail leaves her alone in here. It does not move her.
     *
     * Both halves of that matter, and both were reported as bugs. A room
     * is a wide oval — a generous queen chamber is 22 mm across and 11 mm
     * tall — so a shallow one reaches up through the hill, and asking the
     * question on the SURFACE let the room claim someone standing on their
     * own anthill and pull them down to its floor: "it teleports me
     * underground". And when the room's containment also drove movement it
     * was a cage rather than a floor, so a room whose only tunnel leaves
     * straight up — which is exactly what the designer's PLACE chain
     * builds, each piece dropped below the last — sealed her in: "I am
     * stuck in a room". The carved soil is the only container she needs;
     * a second, tighter, invisible one was the bug.
     */
    /* Her walked path used to be the tunnel camera's rail. The chase finds
     * its own open air now, so nothing reads the trail — and a per-frame
     * list of clones nothing reads is just work. */

    if (this.stream) {
      // Soil leaves at the bottom of the stroke, not on the button — and
      // which stroke it is depends on which tool the shovel is holding.
      if (bore.bite) this.bite();

      /* The builder digs on a BUTTON, not on a frame: `digPiece` is called
       * straight from the palette's chips. Nothing to do per-frame here. */

      const lead = Math.min(LEAD_MAX, Math.abs(speed) * LEAD_S);
      const now = performance.now();
      /*
       * ONE SCROLL AT A TIME, FINISHED BEFORE THE NEXT.
       *
       * A scroll regenerates the whole window — measured at 290 to 508 ms —
       * and then dumps most of two hundred chunks into the mesh queue. The
       * gate was a flat 150 ms, which is a third of one scroll's own cost,
       * so on a run downhill the next one started while the last was still
       * being digested and the backlog never came back to zero: the report's
       * "queued 190" beside "scrolls 245", and the lag and the black holes
       * underground are both that same backlog seen from different angles.
       * Waiting for the queue to be nearly drained cannot deadlock — the
       * queue drains on its own every frame whether she moves or not.
       */
      const digesting = this.queue.length > MESH_BUDGET * 4;
      if (!digesting && now - this.lastScrollAt > SCROLL_COOLDOWN_MS) {
        /*
         * The look-ahead rides her NOSE, not a compass bearing. `facing` is
         * `atan2(fwd.x, fwd.z)`, which is noise when her nose is near
         * vertical — down a shaft the horizontal part of it is almost
         * nothing and the bearing spins, so a full-length lead was being
         * flung in a random direction every frame. Using the nose's own
         * horizontal components shrinks the lead to nothing exactly when the
         * bearing stops meaning anything, which is the behaviour wanted.
         */
        const scroll = this.stream.recentreOn(
          this.at.x + this.fwd.x * lead,
          this.at.z + this.fwd.z * lead,
        );
        if (scroll) {
          this.lastScrollAt = now;
          this.onScroll(scroll);
        }
      }

      /* The budget breathes with the backlog: three per frame when caught
       * up, up to twelve when a scroll dumped work — a 200-deep queue must
       * drain in a second, not stay a permanent debt on a 20 fps phone. */
      const budget = Math.min(
        this.meshBudgetCapForTest,
        Math.min(12, Math.max(MESH_BUDGET, this.queue.length >> 4)),
      );
      let built = 0;
      const meshStart = performance.now();
      while (built < budget && this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.queued.delete(this.key(job.cx, job.cy, job.cz));
        this.meshChunk(job.cx, job.cy, job.cz);
        built += 1;
        /* One chunk ALWAYS lands, but the frame never spends more than
         * ~6 ms meshing — the playtest HUD's "last 74 ms" hitches were
         * this loop eating a whole scroll's backlog in one gulp. */
        /*
         * The slice grows with the backlog. Six milliseconds is right when
         * the queue is a handful, and far too polite when a scroll has just
         * dumped two hundred chunks: underground an unbuilt chunk is a hole
         * onto nothing, so the backlog is not just late scenery, it is the
         * black the report describes. Ten milliseconds for as long as the
         * pile is deep, six the rest of the time.
         */
        if (performance.now() - meshStart > (this.queue.length > 64 ? 10 : 6)) break;
      }
      this.reveal();
    }

    /* The crossover is deliberately not instant: breaking the surface is
     * one of the moments this game has, and half a second of contours
     * resolving into daylight is the whole of the effect. */
    if (this.sense) {
      this.sense.uSense.value += ((this.underground ? 1 : 0) - this.sense.uSense.value)
        * (1 - Math.exp(-SENSE_EASE * dt));
      /*
       * AND THE VOID BEHIND A MISSING CHUNK IS SOIL, NOT NOTHING.
       *
       * Underground, a chunk still in the mesh queue leaves a hole with the
       * clear colour behind it — sky above ground, and after a scroll, a
       * black gap in the tunnel wall. It cannot be meshed any sooner than it
       * is, but what shows through while it is pending can be the colour of
       * packed earth instead of the colour of nothing, which turns a hole
       * into a patch of unlit dirt. Eased on the same crossing the sense
       * shader uses, so surfacing does not flash.
       */
      (this.scene.background as THREE.Color)
        .copy(this.skyColour).lerp(SOIL_DARK, this.sense.uSense.value);
    }
    this.refreshAim();
    this.pose(dt);
    this.recordTelemetry(dt);
    // While the designer is up the camera is ITS fly rig, not the follow cam.
    if (!this.designer?.isOpen) this.aimCamera(dt);
  }

  /* ------------------------------------------------ chambers and the modes */

  /** The angle she is pointed, in degrees, live. */
  private refreshAim(): void {
    if (this.digMode && this.headingReadout && this.depthReadout) {
      /*
       * The bearing of the AIM, not of her body. On a trunk her nose points
       * at the sky and has no bearing worth printing; the line she is about
       * to cut along still does, right up until it goes plumb, and then it
       * holds rather than spinning on rounding.
       */
      const line = this.boreAim();
      const flat = Math.hypot(line.x, line.z);
      if (flat > 0.15) this.aimBearing = Math.atan2(line.x, line.z);
      const hdg = Math.round(((this.aimBearing * 180) / Math.PI + 360) % 360);
      const bearing = `${String(hdg).padStart(3, '0')}\u00b0`;
      if (this.headingReadout.textContent !== bearing) {
        this.headingReadout.textContent = bearing;
      }
      const down = Math.round(this.depthMm());
      const depth = down > 0 ? `\u25bc ${down} mm` : 'surface';
      if (this.depthReadout.textContent !== depth) {
        this.depthReadout.textContent = depth;
        this.depthReadout.classList.toggle('is-steep', down >= QUEST_DEPTH_MM);
      }
    }
    if (!this.aimReadout) return;
    /*
     * THE ANGLE IS READ AGAINST THE WORLD, whatever frame the stick works
     * in. `aimPitch` is her own pitch — nought means along her nose — and
     * printing that would have the dial say nought while she points at the
     * sky up a trunk. The rise of the actual aim line is the number an
     * altimeter would agree with.
     */
    const line = this.boreAim();
    const deg = Math.round(
      (Math.asin(Math.max(-1, Math.min(1, line.y))) * 180) / Math.PI,
    );
    const text = `${deg > 0 ? '+' : ''}${deg}°`;
    if (this.aimReadout.textContent !== text) this.aimReadout.textContent = text;
    this.aimReadout.classList.toggle('is-steep', deg <= -45);
  }

  /**
   * THE WALK, in her own frame: forward is along her nose, and down is
   * whatever she is standing on.
   *
   * Everything that used to make this hard was world +Y sneaking in. A floor
   * was "the soil below at this x,z", so a wall was a thing to be REFUSED
   * and then climbed at a fixed rate by a special case; a ceiling was not a
   * surface at all; and stepping off a lip left her hanging in the black
   * with nothing underneath, because "underneath" meant one fixed direction
   * that no longer pointed at any soil. Every one of those was a hand-off
   * between two ideas of down.
   *
   * There is one idea of down now and it is `up`, negated. She steps along
   * her nose, and `SurfaceWalker` seats her back onto the soil and turns her
   * up onto its normal — so a wall is a floor she is turning onto, a ceiling
   * is a floor she is under, and there is no case analysis anywhere for
   * either. Walking up out of a shaft is not a rule; it is what walking IS
   * once down points at the shaft's wall.
   */
  /**
   * WHAT THE GROUND IS DOING, ahead of her, under her and behind her.
   *
   * Three probes and no more. Each is a surface elevation measured ALONG
   * HER OWN UP at a point offset along her nose, using the same
   * `boreFrame().surface` the leg solver already uses — so on a trunk
   * "ahead" is further up the bark and "rise" is out of it, and none of
   * this needs to know a tree exists.
   *
   * The offsets are fractions of her body length, so a major anticipates in
   * proportion to herself. Cheap enough to run every frame: three surface
   * casts against the six the legs already pay for.
   */
  private readSpine(dt: number): SpinePose {
    const frame = this.boreFrame();
    if (!frame || !this.queenReady) return this.spine.pose;
    const body = this.queen.bodyLength();
    const ahead = body * PROBES.ahead;
    const behind = body * PROBES.behind;
    const up = this.up;
    const at = (along: number): number => {
      const px = this.at.x + this.fwd.x * along;
      const py = this.at.y + this.fwd.y * along;
      const pz = this.at.z + this.fwd.z * along;
      /* Elevation ALONG HER UP, which is what makes this frame-relative. */
      return frame.surface(px, py, pz) - (px * up.x + py * up.y + pz * up.z);
    };
    const here = at(0);
    /*
     * THE RISES ARE FILTERED, because the surface they come off is a
     * LATTICE and the baseline is short.
     *
     * Measured walking: the raw rises land on multiples of a sixteenth of a
     * millimetre — the lattice's own step — and over a 1.8 mm baseline one
     * of those steps is two degrees of head. The full +-0.9 mm range the
     * ground actually produced swung the target 26 degrees, at frame rate.
     * That is quantisation, not terrain, and converting it to an angle
     * first only magnifies it.
     *
     * So the elevation differences are low-passed before they become
     * angles. This is not the spine's own smoothing — that shapes the
     * TRAIN, and no amount of it can help when the target itself is noise.
     */
    const rawAhead = at(ahead) - here;
    const rawBehind = at(-behind) - here;
    const k = 1 - Math.exp(-RISE_RATE * Math.max(0, dt));
    this.riseAhead += (rawAhead - this.riseAhead) * k;
    this.riseBehind += (rawBehind - this.riseBehind) * k;
    const wantAhead = this.riseAhead;
    const wantBehind = this.riseBehind;
    /*
     * The proximity floor: how much daylight each end has, measured the
     * same way. `SPINE_CLEARANCE` is a hundredth of a millimetre, so this
     * only ever fires when anticipation has already failed.
     */
    /*
     * TWO DIFFERENT QUESTIONS, ASKED TWO DIFFERENT WAYS.
     *
     * The rises above are terrain DIFFERENCES and say where a section
     * should point. The clearances below are MEASURED distances from a
     * drawn shell to solid and say whether it is about to touch anything.
     * Deriving the second from the sign of the first was a category error
     * that fired the emergency bias on 89% of walking frames.
     */
    const reading: SpineReading = {
      aheadRise: wantAhead,
      behindRise: wantBehind,
      headClear: (this.headClearMm = this.shellClearance('head')),
      gasterClear: this.shellClearance('gaster'),
      /*
       * The one thing a rise cannot say. Rounding onto a trunk her probes
       * both read exactly zero — the bark ahead of her is at the same height
       * in her own frame as the bark under her — so without this her back is
       * a plank through the only manoeuvre it exists for. The gait already
       * knows the angle; it just had nowhere to send it.
       */
      fold: this.driveReport?.corner.fold ?? 0,
      /*
       * The tail does not relax on the neck's schedule. While the rear feet
       * have yet to cross — the transfer phases — the gaster is still
       * sweeping the surface she is leaving, so its lift holds at the
       * corner's full character even as the attitude angle spends itself.
       * See `SpineReading.tailFold`.
       */
      tailFold: (() => {
        const c = this.driveReport?.corner;
        if (!c) return undefined;
        return c.phase === 'transferMiddle' || c.phase === 'transferRear'
          ? Math.max(c.fold, TAIL_HOLD_RAD)
          : c.fold;
      })(),
    };
    /* Millimetres converted ONCE, here at the boundary — everything inside
     * `posture` is then in the same units as the reading it was handed. */
    const want = posture(reading, ahead, behind, undefined, {
      soft: CLEARANCE_MM.soft / MM,
      hard: CLEARANCE_MM.hard / MM,
    });
    /* Diagnostics for `shot-spine.mjs` — every input and both outputs, so
     * the bobbing can be attributed rather than guessed at. */
    this.spineRead = reading;
    this.spineWant = want;
    return this.spine.follow(want, dt);
  }

  /**
   * HOW MUCH AIR A BODY SEGMENT'S SHELL HAS, along her own down.
   *
   * Against the unioned solid field — soil, landmark, scrub, dug tunnel
   * wall — so it works on a ceiling and upside down with no per-object
   * branch anywhere. `Infinity` when nothing is within reach, which is the
   * ordinary case and must contribute nothing.
   *
   * The shell RADIUS is subtracted, which `groundGuard` deliberately does
   * not do: there the number drives a rigid lift of the whole model and a
   * radius over-reports, floating all six planted feet. Here it drives a
   * bend of one segment, and over-reporting is the safe direction.
   */
  private shellClearance(which: 'head' | 'gaster'): number {
    if (!this.queenReady) return Infinity;
    const radius = this.queen.segmentShell(which, S_SPOT);
    if (radius < 0) return Infinity;
    /*
     * HALF THE RADIUS, and that is a calibration rather than a guess.
     *
     * `groundGuard`'s own note says why the whole radius is wrong: it is
     * the widest the mesh gets ANYWHERE around that bone, and subtracting
     * it straight down assumes the widest part hangs directly below. On the
     * gaster that radius is 1.53 mm — most of her abdomen — and using it
     * reported -0.53 to -1.53 mm of clearance on flat ground she is
     * visibly not clipping through. I reproduced the exact mistake that
     * comment warns about.
     *
     * Measured: standing on the flat her gaster bone sits about 1.0 mm off
     * solid and nothing shows, so whatever actually hangs below that bone
     * is under 1.0 mm — under two thirds of the radius. Half is inside
     * that and still conservative.
     */
    const shell = radius * SHELL_SHARE;
    const up = this.up;
    const reach = SHELL_REACH;
    const step = CELL_SIZE * 0.5;
    let clear = Infinity;
    for (let d = 0; d <= reach; d += step) {
      if (this.soilSolidAt(
        S_SPOT.x - up.x * d, S_SPOT.y - up.y * d, S_SPOT.z - up.z * d,
      )) { clear = d - shell; break; }
    }
    /*
     * THE HEAD ALSO LOOKS WHERE SHE IS GOING.
     *
     * `CLEARANCE_MM`'s own words are "what is in front of it", and along
     * her down that is true of the ground but never of a wall: marching
     * down from the head spot, a vertical face ahead reads clear on one
     * frame and half a millimetre INSIDE on the next — a cliff, not a
     * ramp — and no follow rate can answer a warning that arrives after
     * the touch. Measured at the trunk corner: 4.01 mm to 0.01 mm in one
     * frame at walking pace. So the head takes the nearer of two
     * questions, below and AHEAD, and the wall becomes the same gentle
     * ramp the ground always was — the bias starts easing her face up
     * while it is still a millimetre out. The gaster keeps the single
     * probe: what it drags over is always beneath it.
     */
    if (which === 'head') {
      const fwd = this.fwd;
      for (let d = 0; d <= reach; d += step) {
        if (this.soilSolidAt(
          S_SPOT.x + fwd.x * d, S_SPOT.y + fwd.y * d, S_SPOT.z + fwd.z * d,
        )) { clear = Math.min(clear, d - shell); break; }
      }
    } else {
      /*
       * THE GASTER LOOKS WHERE IT TRAILS — the head's own fix, mirrored.
       * "What it drags over is always beneath it" is true in steady state
       * and false in the one manoeuvre that clips it: mid-fold her frame
       * has already rotated onto the new face, so the floor the tail is
       * still sweeping lies AFT along -forward, not below — the same
       * cliff-not-ramp blindness the head's second probe cured, arriving
       * from behind. Reported as the abdomen clipping through the ground
       * during the transition, which is exactly this probe's blind spot.
       */
      const fwd = this.fwd;
      for (let d = 0; d <= reach; d += step) {
        if (this.soilSolidAt(
          S_SPOT.x - fwd.x * d, S_SPOT.y - fwd.y * d, S_SPOT.z - fwd.z * d,
        )) { clear = Math.min(clear, d - shell); break; }
      }
    }
    return clear;
  }

  /**
   * How much higher she should ride because she is standing on WOOD.
   *
   * Nought on soil. On a trunk it is two thirds of the facet sagitta —
   * `r (1/cos(pi/sides) - 1)` at twenty sides is 1.23% of the radius, and
   * averaging that over a facet is about two thirds of the peak. The radius
   * is read off the collision itself rather than guessed: march out along
   * her own up until the wood ends, which is the local skin depth and needs
   * no knowledge of which tree she is on.
   */
  private moveSurface(dt: number, speed: number): void {
    const walker = this.walker;
    if (!walker) return;
    const span = SPAN_MM / MM;

    /*
     * THE LEGS MOVE HER, once she has any.
     *
     * The stick proposes a shove and a spin; the planted feet refuse what
     * they cannot reach; what survives is her displacement. That is what
     * makes the gait match the ground — the cycle and the travel come out
     * of the same step rather than being two numbers hoped into agreement,
     * which is what the skating was. Sliding her along her nose is the
     * fallback for the first second, before her model has loaded.
     */
    /*
     * A DODGE IS THE ORDINARY MOVEMENT WITH DIFFERENT NUMBERS IN IT.
     *
     * It is mixed into the same walk/strafe/speed the stick fills and
     * handed to the same drive, which is the whole point: the burst then
     * inherits the surface frame, the foot clip, the collision and the
     * measured-speed gait without any of them being told a dodge exists.
     * On a trunk "left" is along the bark because `forward` and `up` are
     * hers, not the world's.
     *
     * `authority` eases from one to nought over the tail of the burst, so
     * control returns to whatever the thumb is asking for by then rather
     * than snapping back to it.
     */
    const burst = this.dodge.sample(dt);
    const stickSpeed = WALK_SPEED * (this.input.sprint ? SPRINT : 1);
    const w = burst.authority;
    const walk = this.input.walk + (burst.forward - this.input.walk) * w;
    const strafe = this.input.strafe + (burst.side - this.input.strafe) * w;
    const pace = burst.active
      ? stickSpeed + (burst.speed - stickSpeed) * w
      : stickSpeed;

    if (this.drive) {
      this.driveReport = this.drive.step(
        dt,
        { at: this.at, up: this.up, forward: this.fwd },
        {
          walk,
          strafe,
          /* Told, not obeyed: the rig has already turned her this frame and
           * the gait still has to step for it. See `DriveInput.spin`. */
          yaw: -this.input.yaw,
          spin: false,
          speed: pace,
          yawRate: TURN_RATE,
          /* The walker seats her: two systems both deciding how high she
           * rides do not average out, they fight. */
          settle: false,
          /*
           * A DODGE MAY NOT STAGE A CLIMB, and neither may a dig stroke.
           *
           * The drive is handed one walk and one strafe and cannot tell a
           * burst from a thumb, which is the whole virtue of mixing the
           * dodge in up there — and it is exactly why the veto has to be
           * said here, where the difference is still known. A flick that
           * happens to point at bark is an evasion, not a decision to go
           * up; a mandible stroke is not travel at all.
           */
          mayTransition: !burst.active && !this.input.dig,
        },
        this.groundForLegs,
      );
    } else {
      this.at.addScaledVector(this.fwd, walk * pace * dt);
      if (strafe !== 0) {
        /* `up x fwd` is her model +X, which is screen-LEFT — hence the
         * minus. Same convention as `DriveInput.strafe`. */
        const side = S_RIGHT.crossVectors(this.up, this.fwd).normalize();
        this.at.addScaledVector(side, -strafe * pace * dt);
      }
    }
    this.at.x = Math.min(span - 2, Math.max(2, this.at.x));
    this.at.z = Math.min(span - 2, Math.max(2, this.at.z));

    /*
     * ATTITUDE HOLDS STILL WHILE THE JAWS ARE WORKING.
     *
     * Digging takes the ground out from under her, so the normal the grip
     * finds flips between the floor, the fresh rim and the wall several
     * times a second — and her up steers the cast that found it, which is a
     * feedback loop no rate limit can tame. Frozen for the frames a stroke
     * is actually cutting; free the rest of the time, which is when
     * cornering happens anyway.
     */
    const aimDt = this.input.dig && this.underground ? 0 : dt;
    /*
     * WOOD IS DRAWN PROUD OF ITS OWN COLLISION, so she rides a little
     * higher on it.
     *
     * The trunk's collision is the round cone — a circle at every height.
     * The mesh is a polygon whose flats are TANGENT to that circle, which
     * is what stopped her hovering, but it means the drawn bark stands out
     * from the collision by up to a facet's sagitta, and she seats on the
     * collision. Measured on the landmark: her claws sat 2.7 mm inside the
     * picture — reported as "still in the tree, but a lot closer".
     *
     * The lift is the mean of that excess rather than its worst, so she
     * sits on the bark whichever way round the trunk she is, and it is
     * applied ONLY where the thing under her is wood. Soil has no facets
     * and already measured 0.28 mm, which is contact; lifting her there
     * would put the hovering back on the ground instead.
     */
    /* One height law everywhere now: her legs' own rest plane, plus the
     * hundredth of a millimetre of air that keeps her out of the ground. */
    (walker.tune as { ride: number }).ride = this.legRide + FOOT_AIR;
    /*
     * THE SEATING, MEASURED — how much the WALKER moved her this frame, as
     * distinct from how much her legs did.
     *
     * The two are separate authorities over the same body: the legs drive her
     * along the ground and the walker re-seats her onto it, easing toward the
     * seat point every frame. A recording that only shows clearance cannot say
     * which of them produced a bob, and "she sinks and pops back" is a
     * completely different bug depending on the answer. So the position is
     * snapped either side of the call and the difference along her up is kept.
     */
    this.seatFrom.copy(this.at);
    /*
     * STILL means the PLAYER is asking for nothing and no corner is being
     * worked. Only then may the walker's dead-band refuse the sub-band seat
     * corrections that, at rest, are pure noise — at 22 Hz and a tenth of a
     * millimetre, the vibration — but that in motion are the very steps a
     * corner is made of.
     */
    /* 'normal' IS the idle phase — every other value means a corner is in
     * hand. (The telemetry's 'none' is its own placeholder for "no drive
     * yet", not a phase the drive ever reports.) */
    const still = Math.abs(this.input.walk) < 0.01
      && Math.abs(this.input.strafe) < 0.01
      && Math.abs(this.input.yaw) < 0.01
      && (this.driveReport?.corner.phase ?? 'normal') === 'normal';
    /*
     * THE CORNER'S PRE-TILT. The moment a front grip holds the new face the
     * drive reports a lean, and the walker bends her attitude goal toward
     * the wall by that share — shoulders rising while the front feet take
     * hold, the way an ant actually enters a climb. This is what lifts the
     * head clear of the bark during the flat approach; see
     * `CornerTurn.leanToward`.
     */
    const leanShare = this.drive ? this.drive.cornerLean(S_LEAN) : 0;
    walker.settle(
      { at: this.at, up: this.up, forward: this.fwd }, dt, aimDt, still,
      leanShare > 0 ? { toward: S_LEAN, share: leanShare } : undefined,
    );
    this.seatLiftMm = this.seatFrom.sub(this.at).dot(this.up) * -VOXEL_MM;

    /*
     * The safety net is smaller than it was, because most of what it caught
     * cannot happen any more: there is no "off the modelled window" — the
     * density answers everywhere — and no "no floor below at this x,z",
     * because below is wherever she is standing. What is left is genuinely
     * being inside soil, which the walker's own embedded case handles first
     * and this only backs up.
     */
    /*
     * Tested WELL above her origin, because her origin is not the lowest
     * part of her — the rig puts its sole plane through it, so a correctly
     * seated ant has her root a fraction inside the surface — AND because
     * the surface itself is a millimetre lattice. Walking up even a gentle
     * slope, the density surface under her jumps by whole cell steps as she
     * crosses cell boundaries, so a healthy seated origin transiently sits
     * over a millimetre deep. The old half-millimetre probe read every such
     * step as a burial: three frames of it and she was snapped back to
     * lastSafe, which on a slope she is walking UP means snapped backward —
     * a permanent treadmill, felt as "stuck for some reason", eighteen
     * millimetres from spawn, with the drive reporting full speed the whole
     * time. Reproduced deterministically and gone at two millimetres.
     *
     * Two millimetres is still far inside anything that has actually
     * swallowed her: a collapse or a fall into soil buries the whole body,
     * and her trunk is four millimetres through.
     */
    const probeUp = 2 / MM;
    if (this.soilDensityAt(
      this.at.x + this.up.x * probeUp,
      this.at.y + this.up.y * probeUp,
      this.at.z + this.up.z * probeUp,
    ) > 0) {
      // Three CONSECUTIVE bad frames means it is real. One is usually the
      // rounding flickering while she hugs a curved wall — snapping on that
      // yanked her off the shaft wall mid-climb, every climb.
      this.embedFrames += 1;
      if (this.embedFrames >= 3 && this.hasSafe) {
        this.at.copy(this.lastSafe);
        this.embedFrames = 0;
      }
    } else {
      this.embedFrames = 0;
      this.lastSafe.copy(this.at);
      this.hasSafe = true;
    }
  }

  /** The way she is pointed AND pitched — the line the bore cuts and, while
   *  she is engaged in one, the line she travels. */
  private boreAim(): THREE.Vector3 {
    /*
     * SHE DIGS WHERE YOU ARE POINTING HER, and the pointing keeps still
     * until you change it. Dragging up and down sets it in either view —
     * no buttons, no gauge — and the camera follows it rather than setting
     * it, which is the way round that stops "forward" quietly meaning
     * "into the floor".
     */
    /*
     * PITCHED IN HER OWN FRAME — and READ against the world.
     *
     * Both halves matter, and putting both in the same frame is what went
     * wrong. The gauge has to be world-referenced: it is a depth
     * instrument, and a depth measured against whatever slope she happens
     * to be on tells you nothing. But the CONTROL cannot be, because the
     * camera looks down this line: build it from a compass bearing and she
     * is clinging to a vertical trunk with a bearing that has been frozen
     * since the last time she was upright, so the view unhooks from her
     * body and panning turns something that is not the ant.
     *
     * So the aim is a rotation between her nose and her back, which the
     * view can ride, and `refreshAim` reports the world angle OF that line.
     * Nose-first up a trunk then reads +90 on the dial, which is exactly
     * what was asked for — the number is world, the stick is hers.
     */
    /*
     * IN HER EYES, THE CUT IS WHATEVER THE CROSSHAIR COVERS.
     *
     * The crosshair sits at the centre of the frame, and the frame is now
     * built on her HEAD's forward rather than her body's — so the cut has
     * to run down that same line or the two disagree by the whole of the
     * spine's lean the moment she is on a slope. `lookDir` is the vector
     * the lens was actually built from, written by `aimCamera` each frame
     * it draws a first-person view.
     *
     * Third person keeps the body-frame aim: there the crosshair is hidden
     * and the shovel's line is hers, not the camera's.
     */
    if (this.firstPerson && this.lookDir.lengthSq() > 1e-9) {
      return new THREE.Vector3().copy(this.lookDir).normalize();
    }
    const cp = Math.cos(this.aimPitch);
    return new THREE.Vector3().copy(this.fwd).multiplyScalar(cp)
      .addScaledVector(this.up, Math.sin(this.aimPitch));
  }

  /**
   * ONE STROKE OF THE SHOVEL: a mouthful 10 mm wide, 5 mm tall and 3 mm
   * deep, taken at her jaws, along the way she is pointed.
   *
   * Wider than she is, and that is the point — a stroke opens something
   * she can WALK into rather than something she has to be threaded
   * through. It is what let the body capsule go: nothing needs to check
   * whether she fits, because at ten millimetres across a nine-millimetre
   * ant always does.
   */
  private bite(): void {
    const aim = this.boreAim();
    /*
     * AT HER JAWS, or at the front of her while the model is still
     * loading. `jawPosition` is the real mandible tip where the rigger
     * gave her one; the fallback is a nose-length along the aim, so the
     * first frames of a session dig where every frame after them does.
     */
    /*
     * ON THE AIM LINE THROUGH HER CENTRE — never on the jaw BONE.
     *
     * The bone is the obvious anchor and it is the wrong one, twice over.
     * It rides the visual model, which sits above her centre-line and
     * lags her by a frame of easing, so the cut opened ABOVE where the
     * crosshair pointed — reported as aiming high, and settling onto the
     * crosshair only once the model had bedded into the tunnel and its
     * jaw had come down to the line. And the same offset means a bone-
     * anchored tunnel runs parallel to her path a few millimetres aside,
     * which is its own old bug.
     *
     * So the bone is allowed to say how FAR along the aim her jaws are,
     * and nothing else. The cut is centred on the ray the camera looks
     * down, so what the crosshair covers is what disappears.
     */
    const centre = new THREE.Vector3();
    let hull = NOSE_REACH + JAW_PAST_NOSE;
    if (this.queenReady && this.queen.jawPosition(centre)) {
      hull = Math.max(hull, centre.sub(this.at).dot(aim));
    }
    this.biteCentre(aim, hull, centre);

    let touched = 0;
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    /*
     * Two scoops, one at the face and one a depth further in, so a HELD
     * stroke cuts a continuous tube rather than a string of beads — the
     * brush is only three millimetres deep and her stride outruns a
     * single one on the first step.
     */
    for (let i = 0; i < 2; i += 1) {
      const at = S_CENTER.copy(centre).addScaledVector(aim, (i * SCOOP_DEEP_MM) / MM);
      const result = this.stream!.subtractEllipsoid(at, aim, {
        deep: SCOOP_DEEP_MM / 2 / MM,
        wide: SCOOP_WIDE_MM / 2 / MM,
        tall: SCOOP_TALL_MM / 2 / MM,
      });
      if (result.changedSamples === 0) continue;
      touched += result.changedSamples;
      const bb = result.bounds;
      minX = Math.min(minX, bb.minX); maxX = Math.max(maxX, bb.maxX);
      minY = Math.min(minY, bb.minY); maxY = Math.max(maxY, bb.maxY);
      minZ = Math.min(minZ, bb.minZ); maxZ = Math.max(maxZ, bb.maxZ);
    }
    this.biteTouched = touched > 0;
    if (touched === 0) return;
    /*
     * AND SHAVE WHAT WAS JUST CUT, in the same stroke.
     *
     * This ran automatically once before and had to be pulled out,
     * because the brush could fill as well as shave and it brought roofs
     * down on tunnels barely wider than she is. One-way, it cannot: soil
     * is only ever removed, so the worst a stroke can do is open the hole
     * slightly wider than intended, which is the failure you want. So the
     * two are one action again — cut, then round off what the cut left.
     */
    const relaxed = this.smoothAround(centre);
    if (relaxed) {
      minX = Math.min(minX, relaxed.minX); maxX = Math.max(maxX, relaxed.maxX);
      minY = Math.min(minY, relaxed.minY); maxY = Math.max(maxY, relaxed.maxY);
      minZ = Math.min(minZ, relaxed.minZ); maxZ = Math.max(maxZ, relaxed.maxZ);
    }
    // Work done at depth is chamber-building, whatever she calls it.
    if (this.depthMm() >= QUEST_DEPTH_MM * 0.7) this.deepCarved += touched;

    /*
     * THE CUT IS DRAWN THIS FRAME, NOT WHEN THE QUEUE GETS ROUND TO IT.
     *
     * The density changes the instant the scoop lands, and her body and
     * feet answer to the density — she steps down onto the new floor at
     * once. The PICTURE used to answer to the queue, and while digging the
     * queue runs one to two HUNDRED chunks deep (measured 140-213), which
     * at three to twelve chunks a frame is up to a second and a half of
     * lag. For that second the screen still draws the floor she just
     * removed, with her standing the best part of a scoop below it —
     * reported as "falls halfway into the terrain", with her legs planted
     * on ground the picture claims is solid. The physics was measured
     * clean the whole time (worst 0.4 mm); only the drawing was late.
     *
     * A scoop touches a couple of dozen chunks at most, so they are meshed
     * HERE, synchronously — the backlog behind them can take its time, but
     * what the shovel just changed is never allowed to be stale.
     */
    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
    const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
    for (let cz = lo(minZ); cz <= hi(maxZ, CHUNKS_XZ); cz += 1) {
      for (let cy = lo(minY); cy <= hi(maxY, CHUNKS_Y); cy += 1) {
        for (let cx = lo(minX); cx <= hi(maxX, CHUNKS_XZ); cx += 1) {
          const key = this.key(cx, cy, cz);
          if (this.queued.has(key)) {
            /* Already waiting in line: pull it out — it is done now. */
            this.queued.delete(key);
            const at = this.queue.findIndex(
              (j) => j.cx === cx && j.cy === cy && j.cz === cz,
            );
            if (at >= 0) this.queue.splice(at, 1);
          }
          this.meshChunk(cx, cy, cz);
        }
      }
    }
    this.reveal();
  }

  /**
   * HOW FAR ALONG THE AIM THE SCOOP SITS — where it MEETS SOIL, not at a
   * fixed arm's length.
   *
   * Her jaws are about five millimetres out and the scoop is three deep, so
   * an anchor pinned to her reach is entirely INSIDE the hill the moment
   * she is closer to a face than that. It still carves: it opens a bubble a
   * few millimetres in, sealed behind an unbroken wall, so nothing appears
   * to happen — and stepping BACK until the scoop straddles the surface is
   * what made it work again. Reported exactly that way: right up against
   * dirt it will not dig, back up and it will.
   *
   * So the ray is walked out from her centre to the first soil it meets and
   * the scoop is seated a half-depth past that, which puts its near lip in
   * the air on this side of every face however close she is. Finding no
   * soil inside her reach means she is aiming at open sky, and the arm's
   * length is the honest answer again — that is the stroke that misses, and
   * it should.
   *
   * The preview draws from this same number, so what the ghost promises is
   * what the stroke takes.
   *
   * SOIL ONLY. The walker's field has the tree unioned into it so she can
   * climb the thing, but the shovel edits the voxel field and a tree is not
   * in it — aiming at bark would find "solid", cut nothing, and read as the
   * dig being broken again. Wood is not diggable, so the shovel does not
   * see it.
   */
  private biteCentre(aim: THREE.Vector3, reach: number, out: THREE.Vector3): boolean {
    const step = CELL_SIZE * 0.5;
    const far = reach + SCOOP_DEEP_MM / MM;
    for (let d = 0; d <= far; d += step) {
      const x = this.at.x + aim.x * d;
      const y = this.at.y + aim.y * d;
      const z = this.at.z + aim.z * d;
      if (this.groundSolidAt(x, y, z)) {
        out.set(x, y, z).addScaledVector(aim, SCOOP_DEEP_MM / 2 / MM);
        return true;
      }
    }
    /*
     * NOTHING ALONG THE AIM — SO DIG THE GROUND SHE IS ON.
     *
     * Measured on a hillside, aiming level: thirty millimetres of the ray
     * ahead of her is air, every sample, because she stands a body-height
     * off a surface that falls away in front of her. The stroke was seated
     * at arm's length in that air and removed nothing, which is the press
     * that does nothing — and at zero degrees, which is where the dial
     * starts and where "dig the entrance" begins.
     *
     * She is standing ON soil, though, and her jaws can reach it. So the
     * fallback drops from arm's length along her own down until it finds
     * the floor, and centres the scoop on it: half the mouthful is under
     * the surface, which is a scrape. That is what an ant aiming level at
     * a hillside actually does.
     */
    out.copy(this.at).addScaledVector(aim, reach);
    for (let d = 0; d <= RIDE * 4; d += step) {
      const x = out.x - this.up.x * d;
      const y = out.y - this.up.y * d;
      const z = out.z - this.up.z * d;
      if (this.groundSolidAt(x, y, z)) {
        out.set(x, y, z);
        return true;
      }
    }
    /* Air ahead and air below it: she is over a drop, and this stroke is a
     * genuine miss. Left at arm's length so the ghost still shows where. */
    return false;
  }

  /** Builder ids are `b{k}-{i}` and `b{k}-e{i}` — how its half of a merged
   *  plan is told apart from anything the designer or a probe authored. */
  private static isBuilderId(id: string): boolean {
    return /^b\d+-/.test(id);
  }

  /**
   * Shave the bumps around a point, and only ever OUTWARD.
   *
   * A blur moves a surface both ways: it takes off the ridges that poke
   * into a tunnel, and it fills the hollows — and the filling is how a
   * roof comes down on a passage barely wider than the animal in it.
   * One-way, soil may be removed and never added, so narrowing is not
   * unlikely but arithmetically impossible. That is what lets this run on
   * every stroke instead of being a tool you have to remember to use.
   */
  private smoothAround(centre: THREE.Vector3): { minX: number; minY: number;
    minZ: number; maxX: number; maxY: number; maxZ: number } | null {
    if (!this.stream) return null;
    const box = this.stream.boxAround(centre, this.brushMm / MM);
    let touched = null;
    for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) {
      const done = this.stream.smoothBox(box, SMOOTH_STRENGTH, SMOOTH_MAX_SHIFT, true);
      if (!done) break;
      touched = done;
    }
    return touched;
  }

  /**
   * THE GHOST: where the next press will act, shown before it acts.
   *
   * Both tools work at arm's length down a line you cannot see, which is
   * a guess dressed as an aim. Drawn, the dig is the pair of scoops it
   * actually removes and the smoothing is the ball it actually relaxes,
   * so the slider has something to be a slider FOR.
   */
  private updateToolGhost(): void {
    const show = this.digMode && this.ready;
    if (!show) {
      if (this.toolGhost) this.toolGhost.visible = false;
      if (this.smoothGhost) this.smoothGhost.visible = false;
      return;
    }
    const make = (colour: number, opacity: number): THREE.Mesh => {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 20, 14),
        new THREE.MeshBasicMaterial({
          color: colour, wireframe: true, transparent: true, opacity,
          depthTest: false,
        }),
      );
      mesh.renderOrder = 9;
      this.scene.add(mesh);
      return mesh;
    };
    if (!this.toolGhost) this.toolGhost = make(0xe9c36f, 0.5);
    if (!this.smoothGhost) this.smoothGhost = make(0x6fc8e9, 0.22);

    const aim = this.boreAim();
    /* The same spot the stroke uses, so the ghost cannot promise a hole
     * somewhere the cut will not make one — including the scrape it falls
     * back to when the aim itself meets nothing. */
    const spot = S_SPOT;
    const willBite = this.biteCentre(aim, NOSE_REACH + JAW_PAST_NOSE, spot);

    /* The CUT, as the pair of scoops it actually removes — wide and low,
     * her real mouthful shape, because a round marker would promise a
     * hole of entirely the wrong proportions. */
    const span = (SCOOP_DEEP_MM * 2) / MM;
    S_FWD.copy(aim);
    /* Across her, in HER frame. A right vector built out of world Y —
     * `(aim.z, 0, -aim.x)` — is the ghost lying flat against the horizon
     * while the wide scoop it stands for is lying flat against the wall
     * she is on, and it degenerates outright on a plumb aim. */
    S_RIGHT.crossVectors(S_FWD, this.up);
    if (S_RIGHT.lengthSq() < 1e-8) S_RIGHT.set(S_FWD.z, S_FWD.x, S_FWD.y);
    S_RIGHT.normalize();
    S_UP.crossVectors(S_RIGHT, S_FWD).normalize();
    const cut = this.toolGhost;
    cut.visible = true;
    cut.quaternion.setFromRotationMatrix(S_MAT.makeBasis(S_RIGHT, S_UP, S_FWD));
    cut.scale.set(SCOOP_WIDE_MM / 2 / MM, SCOOP_TALL_MM / 2 / MM, span / 2);
    cut.position.copy(spot);
    /* A stroke that will remove nothing says so, rather than drawing a
     * confident hole over open air. */
    (cut.material as THREE.MeshBasicMaterial).opacity = willBite ? 0.5 : 0.16;

    /* And the SHAVE around it, which is what the slider sizes. Fainter,
     * because it only rounds off what the cut leaves — it is the halo of
     * the stroke, not the stroke. */
    const halo = this.smoothGhost;
    halo.visible = true;
    halo.quaternion.identity();
    halo.scale.setScalar(this.brushMm / MM);
    halo.position.copy(spot);
  }

  /** Remesh every chunk a brush result touched — bite()'s own loop, shared. */
  private enqueueBounds(b: {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  }): void {
    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
    const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
    for (let cz = lo(b.minZ); cz <= hi(b.maxZ, CHUNKS_XZ); cz += 1) {
      for (let cy = lo(b.minY); cy <= hi(b.maxY, CHUNKS_Y); cy += 1) {
        for (let cx = lo(b.minX); cx <= hi(b.maxX, CHUNKS_XZ); cx += 1) {
          this.enqueue(cx, cy, cz);
        }
      }
    }
  }

  /* ----------------------------------------------------- the nest's save */

  /* ------------------------------------------------- the tunnel designer */

  /**
   * DIG opens the DESIGNER — the tunnel system is how new tunnels get made.
   * Built fresh each open: its working box is fitted around wherever the
   * plan has grown to, with room to grow on every side.
   */
  openDesigner(): void {
    if (!this.soil || !this.ready || this.designer?.isOpen) return;
    /* A nestless island (the founding dig) has no plan to bound — the
     * working box grows around HER instead, sitting on the ground she
     * stands on, so the first nest is dug where the queen is. */
    const here: { min: number[]; max: number[] } = (() => {
      const xMm = this.at.x * MM;
      const zMm = this.at.z * MM;
      const gMm = this.groundHeightAt(this.at.x, this.at.z) * MM;
      return { min: [xMm, gMm, zMm], max: [xMm, gMm, zMm] };
    })();
    const b = planBounds(this.soil.plan) ?? here;
    const PAD = 160;
    /*
     * The box must be TALL enough that an entrance dragged anywhere in its
     * footprint can reach the terrain there — on the summit the ground
     * rises and falls tens of millimetres across one box, and a mouth
     * clamped short of the surface is floating or buried, the exact thing
     * ground-snap exists to prevent. Sample the drawn surface across the
     * footprint and take the box to it.
     */
    const bx0 = b.min[0] - PAD;
    const bx1 = b.max[0] + PAD;
    const bz0 = b.min[2] - PAD;
    const bz1 = b.max[2] + PAD;
    let terrainMin = Infinity;
    let terrainMax = -Infinity;
    for (let j = 0; j <= 8; j += 1) {
      for (let i = 0; i <= 8; i += 1) {
        const h = this.renderedHeightAtMm(
          bx0 + ((bx1 - bx0) * i) / 8, bz0 + ((bz1 - bz0) * j) / 8,
        );
        terrainMin = Math.min(terrainMin, h);
        terrainMax = Math.max(terrainMax, h);
      }
    }
    this.designOriginMm.set(
      bx0, Math.min(b.min[1] - PAD, terrainMin - 48), bz0,
    );
    const blockMm = {
      x: bx1 - this.designOriginMm.x,
      y: Math.max(b.max[1] + 48, terrainMax + 48) - this.designOriginMm.y,
      z: bz1 - this.designOriginMm.z,
    };
    /*
     * THE FOUNDING SEED: a nestless island's first DIG does not open an
     * empty drawing and wait for the player to guess that PLACE comes
     * first — it seeds the entrance at the queen's own feet, grounded on
     * the drawn surface, and opens the tools around it already selected.
     * The queen digs where the queen is.
     */
    let local = this.shiftPlan(this.soil.plan, -1);
    let seeded = false;
    if (!local.nodes.some((n) => n.kind === 'entrance')) {
      local = addNode(local, 'entrance', {
        x: this.at.x * MM - this.designOriginMm.x,
        y: this.renderedHeightAtMm(this.at.x * MM, this.at.z * MM)
          - this.designOriginMm.y,
        z: this.at.z * MM - this.designOriginMm.z,
      }).plan;
      seeded = true;
    }
    this.designer?.dispose();
    this.designer = new NestDesigner(
      this.scene, this.camera, this.renderer.domElement, this.hud,
      {
        mmPerUnit: MM,
        origin: new THREE.Vector3(
          this.designOriginMm.x / MM, this.designOriginMm.y / MM, this.designOriginMm.z / MM,
        ),
        blockMm,
        /* The drawn island surface, in plan-local mm — what entrance nodes
         * snap to. Drawn, not bilinear: a mouth must sit on the ground the
         * player SEES (the walker's own hard-won rule). */
        groundMm: (xMm, zMm) => this.renderedHeightAtMm(
          this.designOriginMm.x + xMm, this.designOriginMm.z + zMm,
        ) - this.designOriginMm.y,
        /* The founding mouth lands at HER feet, not ahead of the camera. */
        antMm: {
          x: this.at.x * MM - this.designOriginMm.x,
          y: this.at.y * MM - this.designOriginMm.y,
          z: this.at.z * MM - this.designOriginMm.z,
        },
      },
      {
        build: (plan) => this.applyPlan(this.shiftPlan(plan, 1)),
        close: () => this.closeDesigner(),
      },
      local,
    );
    /* Everything stops (the block scene's rule): the stick is released, the
     * jaws are off, and the camera is the designer's until DONE. */
    this.input.walk = 0;
    this.input.yaw = 0;
    this.input.dig = false;
    this.stickPointer = null;
    this.lookPointer = null;
    this.stickEl.style.display = 'none';
    if (this.nestView) this.nestView.root.visible = false;
    /* A seeded mouth is an EDIT — DONE must carve it even untouched, or
     * the founding dig would quietly evaporate on close. */
    this.designer.show(local, { dirty: seeded });
  }

  private closeDesigner(): void {
    if (!this.designer) return;
    /* DONE with unbuilt changes carves them — a designer that can lose the
     * nest you just drew is worse than one that occasionally digs. */
    if (this.designer.hasUnbuilt) this.applyPlan(this.shiftPlan(this.designer.current(), 1));
    this.designer.hide();
    this.designer.dispose();
    this.designer = null;
    if (this.nestView) this.nestView.root.visible = this.showPlan;
  }

  /** The plan, translated into (+1) or out of (-1) the island's absolute mm. */
  private shiftPlan(plan: NestPlan, sign: 1 | -1): NestPlan {
    const o = this.designOriginMm;
    return {
      nodes: plan.nodes.map((n) => ({
        ...n, x: n.x + sign * o.x, y: n.y + sign * o.y, z: n.z + sign * o.z,
      })),
      edges: plan.edges.map((e) => ({ ...e })),
    };
  }

  /**
   * DIG IT: the plan becomes the world. One representation — the soil is
   * carved FROM it, the rails ARE it, the sonar view DRAWS it — so the
   * regenerate covers the union of the old and new reject boxes (a deleted
   * tunnel must refill) and everything else is rebuilt from the plan.
   */
  private applyPlan(plan: NestPlan): void {
    if (!this.soil || !this.stream) return;
    const before = this.soil.reject;
    this.soil.setPlan(plan);
    const after = this.soil.reject;
    const box = this.stream.regenerateBox(
      {
        x: Math.min(before.min[0], after.min[0]) / MM,
        y: Math.min(before.min[1], after.min[1]) / MM,
        z: Math.min(before.min[2], after.min[2]) / MM,
      },
      {
        x: Math.max(before.max[0], after.max[0]) / MM,
        y: Math.max(before.max[1], after.max[1]) / MM,
        z: Math.max(before.max[2], after.max[2]) / MM,
      },
    );
    if (box) {
      const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
      const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
      for (let cz = lo(box.minZ); cz <= hi(box.maxZ, CHUNKS_XZ); cz += 1) {
        for (let cy = lo(box.minY); cy <= hi(box.maxY, CHUNKS_Y); cy += 1) {
          for (let cx = lo(box.minX); cx <= hi(box.maxX, CHUNKS_XZ); cx += 1) {
            this.enqueue(cx, cy, cz);
          }
        }
      }
    }
    /* Her rail may have been resized, moved or deleted: let go and let the
     * regrab find whatever bore is under her now. The room she stood in may
     * be gone too — it re-derives from her position next frame. The tunnel
     * builder asks for the ride to be PRESERVED instead: its plan only ever
     * grows, and committing a leg mid-crawl must not drop her off a rail
     * or un-declare a gate she just declined. */
    if (this.nestView) {
      this.nestView.dispose();
      this.scene.remove(this.nestView.root);
    }
    this.nestView = buildNestView(plan);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.visible = this.showPlan && !this.designer?.isOpen;
    this.scene.add(this.nestView.root);
  }

  private pose(dt: number): void {
    if (!this.queenReady) return;
    /*
     * SHE IS DRAWN IN THE FRAME SHE IS STANDING IN.
     *
     * This used to build her up out of the heightfield's slope — `(-hx, 1,
     * -hz)` — and that hard-coded `1` was the ceiling on the whole game:
     * with a positive Y component by construction she could never be steeper
     * than ninety degrees, let alone inverted, however good the walk under
     * her got. The walker's up is volumetric and has no such preference, so
     * on the underside of an overhang she is simply upside down, which in
     * her own frame is perfectly ordinary.
     */
    const up = S_UP.copy(this.up);
    const forward = S_FWD.copy(this.fwd);
    forward.addScaledVector(up, -forward.dot(up)).normalize();
    const right = S_RIGHT.crossVectors(up, forward).normalize();
    this.queen.root.position.copy(this.at);
    this.queen.root.quaternion.setFromRotationMatrix(S_MAT.makeBasis(right, up, forward));
    this.queen.update(dt, {
      /*
       * WHAT SHE ACTUALLY TRAVELLED, not what the stick asked for.
       *
       * `velocity` is the command: stick times walk speed times sprint. It
       * says the same thing whether she is crossing open ground or pressed
       * against a trunk going nowhere, so the gait ran her legs at a sprint
       * while she stood still — reported as the animation being set to
       * running while she walked. Her real ground speed is the distance she
       * covered across her own tangent plane, which is zero when she is
       * blocked and honest on every slope.
       */
      speed: this.groundSpeed,
      turn: -this.input.yaw * TURN_RATE,
      digging: this.input.dig ? 1 : 0,
      carrying: 0,
      /*
       * HER HEAD FOLLOWS THE AIM — ported from the sandbox room, which
       * drives both of these from its own arrow keys.
       *
       * This was `headYaw: 0` with no pitch at all, so she faced dead ahead
       * whatever the dial said: aiming ninety degrees up a trunk swung the
       * camera and the bore and left her looking at the bark in front of her
       * nose. `gaitPose` clamps yaw through the neck's own release curve and
       * pitch to +16.7/-75 degrees, so handing it a raw camera angle is
       * safe. In first person her head IS the camera, and turning it would
       * only fight the view.
       */
      /* Left and right were backwards — reported, and the sign lives here
       * and nowhere else. Her pitch was already right, so only this flips. */
      headYaw: this.firstPerson ? 0 : this.lookYaw,
      headPitch: this.clampedHeadPitch(),
      /* The ground's own posture, kept entirely separate from the aim above
       * — see `readSpine`. */
      spine: this.readSpine(dt),
    });
    /* And her FEET are solved in that frame too. The solver has always
     * taken one; the island had been passing `undefined` and letting it
     * measure every foot as a height above sea level, which on a wall asks
     * a question the wall has no answer to. `boreFrame` casts along her own
     * up, so a foot on a ceiling is planted on the ceiling. */
    /* ANCHORED. Without this the solver may only raise and lower a foot,
     * and nothing in the pipeline knows where one IS from frame to frame —
     * so nothing can hold one still, and every planted foot skates. */
    this.queen.solveFeet(
      (x, z, y) => this.footingFrom(x, z, y),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
      this.drive ? (slot) => this.drive!.anchorFor(slot) : undefined,
      this.boreFrame(),
    );
    /*
     * NOTHING SHE IS MADE OF MAY BE IN THE SOIL.
     *
     * The legs and antennae have the solver above, which places them
     * per joint. Everything else — mandibles, the tip of a gaster over a
     * bank — has nobody, and on this island it simply sank. `groundGuard`
     * walks the bones that geometry is actually drawn on, asks how far
     * each would have to rise to be out of the dirt, and returns the
     * worst; the model is lifted rigidly by that, because a fail-safe
     * that tries to bend things is a fail-safe with its own bugs.
     *
     * The probe asks whether a POINT is in soil, not whether it is under
     * the surface. In a burrow those are different questions — a height
     * query answers "the rim, several millimetres over your head" — and
     * only the first one has a sensible answer down here.
     */
    /* Out along HER up, not the world's — on a ceiling the way out of the
     * dirt is downward, and a guard that only ever lifted in +Y pushed her
     * further into it. */
    /*
     * Stepped in eighths and then halved down to the clearance, rather than
     * crawled in 0.004-unit increments: a buried bone was costing a hundred
     * and thirty probes and there are forty of them, which measured at 732
     * probes a frame. Twelve probes get the same answer to well inside the
     * clearance the guard is enforcing.
     */
    const GUARD_REACH = RIDE * 2;
    const lift = this.queen.groundGuard((x, y, z) => {
      if (!this.soilSolidAt(x, y, z)) return 0;
      let lo = 0;
      let clear = -1;
      for (let i = 1; i <= 8; i += 1) {
        const d = (i / 8) * GUARD_REACH;
        if (!this.soilSolidAt(x + up.x * d, y + up.y * d, z + up.z * d)) { clear = d; break; }
        lo = d;
      }
      if (clear < 0) return GUARD_REACH;
      while (clear - lo > BONE_CLEARANCE) {
        const mid = (lo + clear) * 0.5;
        if (this.soilSolidAt(x + up.x * mid, y + up.y * mid, z + up.z * mid)) lo = mid;
        else clear = mid;
      }
      return clear;
    });
    /* Kept for the shake probe: this is a discrete search and a prime
     * suspect for vertical jitter, so it has to be measurable. */
    this.guardLift = lift;
    if (lift > 0) this.queen.root.position.addScaledVector(up, lift);
  }

  /**
   * The lens is never under the dirt, whichever camera placed it.
   *
   * Three paths put the camera somewhere — her own eyes, the underground
   * chase, the shoulder orbit — and each had its own idea of clearance or
   * none at all. This runs after all of them: lift to a floor's own skin
   * depth, then, if the point is still INSIDE something (a roof, a wall
   * it swung into), climb until it is not.
   */
  private liftCameraClear(): void {
    const p = this.camera.position;
    const walker = this.walker;
    if (!walker) return;
    if (this.soilDensityAt(p.x, p.y, p.z) <= 0) return;
    /*
     * OUT ALONG THE SOIL'S OWN NORMAL — the shortest way to air, and the
     * only direction that works on every surface.
     *
     * This used to climb in +Y, which is the way out of a floor and the way
     * further INTO a ceiling: pressed against the roof of a tunnel it
     * marched the lens deeper the whole length of its search and gave up
     * still buried, which is the ground coming through the picture. The
     * gradient points out of whatever it is actually inside, so a roof, a
     * wall and a floor are one case.
     */
    const out = S_TARGET.set(0, 1, 0);
    walker.normalAt(p, out);
    for (let d = CAMERA_SKIN; d <= RIDE * 4; d += CAMERA_SKIN) {
      if (this.soilDensityAt(
        p.x + out.x * d, p.y + out.y * d, p.z + out.z * d,
      ) <= 0) {
        /* One skin PAST the boundary: landing exactly on it leaves the near
         * plane straddling the surface, which is the dirt still showing. */
        p.addScaledVector(out, d + CAMERA_SKIN);
        return;
      }
    }
    /* Buried deeper than the search — the only place certainly in air is
     * where she is, so fall back on her and let the next frame ease out. */
    p.copy(this.at);
  }

  private aimCamera(dt: number): void {
    /* In her eyes her own body would fill the frame — hidden there, shown
     * everywhere else (and only once her model has actually loaded). */
    this.queen.root.visible = this.queenReady && !this.firstPerson;
    this.crosshair.style.display = this.firstPerson ? '' : 'none';
    /*
     * THE ORBIT'S PITCH IS EASED ONCE, FOR EVERY VIEW — before either the
     * first-person or the underground return, so every camera that reads
     * `camPitch` reads a live one.
     */
    /*
     * THE PAN DECAYS, and the camera's elevation is its OWN number.
     *
     * It used to be `0.28 - aimPitch`, which tied the chase arm's height to
     * the dig aim — and `aimPitch` never returns to anything, so a single
     * vertical drag left the third-person view permanently off its neutral
     * with no way back. Reported as being locked at a few degrees and
     * unable to sit directly behind her. The pan is now an offset that
     * comes home; the aim is left to the shovel.
     *
     * Digging holds the pan indefinitely: there the look IS the aim.
     */
    if (this.lookPointer !== null || this.digMode) this.lookIdle = 0;
    else this.lookIdle += dt;
    if (this.lookIdle > LOOK_HOLD_S) {
      const home = 1 - Math.exp(-LOOK_RETURN_RATE * dt);
      this.lookYaw -= this.lookYaw * home;
      this.lookPitch -= this.lookPitch * home;
    }
    /*
     * ONE ANGLE, ONE OWNER. `aimPitch` is what her head is POSED with and
     * what the third-person shovel cuts along; the pan is what the player
     * asked for. Keeping them equal here means there is exactly one place
     * the number is decided, and her head visibly follows the look in both
     * views instead of staring level while the camera tips.
     */
    this.aimPitch = this.lookPitch;
    /*
     * MINUS, as it always was. `0.28 - pan` is what the third-person view
     * has done since it was written: drag DOWN and the camera climbs, so
     * you end up looking along the line she would cut. Writing it as
     * `0.28 + pan` inverted the vertical drag and squeezed its useful range
     * against the low clamp — reported as the view being messed up and the
     * movement limited. The pan is the new part; the law is not.
     */
    const wantPitch = Math.min(CHASE_PITCH_MAX,
      Math.max(CHASE_PITCH_MIN, CHASE_PITCH - this.lookPitch));
    this.camPitch += (wantPitch - this.camPitch) * Math.min(1, dt * 6);
    /*
     * The lens's flinch is FIRST-PERSON STATE, and a view change is a hard
     * cut everywhere in this rig — so the lift is dropped the frame the view
     * leaves her head, rather than surviving in a corner to greet the next
     * first-person frame with a five-degree tilt the clearance no longer
     * asks for. (Code review's catch, not a report.)
     */
    if (!this.firstPerson) this.fpvLift = 0;
    if (this.firstPerson) {
      /* Her own eyes: at the head, looking where she faces; the mouse (or
       * right-half drag) turns HER, and pitch is a look, not an orbit. On
       * the rail the eyes follow the BORE's axis — looking up a vertical
       * shaft means looking up it, not at its wall. */
      /*
       * THE EYE LOOKS DOWN THE CUT'S OWN RAY.
       *
       * `boreAim` is the line the shovel works along, so the camera takes
       * it whole — same origin, same direction — and the crosshair then
       * covers exactly what the next stroke removes. The eye used to sit
       * a little above and ahead of her on her FACING instead, which is a
       * different ray, and the two disagreed by more the further out you
       * looked.
       */
      /*
       * HER FRAME, because the eye is IN HER HEAD.
       *
       * A world frame here rolls the whole view ninety degrees the moment
       * she is on a trunk — her up is horizontal and the lens insists on
       * the sky's, so the bark ends up down one side of the screen and a
       * left-right pan swings around an axis that is nothing to do with
       * her. Reported exactly that way. The dial still reads against the
       * world; only the picture rides her body.
       */
      /*
       * THE BONE GIVES THE LENS ITS PLACE, AND NOTHING ELSE.
       *
       * Mounting the ORIENTATION on the head bone as well was an
       * over-reach, and it cost twice. Her head carries the gait's own
       * movement, which arrived at the lens as shake; and her head's up is
       * the surface normal under her, which rolled the horizon on every
       * slope — reported as the view being tilted when it should be
       * straight ahead. Neither is what "put the camera in her head"
       * asked for. The POSITION still comes off the bone, which is the
       * part that was wanted: the lens sits where her eyes are and goes
       * where they go.
       *
       * So the frame is hers-the-animal's again — the body her legs and
       * the walker maintain, which is smooth by construction and already
       * measured dead still at rest — with the player's pan on top.
       */
      const fwd = S_FWD.copy(this.fwd);
      const upv = S_UP.copy(this.up);
      /*
       * THE BONE TAKES THE WHEEL WHEN THE THUMB LETS GO. Left alone for
       * `LOOK_HOLD_S`, the lens's frame eases from the body's onto the
       * HEAD BONE's own facing and up — so her gait's nod, the climb's
       * tilt, the spine's posture all reach the picture — through the
       * same exponential filters that already keep the bone's shake out.
       * The moment the player drags, the share collapses to zero: the
       * look is theirs, and her head is POSED to follow it (the pose
       * reads the same angles), which is the exact handshake asked for —
       * head drives camera at rest, camera drives head under a thumb.
       */
      const boneShare = Math.min(1, Math.max(0,
        (this.lookIdle - LOOK_HOLD_S) / 0.8));
      if (boneShare > 0 && this.queenReady
        && this.queen.eyeForwardWorld(BONE_FWD)) {
        /* The bone's FACING only — its nod and its glance. Its roll stays
         * the body's: the head's up is the surface normal under her, and
         * following it tips the horizon on every slope (the v0.0.64
         * report, and the probe still pins it). */
        fwd.lerp(BONE_FWD, boneShare).normalize();
      }
      this.eyeFwd.lerp(fwd, 1 - Math.exp(-EYE_ROLL_RATE * dt));
      if (this.eyeFwd.lengthSq() < 1e-9) this.eyeFwd.copy(fwd);
      this.eyeRoll.lerp(upv, 1 - Math.exp(-EYE_ROLL_RATE * dt));
      if (this.eyeRoll.lengthSq() < 1e-9) this.eyeRoll.copy(upv);
      const baseFwd = S_NOSE.copy(this.eyeFwd).normalize();
      const baseUp = S_ROLL.copy(this.eyeRoll)
        .addScaledVector(baseFwd, -this.eyeRoll.dot(baseFwd)).normalize();
      /*
       * The pan is applied HERE rather than being read off her head, so a
       * glance is exact and instant. Her head is posed with the same angle,
       * so she still visibly looks where the player is looking.
       */
      const right = S_RIGHT.crossVectors(baseFwd, baseUp).normalize();
      /*
       * THE LENS FLINCHES BEFORE THE GROUND DOES — a few degrees of
       * camera-only up-tilt as her head's measured clearance closes.
       *
       * Rounding a corner in first person, the head rides within a
       * millimetre of the surface while the body rotates, and a lens that
       * close with a level view puts the terrain across the bottom third
       * of the frame — reported as the view being thirty percent
       * underground. Her HEAD is not tilted for it (the pose is the
       * animation's business and it is already flinching); only the
       * picture lifts, the way a person walking at a wall raises their
       * eyes before their chin. Keyed to the same measured clearance the
       * spine's flinch uses, so it fires at any speed and either corner
       * direction, and EASED because the clearance probe reads in
       * half-millimetre steps that would otherwise pop the horizon.
       */
      const closeness = Number.isFinite(this.headClearMm)
        ? THREE.MathUtils.clamp((FPV_LIFT_SOFT_MM - this.headClearMm)
          / (FPV_LIFT_SOFT_MM - FPV_LIFT_HARD_MM), 0, 1)
        : 0;
      this.fpvLift += (closeness * FPV_LIFT_RAD - this.fpvLift)
        * (1 - Math.exp(-FPV_LIFT_RATE * dt));
      const viewPitch = this.lookPitch + this.fpvLift;
      const dir = S_RAD.copy(baseFwd).applyAxisAngle(right, viewPitch).normalize();
      const steadyFwd = S_NOSE.copy(dir);
      const steadyUp = S_ROLL.copy(baseUp).applyAxisAngle(right, viewPitch).normalize();
      /* The dig reads this: the crosshair is the centre of the frame, so
       * the cut has to run down the line the frame was built on. */
      this.lookDir.copy(dir);
      /*
       * Forward of her centre so her own back does not fill the frame —
       * but ALONG THE AIM, so the eye stays on the cut's line. And never
       * through the wall: the offset walks back until the lens is in air
       * with a little to spare, and her centre is always air, so there is
       * always somewhere to retreat to.
       *
       * The rise is off HER back, along her own up: an ant's eyes are at
       * the top of her head, and a lens on her centre-line reads as looking
       * out of her chest. On a ceiling that rise points at the floor, which
       * is where the top of her head actually is.
       */
      /*
       * THE ANCHOR IS HER HEAD, not a point invented from her root.
       *
       * `root + up * EYE_RISE` inherits every sub-millimetre re-seat the
       * walker makes, undamped, and knows nothing about where her face
       * actually is. The rig does. `eyeWorldPosition` is the head joint
       * raised and pushed forward by the head's own measured radius; the
       * old sum stays as the fallback for the second before the model has
       * loaded, which is the only time it is right about anything.
       */
      const base = S_CENTER;
      if (!(this.queenReady && this.queen.eyeWorldPosition(base))) {
        base.copy(this.at).addScaledVector(upv, EYE_RISE);
      }
      /*
       * THE RETREAT IS CONTINUOUS NOW, and that was a real bug.
       *
       * It used to step `t` down from 1 in fifths, so the lens had five
       * legal positions and near a wall the accepted one flipped between
       * neighbours frame to frame — a hard pop of a fifth of `EYE_FORWARD`,
       * every frame, which is the shaking AND the ground coming through the
       * lens. Bisecting finds the furthest clear point on the line instead,
       * so the eye slides in and out of cover smoothly and lands somewhere
       * different only when the world is actually different.
       */
      const eye = S_TARGET.copy(base);
      const clearAt = (t: number): boolean => {
        const px = base.x + dir.x * EYE_FORWARD * t;
        const py = base.y + dir.y * EYE_FORWARD * t;
        const pz = base.z + dir.z * EYE_FORWARD * t;
        return this.soilDensityAt(px, py, pz) <= 0
          && this.soilDensityAt(px + dir.x * EYE_SKIN, py + dir.y * EYE_SKIN,
            pz + dir.z * EYE_SKIN) <= 0;
      };
      /*
       * MARCHED, NOT JUST TESTED AT THE END — the lens must stay in HER air.
       *
       * `clearAt(1)` alone asks only whether the far END of the line is in
       * air, and through the thin wall of a bore the answer is yes: the line
       * punches the crust and lands in the open air beyond it, the camera
       * sets up outside the world looking back in, and the player sees the
       * sky box through the dirt — reported, with a screenshot, from inside
       * a dig. So the line is walked in short steps from her head outward
       * and stops at the last clear point BEFORE the first solid one; the
       * bisection then only sharpens that boundary. The eye can no longer
       * be anywhere she could not poke her own head.
       */
      let lastClear = 0;
      let firstBlocked = -1;
      for (let i = 1; i <= EYE_MARCH_STEPS; i += 1) {
        const t = i / EYE_MARCH_STEPS;
        if (clearAt(t)) lastClear = t;
        else { firstBlocked = t; break; }
      }
      if (firstBlocked < 0) {
        eye.addScaledVector(dir, EYE_FORWARD);
      } else {
        let lo = lastClear;
        let hi = firstBlocked;
        for (let i = 0; i < EYE_BISECTIONS; i += 1) {
          const mid = (lo + hi) / 2;
          if (clearAt(mid)) lo = mid; else hi = mid;
        }
        eye.addScaledVector(dir, EYE_FORWARD * lo);
      }
      /*
       * AND THEN IT IS FILTERED — the POSITION only.
       *
       * Her root is re-seated against a lattice every frame and her up is a
       * density gradient, so the eye target carries sub-millimetre noise
       * however good the anchor is. A short lag on the position removes it.
       * The LOOK is not filtered at all: it comes straight off the aim,
       * which is player input, so turning stays instant. That split is the
       * whole design — filter the body, never the intent.
       */
      this.settleEye(eye, dt);
      /*
       * THE EYE'S OWN UP, TURNED WITH THE PITCH — not the world's.
       *
       * Handing `lookAt` a fixed up and a look parallel to it leaves the
       * roll undefined, and three.js picks whatever falls out of a
       * degenerate cross product. Straight down is exactly that case, and
       * digging aims her straight down all the time. Rotating the up by
       * the same pitch keeps it perpendicular to the look by construction
       * — their dot is `-cos*sin + sin*cos`, zero at every angle.
       */
      /*
       * ROTATED BY THE AIM ITSELF, not by a copy of it.
       *
       * There was a second field, `fpPitch`, written only by the look-drag.
       * Anything else that moved the aim — a key, a test, a scripted view —
       * left it behind, and a stale up is not a cosmetic problem: this
       * rotation exists precisely so that up stays perpendicular to the
       * look at the poles, where `lookAt` has no other way to choose a
       * roll. Measured with the dial at ninety, up and look were PARALLEL,
       * which is the degenerate case it was written to avoid. One number.
       */
      /*
       * Built from the same head frame and turned by the same pan, so up
       * and look cannot disagree about which body they belong to — and her
       * head's roll IS the camera's roll, which is what makes rounding onto
       * a trunk read as her leaning rather than the world tipping.
       */
      this.camera.up.copy(steadyUp);
      this.liftCameraClear();
      /* Aim from where the lens ACTUALLY ended up. The guard above may have
       * nudged it out of a roof, and looking at a target measured from the
       * old spot tilts the whole view by however far it moved — a pitch
       * that drifts on its own every time she brushes a ceiling. */
      const lens = this.camera.position;
      this.camera.lookAt(lens.x + dir.x, lens.y + dir.y, lens.z + dir.z);
      return;
    }
    /* The drag swings the arm off her tail and it decays back to zero, so
     * the camera returns behind her without ever holding an absolute world
     * bearing — which is the thing that stops meaning anything on a wall. */
    /* The pan's own return is handled once, for both views, in `aimCamera`
     * — it holds for `LOOK_HOLD_S` first, which this did not. */
    this.chaseCamera(dt);
  }

  /**
   * THE CHASE: find the open air behind her, and sit in the middle of it.
   *
   * There were two of these — a tunnel chase that followed her walked path
   * and a shoulder orbit that swung a fixed arm — and the seam between them
   * is where the camera got stuck. Stepping from the hill onto the trunk is
   * not underground and it is not open country either: the arm swung into a
   * metre of solid wood, the guard hauled it back onto her, and the view sat
   * under the ant with nothing to show. Switching to first person "fixed" it
   * because first person does not use the arm.
   *
   * So there is one camera, and instead of one arm it CASTS A FAN of them —
   * a spread of directions around where it would like to be — and asks each
   * how far it gets before it meets something. The answer is the weighted
   * mean of where those rays ended: a spot in the middle of whatever open
   * space actually exists behind her, whether that is a tunnel, the gap
   * between the trunk and the hillside, or the whole sky. Nothing about it
   * knows what a tree is, or a tunnel, which is exactly why it cannot have a
   * seam between them.
   *
   * The mean is what makes it steady. Picking the single best ray snaps
   * between candidates as she turns; averaging a dozen of them moves
   * continuously, because one ray losing its clearance only shifts the
   * average by its own share.
   */
  private chaseCamera(dt: number): void {
    const ideal = S_PERP.copy(this.orbitBack(S_RAD));
    /* A basis to sweep the fan in: across her, and the third axis. */
    const across = S_RIGHT.crossVectors(ideal, this.up);
    if (across.lengthSq() < 1e-8) across.set(ideal.z, ideal.x, ideal.y);
    across.normalize();
    const over = S_FWD.crossVectors(across, ideal).normalize();

    /*
     * THE FAN IS A FALLBACK, NOT THE RULE.
     *
     * When it always ran, it always won: in open country the downward rays
     * of the fan hit the ground within a few millimetres and the upward
     * ones ran free, so the weighted mean sat at whatever elevation the
     * ground allowed and barely moved when the drag changed the ideal.
     * That is the reported bug — the third-person view would swing left and
     * right and refuse to pitch. If the arm the player actually asked for
     * is clear, it is the answer, and the search never runs.
     */
    /*
     * ABOVE GROUND the chase is the classic one, and only that: the arm
     * the player asked for, shortened to whatever run is actually clear
     * (blocked means CLOSER to her, never a different direction), and
     * then ridden at a fixed height over the terrain — the standard
     * third-person ground rule the field asked for by name. The fan is
     * a tunnel instrument; in open country its ground-hugging rays vetoed
     * every downward pitch, which was the "limited, won't go around"
     * report.
     */
    if (!this.underground) {
      /*
       * FULL ARM FIRST, then lifted, then shortened — that order is the
       * whole fix. Shortening to the first soil hit collapsed the camera
       * onto her back whenever the ground rose behind her (which on a
       * mound is always), and the pan read as nearly dead. Instead the
       * arm keeps the distance the player owns, rides a fixed clearance
       * over whatever terrain stands under it, and only slides in toward
       * her when a ridge actually blocks the SIGHT LINE between them.
       */
      const pos = S_TARGET;
      for (const t of CHASE_REACH) {
        pos.copy(this.at).addScaledVector(ideal, this.camDist * t);
        const floor = this.walkGroundAt(pos.x, pos.z) + CHASE_GROUND_CLEAR;
        if (pos.y < floor) pos.y = floor;
        /* Sight line: her head to the lens, sampled past her own body. */
        let open = true;
        for (let i = 3; i <= 12; i += 1) {
          const k = i / 12;
          if (this.soilSolidAt(
            this.at.x + (pos.x - this.at.x) * k,
            this.at.y + 0.4 + (pos.y - this.at.y - 0.4) * k,
            this.at.z + (pos.z - this.at.z) * k,
          )) { open = false; break; }
        }
        if (open) break;
      }
      this.settleChase(pos, dt);
      return;
    }

    const straight = this.clearRun(ideal, this.camDist);
    if (straight > this.camDist * 0.92) {
      this.settleChase(S_TARGET.copy(this.at).addScaledVector(ideal, straight), dt);
      return;
    }

    const want = S_TARGET.set(0, 0, 0);
    let weight = 0;
    let bestRun = 0;
    const dir = S_CENTER;
    for (const swing of FAN_SWING) {
      for (const rise of FAN_RISE) {
        dir.copy(ideal).multiplyScalar(Math.cos(swing) * Math.cos(rise))
          .addScaledVector(across, Math.sin(swing))
          .addScaledVector(over, Math.sin(rise))
          .normalize();
        const run = this.clearRun(dir, this.camDist);
        if (run < CHASE_MIN) continue;
        if (run > bestRun) bestRun = run;
        /*
         * Weighted by how much room it found AND how close it is to where
         * the camera wanted to be. Squaring the room makes a ray that got
         * the whole way worth far more than one that got a third, so the
         * mean sits in the open rather than being dragged into a corner by
         * a crowd of stubs.
         */
        const aim = 0.3 + 0.7 * Math.max(0, dir.dot(ideal));
        const w = run * run * aim;
        want.addScaledVector(dir, run * w);
        weight += w;
      }
    }
    if (weight > 0) {
      want.multiplyScalar(1 / weight).add(this.at);
    } else {
      /*
       * Nowhere to stand at all — wedged in a crack barely her own size. Sit
       * off her back at whatever the ceiling allows and look at her; that is
       * the honest picture of being stuck, and it is never under her.
       */
      want.copy(this.at).addScaledVector(this.up, Math.max(CHASE_MIN, bestRun));
    }

    /*
     * THE ROOM CAMERA still rides on top: from a few millimetres outside a
     * chamber the view eases onto a post under its ceiling, so a room reads
     * as a PLACE the camera inhabits rather than another stretch of tube.
     */
    let roomShare = 0;
    let roomBox: ChamberBox | null = null;
    for (const node of this.soil?.plan.nodes ?? []) {
      if (node.kind !== 'chamber') continue;
      const box = chamberBox(node.x / MM, node.y / MM, node.z / MM, node.radiusMm / MM);
      const u = chamberNorm(box, this.at.x, this.at.y, this.at.z);
      const t = Math.min(1, Math.max(0,
        (CHAMBER_CAM_FAR - u) / (CHAMBER_CAM_FAR - CHAMBER_CAM_NEAR)));
      if (t > roomShare) { roomShare = t; roomBox = box; }
    }
    this.chamberCam += (roomShare - this.chamberCam) * Math.min(1, dt * 3);
    if (roomBox && this.chamberCam > 0.01) {
      want.lerp(S_UP.set(roomBox.cx, roomBox.cy + roomBox.ry * 0.55, roomBox.cz),
        this.chamberCam);
    }

    this.settleChase(want, dt);
  }

  /**
   * Put the first-person lens on the eye anchor, filtered.
   *
   * One exponential on the position and nothing at all on the aim, so
   * turning has no lag whatever `EYE_FOLLOW_HZ` is set to. `EYE_SNAP`
   * catches the case a filter must never smooth — a respawn, a rail grab,
   * an embed rescue — because easing across a teleport would fly the camera
   * through the island.
   */
  private settleEye(want: THREE.Vector3, dt: number): void {
    if (!this.eyeAt) this.eyeAt = want.clone();
    else if (this.eyeAt.distanceTo(want) > EYE_SNAP) this.eyeAt.copy(want);
    else this.eyeAt.lerp(want, 1 - Math.exp(-EYE_FOLLOW_RATE * dt));
    this.camera.position.copy(this.eyeAt);
  }

  /**
   * Ease the lens onto a chosen spot and point it at her — through three
   * filters rather than none.
   *
   * The order matters. The chosen spot is smoothed FIRST, so the pop when
   * the straight arm gives way to the fan is spread over a few tenths of a
   * second instead of landing in one frame; then the lens eases onto that
   * already-calm target, which is a two-pole filter and reads as a camera
   * rig. The look point and the up get their own, slower filters, because
   * the eye reads a shaking DIRECTION far more harshly than a shaking
   * position — an arm's length of lever turns a 1 mm wobble in her seat
   * into a couple of degrees of picture.
   */
  private settleChase(want: THREE.Vector3, dt: number): void {
    if (!this.camWant) this.camWant = want.clone();
    /* Faster when the target has run away — squeezing through a gap should
     * not leave the lens lagging inside the wall — but never instant. */
    const jump = this.camWant.distanceTo(want);
    this.camWant.lerp(want, 1 - Math.exp(-(jump > this.camDist ? 12 : 5) * dt));

    const gap = this.camera.position.distanceTo(this.camWant);
    const rate = gap > this.camDist ? 14 : 7;
    this.camera.position.lerp(this.camWant, 1 - Math.exp(-rate * dt));
    this.liftCameraClear();

    const look = S_UP.copy(this.at).addScaledVector(this.up, 0.3);
    if (!this.camLook) this.camLook = look.clone();
    /* A filter is for jitter, not for teleports: if she has been MOVED —
     * a respawn, a rail grab, an embed rescue — following her over half a
     * second would sweep the whole island past the lens. */
    if (this.camLook.distanceTo(look) > this.camDist * 3) this.camLook.copy(look);
    this.camLook.lerp(look, 1 - Math.exp(-9 * dt));
    /*
     * The up is filtered as a DIRECTION and renormalised, so easing it can
     * never shorten it to nothing on the way between two opposed ups —
     * which is what walking round the underside of a branch asks for.
     */
    this.camRoll.lerp(this.up, 1 - Math.exp(-7 * dt));
    if (this.camRoll.lengthSq() < 1e-6) this.camRoll.copy(this.up);
    this.camera.up.copy(this.camRoll).normalize();
    this.camera.lookAt(this.camLook.x, this.camLook.y, this.camLook.z);
  }

  /**
   * How far a ray out of her centre gets before it meets something, capped
   * at `max`. Her own centre is always air, so this always has an answer.
   */
  /**
   * Her head follows the look — but never INTO the hill or the bark.
   * Climbing tips her frame until "ahead" can point straight at the
   * surface she stands on, and posing the neck with the raw look then
   * buries her face in it — reported from the trunk and from cresting a
   * hole. Probe a face-length along the would-be look from her eyes
   * (soil, trunk and scrub all answer through `soilDensityAt`) and back
   * the pitch off by halves until that point is air.
   */
  private clampedHeadPitch(): number {
    let pitch = this.lookPitch;
    if (!this.queenReady || !this.queen.eyeWorldPosition(HEAD_PROBE_AT)) {
      return pitch;
    }
    HEAD_PROBE_RIGHT.crossVectors(this.fwd, this.up);
    if (HEAD_PROBE_RIGHT.lengthSq() < 1e-8) return pitch;
    HEAD_PROBE_RIGHT.normalize();
    for (let i = 0; i < 4 && Math.abs(pitch) > 0.04; i += 1) {
      HEAD_PROBE_DIR.copy(this.fwd).applyAxisAngle(HEAD_PROBE_RIGHT, pitch);
      if (this.soilDensityAt(
        HEAD_PROBE_AT.x + HEAD_PROBE_DIR.x * 0.5,
        HEAD_PROBE_AT.y + HEAD_PROBE_DIR.y * 0.5,
        HEAD_PROBE_AT.z + HEAD_PROBE_DIR.z * 0.5,
      ) <= 0) break;
      pitch *= 0.5;
    }
    return pitch;
  }

  private clearRun(dir: THREE.Vector3, max: number): number {
    const step = CELL_SIZE * 0.6;
    for (let d = step; d <= max; d += step) {
      if (this.soilSolidAt(
        this.at.x + dir.x * d, this.at.y + dir.y * d, this.at.z + dir.z * d,
      )) return Math.max(0, d - step - CAMERA_SKIN);
    }
    return max;
  }

  /**
   * The orbit arm, built in HER frame: back along her nose, swung off it by
   * the drag, and raised by the pitch — all about her own up.
   *
   * The old arm was `(sin lookYaw, 0, cos lookYaw)` with a world-vertical
   * rise, which is a rig bolted to the horizon. Underground the horizon is
   * not a thing she has: in a shaft her up is horizontal, and a camera that
   * insists on world vertical sits in the wall looking at dirt.
   */
  private orbitBack(into: THREE.Vector3): THREE.Vector3 {
    const nose = S_NOSE.copy(this.fwd).applyAxisAngle(this.up, this.lookYaw);
    return into.copy(nose).negate().multiplyScalar(Math.cos(this.camPitch))
      .addScaledVector(this.up, Math.sin(this.camPitch)).normalize();
  }

  /* ---------------------------------------------------------------- HUD */

  private buildControls(): void {
    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    this.hud.appendChild(actions);

    /*
     * DIG IS A MODE: tap DIG to arm it, and the PALETTE appears. From there
     * it is a coaster builder — a row of pieces, one tap each, laid on the
     * end of what is already there. The two-step survives from the chewing
     * era for the same reason it was introduced: a palette that is always
     * on screen is a palette that gets dug into by a mis-tap.
     */
    const dig = document.createElement('button');
    dig.className = 'density-lab-button density-lab-dig';
    dig.textContent = 'DIG';
    dig.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.digMode = !this.digMode;
      /* A burst in flight while the jaws come out would carry her off the
       * spot she was lining up. */
      if (this.digMode) this.dodge.cancel();
      dig.classList.toggle('is-grip', this.digMode);
      this.scoopBtn!.style.display = this.digMode ? '' : 'none';
      this.headingReadout!.style.display = this.digMode ? '' : 'none';
      this.depthReadout!.style.display = this.digMode ? '' : 'none';
      if (!this.digMode) this.input.dig = false;
      /* Digging is aiming, and aiming is done down her own eyes: arming
       * DIG drops into first person with a wide 100° field so the tunnel
       * mouth and the instruments share the frame. Disarming narrows the
       * lens back; the VIEW chip still switches freely either way. */
      if (this.digMode) this.firstPerson = true;
      this.camera.fov = this.digMode ? 100 : 60;
      this.camera.updateProjectionMatrix();
    });
    actions.appendChild(dig);

    /*
     * THE SHOVEL: hold it and she strokes, each stroke one mouthful along
     * the aim. Arming DIG first is deliberate — a lone held button carved
     * tunnels out of mis-taps, and a scoop this size deserves the intent.
     */
    const scoopBtn = document.createElement('button');
    scoopBtn.className = 'density-lab-button density-lab-dig';
    scoopBtn.textContent = '\u{1FA8F}';
    scoopBtn.style.display = 'none';
    this.scoopBtn = scoopBtn;
    scoopBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      scoopBtn.setPointerCapture(e.pointerId);
      this.input.dig = true;
    });
    const stopDig = (): void => { this.input.dig = false; };
    scoopBtn.addEventListener('pointerup', stopDig);
    scoopBtn.addEventListener('pointercancel', stopDig);
    scoopBtn.addEventListener('lostpointercapture', stopDig);
    actions.appendChild(scoopBtn);


    /*
     * THE SHAVE HAS NO SLIDER ANY MORE.
     *
     * It was there because the right size looked like it depended on
     * whether you were easing one lip or a whole chamber floor. Played, it
     * did not: the widest setting was better everywhere, so the control was
     * a thing to push to the end before starting. A setting with one good
     * value is a constant.
     */



    /*
     * The angle, where the thumb can see it.
     *
     * Taking the ± buttons away also took away the only way to tell how
     * steeply she was pointed, and a bore you cannot read is a bore that
     * quietly goes too deep — which is exactly what happened. This is a
     * readout and not a control: the drag still does the aiming.
     */
    this.aimReadout = document.createElement('div');
    this.aimReadout.className = 'density-lab-aim-readout';
    actions.appendChild(this.aimReadout);

    /*
     * THE OTHER TWO INSTRUMENTS, while the shovel is out.
     *
     * The angle alone says which way the next stroke goes and nothing about
     * where that leaves her. A bearing and a depth make the three together
     * a navigation panel: you can drive a tunnel on a heading, hold a
     * grade, and know how far under you are — which is the whole of digging
     * blind. Both are world-referenced, like the angle beside them.
     */
    this.headingReadout = document.createElement('div');
    this.headingReadout.className = 'density-lab-aim-readout';
    this.headingReadout.style.display = 'none';
    actions.appendChild(this.headingReadout);

    this.depthReadout = document.createElement('div');
    this.depthReadout.className = 'density-lab-aim-readout';
    this.depthReadout.style.display = 'none';
    actions.appendChild(this.depthReadout);


    /* The PLAN button is gone: the shovel is how tunnels get made now.
     * The designer code stays for the tests and for a possible return as
     * a colony-scale tool, but the queen digs with her jaws, not a CAD. */


    const plan = document.createElement('button');
    plan.className = 'density-lab-button density-lab-mode';
    plan.textContent = 'SONAR';
    plan.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.showPlan = !this.showPlan;
      if (this.nestView) this.nestView.root.visible = this.showPlan;
    });
    actions.appendChild(plan);

    const view = document.createElement('button');
    view.className = 'density-lab-button density-lab-mode';
    view.textContent = 'VIEW';
    view.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.firstPerson = !this.firstPerson;
    });
    actions.appendChild(view);

    /*
     * WALK / RUN — and on a touch screen it is the ONLY sprint there is.
     *
     * Shift has always doubled her pace for the PC hand; a thumb had no
     * equivalent, so a phone was locked to 7.5 mm/s whatever it did. The
     * chip is a latch rather than a held button because there is nowhere
     * left on a phone to hold a second finger down: the left half of the
     * screen is the stick and the right half is the look-drag.
     */
    this.paceChip = document.createElement('button');
    this.paceChip.className = 'density-lab-button density-lab-mode';
    this.paceChip.textContent = 'WALK';
    this.paceChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.running = !this.running;
      this.paceChip!.textContent = this.running ? 'RUN' : 'WALK';
      /* Written HERE as well as in `applyKeys`, because that only runs on a
       * key event — on a phone there are none, so the latch would have sat
       * there doing nothing until someone plugged a keyboard in. */
      this.input.sprint = this.running;
    });
    actions.appendChild(this.paceChip);

    /*
     * THE FLIGHT RECORDER'S THREE BUTTONS.
     *
     * REC is a readout rather than a control — it arms itself the moment she
     * moves, because the interesting run is the one nobody remembered to
     * start recording. STOP freezes the buffer so a good run cannot be
     * overwritten by walking back; COPY puts the report on the clipboard.
     *
     * Tapping REC once it has stopped clears it and re-arms, so a second
     * attempt does not need a page reload.
     */
    /*
     * ONE ROW, NOT THREE. As three stacked buttons these pushed the rail
     * off the top of a phone in dig mode — the DIG toggle, which is also
     * the way OUT of dig mode, went with it. Reported as "I can't get out
     * of dig mode". The rail is bottom-anchored and grows upward, so every
     * chip added anywhere costs headroom exactly where the dig controls
     * live; the recorder's three buttons now share one slot.
     */
    const logRow = document.createElement('div');
    logRow.className = 'tm-log-row';
    actions.appendChild(logRow);

    this.telemetryChip = document.createElement('button');
    this.telemetryChip.className = 'density-lab-button density-lab-mode';
    this.telemetryChip.textContent = 'REC';
    this.telemetryChip.title = 'Records automatically once she moves';
    this.telemetryChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.telemetry.reset();
    });
    logRow.appendChild(this.telemetryChip);

    const logStop = document.createElement('button');
    logStop.className = 'density-lab-button';
    logStop.textContent = 'STOP';
    logStop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.telemetry.stop();
    });
    logRow.appendChild(logStop);

    const logCopy = document.createElement('button');
    logCopy.className = 'density-lab-button';
    logCopy.textContent = 'COPY';
    logCopy.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      /* Stop first: copying a still-running buffer gives a report that
       * disagrees with itself between the summary and the events. */
      this.telemetry.stop();
      const text = this.telemetryReport();
      const done = (ok: boolean) => {
        logCopy.textContent = ok ? 'COPIED' : 'SEE LOG';
        window.setTimeout(() => { logCopy.textContent = 'COPY'; }, 1500);
      };
      /* The clipboard needs a secure context and a user gesture; on a plain
       * http:// LAN address for phone testing it is simply absent, so the
       * console is the fallback rather than a silent failure. */
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => done(true), () => {
          console.log(text);
          done(false);
        });
      } else {
        console.log(text);
        done(false);
      }
    });
    logRow.appendChild(logCopy);

    /*
     * WASD for the PC hand (playtest: "I was having trouble moving"):
     * W/S walk, A/D turn, Shift sprint, Space DIGS (hold), B opens the nest
     * tools, V swaps the view. There is no aim key: she digs where the view
     * looks.
     * Arrows mirror WASD. Keys and stick write the same inputs.
     */
    const applyKeys = () => {
      const k = this.keysDown;
      if (this.designer?.isOpen) {
        /* The designer owns the keys, but the Space EDGE must keep tracking
         * or a release while designing leaves it stuck "down" — and the
         * next press after DONE would be swallowed. */
        this.spaceWasDown = k.has(' ');
        return;
      }
      const forward = (k.has('w') || k.has('arrowup') ? 1 : 0)
        - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const turn = (k.has('d') || k.has('arrowright') ? 1 : 0)
        - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      if (this.stickPointer === null) {
        this.input.walk = forward;
        this.input.yaw = turn;
      }
      /* Shift OR the latch — the key is a hold and the chip is a toggle,
       * and either one asking for a run is a run. */
      this.input.sprint = k.has('shift') || this.running;
      /* Space is the shovel, and it is HELD — but only once DIG is armed. */
      const space = k.has(' ');
      if (space !== this.spaceWasDown) {
        this.input.dig = this.digMode && space;
        this.spaceWasDown = space;
      }
    };
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'b' && !e.repeat) this.openDesigner();
      if (key === 'v' && !e.repeat) this.firstPerson = !this.firstPerson;
      if (key === 'p' && !e.repeat) {
        this.showPlan = !this.showPlan;
        if (this.nestView) this.nestView.root.visible = this.showPlan;
      }
      this.keysDown.add(key);
      applyKeys();
    });
    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
      applyKeys();
    });
    window.addEventListener('blur', () => {
      this.keysDown.clear();
      applyKeys();
    });

    this.stickEl.className = 'nest-stick';
    this.stickEl.style.display = 'none';
    this.stickKnob.className = 'nest-stick-knob';
    this.stickEl.appendChild(this.stickKnob);
    this.hud.appendChild(this.stickEl);

    // Her aim, in her own eyes: shown only in first person.
    this.crosshair.className = 'density-lab-crosshair';
    this.crosshair.style.display = 'none';
    this.crosshair.style.pointerEvents = 'none';
    this.hud.appendChild(this.crosshair);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (this.designer?.isOpen) { this.designer.handlePointerDown(e); return; }
      if (e.clientX < window.innerWidth * 0.5 && this.stickPointer === null) {
        this.stickPointer = e.pointerId;
        this.stickOrigin.x = e.clientX;
        this.stickOrigin.y = e.clientY;
        this.stickEl.style.left = `${e.clientX}px`;
        this.stickEl.style.top = `${e.clientY}px`;
        this.stickEl.style.display = '';
      } else if (this.lookPointer === null) {
        this.lookPointer = e.pointerId;
        /* The stroke starts here. Whether it turns out to be a look or a
         * flick is decided on RELEASE — see the note there. */
        this.stroke.x = e.clientX;
        this.stroke.y = e.clientY;
        this.stroke.lastX = e.clientX;
        this.stroke.lastY = e.clientY;
        this.stroke.at = performance.now();
        this.stroke.travel = 0;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.designer?.isOpen) { this.designer.handlePointerMove(e); return; }
      if (e.pointerId === this.stickPointer) {
        const dx = Math.max(-48, Math.min(48, e.clientX - this.stickOrigin.x));
        const dy = Math.max(-48, Math.min(48, e.clientY - this.stickOrigin.y));
        /* Left and right TURN her. The side step is the view's job now. */
        this.input.yaw = stickCurve(dx / 48);
        this.input.walk = stickCurve(-dy / 48);
        this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (e.pointerId === this.lookPointer) {
        /* Path length, not displacement: a drag that wandered out and back
         * has gone nowhere, and `readFlick` rejects it on the difference. */
        this.stroke.travel += Math.hypot(
          e.clientX - this.stroke.lastX, e.clientY - this.stroke.lastY,
        );
        this.stroke.lastX = e.clientX;
        this.stroke.lastY = e.clientY;
        if (this.firstPerson) {
          /* Her own eyes: the drag turns HER, and the glance IS the
           * aim — one number, so view and dig can never disagree about
           * which way she is pointed. */
          /* The rig is turned and nothing else: `simulate` reads the step
           * off it and applies it about her own up, so a look-drag on a
           * ceiling turns her along the ceiling. Writing `facing` here as
           * well would fight that for a frame. */
          this.bore.turn(-e.movementX * 0.004);
          /*
           * PITCH IS A LOOK, and a look comes home. It used to write
           * `aimPitch` directly, which is the shovel's angle and has no
           * neutral to return to — so first person opened at whatever the
           * last drag left, in either view, instead of along her nose.
           * While DIGGING the pan is held rather than decayed, so this is
           * still exactly the aim when it needs to be.
           */
          this.lookPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
            this.lookPitch - e.movementY * 0.004));
          this.lookIdle = 0;
        } else {
          // Third person: the drag pans the view — above ground a full
          // orbit, underground a tight override the trail cam resumes from
          // the moment the finger lifts.
          /* Over her shoulder the vertical drag AIMS HER, and the camera
           * elevation follows that aim, so what you are looking along is
           * always the line she will cut. */
          /* An OFFSET off her tail, bounded to half a turn either way — it
           * decays back to zero, which is how the view swings home. */
          /*
           * BOTH AXES ARE A PAN NOW. The vertical drag used to aim the
           * SHOVEL and let the camera's elevation follow it, which is why
           * the third-person view could be left tilted with no way back:
           * an aim has no neutral. A pan does, and reaches it three
           * seconds after the finger lifts.
           */
          this.lookYaw = Math.max(-Math.PI, Math.min(Math.PI,
            this.lookYaw - e.movementX * 0.005));
          this.lookPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
            this.lookPitch - e.movementY * 0.004));
          this.lookIdle = 0;
        }
      }
    });
    /*
     * LETTING GO HAS TO BE UNCONDITIONAL.
     *
     * The stick latched: a pointerup that never arrives — a finger leaving
     * the glass, a capture stolen, the tab going away mid-drag — left
     * `input.walk` exactly as it was, so she carried on walking, and if the
     * thumb happened to be below centre she carried on walking BACKWARDS
     * with nothing on screen to say why. Reported, twice.
     *
     * So there is one place that drops the stick, it clears the inputs
     * whether or not the id matches, and everything that could possibly
     * mean "the finger is gone" calls it.
     */
    const dropStick = (): void => {
      this.stickPointer = null;
      this.input.walk = 0;
      this.input.yaw = 0;
      /* `strafe` stays nought: nothing writes it any more except the dodge
       * mixer in `moveSurface`, which owns its own lifetime. */
      this.input.strafe = 0;
      this.stickKnob.style.transform = 'translate(0px, 0px)';
      this.stickEl.style.display = 'none';
    };
    const release = (e: PointerEvent) => {
      if (this.designer?.isOpen) { this.designer.handlePointerUp(e); return; }
      if (e.pointerId === this.stickPointer) dropStick();
      if (e.pointerId === this.lookPointer) {
        this.lookPointer = null;
        /*
         * A FLICK IS READ ON RELEASE, NEVER DURING THE DRAG.
         *
         * Halfway through a fast pan the numbers look exactly like a flick
         * — short, quick, far enough — so classifying as it happens would
         * fire a dodge every time you whipped the camera round. Waiting for
         * the finger costs nothing a player can feel and makes an ordinary
         * look impossible to misread.
         *
         * NOT IN FIRST PERSON, AND NOT WITH DIG ARMED. In her own eyes the
         * drag turns HER and aims the jaws, and lining a bite up is a lot
         * of quick short strokes — every one of which is a flick by these
         * numbers. Rather than special-case the thresholds and make digging
         * worse to make dodging possible, the gesture simply belongs to
         * third person. DIG forces first person anyway, so one test covers
         * both.
         */
        if (!this.firstPerson && !this.digMode) {
          const dir = readFlick({
            dx: this.stroke.lastX - this.stroke.x,
            dy: this.stroke.lastY - this.stroke.y,
            travelPx: this.stroke.travel,
            ms: performance.now() - this.stroke.at,
          });
          if (dir) this.dodge.start(dir, MM);
        }
        // Finger off: the eye starts sliding back to the tube's own line.
        }
    };
    /* The belt and braces: a pointer that vanishes without a pointerup, a
     * window that loses focus, a tab that goes to the background. */
    window.addEventListener('pointercancel', dropStick);
    window.addEventListener('blur', () => { dropStick(); this.input.dig = false; });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { dropStick(); this.input.dig = false; }
    });
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    window.addEventListener('pointerup', release);
  }

  private updateStatus(): void {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const elevM = this.heights
      ? (this.groundHeightAt(this.at.x, this.at.z) * MM).toFixed(0)
      : '…';
    this.statsPanel.setHTML(`
      <b>kauai island</b> · 56 m square · 1:1000 · all 64 sections resident<br>
      terrain ${this.terrainVerts.toLocaleString()} v / ${this.terrainTris.toLocaleString()} t
      · elevation ${elevM} m<br>
      aim ${((this.aimPitch * 180) / Math.PI).toFixed(0)}° ·
      scoop ${SCOOP_WIDE_MM} x ${SCOOP_TALL_MM} x ${SCOOP_DEEP_MM} mm<br>
      soil window ${WINDOW_MM} mm · ${(WINDOW_BYTES / 1048576).toFixed(1)} MB ·
      chunks ${this.chunkMeshes.size} · queued ${this.queue.length} ·
      dug ${this.stream?.editedSamples ?? 0}<br>
      ${this.stands.size ? `forest ${[...this.stands.values()]
        .map((m) => m.count).reduce((a, b) => a + b, 0).toLocaleString()} plants ·
        ${this.stands.size} draws<br>` : ''}
      ${this.tree ? `tree ${this.tree.bark} · ${this.tree.triangles.map((t) => t.toLocaleString()).join(' / ')} t · lod ${this.treeLevel()}<br>` : ''}
      band floor ${this.stream?.bandFloorMm ?? 0} m · scrolls ${this.stats.scrolls}
      (${this.stats.rebases} rebases) · last ${this.stats.lastScrollMs.toFixed(0)} ms<br>
      at (${(this.at.x * MM / 1000).toFixed(1)}, ${(this.at.z * MM / 1000).toFixed(1)}) m ·
      ${memory ? `heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB · ` : ''}fps ${this.stats.fps}
      @ ${this.pixelRatioNow.toFixed(2)}x
    `);
  }

  /* --------------------------------------------------------------- loop */

  private animate = (): void => {
    /* Nothing to draw into. `watchContext` cancels the pending frame, so
     * this is the belt to that pair of braces — and it is what stops a
     * restore from ever running two loops at once. */
    if (this.contextLost) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
    if (this.designer?.isOpen) this.designer.update();

    this.stats.frames += 1;
    if (now - this.stats.fpsAt > 1000) {
      this.stats.fps = Math.round(this.stats.frames * 1000 / (now - this.stats.fpsAt));
      this.stats.frames = 0;
      this.stats.fpsAt = now;
      /* Resolution breathes with the frame rate: a phone that cannot hold
       * ~30 fps at retina scale drops a notch (never below 1x) and earns
       * it back above 55 — the single biggest lever on a fillrate-bound
       * iPhone, and invisible on a desktop that never dips. */
      if (this.stats.fps < 28 && this.pixelRatioNow > 1) {
        this.pixelRatioNow = Math.max(1, this.pixelRatioNow - 0.25);
        this.renderer.setPixelRatio(this.pixelRatioNow);
        this.resize();
      } else if (this.stats.fps > 55 && this.pixelRatioNow < this.pixelCap) {
        this.pixelRatioNow = Math.min(this.pixelCap, this.pixelRatioNow + 0.25);
        this.renderer.setPixelRatio(this.pixelRatioNow);
        this.resize();
      }
      this.updateStatus();
    }

    /* The landmark picks its own detail level, from the distance to its
     * WOOD rather than to its origin — see `BuiltTree.updateLevels`. It has
     * to happen after the camera has been placed and before the draw. */
    this.tree?.updateLevels(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* --------------------------------------------------- the lost context */

  /**
   * What to do when the device takes the GPU away.
   *
   * It happens most on a rotate: turning the phone reallocates the drawing
   * buffer, and a first launch after an update is doing that with an emptied
   * cache, a megabyte of ant still arriving and terrain being built. three.js
   * rebuilds its own state if the context returns, but says nothing either
   * way and quietly makes `render` a no-op — so the sim keeps stepping, the
   * HUD keeps ticking, and the screen stays black with nothing to press.
   *
   * A loss that heals leaves no trace but a dropped frame: no banner, because
   * one that flashes up and away is worse than the hitch it describes. Only
   * a loss that does not heal gets a message, and the message has the one
   * button that can actually help.
   */
  private watchContext(): void {
    this.stopContextGuard = guardContext(this.renderer.domElement, {
      onLost: () => {
        this.contextLost = true;
        /* Stop the loop. Every draw from here is discarded, and simulating
         * an invisible island is just battery. */
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      },
      onRestored: () => {
        this.contextLost = false;
        this.clearGpuNotice();
        /* The buffer is new and may be a different size — a rotate is the
         * usual reason the context went in the first place. */
        this.resize();
        /* Without this the first frame back carries the whole outage as its
         * dt; the clamp in `animate` would cap it at 50 ms, but she would
         * still take a step nobody asked for. */
        this.previous = performance.now();
        this.animate();
      },
      onAbandoned: () => this.showGpuNotice(),
    });
  }

  private showGpuNotice(): void {
    if (this.gpuNotice) return;
    const bar = document.createElement('div');
    bar.className = 'tm-update tm-update--alert';
    bar.setAttribute('role', 'alert');
    bar.innerHTML = `
      <span class="tm-update__text">The device dropped the 3D display.</span>
      <button class="tm-update__go" type="button">RELOAD</button>
    `;
    bar.querySelector('.tm-update__go')?.addEventListener('click', () => {
      window.location.reload();
    });
    document.body.appendChild(bar);
    this.gpuNotice = bar;
  }

  private clearGpuNotice(): void {
    this.gpuNotice?.remove();
    this.gpuNotice = null;
  }

  /* -------------------------------------------------------------- probes */

  /* ------------------------------------------------- the founding quests */

  /** How far below the ORIGINAL ground she is, in mm. Never negative. */
  private depthMm(): number {
    return Math.max(
      0, (this.walkGroundAt(this.at.x, this.at.z) - this.at.y) * MM,
    );
  }

  private questTick(dt: number): void {
    if (!this.questEl) this.buildQuestHud();
    if (this.questStage === 0 && this.depthMm() >= QUEST_DEPTH_MM) {
      this.questStage = 1;
    } else if (this.questStage === 1 && this.deepCarved >= QUEST_CHAMBER_SAMPLES) {
      this.questStage = 2;
      this.cineUntil = performance.now() + 5200;
      if (this.cineEl) this.cineEl.classList.add('is-on');
      this.spawnWorker();
    } else if (this.questStage === 2 && performance.now() > this.cineUntil) {
      this.questStage = 3;
      if (this.cineEl) this.cineEl.classList.remove('is-on');
    }
    this.renderQuest();
    this.poseWorker(dt);
  }

  private buildQuestHud(): void {
    this.questEl = document.createElement('div');
    this.questEl.className = 'density-lab-status rail-status';
    /* Up against the top edge. The shared status style sits 42px down to
     * clear the STATS chip, which the quest box does not need to — it is
     * centred and the chip is hard left, so they never meet. */
    this.questEl.style.top = 'max(8px, env(safe-area-inset-top))';
    this.questEl.style.left = '50%';
    this.questEl.style.right = 'auto';
    this.questEl.style.transform = 'translateX(-50%)';
    this.hud.appendChild(this.questEl);

    /*
     * The founding cinematic, as the brief wrote it: a held black beat
     * while the colony's story turns over. DOM, not canvas — it must sit
     * over everything and cost nothing when off.
     */
    this.cineEl = document.createElement('div');
    this.cineEl.style.cssText = 'position:absolute;inset:0;z-index:40;'
      + 'display:flex;flex-direction:column;justify-content:center;'
      + 'align-items:center;gap:14px;text-align:center;padding:0 9vw;'
      + 'background:rgba(6,5,8,0.88);color:#e8dfc8;pointer-events:none;'
      + 'opacity:0;transition:opacity 1.1s ease;'
      + 'font-family:ui-monospace,monospace;';
    this.cineEl.innerHTML = '<div style="font-size:19px;letter-spacing:0.4px">'
      + 'The Queen has made this her home.</div>'
      + '<div style="font-size:14px;opacity:0.8">Now she waits for her '
      + 'first generation to emerge…</div>';
    const style = document.createElement('style');
    style.textContent = '.density-lab-hud > div.is-on { opacity: 1 !important; }';
    document.head.appendChild(style);
    this.hud.appendChild(this.cineEl);
  }

  private renderQuest(): void {
    if (!this.questEl) return;
    let text = '';
    if (this.questStage === 0) {
      text = `⛏ QUEST · dig the entrance · ${this.depthMm().toFixed(0)}/${QUEST_DEPTH_MM} mm down`;
    } else if (this.questStage === 1) {
      const pct = Math.min(
        100, Math.round((this.deepCarved / QUEST_CHAMBER_SAMPLES) * 100),
      );
      text = `⛏ QUEST · hollow the queen's chamber · ${pct}%`;
    } else if (this.questStage === 3) {
      text = '🐜 the first worker is here · the colony begins';
    }
    if (this.questEl.textContent !== text) this.questEl.textContent = text;
    this.questEl.style.display = text ? '' : 'none';
  }

  /**
   * The first worker: hatched where the chamber quest completed, wearing
   * the real worker rig, pottering a small patrol around her birthplace.
   * She is the payoff — proof the colony is REAL — not yet a colonist
   * with jobs; that part arrives with the sandbox mechanics.
   */
  private spawnWorker(): void {
    if (this.colony.length > 0) return;
    this.workerAnchor.copy(this.at);
    /* A worker first, then a major beside her — the two castes the rig
     * actually ships and the two the sandbox mechanics were written for. */
    let seed = 0x51ce;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (const caste of ['worker', 'major'] as const) {
      const one = new Colonist(caste, rand);
      one.model.ikEnabled = this.ikWanted;
      this.scene.add(one.model.root);
      this.colony.push(one);
      void one.load().then((ok) => {
        if (!ok) return;
        const a = rand() * Math.PI * 2;
        one.place(
          this.workerAnchor.x + Math.cos(a) * COLONIST_ARRIVE,
          this.workerAnchor.z + Math.sin(a) * COLONIST_ARRIVE,
          (x, z) => this.walkGroundAt(x, z),
        );
      });
    }
  }

  private poseWorker(dt: number): void {
    const walker = this.walker;
    if (!walker || this.colony.length === 0) return;
    for (const one of this.colony) {
      one.step(
        dt,
        this.workerAnchor,
        COLONIST_ROAM,
        (x, z) => this.walkGroundAt(x, z),
        (p, into) => { walker.normalAt(p, into); },
        this.groundForLegs,
      );
    }
  }

  setPausedForTest(on: boolean): void { this.paused = on; }

  /** Where the next stroke would land, and what it is aimed at — the numbers
   *  behind "it says it dug and nothing happened". */
  biteProbeForTest(): { seatMm: number; aimDeg: number; upY: number; ceilMm: number } {
    const aim = this.boreAim();
    const spot = new THREE.Vector3();
    const hit = this.biteCentre(aim, NOSE_REACH + JAW_PAST_NOSE, spot);
    return {
      seatMm: hit ? spot.distanceTo(this.at) * MM : -1,
      aimDeg: (this.aimPitch * 180) / Math.PI,
      upY: this.up.y,
      ceilMm: this.bandTop.value * MM,
    };
  }

  /**
   * Point the shovel, from a probe.
   *
   * It writes the LOOK, because that is the input now: `aimPitch` is
   * derived from it every frame, so setting the derived value alone lasted
   * exactly until the next camera update. Both are set so the very next
   * `boreAim()` — before any frame has run — already reads the new angle.
   */
  aimPitchForTest(radians: number): void {
    this.lookPitch = radians;
    this.aimPitch = radians;
    this.lookIdle = 0;
  }

  /**
   * TURN THE LEG SOLVER OFF, to tell a gait fault from a solver fault.
   *
   * Everything upstream keeps running — the corner scheduler, the anchors,
   * the clip, her body — and only the bending of the legs to reach those
   * anchors stops. If feet still stick with this off, the IK was never the
   * problem.
   *
   * Reachable three ways, because the interesting case is on a phone:
   * `?ik=off` in the URL, `window.islandScene.setIK(false)` from a console,
   * and the colonists follow her so the whole colony is one switch.
   */
  setIK(on: boolean): void {
    this.queen.ikEnabled = on;
    for (const one of this.colony) one.model.ikEnabled = on;
  }

  get ikEnabled(): boolean { return this.queen.ikEnabled; }

  /** Whatever the switch is set to now — colonists arrive later and ask. */
  private get ikWanted(): boolean { return this.queen.ikEnabled; }

  /**
   * THE CORNER, IN ONE LINE — for a probe or a console, never for a frame.
   *
   * `FL NEW/PLANT FR NEW/SWING ML OLD/PLANT ...` with the phase, how far the
   * two surfaces disagree, how near the tracked candidate is, and how many
   * feet are actually down. Built only when someone asks: the report itself
   * is state the drive already holds, and this costs a string.
   */
  /**
   * One frame into the recorder, in the units a reader thinks in.
   *
   * Everything here is state the scene already holds — the cost is a small
   * object per frame and nothing at all once sixty seconds are up.
   */
  private readonly telemPrev = new THREE.Vector3();
  private telemHasPrev = false;

  private recordTelemetry(dt: number): void {
    const r = this.driveReport;
    this.telemetry.offer({
      x: this.at.x * VOXEL_MM, y: this.at.y * VOXEL_MM, z: this.at.z * VOXEL_MM,
      upX: this.up.x, upY: this.up.y, upZ: this.up.z,
      walk: this.input.walk,
      yaw: this.input.yaw,
      strafe: this.input.strafe,
      sprint: this.input.sprint,
      reqMmS: this.velocity.length() * VOXEL_MM,
      /*
       * MEASURED, NOT CLAIMED. r.movedMm is what the drive believes it did,
       * and against the anti-embed treadmill the drive believed 7.5 mm/s
       * while the body was pinned to the millimetre for seventeen seconds —
       * the one log column that could have named the bug read healthy.
       * Forward-projected so a snap backward shows as negative.
       */
      actMmS: dt > 1e-6 && this.telemHasPrev
        ? (S_SPOT.copy(this.at).sub(this.telemPrev).dot(this.fwd) * VOXEL_MM) / dt
        : 0,
      heldBackMm: r?.heldBackMm ?? 0,
      planted: r?.planted ?? 0,
      groping: r?.groping ?? 0,
      strain: r?.strain ?? 0,
      allowed: r?.allowed ?? 1,
      clearanceMm: r?.clearanceMm ?? 0,
      seatMm: this.seatLiftMm,
      phase: r?.corner.phase ?? 'none',
      turnDeg: r?.corner.turnDeg ?? 0,
      candidateMm: r?.corner.candidateMm ?? 0,
      onNew: r?.corner.onNew ?? 0,
      onOld: r?.corner.onOld ?? 0,
    }, dt);
    this.telemPrev.copy(this.at);
    this.telemHasPrev = true;
    if (this.telemetryChip) {
      const st = this.telemetry.status;
      this.telemetryChip.textContent = st === 'recording'
        ? `REC ${this.telemetry.elapsed.toFixed(0)}s`
        : st === 'stopped' ? `LOG ${this.telemetry.count}f` : 'REC';
      this.telemetryChip.style.color = st === 'recording' ? '#f87171' : '';
    }
  }

  /** The recording as pasteable text — the console hook, for a probe. */
  telemetryReport(): string {
    return this.telemetry.report(
      `THRONEMOUND TELEMETRY v${__APP_VERSION__} — max ${TELEMETRY_MAX_SECONDS}s`,
    );
  }

  cornerLineForTest(): string {
    const r = this.driveReport?.corner;
    if (!r) return 'no drive';
    const feet = r.feet.map((f) => (
      `${f.slot.replace(/[a-z]/g, '').padEnd(2)} ${f.owner.toUpperCase()}/${f.state}`
    ));
    return `${r.phase} turn=${r.turnDeg}deg cand=${r.candidateMm}mm `
      + `new=${r.onNew} old=${r.onOld} planted=${r.planted} | ${feet.join('  ')}`;
  }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setFacingForTest(radians: number): void {
    /* Three things have to agree or the next frame undoes this: the rig owns
     * the heading, the heading's LAST value is what a turn is measured
     * against, and her nose is what actually points anywhere. */
    this.facing = radians;
    this.bore.turn(radians - this.bore.heading);
    this.headingWas = this.bore.heading;
    this.fwd.set(Math.sin(radians), 0, Math.cos(radians));
    this.walker?.squareForward({ at: this.at, up: this.up, forward: this.fwd });
  }

  teleportMm(xMm: number, zMm: number): void {
    this.at.x = xMm / MM;
    this.at.z = zMm / MM;
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;
    this.velocity.set(0, 0, 0);
    this.underground = false;
    this.hasSafe = false;
    /* Set down the right way up wherever she lands, gripping again. Carrying
     * a ceiling's attitude across a teleport would have her arrive upside
     * down over open ground and fall off the hill. */
    this.up.set(0, 1, 0);
    if (this.walker) {
      this.walker.gripping = true;
      this.walker.fallSpeed = 0;
      this.walker.squareForward({ at: this.at, up: this.up, forward: this.fwd });
    }
    /* Her feet are anchored to world points; a teleport leaves them behind
     * on ground she is no longer standing on. */
    this.drive?.plantAll(
      { at: this.at, up: this.up, forward: this.fwd }, this.groundForLegs,
    );
    if (this.stream) {
      const scroll = this.stream.recentreOn(this.at.x, this.at.z);
      if (scroll) this.onScroll(scroll);
    }
  }

  drainQueueForTest(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queued.delete(this.key(job.cx, job.cy, job.cz));
      this.meshChunk(job.cx, job.cy, job.cz);
    }
    this.reveal();
  }

  /** Is there soil at this ABSOLUTE mm position? Off the LIVE field. */
  solidAtMm(xMm: number, yMm: number, zMm: number): boolean | null {
    const stream = this.stream;
    if (!stream) return null;
    const x = Math.round((xMm / MM - stream.originWorldX) / CELL_SIZE);
    const z = Math.round((zMm / MM - stream.originWorldZ) / CELL_SIZE);
    const y = Math.round(yMm - stream.bandFloorMm);
    if (x < 0 || x > WINDOW_CELLS || z < 0 || z > WINDOW_CELLS
      || y < 0 || y >= SAMPLES_Y) return null;
    return stream.field.get(x, y, z) > 0;
  }

  planForTest(): { id: string; x: number; y: number; z: number }[] {
    return (this.soil?.plan.nodes ?? []).map(
      (n) => ({ id: n.id, x: n.x, y: n.y, z: n.z }),
    );
  }

  /** Elevation in real metres at a position in island millimetres. */
  heightAtMm(xMm: number, zMm: number): number {
    return this.groundHeightAt(xMm / MM, zMm / MM) * MM;
  }

  /** The DRAWN surface's elevation (real m) — what standing-on must match. */
  renderedHeightAtMm(xMm: number, zMm: number): number {
    if (!this.heights) return 0;
    return this.renderedOn(this.heights, xMm, zMm);
  }

  statsForTest(): Record<string, number> {
    return {
      verts: this.terrainVerts,
      tris: this.terrainTris,
      loaded: this.heights ? 1 : 0,
      meshed: this.chunkMeshes.size,
      queued: this.queue.length,
      edited: this.stream?.editedSamples ?? 0,
      scrolls: this.stats.scrolls,
      rebases: this.stats.rebases,
      bandFloorMm: this.stream?.bandFloorMm ?? -1,
      underground: this.underground ? 1 : 0,
      firstPerson: this.firstPerson ? 1 : 0,
      aimDeg: (this.aimPitch * 180) / Math.PI,
      scoopWideMm: SCOOP_WIDE_MM,
      scoopTallMm: SCOOP_TALL_MM,
      scoopDeepMm: SCOOP_DEEP_MM,
      digMode: this.digMode ? 1 : 0,
      questStage: this.questStage,
      questDepthMm: +this.depthMm().toFixed(1),
      deepCarved: this.deepCarved,
      workerOut: this.colony.filter((c) => c.ready).length,
      playerReady: this.playerReady ? 1 : 0,
      statsOpen: this.statsPanel.bodyVisible ? 1 : 0,
      designing: this.designer?.isOpen ? 1 : 0,
      planNodes: this.soil?.plan.nodes.length ?? 0,
      designX: this.designOriginMm.x,
      designY: this.designOriginMm.y,
      designZ: this.designOriginMm.z,
    };
  }

  /** The whole plan, deep-copied, in island mm — for probes to extend. */
  currentPlanForTest(): NestPlan {
    return JSON.parse(JSON.stringify(this.soil!.plan)) as NestPlan;
  }

  /** Run the designer's DIG IT pipeline on a plan in island mm. */
  applyPlanForTest(plan: NestPlan): void {
    this.applyPlan(plan);
  }

  closeDesignerForTest(): void {
    this.closeDesigner();
  }

  private readonly refuseGesture = (e: Event): void => { e.preventDefault(); };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.stopContextGuard?.();
    this.stopContextGuard = null;
    this.clearGpuNotice();
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.host.removeEventListener(name, this.refuseGesture);
    }
    this.statsPanel.dispose();
    this.designer?.dispose();
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mesh of this.stands.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.stands.clear();
    this.forestMaterial?.dispose();
    this.tree?.dispose();
    this.islandMaterial?.dispose();
    this.soilMaterial?.dispose();
    if (this.textures) for (const tex of Object.values(this.textures)) tex.dispose();
    this.nestView?.dispose();
    this.queen.dispose();
    for (const one of this.colony) one.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
