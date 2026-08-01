import * as THREE from 'three';
import { QueenModel } from '../anim/QueenModel';
import { BoreRig, DIG_YAW_RATE, STROKE_SECONDS, YAW_RATE } from './BoreControl';
import { clampStickOrigin, stickVector } from '../voxel/locomotion';
import { FollowCamera, type CameraMode } from './FollowCamera';
import { TripodGait, type SurfaceAt } from '../anim/tripod';
import { DigHud } from './DigHud';
import { CASTE_LENGTH_MM } from '../anim/hexapod';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { TerrainStream } from '../density/TerrainStream';
import {
  BITE_DEPTH, BITE_DEPTH_MM, BITE_WIDTH_MM, BRUSH_RADIUS, CELLS_Y,
  CELL_SIZE, CHUNK_CELLS, CLOD_DISPLAY_SCALE, PELLET_SOLIDITY, WORLD_UNIT_MM, clodGeometry,
} from '../density/labMound';
import {
  SOIL_DEPTH, TILE_CELLS, TILE_MM, WINDOW_BYTES, WINDOW_CELLS, WINDOW_SIZE,
  WORLD_SPAN, WORLD_TILES, streamGroundHeight,
} from '../density/labWorld';
import './DensityTerrainLabScene.css';

const MAX_PELLETS = 36;

/** World units per second she walks. About 12 mm/s — a tile every 1.3 s. */
const WALK_SPEED = 2.4;

/** Crawl is a third of a walk — the pace for placing a tunnel precisely. */
const CRAWL_FRACTION = 0.34;

/**
 * How fast she advances while BORING, in world units per second.
 *
 * DERIVED, and the derivation is one line: a stroke cuts BITE_DEPTH_MM off the
 * face and takes STROKE_SECONDS to do it, so the face retreats at exactly that
 * ratio and so does she. 0.5 mm every 0.42 s is 1.2 mm/s. The width of the bore
 * does not enter into it — a wider tunnel is more soil per stroke AND more soil
 * per millimetre of progress, and the two cancel.
 *
 * The complaint this answers is that digging was nothing like the work it
 * depicts. She bored at 8.2 mm/s, three quarters of her walking pace, while her
 * jaws could clear 1.2 mm of face a second: not tunnelling through the mound,
 * swimming through it with the bite as decoration. Nothing stopped her, because
 * the block test is a single point at her centre and the dig point runs a
 * centimetre ahead, so her path was always already cleared when she reached it.
 *
 * My first attempt at this was a hand-picked 2.1 mm/s dressed up in a volume
 * argument that divided by HER cross-section instead of the TUNNEL's. Those are
 * different numbers and only one of them is what has to be removed.
 */
const BORE_SPEED = (BITE_DEPTH_MM / STROKE_SECONDS) / WORLD_UNIT_MM;

/** Radians per second she can turn. A little over half a turn a second. */
const TURN_RATE = 3.6;

/**
 * Seconds for the head to swing the full ninety degrees, and how far behind it
 * the thorax and the gaster follow.
 *
 * The pitch used to be applied to the aim the instant a button was pressed,
 * which is why it "didn't exactly work": the number on the gauge jumped and
 * the animal did not move at all. A body takes time to point somewhere, and
 * the segments do not arrive together — head, then thorax, then gaster, like a
 * train. The lags are fractions of the swing rather than seconds, so retuning
 * the swing keeps the shape of the motion.
 */
const PITCH_SWING_SECONDS = 3;
/*
 * Each segment's own rate, as a fraction of the head's — so a SMALLER number
 * trails further. They were 0.45 and 0.75, which made the gaster faster than
 * the thorax it was supposed to be following, and since it is stepped toward
 * the thorax in the same frame it caught up completely every time: the trace
 * showed thorax and gaster identical to the tenth of a degree, which is a
 * train with one carriage.
 */
const THORAX_RATE = 0.45;
const GASTER_RATE = 0.22;

/**
 * How quickly the dig animation fades after a bite, in units per second.
 *
 * The gait takes `digging` as a 0..1 level, not an event, so a bite raises it
 * and this brings it back down. Roughly a third of a second of scraping per
 * tap, which is about how long the crater takes to register anyway.
 */
const DIG_DECAY = 3;

/**
 * How far apart her feet are, as a fraction of her length, for reading slope.
 *
 * A little over a third either way, so the span is most of her body. Small
 * enough that she follows a real rise; large enough that she ignores anything
 * she could simply step over — including her own diggings, which is what she
 * spends the whole lab doing.
 */
const STANCE = 0.35;

/**
 * Eight points around her body's own width, for the descend rule.
 *
 * Eight rather than four because a bore met off-centre crosses the ring
 * diagonally as often as squarely, and four axis points can straddle an opening
 * that eight would find. Unit vectors; the radius is her measured girth.
 */
/**
 * What is left of her walking speed once her footing has gone — a fifth.
 *
 * Not zero: she should still be able to edge forward off a lip, and a hard stop
 * at the rim is its own kind of wrong. Small enough that she goes DOWN a hole
 * she is over rather than across it.
 */
const HOLE_SCRABBLE = 0.2;

/** The castes on the bench, left to right. */
const CASTES = ['worker', 'queen', 'major'] as const;

/**
 * How far apart they stand.
 *
 * A queen length and a bit: far enough that no two overlap and a tap picks the
 * one you meant, close enough that all three sit inside the follow camera's
 * frame at its default arm — about 36 mm wide where they stand.
 */
const BENCH_SPACING = 11 / WORLD_UNIT_MM;

/** One ant on the bench. Only the driven one moves; see `ants`. */
interface LabAnt {
  caste: (typeof CASTES)[number];
  model: QueenModel;
  position: THREE.Vector3;
  facing: number;
  ready: boolean;
}

const BODY_RING: ReadonlyArray<readonly [number, number]> = (() => {
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    ring.push([Math.cos(a), Math.sin(a)]);
  }
  return ring;
})();

/**
 * How far past her mouthparts she can bite, in world units — about 2 mm.
 *
 * Her mandibles are not in the rig (the auto-rigger left the queen's out), so
 * the mouth bone is the nearest honest anchor and this covers the jaws
 * themselves plus a little of the lunge. It is also the reach limit: soil
 * further away than this is soil she has to walk to.
 */
const JAW_REACH = 0.6;

/**
 * How far below level she scrapes when she is not aiming at anything reachable.
 *
 * Her mouthparts sit about 1.4 mm above her feet and 4 mm ahead of her centre,
 * so a ray from them toward a target several millimetres away is very nearly
 * level — and a level ray from a point above the ground never meets it. Aiming
 * alone therefore found no soil at all and every bite reported that her jaws
 * could not reach, on flat ground, with her face in the dirt.
 */
const DIG_PITCH = 0.7;

/**
 * The gap left under a planted foot, in world units — a hundredth of a
 * millimetre, as asked for.
 *
 * Not zero, and the reason is floating point rather than taste: the foot's
 * position comes back through a skinned mesh at float32, so a target of
 * exactly the surface lands a hair under it about half the time, and a hair
 * under is the clipping this exists to stop.
 */
const FOOT_CLEARANCE = 0.01 / WORLD_UNIT_MM;

/**
 * How close to the ground a foot must be before it is treated as standing on
 * it — 0.6 mm, about a tenth of her body length.
 *
 * This is what tells a planted foot from a swinging one without the gait
 * having to say. Too large and she drags her feet through the swing; too small
 * and a downhill foot never finds the ground it is supposed to be pushing off.
 */
const FOOT_PLANT_BAND = 0.6 / WORLD_UNIT_MM;

/**
 * How far above herself she looks for ground — her step height, 2 mm.
 *
 * Every ground query is now "the floor below this", so this is what decides
 * what counts as a step up rather than a wall. Too small and she cannot climb
 * the rim of her own diggings; too large and the query starts finding the top
 * of a burrow's ceiling again, which is the bug it exists to avoid.
 */
const STEP_UP = 2 / WORLD_UNIT_MM;

/** World up and world forward, for anything measured against the horizon. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FORWARD = new THREE.Vector3(0, 0, 1);
/** Scratch for turning a tap into a ray. */
const POINTER = new THREE.Vector2();

/**
 * Gravity, in world units per second squared. Five, as asked for.
 *
 * A tuned number, not physics: real gravity is 9,800 mm/s², which on a 9 mm
 * animal in a 320 mm world is a fall over before you have seen it start. Five
 * world units is 25 mm/s², about a body length in the first second — slow
 * enough to read as weight rather than as a teleport.
 *
 * It applies whether she is walking, boring or underground. That is the point:
 * every "floating in space" bug so far has been some code path deciding she
 * did not need holding up this frame, and the honest answer to a missing
 * support is to FALL, not to hang there. Gravity is the one rule that has no
 * exceptions, so it is the only thing that can catch all of them at once.
 */
const GRAVITY = 5;

/**
 * How far above the ground she has to be before gravity takes over from the
 * stance.
 *
 * Below this, `stand` eases her onto the surface — that easing is what stops
 * her shivering as bites change the ground under her feet, and it has to keep
 * doing that job. Above it she is not standing on anything and no amount of
 * easing should pretend otherwise. Half a millimetre is under a tenth of her
 * body height, so nothing that reads as contact ever reaches the falling path.
 */
const FALL_FROM = 0.5 / WORLD_UNIT_MM;

/** Terminal speed, so a long drop cannot tunnel her through a thin floor. */
const FALL_LIMIT = 30 / WORLD_UNIT_MM;

/**
 * How quickly her height and her walking speed catch up, per second.
 *
 * Both were instant. Height snapped to whatever the ground said this frame,
 * which over a dug surface is a different number every frame, and the pad
 * moved her at full speed from a standing start. Smoothing both is most of
 * what "make the movement lerp" means; the rest is that the terrain under her
 * changes while she stands on it, and a step response of about a fifth of a
 * second turns that from a snap into a settle.
 */
const HEIGHT_EASE = 14;

/** How far the camera stays clear of the soil — 3 mm, about a third of her. */
const CAMERA_CLEARANCE = 3 / WORLD_UNIT_MM;

/**
 * Throttle applied automatically while boring, as a fraction of walking pace.
 *
 * A tunnel is dug by advancing into it. Standing still and biting makes one
 * pocket and then nothing at all, because after the first stroke there is no
 * soil left within reach of her jaws — so the second bite reports nothing to
 * bite and the player concludes the dig has broken. A slow creep keeps her
 * face against the working end.
 */
const BORE_CREEP = 0.28;

/**
 * Extra downward pitch to try, in radians, when the aimed angle finds nothing.
 *
 * Her jaws are about 1.4 mm above her feet and reach 3 mm, so anything
 * shallower than roughly twenty-five degrees below level misses flat ground
 * entirely. Sweeping rather than giving up means "aim level and hold BORE" on
 * open ground does the obvious thing — scrapes a trench in front of her —
 * without the player having to discover that they must aim down first.
 */
const BORE_SWEEP = [0, -0.3, -0.6, -0.9, -1.2];

/**
 * How far ahead of her jaws the bore is aimed — one centimetre.
 *
 * A virtual point she drives AT, rather than a direction she happens to be
 * facing. The difference shows the moment the pitch changes: aiming down ten
 * degrees moves a target a centimetre away by nearly two millimetres, so the
 * cut swings and she follows it. Without a target the bite direction and the
 * travel direction are two numbers that agree only as long as nobody touches
 * the dial, and the tunnel wanders between them.
 */
const DIG_POINT_AHEAD = 10 / WORLD_UNIT_MM;

/** How far her mandibles reach past the mouth bone — 1 mm. */
const MANDIBLE_REACH = 1 / WORLD_UNIT_MM;

/** How high up her body the camera aims — mid-thorax, about 2.5 mm. */
const CAMERA_LOOK_AT = 2.5 / WORLD_UNIT_MM;

/** Throw of the floating stick, in CSS pixels. Matches the main room's. */
const STICK_RADIUS = 70;

/** How far the camera swings per pixel dragged. */
const LOOK_PER_PIXEL = 0.006;

/** Pixels a pointer may travel and still count as a tap rather than a drag. */
const TAP_SLOP = 6;


/** How much one nudge moves the first-person eye, in world units. */
const EYE_NUDGE = 0.5 / WORLD_UNIT_MM;
/** Where the eye may be placed, either side of her origin. */
const EYE_RANGE = 12 / WORLD_UNIT_MM;
/** Local-storage key for the camera settings, so a placement survives a reload. */
const CAMERA_PREFS = 'thronemound.lab.camera';

/** Scratch for the camera sight-line march, so it allocates nothing. */
const PROBE = new THREE.Vector3();
/** Scratch for the roof sense, which runs while PROBE may be in use. */
const SENSE = new THREE.Vector3();

/**
 * The cone that decides whether she has a ceiling: straight up, and four rays
 * at forty degrees. See `underground` — a majority of these hitting soil is
 * what "covered" means, so a shaft counts (walls all round), a tunnel counts
 * (roof plus its two walls), and an open crater does not (rim on one side at
 * most).
 */
const ROOF_RAYS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const tilt = 40 * Math.PI / 180;
  const out = Math.sin(tilt);
  const rise = Math.cos(tilt);
  return [
    [0, 1, 0],
    [out, rise, 0], [-out, rise, 0], [0, rise, out], [0, rise, -out],
  ];
})();
const SPEED_EASE = 7;

/* ---------------------------------------------------------------- the climb */

/** The practice tree: a bark cylinder rising from the mound near the bench. */
const TREE_RADIUS = 12.5 / WORLD_UNIT_MM;
const TREE_HEIGHT = 60 / WORLD_UNIT_MM;
/**
 * Steeper than this — the surface normal's agreement with world up — and a
 * surface is a WALL: walking into it mounts it. Flatter than `EXIT_FLAT` and
 * the wall has become floor again and the climb hands back to the ordinary
 * walk. The gap between the two is hysteresis, so a rolling lip does not
 * flicker her between modes.
 */
const MOUNT_STEEP = 0.5;
const EXIT_FLAT = 0.82;
/** How fast her up rolls onto a new face, and how fast she is drawn onto it. */
const CLIMB_ALIGN = 9;
const CLIMB_SNAP = 10;
/**
 * The lip wrap: when the surface under her vanishes — she has walked over the
 * top edge of the trunk — the new surface is behind and below her in her own
 * frame. These are the angles the search sweeps, from "just below" round to
 * "behind me", rotating the hold cast from -up toward -forward.
 */
const LIP_ARCS = [0.6, 1.2, 1.9];

/* Scratch for the climb's casts; none of these survive a call. */
const CAST_AT = new THREE.Vector3();
const CAST_HIT = new THREE.Vector3();
const CAST_FROM = new THREE.Vector3();
const CAST_DIR = new THREE.Vector3();
const CAST_N = new THREE.Vector3();
const CLIMB_V = new THREE.Vector3();
const GUARD_P = new THREE.Vector3();
const SPIN = new THREE.Quaternion();

/**
 * How much of a frame may go to building newly streamed chunks.
 *
 * A scroll brings in a third of the window — around fifty chunks and a tenth
 * of a second of meshing. Spent in one frame that is a visible lurch at every
 * tile line; spread over a few frames it is soil arriving, which is what
 * streaming is supposed to look like anyway.
 *
 * A share of the FRAME rather than a fixed slice, because a fixed slice is a
 * promise about frame rate that nothing keeps. At nine milliseconds a frame
 * the queue drained fine at sixty frames a second and never emptied at all
 * under software rendering, where a frame is a couple of hundred milliseconds
 * and nine of them buys two chunks: soil arrived more slowly than walking
 * asked for more of it. As a share it self-corrects — a device already
 * struggling to draw spends proportionally more on having something to draw,
 * and a fast one still never gives up more than a small part of a frame.
 */
const BUILD_SHARE = 0.3;
const BUILD_FLOOR_MS = 6;
const BUILD_CEILING_MS = 40;


/** Sample bounds the stream kept through a scroll, in window-local indices. */
type Retained = { x0: number; x1: number; z0: number; z1: number };

/**
 * Is a resident chunk's soil still the soil it was meshed from?
 *
 * Being inside the window is not enough — see `ScrollReport.retained`. A chunk
 * of cells [c, c+CHUNK_CELLS) is meshed from samples [c-1, c+CHUNK_CELLS+1],
 * because a surface-net quad reaches one cell back and the corner loop reaches
 * one sample forward, so those are the samples that have to have survived.
 * Two of slack rather than one, because the price of an unnecessary rebuild is
 * a few milliseconds and the price of a missed one is a hole in the ground.
 */
