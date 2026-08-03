/**
 * The block room: one cube of dirt, and an ant who can walk all the way
 * round it.
 *
 * This is a deliberate restart. The colony sim grew a streamed world, a
 * climb, a save, a menu and a first-person capsule, and somewhere in that
 * pile the feel of digging broke and stayed broken. Rather than keep
 * bisecting a large room, this is the smallest room that can still be wrong
 * in an interesting way: a 64 mm block of soil, the queen standing on it,
 * and two verbs — walk, dig.
 *
 * Three things are copied from the Godot build rather than invented here,
 * because they are known to work there:
 *
 *   1. THE BLOCK. A cube, not a landscape. Six faces, eight corners, twelve
 *      edges, and every one of them a case that walking has to survive.
 *   2. ADHESION. She walks on the top, the sides and the UNDERSIDE without
 *      falling off. Her "down" is the surface she is on, not the world's.
 *   3. DIGGING AT THE MANDIBLE. The bite is taken at the jaw bone and
 *      reaches out by a bite width measured off her own bones — see
 *      `QueenModel.antennaToJaw` — rather than from a crosshair.
 *
 * ## What is deliberately NOT here
 *
 * No streaming, no save, no menu, no climb machinery, no underground sense,
 * no HUD instruments. Those are the things being re-added one at a time, and
 * a room that starts with them has nothing to tell us.
 *
 * ## Modes, and the head
 *
 * She has a MODE — walk, dig, combat — cycled with `*` and `/` or by tapping
 * the chip above the action button, and the mode decides two things: which
 * action button is on screen at all, and whether her head PITCHES.
 *
 * Her head yaws toward the camera in every mode, because the view can be
 * swung right round her and a body facing north while you look south should
 * not stare rigidly ahead; her gaster swings the other way at 30% of it, as
 * a counterweight. But she only pitches her face while digging. That was the
 * open problem this room was built to answer — the gait held her head up, so
 * a jaw-mounted bite aimed where the ANIMATION pointed rather than where the
 * player was looking. In DIG mode the two are now the same angle.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import { FollowCamera } from './FollowCamera';
import { STICK_DEADZONE, clampStickOrigin, stickVector } from '../voxel/locomotion';
import { MODES, cycleMode } from './modes';
import { RAIL_SMOOTH_MM, TunnelRail, railFromPlan } from './tunnelRail';
import { senseRoom, type RoomSense } from '../voxel/room';
import { anyOf, bore, box, carve } from '../voxel/carve';
import { carvePlan, inWorldUnits } from '../nest/nestCarve';
import {
  groundOf, sampleEdge, tallestMoundMm, validatePlan, MOUND_SPREAD,
  type NestPlan, type Vec3,
} from '../nest/nestPlan';
import { demoNest } from '../nest/demoNest';
import { buildNestView, type NestView } from '../nest/nestView';
import { NestDesigner } from '../nest/NestDesigner';
import { makeClod, stepClods, type Clod } from '../voxel/clodBurst';
import {
  DigPlanRunner, PIECE_LIMITS, PLAN_SPEED_MM_S, clampPiece, type DigPiece,
} from './digPlan';
import { SENSE_EASE, makeSensed, type SenseUniforms } from './undergroundSense';
import {
  CASTE_BITE_MM, CASTE_LENGTH_MM, HEAD_PITCH_DOWN, HEAD_PITCH_UP, HEAD_YAW_LIMIT,
} from '../anim/hexapod';
import {
  FOOT_CLEARANCE_MM, LegDrive, type DriveReport, type LegSetup,
} from '../anim/legDrive';

/** Millimetres per world unit, the scale the whole project runs on. */
const MM = 5;

/**
 * The block: 64 mm on a side, sampled every half millimetre.
 *
 * Both halves are chosen against the same constraint — the bite. A queen's
 * mandible is 1.75 mm across, so at half-millimetre cells a bite spans three
 * and a half of them, which is enough for the brush to read as a bite rather
 * than a stairstep. Finer would be prettier and cost four times the memory
 * for a room whose whole point is to be small: 129³ samples is 8.6 MB, and
 * the quarter-millimetre version of the same cube would be 69 MB.
 *
 * Sixty-four millimetres is about seven queens end to end — big enough that
 * walking round it is a journey and the faces are not all in shot at once,
 * small enough to see the whole experiment.
 */
const BLOCK_MM = 64;
const CELL_MM = 0.5;
const CELL = CELL_MM / MM;
const BLOCK_CELLS = Math.round(BLOCK_MM / CELL_MM);
/**
 * Air around the block, and it is not padding — it is the only reason the
 * outside of the cube gets a surface at all.
 *
 * Surface nets draws where the field CROSSES zero. Filled as
 * `min(x, SPAN - x, ...)` the field is zero on the boundary sample and
 * positive everywhere inside: it never goes negative, so there is no
 * crossing to draw and the outer faces come out missing or patchy — you can
 * see straight through the block from outside, which is exactly what was
 * reported. Three cells of genuinely negative space on every side gives the
 * mesher the sign change it needs, and the faces close.
 */
const MARGIN_CELLS = 3;
const CELLS = BLOCK_CELLS + MARGIN_CELLS * 2;
const SPAN = CELLS * CELL;
/** The block's own bounds inside that field, and its middle. */
const LOW = MARGIN_CELLS * CELL;
const HIGH = LOW + BLOCK_CELLS * CELL;
const MID = (LOW + HIGH) * 0.5;
/**
 * How high the lower half of the test step stands — halfway up the block, so
 * the face she drills into is some thirty millimetres of wall, far taller than
 * she is. The bore then goes into rock rather than over a lip.
 */
const STEP_TOP = MID;

/* ------------------------------------------------- the pre-cut test warren */

/** Where the shaft drops, in millimetres from the block's low corner. */
const SHAFT_AT = BLOCK_MM / 2;
/** Across the bore. Ten millimetres total, so five of radius. */
const SHAFT_WIDE = 10;
/** The room at the bottom: ten across, ten tall, twenty long. */
const ROOM_W = 10;
const ROOM_H = 10;
const ROOM_LONG = 20;
/** How far up from the block's floor the room's floor sits. */
const ROOM_FLOOR = 6;

/** Cells per meshed chunk, so a bite rebuilds a corner and not the cube. */
const CHUNK = 32;

/** How far off the soil her body rides, and how far a foot may reach. */
const RIDE = 1.4 / MM;

/** The adhesion cast: from this far off her back, in through her soles. */
const GRIP_LIFT = 3 / MM;
const GRIP_REACH = 9 / MM;
/** Looking for the far side of an edge: behind and below, in her own frame. */
const WRAP_ARCS = [0.6, 1.1, 1.7, 2.4];

/** World units per second. Slower than the sim's run — this is a small room. */
const WALK_SPEED = 1.6;
const YAW_RATE = 2.2;
/**
 * How fast the eased stick catches the real one, per second. Ten is a time
 * constant of a tenth of a second: 63% of the way there in 100 ms, 95% in
 * 300. Fast enough to feel direct, slow enough that rolling a thumb round
 * the pad reads as one curve instead of a walk and a turn taking turns.
 */
const STICK_EASE = 10;
/** How fast her up eases onto a new face. Snappy, or corners read as slides. */
/**
 * How steep a grade the gyro will accept, up or down. Her neck stops at 75
 * degrees down and the body has no reason to out-reach where she can look.
 */
const TRIM_LIMIT = (75 * Math.PI) / 180;
/** Scratch for the room spray, so sensing allocates nothing per frame. */
const PROBE = new THREE.Vector3();

/* ------------------------------------------------------------- the railway */

/**
 * How far to look when asking what kind of space she is in, and how finely.
 * Twelve millimetres is comfortably wider than any tunnel she digs and
 * comfortably narrower than the block, so it separates the two cleanly.
 */
const ROOM_REACH_MM = 12;
const ROOM_STEP_MM = 0.5;
/**
 * How often the spray is re-marched. Fourteen rays is a few hundred field
 * lookups; the answer changes over tenths of a second, not frames.
 */
const ROOM_EVERY = 4;
/**
 * Boxed in past this and she counts as UNDERGROUND, as a band.
 *
 * Guessed at 0.72 first, from the fact that open ground only meets soil on the
 * downward half of the spray. That reasoning is right and the number was still
 * wrong: measured inside a tunnel she has just dug, enclosure runs anywhere
 * from 0.64 to 1.00 depending on how much of the roof she has taken out, so
 * 0.72 threw her off the rails in her own bore. A band, because a threshold on
 * a quantity that wanders is a thing that flickers — the same lesson the
 * camera's no-room test taught.
 */
/**
 * How close a ceiling has to be, along HER OWN UP, before she counts as
 * underground — and how far it has to go before she stops. Millimetres.
 *
 * Two statistical discriminators were tried first and both failed on cases the
 * game actually contains. Enclosure cannot do it: measured, the surface reads
 * 0.64 to 0.71 and her own bore 0.64 to 1.00, and they overlap. A count of
 * upward WORLD rays that meet soil cannot either — it is right on the top face
 * and wrong on the other five, where the rising corners point straight back
 * into the block, so walking round the side of the mound read as being inside
 * it for 336 frames out of 600.
 *
 * This one is not statistical. Her up is by definition the way OUT of the
 * surface she is gripping, so soil along it means something over her head and
 * nothing else: sky on the top face, open air off a side or the underside, and
 * a ceiling only when she is genuinely in a hole.
 *
 * The reach is generous on purpose, and was not generous enough at first. Six
 * millimetres is about right for the four-millimetre bores she chews, and in a
 * pre-cut shaft ten millimetres across the far wall is eight and a half away —
 * so she crawled the whole length of a vertical shaft with the readout calling
 * it the surface. Being generous costs nothing, because on any face of the
 * block the cast along her up goes to the sky and misses at any range at all.
 */
/**
 * How long a ceiling reading must hold before it counts, in seconds.
 *
 * See `judgeWhereSheIs`. A quarter of a second, the same figure the camera's
 * no-room test settled on — long enough to throw away the flank of a hill,
 * short enough that walking into a real tunnel is not visibly late.
 */
const ROOF_DWELL = 0.25;

/**
 * How many loose clods may exist at once.
 *
 * Godot has no cap because a bite there is a click; here DIG latches and holds,
 * which is several bites a second for as long as a finger stays down. Twelve
 * seconds of that without a limit is hundreds of meshes.
 */
const MAX_CLODS = 40;

const CEILING_ENTER_MM = 13;
const CEILING_LEAVE_MM = 18;
/**
 * Wider than this and it is a ROOM, not a tunnel: enclosed on all sides but
 * with space to walk about in, so she comes off the rails and is free.
 *
 * MEASURED, not chosen. The first attempt guessed eight millimetres from her
 * body size and nothing ever reached it — a bore she has just dug reads 2.0 to
 * 2.75 and a room walked out of the soil reads 4.25, so eight was a threshold
 * on the far side of everything that exists. These sit either side of the gap,
 * as a band rather than a line because the two are close enough together that
 * a single value would have her flickering on and off the rails at the mouth
 * of a chamber.
 */
const CHAMBER_ENTER_MM = 3.6;
const CHAMBER_LEAVE_MM = 3.0;
/**
 * How close to the track she has to be to board it, in millimetres.
 *
 * Paired with the smoothing window: the smoothed line runs a little inside
 * every bend of the raw one, so the radius has to cover that gap or a
 * well-smoothed track becomes one she cannot get onto. At a fourteen
 * millimetre window three was already too tight.
 */
const RAIL_CAPTURE_MM = 4;
/** How far she must travel while digging before another sleeper is laid. */
const RAIL_SPACING_MM = 0.4;
const ALIGN = 12;
/**
 * The fastest her body will turn, however hard the soil argues — degrees a
 * second. Ordinary cornering round the block's edge peaks well inside this;
 * what it stops is a grip that flipped to a different face taking the whole
 * view with it in one frame.
 */
const MAX_TILT_RATE = (240 * Math.PI) / 180;
const SNAP = 14;
const GRAVITY = 9;

/**
 * First person: 90 degrees, down from 120.
 *
 * Wide, because an eye at an ant's head is a centimetre from the soil and a
 * narrow lens shows a wall with no sense of where its edges are. But 120 was
 * reported as dizzying, and it would be: at that width the edges of the frame
 * stretch hard, and everything near the eye — which underground is
 * everything — sweeps across it far faster than it moves. Ninety keeps the
 * context and loses most of the distortion.
 */
const FIRST_PERSON_FOV = 90;
const THIRD_PERSON_FOV = 60;

/**
 * How wide a lens the player may ask for, in degrees.
 *
 * Fifty is a long lens — flat, calm, and it makes a tunnel feel like a
 * corridor seen through a letterbox. A hundred and forty is a fisheye, which
 * underground is genuinely useful (you can see a side passage you would
 * otherwise walk past) and on the surface stretches the horizon into a bowl.
 * Both ends are usable, which is why they are the ends.
 */
const FOV_MIN = 50;
const FOV_MAX = 140;

/** Where the chosen lenses are kept between visits. */
const FOV_STORE = 'thronemound.fov';

/** A field of view the projection will accept, whatever was asked for. */
function clampFov(degrees: number): number {
  if (!Number.isFinite(degrees)) return THIRD_PERSON_FOV;
  return Math.min(FOV_MAX, Math.max(FOV_MIN, Math.round(degrees)));
}

/**
 * How far one tap of a tuner button moves the eye, in mm, and its pitch, in
 * degrees. Small enough to land on something, big enough to get there.
 */
/**
 * A fifth of a millimetre ahead of the sockets, tuned on the device and kept.
 *
 * Dead on the socket the eye sits just far enough back that her own head
 * clips the near plane. Two taps forward on the tuner cleared it and put the
 * mandibles in shot, so that is where it starts now; the tuner still moves it
 * from here.
 */
/**
 * The head-profile inset: how far to the side the eye sits, how much of her
 * it frames, and how much of the screen it takes. Six millimetres of span is
 * her head and a little of her thorax — enough context to read a nod against,
 * without her legs cluttering it.
 */
const HEAD_INSET_MM = 12;
const HEAD_INSET_SPAN_MM = 6;
const HEAD_INSET_FRACTION = 0.32;
/**
 * How many antenna-to-jaw spans wide a bite is.
 *
 * The rule as given was two, and two is what her anatomy says. Four is a
 * PACING decision on top of it: at two spans a queen's bite takes about
 * 1.4 mm3 and a burrow is half an hour of tapping, which nobody wants to do.
 * Doubling the radius is eight times the soil per bite.
 *
 * Kept as a multiple of the measured span rather than a millimetre figure, so
 * a worker and a major still scale off their own heads.
 */
const BITE_WIDTH_SPANS = 4;
/**
 * How deep the eye must be for the underground view to be at full strength.
 * Five millimetres is a bit over half her body length — a burrow she has her
 * head inside rather than a dip she is crossing.
 */
const SENSE_FULL_MM = 5;
/** How far up to look for soil overhead when measuring that depth. */
const SENSE_PROBE_MM = 14;
const EYE_FORWARD_MM = 0.2;
const EYE_NUDGE_MM = 0.1;
const EYE_NUDGE_DEG = 2;

const STICK_RADIUS = 70;
const LOOK_PER_PIXEL = 0.005;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Some unit vector at right angles to `v`.
 *
 * Which one does not matter — the caller wants two directions across a tunnel,
 * not a named pair. Crossing with world up would collapse to nothing on a
 * vertical shaft, which is the one case a nest always has, so it crosses with
 * whichever axis `v` leans on least.
 */
function sideways(v: Vec3): THREE.Vector3 {
  const away = Math.abs(v.y) < 0.9 ? WORLD_UP : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3()
    .crossVectors(new THREE.Vector3(v.x, v.y, v.z), away)
    .normalize();
}

export class BlockScene {
  /**
   * Which block to build. `cube` is the room; `cliff` is a measuring rig — see
   * where the field is filled. Chosen with `?shape=cliff`.
   */
  private readonly shape: 'cube' | 'cliff' | 'shaft' | 'nest' = (() => {
    const asked = new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('shape');
    return asked === 'cliff' || asked === 'shaft' || asked === 'nest' ? asked : 'cube';
  })();

