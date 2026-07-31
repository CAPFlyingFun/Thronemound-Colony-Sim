import * as THREE from 'three';
import { QueenModel } from '../anim/QueenModel';
import { BoreRig, DIG_YAW_RATE, YAW_RATE } from './BoreControl';
import { clampStickOrigin, stickVector } from '../voxel/locomotion';
import { FollowCamera, type CameraMode } from './FollowCamera';
import { TripodGait } from '../anim/tripod';
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

/**
 * How far a first-person look-drag must travel to click the pitch dial one
 * ten-degree step.
 *
 * The dial is discrete and the drag is not, so something has to decide where
 * the notches are. Matching the step to the angle itself would make the aim
 * one-to-one with the view, which sounds right and is not: you would be unable
 * to look at the ceiling without aiming at it.
 */
const AIM_PER_STEP = 0.28;

/** How much one nudge moves the first-person eye, in world units. */
const EYE_NUDGE = 0.5 / WORLD_UNIT_MM;
/** Where the eye may be placed, either side of her origin. */
const EYE_RANGE = 12 / WORLD_UNIT_MM;
/** Local-storage key for the camera settings, so a placement survives a reload. */
const CAMERA_PREFS = 'thronemound.lab.camera';

/** Scratch for the camera sight-line march, so it allocates nothing. */
const PROBE = new THREE.Vector3();
const SPEED_EASE = 7;

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
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 250);
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
  private readonly queen = new QueenModel('queen');
  private queenReady = false;
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
  /** The tripod walk. Rebuilt when she leaves the ground, null while boring. */
  private gait: TripodGait | null = null;
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
  private readonly input = { yaw: 0, walk: 0 };
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
  /** Look-drag accumulated toward the next pitch notch. See `AIM_PER_STEP`. */
  private aimDrag = 0;
  /** True once the player has moved the eye, so the rig default stops applying. */
  private eyePlaced = false;
  private repaintCamera: (() => void) | null = null;
  private readonly walkButton: HTMLButtonElement;
  private readonly gaugeAnt: HTMLSpanElement;
  private readonly gaugeRead: HTMLDivElement;
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
    this.scene.add(this.queen.root);
    void this.queen.load().then((ok) => {
      /*
       * A handle for the smoke test, and the reason it is worth having: "is
       * she the right size" cannot be answered from a screenshot, and it
       * cannot be answered from the constants either, because the scale is
       * applied to a model whose own proportions live in the glb. Measured
       * through here, her front foot to her rear foot spans 1.815 world units
       * — 9.07 mm against the 9 mm `CASTE_LENGTH_MM` asks for.
       *
       * The same measurement settled which way she faces: her mouth bone sits
       * at z = +0.82 and her gaster at z = -0.63, so her head is toward +Z and
       * `forward = (sin f, 0, cos f)` points where she is actually going. From
       * the side, at the lab's camera angle, +Z and -X look identical.
       */
      (window as unknown as { labScene?: unknown }).labScene = this;
      this.queenReady = ok;
      if (!ok) this.status.dataset.message = 'Queen model failed to load';
      // The rig has to exist before its head can be found, so the first-person
      // default is seated here rather than when the panel was built.
      this.seatEyeOnHead();
      this.updateStatus();
    });

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
      <div class="density-lab-hint">Set pitch with △▽ · press BORE once to arm it · W/S then moves you along that pitch (A/D steers) · RUN toggles pace</div>
      <div class="density-lab-gauge" aria-live="off">
        <div class="density-lab-gauge-dial"><span class="density-lab-gauge-ant"></span></div>
        <div class="density-lab-gauge-read">0\u00b0</div>
      </div>
      <div class="density-lab-actions"></div>
    `;
    host.appendChild(hud);

    const status = hud.querySelector<HTMLDivElement>('.density-lab-status');
    const actions = hud.querySelector<HTMLDivElement>('.density-lab-actions');
    const dial = hud.querySelector<HTMLSpanElement>('.density-lab-gauge-ant');
    const read = hud.querySelector<HTMLDivElement>('.density-lab-gauge-read');
    if (!status || !actions || !dial || !read) {
      throw new Error('Density terrain lab HUD failed to initialize');
    }
    this.gaugeAnt = dial;
    this.gaugeRead = read;
    this.status = status;

    this.digButton = document.createElement('button');
    this.digButton.className = 'density-lab-button density-lab-dig';
    this.digButton.textContent = 'BORE';
    this.digButton.setAttribute('aria-label', 'Hold to bore along the heading');
    actions.appendChild(this.digButton);

    /*
     * Pitch is set here and nowhere else, in ten-degree steps, so it can be
     * dialled in and read off the gauge. It is a setting, not a stick.
     */
    const aim = document.createElement('div');
    aim.className = 'density-lab-aim';
    for (const [glyph, label, steps] of [['\u25b3', 'aim up', 1], ['\u25bd', 'aim down', -1]] as const) {
      const button = document.createElement('button');
      button.className = 'density-lab-aimkey';
      button.textContent = glyph;
      button.setAttribute('aria-label', label);
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.bore.aim(steps);
        this.updateStatus();
      });
      aim.appendChild(button);
    }
    actions.insertBefore(aim, this.digButton);

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
    this.digButton.addEventListener('pointerdown', this.onDigPointerDown);
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
    this.digButton.removeEventListener('pointerdown', this.onDigPointerDown);
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
   * The dig control is a LATCH, not a trigger.
   *
   * Pressed once it arms the head; pressed again it stows it. Held-to-dig was
   * the first spelling and it fought the joystick, because both hands were
   * then doing continuous work for one action — and it made "pressing Dig will
   * not automatically move you" impossible to express, since the only way to
   * dig was to be holding something.
   */
  private readonly onDigPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.bore.toggleDig();
    this.updateStatus();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === 'Space') {
      event.preventDefault();
      this.bore.toggleDig();
      this.updateStatus();
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
  private stance(worldX: number, worldZ: number): { height: number; up: any } {
    const reach = (CASTE_LENGTH_MM.queen / WORLD_UNIT_MM) * STANCE;
    const from = this.antPosition.y + STEP_UP;
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
    return {
      height: ranked[2]!,
      up: new THREE.Vector3(-(east - west), 2 * reach, -(north - south)).normalize(),
    };
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
  private get underground(): boolean {
    PROBE.copy(this.antPosition).addScaledVector(this.up, CAMERA_LOOK_AT * 2);
    return this.solidAt(PROBE);
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
    const floor = this.groundAt(
      this.antPosition.x, this.antPosition.z, this.antPosition.y + FOOT_CLEARANCE,
    );
    if (this.antPosition.y < floor - FOOT_CLEARANCE) {
      // Lifted OUT of the floor: she is holding whatever height the bore gave
      // her, and the floor is a lower bound.
      const ease = 1 - Math.exp(-HEIGHT_EASE * dt);
      this.antPosition.y += (floor - this.antPosition.y) * ease;
      this.fallSpeed = 0;
    } else {
      /*
       * And DROPPED onto it when the bore has left her over open space.
       *
       * This branch used to do nothing at all, which is most of "the ant
       * floating in space": drive a shaft, break through into the hollow you
       * cut a minute ago, and there is no floor under you — so she held the
       * height the bore last gave her, indefinitely, in mid-air. A tunnel is
       * exactly the place a game makes holes for a body to fall down.
       */
      this.applyGravity(dt, floor);
    }
    if (!this.queenReady) return;
    this.queen.root.position.copy(this.antPosition);
    this.orientQueen();
  }

  private stand(dt: number): void {
    const ground = this.stance(this.antPosition.x, this.antPosition.z);
    if (this.antPosition.y - ground.height > FALL_FROM) {
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
    if (this.bore.digging || this.underground) {
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
    const states = this.gait.step(dt, {
      position: [this.antPosition.x, this.antPosition.y, this.antPosition.z],
      heading: this.facing,
      speed: this.walkSpeed,
    }, ground);
    const out = new Map<string, readonly [number, number, number]>();
    for (const state of states) out.set(state.slot, state.target);
    return out;
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
    const aimed = Math.abs(this.headPitch) > 1e-6;
    const up = aimed ? WORLD_UP : this.up;
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
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
  private travel(dt: number, pitch: number, digging: boolean): void {
    const ease = 1 - Math.exp(-SPEED_EASE * dt);
    const throttle = this.input.walk;
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));

    // Down the WORLD's pitch, matching the gauge. Built on the terrain normal
    // this drifted with the slope, so a dial reading minus ninety drove her
    // along a hillside instead of into it.
    const heading = digging
      ? forward.clone().multiplyScalar(Math.cos(pitch))
        .addScaledVector(WORLD_UP, Math.sin(pitch)).normalize()
      : forward;
    const wanted = heading.multiplyScalar(this.speed * throttle);

    this.velocity.lerp(wanted, ease);
    this.walkSpeed = this.velocity.length();
    if (throttle === 0 && this.walkSpeed < 1e-3) {
      this.velocity.set(0, 0, 0);
      this.walkSpeed = 0;
      return;
    }
    this.glide(dt, digging);
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

  /**
   * The pitch gauge: the number, and an ant tipped to the angle she will bore
   * at. A dial is worth having because the pitch is a SETTING now — you dial
   * it in before you commit, and reading it off the stat block is not the same
   * as seeing which way she is pointed.
   */
  private updateGauge(): void {
    const degrees = Math.round(this.bore.pitch * 180 / Math.PI);
    this.gaugeRead.textContent = `${degrees}\u00b0`;
    /*
     * The needle points the way she will go, so level reads LEVEL.
     *
     * The glyph has to be a rightwards arrowhead for that. It was an upwards
     * one, which put an unrotated needle straight up at 0 degrees \u2014 a dial
     * reading "level" while pointing at the sky \u2014 and swung it to horizontal at
     * minus ninety, exactly a quarter turn wrong the whole way round.
     */
    this.gaugeAnt.style.transform = `rotate(${-degrees}deg)`;
    this.gaugeRead.dataset.digging = this.bore.digging ? 'on' : 'off';
  }

  private updateStatus(): void {
    this.updateGauge();
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
      + `${this.bore.digging ? ' · DIG ON' : ''} · ${this.running ? 'run' : 'crawl'}<br>
      Queen: ${this.queenReady
        ? `${CASTE_LENGTH_MM.queen} mm · feet ${(this.footPenetration * WORLD_UNIT_MM).toFixed(2)} mm`
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
      this.aimDrag += dy * LOOK_PER_PIXEL;
      while (this.aimDrag >= AIM_PER_STEP) { this.bore.aim(-1); this.aimDrag -= AIM_PER_STEP; }
      while (this.aimDrag <= -AIM_PER_STEP) { this.bore.aim(1); this.aimDrag += AIM_PER_STEP; }
      this.updateGauge();
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
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.lastPinch = 0;
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
    const bore = this.bore.step(delta, { yaw: this.input.yaw, forward: this.input.walk });
    this.facing = bore.heading;

    /*
     * The head leads and the body follows it. Rate-limited rather than eased,
     * so ninety degrees always takes the same three seconds however far she has
     * to go — an exponential ease would make a ten-degree change nearly
     * instant and a ninety-degree one never quite finish.
     */
    const swing = (Math.PI / 2) / PITCH_SWING_SECONDS * delta;
    this.headPitch += THREE.MathUtils.clamp(bore.pitch - this.headPitch, -swing, swing);
    this.thoraxPitch += THREE.MathUtils.clamp(
      this.headPitch - this.thoraxPitch, -swing * THORAX_RATE, swing * THORAX_RATE,
    );
    this.gasterPitch += THREE.MathUtils.clamp(
      this.thoraxPitch - this.gasterPitch, -swing * GASTER_RATE, swing * GASTER_RATE,
    );
    this.turnRate = this.input.yaw * (bore.digging ? DIG_YAW_RATE : YAW_RATE);
    // She travels along the pitch her BODY has reached, not the one the dial
    // is set to — otherwise she would dive before she had finished turning to
    // face the dive.
    this.travel(delta, this.headPitch, bore.digging);
    /*
     * With the dig armed she is committed to the hole, whether or not there is
     * yet soil over her head. `stand` puts her on the surface, and while she is
     * cutting the first few millimetres of a shaft that is a tug of war she
     * always wins and the shaft never starts — measured as her rising two
     * millimetres over six seconds of driving straight down.
     */
    if (bore.digging || this.underground) this.holdTunnel(delta);
    else this.stand(delta);
    if (bore.bite) this.carveAlongBore(this.headPitch);
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
      this.footPenetration = this.queen.solveFeet(
        under, FOOT_CLEARANCE, FOOT_PLANT_BAND,
        anchors ? (slot) => anchors.get(slot) ?? null : undefined,
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
      this.guardLift = this.queen.groundGuard((x, y, z) => {
        PROBE.set(x, y, z);
        if (!this.solidAt(PROBE)) return 0;
        return Math.max(0, this.groundAt(x, z, y) - y + FOOT_CLEARANCE);
      });
      this.queen.root.position.y = this.antPosition.y + this.guardLift;
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
    this.follow.target.copy(this.antPosition).addScaledVector(this.up, CAMERA_LOOK_AT);
    this.follow.update(
      delta, this.facing, (point) => this.solidAt(point), CELL_SIZE * 2,
    );
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