function stillValid(cellX: number, cellZ: number, retained?: Retained): boolean {
  if (!retained) return true;
  const inside = (c: number, lo: number, hi: number): boolean =>
    c - 2 >= lo && c + CHUNK_CELLS + 2 < hi;
  return inside(cellX, retained.x0, retained.x1) && inside(cellZ, retained.z0, retained.z1);
}

interface Pellet {
  mesh: any;
  velocity: any;
  /** Radians per second about each axis, damped with the clod's own speed. */
  spin: any;
  age: number;
}

/**
 * Isolated density-terrain experiment. It deliberately does not share the
 * production voxel mesher, so failures here cannot disturb the main map.
 *
 * The soil is STREAMED: a three-by-three window of tiles is resident and it
 * slides to keep the queen in the middle one. See `TerrainStream` for why the
 * world can then be any size, and `labWorld` for why the tile is 16 mm.
 */
export class DensityTerrainLabScene {
  private readonly scene = new THREE.Scene();
  /*
   * The near plane is 0.1 mm, not 0.25 mm.
   *
   * Nothing closer than it is drawn, so a wall inside that distance is a hole
   * you see the world through. At ant scale that is not a corner case: her bore
   * is four millimetres wide, and measured from inside one the nearest soil was
   * 0.20 mm against a 0.25 mm near plane. The terrain was being clipped away
   * and rendering see-through, which is most of "a lot of camera clipping".
   *
   * The far plane comes in to match so the depth buffer keeps its precision —
   * what matters there is the RATIO, and 1250 mm of range was always far more
   * world than a 320 mm one needs.
   */
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.02, 120);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  private readonly follow: FollowCamera;
  private readonly bore = new BoreRig();
  private readonly raycaster = new THREE.Raycaster();
  private readonly stream: TerrainStream;
  private readonly pellets: Pellet[] = [];
  /**
   * One mesh per chunk of cells, keyed by GLOBAL chunk coordinate.
   *
   * Global, not window-local, and that is the whole reason a scroll is cheap.
   * Keyed locally, every chunk in the window would hold different soil after
   * the window moved and all hundred and forty-four would need remeshing — a
   * second of work to walk sixteen millimetres. Keyed globally, a chunk that
   * is still resident is still correct, and only the arriving third is built.
   *
   * Each mesh remembers the window origin it was built against, because
   * `buildSurfaceNets` emits window-local positions. Origin plus geometry is
   * a world position, so a retained chunk needs no adjustment at all when the
   * window slides out from under it.
   */
  private readonly chunks = new Map<string, any>();
  /**
   * Chunks that meshed to nothing — solid soil or open sky.
   *
   * Remembered, because "has no mesh" and "has not been looked at" are not the
   * same thing and `chunks` cannot tell them apart. Two thirds of the window's
   * 144 chunks hold no surface at all, and without this every one of them was
   * re-meshed on every scroll to conclude the same nothing: the build queue
   * took in more work per scroll than it could finish before the next one and
   * simply never emptied.
   */
  private readonly empties = new Set<string>();
  private readonly pending: Array<[number, number, number]> = [];
  /** The same set as `pending`, for an O(1) "is it already queued". */
  private readonly pendingKeys = new Set<string>();
  private readonly terrainMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f4931, roughness: 0.96, metalness: 0, flatShading: false, side: THREE.FrontSide,
  });
  /**
   * Where the ant IS, as opposed to where she is drawn.
   *
   * Kept as a bare vector rather than read off the model, because the model
   * arrives over the network and may not arrive at all. `QueenModel.load`
   * resolves false on failure by design; if the scene's idea of position lived
   * inside her, a slow connection would mean no walking, no streaming and no
   * digging until she showed up.
   */
  private readonly antPosition: any;
  /**
   * All three castes, standing side by side, one of them driven.
   *
   * A bench rather than a cast list: the gait, the foot solver and the stance
   * are shared code with per-caste measurements fed into them, so a fault that
   * only shows on the major — longer legs, a deeper spine, front legs hung off
   * the head chain — is invisible while only the queen is ever on screen. Being
   * able to hop into each one and walk it over the same ground is the cheapest
   * way to find those.
   *
   * Only ONE ever moves. Everything about locomotion stays exactly where it
   * was, reading `this.queen`, which is now whichever ant you are driving; the
   * other two need no more than a position, a heading and a foot solve.
   */
  private readonly ants: LabAnt[] = CASTES.map((caste) => ({
    caste,
    model: new QueenModel(caste),
    position: new THREE.Vector3(),
    facing: 0,
    ready: false,
  }));
  /*
   * The QUEEN to begin with, because she is the middle of the bench: driving an
   * end one puts the other two off to one side and the follow camera frames
   * whoever you are driving, so two of the three are out of shot on the first
   * frame.
   */
  private driven = CASTES.indexOf('queen');

  /** The ant you are driving. The whole movement core reads this. */
  private get queen(): QueenModel {
    return this.ants[this.driven]!.model;
  }

  private get queenReady(): boolean {
    return this.ants[this.driven]!.ready;
  }
  /** Radians. Her heading, eased toward the direction she is walking. */
  private facing = 0;
  /** Radians per second, for the gait's lean into a turn. */
  private turnRate = 0;
  /** World units per second, for the gait's cadence. Zero when standing. */
  private walkSpeed = 0;
  /** Is she running? The HUD's Run/Crawl toggle. */
  private running = true;
  private get speed(): number {
    return this.running ? WALK_SPEED : WALK_SPEED * CRAWL_FRACTION;
  }
  /** Her actual velocity, eased toward what the pad asks for. */
  private readonly velocity = new THREE.Vector3();
  /** 0..1, decaying. Drives the gait's dig animation after a bite. */
  private digPulse = 0;
  /**
   * The pitch her BODY is actually at, chasing the pitch the rig is set to.
   *
   * Two numbers, deliberately: `bore.pitch` is what the player dialled in and
   * this is where the animal has got to. Conflating them is what made pressing
   * the aim button feel like nothing happened.
   */
  private headPitch = 0;
  private thoraxPitch = 0;
  private gasterPitch = 0;

  /** Her current up axis, eased toward the slope so she does not shiver. */
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** How far the worst foot was under the soil before the last solve. */
  private footPenetration = 0;
  /** How fast she is currently falling, in world units per second. */
  private fallSpeed = 0;
  /** Are her feet off the ground? Set by `stand`; damps her stride. */
  private overHole = false;
  /** For tapping an ant to drive it. */
  private readonly picker = new THREE.Raycaster();
  /** Where each pointer went down, so a tap can be told from a drag. */
  private readonly pressedAt = new Map<number, { x: number; y: number }>();
  /** The tripod walk. Rebuilt when she leaves the ground, null while boring. */
  private gait: TripodGait | null = null;
  /**
   * The climb. While `gripping`, her up is the surface normal, gravity is
   * adhesion, and the walk runs in her own frame — the smooth-surface cousin
   * of the dig room's six-axis SurfaceFrame, fitted to a density field and a
   * tree instead of cube faces.
   */
  private gripping = false;
  private readonly climbUp = new THREE.Vector3(0, 1, 0);
  private readonly climbForward = new THREE.Vector3(0, 0, 1);
  /** The practice tree, public so the smoke test can find it. */
  readonly tree = { x: 0, z: 0, radius: TREE_RADIUS, base: 0, top: 0 };
  /** The point a centimetre ahead that the bore is driving at. */
  private readonly digPoint = new THREE.Vector3();
  /** Where the last bite was centred, and where it sat relative to her then. */
  private readonly lastBite = new THREE.Vector3();
  private lastBiteAhead = 0;
  private lastBiteSideways = 0;
  /** How far the fail-safe had to lift her on the last frame. */
  private guardLift = 0;
  /** Live pointers on the canvas, for look-around and pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private lastPinch = 0;
  /** The floating stick: its element, the thumb driving it, and its throw. */
  private readonly stick = document.createElement('div');
  private readonly stickKnob = document.createElement('div');
  private stickPointer: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickX = 0;
  private stickY = 0;
  private sun: any = null;
  /** What the controls are asking for: steering, throttle and the dig. */
  private readonly input = { yaw: 0, walk: 0, dig: 0 };
  /** The first-person instrument overlay. Fed once a frame from `simulate`. */
  private readonly digHud = new DigHud();
  /** Millimetres of tunnel driven since DIG was last pressed. */
  private dugDistance = 0;
  private wasCutting = false;
  /**
   * Is she committed to a bore? Latched on the first cut and released only
   * when she has come genuinely clear of her own workings.
   *
   * The latch exists because no instantaneous measure survives a SHALLOW
   * bore. `wedged` asks whether her whole body is below the undug land, and
   * four millimetres into a dive it is not — so on the old rule, releasing
   * DIG there meant "level out", and pulling back walked her backwards
   * across the open mound instead of up the hole she was standing in.
   * Measured on the round trip: dug to 12.1 mm, "reversed" to 8.4 —
   * DOWNHILL, away from the shaft, nose flat.
   *
   * While the latch is held her travel and her body keep the bore's pitch,
   * so reverse follows the hole that is already there — however shallow it
   * still is.
   */
  private boreEngaged = false;
  private readonly heldKeys = new Set<string>();
  private animationFrame = 0;
  private previousTime = performance.now();
  private previousFrameStart = performance.now();
  private totalRemoved = 0;
  private lastMeshMs = 0;
  private lastScrollMs = 0;
  private readonly status: HTMLDivElement;
  private readonly digButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private camButton!: HTMLButtonElement;
  private camPanel!: HTMLDivElement;
  /** Redraws for the eye readouts, so a recentre updates all three. */
  private readonly camReads: Array<() => void> = [];
  /** True once the player has moved the eye, so the rig default stops applying. */
  private eyePlaced = false;
  private repaintCamera: (() => void) | null = null;
  private readonly walkButton: HTMLButtonElement;
  private readonly padButtons: HTMLButtonElement[] = [];
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly host: HTMLElement) {
    host.replaceChildren();
    host.classList.add('density-lab-host');

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    // Start in the middle of the world, which is also the only place where the
    // window is not clamped against an edge.
    const start = WORLD_SPAN * 0.5;
    this.stream = new TerrainStream(start, start);

    this.antPosition = new THREE.Vector3(start, streamGroundHeight(start, start), start);
    /*
     * Side by side, across her heading rather than along it, so all three are
     * in frame at once from the follow camera's usual quarter view.
     */
    for (let i = 0; i < this.ants.length; i += 1) {
      const ant = this.ants[i]!;
      const across = (i - (this.ants.length - 1) / 2) * BENCH_SPACING;
      ant.position.set(start + across, streamGroundHeight(start + across, start), start);
      this.scene.add(ant.model.root);
      void ant.model.load().then((ok) => {
        ant.ready = ok;
        if (i === this.driven) this.onDrivenLoaded(ok);
      });
    }
    this.antPosition.copy(this.ants[this.driven]!.position);

    /*
     * The practice tree: a plain cylinder — the shape the climb is easiest to
     * judge against — a short walk ahead-right of the bench. Its collision is
     * analytic rather than part of the density field, so digging cannot eat
     * it and the streaming window owes it nothing.
     */
    this.tree.x = start + 4;
    this.tree.z = start + 9;
    this.tree.base = streamGroundHeight(this.tree.x, this.tree.z);
    this.tree.top = this.tree.base + TREE_HEIGHT;
    const trunkHeight = this.tree.top - this.tree.base + 2;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(TREE_RADIUS, TREE_RADIUS, trunkHeight, 28, 1),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.95 }),
    );
    trunk.name = 'practice-tree';
    trunk.position.set(this.tree.x, this.tree.top - trunkHeight / 2, this.tree.z);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    this.scene.add(trunk);

    (window as unknown as { labScene?: unknown }).labScene = this;

    /*
     * Framing in fractions of the WINDOW, not of the world. The window is what
     * exists; the world is four hundred tiles of formula and putting the camera
     * a fraction of it away would look at soil that is not loaded.
     */
    this.camera.position.set(
      start + WINDOW_SIZE * 0.16, this.antPosition.y + WINDOW_SIZE * 0.2, start + WINDOW_SIZE * 0.3,
    );
    this.follow = new FollowCamera(this.camera, {
      /*
       * Thirty millimetres back — about three body lengths, which frames her
       * and a useful patch of what she is digging.
       *
       * It was a fraction of the WINDOW and came out at 10.6 mm, SHORTER than
       * the 13 mm minimum below it, so the arm was always "too short for third
       * person" and the rig sat in first person from the first frame on open
       * ground. Two numbers describing the same thing in different units, and
       * only one of them was ever looked at.
       */
      distance: 30 / WORLD_UNIT_MM,
      // Beyond her own length, so third person is always a view OF her.
      minDistance: 13 / WORLD_UNIT_MM,
      eyeHeight: 2.4 / WORLD_UNIT_MM,
      maxDistance: 60 / WORLD_UNIT_MM,
      clearance: CAMERA_CLEARANCE,
      ease: 6,
    });
    this.follow.target.copy(this.antPosition).addScaledVector(this.up, CAMERA_LOOK_AT);
    this.bindCamera();

    this.scene.background = new THREE.Color(0x8db4d6);
    /*
     * Fog reaches the window edge on purpose. Loaded soil stops at a flat cut
     * face between 16 and 32 mm out, and it is a real edge — there is nothing
     * behind it to draw. Fading into it costs nothing and reads as distance
     * rather than as the map running out.
     */
    /*
     * Fog begins beyond anywhere the camera can get to, and that is the point
     * of the numbers. It used to start at 0.42 of the window — 20 mm — while
     * the orbit reaches out to 30, so soil a few millimetres past her was
     * already a third faded and a shadowed pit floor came out as a pool of
     * sky blue sitting in the crater. Starting past `maxDistance` leaves the
     * fog doing the one job it is for: softening the cut face where the loaded
     * window stops.
     */
    this.scene.fog = new THREE.Fog(0x8db4d6, WINDOW_SIZE * 0.75, WINDOW_SIZE * 1.5);
    this.addLighting();

    const hud = document.createElement('div');
    hud.className = 'density-lab-hud';
    hud.innerHTML = `
      <div class="density-lab-title">DENSITY TERRAIN LAB <span>${BITE_WIDTH_MM} mm bite · ${BITE_DEPTH_MM} mm deep</span></div>
      <div class="density-lab-status"></div>
      <div class="density-lab-hint">Hold DIG and she bores where you look · drag to look and aim · the pad walks · RUN toggles pace</div>
      <div class="density-lab-actions"></div>
    `;
    host.appendChild(hud);
    host.appendChild(this.digHud.root);

    const status = hud.querySelector<HTMLDivElement>('.density-lab-status');
    const actions = hud.querySelector<HTMLDivElement>('.density-lab-actions');
    if (!status || !actions) {
      throw new Error('Density terrain lab HUD failed to initialize');
    }
    this.status = status;

    /*
     * The dig is HELD, like the dig room's: down is cutting, up is stopped.
     * There is no aim control here any more \u2014 in first person the look is
     * the aim, which is the whole simplification asked for.
     */
    this.digButton = document.createElement('button');
    this.digButton.className = 'density-lab-button density-lab-dig';
    this.digButton.textContent = 'DIG';
    this.digButton.setAttribute('aria-label', 'Hold to dig where she is looking');
    actions.appendChild(this.digButton);

    this.walkButton = document.createElement('button');
    this.walkButton.className = 'density-lab-button density-lab-walk';
    this.walkButton.textContent = 'RUN';
    this.walkButton.setAttribute('aria-label', 'Switch between running and crawling');
    this.walkButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.running = !this.running;
      this.walkButton.textContent = this.running ? 'RUN' : 'CRAWL';
      this.updateStatus();
    });
    actions.appendChild(this.walkButton);

    this.buildCameraPanel(hud, actions);

    this.resetButton = document.createElement('button');
    this.resetButton.className = 'density-lab-button density-lab-reset';
    this.resetButton.textContent = 'RESET';
    actions.appendChild(this.resetButton);

    this.buildStick(hud);
    this.digButton.addEventListener('pointerdown', this.onDigDown);
    this.digButton.addEventListener('pointerup', this.onDigUp);
    this.digButton.addEventListener('pointercancel', this.onDigUp);
    this.digButton.addEventListener('pointerleave', this.onDigUp);
    this.resetButton.addEventListener('click', this.resetTerrain);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.refreshResidency(true);
    // Without this the readout is empty until something happens, which is both
    // unhelpful and the reason the walk smoke could not tell where it started.
    this.updateStatus();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onCameraDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onCameraMove);
    this.renderer.domElement.removeEventListener('pointerup', this.onCameraUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.onCameraUp);
    this.renderer.domElement.removeEventListener('wheel', this.onCameraWheel);
    this.digButton.removeEventListener('pointerdown', this.onDigDown);
    this.digButton.removeEventListener('pointerup', this.onDigUp);
    this.digButton.removeEventListener('pointercancel', this.onDigUp);
    this.digButton.removeEventListener('pointerleave', this.onDigUp);
    this.resetButton.removeEventListener('click', this.resetTerrain);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.empties.clear();
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.terrainMaterial.dispose();
    this.queen.dispose();
    for (const pellet of this.pellets) {
      pellet.mesh.geometry.dispose();
      if (pellet.mesh.material instanceof THREE.Material) pellet.mesh.material.dispose();
    }
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  /**
   * The real floating stick, the same one the main room uses.
   *
   * Four buttons in a cross is not a joystick: it has no magnitude, no
   * diagonals, and your thumb has to find a specific 46-pixel square while
   * watching something else. This spawns under the thumb wherever the left of
   * the screen is touched, clamped into the lower-left so it cannot appear
   * beside the HUD or halfway up the display, and reports a vector.
   *
   * Shared with the main room down to `stickVector` and `clampStickOrigin`, so
   * the feel of driving an ant is one implementation rather than two that
   * drift apart.
   */
  /**
   * The camera settings: which view, and exactly where the first-person eye
   * sits on her.
   *
   * The eye is nudged rather than typed because there is no number anybody can
   * derive for "on the queen's head" — it depends on the model, on how much of
   * her you want in shot, and on taste. Nudging while looking at the result is
   * the only way to find it, and it is saved so the answer only has to be found
   * once.
   */
  private buildCameraPanel(hud: HTMLElement, actions: HTMLElement): void {
    this.camButton = document.createElement('button');
    this.camButton.className = 'density-lab-button density-lab-cam';
    this.camButton.textContent = 'CAM';
    this.camButton.setAttribute('aria-label', 'Camera settings');
    this.camButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.camPanel.classList.toggle('is-open');
    });
    actions.appendChild(this.camButton);

    this.camPanel = document.createElement('div');
    this.camPanel.className = 'density-lab-cam-panel';

    const modeRow = document.createElement('button');
    modeRow.className = 'density-lab-cam-mode';
    const paintMode = (): void => {
      const label: Record<CameraMode, string> = {
        first: 'FIRST PERSON',
        auto: 'FIRST UNDER · THIRD ABOVE',
        third: 'THIRD PERSON',
      };
      modeRow.textContent = label[this.follow.mode];
    };
    modeRow.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const order: CameraMode[] = ['auto', 'first', 'third'];
      const next = order[(order.indexOf(this.follow.mode) + 1) % order.length]!;
      this.follow.mode = next;
      paintMode();
      this.saveCameraPrefs();
    });
    this.camPanel.appendChild(modeRow);

    /*
     * Three axes, in HER frame and labelled the way you would think about
     * them rather than by coordinate: across her, up her, and along her nose.
     */
    const axes: Array<[string, 'x' | 'y' | 'z', string]> = [
      ['SIDE', 'x', 'left and right across her'],
      ['RISE', 'y', 'up and down'],
      ['FWD', 'z', 'forward and back along her nose'],
    ];
    for (const [label, axis, hint] of axes) {
      const row = document.createElement('div');
      row.className = 'density-lab-cam-row';
      const name = document.createElement('span');
      name.className = 'density-lab-cam-name';
      name.textContent = label;
      const read = document.createElement('span');
      read.className = 'density-lab-cam-read';
      const paint = (): void => {
        read.textContent = `${(this.follow.eye[axis] * WORLD_UNIT_MM).toFixed(1)} mm`;
      };
      paint();
      this.camReads.push(paint);
      row.appendChild(name);
      for (const step of [-1, 1]) {
        const key = document.createElement('button');
        key.className = 'density-lab-cam-key';
        key.textContent = step < 0 ? '−' : '+';
        key.setAttribute('aria-label', `Move the eye ${step < 0 ? 'back' : 'forward'} ${hint}`);
        key.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          this.follow.eye[axis] = THREE.MathUtils.clamp(
            this.follow.eye[axis] + step * EYE_NUDGE, -EYE_RANGE, EYE_RANGE,
          );
          paint();
          this.eyePlaced = true;
          this.saveCameraPrefs();
        });
        row.appendChild(key);
      }
      row.appendChild(read);
      this.camPanel.appendChild(row);
    }

    const centre = document.createElement('button');
    centre.className = 'density-lab-cam-mode';
    centre.textContent = 'RECENTRE EYE';
    centre.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.eyePlaced = false;
      this.seatEyeOnHead();
      this.eyePlaced = true;
      this.saveCameraPrefs();
    });
    this.camPanel.appendChild(centre);

    paintMode();
    hud.appendChild(this.camPanel);
    this.repaintCamera = () => { paintMode(); for (const p of this.camReads) p(); };
    this.loadCameraPrefs();
    this.repaintCamera();
  }

  /**
   * Put the eye on her HEAD, from the rig.
   *
   * The default used to be a pair of constants, and they sat her camera in the
   * middle of her own thorax: the first-person shot was a wall of her legs
   * swinging past the lens. "On the head" is a different offset for every caste
   * and cannot be one number, so it is read off the mouth bone — and only when
   * the player has not already placed the eye themselves, since a saved
   * placement is a decision and this is only a starting guess.
   */
  private seatEyeOnHead(): void {
    if (this.eyePlaced || !this.queenReady) return;
    const head = this.queen.headOffset();
    if (!head) return;
    this.follow.eye.set(head[0], head[1], head[2]);
    this.repaintCamera?.();
  }

  private saveCameraPrefs(): void {
    try {
      window.localStorage.setItem(CAMERA_PREFS, JSON.stringify({
        mode: this.follow.mode,
        eye: [this.follow.eye.x, this.follow.eye.y, this.follow.eye.z],
      }));
    } catch {
      // A browser with storage denied is not a reason to lose the camera.
    }
  }

  private loadCameraPrefs(): void {
    try {
      const raw = window.localStorage.getItem(CAMERA_PREFS);
      if (!raw) return;
      const saved = JSON.parse(raw) as { mode?: CameraMode; eye?: number[] };
      if (saved.mode === 'first' || saved.mode === 'auto' || saved.mode === 'third') {
        this.follow.mode = saved.mode;
      }
      const eye = saved.eye;
      if (Array.isArray(eye) && eye.length === 3 && eye.every((n) => Number.isFinite(n))) {
        this.follow.eye.set(
          THREE.MathUtils.clamp(eye[0]!, -EYE_RANGE, EYE_RANGE),
          THREE.MathUtils.clamp(eye[1]!, -EYE_RANGE, EYE_RANGE),
          THREE.MathUtils.clamp(eye[2]!, -EYE_RANGE, EYE_RANGE),
        );
        this.eyePlaced = true;
      }
    } catch {
      // Corrupt settings are the same as no settings.
    }
  }

  private buildStick(hud: HTMLElement): void {
    this.stick.className = 'density-lab-stick';
    this.stickKnob.className = 'density-lab-stick-knob';
    this.stick.appendChild(this.stickKnob);
    hud.appendChild(this.stick);
  }

  private showStick(live: boolean): void {
    this.stick.classList.toggle('is-live', live);
    if (!live) return;
    this.stick.style.left = `${this.stickOrigin.x}px`;
    this.stick.style.top = `${this.stickOrigin.y}px`;
    this.stickKnob.style.transform =
      `translate(-50%, -50%) translate(${this.stickX * STICK_RADIUS}px, ${this.stickY * STICK_RADIUS}px)`;
  }

  /**
   * The dig control is HELD — the second specification of it, made after
   * playing both. The latch was asked for first, because hold-to-dig fought
   * the joystick when both hands did continuous work; then the dig room
   * shipped with press-to-dig where the button IS the drive, and it played
   * better. With the button doing the advancing there is nothing left for
   * the other hand to hold, and the objection dissolved.
   */
  private readonly onDigDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.input.dig = 1;
  };

  private readonly onDigUp = (): void => {
    this.input.dig = 0;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === 'Space') {
      event.preventDefault();
      this.input.dig = 1;
      return;
    }
    // Pitch steps on the press, not on the hold: ten degrees a tap.
    if (event.code === 'ArrowUp' || event.code === 'KeyQ') { this.bore.aim(1); this.updateStatus(); return; }
    if (event.code === 'ArrowDown' || event.code === 'KeyE') { this.bore.aim(-1); this.updateStatus(); return; }
    if (event.key.toLowerCase() === 'r') {
      this.resetTerrain();
      return;
    }
    if (event.key.toLowerCase() === 'f') {
      this.running = !this.running;
      this.updateStatus();
      return;
    }
    this.heldKeys.add(event.code);
    this.applyHeldKeys();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      this.input.dig = 0;
      return;
    }
    this.heldKeys.delete(event.code);
    this.applyHeldKeys();
  };

  private applyHeldKeys(): void {
    const held = (...codes: string[]): boolean => codes.some((code) => this.heldKeys.has(code));
    /*
     * Steering is inverted from the obvious spelling, and this is the sign that
     * was wrong.
     *
     * Forward is (sin h, 0, cos h), so a rising heading swings her from +Z
     * toward +X. With the camera behind her looking along +Z, +X is on the
     * LEFT of the screen — so "steer right" turned her left, and it took
     * driving her to notice, because the arithmetic is perfectly consistent
     * and merely the mirror of what a player means.
     */
    this.input.yaw = (held('KeyA') ? 1 : 0) - (held('KeyD') ? 1 : 0);
    this.input.walk = (held('KeyW') ? 1 : 0) - (held('KeyS') ? 1 : 0);
  }

  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight(0xc9e6ff, 0x4a2f1f, 1.65);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xfff1ce, 3.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    /*
     * The shadow camera follows the ant rather than sitting over a fixed
     * world box: at 320 mm the map is a hundred times the area a 1024 map can
     * cover usefully, and a world-sized frustum would put a shadow texel at
     * about a third of a millimetre — coarser than the bite it is meant to
     * show. Sized to the window, a texel is ten microns.
     */
    const extent = WINDOW_SIZE * 0.6;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.far = WINDOW_SIZE * 3;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
  }

  /**
   * Bring the resident chunk set in line with the window.
   *
   * Anything outside is dropped immediately — it costs memory and it would
   * draw soil the window no longer describes. Anything missing is QUEUED
   * rather than built, except on the first call, where there is no frame to
   * protect and an empty scene would have nothing to raycast against.
   */
  private refreshResidency(immediate = false, retained?: Retained): void {
    const started = performance.now();
    const cx0 = this.stream.originCellX;
    const cz0 = this.stream.originCellZ;
    const wanted = new Set<string>();

    for (let z = 0; z < WINDOW_CELLS; z += CHUNK_CELLS)
      for (let y = 0; y < CELLS_Y; y += CHUNK_CELLS)
        for (let x = 0; x < WINDOW_CELLS; x += CHUNK_CELLS) {
          const gx = (cx0 + x) / CHUNK_CELLS;
          const gy = y / CHUNK_CELLS;
          const gz = (cz0 + z) / CHUNK_CELLS;
          const key = `${gx},${gy},${gz}`;
          wanted.add(key);
          const known = this.chunks.has(key) || this.empties.has(key);
          if (known && stillValid(x, z, retained)) continue;
          if (immediate) this.buildChunk(gx, gy, gz);
          else this.enqueue(gx, gy, gz);
        }

    for (const [key, mesh] of this.chunks) {
      if (wanted.has(key)) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.chunks.delete(key);
    }
    // Forget empties that have left, or the set grows with every tile walked.
    for (const key of this.empties) if (!wanted.has(key)) this.empties.delete(key);
    // A queued chunk that has already scrolled back out is work nobody wants.
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const entry = this.pending[i];
      if (!entry) continue;
      const key = `${entry[0]},${entry[1]},${entry[2]}`;
      if (wanted.has(key)) continue;
      this.pending.splice(i, 1);
      this.pendingKeys.delete(key);
    }
    /*
     * Nearest first. A diagonal scroll queues about eighty chunks and the
     * queue drains over a second or so, so the ORDER decides whether the soil
     * that fills in last is under her feet or out at the fog line.
     * Queued in raster order it was the former, which is the one place a gap
     * is unmissable.
     */
    const sx = this.antPosition.x / (CHUNK_CELLS * CELL_SIZE);
    const sz = this.antPosition.z / (CHUNK_CELLS * CELL_SIZE);
    this.pending.sort((a, b) =>
      ((a[0] - sx) ** 2 + (a[2] - sz) ** 2) - ((b[0] - sx) ** 2 + (b[2] - sz) ** 2));
    if (immediate) this.lastMeshMs = performance.now() - started;
  }

  /** Work through the queue until the frame budget runs out. */
  private drainPending(frameMs: number): void {
    if (this.pending.length === 0) return;
    const budget = Math.min(
      BUILD_CEILING_MS, Math.max(BUILD_FLOOR_MS, frameMs * BUILD_SHARE),
    );
    const started = performance.now();
    let built = 0;
    while (this.pending.length > 0 && performance.now() - started < budget) {
      const next = this.pending.shift();
      if (!next) break;
      this.pendingKeys.delete(`${next[0]},${next[1]},${next[2]}`);
      this.buildChunk(next[0], next[1], next[2]);
      built += 1;
    }
    if (built > 0) {
      this.lastMeshMs = performance.now() - started;
      this.updateStatus();
    }
  }

  /**
   * Mesh one chunk, addressed in GLOBAL chunk coordinates.
   *
   * The mesher works in window-local cells, so the chunk is translated in and
   * the resulting geometry is placed back out by the window origin. That
   * offset is baked into the mesh's position at build time and never touched
   * again — which is exactly what lets a scroll leave retained chunks alone.
   */
  private buildChunk(gx: number, gy: number, gz: number): void {
    const key = `${gx},${gy},${gz}`;
    const x0 = gx * CHUNK_CELLS - this.stream.originCellX;
    const z0 = gz * CHUNK_CELLS - this.stream.originCellZ;
    const y0 = gy * CHUNK_CELLS;
    const data = buildSurfaceNets(this.stream.field, 0, {
      x0, y0, z0, x1: x0 + CHUNK_CELLS, y1: y0 + CHUNK_CELLS, z1: z0 + CHUNK_CELLS,
    });
    const existing = this.chunks.get(key);
    // No surface in this chunk: solid soil or open sky, and neither is drawn.
    if (data.indices.length === 0) {
      this.empties.add(key);
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        this.chunks.delete(key);
      }
      return;
    }
    this.empties.delete(key);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = existing ?? new THREE.Mesh(geometry, this.terrainMaterial);
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
    }
    mesh.position.set(this.stream.originWorldX, 0, this.stream.originWorldZ);
    if (!existing) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `density-chunk-${key}`;
      this.scene.add(mesh);
      this.chunks.set(key, mesh);
    }
  }

  /**
   * Rebuild the chunks a bite touched, from window-local sample bounds.
   *
   * `bounds` arrives in SAMPLE indices and a sample is a cell corner, so a
   * changed sample at index i is shared by cells i-1 and i — hence the extra
   * cell of slack on the low side. Miss it and the chunk holding the far half
   * of the bite keeps its old surface, which reads as the dig only working on
   * one side of the crosshair.
   */
  /**
   * Rebuild every resident chunk from scratch.
   *
   * Only the smoke test uses it, to remesh after carving the field directly
   * instead of through a bite. It is public for that reason and no other.
   */
  rebuildTerrainForTest(): void {
    for (const [, mesh] of this.chunks) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.empties.clear();
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.refreshResidency(true);
  }

  private rebuildAround(bounds: {
    minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  }): void {
    const lo = (v: number) => Math.floor(Math.max(0, v - 1) / CHUNK_CELLS);
    const hi = (v: number, cells: number) => Math.floor(Math.min(cells - 1, v) / CHUNK_CELLS);
    const baseX = this.stream.originCellX / CHUNK_CELLS;
    const baseZ = this.stream.originCellZ / CHUNK_CELLS;
    for (let cz = lo(bounds.minZ); cz <= hi(bounds.maxZ, WINDOW_CELLS); cz += 1)
      for (let cy = lo(bounds.minY); cy <= hi(bounds.maxY, CELLS_Y); cy += 1)
        for (let cx = lo(bounds.minX); cx <= hi(bounds.maxX, WINDOW_CELLS); cx += 1)
          this.enqueue(baseX + cx, cy, baseZ + cz);
    this.updateStatus();
  }

  /**
   * Queue a chunk for remeshing, at most once.
   *
   * Bites used to remesh on the spot, which is twenty milliseconds of meshing
   * inside the tap handler — a whole frame, per bite, before anything else can
   * happen. Sustained digging measured at 1.94 seconds of blocked main thread
   * over 150 bites, felt as the controls locking up for a couple of seconds
   * after a burst.
   *
   * Queued, the same eight chunks touched by ten rapid bites are meshed ONCE,
   * inside the frame budget the streamer already respects. The crater lands a
   * frame or two late, which nobody can see, instead of the input freezing,
   * which everybody can.
   */
  private enqueue(gx: number, gy: number, gz: number): void {
    const key = `${gx},${gy},${gz}`;
    if (this.pendingKeys.has(key)) return;
    this.pendingKeys.add(key);
    this.pending.push([gx, gy, gz]);
  }

  private readonly resetTerrain = (): void => {
    this.stream.reset();
    this.totalRemoved = 0;
    for (const pellet of this.pellets) {
      this.scene.remove(pellet.mesh);
      pellet.mesh.geometry.dispose();
      if (pellet.mesh.material instanceof THREE.Material) pellet.mesh.material.dispose();
    }
    this.pellets.length = 0;
    for (const [, mesh] of this.chunks) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.empties.clear();
    this.pending.length = 0;
    this.pendingKeys.clear();
    this.refreshResidency(true);
  };

  /**
   * Bite along the bore, from her jaws.
   *
   * No raycast and no crosshair. The direction is the one the rig is steering
   * — her heading, pitched by however far the player has aimed up or down —
   * expressed in HER frame, so on a slope or in a tunnel "down ten degrees"
   * means ten degrees off the floor she is standing on rather than off the
   * world's horizontal.
   *
   * Aiming with the camera was the old way and it is the wrong tool for a
   * tunnel: the same tap gave a different hole depending on where the view had
   * last been dragged, so a bore wandered with the player's attention. It also
   * cost a raycast against a quarter of a million triangles on every bite.
   */
  private carveAlongBore(pitch: number): void {
    const jaws = new THREE.Vector3();
    if (!this.queenReady || !this.queen.jawPosition(jaws)) return;

    const up = this.up.clone().normalize();
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    forward.addScaledVector(up, -forward.dot(up));
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    const direction = forward.clone().multiplyScalar(Math.cos(pitch))
      .addScaledVector(up, Math.sin(pitch)).normalize();

    /*
     * The bore aims at a POINT a centimetre ahead, and the bite is taken along
     * the line to it. Same direction as her travel, by construction, because
     * both are derived from the one target — which is the whole reason for
     * having a target rather than two angles that are supposed to match.
     */
    this.digPoint.copy(jaws).addScaledVector(direction, DIG_POINT_AHEAD);

    /*
     * The aimed line first, then steeper, and steeper again — never straight
     * down.
     *
     * Her mouthparts sit above her feet, so a LEVEL ray from them never meets
     * level ground and a stroke on the flat found nothing to bite. Dropping
     * back to straight down fixed that and broke something better: the crater
     * opened underneath her instead of in front. Sweeping the PITCH keeps every
     * attempt pointing where she is going.
     */
    let surface = null;
    for (const extra of BORE_SWEEP) {
      const tilted = forward.clone().multiplyScalar(Math.cos(pitch + extra))
        .addScaledVector(up, Math.sin(pitch + extra)).normalize();
      surface = this.firstSoilFromJaws(jaws, tilted, JAW_REACH);
      if (!surface) continue;
      direction.copy(tilted);
      break;
    }
    if (!surface) {
      this.status.dataset.message = 'Nothing in reach of her jaws';
      this.updateStatus();
      return;
    }

    /*
     * The brush RIDES the surface and only dips in by BITE_DEPTH. Sinking the
     * centre below the hit buries most of the sphere and the crater ends up as
     * deep as the centre plus the whole radius. A mandible does not do that;
     * it scrapes.
     */
    const center = surface.clone().addScaledVector(direction, BITE_DEPTH - BRUSH_RADIUS);
    const result = this.stream.subtractSphere(center, BRUSH_RADIUS);
    if (result.changedSamples === 0 || result.removedVolume <= 0.0001) return;

    this.totalRemoved += result.removedVolume;
    this.lastBite.copy(center);
    /*
     * Where the bite landed RELATIVE TO HER, recorded now rather than worked
     * out later. She creeps forward while boring, so a few seconds after the
     * fact the crater is behind her — measured at 2.27 mm behind her centre,
     * which reads as digging underneath herself and is really just her having
     * walked past her own work.
     */
    this.lastBiteAhead = (center.x - this.antPosition.x) * forward.x
      + (center.z - this.antPosition.z) * forward.z;
    this.lastBiteSideways = (center.x - this.antPosition.x) * forward.z
      - (center.z - this.antPosition.z) * forward.x;
    this.rebuildAround(result.bounds);
    /*
     * Spoil goes BACKWARD, over her shoulder. Straight back out of the hole is
     * toward her own face — the bite direction runs from her jaws into the
     * soil, so its negation points at her head and the clods spawned inside
     * her thorax and flew through her. It is also what an ant does with it:
     * the load goes back under the body and out behind.
     */
    const toss = up.clone().multiplyScalar(1.1)
      .addScaledVector(forward, -0.9).normalize();
    this.spawnPellet(surface, toss, result.removedVolume);
    /*
     * Reported in millimetres, because that is the unit the size argument is
     * being had in. A conservation-true clod holding what a 4 mm x 0.5 mm
     * scrape removes comes out around 2 mm across, against the 0.8 mm the brief
     * asks for — and 0.8 mm only holds a tenth of a bite. Putting the number on
     * screen is the cheapest way to settle which of the two gives.
     */
    const clodMm = Math.cbrt(result.removedVolume / PELLET_SOLIDITY)
      * 2 * WORLD_UNIT_MM * CLOD_DISPLAY_SCALE;
    this.status.dataset.message =
      `${(result.removedVolume * WORLD_UNIT_MM ** 3).toFixed(2)} mm³ freed · ${clodMm.toFixed(2)} mm clod`;
    this.updateStatus();
  }

  private spawnPellet(point: any, localNormal: any, volume: number): void {
    if (this.pellets.length >= MAX_PELLETS) {
      const oldest = this.pellets.shift();
      if (oldest) {
        this.scene.remove(oldest.mesh);
        oldest.mesh.geometry.dispose();
        if (oldest.mesh.material instanceof THREE.Material) oldest.mesh.material.dispose();
      }
    }

    /*
     * Sized so the pellet HOLDS the soil that was removed — by the volume of
     * the solid it is actually drawn as, not by a sphere it is not. One number
     * travels: brush geometry decides removed volume, removed volume decides
     * pellet size, and nothing else gets a vote.
     */
    const radius = THREE.MathUtils.clamp(
      Math.cbrt(volume / PELLET_SOLIDITY), 0.004, 0.4,
    ) * CLOD_DISPLAY_SCALE;
    /*
     * A knobbly lump, not a drum.
     *
     * This was `CylinderGeometry(r, 0.92r, 1.45r, 8)` — an octagonal tube,
     * and it read as exactly that. Twenty flat triangles under flat shading is
     * already closer to a chip of earth than anything round; roughening each
     * corner breaks the symmetry so no two clods are the same lump.
     *
     * The shape comes from `clodGeometry` and is INDEXED, which was the fix for
     * clods that looked fractured rather than solid. Three.js builds its
     * platonic solids non-indexed — sixty vertices for twelve corners — so
     * roughening by vertex index moved the five copies of every corner
     * independently and the faces pulled away from each other.
     */
    const clod = clodGeometry(this.pellets.length + volume * 1e4);
    const positions = new Float32Array(clod.positions.length);
    for (let i = 0; i < clod.positions.length; i += 1) positions[i] = clod.positions[i]! * radius;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(clod.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0x81583a,
      roughness: 1,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // Chunk meshes are translated but not rotated, so a face normal is already
    // in world space; the identity keeps the call honest if that ever changes.
    const normal = localNormal.clone().transformDirection(new THREE.Matrix4());
    // Clear of her body to begin with. The bite happens at her mouthparts, so
    // a pellet spawned at the surface starts inside her head.
    mesh.position.copy(point).addScaledVector(normal, radius * 2.2);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.volume = volume;
    this.scene.add(mesh);

    this.pellets.push({
      mesh,
      /*
       * The deliberate toss dominates, and the jitter only breaks the
       * symmetry. It was the other way round — a weak toss under a strong
       * random pop upward — which carried a clod less than two millimetres
       * back before gravity took it, so a nine-millimetre ant was still
       * standing in it. She has to throw the spoil clear of herself.
       */
      velocity: normal.multiplyScalar(2.8).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.6,
        0.7 + Math.random() * 0.5,
        (Math.random() - 0.5) * 0.6,
      )),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 9,
        (Math.random() - 0.5) * 9,
        (Math.random() - 0.5) * 9,
      ),
      age: 0,
    });
  }

  private updatePellets(delta: number): void {
    for (const pellet of this.pellets) {
      pellet.age += delta;
      pellet.velocity.y -= 9.5 * delta;
      pellet.mesh.position.addScaledVector(pellet.velocity, delta);

      /*
       * A clod tumbles because it is MOVING, and stops when it stops.
       *
       * The spin used to be a constant added every frame regardless, so a
       * pellet that had come to rest on the ground went on rotating on the
       * spot forever — a field of dirt spinning quietly in place. Tying the
       * tumble to the velocity means it slows as the clod slows and ends when
       * it lands, and it costs nothing: the number was always available.
       */
      pellet.mesh.rotation.x += pellet.spin.x * delta;
      pellet.mesh.rotation.y += pellet.spin.y * delta;
      pellet.mesh.rotation.z += pellet.spin.z * delta;

      const radius = (pellet.mesh.geometry.boundingSphere?.radius ?? 0.35) * 0.55;
      const floorY = this.groundAt(
        pellet.mesh.position.x, pellet.mesh.position.z, pellet.mesh.position.y + radius,
      ) + radius;
      if (pellet.mesh.position.y < floorY) {
        pellet.mesh.position.y = floorY;
        if (Math.abs(pellet.velocity.y) > 0.22) pellet.velocity.y *= -0.28;
        else pellet.velocity.y = 0;
        pellet.velocity.x *= 0.82;
        pellet.velocity.z *= 0.82;
        // Landing scrubs the tumble off much faster than flight does; earth
        // does not skate.
        pellet.spin.multiplyScalar(0.55);
      }

      // Tumble tracks speed, and both are allowed to reach exactly zero rather
      // than decaying toward it forever.
      const speed = pellet.velocity.length();
      if (speed < 0.02) {
        pellet.velocity.set(0, 0, 0);
        pellet.spin.set(0, 0, 0);
      } else {
        pellet.spin.multiplyScalar(Math.min(1, speed / (speed + delta * 6)));
      }
    }
  }

  /**
   * Height of packed soil at a world position, read from the RESIDENT field
   * rather than from the formula, so the queen and the pellets drop into holes
   * that have actually been dug. Falls back to the formula outside the window,
   * where by construction nothing has been dug anyway.
   */
  private groundAt(worldX: number, worldZ: number, fromY = Infinity): number {
    const x = worldX - this.stream.originWorldX;
    const z = worldZ - this.stream.originWorldZ;
    const span = WINDOW_CELLS * CELL_SIZE;
    if (x < 0 || x > span || z < 0 || z > span) return streamGroundHeight(worldX, worldZ);

    /*
     * The floor BELOW a height, not the top of the world.
     *
     * This used to scan from the sky down and return the first soil it met,
     * which is the right answer exactly once: on open ground, before anybody
     * has dug anything. Stand in a burrow and the topmost soil at your own x
     * and z is the RIM, several millimetres over your head — so the stance
     * thought she was buried, the fail-safe agreed, and it heaved her three
     * millimetres straight up out of the hole she had just dug. Reported as
     * not being able to keep her down in it, and it was the same query
     * answering the same wrong question for the body, the feet and the guard
     * all at once.
     *
     * `fromY` is a step height, not a technicality. Scanning from the ant's
     * own head rather than from the sky is what lets a floor exist under a
     * ceiling; scanning from a little ABOVE her is what still lets her walk up
     * a rise, because ground she could step onto has to be findable.
     */
    /*
     * The treetop is a floor, but only when asked from up there. Asked from
     * the base, the honest answer is the soil — the trunk overhead is a
     * ceiling, not ground she could be standing on.
     */
    const lid = this.treeLid(worldX, worldZ, fromY);
    if (lid !== null) return lid;

    const top = CELLS_Y;
    const start = Math.max(0, Math.min(top, Math.ceil(fromY / CELL_SIZE)));
    let neighbour = this.stream.field.sample(x, start * CELL_SIZE, z);

    /*
     * Starting inside solid soil means climbing out of it. Without this, a
     * probe that begins buried finds the floor of whatever chamber lies below
     * and reports it as the ground, which drops her through the world.
     */
    if (neighbour > 0) {
      /*
       * Climbing out is a STEP, not a swim to the surface.
       *
       * Unbounded, this scanned until the soil ran out — and in the wall of a
       * shaft that is the open sky above the mound, so a foot a fraction of a
       * millimetre into the wall was told its ground was ten millimetres over
       * its head. That is the whole of the 15 mm foot reading, and the solver
       * believed it and dragged her legs up after it.
       *
       * If the soil does not end within a step, nothing here is standable, and
       * the honest answer is the height that was asked about: no lift, leave
       * the limb where the gait put it. The blunt fail-safe still owns the case
       * where she is genuinely buried — that is what it is for.
       */
      const reach = Math.min(top, start + Math.ceil(STEP_UP / CELL_SIZE));
      for (let y = start + 1; y <= reach; y += 1) {
        const here = this.stream.field.sample(x, y * CELL_SIZE, z);
        if (here <= 0) return (y - 1 + neighbour / (neighbour - here)) * CELL_SIZE;
        neighbour = here;
      }
      return fromY === Infinity ? top * CELL_SIZE : fromY;
    }

    /*
     * The crossing is INTERPOLATED, not the top of the last solid cell.
     *
     * Snapping to a cell quantises her feet to a quarter of a millimetre and a
     * bite is half a millimetre deep, so standing in a fresh crater she would
     * drop in two visible steps — or not at all, if the scrape happened to take
     * less than one cell. The surface is DRAWN at the zero crossing, so that is
     * the height to stand at, and `sample` gives it bilinearly across x and z
     * as well rather than snapping her to the nearest column.
     */
    for (let y = start - 1; y >= 0; y -= 1) {
      const here = this.stream.field.sample(x, y * CELL_SIZE, z);
      if (here > 0) return (y + here / (here - neighbour)) * CELL_SIZE;
      neighbour = here;
    }
    return 0;
  }

  /**
   * March out from her jaws along a direction and return the first packed soil
   * within reach, or null. Half-cell steps, so nothing thinner than a bite can
   * be stepped over.
   */
  private firstSoilFromJaws(jaws: any, direction: any, reach: number): any {
    const probe = new THREE.Vector3();
    const steps = Math.ceil(reach / (CELL_SIZE * 0.5));
    for (let i = 0; i <= steps; i += 1) {
      probe.copy(jaws).addScaledVector(direction, (i / steps) * reach);
      if (this.solidAt(probe)) return probe.clone();
    }
    return null;
  }

  /** Is this world point inside packed soil? */
  solidAt(point: any): boolean {
    const x = point.x - this.stream.originWorldX;
    const z = point.z - this.stream.originWorldZ;
    const span = WINDOW_CELLS * CELL_SIZE;
    if (x < 0 || x > span || z < 0 || z > span) return false;
    if (point.y < 0 || point.y > CELLS_Y * CELL_SIZE) return false;
    return this.stream.field.sample(x, point.y, z) > 0;
  }

  /** The signed density at a world point, for the gradient. Air outside. */
  private densityAt(x: number, y: number, z: number): number {
    const lx = x - this.stream.originWorldX;
    const lz = z - this.stream.originWorldZ;
    const span = WINDOW_CELLS * CELL_SIZE;
    if (lx < 0 || lx > span || lz < 0 || lz > span) return -1;
    if (y < 0 || y > CELLS_Y * CELL_SIZE) return -1;
    return this.stream.field.sample(lx, y, lz);
  }

  /** Is this world point inside the tree's trunk? */
  private treeSolidAt(point: THREE.Vector3): boolean {
    const dx = point.x - this.tree.x;
    const dz = point.z - this.tree.z;
    return dx * dx + dz * dz <= this.tree.radius * this.tree.radius
      && point.y <= this.tree.top && point.y >= 0;
  }

  /**
   * Everything a body can press against: the soil, and the tree. The climb,
   * the camera and the fail-safe all ask THIS, so a trunk is as real to them
   * as a bank of soil — which is the whole of what makes it climbable.
   */
  barrierAt(point: THREE.Vector3): boolean {
    return this.solidAt(point) || this.treeSolidAt(point);
  }

  /** The treetop as a floor — see `groundAt`. Null when it does not apply. */
  private treeLid(x: number, z: number, fromY: number): number | null {
    const dx = x - this.tree.x;
    const dz = z - this.tree.z;
    if (dx * dx + dz * dz > this.tree.radius * this.tree.radius) return null;
    if (fromY < this.tree.top - STEP_UP) return null;
    return this.tree.top;
  }

  /**
   * The outward normal of whatever `barrierAt` said was there.
   *
   * The soil answers through its density gradient — the field's own idea of
   * its surface. The tree is analytic: radial off the bark, up off the lid.
   * Soil wins where both could answer, because where they overlap (the
   * trunk's base) the soil is what she is actually standing on.
   */
  private barrierNormal(at: THREE.Vector3, out: THREE.Vector3): void {
    const h = CELL_SIZE * 1.5;
    /*
     * The TREE is asked first, and by proximity to its own surface, because
     * it is analytic and exact. The gradient was asked first once, and it
     * cost the whole climb: a density field has a nonzero gradient in open
     * AIR near the ground too, so a hit on the trunk a millimetre above the
     * soil read as a gentle soil slope, the steepness test called it
     * walkable, and she drove straight through the tree without ever
     * mounting it. The gradient speaks only for points the soil actually
     * claims.
     */
    const dx = at.x - this.tree.x;
    const dz = at.z - this.tree.z;
    const r = Math.hypot(dx, dz);
    const nearTrunk = r <= this.tree.radius + h && at.y <= this.tree.top + h
      && !this.solidAt(at);
    if (nearTrunk) {
      /*
       * The rim reads as ROUNDED even though the solid is a sharp cylinder.
       *
       * With a sharp normal — radial right up to the corner, then suddenly up
       * — her eased up never gets a reason to start rotating: she climbed to
       * the rim and sawed there, 78.6 to 79.1 mm, forever, the wrap search
       * pulling her back to an edge whose normal still said "wall". A corner
       * band whose normal swings smoothly from radial to up is what lets the
       * climb ROLL over the lip, the way a real claw walks round an edge.
       */
      const EDGE = 0.35;
      const rr = r - (this.tree.radius - EDGE);
      const yy = at.y - (this.tree.top - EDGE);
      if (rr > 0 && yy > 0 && r > 1e-6) {
        const len = Math.hypot(rr, yy);
        if (len > 1e-9) {
          out.set((dx / r) * (rr / len), yy / len, (dz / r) * (rr / len)).normalize();
          return;
        }
      }
      if (at.y > this.tree.top - EDGE) {
        out.copy(WORLD_UP);
        return;
      }
      if (r > 1e-6) {
        out.set(dx / r, 0, dz / r);
        return;
      }
    }
    const gx = this.densityAt(at.x + h, at.y, at.z) - this.densityAt(at.x - h, at.y, at.z);
    const gy = this.densityAt(at.x, at.y + h, at.z) - this.densityAt(at.x, at.y - h, at.z);
    const gz = this.densityAt(at.x, at.y, at.z + h) - this.densityAt(at.x, at.y, at.z - h);
    // Density rises inward, so the surface faces down the gradient.
    out.set(-gx, -gy, -gz);
    if (out.lengthSq() > 1e-10) {
      out.normalize();
      return;
    }
    out.copy(WORLD_UP);
  }

  /**
   * March a ray through everything solid and return the first contact, or
   * null. The last sample is always the far end — the camera walk-out taught
   * that lesson — and the contact is bisected to a fraction of a cell, so a
   * foot planted on it does not visibly hover off the bark.
   */
  private castBarrier(
    from: THREE.Vector3, dir: THREE.Vector3, maxDist: number,
  ): THREE.Vector3 | null {
    const step = CELL_SIZE * 0.6;
    const samples = Math.max(1, Math.ceil(maxDist / step));
    let clear = 0;
    for (let i = 1; i <= samples; i += 1) {
      const d = Math.min(i * step, maxDist);
      CAST_AT.copy(from).addScaledVector(dir, d);
      if (this.barrierAt(CAST_AT)) {
        let lo = clear;
        let hi = d;
        for (let split = 0; split < 5; split += 1) {
          const mid = (lo + hi) / 2;
          CAST_AT.copy(from).addScaledVector(dir, mid);
          if (this.barrierAt(CAST_AT)) hi = mid;
          else lo = mid;
        }
        return CAST_HIT.copy(from).addScaledVector(dir, (lo + hi) / 2);
      }
      clear = d;
    }
    return null;
  }

  /**
   * How high she stands and which way is up, at HER size.
   *
   * Measured from ground heights a body-length apart, not from the density
   * gradient at a point. The gradient is the surface normal of the soil at
   * bite scale, which sounds like the same thing and is not: a fresh crater is
   * four millimetres across and its wall points sideways, so standing in one
   * she rolled onto her back. For a nine-millimetre animal that is aligning to
   * a pebble.
   *
   * Sampling the HEIGHTFIELD also means the result can never point below the
   * horizon however rough the ground gets, so there is no crater and no
   * overhang that can turn her over — a bound the gradient version could not
   * give at any sampling radius.
   */
  private stance(
    worldX: number, worldZ: number, fromY = this.antPosition.y,
  ): { height: number; up: any; overHole: boolean } {
    const reach = (CASTE_LENGTH_MM.queen / WORLD_UNIT_MM) * STANCE;
    /*
     * Probed from the height of whoever is ASKING. It defaulted to the driven
     * ant's, which is right for her and wrong for the two standing at the other
     * end of the bench — they would be measured against a column starting above
     * someone else's head.
     */
    const from = fromY + STEP_UP;
    const west = this.groundAt(worldX - reach, worldZ, from);
    const east = this.groundAt(worldX + reach, worldZ, from);
    const south = this.groundAt(worldX, worldZ - reach, from);
    const north = this.groundAt(worldX, worldZ + reach, from);
    const centre = this.groundAt(worldX, worldZ, from);

    /*
     * The MEDIAN of where her feet and her belly are, not the average and not
     * the highest.
     *
     * Two failures pull in opposite directions here, and the median is what
     * separates them without needing to know which is happening. A pothole
     * narrower than she is touches one sample out of five, so the median
     * ignores it and she strides over it — the thing the average was brought
     * in to fix. A shaft she is walking down into is under most of the
     * samples, so the median follows it down, which the average and the
     * max-against-centre both refused to do: they held her on the rim of her
     * own burrow and the fail-safe finished the job by hauling her out.
     */
    const ranked = [west, east, south, north, centre].sort((a, b) => a - b);
    const support = ranked[2]!;
    const floor = this.descendInto(worldX, worldZ, from, support);
    return {
      height: floor,
      up: new THREE.Vector3(-(east - west), 2 * reach, -(north - south)).normalize(),
      overHole: floor < support,
    };
  }

  /**
   * If nothing within her own footprint is holding her up, she goes down it.
   *
   * The median above is a rule about her FEET, and it is the right one for
   * walking: a pothole narrower than her stance touches one sample of five, the
   * median ignores it, and she strides over it the way an animal does. The same
   * rule refuses to let her enter a shaft she would fit down, because three
   * feet on the rim outvote two in the hole — so her own tunnel was somewhere
   * she could only ever fall while cutting, never walk back into. Reported as
   * not being able to get back in the hole.
   *
   * What tells a shaft from a crack is not how far her feet reach, it is
   * whether her BODY is over anything. So this asks a second, tighter ring at
   * her own width, and takes the HIGHEST ground on it. The highest, not the
   * lowest, is the whole trick: it is the best support anywhere under her
   * belly, and if even that has fallen away then there is nothing beneath her
   * at all and she is standing on the rim of a hole she fits through. A crack
   * that only crosses part of her leaves solid ground somewhere on the ring,
   * the maximum stays high, and she keeps walking over it.
   */
  private descendInto(
    worldX: number, worldZ: number, from: number, support: number,
  ): number {
    if (!this.queenReady) return support;
    const girth = this.queen.bodyRadius();
    if (girth <= 0) return support;
    let best = this.groundAt(worldX, worldZ, from);
    for (const [dx, dz] of BODY_RING) {
      best = Math.max(best, this.groundAt(worldX + dx * girth, worldZ + dz * girth, from));
    }
    /*
     * A step's worth of drop, so this is a HOLE and not the far side of a
     * ripple. Below that, the stance median stays in charge and she walks.
     */
    return support - best > STEP_UP ? best : support;
  }

  /**
   * Put her on the ground, facing where she is going, leaning with the slope.
   *
   * Run every frame and NOT only while walking, which is the whole point. The
   * marker this replaced re-read the ground inside the movement branch, so
   * digging out from under yourself left you standing at the height the soil
   * used to be — and standing still over a hole you just made is exactly when
   * that is most obvious.
   */
  /**
   * Is she inside the hill rather than on it?
   *
   * Asked of the soil ABOVE her, because "below the surface" is a question
   * about a column and she is often standing in a hole whose rim is over her
   * head. A body length up is the difference between being in a shallow
   * scrape, where she should still walk on the ground, and being in a tunnel,
   * where the ground has a ceiling and the stance rules stop applying.
   */
  /**
   * Is she below the surface of the mound?
   *
   * Two wrong definitions came before this one, and they failed in opposite
   * directions, which is why both halves of the test below are load-bearing.
   *
   * Probing straight up from her head called a shaft "open field", because
   * straight up from the bottom of a shaft is the shaft — open by
   * construction, she dug it. Ten millimetres down her own hole, `stand` ran,
   * the stance median landed four of five samples on the rim, and she was
   * heaved out. Reported as being teleported out of the hole.
   *
   * Comparing against the UNDUG procedural land fixed that and failed the
   * other way: a crater floor is also below the undug land, while being open
   * sky. So she came up out of a dive into her own crater and stood there in
   * daylight with the flag still set — the gait dead, her feet four
   * millimetres wrong, her head hidden in first person, tunnel physics holding
   * her — until she happened to walk over the rim and everything snapped back
   * in a single frame. Reported as the ant dying and getting stuck
   * underground for a moment before popping back to normal, and measured at
   * 2.3 seconds of it on the round trip the smoke test drives.
   *
   * What tells a tunnel from a crater is a ROOF. Underground means below the
   * undug land AND under solid cover — and cover is sensed with a small cone
   * of rays overhead, because no single ray can answer it: the vertical one is
   * open in every shaft she digs, and any one slanted ray brushes the rim of
   * an open crater. A majority of a cone is what "covered" actually means. In
   * a vertical shaft the slanted rays strike the walls within a millimetre; in
   * an open crater they rise past the rim into sky.
   */
  private get underground(): boolean {
    return this.roofedNow;
  }

  /**
   * Is any of her still below the land as it was before digging?
   *
   * NOT the same question as `underground`, and the difference was measured
   * before it was believed. This is the coarse, geometric fact — her body has
   * not yet cleared the undug surface — and it is the right gate for GRAVITY
   * while the bore is armed, because what holds a digging ant up is being
   * wedged in her own workings, and she is wedged for exactly as long as she
   * is below the land she cut into.
   *
   * Gating gravity on the roof sense instead put a limit cycle at the mouth of
   * every shaft: the roof opens a few millimetres before she is clear, gravity
   * came on against the reverse climb, she sank until the roof closed, the
   * fall reset, she climbed, and around again — measured bouncing between 7.0
   * and 9.8 mm for as long as the reverse was held, which is "it seems to not
   * go out the hole" in its exact spelling.
   */
  private get wedged(): boolean {
    const half = this.queenReady ? this.queen.bodyRadius() : 0;
    return this.antPosition.y + half
      < streamGroundHeight(this.antPosition.x, this.antPosition.z);
  }

  /**
   * Recomputed once per simulated frame, after she has moved and before the
   * standing/tunnelling branch reads it — five rays through the density field
   * are cheap, but not so cheap that every one of the six reads a frame makes
   * should pay for its own.
   */
  private roofedNow = false;

  private senseUnderground(): boolean {
    /*
     * Her own half-thickness, not a camera constant.
     *
     * This compared her against the surface plus CAMERA_LOOK_AT, which is how
     * far ABOVE her the third-person rig aims — a framing number that found its
     * way into a question about her body. At 2.5 mm it meant she had to climb
     * two and a half millimetres clear of the ground before she counted as out.
     * Her body radius is the honest measure and it is measured off each caste's
     * own mesh — she is under the ground when all of her is.
     */
    const half = this.queenReady ? this.queen.bodyRadius() : 0;
    const eye = this.antPosition.y + half;
    if (eye >= streamGroundHeight(this.antPosition.x, this.antPosition.z)) return false;

    /*
     * Below the undug land. Underground only if she is also COVERED: the
     * vertical ray plus four at forty degrees, counted by majority. One wall
     * beside her — standing against the flank of her own crater — lights up
     * two rays at most and she still counts as being in daylight, which she
     * is. A tunnel lights the vertical ray on its roof and the cross-tunnel
     * pair on its walls; a shaft lights all four slanted rays at once.
     *
     * The march is capped at four units — twenty millimetres, two body lengths
     * of queen. Cover further away than that is scenery, not a ceiling.
     */
    const reach = 4;
    const step = CELL_SIZE * 2;
    let hits = 0;
    for (const [dx, dy, dz] of ROOF_RAYS) {
      for (let d = step; d <= reach; d += step) {
        SENSE.set(
          this.antPosition.x + dx * d, eye + dy * d, this.antPosition.z + dz * d,
        );
        if (SENSE.y > CELLS_Y * CELL_SIZE) break;
        if (this.solidAt(SENSE)) { hits += 1; break; }
      }
      if (hits >= 3) return true;
    }
    return false;
  }

  /**
   * Underground she keeps the height the bore gave her, only easing clear of
   * the tunnel floor rather than being pulled back to the surface.
   *
   * `stand` reads the ground under her and puts her on it, which is right on a
   * hillside and exactly wrong inside a burrow: the "ground" over her head is
   * the roof, and following it hauls her back out of her own tunnel.
   */
  /**
   * Fall, and land on `floor` rather than through it.
   *
   * Shared by the standing and the tunnelling paths on purpose. Every floating
   * bug so far has come from one code path or another deciding it did not need
   * to hold her up this frame, so the falling rule lives in one place and both
   * of them call it — a third path added later that forgets to is a bug, but a
   * third path that calls this and gets it subtly wrong is not possible.
   */
  private applyGravity(dt: number, floor: number): void {
    this.fallSpeed = Math.min(FALL_LIMIT, this.fallSpeed + GRAVITY * dt);
    const next = this.antPosition.y - this.fallSpeed * dt;
    if (next <= floor) {
      this.antPosition.y = floor;
      this.fallSpeed = 0;
    } else {
      this.antPosition.y = next;
    }
  }

  private holdTunnel(dt: number): void {
    /*
     * A single column under her, NOT the stance median.
     *
     * The median was tried, to make this agree with `stand` and stop the step
     * on arming, and it stops the dive dead: it samples five points across her
     * stance, a bore is four millimetres wide and she is not, so four of the
     * five land on the rim and the median holds her on top of her own shaft.
     * Measured — she rose to 13.9 mm and stayed there instead of descending.
     */
    /*
     * UNDER the ground, the floor is the single column beneath her — the
     * tunnel's own floor. ABOVE it, the floor is the stance, exactly what
     * `stand` would have used.
     *
     * Those two answers differ by about half a millimetre on sloped ground,
     * because one asks what is directly beneath her and the other where her
     * feet can support her. Arming the dig switches between the branches, so
     * while they disagreed, pressing BORE dropped her by the difference — half
     * a millimetre of movement from the one control whose entire specification
     * is that it does not move you. Matching them where the switch happens
     * removes the step by construction rather than by threshold.
     *
     * The median cannot be used underground: it samples wider than a bore, so
     * four of five land on the rim and it holds her on top of her own shaft.
     */
    /*
     * `wedged`, not `underground`, on both reads in here — this is the digging
     * physics, and what matters to it is her body against the undug land, not
     * whether the player-facing world counts her as being in daylight. See
     * `wedged` for the limit cycle that using the roof sense here produced.
     */
    /*
     * In a bore the floor is the single column beneath her — her own shaft,
     * however shallow it still is. The old gate was `wedged`, which a
     * four-millimetre dive never satisfies, so the stance median held her at
     * the rim and the first seconds of every dig were a tug of war the jaws
     * mostly lost. The "arming must not move her" rule that once forbade
     * this switch is dead: holding DIG is SUPPOSED to move her now.
     */
    /*
     * The column while she is wedged or actively cutting; the STANCE once
     * her body is clear. The stance half is not a nicety — at the mouth of a
     * shaft it reads the rim, and the ease-up branch below is what carries
     * her the last stretch out of her own hole. Pinning the floor to the
     * shaft column whenever the bore was engaged left that assist dead, and
     * a reverse that climbed to the mouth settled back to the shaft floor
     * the moment the stick was released.
     */
    const floor = this.wedged || this.bore.digging
      ? this.groundAt(
        this.antPosition.x, this.antPosition.z, this.antPosition.y + FOOT_CLEARANCE,
      )
      : this.stance(this.antPosition.x, this.antPosition.z).height;
    if (this.antPosition.y < floor - FOOT_CLEARANCE) {
      // Lifted OUT of the floor: she is holding whatever height the bore gave
      // her, and the floor is a lower bound.
      const ease = 1 - Math.exp(-HEIGHT_EASE * dt);
      this.antPosition.y += (floor - this.antPosition.y) * ease;
      this.fallSpeed = 0;
    } else if (!(this.wedged && (this.bore.digging || this.input.walk !== 0))) {
      /*
       * ^ WEDGED, not the bore latch, and the difference is a launch: what
       * suspends gravity is her body being in the soil's grip, and holding
       * reverse does not extend that grip past the surface — gated on the
       * latch, a held reverse at minus ninety sailed her 46 mm into the sky.
       * The latch owns her ALIGNMENT; the soil owns her weight.
       */
      /*
       * And DROPPED onto it when the bore has left her over open space.
       *
       * This branch used to do nothing at all, which is most of "the ant
       * floating in space": drive a shaft, break through into the hollow you
       * cut a minute ago, and there is no floor under you — so she held the
       * height the bore last gave her, indefinitely, in mid-air. A tunnel is
       * exactly the place a game makes holes for a body to fall down.
       *
       * Not while the bore is cutting AND she is actually UNDER the ground.
       * What holds her is being wedged in soil, not the button being pressed:
       * measured, reversing out of a shaft at minus ninety carried her from
       * 6.6 mm to 76.8 mm — sixty-four millimetres above a twelve-millimetre
       * surface, still climbing at walking pace, because backing up the bore
       * kept pointing straight up and nothing was left to pull her down once
       * she was clear of the hole. A body wedged in a hole it is
       * chewing is held by the whole wall of it, not balanced on the floor —
       * and the two height rules disagree by half a millimetre on sloped
       * ground, because `stand` asks where her feet support her and this asks
       * what is directly beneath her. Letting gravity act across that switch
       * meant pressing BORE dropped her by exactly the difference: half a
       * millimetre of movement from the one control whose entire specification
       * is that it does not move you.
       */
      this.applyGravity(dt, floor);
    } else {
      this.fallSpeed = 0;
    }
    if (!this.queenReady) return;
    this.queen.root.position.copy(this.antPosition);
    this.orientQueen();
  }

  private stand(dt: number): void {
    const ground = this.stance(this.antPosition.x, this.antPosition.z);
    /*
     * Airborne is the condition, not "the descend rule fired".
     *
     * Traced across the mouth of her own shaft, the stance median ALREADY found
     * the floor eleven millimetres below her — the rule had nothing to override,
     * so a flag set from it never lit, and she strode across a hole the code
     * knew perfectly well she was over. What matters is not which rule found
     * the drop; it is that there is a drop and her feet are in it.
     */
    this.overHole = this.antPosition.y - ground.height > FALL_FROM;
    if (this.overHole) {
      /*
       * Too far above the ground to be standing on it, so she falls.
       *
       * The easing below is a contact model — it exists so that biting the
       * ground out from under her own feet is a settle rather than a jolt — and
       * a contact model applied at any height is a levitation model. Walk off
       * the rim of a crater and it lowered her gently through the air at a rate
       * set by a smoothing constant, which is the "floating in space" in its
       * above-ground spelling.
       */
      this.applyGravity(dt, ground.height);
    } else {
      // Eased, not assigned. The ground under her changes every time she bites,
      // and following it exactly is a jolt on every frame that removes a cell.
      const ease = 1 - Math.exp(-HEIGHT_EASE * dt);
      this.antPosition.y += (ground.height - this.antPosition.y) * ease;
      this.fallSpeed = 0;
    }
    // The camera rides the rise as well, or descending a shaft leaves the view
    // hanging at the surface looking at the back of her head.
    if (!this.queenReady) return;
    this.queen.root.position.copy(this.antPosition);

    /*
     * Eased toward the new normal rather than snapped to it. Her feet cross a
     * cell every twentieth of a second at walking pace, and the ground has
     * quarter-millimetre grit on it, so taking each frame's slope literally
     * makes her shiver.
     */
    this.up.lerp(ground.up, 0.15).normalize();
    this.orientQueen();
  }

  /**
   * Point her the way she is going, on whatever she is standing on.
   *
   * Built as a BASIS rather than as yaw plus a tilt. Her up is the terrain
   * normal and her forward is the heading flattened against that up, so on a
   * slope she pitches and rolls with the ground instead of standing plumb with
   * her feet through it. Composing two rotations does not give this — the two
   * orders disagree the moment both angles are non-zero.
   */
  /**
   * Advance the tripod walk and hand back where each foot belongs.
   *
   * Null while she is boring or underground: down a shaft she is not walking,
   * she is being pushed along a bore by the joystick, and anchoring her feet to
   * world points would have her clawing at a tunnel wall that is moving past
   * her. Above ground, walking, this is what makes a stance foot's ground speed
   * zero — the thing the clock-driven gait could never do.
   */
  private stepFeet(dt: number): Map<string, readonly [number, number, number]> | null {
    if (!this.queenReady) return null;
    // A climb IS a walk — underground only kills the gait when she is being
    // driven along a bore, not when she is gripping the wall of one.
    if (this.bore.digging || (this.underground && !this.gripping)) {
      this.gait = null;
      return null;
    }
    if (!this.gait) {
      const legs = this.queen.legPlan();
      if (legs.length === 0) return null;
      this.gait = new TripodGait(legs);
    }
    const ground = (x: number, z: number): number =>
      this.groundAt(x, z, this.antPosition.y + STEP_UP);

    let surfaceAt: SurfaceAt;
    const stride = {
      position: [this.antPosition.x, this.antPosition.y, this.antPosition.z] as
        [number, number, number],
      heading: this.facing,
      speed: this.walkSpeed,
      frame: undefined as undefined | {
        right: [number, number, number];
        up: [number, number, number];
        forward: [number, number, number];
      },
    };
    if (this.gripping) {
      const up = this.climbUp;
      const fwd = this.climbForward;
      CAST_N.crossVectors(up, fwd);
      stride.frame = {
        right: [CAST_N.x, CAST_N.y, CAST_N.z],
        up: [up.x, up.y, up.z],
        forward: [fwd.x, fwd.y, fwd.z],
      };
      const reach = Math.max(0.4, this.queen.bodyRadius() * 2 + STEP_UP);
      surfaceAt = (p, upv) => {
        CAST_FROM.set(p[0], p[1], p[2])
          .addScaledVector(CLIMB_V.set(upv[0], upv[1], upv[2]), STEP_UP * 2);
        CAST_DIR.copy(CLIMB_V).negate();
        const hit = this.castBarrier(CAST_FROM, CAST_DIR, STEP_UP * 2 + reach);
        return hit ? [hit.x, hit.y, hit.z] : null;
      };
    } else {
      /*
       * Level ground keeps its seeded column, with one refusal: a landing
       * inside the trunk's footprint while she is below the canopy has
       * nothing under it a leg can use — the "ground" there is soil the
       * trunk stands on. Null retreats the foot toward home, which is what
       * stops her legs vanishing into the bark when she walks up to the tree.
       */
      surfaceAt = (p) => {
        const dx = p[0] - this.tree.x;
        const dz = p[2] - this.tree.z;
        if (dx * dx + dz * dz <= this.tree.radius * this.tree.radius
          && p[1] < this.tree.top - STEP_UP) return null;
        return [p[0], ground(p[0], p[2]), p[2]];
      };
    }
    const states = this.gait.step(dt, stride, ground, surfaceAt);
    const out = new Map<string, readonly [number, number, number]>();
    for (const state of states) out.set(state.slot, state.target);
    return out;
  }

  /**
   * Stand the ants you are NOT driving.
   *
   * They get the same gait and the same foot solver as the driven one, at zero
   * speed — which is the point of the bench. A caste whose legs misbehave
   * standing still on sloped ground shows it here without anyone having to
   * drive over to check, and the three are on the same soil at the same moment
   * so the comparison is like for like.
   */
  /**
   * The driven ant has finished loading.
   *
   * A handle for the smoke test, and the reason it is worth having: "is she the
   * right size" cannot be answered from a screenshot, and it cannot be answered
   * from the constants either, because the scale is applied to a model whose own
   * proportions live in the glb. Measured through here, her widest span is 9.07
   * mm against the 9 mm `CASTE_LENGTH_MM` asks for.
   *
   * The same measurement settled which way she faces: her mouth bone sits at
   * z = +0.82 and her gaster at z = -0.63, so her head is toward +Z and
   * `forward = (sin f, 0, cos f)` points where she is actually going. From the
   * side, at the lab's camera angle, +Z and -X look identical.
   */
  private onDrivenLoaded(ok: boolean): void {
    if (!ok) this.status.dataset.message = `${this.ants[this.driven]!.caste} model failed to load`;
    // The rig has to exist before its head can be found, so the first-person
    // default is seated here rather than when the panel was built.
    this.seatEyeOnHead();
    this.updateStatus();
  }

  private poseBystanders(dt: number): void {
    for (let i = 0; i < this.ants.length; i += 1) {
      if (i === this.driven) continue;
      const ant = this.ants[i]!;
      if (!ant.ready) continue;
      /*
       * The STANCE height, the same floor a driven ant stands on. Using the
       * single column under them instead made every hand-over drop the ant you
       * left behind by the half millimetre the two queries disagree by — a
       * visible twitch, and on the wrong ant, at the moment you look away.
       */
      ant.position.y = this.stance(ant.position.x, ant.position.z, ant.position.y).height;
      ant.model.root.position.copy(ant.position);
      ant.model.root.quaternion.setFromAxisAngle(WORLD_UP, ant.facing);
      ant.model.update(dt, { speed: 0, turn: 0, digging: 0, carrying: 0 });
      ant.model.solveFeet(
        (x, z, y) => this.groundAt(x, z, y + STEP_UP), FOOT_CLEARANCE, FOOT_PLANT_BAND,
      );
      // Whatever the solvers left, nothing drawn may be inside the soil.
      const lift = ant.model.groundGuard((x, y, z) => {
        PROBE.set(x, y, z);
        if (!this.solidAt(PROBE)) return 0;
        return Math.max(0, this.groundAt(x, z, y) - y + FOOT_CLEARANCE);
      });
      ant.model.root.position.y = ant.position.y + lift;
    }
  }

  /**
   * Take over whichever ant was tapped.
   *
   * She keeps her own place: you step out of the one you were driving where it
   * stands and step into the other where IT stands, rather than the model
   * changing underneath a fixed camera. That is what makes the bench a bench —
   * you can walk one somewhere interesting, leave it, and come back to it.
   *
   * The dynamic state does not transfer. Velocity, fall speed, the pitch train
   * and the stepper all belong to the body that was doing them, and carrying a
   * major's momentum into a worker is a bug waiting to be reported as one.
   */
  private drive(index: number): void {
    if (index === this.driven || !this.ants[index]?.ready) return;
    const leaving = this.ants[this.driven]!;
    leaving.position.copy(this.antPosition);
    leaving.facing = this.facing;

    this.driven = index;
    const taking = this.ants[index]!;
    this.antPosition.copy(taking.position);
    this.facing = taking.facing;
    this.bore.turn(taking.facing - this.bore.heading);
    this.velocity.set(0, 0, 0);
    this.walkSpeed = 0;
    this.fallSpeed = 0;
    this.overHole = false;
    this.gait = null;
    this.headPitch = 0;
    this.thoraxPitch = 0;
    this.gasterPitch = 0;
    this.up.set(0, 1, 0);
    // Her head is a different place on every caste, so the first-person eye
    // has to be re-seated unless the player has placed it themselves.
    this.seatEyeOnHead();
    this.updateStatus();
  }

  /** Which ant is under this screen point, if any. */
  private antAt(clientX: number, clientY: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    POINTER.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.picker.setFromCamera(POINTER, this.camera);
    for (let i = 0; i < this.ants.length; i += 1) {
      const ant = this.ants[i]!;
      if (i === this.driven || !ant.ready) continue;
      if (this.picker.intersectObject(ant.model.root, true).length > 0) return i;
    }
    return -1;
  }

  /**
   * Walking into a wall mounts it.
   *
   * The feeler reaches out from her body along her heading, about a nose
   * ahead. A hit whose surface is steeper than `MOUNT_STEEP` is a wall — the
   * flank of the tree, the side of a crater — and driving at a wall is what
   * asking to climb it looks like. Her first heading on the wall is straight
   * up it: the steepest ascent is what walking INTO something means.
   */
  private tryMount(): void {
    if (this.gripping || this.bore.digging || this.input.walk <= 0 || !this.queenReady) return;
    const girth = Math.max(0.2, this.queen.bodyRadius());
    CAST_DIR.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    CAST_FROM.copy(this.antPosition).addScaledVector(WORLD_UP, girth);
    const hit = this.castBarrier(CAST_FROM, CAST_DIR, girth + this.walkSpeed * 0.25 + 0.6);
    if (!hit) return;
    this.barrierNormal(hit, CAST_N);
    if (CAST_N.dot(WORLD_UP) >= MOUNT_STEEP) return;
    this.gripping = true;
    this.climbUp.copy(CAST_N);
    this.climbForward.copy(WORLD_UP).addScaledVector(CAST_N, -WORLD_UP.dot(CAST_N));
    if (this.climbForward.lengthSq() < 1e-6) this.climbForward.copy(CAST_DIR);
    this.climbForward.normalize();
    this.velocity.set(0, 0, 0);
    this.walkSpeed = 0;
    this.fallSpeed = 0;
    this.gait = null;
    this.status.dataset.message = 'Climbing — steer to spiral, reverse to back down';
    this.updateStatus();
  }

  /** The climb is over — flat ground, or nothing left to hold. */
  private endClimb(): void {
    this.gripping = false;
    this.up.copy(this.climbUp);
    this.fallSpeed = 0;
    this.gait = null;
    this.status.dataset.message = 'Walk with the pad, aim, and press DIG';
    this.updateStatus();
  }

  /**
   * One frame of the climb: steer about the surface normal, advance along her
   * own forward, and hold on.
   *
   * Holding on is a cast from just off her back, in through her soles. While
   * it lands, she is drawn onto the contact and her up eases toward its
   * normal — adhesion, in place of gravity. When it finds nothing she has
   * walked over an edge, and the wrap search looks BEHIND AND BELOW her in
   * her own frame, which is where the far side of a lip is; only when even
   * that is empty has she genuinely climbed off the end of the world, and
   * gravity takes her back.
   */
  private climbMove(dt: number): void {
    const up = this.climbUp;
    const fwd = this.climbForward;
    const yaw = this.input.yaw * YAW_RATE * dt;
    if (Math.abs(yaw) > 1e-9) {
      SPIN.setFromAxisAngle(up, -yaw);
      fwd.applyQuaternion(SPIN).normalize();
    }
    this.turnRate = this.input.yaw * YAW_RATE;

    const ease = 1 - Math.exp(-SPEED_EASE * dt);
    CLIMB_V.copy(fwd).multiplyScalar(this.speed * this.input.walk);
    this.velocity.lerp(CLIMB_V, ease);
    this.walkSpeed = this.velocity.length();
    this.antPosition.addScaledVector(this.velocity, dt);
    const margin = CELL_SIZE * 3;
    this.antPosition.x = THREE.MathUtils.clamp(this.antPosition.x, margin, WORLD_SPAN - margin);
    this.antPosition.z = THREE.MathUtils.clamp(this.antPosition.z, margin, WORLD_SPAN - margin);

    const girth = this.queenReady ? Math.max(0.2, this.queen.bodyRadius()) : 0.3;
    CAST_FROM.copy(this.antPosition).addScaledVector(up, girth);
    CAST_DIR.copy(up).negate();
    const hold = this.castBarrier(CAST_FROM, CAST_DIR, girth + STEP_UP * 3);
    if (hold) {
      this.antPosition.lerp(hold, 1 - Math.exp(-CLIMB_SNAP * dt));
      this.barrierNormal(hold, CAST_N);
      up.lerp(CAST_N, 1 - Math.exp(-CLIMB_ALIGN * dt)).normalize();
      fwd.addScaledVector(up, -fwd.dot(up));
      if (fwd.lengthSq() < 1e-8) fwd.set(up.z, up.x, up.y);
      fwd.normalize();
      /*
       * Dismount wants BOTH readings flat: this contact's normal, and the up
       * she has eased onto. One cast alone flapped her on and off at the
       * trunk's foot — the hold cast grazes the soil there, reads "flat",
       * dismounts, and the next frame's feeler mounts her again, twice a
       * second, while her body is still lying against the bark.
       */
      if (CAST_N.dot(WORLD_UP) > EXIT_FLAT && up.dot(WORLD_UP) > EXIT_FLAT) this.endClimb();
    } else {
      let caught = false;
      for (const arc of LIP_ARCS) {
        CAST_DIR.copy(up).multiplyScalar(-Math.cos(arc)).addScaledVector(fwd, -Math.sin(arc)).normalize();
        CAST_FROM.copy(this.antPosition).addScaledVector(up, girth * 1.2);
        const wrap = this.castBarrier(CAST_FROM, CAST_DIR, girth * 3);
        if (wrap) {
          this.antPosition.lerp(wrap, 0.5);
          this.barrierNormal(wrap, CAST_N);
          up.lerp(CAST_N, 0.5).normalize();
          fwd.addScaledVector(up, -fwd.dot(up));
          if (fwd.lengthSq() > 1e-8) fwd.normalize();
          caught = true;
          break;
        }
      }
      if (!caught) this.endClimb();
    }

    /*
     * The rest of the frame — HUD, camera, dismounts — thinks in the world
     * yaw her climb most resembles, so it is kept in step whenever her
     * forward has any horizontal meaning at all. Near straight up it has
     * none, and the last good yaw stands.
     */
    if (this.gripping && Math.hypot(fwd.x, fwd.z) > 0.15) {
      this.facing = Math.atan2(fwd.x, fwd.z);
      this.bore.turn(this.facing - this.bore.heading);
    }
    if (this.gripping) this.up.copy(up);

    const scroll = this.stream.recentreOn(this.antPosition.x, this.antPosition.z);
    if (scroll) {
      this.lastScrollMs = scroll.ms;
      this.refreshResidency(false, scroll.retained);
      this.updateStatus();
    }
    if (!this.queenReady) return;
    this.queen.root.position.copy(this.antPosition);
    this.orientQueen();
  }

  private orientQueen(): void {
    /*
     * Pitch is measured from the WORLD horizon, never from the ground she
     * happens to be on.
     *
     * `this.up` is the terrain normal, and building the bore on it made minus
     * ninety mean "ninety degrees off whatever slope I am standing on". On the
     * flank of the mound that is a diagonal; on the wall of her own shaft it is
     * sideways, which is how she ended up clinging to a cliff face with the
     * gauge insisting she was pointed straight down. Reported exactly that way:
     * max at minus ninety was not straight down.
     *
     * A pitch dial is a promise about the world, the same one a submarine's
     * is. So while she is aimed, her frame is world-referenced; only when she
     * is level does she lie back down along the slope, which is what makes
     * walking over a rise look right.
     */
    /*
     * On a climb her frame IS the climb's: up off the bark, forward where she
     * crawls, no world-pitch train — the dig is disarmed on a wall. The
     * flatten below is a no-op there, since the two are already orthogonal.
     */
    const aimed = !this.gripping && Math.abs(this.headPitch) > 1e-6;
    const up = this.gripping ? this.climbUp : (aimed ? WORLD_UP : this.up);
    const forward = this.gripping
      ? this.climbForward.clone()
      : new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    forward.addScaledVector(up, -forward.dot(up));
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    if (aimed) {
      forward.multiplyScalar(Math.cos(this.headPitch))
        .addScaledVector(WORLD_UP, Math.sin(this.headPitch)).normalize();
    }
    /*
     * Her own up is rebuilt from the basis rather than taken from the terrain,
     * so at ninety degrees down she is nose-first into the floor with her back
     * squarely behind her instead of being twisted to match a wall.
     */
    let right = new THREE.Vector3().crossVectors(up, forward);
    if (right.lengthSq() < 1e-8) right.crossVectors(WORLD_FORWARD, forward);
    right.normalize();
    const back = new THREE.Vector3().crossVectors(forward, right).normalize();
    this.queen.root.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, back, forward),
    );
  }

  /**
   * Move her along the BORE, not along the ground.
   *
   * This is the fix for a gauge reading minus seventy-seven while she scraped
   * a shallow trench across the surface: pitch steered the bite and nothing
   * else, so however steeply she aimed, she still walked horizontally and the
   * hole could never become a tunnel. Aim, then advance, and the aim is the
   * direction you advance in — which is the whole of what "move forward or
   * backwards along your pitch set" means.
   *
   * Above ground with the dig off, pitch is ignored and she simply walks.
   */
  private travel(dt: number, pitch: number, cutting: boolean): void {
    const ease = 1 - Math.exp(-SPEED_EASE * dt);
    /*
     * The DIG button is the drive: held, she advances into the face at jaw
     * pace with no pad input at all, which is the dig room's model brought
     * over whole. The pad only ever walks her — and pulling back with the
     * dig released is how she reverses out of a bore, at walking pace,
     * because backing out removes nothing and there is no work to pace.
     */
    const throttle = cutting ? 1 : this.input.walk;
    /*
     * Travel follows the pitch while she is cutting AND for as long as any
     * of her is still below the undug land. The second half is what lets go
     * of the button mean "stop", not "level out": release mid-bore and she
     * holds the bore's line, so pulling back walks her up the hole that is
     * already there instead of grinding her nose into its wall.
     */
    const aligned = cutting || this.boreEngaged;
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));

    // Down the WORLD's pitch, matching the dial. Built on the terrain normal
    // this drifted with the slope, so an aim of minus ninety drove her
    // along a hillside instead of into it.
    const heading = aligned
      ? forward.clone().multiplyScalar(Math.cos(pitch))
        .addScaledVector(WORLD_UP, Math.sin(pitch)).normalize()
      : forward;
    // Boring is paced by the JAWS, not by the legs.
    let pace = cutting ? BORE_SPEED : this.speed;
    /*
     * Footing gone, forward progress gone with it.
     *
     * Walking her across the mouth of her own shaft dipped her ten millimetres
     * and carried her out the far side: at eleven millimetres a second she
     * crosses a seven-millimetre hole in three tenths of a second, and gravity
     * only draws her down a millimetre in that time. So she sailed it.
     *
     * The missing piece is not more gravity, it is that an animal whose feet
     * have nothing under them does not keep striding. There is no horizontal
     * collision above ground — she walks straight through the rim — so this
     * does the part of that job that matters: with nothing underfoot she
     * scrabbles instead of running, and drops IN rather than across.
     */
    if (this.overHole && !aligned) pace *= HOLE_SCRABBLE;
    const wanted = heading.multiplyScalar(pace * throttle);

    this.velocity.lerp(wanted, ease);
    this.walkSpeed = this.velocity.length();
    if (throttle === 0 && this.walkSpeed < 1e-3) {
      this.velocity.set(0, 0, 0);
      this.walkSpeed = 0;
      return;
    }
    this.glide(dt, aligned);
  }

  /**
   * Carry her by the current velocity, and everything that has to follow her.
   *
   * Shared by the walking and the coasting branches, because the camera, the
   * orbit target and the streaming window all have to keep up whether she is
   * being driven or merely still slowing down — and a stop that leaves the
   * window behind is a stop that streams a tile late.
   */
  private glide(dt: number, digging: boolean): void {
    if (this.velocity.lengthSq() < 1e-12) return;
    const margin = CELL_SIZE * 3;
    const next = this.antPosition.clone().addScaledVector(this.velocity, dt);
    next.x = THREE.MathUtils.clamp(next.x, margin, WORLD_SPAN - margin);
    next.z = THREE.MathUtils.clamp(next.z, margin, WORLD_SPAN - margin);

    /*
     * Underground she can only go where the soil has already been removed.
     *
     * Without this the joystick drives her straight through the working face
     * and out the far side of the hill, and the digging becomes decoration.
     * With it, advance is paced by the head: each stroke clears a little more
     * and she moves into it, which is what makes the rate of tunnelling a
     * property of the bore rather than of how long the stick is held.
     *
     * Vertical is checked with her BODY offset, not her feet, so she is not
     * blocked by the floor she is standing on.
     */
    if (digging) {
      /*
       * Probed AT the position she would occupy, with no upward offset.
       *
       * The offset was half a body height, which on a descent is a point above
       * her that is still in open air while her feet are already in the soil —
       * so she sank in, and `holdTunnel` climbed her straight back out. Six
       * seconds of driving at ninety degrees down measured as two millimetres
       * UP. Asking about the place she is actually going is both the simpler
       * question and the one that paces her to the digging.
       */
      PROBE.copy(next);
      if (this.solidAt(PROBE)) return;
      this.antPosition.y = next.y;
    }
    this.antPosition.x = next.x;
    this.antPosition.z = next.z;

    const scroll = this.stream.recentreOn(this.antPosition.x, this.antPosition.z);
    if (scroll) {
      this.lastScrollMs = scroll.ms;
      this.refreshResidency(false, scroll.retained);
      this.updateStatus();
    }
  }

  private updateStatus(): void {
    const message = this.status.dataset.message ?? 'Walk with the pad, aim, and press DIG';
    const physicalVolumeMm3 = this.totalRemoved * WORLD_UNIT_MM ** 3;
    const tileX = Math.floor(this.antPosition.x / (TILE_CELLS * CELL_SIZE));
    const tileZ = Math.floor(this.antPosition.z / (TILE_CELLS * CELL_SIZE));
    const megabytes = (WINDOW_BYTES / 1048576).toFixed(1);
    const queued = this.pending.length > 0 ? ` · ${this.pending.length} queued` : '';
    this.status.innerHTML = `
      <b>${message}</b><br>
      Removed: ${this.totalRemoved.toFixed(1)} voxel³ · ${physicalVolumeMm3.toFixed(0)} mm³<br>
      World: ${WORLD_TILES}×${WORLD_TILES} tiles of ${TILE_MM} mm = ${WORLD_SPAN * WORLD_UNIT_MM} mm<br>
      Tile ${tileX},${tileZ} · window ${WINDOW_CELLS}×${CELLS_Y}×${WINDOW_CELLS} = ${megabytes} MB<br>
      Bore: ${(((this.facing * 180 / Math.PI) + 360) % 360).toFixed(0).padStart(3, '0')}° ·`
      + ` pitch ${(this.bore.pitch * 180 / Math.PI >= 0 ? '+' : '')}`
      + `${(this.bore.pitch * 180 / Math.PI).toFixed(0)}°`
      + `${this.bore.digging ? ' · DIG ON' : ''} · ${this.running ? 'run' : 'crawl'}${this.gripping ? ' · CLIMB' : ''}<br>
      Driving ${this.ants[this.driven]!.caste}: ${this.queenReady
        ? `${CASTE_LENGTH_MM[this.ants[this.driven]!.caste]} mm`
          + ` · feet ${(this.footPenetration * WORLD_UNIT_MM).toFixed(2)} mm`
          + ` · guard ${(this.guardLift * WORLD_UNIT_MM).toFixed(3)} mm`
          + `${this.follow.firstPerson ? ' · eye view' : ''}`
        : 'loading…'}<br>
      Mesh: ${this.lastMeshMs.toFixed(1)} ms · scroll ${this.lastScrollMs.toFixed(1)} ms${queued}<br>
      Dug: ${this.stream.editedSamples} samples kept
    `;
  }

  /** Left of the screen drives her; the right of it looks around her. */
  private bindCamera(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onCameraDown);
    canvas.addEventListener('pointermove', this.onCameraMove);
    canvas.addEventListener('pointerup', this.onCameraUp);
    canvas.addEventListener('pointercancel', this.onCameraUp);
    canvas.addEventListener('wheel', this.onCameraWheel, { passive: false });
  }

  /** The left of the screen is the stick's zone; the rest looks. */
  private get stickZone(): number {
    return this.renderer.domElement.clientWidth * 0.42;
  }

  private readonly onCameraDown = (event: PointerEvent): void => {
    const canvas = this.renderer.domElement;
    if (event.pointerType !== 'mouse' && event.clientX < this.stickZone && this.stickPointer === null) {
      this.stickPointer = event.pointerId;
      this.stickOrigin = clampStickOrigin(event.clientX, event.clientY, {
        minX: STICK_RADIUS + 8,
        maxX: Math.max(STICK_RADIUS + 8, this.stickZone - STICK_RADIUS - 8),
        minY: canvas.clientHeight * 0.38,
        maxY: canvas.clientHeight - STICK_RADIUS - 12,
      });
      this.stickX = 0;
      this.stickY = 0;
      this.showStick(true);
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.pressedAt.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  private readonly onCameraMove = (event: PointerEvent): void => {
    if (event.pointerId === this.stickPointer) {
      const v = stickVector(
        event.clientX - this.stickOrigin.x, event.clientY - this.stickOrigin.y, STICK_RADIUS,
      );
      this.stickX = v.x;
      this.stickY = v.y;
      /*
       * Up the screen is forward, and pushing RIGHT turns her nose right.
       *
       * That sign is measured, not reasoned: projecting a point ahead of her
       * into the camera showed `yaw = +1` swinging her nose LEFT across the
       * screen. The keyboard had it right and the button pad had it backwards,
       * which is why left and right were inverted for anyone on a phone and
       * fine for anyone on a keyboard.
       */
      this.input.walk = -v.y;
      this.input.yaw = -v.x;
      this.showStick(true);
      return;
    }
    const last = this.pointers.get(event.pointerId);
    if (!last) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2) {
      /*
       * Pinch, measured between the two live pointers. Tracked as a RATIO of
       * the previous spread rather than as a delta, so the zoom feels the same
       * whether the fingers start together or apart.
       */
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.lastPinch > 0 && spread > 0) this.follow.zoom(this.lastPinch / spread);
      this.lastPinch = spread;
      return;
    }
    this.lastPinch = 0;
    if (this.follow.firstPerson) {
      /*
       * From her own eyes, looking IS aiming. The whole point of the view is
       * that you can see where you are about to dig, and a camera that orbits
       * independently of her head shows you somewhere she is not pointed.
       *
       * So the drag turns HER and the aim follows: sideways swings her heading,
       * up and down clicks the pitch dial through its ten-degree steps. The
       * dial stays the only authority on pitch, so the gauge still tells the
       * truth and there is no second copy of the number to disagree with it.
       */
      this.bore.turn(-dx * LOOK_PER_PIXEL);
      // The look IS the aim: one continuous number, no notches, no second
      // copy for a gauge to disagree with. Drag up, dig up.
      this.bore.aimTo(this.bore.pitch - dy * LOOK_PER_PIXEL);
      return;
    }
    this.follow.orbit(-dx * LOOK_PER_PIXEL, -dy * LOOK_PER_PIXEL);
  };

  private readonly onCameraUp = (event: PointerEvent): void => {
    if (event.pointerId === this.stickPointer) {
      this.stickPointer = null;
      this.stickX = 0;
      this.stickY = 0;
      this.input.walk = 0;
      this.input.yaw = 0;
      this.showStick(false);
      return;
    }
    /*
     * A TAP picks an ant to drive; a DRAG looks around. The same pointer does
     * both, so they are told apart by how far it travelled — anything under a
     * few pixels was a tap, whatever the finger meant by it.
     */
    const down = this.pressedAt.get(event.pointerId);
    this.pressedAt.delete(event.pointerId);
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > TAP_SLOP) return;
    const picked = this.antAt(event.clientX, event.clientY);
    if (picked >= 0) this.drive(picked);
  };

  private readonly onCameraWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.follow.zoom(event.deltaY > 0 ? 1.1 : 1 / 1.1);
  };

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    /*
     * Let three.js set the canvas CSS size as well as its buffer.
     *
     * The third argument is `updateStyle`, and passing false was why digging
     * landed at the bottom right instead of under the crosshair. With no CSS
     * size a canvas displays at its ATTRIBUTE size in CSS pixels, and the
     * attributes are the buffer — width x devicePixelRatio. On a phone at
     * ratio 2 that is a canvas twice the viewport, pinned to the host's top
     * left and clipped by its `overflow: hidden`, so only the top-left quarter
     * of the render is on screen. The dig ray is NDC (0,0), dead centre of the
     * frustum and correct throughout; it was the picture that was off, by
     * exactly half a viewport down and right.
     *
     * Measured before the fix, on a 430x932 host: offset (-1,-1) at ratio 1,
     * (+214,+465) at ratio 2. Which is also the reason it survived a headless
     * check — a phone-sized viewport at ratio 1 is not a phone.
     */
    this.renderer.setSize(width, height);
  }

  /**
   * One step of the world, with no rendering in it.
   *
   * Split out from the frame loop so a test can advance the simulation by a
   * fixed amount instead of holding a key and hoping. Under software rendering
   * a frame takes half a second and the per-frame delta is capped — so three
   * real seconds of holding "walk" was about a third of a simulated one, and
   * checks written against the wall clock were measuring the renderer rather
   * than the thing they named. This runs exactly what the frame loop runs.
   */
  private simulate(delta: number): void {
    /*
     * Steer, then travel, then dig — in that order, because the bore direction
     * is what she moves ALONG and what her jaws follow, and a bite taken
     * against last frame's heading is a tunnel with a kink in it.
     */
    // A climb owns the yaw — the bore's heading is kept in step by climbMove
    // so the HUD and an eventual dismount agree with where she is pointed.
    const bore = this.bore.step(delta, {
      yaw: this.gripping ? 0 : this.input.yaw,
      forward: this.input.walk,
      // No jaws on the climb: the bore is a soil tool, and the wall is bark.
      dig: !this.gripping && this.input.dig > 0,
    });
    if (!this.gripping) this.facing = bore.heading;

    /*
     * The head leads and the body follows it. Rate-limited rather than eased,
     * so ninety degrees always takes the same three seconds however far she has
     * to go — an exponential ease would make a ten-degree change nearly
     * instant and a ninety-degree one never quite finish.
     */
    const swing = (Math.PI / 2) / PITCH_SWING_SECONDS * delta;
    /*
     * She only tips when the dig is ARMED. The dial is an aim you set before
     * you commit — pressing it should not put her nose in the dirt while she is
     * walking about on the surface, which is what it did: leave the gauge at
     * minus forty and she wandered the mound permanently face-down.
     *
     * The dial keeps its value the whole time, so the gauge still reads what
     * she will dig at. What changes is only whether her BODY is holding that
     * angle yet, and she levels out on the same rate limit she tips down on,
     * so disarming is a controlled rise rather than a snap upright.
     */
    if (bore.digging) this.boreEngaged = true;
    else if (this.boreEngaged) {
      /*
       * Released only when she is clear of the workings AND has let go of
       * reverse. The second clause is the one found by measurement: release
       * on clearance alone, and the rest of a held reverse walks her
       * BACKWARD, blind, flat across the mound — straight into whatever
       * crater is behind her. Reversing means "back out of the bore" for as
       * long as it is held, so the bore's frame holds with it; the launch
       * guard already keeps her from sailing off the top. A climb releases
       * it outright — that frame owns her.
       */
      const undug = streamGroundHeight(this.antPosition.x, this.antPosition.z);
      const clear = this.antPosition.y >= undug - FALL_FROM && this.input.walk >= 0;
      if (clear || this.gripping) this.boreEngaged = false;
    }
    // She holds the bore's angle for as long as she is committed to the bore,
    // and levels out only once she is clear of it.
    const aim = this.boreEngaged && !this.gripping ? bore.pitch : 0;
    this.headPitch += THREE.MathUtils.clamp(aim - this.headPitch, -swing, swing);
    this.thoraxPitch += THREE.MathUtils.clamp(
      this.headPitch - this.thoraxPitch, -swing * THORAX_RATE, swing * THORAX_RATE,
    );
    this.gasterPitch += THREE.MathUtils.clamp(
      this.thoraxPitch - this.gasterPitch, -swing * GASTER_RATE, swing * GASTER_RATE,
    );
    if (this.gripping) {
      this.climbMove(delta);
      this.roofedNow = this.senseUnderground();
    } else {
      this.turnRate = this.input.yaw * (bore.digging ? DIG_YAW_RATE : YAW_RATE);
      // She travels along the pitch her BODY has reached, not the one the dial
      // is set to — otherwise she would dive before she had finished turning to
      // face the dive.
      this.travel(delta, this.headPitch, bore.digging);
      // Sensed HERE — after she has moved, before anything reads it — and then
      // held for the frame, so the six readers below all agree on the answer.
      this.roofedNow = this.senseUnderground();
      /*
       * With the dig armed she is committed to the hole, whether or not there is
       * yet soil over her head. `stand` puts her on the surface, and while she is
       * cutting the first few millimetres of a shaft that is a tug of war she
       * always wins and the shaft never starts — measured as her rising two
       * millimetres over six seconds of driving straight down.
       */
      /*
       * Committed to a bore — engaged, not merely "button down": a shallow
       * shaft is not roofed and not deep enough to wedge her, and `stand`
       * running there eased her back onto the pit floor every frame while
       * the reverse tried to climb, which is why "reversing did not bring
       * her up" survived the first latch fix.
       */
      if (this.boreEngaged || this.underground) this.holdTunnel(delta);
      else this.stand(delta);
      // Only after she has settled: the feeler reads her resolved position.
      this.tryMount();
    }
    if (bore.bite && !this.gripping) this.carveAlongBore(this.headPitch);
    // The gait's dig level IS the head's dip, so the animation and the moment
    // soil leaves are the same event rather than two things kept in step.
    this.digPulse = bore.dip;
    if (this.queenReady) {
      this.queen.update(delta, {
        // The gait wants voxels per second and a world unit IS a voxel here,
        // both being five millimetres, so this needs no conversion — which is
        // worth saying out loud, because it would need one if either changed.
        speed: this.walkSpeed,
        turn: this.turnRate,
        digging: this.digPulse,
        carrying: 0,
      });
      /*
       * Feet AFTER the gait, every frame. The gait poses her legs from the
       * body's frame alone and cannot know what the ground is doing, so
       * without this her feet sink into every rise she walks over and hang
       * above every hollow — and into her own diggings most of all, which is
       * the one place the lab guarantees the ground is not flat.
       */
      /*
       * The floor below the POINT ASKING, not the top of the world and not the
       * floor below her body. In a burrow the first two differ by the whole
       * depth of it, which is what used to convince the guard she was buried
       * and heave her out through the ceiling; the second two differ by
       * whatever a foot has strayed from her centre, which in a shaft narrower
       * than her stance means a foot in the wall asking about open air.
       *
       * A step of headroom, so ground she could climb onto is still findable.
       */
      const under = (x: number, z: number, y: number): number =>
        this.groundAt(x, z, y + STEP_UP);
      // Only the LAG goes on the segments; the whole body is already pointed
      // down the bore by `orientQueen`.
      this.queen.leanSegments(
        this.thoraxPitch - this.headPitch, this.gasterPitch - this.thoraxPitch,
      );
      /*
       * The tripod stepper decides where her feet ARE; the solver only bends
       * the legs to reach. Underground the gait is not walking her anywhere —
       * she is being driven along a bore — so the anchors are dropped and the
       * legs fall back to terrain-following, which is what they were doing
       * before and is right for a body that is swimming through soil.
       */
      const anchors = this.stepFeet(delta);
      /*
       * On a climb the solver works in her frame: elevations run along the
       * surface normal, and "the ground under a joint" is a cast in through
       * the bark rather than a column through the sky.
       */
      const girth = Math.max(0.2, this.queen.bodyRadius());
      const solveFrame = this.gripping ? {
        up: [this.climbUp.x, this.climbUp.y, this.climbUp.z] as
          readonly [number, number, number],
        surface: (x: number, y: number, z: number): number => {
          CAST_FROM.set(x, y, z).addScaledVector(this.climbUp, STEP_UP);
          CAST_DIR.copy(this.climbUp).negate();
          const hit = this.castBarrier(CAST_FROM, CAST_DIR, STEP_UP + girth * 2);
          const upv = this.climbUp;
          if (!hit) return x * upv.x + y * upv.y + z * upv.z;
          return hit.x * upv.x + hit.y * upv.y + hit.z * upv.z;
        },
      } : undefined;
      this.footPenetration = this.queen.solveFeet(
        under, FOOT_CLEARANCE, FOOT_PLANT_BAND,
        anchors ? (slot) => anchors.get(slot) ?? null : undefined,
        solveFrame,
      );
      /*
       * The fail-safe, after everything else has had its go: whatever the
       * solvers did, nothing she is made of may be under the ground. It lifts
       * the whole model rather than bending anything, which is blunt on
       * purpose — a fail-safe with opinions is a fail-safe with its own bugs.
       *
       * A lift that is doing steady visible work means something is missing a
       * solver, so it is reported next to the foot correction rather than
       * quietly applied. That is how the antennae were found: nothing owned
       * them, because they are not legs.
       */
      /*
       * The guard asks whether a point is IN the soil, not whether it is under
       * the surface. Near the wall of a shaft those are different questions
       * and only the first one has a sensible answer.
       */
      this.poseBystanders(delta);
      this.guardLift = this.queen.groundGuard((x, y, z) => {
        PROBE.set(x, y, z);
        if (!this.barrierAt(PROBE)) return 0;
        if (this.gripping) {
          // Escape is along HER up — off the bark, not toward the sky.
          for (let d = CELL_SIZE; d <= STEP_UP * 2; d += CELL_SIZE) {
            GUARD_P.copy(PROBE).addScaledVector(this.climbUp, d);
            if (!this.barrierAt(GUARD_P)) return d;
          }
          return STEP_UP * 2;
        }
        return Math.max(0, this.groundAt(x, z, y) - y + FOOT_CLEARANCE);
      });
      this.queen.root.position.copy(this.antPosition)
        .addScaledVector(this.gripping ? this.climbUp : WORLD_UP, this.guardLift);
    }
    /*
     * The camera looks at her BODY, not at her feet. `antPosition` is her
     * ground contact, so framing on it puts her in the top of the shot and
     * points the collision probe straight into the floor.
     */
    this.follow.up.copy(this.up);
    /*
     * What `auto` switches on. Digging counts as under before she is buried:
     * the moment the bore is armed you want to be looking down it, and waiting
     * for soil to close over her head flips the view halfway into the stroke.
     */
    this.follow.submerged = this.underground || this.bore.digging;
    /*
     * The first-person view looks where the DIAL is aimed, not where her body
     * has got to — so the moment you nudge the pitch you are already looking at
     * the soil you are about to take, rather than watching her three-second
     * lean catch up with the decision.
     */
    this.follow.aimPitch = this.gripping
      ? Math.asin(THREE.MathUtils.clamp(this.climbForward.y, -1, 1))
      : this.bore.pitch;
    /*
     * Her head comes off the picture when the camera is INSIDE it and she is
     * under the ground — the one case where her own skull is the whole view.
     * Above ground the first-person eye still sees her jaws and antennae in
     * frame, which is worth keeping: it is how you tell where the bite lands.
     * The shadow keeps its head either way; see `showHead`.
     */
    if (this.queenReady) {
      /*
       * The dig room's whole trick is that there is nothing to clip: a
       * camera and a capsule. So while the view is from inside her head AND
       * the dig is live — armed, or genuinely under the land — the model
       * goes away entirely and the lab IS the dig room. Above ground in
       * first person by choice she keeps her jaws and antennae in frame,
       * which is how you tell where a bite will land.
       */
      const capsule = this.follow.firstPerson && (this.underground || this.bore.digging);
      this.queen.root.visible = !capsule;
      this.queen.showHead(!(this.follow.firstPerson && this.underground));
    }
    this.follow.target.copy(this.antPosition).addScaledVector(this.up, CAMERA_LOOK_AT);
    // The eye hangs off her BODY; only the third-person look target is lifted.
    this.follow.body.copy(this.antPosition);
    this.follow.update(
      delta, this.facing, (point) => this.barrierAt(point), CELL_SIZE * 2,
      // The land as seen from the sky — crater rims and the treetop count.
      (x, z) => this.groundAt(x, z, CELLS_Y * CELL_SIZE),
    );
    /*
     * The instruments, from the same numbers the physics runs on: depth is
     * the wedged measure's own subtraction, the tunnel length is integrated
     * from her true velocity while the button is down, soil is the carve's
     * tally. The HUD wears the first-person view only — over the shoulder,
     * the animal itself is the instrument.
     */
    if (bore.digging && !this.wasCutting) this.dugDistance = 0;
    if (bore.digging) this.dugDistance += this.walkSpeed * delta;
    this.wasCutting = bore.digging;
    this.digHud.visible = this.follow.firstPerson;
    // The stat block yields to the instruments — dimmed, not removed, so the
    // debugging numbers stay reachable and the smoke can still read them.
    this.status.style.opacity = this.follow.firstPerson ? '0.28' : '';
    this.digHud.update({
      headingDeg: this.facing * 180 / Math.PI,
      pitchDeg: this.bore.pitch * 180 / Math.PI,
      digMm: this.dugDistance * WORLD_UNIT_MM,
      depthMm: Math.max(0, (
        streamGroundHeight(this.antPosition.x, this.antPosition.z) - this.antPosition.y
      ) * WORLD_UNIT_MM),
      gsMmS: this.walkSpeed * WORLD_UNIT_MM,
      soilMm3: this.totalRemoved * WORLD_UNIT_MM ** 3,
      cutting: bore.digging,
    });
    this.updatePellets(delta);
    if (this.sun) {
      this.sun.position.set(
        this.antPosition.x + WINDOW_SIZE * 0.5,
        SOIL_DEPTH + WINDOW_SIZE * 0.7,
        this.antPosition.z + WINDOW_SIZE * 0.34,
      );
      this.sun.target.position.copy(this.antPosition);
      this.sun.target.updateMatrixWorld();
    }
  }

  /** Advance the simulation deterministically. For the smoke test only. */
  stepForTest(delta: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(delta);
  }

  private animate = (): void => {
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.previousTime) / 1000);
    this.previousTime = now;
    this.simulate(delta);
    this.drainPending(now - this.previousFrameStart);
    this.previousFrameStart = now;
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