  /**
   * Whether the coaster builder is offered at all.
   *
   * OFF, and hidden rather than deleted. Planned digging does not work well
   * enough to be in the way of testing the manual kind, and everything under
   * it — the path integrator, the pacing, the piece geometry — is tested and
   * worth keeping for when the digging itself is solid. `?plan=1` brings it
   * back.
   */
  private readonly planEnabled = new URLSearchParams(
    typeof location === 'undefined' ? '' : location.search,
  ).get('plan') === '1';

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly follow: FollowCamera;
  private readonly field: DensityField;

  /**
   * The designed nest this block was carved from, or null when the block was
   * not carved from one. Held so the soil can be checked against the plan and,
   * later, so the routing has the same graph the carving used.
   */
  private nest: NestPlan | null = null;
  private readonly queen: QueenModel;
  private readonly chunks = new Map<string, THREE.Mesh>();
  /*
   * DOUBLE SIDED, and not as a shrug — as the only honest answer until the
   * mesher is fixed.
   *
   * `buildSurfaceNets` winds its NEGATIVE-facing surfaces backwards. Tallied
   * on this very block, triangle by triangle: the +X, +Y and +Z faces come
   * out ~32,000 wound outward and a few hundred not, while X-, Y- and Z-
   * come out 31,752 wound INWARD and not one correct. Backface culling then
   * removes exactly those three faces, which is the "terrain is not showing
   * on all directions" this room was reported for — and, far more
   * importantly, it is why a tunnel CEILING is invisible from underneath:
   * a ceiling is a -Y surface.
   *
   * The heightfield rooms never showed it because a landscape's surface
   * faces up, and +Y is the case that works.
   *
   * Drawing both sides costs fill rate and hides the bug rather than fixing
   * it. It is not a one-line flip, and that is measured too: inverting the
   * `flip` rule in `addQuad`'s three call sites (`start < 0` to `start > 0`)
   * does not correct the negative faces, it reverses the POSITIVE ones as
   * well — the tally goes from three faces right to none right. So the flag
   * globally reverses the mesh rather than distinguishing the two directions
   * a crossing can face, and whatever actually decides orientation is
   * somewhere else. The next pass at it starts from that, with the
   * watertightness suite's orientation check as the harness.
   */
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x7a5136, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });

  /**
   * The underground view, faded in by DEPTH.
   *
   * Digging is unreadable from inside a hole: the eye is a millimetre from a
   * wall, the wall is one flat brown, and there is nothing in the picture to
   * tell you which way is out. The sense shader replaces that with contours
   * and a grid — the same one the colony sim uses — so the shape of the space
   * around her is legible even when the lighting says nothing.
   *
   * Driven by how far under the surface the EYE is, not by a flag: none at
   * the surface, full at `SENSE_FULL_MM` below it. A switch would flip on the
   * frame her head crossed the soil, which is exactly the frame she is
   * bobbing across it several times a second.
   */
  private readonly sense: SenseUniforms = makeSensed(this.material);

  /** Where she is, and the frame she is in. `up` is the face she is on. */
  private readonly at = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly velocity = new THREE.Vector3();
  private gripping = true;
  private fallSpeed = 0;
  private walkSpeed = 0;
  private turnRate = 0;
  private ready = false;
  private removed = 0;
  /** Where the last bite landed and how big it was. For probes. */
  private readonly lastBiteAt = new THREE.Vector3();
  private lastBiteRadius = 0;

  /**
   * Where the player is looking, as a pitch. The seam the head tracking will
   * plug into: today it aims the CAMERA only, and the jaws point wherever
   * the gait is holding her head, which is the open problem.
   */
  private aimPitch = 0;

  /**
   * The legs, and after `plantAll` they are what actually moves her. Null
   * until the model has loaded, because the leg homes are read off the rig.
   */
  private drive: LegDrive | null = null;
  private report: DriveReport | null = null;
  /**
   * Which mode she is in, as an index into `MODES`. Decides whether her head
   * pitches with your look and which action button is on screen.
   *
   * Opens in DIG rather than at the top of the ring, because this room exists
   * to test digging and it is reloaded on a phone dozens of times a session.
   * A default that costs a tap every single time is the wrong default.
   */
  private mode = MODES.findIndex((m) => m.id === 'dig');
  private readonly modeButton = document.createElement('button');
  /** The one action button, whose meaning is the mode's. See `setMode`. */
  private readonly actionButton = document.createElement('button');
  /**
   * First person, and the tuning offsets for where its eye sits.
   *
   * The eye starts at the midpoint of her antenna sockets, measured off the
   * rig — see `QueenModel.eyeOffset` — and these are a nudge on top of it,
   * in HER frame, so it can be dialled in on the device and the settled
   * numbers folded back into the code. The tuner disappears with them.
   */
  private firstPerson = false;
  private readonly eyeNudge = new THREE.Vector3();
  private eyePitch = 0;
  private readonly tuner = document.createElement('div');
  private readonly viewButton = document.createElement('button');
  /** Instruments off by default: they cover the thing they measure. */
  private debug = false;
  private readonly debugButton = document.createElement('button');
  private readonly trimButton = document.createElement('button');

  /**
   * The sonar view: the designed nest drawn through the soil.
   *
   * Only built when the block was carved from a plan, and on by default when it
   * was — the first thing anyone wants to know about a nest they designed is
   * whether the soil did what the drawing said, and that is a question you
   * answer by looking at both at once.
   */
  private nestView: NestView | null = null;

  /** Built the first time DIG is pressed on a block that came from a plan. */
  private designer: NestDesigner | null = null;

  /** Loose soil in the air, and the mesh drawn for each. Same order, always. */
  private clods: Clod[] = [];

  private readonly clodMeshes: THREE.Mesh[] = [];

  /*
   * One geometry and one material for every clod. Godot builds a SphereMesh per
   * lump because it can afford to; here a bite a frame would be a new buffer a
   * frame. Size and squash go on the instance's scale instead.
   */
  private readonly clodGeometry = new THREE.SphereGeometry(1, 9, 5);

  private readonly clodMaterial = new THREE.MeshStandardMaterial({
    // Godot: albedo Color(0.48, 0.30, 0.16), roughness 1.0.
    color: new THREE.Color(0.48, 0.30, 0.16), roughness: 1,
  });

  /** The HUD root, kept so the designer can hang its own panel on it. */
  private hud!: HTMLElement;

  private readonly nestButton = document.createElement('button');

  private sonar = true;

  /**
   * The two lenses, in degrees, and they are two rather than one on purpose.
   *
   * Watching her walk and being her want different glass. Third person is a
   * shot OF something and a wide lens there just pushes her further away; first
   * person is a shot FROM somewhere and a narrow lens there is a letterbox in a
   * tunnel with no peripheral view of the walls going past — which is most of
   * what tells you you are moving at all.
   */
  private fov = { first: FIRST_PERSON_FOV, third: THIRD_PERSON_FOV };

  private readonly settings = document.createElement('div');

  private readonly settingsButton = document.createElement('button');
  private readonly planButton = document.createElement('button');
  private readonly planner = document.createElement('div');
  private readonly planList = document.createElement('pre');
  private readonly planRunButton = document.createElement('button');
  private readonly planFields = new Map<keyof DigPiece, { value: HTMLElement; unit: string }>();
  /** The piece being drafted, before it is added to the queue. */
  private draft: DigPiece = { pitch: -15, turn: 0, roll: 0, length: 5 };
  /** The eased stick, which is what actually drives her. See `step`. */
  private driveWalk = 0;
  private driveYaw = 0;
  /**
   * How far her body origin rides above the surface — DERIVED from the legs,
   * not chosen.
   *
   * It began as a hand-picked 1.4 mm and that was the whole reason only two
   * legs could reach the ground: the rig's own foot homes sit at y = +0.27 mm,
   * so her origin is essentially AT her contact plane rather than above it,
   * and lifting the body 1.4 mm lifted every foot target 1.7 mm clear of the
   * block — past the 1.1 mm a front leg has to spare. The rear pair, with
   * 1.83 mm, could just reach, which is exactly what the first run measured:
   * two planted, four groping.
   *
   * In a design where the legs carry the body, the body's height is the legs'
   * business. So it is the feet's own offset, plus the ride clearance.
   */
  private ride = RIDE;

  private readonly input = { walk: 0, yaw: 0, dig: false };
  /**
   * THE GYRO: an attitude she flies to, rather than one the ground picks for
   * her. `pitch` is the GRADE her nose holds against world horizontal, nose-up
   * positive; `hold()` pitches its goal until she is on it.
   *
   * What it is for, measured rather than assumed. Everything about how she sits
   * was, until this, decided entirely by the soil — `hold()` casts through her
   * soles, finds a face, and eases her up onto its normal. Underground that
   * means floor, wall and ceiling normals swapping about beneath her, each swap
   * yanking her whole body: over twenty seconds of tunnelling her nose wandered
   * with a standard deviation of 39.5 degrees and tumbled through 6952 degrees
   * in total. Holding a grade through the same run: 11.0 degrees and 2861, for
   * the same depth reached. Seventy per cent less wander at no cost in
   * progress, which is "the camera going all over the place while digging"
   * with a number attached.
   *
   * What it is NOT for, which corrects what I first assumed of it. It does not
   * unlock digging downward, because nothing was blocking that. Digging while
   * STANDING STILL sinks her 0 mm at any trim — `hold()` grabs the first solid
   * under her and, stood on a plateau beside a pit, that is the plateau. Biting
   * while she WALKS sinks her tens of millimetres with no gyro at all, and
   * trimming nose-down makes entry steadily worse: 44.7 mm untrimmed, 14.1 at
   * -40 degrees, 2.8 at -60, 1.7 at -75, because a steeply pitched body aims
   * its grip cast into intact soil and seats on that instead of travelling.
   * So dig in with it off and switch it on once she is under — which is where
   * it was asked to live in the first place.
   *
   * Off, this is the identity: she lies on the normal exactly as before, and
   * the six-face walk is untouched.
   */
  private readonly trim = { on: false, pitch: 0, roll: 0 };
  /**
   * The plan she is flying, if she is flying one. See `digPlan`.
   *
   * The runner is pure and knows nothing about soil; this end owns the two
   * things it cannot: turning its heading command into steering the LEGS
   * actually perform, and holding the bite down while a piece runs.
   */
  /**
   * THE RAILWAY. See `tunnelRail` for why the tunnel is written down at all.
   *
   * Three states, and the rule between them is one measurement: how boxed in
   * she is, and how wide the space is.
   *
   *   SURFACE   not enclosed. She walks as she always has, on any face of the
   *             block, and none of this applies.
   *   TUNNEL    enclosed and narrow. She rides the track she dug: the stick
   *             moves her along it and nothing steers, because a bore four
   *             millimetres across has no room for a decision. This is what
   *             makes it steady — position and attitude come off a recorded
   *             curve rather than off soil she is still chewing.
   *   CHAMBER   enclosed but WIDE. A room underground is a place to walk
   *             about, so she is free again.
   *
   * Digging always releases her. Laying track and riding it are different
   * jobs, and holding DIG is how you say which you are doing.
   */
  private rail: TunnelRail | null = null;
  private railS = 0;
  /**
   * How far either side the track is averaged when she rides it. A field
   * rather than a constant because it had to be swept against the real
   * recording to pick — see `probe-rails`.
   */
  railSmoothMm = RAIL_SMOOTH_MM;
  private onRails = false;
  private room: RoomSense = {
    enclosed: 0, boreMm: ROOM_REACH_MM, nearestMm: ROOM_REACH_MM, roofed: 0,
  };
  private roomTick = 0;

  private plan: DigPlanRunner | null = null;
  private planPieces: DigPiece[] = [];
  /** The track the running plan describes, and how far along it she is. */
  private planRail: TunnelRail | null = null;
  private planS = 0;
  private lastPlanS = 0;
  private digCooldown = 0;
  /** True while dig is latched on via tap-to-toggle. */
  private digLatch = false;
  /** Set by `setPausedForTest` so probes own the clock. Never set in play. */
  private paused = false;
  /** Why the last bite did nothing, for probes. Cleared on a real bite. */
  private lastBiteWhy = 'never ran';

  private readonly status: HTMLDivElement;
  private readonly stick = document.createElement('div');
  private readonly stickKnob = document.createElement('div');
  private readonly stickOrigin = { x: 0, y: 0 };
  private stickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lookAt = { x: 0, y: 0 };
  private frame = 0;
  /**
   * The head-profile inset's camera. Orthographic and framed on her head —
   * see `renderHeadInset`.
   */
  private readonly headCam = new THREE.OrthographicCamera(
    -HEAD_INSET_SPAN_MM / 2 / MM, HEAD_INSET_SPAN_MM / 2 / MM,
    HEAD_INSET_SPAN_MM / 2 / MM, -HEAD_INSET_SPAN_MM / 2 / MM,
    0.01, 40 / MM,
  );
  private previous = performance.now();
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly host: HTMLElement) {
    host.replaceChildren();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x8db4d6);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 400);
    this.follow = new FollowCamera(this.camera, {
      distance: 24 / MM, minDistance: 2.4, maxDistance: 24, eyeHeight: 1.8 / MM,
      clearance: CELL * 2, ease: 8,
    });
    this.follow.mode = 'third';

    this.field = new DensityField({
      cellsX: CELLS, cellsY: CELLS, cellsZ: CELLS, cellSize: CELL,
    });
    /*
     * A cube as a signed field: the distance to the nearest face, positive
     * inside. Surface nets rounds the edges by about a cell, which is what a
     * block of soil looks like anyway — a machined corner would be the
     * surprising part.
     */
    if (this.shape === 'nest') {
      /*
       * A DESIGNED NEST, carved from the plan rather than from a list of
       * shapes written out here.
       *
       * Every other rig in this file describes its geometry twice over — once
       * as the field that gets carved and once, implicitly, in whatever walks
       * it. That is the failure that cost the most time in this project: the
       * dug-tunnel code kept a raw view and a smoothed view of one track, they
       * disagreed by six millimetres on a bend, and she boarded a tunnel she
       * was four millimetres from and was set down outside it. Here the plan is
       * the only description. The soil is cut from it, the routing runs over
       * it, and there is nothing for either to drift away from.
       */
      this.nest = demoNest();
      this.carveNest();
    } else if (this.shape === 'shaft') {
      /*
       * A SHAFT AND A ROOM, cut to a number before anything is bitten.
       *
       * A tunnel she dug is a recording of every wobble she had while digging
       * it, so measuring her in one measures the digging as much as the thing
       * under test. This is a bore of exactly ten millimetres running exactly
       * straight down into a room of exactly ten by ten by twenty — which
       * makes it possible to ask what her grip and the camera do at ninety
       * degrees with nothing else going on at all.
       *
       * The shaft's bottom end sits INSIDE the room's ceiling on purpose. Stop
       * it at the ceiling and a wafer of soil is left across the opening, and
       * she arrives at a lid instead of a doorway.
       */
      const mm = (v: number): number => LOW + v / MM;
      const room = box(
        [mm(SHAFT_AT - ROOM_W / 2), mm(ROOM_FLOOR), mm(SHAFT_AT - ROOM_LONG / 2)],
        [mm(SHAFT_AT + ROOM_W / 2), mm(ROOM_FLOOR + ROOM_H), mm(SHAFT_AT + ROOM_LONG / 2)],
      );
      const shaft = bore(
        [mm(SHAFT_AT), mm(BLOCK_MM + 4), mm(SHAFT_AT)],
        [mm(SHAFT_AT), mm(ROOM_FLOOR + ROOM_H - 2), mm(SHAFT_AT)],
        SHAFT_WIDE / 2 / MM,
      );
      const solid = box([LOW, LOW, LOW], [HIGH, HIGH, HIGH]);
      this.field.fill(carve(solid, anyOf([room, shaft])));
    } else if (this.shape === 'cliff') {
      /*
       * A STEP, for measuring rather than for playing: a flat plateau to walk
       * in on and a face at exactly ninety degrees to drill into.
       *
       * The point of it is that a level approach and a vertical wall mean
       * every correct answer is a straight line. Walking in at nought degrees
       * and boring straight ahead, her height must not change, her heading
       * must not change, and nothing may drift sideways — so any wobble in the
       * body or the camera is the whole of the reading, with no slope or
       * curvature for it to hide behind.
       */
      this.field.fill((x, y, z) => Math.min(
        x - LOW, HIGH - x, y - LOW, (z < MID ? STEP_TOP : HIGH) - y,
        z - LOW, HIGH - z,
      ));
    } else {
      this.field.fill((x, y, z) => Math.min(
        x - LOW, HIGH - x, y - LOW, HIGH - y, z - LOW, HIGH - z,
      ));
    }
    this.remeshAll();

    this.addLighting();
    this.queen = new QueenModel('queen');
    this.scene.add(this.queen.root);

    // On top of the block, in the middle, facing +Z. On the step, back from
    // the face with a clear run at it.
    if (this.shape === 'cliff') this.at.set(MID, STEP_TOP + RIDE, MID - 20 / MM);
    else if (this.shape === 'shaft') {
      // Beside the mouth, facing it, so walking forward takes her over the lip.
      this.at.set(LOW + SHAFT_AT / MM, HIGH + RIDE, LOW + (SHAFT_AT - 11) / MM);
    } else if (this.shape === 'nest') {
      // Back from the designed entrance, on the surface, with a clear run at
      // it — the same arrangement the shaft rig uses, so the two are
      // comparable.
      /*
       * On the ground the PLAN put there, clear of the heap.
       *
       * `HIGH` is the top of the block and is no longer where the ground is —
       * the nest's ground sits lower so the anthill has headroom. Spawning at
       * HIGH would drop her a dozen millimetres through air, and the far side
       * of the heap is where she can walk at it rather than start halfway up it.
       */
      const mouth = demoNest().nodes[0]!;
      const clear = mouth.radiusMm * MOUND_SPREAD + 6;
      this.at.set(
        LOW + mouth.x / MM, LOW + mouth.y / MM + RIDE,
        LOW + (mouth.z - clear) / MM,
      );
    } else this.at.set(MID, HIGH + RIDE, MID);
    this.follow.target.copy(this.at);

    const hud = document.createElement('div');
    this.hud = hud;
    hud.className = 'density-lab-hud';
    host.appendChild(hud);
    this.status = document.createElement('div');
    this.status.className = 'density-lab-status';
    hud.appendChild(this.status);
    // Before the controls, so the sliders open on the lenses actually in use.
    this.loadFov();
    this.buildControls(hud);

    void this.queen.load().then((ok) => {
      this.ready = ok;
      if (!ok) return;
      this.queen.root.visible = true;
      this.buildLegs();
    });

    (window as unknown as { blockScene?: unknown }).blockScene = this;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.material.dispose();
    this.queen.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xc9e6ff, 0x4a2f1f, 1.8));
    const sun = new THREE.DirectionalLight(0xfff1ce, 2.6);
    sun.position.set(SPAN * 1.4, SPAN * 2, SPAN * 0.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const extent = SPAN * 0.9;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.far = SPAN * 6;
    this.scene.add(sun);
    /*
     * A second light from BELOW, which a landscape would never want and this
     * room cannot do without: she spends a third of her time on the
     * underside, and an unlit underside is a black screen with an ant on it.
     */
    const bounce = new THREE.DirectionalLight(0xbfd8ff, 0.9);
    bounce.position.set(-SPAN * 0.6, -SPAN * 2, -SPAN * 0.4);
    this.scene.add(bounce);
  }

  /* ----------------------------------------------------------- the soil */

  /** Signed density at a world point: positive inside the soil. */
  densityAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x > SPAN || y > SPAN || z > SPAN) return -1;
    return this.field.sample(x, y, z);
  }

  solidAt(p: THREE.Vector3): boolean {
    return this.densityAt(p.x, p.y, p.z) > 0;
  }

  /**
   * The outward normal of the soil at a point, from the field's gradient.
   *
   * Central differences at one cell, which on a rounded cube edge gives the
   * blend between two faces rather than a jump — the reason she rounds a
   * corner instead of snapping to the next face.
   */
  /** The same cast `hold()` uses, exposed so probes ask the same question. */
  castForTest(from: THREE.Vector3, dir: THREE.Vector3, reach: number): THREE.Vector3 | null {
    return this.cast(from, dir, reach);
  }

  normalAt(p: THREE.Vector3, into: THREE.Vector3): THREE.Vector3 {
    const h = CELL;
    into.set(
      this.densityAt(p.x - h, p.y, p.z) - this.densityAt(p.x + h, p.y, p.z),
      this.densityAt(p.x, p.y - h, p.z) - this.densityAt(p.x, p.y + h, p.z),
      this.densityAt(p.x, p.y, p.z - h) - this.densityAt(p.x, p.y, p.z + h),
    );
    if (into.lengthSq() < 1e-12) into.copy(WORLD_UP);
    return into.normalize();
  }

  /** March for the first solid point, and bisect once it is found. */
  private cast(
    from: THREE.Vector3, dir: THREE.Vector3, reach: number,
  ): THREE.Vector3 | null {
    const step = CELL * 0.5;
    const probe = new THREE.Vector3();
    let previous = 0;
    for (let d = 0; d <= reach; d += step) {
      probe.copy(from).addScaledVector(dir, d);
      if (this.solidAt(probe)) {
        let lo = previous;
        let hi = d;
        for (let i = 0; i < 6; i += 1) {
          const mid = (lo + hi) * 0.5;
          probe.copy(from).addScaledVector(dir, mid);
          if (this.solidAt(probe)) hi = mid;
          else lo = mid;
        }
        return probe.copy(from).addScaledVector(dir, hi);
      }
      previous = d;
    }
    return null;
  }

  /* --------------------------------------------------------- the meshing */

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private remeshAll(): void {
    const n = Math.ceil(CELLS / CHUNK);
    for (let cz = 0; cz < n; cz += 1) {
      for (let cy = 0; cy < n; cy += 1) {
        for (let cx = 0; cx < n; cx += 1) this.remeshChunk(cx, cy, cz);
      }
    }
  }

  private remeshChunk(cx: number, cy: number, cz: number): void {
    const key = this.chunkKey(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      this.chunks.delete(key);
    }
    const data = buildSurfaceNets(this.field, 0, {
      x0: cx * CHUNK, y0: cy * CHUNK, z0: cz * CHUNK,
      x1: Math.min(CELLS, (cx + 1) * CHUNK),
      y1: Math.min(CELLS, (cy + 1) * CHUNK),
      z1: Math.min(CELLS, (cz + 1) * CHUNK),
    });
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunks.set(key, mesh);
  }

  /* ---------------------------------------------------------- the digging */

  /**
   * A bite, taken AT THE MANDIBLE, sized and placed by her own bones.
   *
   * Both numbers come off the rig rather than out of a table, which is what
   * makes them vary per ant instead of by a scale factor:
   *
   *   WIDTH   twice the span from her antenna socket to her jaw. The radius
   *           is therefore that span itself.
   *   WHERE   the point a straight line DOWN from that jaw meets the soil,
   *           down being hers and not the world's.
   *
   * There is no crosshair and no aim ray. The player steers the dig by
   * steering her HEAD — which follows the look in DIG mode — and the hole
   * appears under her face. Nothing in the placement grows as an angle
   * flattens, which is what put a hole six millimetres downrange before.
   */
  private bite(): void {
    this.lastBiteWhy = 'ran';
    if (!this.ready) { this.lastBiteWhy = 'model not ready'; return; }
    const jaw = new THREE.Vector3();
    if (!this.queen.jawPosition(jaw)) { this.lastBiteWhy = 'no jaw bone'; return; }
    /*
     * THE BITE IS SIZED BY HER OWN BONES.
     *
     * "Measure from antennas to bottom of jaw bone and double that for the
     * digging distance" — so the width is a multiple of the antenna-socket-to-
     * jaw span. Measured rather than tabled, which means the worker and the
     * major get their own without anyone typing a number: see
     * `QueenModel.antennaToJaw` and `BITE_WIDTH_SPANS`.
     *
     * It reproduces the hand-picked figure almost exactly, which is the
     * reason to trust it. `CASTE_BITE_MM.queen` was 1.75 mm; twice her
     * measured span is 1.736 mm, inside one percent, off the rig.
     */
    const radius = this.queen.antennaToJaw() * BITE_WIDTH_SPANS / 2;
    if (radius <= 0) { this.lastBiteWhy = 'rig has no antenna-to-jaw span'; return; }

    /*
     * WHY THERE IS NO RAY HERE ANY MORE.
     *
     * The brush used to be dropped on the first solid point along a ray cast
     * up to 9 mm from the jaw. On a flat face with the camera near level that
     * ray is almost a tangent, so it ran a long way before the ground rose
     * into it: the hole landed at `jawHeight / tan(aim)` downrange, which is
     * 6.36 mm at ten degrees off level and unbounded as the aim flattens. At
     * exactly level it found nothing within 9 mm and refused to dig.
     *
     * Her head reaches the soil on its own — the gait's dig dip takes her jaw
     * from 1.121 mm over it to 0.070 mm — so there was never anything to
     * search for.
     */
    /*
     * And it lands where a straight line DOWN from the jaw meets the soil —
     * "make it a straight line from that bone straight down and at that
     * projected point will be that dig radius".
     *
     * Down in HER frame, not the world's, so it works on a wall and on the
     * ceiling. Note there is no aim ray here at all: the player steers the
     * dig by steering her HEAD, which in DIG mode follows the look, and the
     * hole appears under her face. That is why it can never end up six
     * millimetres downrange again — the placement has no term that grows as
     * an angle flattens.
     *
     * The cast starts above the jaw and reaches past it, so it finds the
     * surface whether her face is just over the soil or already inside a
     * tunnel she has dug. With nothing found she bites at the jaw itself,
     * which is the deep-in-a-tunnel case.
     */
    const from = jaw.clone().addScaledVector(this.up, radius * 2);
    const hit = this.cast(from, this.up.clone().negate(), radius * 6);
    const at = hit ?? jaw.clone();
    // Recorded so a probe can measure where the bite ACTUALLY went rather
    // than recompute a formula and agree with itself.
    this.lastBiteAt.copy(at);
    this.lastBiteRadius = radius;
    const result = this.field.subtractSphere(at, radius);
    if (result.changedSamples === 0) { this.lastBiteWhy = 'brush changed nothing'; return; }
    this.lastBiteWhy = '';
    this.removed += result.removedVolume;
    /*
     * The soil she just took out, thrown clear as a lump.
     *
     * Sized off `removedVolume`, not off the brush radius — which is the whole
     * point of the Godot version this is ported from, whose own HUD line reads
     * "Scoop removed %.2f voxel^3; the clod uses that same volume". A bite that
     * clips the edge of a tunnel she has already dug removes almost nothing and
     * should produce almost nothing.
     */
    this.throwClod(at, result.removedVolume);

    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CHUNK));
    const hi = (v: number, max: number) => Math.min(
      Math.ceil(max / CHUNK) - 1, Math.floor((v + 1) / CHUNK),
    );
    for (let cz = lo(result.bounds.minZ); cz <= hi(result.bounds.maxZ, CELLS); cz += 1) {
      for (let cy = lo(result.bounds.minY); cy <= hi(result.bounds.maxY, CELLS); cy += 1) {
        for (let cx = lo(result.bounds.minX); cx <= hi(result.bounds.maxX, CELLS); cx += 1) {
          this.remeshChunk(cx, cy, cz);
        }
      }
    }
  }

  /* --------------------------------------------------------- the walking */

  /**
   * One step, in HER frame.
   *
   * Her up is the face she is on and her forward is a tangent of it, so the
   * same code walks the top, a side and the underside — there is no special
   * case for "upside down", because nothing here refers to the world's
   * vertical except gravity, and gravity only applies once she has let go.
   */
  /**
   * Read the leg homes off the rig itself, in her body frame.
   *
   * Not a table of guessed offsets: the model is posed at rest, each leg's
   * tip bone is asked where it is, and the answer is converted into her own
   * frame. Whatever the rig says her stance is, that is what the legs return
   * to — and it stays true if the model is ever re-exported.
   */
  private buildLegs(): void {
    const setup: LegSetup[] = this.queen.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    /*
     * Rest exactly where her own feet say, and NOT a clearance higher. The
     * body's minimum clearance is a safety for when the ground rises into
     * her (see `RIDE_CLEARANCE_MM`); adding it here instead raised her a
     * quarter of a millimetre off the soil before the IK had even had its
     * turn, which with the IK's own 0.5 mm was most of the gap reported
     * under her feet.
     */
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.ride = -meanFootY;
    // Re-seat her at the height her own legs imply before they take over.
    this.at.addScaledVector(this.up, this.ride - RIDE);
    this.drive = new LegDrive(setup);
    this.drive.plantAll(
      { at: this.at, up: this.up, forward: this.forward }, this.groundForLegs,
    );
  }

  /**
   * What the legs are allowed to ask the world. Nearest solid to a point,
   * searched along her own down and then her own up — null is a real answer
   * and means "nothing to stand on here".
   */
  private readonly groundForLegs = {
    nearest: (at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number) => {
      const from = at.clone().addScaledVector(up, rise);
      return this.cast(from, up.clone().negate(), rise + down);
    },
  };

  /**
   * What kind of space is she in? The one question the railway is built on.
   *
   * Re-marched every few frames rather than every frame because fourteen rays
   * is a few hundred field lookups and the answer moves over tenths of a
   * second. It replaces `buriedDepth`, which asked the same thing along HER
   * OWN UP and so swung with her orientation instead of her position — it
   * reported her surfacing from nine millimetres deep while her real height
   * fell 0.8 mm.
   */
  private senseTheRoom(): void {
    this.roomTick -= 1;
    if (this.roomTick > 0) return;
    this.roomTick = ROOM_EVERY;
    this.room = senseRoom(
      (x, y, z) => this.solidAt(PROBE.set(x / MM, y / MM, z / MM)),
      this.at.x * MM, this.at.y * MM, this.at.z * MM,
      { reachMm: ROOM_REACH_MM, stepMm: ROOM_STEP_MM },
    );
  }

  /** The last room reading, for probes and the readout. */
  roomForTest(): RoomSense { return this.room; }

  /** The designer, once it exists. For probes. */
  designerForTest(): NestDesigner | null { return this.designer; }

  /** The clods in the air right now. For probes. */
  clodsForTest(): readonly Clod[] { return this.clods; }

  /**
   * Throw the soil a bite removed clear of the face it came out of.
   *
   * `normalAt` already points OUT of the soil — it takes the negative gradient,
   * and density falls as you leave the soil. Negating it again on the way in
   * here threw every clod straight down into the block, which read as bites
   * producing no clod at all rather than as a clod going the wrong way.
   *
   * Taken at the bite point rather than at her mouth: on a wall those two
   * disagree by ninety degrees, and the lump has to leave the wall, not her
   * face.
   */
  private throwClod(at: THREE.Vector3, volume: number): void {
    if (volume <= 0) return;
    // A cap is not a nicety — holding DIG down is several bites a second, and
    // each one is a mesh. Oldest goes first.
    if (this.clods.length >= MAX_CLODS) this.dropClod(0);

    const normal = this.normalAt(at, new THREE.Vector3());
    const clod = makeClod(at, normal, volume);
    this.clods.push(clod);

    const mesh = new THREE.Mesh(this.clodGeometry, this.clodMaterial);
    // Godot's own squash: Vector3(1.0, 0.76, 0.9), so a clod is a lump and not
    // a marble.
    mesh.scale.set(clod.radius, clod.radius * 0.76, clod.radius * 0.9);
    /*
     * And its random resting rotation — taken off the clod's own seed rather
     * than re-rolled, so the lump keeps one attitude for its whole life instead
     * of shimmering.
     */
    mesh.rotation.set(
      ((clod.seed & 0xff) / 255) * Math.PI * 2,
      (((clod.seed >> 8) & 0xff) / 255) * Math.PI * 2,
      (((clod.seed >> 16) & 0xff) / 255) * Math.PI * 2,
    );
    mesh.position.set(clod.at.x, clod.at.y, clod.at.z);
    this.scene.add(mesh);
    this.clodMeshes.push(mesh);
  }

  private dropClod(index: number): void {
    const mesh = this.clodMeshes[index];
    if (mesh) this.scene.remove(mesh);
    this.clods.splice(index, 1);
    this.clodMeshes.splice(index, 1);
  }

  /** Fall, land and expire: the clods' whole life, once a frame. */
  private stepTheClods(dt: number): void {
    if (!this.clods.length) return;
    const before = this.clods.length;
    const kept = stepClods(this.clods, dt, (x, y, z) => this.solidAt(PROBE.set(x, y, z)));
    if (kept.length !== before) {
      /*
       * `stepClods` drops by age and clods are pushed in order, so the ones it
       * removed are always the oldest — a PREFIX of the list. Pairing the
       * meshes back up by index only works because of that; if it ever filtered
       * on something other than age this would quietly mismatch every lump with
       * somebody else's mesh.
       */
      const gone = before - kept.length;
      for (let i = 0; i < gone; i += 1) {
        const mesh = this.clodMeshes[i];
        if (mesh) this.scene.remove(mesh);
      }
      this.clodMeshes.splice(0, gone);
      this.clods = kept;
    }
    for (let i = 0; i < this.clods.length; i += 1) {
      const clod = this.clods[i]!;
      this.clodMeshes[i]?.position.set(clod.at.x, clod.at.y, clod.at.z);
    }
  }

  /** The plan this block was carved from, so a probe never needs a copy of it. */
  nestForTest(): NestPlan | null { return this.nest; }

  /**
   * Cut the block from `this.nest`, and redraw the plan over it.
   *
   * All of it in the plan's MILLIMETRES, converted once at the end. The first
   * version built the soil in world units and the nest in millimetres and
   * converted each separately, which needed a scale and its inverse in the same
   * expression — correct as written and the sort of thing that stops being
   * correct the moment anyone touches it. The block's own faces are exactly
   * 0 and BLOCK_MM in that frame, so nothing is lost by moving.
   */
  private carveNest(): void {
    if (!this.nest) return;
    const faults = validatePlan(this.nest);
    if (faults.length) {
      // Loud, but not fatal. A plan with a fault in it still carves — it
      // carves something visibly wrong, which is friendlier to look at than
      // an empty screen and easier to diagnose than a thrown error.
      console.warn('[nest] plan faults', faults);
    }
    /*
     * The ground is where the plan's entrances are, and the block is filled to
     * THERE rather than to its own top face. Everything above it belongs to the
     * anthill, which needs the room: the grid keeps only three cells of margin
     * over the block, so a heap piled at the very top is mostly outside the
     * field and renders as the inside of a bowl.
     */
    const ground = groundOf(this.nest) ?? BLOCK_MM;
    const spare = BLOCK_MM + MARGIN_CELLS * CELL_MM - (ground + tallestMoundMm(this.nest));
    if (spare < 0) {
      console.warn(`[nest] the anthill stands ${(-spare).toFixed(1)} mm above the field and `
        + 'will be cut off — lower the ground or shrink the entrance');
    }
    const soil = box([0, 0, 0], [BLOCK_MM, ground, BLOCK_MM]);
    this.field.fill(inWorldUnits(
      carvePlan(soil, this.nest, { stepMm: 0.5 }), [LOW, LOW, LOW], MM,
    ));

    this.nestView?.dispose();
    if (this.nestView) this.scene.remove(this.nestView.root);
    this.nestView = buildNestView(this.nest);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.position.set(LOW, LOW, LOW);
    this.nestView.root.visible = this.sonar;
    this.scene.add(this.nestView.root);
  }

  /**
   * The lens settings, and remembering them.
   *
   * A field of view is a comfort setting, not a game state — someone who finds
   * ninety degrees swimmy finds it swimmy every time they open the page, and
   * making them say so again on every visit is the kind of thing that reads as
   * the setting not working. Kept per-lens under one key.
   */
  private loadFov(): void {
    try {
      const raw = localStorage.getItem(FOV_STORE);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<{ first: number; third: number }>;
      if (typeof saved.first === 'number') this.fov.first = clampFov(saved.first);
      if (typeof saved.third === 'number') this.fov.third = clampFov(saved.third);
    } catch {
      // A corrupt or unavailable store is not worth a broken scene — private
      // browsing throws on the read alone. The defaults are perfectly good.
    }
  }

  private saveFov(): void {
    try {
      localStorage.setItem(FOV_STORE, JSON.stringify(this.fov));
    } catch { /* see loadFov */ }
  }

  /** Set one lens, in degrees. Clamped, applied and remembered. */
  setFov(which: 'first' | 'third', degrees: number): void {
    this.fov[which] = clampFov(degrees);
    this.saveFov();
    this.refreshView();
  }

  /** The lenses in use, for probes and the readout. */
  fovForTest(): { first: number; third: number } { return { ...this.fov }; }

  /**
   * Put the designer up, building it the first time it is asked for.
   *
   * Built lazily because most blocks never have one — and it holds a camera
   * rig, a raycaster and a panel of its own, none of which should exist on a
   * measuring rig that will never open it.
   */
  private openDesigner(): void {
    if (!this.nest) return;
    this.designer ??= new NestDesigner(
      this.scene, this.camera, this.renderer.domElement, this.hud,
      { mmPerUnit: MM, origin: new THREE.Vector3(LOW, LOW, LOW), blockMm: BLOCK_MM },
      {
        build: (plan) => {
          this.nest = plan;
          this.carveNest();
          this.remeshAll();
        },
        close: () => this.closeDesigner(),
      },
      this.nest,
    );
    // Everything stops: the joystick is released, the jaws are off, and the
    // camera is the designer's until DONE. A latched dig left running would
    // still be running when the block came back a different shape.
    this.input.walk = 0;
    this.input.yaw = 0;
    this.input.dig = false;
    this.digLatch = false;
    this.actionButton.classList.remove('is-latched');
    this.stickPointer = null;
    this.stick.classList.remove('is-live');
    // The sonar overlay is the designer's own drawing while it is up, so the
    // scene's copy would double every tunnel.
    if (this.nestView) this.nestView.root.visible = false;
    this.hud.classList.add('is-designing');
    this.designer.show(this.nest);
  }

  private closeDesigner(): void {
    if (!this.designer) return;
    /*
     * DONE with unbuilt changes carves them. The alternative is throwing away
     * work somebody just did because they pressed the wrong one of two buttons,
     * and a designer that can lose your nest is worse than one that occasionally
     * digs when you only meant to look.
     */
    if (this.designer.hasUnbuilt) {
      this.nest = this.designer.current();
      this.carveNest();
      this.remeshAll();
    }
    this.designer.hide();
    this.hud.classList.remove('is-designing');
    if (this.nestView) this.nestView.root.visible = this.sonar;
    // Set her back down on the ground the new plan defines — the old footing
    // may be soil that no longer exists, or air where the ground used to be.
    this.standHerOnTheGround();
  }

  /**
   * Put her on the surface beside the first entrance, upright and still.
   *
   * After a re-carve her old footing may be a tunnel that was filled in or a
   * hill that was flattened, and `hold()` re-seats her on the NEAREST surface —
   * which from inside fresh soil is whichever wall is closest, not the ground.
   */
  private standHerOnTheGround(): void {
    const mouth = this.nest?.nodes.find(n => n.kind === 'entrance');
    if (!mouth) return;
    const clear = mouth.radiusMm * MOUND_SPREAD + 6;
    this.at.set(
      LOW + mouth.x / MM, LOW + mouth.y / MM + RIDE,
      LOW + Math.max(mouth.z - clear, 2) / MM,
    );
    this.up.set(0, 1, 0);
    this.forward.set(0, 0, 1);
    this.follow.target.copy(this.at);
  }

  /** Show or hide the designed nest drawn through the soil. */
  setSonar(on: boolean): void {
    this.sonar = on;
    if (this.nestView) this.nestView.root.visible = on;
    this.nestButton.textContent = on ? 'SONAR' : 'sonar';
  }

  /** Is there soil here? In the plan's millimetres, for probes. */
  solidAtMm(x: number, y: number, z: number): boolean {
    return this.solidAt(PROBE.set(LOW + x / MM, LOW + y / MM, LOW + z / MM));
  }

  /**
   * Walk the designed nest and ask the SOIL whether it agrees with the plan.
   *
   * The pure carve is already tested as arithmetic. What this checks is the
   * thing arithmetic cannot: that after the field is sampled onto half-
   * millimetre cells and meshed, the tunnel the plan describes is still there
   * and still the width it claims. A bore narrower than a cell, a bend the
   * sampling skips over, a chamber that lands between cells — none of those
   * show up until the field is real, and all of them end with her walking into
   * a wall the plan says is a corridor.
   *
   * It reads the same `sampleEdge` the carver read, deliberately. Measuring the
   * dig with a second description of where the tunnel is would be the exact bug
   * this whole module exists to make impossible.
   */
  auditNest(): {
    samples: number; blocked: number; pinched: number;
    worstAtMm: { x: number; y: number; z: number } | null;
  } | null {
    if (!this.nest) return null;
    const world = (x: number, y: number, z: number): THREE.Vector3 =>
      PROBE.set(LOW + x / MM, LOW + y / MM, LOW + z / MM);
    let samples = 0;
    let blocked = 0;
    let pinched = 0;
    let worstAtMm: { x: number; y: number; z: number } | null = null;
    for (const edge of this.nest.edges) {
      for (const s of sampleEdge(this.nest, edge, 0.5)) {
        samples += 1;
        if (this.solidAt(world(s.at.x, s.at.y, s.at.z))) {
          blocked += 1;
          if (!worstAtMm) worstAtMm = { ...s.at };
          continue;
        }
        /*
         * Open on the centreline is not enough — a hairline crack is open on
         * the centreline. Ask at 70% of the claimed bore in the two directions
         * across the tunnel, which is where a corridor that has been sampled
         * down to a slit gives itself away.
         */
        const a = sideways(s.along);
        const b = new THREE.Vector3().crossVectors(
          new THREE.Vector3(s.along.x, s.along.y, s.along.z), a,
        ).normalize();
        const r = s.radiusMm * 0.7;
        const tight = [a, b].some(d => (
          this.solidAt(world(s.at.x + d.x * r, s.at.y + d.y * r, s.at.z + d.z * r))
          || this.solidAt(world(s.at.x - d.x * r, s.at.y - d.y * r, s.at.z - d.z * r))
        ));
        if (tight) {
          pinched += 1;
          if (!worstAtMm) worstAtMm = { ...s.at };
        }
      }
    }
    return { samples, blocked, pinched, worstAtMm };
  }

  /**
   * Force a room reading, so the RULE can be tested without having to carve a
   * chamber first. Carving one takes a player minutes and a probe more
   * excavation than a sixty-four millimetre block contains; the rule is a pure
   * function of these three numbers and deserves testing on its own.
   */
  setRoomForTest(room: RoomSense): void {
    this.room = room;
    this.roomTick = ROOM_EVERY;
  }

  /**
   * Where she is, decided ONCE a frame and then only read.
   *
   * These were getters that did the work — and both of them latched, so every
   * read moved the state on. The HUD reads them every frame and so did the
   * probes, which meant looking at the readout changed the physics: she rode
   * the rails for six frames instead of hundreds because something else had
   * asked what she was doing. A question should not be an action.
   */
  private undergroundLatch = false;

  /** How long the ceiling reading has disagreed with the latch, in seconds. */
  private roofedFor = 0;
  private chamberLatch = false;

  get underground(): boolean { return this.undergroundLatch; }

  get inChamber(): boolean { return this.chamberLatch; }

  /** Work out both, from the room reading and a cast for a ceiling. */
  private judgeWhereSheIs(dt = 1 / 60): void {
    const reach = this.undergroundLatch ? CEILING_LEAVE_MM : CEILING_ENTER_MM;
    const roofed = this.cast(
      this.at.clone().addScaledVector(this.up, CELL),
      this.up.clone(), reach / MM,
    ) !== null;
    /*
     * A ROOF HAS TO LAST to count.
     *
     * The cast goes along HER OWN up, and her up lags the ground she is on —
     * so walking up the flank of an anthill, an up still leaning back toward
     * the hill finds thirteen millimetres of soil above her and reports her
     * underground while she is stood in the open on a slope. Measured on the
     * anthill: she flickered under at frame 53 and back out at 63, ten frames,
     * and each crossing is a hard camera cut.
     *
     * Same shape of answer as the camera's own no-room test, and for the same
     * reason: the reading is not noisy, it is briefly and confidently WRONG. A
     * band would only move where it happens. Three frames of ceiling is a hill;
     * a quarter of a second of it is a roof.
     */
    this.roofedFor = roofed === this.undergroundLatch ? 0 : this.roofedFor + dt;
    if (roofed !== this.undergroundLatch && this.roofedFor >= ROOF_DWELL) {
      this.undergroundLatch = roofed;
      this.roofedFor = 0;
    }
    if (!this.undergroundLatch) {
      this.chamberLatch = false;
      return;
    }
    this.chamberLatch = this.chamberLatch
      ? this.room.boreMm >= CHAMBER_LEAVE_MM
      : this.room.boreMm >= CHAMBER_ENTER_MM;
  }

  /** What the HUD and the probes call the current state. */
  get travelState(): 'surface' | 'chamber' | 'digging' | 'rails' | 'tunnel' {
    if (!this.underground) return 'surface';
    if (this.inChamber) return 'chamber';
    if (this.input.dig) return 'digging';
    return this.onRails ? 'rails' : 'tunnel';
  }

  /**
   * Lay track while she digs, and ride it when she is not.
   *
   * Returns whether the rail moved her this frame, in which case the ordinary
   * drive is skipped entirely — that is the whole point. Underground her
   * position and attitude come off a recorded curve instead of off soil she is
   * in the middle of destroying, and a recorded curve has nothing to jitter.
   *
   * Digging RELEASES her, deliberately. Laying track and riding it are
   * different jobs and holding DIG is how you say which one you are doing; it
   * is also the way off the rails when you want one.
   */
  private rideRail(dt: number): boolean {
    if (!this.underground) {
      // Surface behaviour is untouched, and the track is left where it is so
      // that coming back down the same hole puts her back on it.
      this.onRails = false;
      return false;
    }
    if (this.input.dig) {
      /*
       * Digging is where the track comes FROM. The first sleeper is laid at
       * the point she breaks in, which is the "spline created at the dig
       * starting point" — everything after it is just her own path recorded.
       */
      if (!this.rail) this.rail = new TunnelRail();
      this.rail.record(
        { x: this.at.x * MM, y: this.at.y * MM, z: this.at.z * MM },
        this.up, this.forward, RAIL_SPACING_MM,
      );
      this.onRails = false;
      return false;
    }
    if (this.inChamber || !this.rail || this.plan) {
      this.onRails = false;
      return false;
    }
    const here = { x: this.at.x * MM, y: this.at.y * MM, z: this.at.z * MM };
    const near = this.rail.nearest(here);
    if (!near || near.distMm > RAIL_CAPTURE_MM) {
      this.onRails = false;
      return false;
    }
    // Board where she is standing, not at the end of the line.
    if (!this.onRails) this.railS = near.s;
    this.onRails = true;

    const before = this.at.clone();
    this.railS = THREE.MathUtils.clamp(
      this.railS + this.driveWalk * WALK_SPEED * MM * dt, 0, this.rail.lengthMm,
    );
    const frame = this.rail.sample(this.railS, this.railSmoothMm);
    if (!frame) {
      this.onRails = false;
      return false;
    }
    this.at.set(frame.x / MM, frame.y / MM, frame.z / MM);
    this.up.set(frame.ux, frame.uy, frame.uz).normalize();
    this.forward.set(frame.fx, frame.fy, frame.fz).normalize();
    /*
     * Her speed is still MEASURED, never assumed, because the gait reads it to
     * decide whether she is walking. A rail that told the legs how fast they
     * were going would put the two out of step the moment the track ran out.
     */
    const moved = this.at.clone().sub(before);
    this.velocity.copy(moved).divideScalar(Math.max(dt, 1e-6));
    this.walkSpeed = moved.length() / Math.max(dt, 1e-6);
    this.gripping = true;
    this.fallSpeed = 0;
    return true;
  }

  /**
   * Fly the plan: turn a piece into the same commands a thumb would give.
   *
   * Deliberately written INTO `input`, upstream of the easing and of the legs,
   * rather than moving her directly. The whole point of a plan is that it is
   * the same ant doing the same walking — she has to dig the tunnel with her
   * legs and her jaws, at whatever pace the soil allows, or the tunnel is a
   * cutscene. It also means grabbing the stick blends against the autopilot
   * instead of fighting a teleport.
   *
   * Distance is measured across her own up, so a piece is spent by TRAVEL and
   * never by being re-seated up and down half a millimetre at a time. That is
   * the same distinction the gait makes to decide whether she is walking, and
   * it was worth a phantom 6.5 mm/s the last time it was got wrong.
   */
  private flyPlan(dt: number): boolean {
    const plan = this.plan;
    const track = this.planRail;
    if (!plan || !track) return false;
    /*
     * The runner is charged with the TRACK's own advance, not with her
     * measured displacement, and those being two different numbers deadlocked
     * it. Arc length is clamped at the end of the rail, so she stops moving
     * there; the runner's separately integrated total falls a hair short of
     * the piece length on float alone, and with no movement left it can never
     * make it up. A turn piece sat at progress 0.967 for ninety seconds.
     *
     * One number for how far along she is. `planS` is it, because `planS` is
     * what actually moves her.
     */
    const advance = this.planS - this.lastPlanS;
    this.lastPlanS = this.planS;
    const step = plan.step(dt, advance);
    if (step.finished && plan.finished) {
      this.stopPlan();
      return false;
    }
    /*
     * SHE RIDES THE PLAN, she is not steered along it.
     *
     * Steering was the first design and it was measurably wrong. It set the
     * gyro to the piece's grade and pushed the stick, and left her actual PATH
     * to `hold()` — which re-seats her on the surface every frame whatever
     * angle she is holding. Measured, a piece asking for thirty degrees down
     * held her nose at -30.4 and sank her 0.01 mm over ten millimetres. The
     * attitude was perfect and she went nowhere; she scraped along the top
     * with her face in the dirt and left a crater, which is exactly what it
     * looked like on screen.
     *
     * The geometry is now worked out before a bite is taken and she follows
     * it, the same way she rides a tunnel she has already dug. Ten millimetres
     * at thirty degrees down goes down five, because that is what the
     * arithmetic says.
     */
    const before = this.at.clone();
    this.planS = Math.min(track.lengthMm, this.planS + step.walk * PLAN_SPEED_MM_S * dt);
    const frame = track.sample(this.planS);
    if (!frame) {
      this.stopPlan();
      return false;
    }
    this.at.set(frame.x / MM, frame.y / MM, frame.z / MM);
    this.up.set(frame.ux, frame.uy, frame.uz).normalize();
    this.forward.set(frame.fx, frame.fy, frame.fz).normalize();
    // Measured, never assumed — the gait reads this to decide she is walking.
    const moved = this.at.clone().sub(before);
    this.velocity.copy(moved).divideScalar(Math.max(dt, 1e-6));
    this.walkSpeed = moved.length() / Math.max(dt, 1e-6);
    this.gripping = true;
    this.fallSpeed = 0;
    this.driveWalk = step.walk;
    this.driveYaw = 0;
    this.turnRate = 0;
    this.input.walk = step.walk;
    this.input.yaw = 0;
    // The soil still has to be removed. The path is decided; the digging is not.
    this.input.dig = MODES[this.mode]?.action?.id === 'dig';
    return true;
  }

  /** Begin the queued plan, from wherever she is now. */
  startPlan(): void {
    if (this.planPieces.length === 0) return;
    const pieces = this.planPieces.map(clampPiece);
    this.plan = new DigPlanRunner(pieces);
    // The track is laid from where she stands and how she is facing, so RUN
    // means "go from here" rather than "go from the origin".
    this.planRail = railFromPlan(pieces, {
      at: { x: this.at.x * MM, y: this.at.y * MM, z: this.at.z * MM },
      forward: this.forward,
    });
    this.planS = 0;
    this.lastPlanS = 0;
    this.setTrim(false);
    this.updatePlanHud();
  }

  /** Hand her back. Releasing the plan releases the gyro with it. */
  stopPlan(): void {
    this.plan = null;
    this.planRail = null;
    this.input.walk = 0;
    this.input.yaw = 0;
    this.input.dig = false;
    this.trim.roll = 0;
    this.setTrim(false);
    this.updatePlanHud();
  }

  private step(dt: number): void {
    /*
     * A running plan OWNS the frame, and this is the bug the last version had.
     *
     * It used to set her position and attitude and then fall through to the
     * rest of `step` — which runs the leg drive and then `hold()`, and `hold()`
     * puts her straight back on the surface. So the plan was overwritten every
     * frame by the very thing it was meant to override, and ten millimetres at
     * thirty degrees down sank her 0.43 mm instead of five.
     *
     */
    if (this.flyPlan(dt)) return;
    /*
     * The stick is EASED before anything reads it.
     *
     * A thumb rolling from twelve o'clock round to nine is a smooth path, but
     * the two axes it lands on are read straight, and the leg system turns
     * them into a per-leg travel direction — `v + ω × r`. Swap walk for yaw in
     * one frame and every one of those six directions swings, so the step
     * targets jump and she snaps from striding to spinning. Easing the
     * COMMAND, not the result, fixes it at the source and leaves the feet's
     * own geometry alone: the twist she is asked for turns over about a tenth
     * of a second, which is quick enough to feel direct and long enough that
     * a full lap of the stick reads as one curve.
     */
    this.senseTheRoom();
    this.judgeWhereSheIs(dt);
    const ease = 1 - Math.exp(-STICK_EASE * dt);
    this.driveWalk += (this.input.walk - this.driveWalk) * ease;
    this.driveYaw += (this.input.yaw - this.driveYaw) * ease;
    /*
     * The sign is REPORTED, not reasoned: pushing the stick right turned her
     * left. The lab's own steering carries the same comment for the same
     * reason — forward is (sin h, 0, cos h), so a rising heading swings her
     * nose from +Z toward +X, and with the camera behind her that is the
     * LEFT of the screen. The arithmetic is consistent and is the mirror of
     * what a thumb means.
     */
    /*
     * ON THE TRACK, the stick is a throttle and nothing else.
     *
     * Steering is not merely ignored, it is zeroed before the gait reads it —
     * the legs turn her by walking, so leaving a twist in the command would
     * have her fighting the rail every frame rather than riding it.
     */
    if (this.rideRail(dt)) {
      this.driveYaw = 0;
      this.turnRate = 0;
      this.forward.addScaledVector(this.up, -this.forward.dot(this.up));
      if (this.forward.lengthSq() < 1e-8) this.forward.set(this.up.z, this.up.x, this.up.y);
      this.forward.normalize();
      return;
    }
    this.turnRate = this.driveYaw * YAW_RATE;
    if (!this.drive) {
      const yaw = this.driveYaw * YAW_RATE * dt;
      if (Math.abs(yaw) > 1e-9) this.forward.applyAxisAngle(this.up, yaw).normalize();
    }

    if (this.drive) {
      /*
       * THE LEGS MOVE HER. The stick proposes, the planted feet constrain,
       * and what survives is her displacement — see `legDrive`.
       */
      const before = this.at.clone();
      this.report = this.drive.step(
        dt,
        { at: this.at, up: this.up, forward: this.forward },
        {
          walk: this.driveWalk,
          yaw: this.driveYaw,
          speed: WALK_SPEED,
          yawRate: YAW_RATE,
          // hold() owns how high she rides in this room. See `DriveInput`.
          settle: false,
        },
        this.groundForLegs,
      );
      /*
       * Speed is what she TRAVELS, measured across her own up — never how far
       * she was re-seated along it. The gait takes this number and decides
       * from it whether she is walking, and a body being nudged up and down
       * by half a millimetre a frame is not walking. Reading the raw
       * displacement had a motionless ant reporting 6.5 mm/s.
       */
      const moved = this.at.clone().sub(before);
      this.velocity.copy(moved).divideScalar(Math.max(dt, 1e-6));
      moved.addScaledVector(this.up, -moved.dot(this.up));
      this.walkSpeed = moved.length() / Math.max(dt, 1e-6);
    } else {
      const wanted = this.forward.clone().multiplyScalar(WALK_SPEED * this.driveWalk);
      this.velocity.lerp(wanted, 1 - Math.exp(-10 * dt));
      this.walkSpeed = this.velocity.length();
      this.at.addScaledVector(this.velocity, dt);
    }

    if (this.gripping) this.hold(dt);
    else this.fall(dt);

    // The forward is re-flattened against whatever up she ended on.
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up));
    if (this.forward.lengthSq() < 1e-8) this.forward.set(this.up.z, this.up.x, this.up.y);
    this.forward.normalize();
  }

  /**
   * How far she can be lifted off her own back before the lift itself is
   * INSIDE something. Nought means she is embedded.
   *
   * `cast` reports a hit at zero distance when its origin is already solid,
   * which is correct for a ray and catastrophic here: `hold()` used to start
   * three millimetres above her without asking whether there was three
   * millimetres of room. Her own tunnels are about five millimetres across, so
   * underground that start point sits in the CEILING — the cast then "hit" the
   * ceiling at zero range, seated her a body-height above it, and did it again
   * the next frame. An elevator to the surface, running at up to three
   * millimetres a frame, dressed up as a grip. Reported twice: teleported to
   * the surface while moving in a tunnel, and now jumping out as soon as she
   * gets underground.
   */
  private clearLift(): number {
    const probe = new THREE.Vector3();
    const step = CELL * 0.5;
    for (let lift = GRIP_LIFT; lift > 0; lift -= step) {
      probe.copy(this.at).addScaledVector(this.up, lift);
      if (!this.solidAt(probe)) return lift;
    }
    return 0;
  }

  /**
   * Hold on: cast from off her back, in through her soles.
   *
   * When it lands she is drawn onto the contact and her up eases onto its
   * normal — that is the whole of walking round a corner. When it finds
   * nothing she has walked over an edge, so the wrap search looks BEHIND AND
   * BELOW her, in her own frame, which is where the far side of an edge is.
   * Only when that is empty too has she genuinely walked off into the air.
   */
  private hold(dt: number): void {
    /*
     * While actively digging underground the DensityField surface normal
     * changes with every bite — the gradient flips between the floor, the
     * freshly-carved rim, and the surrounding walls several times per second.
     * Running `aimUp` at full rate in that environment lets the body spin up
     * to 240 °/s, which is the "model all over the place" report. Slowing to
     * one-eighth rate while the mandibles are working reduces visible body
     * rotation to about 30 °/s while still letting her gradually track the
     * tunnel direction she is actually digging toward.
     */
    /*
     * Freeze orientation completely during active digging underground.
     * aimDt = 0 makes the lerp factor 1 - exp(-ALIGN * 0) = 0, so aimUp is a
     * no-op. Without this, hold() feeds noisy DensityField surface normals into
     * aimUp, which tilts the body, which changes the ray direction hold() casts,
     * which finds a different (wall) surface, which tilts the body further —
     * an outside-loop feedback that cannot be tamed by slowing the rate alone.
     * Locking orientation during bites breaks the loop entirely. Above ground
     * or when not actively digging, full dt is used and behaviour is unchanged.
     */
    const aimDt = (this.input.dig && this.underground) ? 0 : dt;

    /*
     * Embedded is its own case, and casting cannot answer it. Her origin being
     * inside soil means every ray out of her starts solid and reports itself
     * at zero range, so the only honest question is which way is OUT — which
     * is what `nearestSurface` marches for.
     */
    if (this.solidAt(this.at)) {
      const out = this.nearestSurface(this.at);
      if (out) {
        const normalOut = new THREE.Vector3();
        this.normalAt(out.point, normalOut);
        this.at.lerp(out.point.clone().addScaledVector(normalOut, this.ride),
          1 - Math.exp(-SNAP * dt));
        this.aimUp(this.trimmedUp(normalOut), aimDt);
        return;
      }
    }
    const lift = this.clearLift();
    const from = this.at.clone().addScaledVector(this.up, lift);
    const dir = this.up.clone().negate();
    let hit = this.cast(from, dir, lift + GRIP_REACH);
    let normal = new THREE.Vector3();

    if (!hit) {
      for (const arc of WRAP_ARCS) {
        const wrapDir = this.up.clone().multiplyScalar(-Math.cos(arc))
          .addScaledVector(this.forward, -Math.sin(arc)).normalize();
        const wrapFrom = this.at.clone().addScaledVector(this.up, GRIP_LIFT * 0.5);
        hit = this.cast(wrapFrom, wrapDir, GRIP_REACH);
        if (hit) break;
      }
    }
    if (!hit) {
      this.gripping = false;
      this.fallSpeed = 0;
      return;
    }
    this.normalAt(hit, normal);
    const seat = hit.clone().addScaledVector(normal, this.ride);
    this.at.lerp(seat, 1 - Math.exp(-SNAP * dt));
    this.aimUp(this.trimmedUp(normal), aimDt);
  }

  /**
   * Turn her body toward an attitude — the ONE path by which her up ever
   * changes, eased and then rate-limited.
   *
   * The easing was always there and was never enough on its own, because it
   * only smooths a goal that MOVES smoothly. Digging does not: she removes the
   * ground from under herself, so the contact her grip finds flips between
   * faces several times a second and the goal arrives as a step. Two of the
   * four places that moved her up did not even ease — they wrote the raw
   * normal straight in.
   *
   * So there is also a ceiling on how fast a body can turn, which is what a
   * body actually has. Nothing about a real ant lets it roll ninety degrees in
   * a sixtieth of a second; the limit is what makes a bad sample cost a few
   * degrees instead of the whole view. It leaves ordinary cornering alone,
   * which peaks well inside it.
   */
  private aimUp(goal: THREE.Vector3, dt: number): void {
    const eased = this.up.clone().lerp(goal, 1 - Math.exp(-ALIGN * dt)).normalize();
    const swing = Math.acos(THREE.MathUtils.clamp(this.up.dot(eased), -1, 1));
    const cap = MAX_TILT_RATE * dt;
    if (swing <= cap || swing < 1e-9) {
      this.up.copy(eased);
      return;
    }
    const axis = new THREE.Vector3().crossVectors(this.up, eased);
    if (axis.lengthSq() < 1e-12) {
      this.up.copy(eased);
      return;
    }
    this.up.applyAxisAngle(axis.normalize(), cap).normalize();
  }

  /**
   * The attitude she should be holding: the surface normal, pitched until her
   * nose sits at the commanded GRADE.
   *
   * The grade is measured against world horizontal, not against the soil under
   * her, and that distinction is the whole design. Trim taken relative to the
   * local surface compounds: nose down forty, seat on the forty-degree floor
   * that produces, take another forty off THAT, and within a second or two she
   * is vertical and then inverted. A gyroscope holds an attitude in the world,
   * which is exactly what stops the runaway — "descend at forty degrees" is a
   * fixed point, not an increment.
   *
   * Only the pitch is taken. Roll — which way up she is, which face of the
   * block she is on — still comes entirely from the normal, so she keeps
   * walking round corners and along the underside while the gyro is holding
   * her grade.
   */
  private trimmedUp(normal: THREE.Vector3): THREE.Vector3 {
    if (!this.trim.on) return normal;
    const right = new THREE.Vector3().crossVectors(normal, this.forward);
    // Nose straight at the normal leaves no axis to pitch about. Rare, and
    // holding the last attitude through it beats spinning on a degenerate one.
    if (right.lengthSq() < 1e-8) return normal;
    right.normalize();
    // The forward that goes with THIS normal, rather than the stale one.
    const nose = new THREE.Vector3().crossVectors(right, normal).normalize();
    const grade = Math.asin(THREE.MathUtils.clamp(nose.y, -1, 1));
    /*
     * Positive about her right is nose DOWN — rotating the frame about +X
     * carries +Z toward -Y. So closing the gap from where her nose is to where
     * it is asked to be is (grade - commanded), not the other way round. This
     * sign was checked against the model, not reasoned: see probe-gyro.
     */
    const pitched = normal.clone().applyAxisAngle(right, grade - this.trim.pitch).normalize();
    /*
     * ROLL last, and about her NOSE, so it is a bank and nothing else.
     *
     * Pitch is absolute because a relative pitch compounds; roll is relative
     * to the surface because that is what banking means — a floor tilted
     * thirty degrees off the ground under her, not thirty degrees off the
     * world. Rolling after pitching keeps the two independent, which is what
     * lets a piece ask for both without one eating the other.
     */
    if (Math.abs(this.trim.roll) < 1e-6) return pitched;
    return pitched.applyAxisAngle(nose, this.trim.roll).normalize();
  }

  /** Is this point within the block's own bounds, rather than outside it? */
  private insideBlock(p: THREE.Vector3): boolean {
    const m = CELL * 2;
    return p.x > LOW + m && p.x < HIGH - m
      && p.y > LOW + m && p.y < HIGH - m
      && p.z > LOW + m && p.z < HIGH - m;
  }

  /**
   * The nearest bit of surface to a point buried in soil, searched outward
   * along her own axes. What an ant in a tunnel takes hold of.
   */
  private nearestSurface(p: THREE.Vector3): { point: THREE.Vector3 } | null {
    const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
    const dirs = [
      this.up.clone().negate(), this.up.clone(),
      right, right.clone().negate(),
      this.forward.clone(), this.forward.clone().negate(),
    ];
    /*
     * Marched OUT of the soil, not cast back into it.
     *
     * This used to start `GRIP_REACH` away and cast inward, which only works
     * when that start point is in open air. Buried deeper than the reach it is
     * in soil too, so `cast` returned its own origin — nine millimetres from
     * her, in the middle of solid ground, reported as a face. Every direction
     * tied at exactly that distance, the first won, and she was seated on a
     * fiction with a zero-gradient normal that falls back to world up. Walking
     * out of the soil to where it STOPS being solid needs no such assumption
     * and is the boundary by definition.
     */
    const step = CELL * 0.5;
    const probe = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    let bestDist = Infinity;
    for (const dir of dirs) {
      for (let d = 0; d <= GRIP_REACH; d += step) {
        probe.copy(p).addScaledVector(dir, d);
        if (this.solidAt(probe)) continue;
        if (d < bestDist) { bestDist = d; best = probe.clone(); }
        break;
      }
    }
    return best ? { point: best } : null;
  }

  /** Off the block: straight down, world frame, until something catches. */
  private fall(dt: number): void {
    this.fallSpeed += GRAVITY * dt;
    this.at.y -= this.fallSpeed * dt;
    const probe = this.at.clone();
    /*
     * INSIDE the block is not the same as landed, and conflating them is the
     * teleport.
     *
     * `solidAt` is true for every point in the soil, so the moment she lost
     * her grip underground this fired and flung her to the top of the block.
     * Reported as being teleported to the surface while moving around in a
     * tunnel. Underground she should simply take hold of whatever is nearest
     * — a tunnel has a floor, walls and a ceiling and all three are grip.
     */
    if (this.solidAt(probe) && this.insideBlock(probe)) {
      const near = this.nearestSurface(probe);
      if (near) {
        /*
         * Through the slew, not straight onto her.
         *
         * Writing the normal into `this.up` was the single-frame ninety-five
         * degree flip: digging removes the ground from under her constantly,
         * so she loses grip and re-grips several times a second, and each
         * re-grip snapped her orientation with no easing at all. Measured at
         * 3.94 degrees of body rotation PER FRAME while digging, against 0.15
         * while walking. That is the camera being all over the place.
         */
        const found = new THREE.Vector3();
        this.normalAt(near.point, found);
        this.aimUp(found, dt);
        this.at.copy(near.point).addScaledVector(this.up, this.ride);
        this.gripping = true;
        this.fallSpeed = 0;
        this.velocity.set(0, 0, 0);
        return;
      }
    }
    if (this.solidAt(probe) || this.at.y < LOW - SPAN) {
      // Landed on the outside, or lost entirely: back onto the top and re-grip.
      const from = new THREE.Vector3(
        THREE.MathUtils.clamp(this.at.x, LOW + CELL * 4, HIGH - CELL * 4),
        HIGH + GRIP_LIFT * 2,
        THREE.MathUtils.clamp(this.at.z, LOW + CELL * 4, HIGH - CELL * 4),
      );
      const hit = this.cast(from, new THREE.Vector3(0, -1, 0), SPAN * 2);
      if (hit) {
        // Same reason as above: this is a rescue, and a rescue that spins the
        // view ninety degrees in a frame is worse than the fall.
        const found = new THREE.Vector3();
        this.normalAt(hit, found);
        this.aimUp(found, dt);
        this.at.copy(hit).addScaledVector(this.up, this.ride);
        this.gripping = true;
        this.fallSpeed = 0;
        this.velocity.set(0, 0, 0);
      }
    }
  }

  /* ------------------------------------------------------------- the loop */

  /**
   * Stop the live loop advancing her, so `stepForTest` is the ONLY thing that
   * does. Rendering carries on, so screenshot probes still work.
   *
   * Without this, "deterministic" was a lie: the animation loop calls
   * `simulate` with wall-clock dt, so every probe was measuring its own steps
   * PLUS however many frames the browser happened to slip in, at whatever dt
   * the machine was managing. It showed up as the same probe on the same build
   * reporting she ended up thirteen millimetres down on one run and on the
   * surface on the next.
   */
  setPausedForTest(on: boolean): void {
    this.paused = on;
  }

  /** Advance the room deterministically. For tests. */
  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  private simulate(dt: number): void {
    /*
     * Inside `simulate`, not beside it. The first version stepped the clods
     * from the render loop so they would keep falling while a probe had the
     * world paused — but `stepForTest` calls `simulate` directly and never
     * touches the render loop, so under every probe the clods simply hung in
     * the air where they were thrown, frozen for three hundred frames.
     */
    this.stepTheClods(dt);
    this.step(dt);

    if (this.ready) {
      this.queen.root.position.copy(this.at);
      /*
       * Her whole body is oriented by the frame she is standing in — up off
       * the face, nose along her forward. On the underside that is upside
       * down in world terms and perfectly ordinary in hers.
       */
      const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
      const basis = new THREE.Matrix4().makeBasis(right, this.up, this.forward);
      this.queen.root.quaternion.setFromRotationMatrix(basis);
      /*
       * HER HEAD FOLLOWS YOUR LOOK. Yaw always, pitch only where the mode
       * asks for it — see `modes.ts`. The pitch is the same `aimPitch` the
       * bite is taken along, so in DIG mode her jaws point at the hole she
       * is about to make rather than wherever the walk cycle left them.
       */
      const mode = MODES[this.mode]!;
      this.queen.update(dt, {
        speed: this.walkSpeed,
        turn: this.turnRate,
        digging: this.input.dig ? 1 : 0,
        carrying: 0,
        headYaw: this.follow.lookYaw,
        /*
         * The PLAYER's look, not the biased view. Onboard, `lookPitch`
         * returns the camera's own pitch — which now carries her resting
         * posture — so reading it here applied that posture twice and drove
         * her face past vertical at a level camera.
         */
        /*
         * WHERE HER FACE POINTS, absolutely — the camera's own pitch, because
         * the bone IS the camera. Aim it 43 degrees down and she is 43
         * degrees down; take it to 75 and so is she.
         *
         * Undefined where the mode does not want her pitching, which leaves
         * her in her bind pose rather than snapping her level. One limit for
         * both cameras: see `HEAD_PITCH_DOWN`.
         */
        headPitch: mode.pitchHead
          ? (this.firstPerson ? this.aimPitch : this.follow.lookPitch)
          : undefined,
      });
      /*
       * Feet onto the soil, in her frame: elevation is measured along HER
       * up, and the surface under a foot is found by casting in through it.
       * The same call the sim uses, handed a frame instead of a height map.
       */
      this.queen.solveFeet(
        (x, z, y) => this.surfaceUnder(x, y, z),
        FOOT_CLEARANCE_MM / 5,
        RIDE * 2,
        this.drive ? (slot) => this.drive!.anchorFor(slot) : undefined,
        {
          up: [this.up.x, this.up.y, this.up.z],
          surface: (x, y, z) => this.surfaceUnder(x, y, z),
        },
      );
    }

    /*
     * The bite comes AFTER she is posed, and that ordering is the fix, not
     * housekeeping.
     *
     * It used to run at the top of this function, which meant it read a jaw
     * from the previous frame — at her previous position, with her head
     * wherever it had been. On the frame the button goes down that is the
     * head still HELD UP by the walking gait, 1.12 mm off the soil, and the
     * old placement then projected that height forward into 6 mm of error.
     * Posing her first means `jawPosition` returns the jaw that is drawn on
     * the screen, dipped into the dig at 0.07 mm.
     */
    this.digCooldown = Math.max(0, this.digCooldown - dt);
    if (this.input.dig && MODES[this.mode]!.action?.id === 'dig' && this.digCooldown === 0) {
      this.bite();
      this.digCooldown = 0.25;
    }

    /*
     * WHERE THE EYE SITS: on her antenna sockets, as they are RIGHT NOW.
     *
     * `FollowCamera.eye` is an offset in her frame, so the live socket is
     * decomposed onto her right, up and forward every frame. It has to be the
     * live bone and not the rig's bind pose: her head is posed continuously —
     * dipped into a dig, turned toward the look — and the bind-pose figure
     * put the eye 2.05 mm behind the sockets, which on a 9 mm ant is inside
     * her thorax. Riding the live bone is also the only way "looking down the
     * mandibles" means anything, since the mandibles move.
     */
    /*
     * WHERE THE EYE SITS: on her antenna sockets as they are right now, given
     * to the rig as a WORLD POINT rather than as an offset in her frame.
     *
     * The frame round-trip is what broke it. Decomposing the live socket onto
     * her right/up/forward and letting the rig rebuild it looks harmless, but
     * the rig rebuilds on axes already turned by the look yaw — so the offset
     * was rotated twice and the eye swung wide of the head it is bolted to.
     * Measured: her jaws sat 10 degrees off the view centre looking straight
     * ahead and 79 degrees off at a sixty degree turn. A world point has no
     * frame to disagree about.
     */
    /*
     * THE EYE, MOUNTED IN HER HEAD'S FRAME — a boom, not a hand.
     *
     * The position is her antenna sockets, and every offset on top of it runs
     * along the HEAD's axes rather than her body's. That distinction is
     * invisible looking straight ahead and is the whole difference at a full
     * turn: a fifth of a millimetre pushed along her BODY forward is a fifth
     * of a millimetre sideways once her head has swung sixty degrees, and at
     * 0.87 mm from the jaw that is a large angle. It showed as the two
     * mandibles splitting evenly about the view centre when straight and
     * unevenly when turned.
     *
     * Handed over as a WORLD POINT. `FollowCamera.eye` is an offset in her
     * frame and the rig rebuilds it on axes already turned by the look yaw,
     * so anything passed that way gets rotated twice.
     */
    this.follow.body.copy(this.at);
    this.follow.onboardEye = null;
    this.follow.onboardLook = null;
    this.follow.onboardLookAt = null;
    const socket = new THREE.Vector3();
    const jaw = new THREE.Vector3();
    if (this.queen.eyePosition(socket) && this.queen.jawPosition(jaw)) {
      // Her head's own axes, from geometry: down the mandibles, and across.
      const headFwd = jaw.clone().sub(socket).normalize();
      const headRight = new THREE.Vector3().crossVectors(this.up, headFwd);
      if (headRight.lengthSq() < 1e-8) headRight.crossVectors(this.forward, headFwd);
      headRight.normalize();
      const headUp = new THREE.Vector3().crossVectors(headFwd, headRight).normalize();
      const eye = socket.clone()
        .addScaledVector(headFwd, EYE_FORWARD_MM / MM + this.eyeNudge.z)
        .addScaledVector(headUp, this.eyeNudge.y)
        .addScaledVector(headRight, this.eyeNudge.x);
      this.follow.onboardEye = eye;
      if (this.firstPerson) {
        /*
         * And the view is centred on the JAWS themselves, as a point.
         *
         * Not a direction: a direction is computed against where the eye was
         * asked to go, and the rig marches the eye out of soil, which at a
         * steep look with her head buried moves it. The jaws slid 106 degrees
         * off the centre of a view aiming exactly where it had been told.
         * A point is aimed from wherever the eye actually ended up.
         */
        this.follow.onboardLookAt = jaw.clone();
        this.follow.onboardLookPitch = this.eyePitch;
      }
    }

    this.follow.target.copy(this.at).addScaledVector(this.up, RIDE);
    this.follow.up.copy(this.up);
    /*
     * Down the mandibles, not down her forward. Her face already points about
     * 36 degrees below her body axis — an ant's mouthparts hang under the
     * head joint — so a first-person eye aimed along her forward looks over
     * the top of the work. `eyePitch` is the tuner's share of that.
     */
    /*
     * Onboard the view sits at her REST posture and moves from there, so a
     * level camera is already looking down the mandibles at the work rather
     * than out over the top of them. Same offset the bone gets, so the two
     * stay the same angle — which is the invariant this whole camera is
     * built on. `eyePitch` is the tuner's share on top.
     */
    // The view IS the aim now — no posture folded in, because the bone is not
    // offset from it either. `eyePitch` is the tuner's share and nothing else.
    /*
     * Tell the rig where she is, so `auto` can do its job.
     *
     * `submerged` has existed on FollowCamera since the mode was written and
     * nothing ever set it — so `auto` has never once fired, and third person
     * only ever dropped to first when there was physically no room for a shot
     * of her. That fallback is a different thing: it is the rig giving up, not
     * the view being chosen, and it fires on a crowded surface as readily as in
     * a tunnel. One assignment is the whole of the fix.
     */
    this.follow.submerged = this.underground;
    this.refreshView();
    this.follow.aimPitch = this.aimPitch + (this.firstPerson ? this.eyePitch : 0);
    this.follow.update(
      dt,
      Math.atan2(this.forward.x, this.forward.z),
      (p) => this.solidAt(p),
      CELL * 2,
      undefined,
      this.forward,
    );
  }

  /**
   * How high the soil is under a point, measured along HER up.
   *
   * The foot solver wants an elevation, and on a wall or an underside there
   * is no such thing in world terms — so the cast goes in along her own down
   * and the answer is reported as a distance along her own up. Off the block
   * entirely, the answer is "far below", which parks the foot rather than
   * planting it in mid-air.
   */
  /**
   * The soil under a point — the NEAREST surface, not the outermost one.
   *
   * This used to start its cast `GRIP_LIFT` (3 mm) above the point, which is
   * above the roof of anything she has dug. So a foot standing in a tunnel
   * got the answer for the ORIGINAL ground overhead, read as being far below
   * the surface, and was lifted out onto it. That is the ant in a pit with
   * her legs splayed across the flat around it.
   *
   * The lift exists for a real reason — a foot a little INTO the soil needs
   * the surface just above it, not the next one down — so it is kept and
   * made small: one cell, which is less than the height of a single bite's
   * tunnel and enough to cover a foot that has sunk a fraction of a
   * millimetre.
   */
  private surfaceUnder(x: number, y: number, z: number): number {
    const from = new THREE.Vector3(x, y, z).addScaledVector(this.up, CELL);
    const hit = this.cast(from, this.up.clone().negate(), CELL + GRIP_REACH);
    if (!hit) return -SPAN;
    return hit.dot(this.up);
  }

  /**
   * How far the eye is beneath the soil overhead, in world units.
   *
   * Marched along her own up rather than the world's, so a tunnel in a wall
   * counts as buried the same as one in the floor. The depth is measured to
   * the OUTERMOST soil on that line, not the first surface met — inside a
   * burrow the first thing above the eye is the tunnel's roof a millimetre
   * away, and being a millimetre under a metre of soil is still buried.
   *
   * Zero when there is nothing overhead, which is the surface and above.
   */
  /**
   * Soil above a point ALONG HER OWN UP — kept only because probes written
   * against it still read it, and no longer drives anything.
   *
   * It swings with her orientation rather than her position, which is why the
   * fade and the railway both ask `senseRoom` instead. See `senseWanted`.
   */
  buriedDepth(from: THREE.Vector3): number {
    let last = 0;
    const probe = new THREE.Vector3();
    for (let d = 0; d <= SENSE_PROBE_MM / MM; d += CELL) {
      probe.copy(from).addScaledVector(this.up, d);
      if (this.solidAt(probe)) last = d;
    }
    return last;
  }

  /** Advance only the sense ramp, for probes that park the camera. */
  senseStepForTest(dt: number): void {
    const want = Math.min(1, this.buriedDepth(this.camera.position) / (SENSE_FULL_MM / MM));
    this.sense.uSense.value += (want - this.sense.uSense.value)
      * (1 - Math.exp(-SENSE_EASE * dt));
  }

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    /*
     * The designer owns the camera and the world stands still while it is up.
     * Simulating underneath it would have her walking off on her own behind the
     * panel — and worse, `hold()` would keep re-seating her against soil that
     * is about to be re-cut, so she would come back somewhere nobody put her.
     */
    if (this.designer?.isOpen) {
      this.designer.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(this.animate);
      return;
    }
    if (!this.paused) this.simulate(dt);
    /*
     * Eased toward the depth's answer rather than snapped to it. The depth
     * itself is the fade — a hard cut would flicker every time her head
     * crossed the soil line, which while digging is several times a second.
     */
    const want = Math.min(1, this.buriedDepth(this.camera.position) / (SENSE_FULL_MM / MM));
    this.sense.uSense.value += (want - this.sense.uSense.value)
      * (1 - Math.exp(-SENSE_EASE * dt));
    this.renderer.render(this.scene, this.camera);
    this.renderHeadInset();
    this.updateStatus();
    this.frame = requestAnimationFrame(this.animate);
  };

  /**
   * A PROFILE of her head, inset top-right — the instrument for reading a
   * pitch off the screen.
   *
   * An angle is the one thing the main view cannot show you, in either
   * camera: over her shoulder her head is small and mostly facing away, and
   * onboard you are inside it. So this looks at her from the side, square on,
   * where a nod is the whole picture.
   *
   * ORTHOGRAPHIC on purpose. The reading has to be an angle and nothing else,
   * and a perspective lens a few millimetres from a 2 mm head bends every
   * line it draws. Locked to HER frame rather than the world's, so level in
   * the inset means level to the ant, on a wall and on the ceiling too.
   *
   * It is a debug instrument and it says so: it costs a second scene draw
   * over a sixth of the screen and comes out when the head is signed off.
   */
  private renderHeadInset(): void {
    if (!this.ready || !this.debug) return;
    const head = new THREE.Vector3();
    if (!this.queen.eyePosition(head)) return;
    /*
     * Her LEFT, so a nose-down nod reads as clockwise the way a protractor
     * does. Her own up is the inset's up, so the horizon in here is her body
     * axis and the angle you read is the angle the bone was given.
     */
    const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
    this.headCam.position.copy(head).addScaledVector(right, -HEAD_INSET_MM / MM);
    this.headCam.up.copy(this.up);
    this.headCam.lookAt(head);
    this.headCam.updateProjectionMatrix();

    const size = this.renderer.getSize(new THREE.Vector2());
    const w = Math.round(Math.min(size.x, size.y) * HEAD_INSET_FRACTION);
    const x = Math.round(size.x - w - 12);
    const y = Math.round(size.y - w - 12);
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, w, w);
    this.renderer.setScissor(x, y, w, w);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.headCam);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
  }

  private updateStatus(): void {
    const face = this.up.y > 0.7 ? 'top'
      : this.up.y < -0.7 ? 'UNDERSIDE'
        : 'side';
    const mode = MODES[this.mode]!;
    this.status.innerHTML = `<strong>BLOCK ROOM — ${mode.label}: ${mode.hint}</strong><br>
      Block: ${BLOCK_MM} mm cube · ${CELL_MM} mm cells · ${CELLS}³<br>
      Bite: ${(this.queen.antennaToJaw() * BITE_WIDTH_SPANS * MM).toFixed(2)} mm wide, measured (table said ${CASTE_BITE_MM.queen}) · removed ${(this.removed * MM ** 3).toFixed(0)} mm³<br>
      On the ${face} · up ${this.up.x.toFixed(2)}, ${this.up.y.toFixed(2)}, ${this.up.z.toFixed(2)}<br>
      Gyro: ${this.trim.on
    ? `HOLDING ${(this.trim.pitch * 180 / Math.PI).toFixed(0)}° · flying ${this.gradeDeg().toFixed(0)}°`
    : `off · flying ${this.gradeDeg().toFixed(0)}°`}<br>
      Queen: ${CASTE_LENGTH_MM.queen} mm · ${this.gripping ? 'gripping' : 'FALLING'} · `
      + `head ${(this.follow.lookYaw * 180 / Math.PI).toFixed(0)}° off, `
      + `${mode.pitchHead
        ? `cam ${(this.follow.lookPitch * 180 / Math.PI).toFixed(0)}° → BONE `
          + `${this.headAngleDeg().toFixed(0)}° (should match)`
        : `level · BONE ${this.headAngleDeg().toFixed(0)}°`}<br>`
      + `${this.firstPerson
        ? `EYE nudge fwd ${(this.eyeNudge.z * MM).toFixed(2)}, up ${(this.eyeNudge.y * MM).toFixed(2)}, `
          + `right ${(this.eyeNudge.x * MM).toFixed(2)} mm · pitch `
          + `${(this.eyePitch * 180 / Math.PI).toFixed(0)}° — read these off and I will bake them in`
        : '3rd person · tap 1ST for the head cam'}<br>
      Sense: ${(this.sense.uSense.value * 100).toFixed(0)}% · ${this.travelState.toUpperCase()}`
      + ` — ${(this.room.enclosed * 100).toFixed(0)}% enclosed, bore ${this.room.boreMm.toFixed(1)} mm`
      + `${this.rail ? ` · track ${this.rail.lengthMm.toFixed(1)} mm` : ' · no track'}`
      + `${this.onRails ? ` at ${this.railS.toFixed(1)} mm` : ''}<br>
      Legs: ${this.report
    ? `${this.report.planted} planted · ${this.report.groping} reaching · `
      + `${this.report.movedMm.toFixed(2)} mm moved, ${this.report.heldBackMm.toFixed(2)} held back · `
      + `stroke ${(this.report.strain * 100).toFixed(0)}% · `
      + `${this.report.clearanceMm.toFixed(2)} mm clear`
    : 'waiting for the model'}`;
  }

  /**
   * Change mode, and make the HUD say so.
   *
   * The action button is HIDDEN rather than disabled when a mode has no verb,
   * because a greyed-out button on a phone is a thumb-sized piece of screen
   * spent saying "not this". A mode with nothing to do gets its space back.
   *
   * Anything the old mode had held down is released on the way out — holding
   * DIG and cycling away from digging must not leave her chewing.
   */
  setMode(next: number): void {
    this.mode = next;
    this.input.dig = false;
    this.digLatch = false;
    this.actionButton.classList.remove('is-latched');
    const mode = MODES[this.mode]!;
    this.modeButton.textContent = mode.label;
    if (mode.action) {
      this.actionButton.textContent = mode.action.label;
      this.actionButton.style.display = '';
    } else {
      this.actionButton.style.display = 'none';
    }
  }

  /**
   * Swap cameras, and show the tuner only where it means anything.
   *
   * The field of view changes with it: 120 degrees onboard, because an eye a
   * centimetre off the soil at 60 sees a wall and no context, and back to 60
   * over her shoulder where a wide angle would just distort her.
   */
  /** Show or hide every instrument at once. `B` on a keyboard. */
  private setDebug(on: boolean): void {
    this.debug = on;
    this.debugButton.textContent = on ? 'DEBUG' : 'debug';
    this.status.style.display = on ? '' : 'none';
    this.tuner.style.display = on && this.firstPerson ? '' : 'none';
  }

  /**
   * Engage or release the gyro, taking the grade she is CURRENTLY LOOKING AT
   * as the one to hold.
   *
   * A numeric dial would need a row of buttons and a value to read before it
   * meant anything. This is one tap: aim where you want to go, engage, and the
   * body flies the line the view was on — the way a backhoe's boom is placed
   * and then held, rather than a camera hand-held on target. Releasing hands
   * her straight back to the soil.
   *
   * The grade comes from the VIEW, in the world. It first came from
   * `aimPitch`, which is neither: that is the head's aim relative to her body,
   * and it saturates at the neck's limit of +16.71 degrees. So every press
   * read "HOLD 17°" whatever the screen was pointing at — nose UP, which
   * underground is a command to climb out. Reported as defaulting to the same
   * angle every time and then crawling backwards out of the tunnel.
   */
  setTrim(on: boolean, grade = this.lookGrade()): void {
    this.trim.on = on;
    if (on) this.trim.pitch = THREE.MathUtils.clamp(grade, -TRIM_LIMIT, TRIM_LIMIT);
    this.trimButton.textContent = on
      ? `HOLD ${(this.trim.pitch * 180 / Math.PI).toFixed(0)}°`
      : 'hold';
  }

  /**
   * Which view the player wants ON THE SURFACE.
   *
   * Underground is not a preference — it is first person, always. In a four-
   * millimetre bore there is nothing to see of her but the back of her own
   * gaster, and the view she has IS the information: which way the tunnel goes
   * and what is in front of her face. The choice only means anything up top,
   * where there is a whole animal to watch walking.
   */
  private setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    // 'auto' is third person up top and first person the moment she is under.
    // The switch between them is a hard cut by design, never eased: easing
    // between a shot from behind her and a shot from her own head travels
    // straight through her body, and the one time it was tried it turned an
    // 82-degree swing into a 112-degree one.
    this.follow.mode = on ? 'first' : 'auto';
    this.refreshView();
  }

  /**
   * Bring the lens and the label in line with where she actually is.
   *
   * Called every frame rather than only on a press, because `auto` changes the
   * shot without anybody pressing anything — she walks into a hole and the
   * view is first person. A field of view left at the third-person figure
   * while the eye sits on her head is the "driving a car in the air" feeling:
   * a wide lens with nothing near it to give the speed a scale.
   */
  private refreshView(): void {
    const onboard = this.firstPerson || this.underground;
    const fov = onboard ? this.fov.first : this.fov.third;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // The label and the classes only move when the shot does. This runs every
    // frame so that `auto` can change the view without anybody pressing
    // anything, and writing unchanged text to the DOM sixty times a second is
    // the kind of thing that shows up as jank on a phone long before it shows
    // up in a profile.
    if (onboard === this.viewShown) return;
    this.viewShown = onboard;
    this.viewButton.textContent = onboard ? '1ST' : '3RD';
    // Underground the button is showing a fact, not an offer. Say so, rather
    // than letting a press look like it did nothing.
    this.viewButton.classList.toggle('is-locked', this.underground && !this.firstPerson);
    this.tuner.style.display = onboard && this.debug ? '' : 'none';
  }

  /** What `refreshView` last drew, so it can skip a frame that changed nothing. */
  private viewShown: boolean | null = null;

  /**
   * Her head's ABSOLUTE pitch: where her face actually points, measured from
   * the model, not the offset the camera asked for.
   *
   * On screen because that is the number being read off it. Her head does not
   * rest level — it hangs nose-down by its own construction — so a readout of
   * the camera's offset says 0 while her face is already forty degrees into
   * the floor, and two people looking at the same ant disagree by that much.
   *
   * Head joint to jaw tip, which of the several lines that could fairly be
   * called "the head angle" is the one that looks like the head: the neck
   * base reads -26.94 at rest, this reads -36.35, the mouth chain alone
   * -45.00 and the antenna sockets -64.76.
   */
  private headAngleDeg(): number {
    if (!this.ready) return 0;
    const head = new THREE.Vector3();
    const jaw = new THREE.Vector3();
    if (!this.queen.headJointPosition(head) || !this.queen.jawPosition(jaw)) return 0;
    const d = jaw.sub(head).normalize();
    return (Math.asin(Math.max(-1, Math.min(1, d.dot(this.up)))) * 180) / Math.PI;
  }

  /** Is the gyro engaged? For probes, which cannot see a private. */
  trimOnForTest(): boolean {
    return this.trim.on;
  }

  /**
   * The grade the VIEW is on, against world horizontal. What "hold this line"
   * means when you press the button while looking somewhere.
   */
  lookGrade(): number {
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  /**
   * The grade she is actually flying: her nose against world horizontal,
   * nose-up positive. What the gyro is trying to make equal to its command.
   */
  gradeDeg(): number {
    return (Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1)) * 180) / Math.PI;
  }

  /** Aim through the same clamp a drag uses. For probes. */
  setAimPitchForTest(next: number): void {
    this.aimPitch = THREE.MathUtils.clamp(next, -HEAD_PITCH_DOWN, HEAD_PITCH_UP);
  }

  /* ------------------------------------------------------------ the input */

  /**
   * The coaster builder: draft a piece with four steppers, queue it, fly it.
   *
   * Four steppers rather than a free numeric entry because this is used with a
   * thumb, and because the steps ARE the vocabulary — fifteen degrees and one
   * millimetre are the units a tunnel is actually described in. The draft is
   * shown as the sentence you would say out loud ("down 15, left 45, roll 30,
   * 6 mm") so the panel reads as the plan rather than as four spinboxes.
   *
   * Hidden behind PLAN, because a phone in landscape has room for the view or
   * for a builder and not both, and the builder is the one you close.
   */
  private buildPlanner(hud: HTMLElement, actions: HTMLElement): void {
    if (!this.planEnabled) return;
    this.planButton.className = 'density-lab-button density-lab-mode';
    this.planButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setPlanner(this.planner.style.display === 'none');
    });
    actions.appendChild(this.planButton);

    this.planner.className = 'density-lab-planner';
    const rows: Array<[string, keyof DigPiece, string]> = [
      ['PITCH', 'pitch', '°'],
      ['TURN', 'turn', '°'],
      ['ROLL', 'roll', '°'],
      ['LEN', 'length', 'mm'],
    ];
    for (const [label, key, unit] of rows) {
      const row = document.createElement('div');
      row.className = 'density-lab-planner-row';
      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);
      const value = document.createElement('b');
      row.appendChild(value);
      this.planFields.set(key, { value, unit });
      for (const dir of [-1, 1]) {
        const button = document.createElement('button');
        button.textContent = dir < 0 ? '−' : '+';
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          this.draft = clampPiece({
            ...this.draft,
            [key]: this.draft[key] + dir * PIECE_LIMITS[key].step,
          });
          this.updatePlanHud();
        });
        row.appendChild(button);
      }
      this.planner.appendChild(row);
    }

    const queue = document.createElement('div');
    queue.className = 'density-lab-planner-row';
    for (const [label, run] of [
      ['ADD', () => { this.planPieces.push({ ...this.draft }); }],
      ['UNDO', () => { this.planPieces.pop(); }],
      ['CLEAR', () => { this.planPieces = []; this.stopPlan(); }],
    ] as Array<[string, () => void]>) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        run();
        this.updatePlanHud();
      });
      queue.appendChild(button);
    }
    this.planner.appendChild(queue);

    this.planRunButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (this.plan) this.stopPlan();
      else this.startPlan();
    });
    this.planner.appendChild(this.planRunButton);
    this.planner.appendChild(this.planList);
    this.planList.className = 'density-lab-planner-list';
    hud.appendChild(this.planner);
    this.setPlanner(false);
    this.updatePlanHud();
  }

  private setPlanner(on: boolean): void {
    this.planner.style.display = on ? '' : 'none';
    this.planButton.textContent = on ? 'PLAN' : 'plan';
  }

  /** Redraw the draft, the queue and what the run is doing. */
  private updatePlanHud(): void {
    for (const [key, { value, unit }] of this.planFields) {
      const n = this.draft[key];
      value.textContent = `${n > 0 && key !== 'length' ? '+' : ''}${n}${unit}`;
    }
    const total = this.planPieces.reduce((a, p) => a + p.length, 0);
    this.planRunButton.textContent = this.plan ? 'STOP' : 'RUN';
    this.planList.textContent = this.planPieces.length === 0
      ? 'no pieces — set one and ADD'
      : this.planPieces.map((p, i) => {
        const mark = this.plan && i === this.plan.pieceIndex ? '▶' : `${i + 1}.`;
        return `${mark} ${p.pitch}° ${p.turn > 0 ? 'L' : p.turn < 0 ? 'R' : '—'}`
          + `${p.turn ? Math.abs(p.turn) : ''} roll ${p.roll}° · ${p.length}mm`;
      }).join('\n') + `\n${total} mm · ${total} s at ${PLAN_SPEED_MM_S} mm/s`;
  }

  /** Open the builder and redraw it. For probes and screenshots. */
  setPlannerForTest(on: boolean): void { this.setPlanner(on); }
  updatePlanHudForTest(): void { this.updatePlanHud(); }

  private buildControls(hud: HTMLElement): void {
    this.stick.className = 'density-lab-stick';
    this.stickKnob.className = 'density-lab-stick-knob';
    this.stick.appendChild(this.stickKnob);
    hud.appendChild(this.stick);

    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    hud.appendChild(actions);
    /*
     * MODE first, then the action the mode offers.
     *
     * One action button that means whatever the mode says, rather than one
     * button per verb — a phone has room for about two, and this game will
     * have more verbs than that. Tapping MODE cycles forward; on a keyboard
     * `*` goes forward and `/` goes back.
     */
    this.modeButton.className = 'density-lab-button density-lab-mode';
    this.modeButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setMode(cycleMode(this.mode));
    });
    actions.appendChild(this.modeButton);

    this.actionButton.className = 'density-lab-button density-lab-dig';
    actions.appendChild(this.actionButton);
    // Tap-to-toggle: one tap starts digging, another stops it.
    // This lets the player navigate while digging without holding the button.
    this.actionButton.addEventListener('pointerdown', (event: PointerEvent) => {
      event.preventDefault();
      /*
       * On a block that came from a plan, DIG means DESIGN.
       *
       * Chewing a tunnel one bite at a time is how the nest used to get made,
       * and it records every wobble she had while making it. Drawing it and
       * cutting it to the drawing is the same verb done properly — so the big
       * button opens the designer, and manual digging stays on the rigs that
       * have no plan to draw.
       */
      if (this.nest) { this.openDesigner(); return; }
      this.digLatch = !this.digLatch;
      this.input.dig = this.digLatch;
      this.actionButton.classList.toggle('is-latched', this.digLatch);
    });
    this.setMode(this.mode);
    this.buildPlanner(hud, actions);

    /*
     * FIRST PERSON, and a tuner for where its eye goes.
     *
     * The toggle is its own button rather than a fourth entry in the mode
     * ring, because which camera you are on is orthogonal to what you are
     * doing — you want first person while digging AND while walking, and
     * folding them together would double the ring every time a verb is added.
     */
    /*
     * DEBUG off by default. The readout, the tuner and the head inset are
     * instruments, and instruments covering most of a phone screen make it
     * impossible to judge how the thing actually looks — which is the whole
     * reason for looking at it. One tap puts them all back.
     */
    this.debugButton.className = 'density-lab-button density-lab-mode';
    this.debugButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setDebug(!this.debug);
    });
    actions.appendChild(this.debugButton);

    this.trimButton.className = 'density-lab-button density-lab-mode';
    this.trimButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setTrim(!this.trim.on);
    });
    actions.appendChild(this.trimButton);
    this.setTrim(false);

    /*
     * The sonar toggle, and only when there is a plan to draw. A button that
     * does nothing on five of six rigs is worse than no button on a phone
     * screen this size.
     */
    if (this.nestView) {
      this.nestButton.className = 'density-lab-button density-lab-mode';
      this.nestButton.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.setSonar(!this.sonar);
      });
      actions.appendChild(this.nestButton);
      this.setSonar(true);
    }

    this.viewButton.className = 'density-lab-button density-lab-mode';
    this.viewButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setFirstPerson(!this.firstPerson);
    });
    actions.appendChild(this.viewButton);

    this.buildSettings(hud, actions);

    this.buildTuner(hud);
  }

  /**
   * The settings panel: the two lenses, on sliders.
   *
   * A slider rather than the tuner's plus-and-minus pair, because a field of
   * view is something you find by sweeping until it feels right, not by
   * stepping to a number you already knew. Ninety degrees of range at one
   * degree a tap would be ninety taps.
   *
   * Closed by default and drawn over the scene when open. The thing being
   * adjusted is the view itself, so the panel has to leave most of the view
   * showing or there is nothing to judge the setting against — it updates live
   * as the slider moves for the same reason.
   */
  private buildSettings(hud: HTMLElement, actions: HTMLElement): void {
    this.settings.className = 'density-lab-settings';
    this.settings.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'density-lab-settings-title';
    title.textContent = 'FIELD OF VIEW';
    this.settings.appendChild(title);

    const lenses: Array<['first' | 'third', string]> = [
      ['first', '1ST'],
      ['third', '3RD'],
    ];
    for (const [which, label] of lenses) {
      const row = document.createElement('label');
      row.className = 'density-lab-settings-row';

      const name = document.createElement('span');
      name.className = 'density-lab-settings-name';
      name.textContent = label;
      row.appendChild(name);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(FOV_MIN);
      slider.max = String(FOV_MAX);
      slider.step = '1';
      slider.value = String(this.fov[which]);
      row.appendChild(slider);

      const readout = document.createElement('span');
      readout.className = 'density-lab-settings-value';
      readout.textContent = `${this.fov[which]}°`;
      row.appendChild(readout);

      slider.addEventListener('input', () => {
        this.setFov(which, Number(slider.value));
        readout.textContent = `${this.fov[which]}°`;
      });
      // The joystick and the dig button both read raw pointer events off the
      // canvas. Without this a drag on the slider also drives her.
      for (const kind of ['pointerdown', 'pointermove', 'pointerup'] as const) {
        slider.addEventListener(kind, (event) => event.stopPropagation());
      }
      this.settings.appendChild(row);
    }

    const reset = document.createElement('button');
    reset.className = 'density-lab-settings-reset';
    reset.textContent = 'RESET';
    reset.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setFov('first', FIRST_PERSON_FOV);
      this.setFov('third', THIRD_PERSON_FOV);
      for (const input of this.settings.querySelectorAll('input')) {
        const which = input.parentElement?.firstElementChild?.textContent === '1ST'
          ? 'first' : 'third';
        input.value = String(this.fov[which]);
        const readout = input.nextElementSibling;
        if (readout) readout.textContent = `${this.fov[which]}°`;
      }
    });
    this.settings.appendChild(reset);
    hud.appendChild(this.settings);

    this.settingsButton.className = 'density-lab-button density-lab-mode';
    this.settingsButton.textContent = 'FOV';
    this.settingsButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const open = this.settings.style.display === 'none';
      this.settings.style.display = open ? '' : 'none';
      this.settingsButton.classList.toggle('is-latched', open);
    });
    actions.appendChild(this.settingsButton);
  }

  private buildTuner(hud: HTMLElement): void {
    this.tuner.className = 'density-lab-tuner';
    const rows: Array<[string, (dir: number) => void]> = [
      ['FWD', (d) => { this.eyeNudge.z += d * EYE_NUDGE_MM / MM; }],
      ['UP', (d) => { this.eyeNudge.y += d * EYE_NUDGE_MM / MM; }],
      ['RIGHT', (d) => { this.eyeNudge.x += d * EYE_NUDGE_MM / MM; }],
      ['PITCH', (d) => { this.eyePitch += (d * EYE_NUDGE_DEG * Math.PI) / 180; }],
    ];
    for (const [label, apply] of rows) {
      const row = document.createElement('div');
      row.className = 'density-lab-tuner-row';
      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);
      for (const dir of [-1, 1]) {
        const button = document.createElement('button');
        button.textContent = dir < 0 ? '\u2212' : '+';
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          apply(dir);
        });
        row.appendChild(button);
      }
      this.tuner.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.textContent = 'RESET';
    reset.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.eyeNudge.set(0, 0, 0);
      this.eyePitch = 0;
    });
    this.tuner.appendChild(reset);
    hud.appendChild(this.tuner);
    this.setFirstPerson(false);
    this.setDebug(false);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      // Bound to the canvas for the life of the gesture, so its release comes
      // back here even if the finger ends up over the HUD or off the edge.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      /*
       * While the designer is up the canvas is ITS canvas. Handing the same
       * events to both would spawn a joystick under every orbit and turn her on
       * the spot behind the panel.
       */
      if (this.designer?.isOpen) { this.designer.handlePointerDown(event); return; }
      if (event.clientX < window.innerWidth * 0.5 && this.stickPointer === null) {
        this.stickPointer = event.pointerId;
        const o = clampStickOrigin(event.clientX, event.clientY, {
          minX: STICK_RADIUS + 12, maxX: window.innerWidth * 0.5 - 12,
          minY: STICK_RADIUS + 12, maxY: window.innerHeight - STICK_RADIUS - 12,
        });
        this.stickOrigin.x = o.x;
        this.stickOrigin.y = o.y;
        this.stick.style.left = `${o.x}px`;
        this.stick.style.top = `${o.y}px`;
        this.stick.classList.add('is-live');
        return;
      }
      this.lookPointer = event.pointerId;
      this.lookAt = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.designer?.isOpen) { this.designer.handlePointerMove(event); return; }
      if (event.pointerId === this.stickPointer) {
        const v = stickVector(
          event.clientX - this.stickOrigin.x, event.clientY - this.stickOrigin.y, STICK_RADIUS,
        );
        /*
         * BOTH axes, proportionally. This is where "it snaps from forward to
         * turn" actually lived.
         *
         * The stick used to be quantised to ONE axis — whichever component
         * was larger won, and it won at `sign(component) × magnitude`, the
         * full throw. So she could never walk and turn at once, a lean of
         * one degree past the diagonal swapped a full walk for a full spin in
         * a single frame, and nothing in between the four compass points
         * existed. Easing the command afterwards, which is what the last
         * change did, can only smooth the edges of a square wave; it cannot
         * make the square wave a curve.
         *
         * Passing both through is all it takes, because the legs already
         * handle a mixed twist properly — `v + ω × r` per leg — and have
         * since they were built from Hexapod_v4. A diagonal thumb is a
         * curved walk, and rolling right round the pad sweeps continuously
         * from walk to spin and back.
         */
        this.input.walk = 0;
        this.input.yaw = 0;
        if (v.magnitude > STICK_DEADZONE) {
          // Rescale so the throw starts at zero just outside the deadzone
          // rather than jumping to 0.12 the moment it is crossed.
          const throwOut = (v.magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
          const k = throwOut / v.magnitude;
          this.input.walk = -v.y * k;
          this.input.yaw = -v.x * k;
        }
        this.stickKnob.style.transform = `translate(${v.x * STICK_RADIUS}px, ${v.y * STICK_RADIUS}px)`;
        return;
      }
      if (event.pointerId !== this.lookPointer) return;
      const dx = event.clientX - this.lookAt.x;
      const dy = event.clientY - this.lookAt.y;
      this.lookAt = { x: event.clientX, y: event.clientY };
      this.follow.orbit(-dx * LOOK_PER_PIXEL, -dy * LOOK_PER_PIXEL);
      /*
       * Clamped to what her NECK can do, not to what a camera can do.
       *
       * In first person the eye is on her head, so any range the view has
       * that the neck does not is range where the two silently part company.
       * Fifteen degrees up is the neck's limit, so it is the view's too.
       */
      this.aimPitch = THREE.MathUtils.clamp(
        this.aimPitch - dy * LOOK_PER_PIXEL,
        -HEAD_PITCH_DOWN,
        HEAD_PITCH_UP,
      );
      /*
       * And the YAW is clamped to her neck too, onboard, for the same reason
       * the pitch is: the eye is on her head, so a view that can swing
       * further than the neck is a view that parts company with it.
       */
      if (this.firstPerson) {
        this.follow.yawOffset = THREE.MathUtils.clamp(
          this.follow.yawOffset, -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT,
        );
      }
    });
    const release = (event: PointerEvent) => {
      if (this.designer?.isOpen) { this.designer.handlePointerUp(event); return; }
      if (event.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.input.walk = 0;
        this.input.yaw = 0;
        this.stick.classList.remove('is-live');
        this.stickKnob.style.transform = '';
      }
      if (event.pointerId === this.lookPointer) this.lookPointer = null;
    };
    /*
     * RELEASED FROM ANYWHERE, and captured so it usually does not have to be.
     *
     * These used to be on the canvas alone. The HUD, the buttons and the
     * tuner all take pointer events, and the screen edge takes them too — so
     * a thumb that slid off the canvas mid-drag fired its `pointerup`
     * somewhere the canvas never heard, the stick stayed latched at whatever
     * it was last set to, and she span on the spot at full deflection until
     * the app was killed. Reported exactly that way.
     *
     * Three layers, because a stuck control is unrecoverable without one:
     *   CAPTURE  binds the pointer to the canvas on the way down, so its up
     *            comes back here wherever the finger has wandered to.
     *   WINDOW   catches the release anyway if capture was refused or lost,
     *            which is the case capture alone does not cover.
     *   BLUR     zeroes everything when the app goes away, since a pointer
     *            that ends while backgrounded may never report at all.
     */
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    const letGo = (): void => {
      this.stickPointer = null;
      this.lookPointer = null;
      this.input.walk = 0;
      this.input.yaw = 0;
      this.input.dig = false;
      this.digLatch = false;
      this.actionButton.classList.remove('is-latched');
      this.stick.classList.remove('is-live');
      this.stickKnob.style.transform = '';
    };
    window.addEventListener('blur', letGo);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) letGo();
    });

    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyW') this.input.walk = 1;
      if (event.code === 'KeyS') this.input.walk = -1;
      if (event.code === 'KeyA') this.input.yaw = 1;
      if (event.code === 'KeyD') this.input.yaw = -1;
      if (event.code === 'Space') {
        event.preventDefault();
        this.digLatch = !this.digLatch;
        this.input.dig = this.digLatch;
        this.actionButton.classList.toggle('is-latched', this.digLatch);
      }
      // Named by key, not by code: `*` and `/` live in different places on
      // a numpad and a main row, and the player means the character.
      if (event.key === '*') { event.preventDefault(); this.setMode(cycleMode(this.mode)); }
      if (event.key === '/') { event.preventDefault(); this.setMode(cycleMode(this.mode, -1)); }
      if (event.code === 'KeyV') { event.preventDefault(); this.setFirstPerson(!this.firstPerson); }
      if (event.code === 'KeyB') { event.preventDefault(); this.setDebug(!this.debug); }
      if (event.code === 'KeyH') { event.preventDefault(); this.setTrim(!this.trim.on); }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'KeyW' || event.code === 'KeyS') this.input.walk = 0;
      if (event.code === 'KeyA' || event.code === 'KeyD') this.input.yaw = 0;
      // Space is now a toggle — keyup does nothing for dig.
    });
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
