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
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';
import { CASTE_LENGTH_MM, stanceRadius } from '../anim/hexapod';
import { buildNestView, type NestView } from '../nest/nestView';
import { NestDesigner } from '../nest/NestDesigner';
import { planBounds } from '../nest/nestCarve';
import { addNode } from '../nest/nestEdit';
import { type NestPlan } from '../nest/nestPlan';
import { chamberBox, chamberNorm, type ChamberBox } from './ChamberMovement';
import { BoreRig } from './BoreControl';
import { DebugStatsPanel } from './DebugStatsPanel';
import { LoadingOverlay } from './LoadingOverlay';
import { SENSE_EASE, makeSensed, type SenseUniforms } from './undergroundSense';
import { IslandStream, type IslandScrollReport } from '../world/IslandStream';
import { SurfaceWalker } from '../world/surfaceWalk';
import { makeIslandSoil, type IslandSoil } from '../world/islandSoil';
import {
  loadBiomeTextures, makeBiomeMaterial, type BiomeTextureSet,
} from '../world/islandBiome';
import {
  CAP_PLANES, CELLS_Y, CELL_SIZE, MM, SAMPLES_Y, TILE_CELLS, WINDOW_CELLS,
  WINDOW_MM, WINDOW_BYTES,
} from '../world/worldScape';

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
const WALK_SPEED = 3;
const SPRINT = 3;
const TURN_RATE = 2.4;
const RIDE = 1.3 / MM;

/* Scratch space for the per-frame hot paths (rail, pose, camera) —
 * allocated once and reused, so a minute of riding feeds the garbage
 * collector nothing (the GC pauses read as hitches on the playtest PC). */
const S_PERP = new THREE.Vector3();
const S_RAD = new THREE.Vector3();
const S_CENTER = new THREE.Vector3();
const S_TARGET = new THREE.Vector3();
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
const SCROLL_COOLDOWN_MS = 150;

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

/** The smoothing brush's reach, and the ends of its slider, in mm. */
const SMOOTH_RADIUS_DEFAULT_MM = 10;
const SMOOTH_RADIUS_MIN_MM = 4;
const SMOOTH_RADIUS_MAX_MM = 30;

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
const AIM_LIMIT = 1.4;

/** The room camera starts blending in at norm 1.25 (~3 mm out) and is all
 *  the way in by 0.75 — distance-driven, so walking pace sets the feel. */
const CHAMBER_CAM_FAR = 1.25;
const CHAMBER_CAM_NEAR = 0.75;

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

  readonly input = { walk: 0, yaw: 0, dig: false, sprint: false };

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

  private brushRow: HTMLDivElement | null = null;

  /** The smoothing brush's radius, in millimetres — the slider's value. */
  private brushMm = SMOOTH_RADIUS_DEFAULT_MM;

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

  /** How far the third-person camera is swung off her tail by a drag; it
   *  decays back to zero, which is how the view returns behind her. */
  private camYaw = 0;

  private camPitch = 0.5;

  private camDist = 30 / MM;

  private firstPerson = false;

  private fpPitch = 0;

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

  private underground = false;

  /** Her recent path — the underground chase camera follows THIS, because
   *  the path she walked is guaranteed to be inside the tunnel. */
  private readonly trail: THREE.Vector3[] = [];

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
  private worker: QueenModel | null = null;

  private workerReady = false;

  private readonly workerAnchor = new THREE.Vector3();

  private workerJig = 0;

  private showPlan = true;

  private readonly stats = {
    fps: 0,
    frames: 0,
    fpsAt: performance.now(),
    scrolls: 0,
    lastScrollMs: 0,
    rebases: 0,
  };

  private readonly hud: HTMLElement;

  /** The telemetry, folded behind a small STATS chip (collapsed default). */
  private readonly statsPanel: DebugStatsPanel;

  /** The full-screen curtain that hides the raw start-up. */
  private readonly loading: LoadingOverlay;

  private stickPointer: number | null = null;

  private lookPointer: number | null = null;

  private readonly stickOrigin = { x: 0, y: 0 };

  private readonly stickEl = document.createElement('div');

  private readonly stickKnob = document.createElement('div');

  private readonly crosshair = document.createElement('div');

  private aimReadout: HTMLElement | null = null;

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

    this.scene.background = new THREE.Color(0x9cc4e0);
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
    });

    (window as unknown as { islandScene?: unknown }).islandScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.animate();
  }

  private async load(): Promise<void> {
    this.loading.setStatus('Preparing the island…');
    const url = `${import.meta.env.BASE_URL}kauai-1025.bin`;
    const [raw, textures] = await Promise.all([
      (await fetch(url)).arrayBuffer(),
      loadBiomeTextures(import.meta.env.BASE_URL),
    ]);
    this.loading.setStatus('Raising the island…');
    this.heights = new Int16Array(raw);
    this.heightsBase = this.heights.slice();
    this.textures = textures;
    /* BOTH surfaces band by the stride-1 data slope (aGroundNy): the
     * island's LOD rings and the soil window then agree on where rock
     * meets sand, instead of each mesh reading its own normals. */
    this.islandMaterial = makeBiomeMaterial(textures, this.clip, true);
    this.soilMaterial = makeBiomeMaterial(textures, undefined, true);
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
        snap: 14,
        gravity: 9,
      },
    );
    this.remeshEverything();
    this.clipToWindow();

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
    }).finally(() => {
      this.queenSettled = true;
      this.playerReady = true;
      void this.loading.finish();
    });
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
  private soilDensityAt(x: number, y: number, z: number): number {
    const fine = this.stream?.densityAtWu(x, y, z);
    if (fine !== null && fine !== undefined) return fine;
    return this.walkGroundAt(x, z) - y;
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
    const probe = new THREE.Vector3();
    const REACH = BODY_HALF_TALL * 2 + BODY_FLOOR_MARGIN;
    const STEPS = 14;
    return {
      up: [up.x, up.y, up.z] as const,
      surface: (x: number, y: number, z: number): number => {
        const elevOf = (px: number, py: number, pz: number) => px * up.x + py * up.y + pz * up.z;
        /* Feel DOWN her own up until the soil starts, and report where it
         * started. Nothing found means open tube — she keeps her stance. */
        for (let i = 0; i <= STEPS; i += 1) {
          const t = (i / STEPS) * REACH;
          probe.set(x - up.x * t, y - up.y * t, z - up.z * t);
          if (this.soilDensityAt(probe.x, probe.y, probe.z) > 0) {
            return elevOf(probe.x, probe.y, probe.z);
          }
        }
        return elevOf(x, y, z) - REACH;
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
      orig[v] = this.groundHeightAt(wx, wz) * MM;
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

  private clipToWindow(): void {
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
    const bore = this.bore.step(dt, {
      yaw: -this.input.yaw,
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
    /* Kept in step for everything that still wants a compass bearing — the
     * scroll's look-ahead, the trail's fallback — and derived, never set. */
    this.facing = Math.atan2(this.fwd.x, this.fwd.z);
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
    this.moveSurface(dt, speed);

    this.underground = this.at.y + RIDE
      < this.walkGroundAt(this.at.x, this.at.z) - UNDER_MM / MM;

    this.questTick(dt);

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
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(this.at) > 0.3) {
      this.trail.push(this.at.clone());
      if (this.trail.length > 240) this.trail.shift();
    }

    if (this.stream) {
      // Soil leaves at the bottom of the stroke, not on the button — and
      // which stroke it is depends on which tool the shovel is holding.
      if (bore.bite) this.bite();

      /* The builder digs on a BUTTON, not on a frame: `digPiece` is called
       * straight from the palette's chips. Nothing to do per-frame here. */

      const lead = Math.min(LEAD_MAX, Math.abs(speed) * LEAD_S);
      const now = performance.now();
      if (now - this.lastScrollAt > SCROLL_COOLDOWN_MS) {
        const scroll = this.stream.recentreOn(
          this.at.x + Math.sin(this.facing) * lead,
          this.at.z + Math.cos(this.facing) * lead,
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
        if (performance.now() - meshStart > 6) break;
      }
      this.reveal();
    }

    /* The crossover is deliberately not instant: breaking the surface is
     * one of the moments this game has, and half a second of contours
     * resolving into daylight is the whole of the effect. */
    if (this.sense) {
      this.sense.uSense.value += ((this.underground ? 1 : 0) - this.sense.uSense.value)
        * (1 - Math.exp(-SENSE_EASE * dt));
    }
    this.refreshAim();
    this.pose(dt);
    // While the designer is up the camera is ITS fly rig, not the follow cam.
    if (!this.designer?.isOpen) this.aimCamera(dt);
  }

  /* ------------------------------------------------ chambers and the modes */

  /** The angle she is pointed, in degrees, live. */
  private refreshAim(): void {
    if (!this.aimReadout) return;
    const deg = Math.round((this.aimPitch * 180) / Math.PI);
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
  private moveSurface(dt: number, speed: number): void {
    const walker = this.walker;
    if (!walker) return;
    const span = SPAN_MM / MM;

    /* The step is along her NOSE, which is already square to her up — so on
     * a wall it runs up the wall and on a ceiling it runs along the ceiling,
     * with no component trying to push her through either. */
    this.at.addScaledVector(this.fwd, speed * dt);
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
    walker.settle({ at: this.at, up: this.up, forward: this.fwd }, dt, aimDt);

    /*
     * The safety net is smaller than it was, because most of what it caught
     * cannot happen any more: there is no "off the modelled window" — the
     * density answers everywhere — and no "no floor below at this x,z",
     * because below is wherever she is standing. What is left is genuinely
     * being inside soil, which the walker's own embedded case handles first
     * and this only backs up.
     */
    if (this.soilDensityAt(this.at.x, this.at.y, this.at.z) > 0) {
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
     * PITCHED IN HER OWN FRAME, not the world's. The aim used to be built
     * out of a compass bearing and a world-vertical rise, which is only the
     * same thing while she is the right way up. Standing on a wall, "aim up
     * ten degrees" meant ten degrees toward the sky rather than ten degrees
     * off the wall she is on — so the crosshair left the tunnel. Her nose
     * and her up are already an orthonormal pair; the aim is a rotation
     * between them, and on level ground it reduces to exactly what it was.
     */
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
    centre.copy(this.at).addScaledVector(aim, hull);

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

    // One remesh for the whole face, not seven.
    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
    const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
    for (let cz = lo(minZ); cz <= hi(maxZ, CHUNKS_XZ); cz += 1) {
      for (let cy = lo(minY); cy <= hi(maxY, CHUNKS_Y); cy += 1) {
        for (let cx = lo(minX); cx <= hi(maxX, CHUNKS_XZ); cx += 1) {
          this.enqueue(cx, cy, cz);
        }
      }
    }
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
    const hull = NOSE_REACH + JAW_PAST_NOSE;

    /* The CUT, as the pair of scoops it actually removes — wide and low,
     * her real mouthful shape, because a round marker would promise a
     * hole of entirely the wrong proportions. */
    const span = (SCOOP_DEEP_MM * 2) / MM;
    S_FWD.copy(aim);
    S_RIGHT.set(S_FWD.z, 0, -S_FWD.x);
    if (S_RIGHT.lengthSq() < 1e-6) S_RIGHT.set(1, 0, 0);
    S_RIGHT.normalize();
    S_UP.crossVectors(S_RIGHT, S_FWD).normalize();
    const cut = this.toolGhost;
    cut.visible = true;
    cut.quaternion.setFromRotationMatrix(S_MAT.makeBasis(S_RIGHT, S_UP, S_FWD));
    cut.scale.set(SCOOP_WIDE_MM / 2 / MM, SCOOP_TALL_MM / 2 / MM, span / 2);
    cut.position.copy(this.at)
      .addScaledVector(aim, hull + span / 2 - SCOOP_DEEP_MM / 2 / MM);

    /* And the SHAVE around it, which is what the slider sizes. Fainter,
     * because it only rounds off what the cut leaves — it is the halo of
     * the stroke, not the stroke. */
    const halo = this.smoothGhost;
    halo.visible = true;
    halo.quaternion.identity();
    halo.scale.setScalar(this.brushMm / MM);
    halo.position.copy(this.at).addScaledVector(aim, hull);
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
      /* Her ground speed is the whole of it now, not its horizontal shadow:
       * running up a shaft wall, `hypot(vx, vz)` is near zero and the gait
       * read her as standing still while she climbed. */
      speed: this.velocity.length(),
      turn: -this.input.yaw * TURN_RATE,
      digging: this.input.dig ? 1 : 0,
      carrying: 0,
      headYaw: 0,
    });
    /* And her FEET are solved in that frame too. The solver has always
     * taken one; the island had been passing `undefined` and letting it
     * measure every foot as a height above sea level, which on a wall asks
     * a question the wall has no answer to. `boreFrame` casts along her own
     * up, so a foot on a ceiling is planted on the ceiling. */
    this.queen.solveFeet(
      (x, z, y) => this.footingFrom(x, z, y),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
      undefined,
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
    const lift = this.queen.groundGuard((x, y, z) => {
      if (this.soilDensityAt(x, y, z) <= 0) return 0;
      for (let d = BONE_CLEARANCE; d <= RIDE * 2; d += BONE_CLEARANCE) {
        if (this.soilDensityAt(
          x + up.x * d, y + up.y * d, z + up.z * d,
        ) <= 0) return d;
      }
      return RIDE * 2;
    });
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
     * THE ORBIT'S PITCH IS EASED ONCE, FOR EVERY VIEW.
     *
     * It used to be computed at the BOTTOM of this function, past both the
     * first-person and the underground returns — so underground, the orbit
     * drag turned the yaw and the pitch stayed at whatever it was last
     * left at on the surface. One place, before the branches, and every
     * camera that reads `camPitch` reads a live one.
     *
     * The camera FOLLOWS the aim, in both directions and at full gain.
     * It was `0.28 + max(0, -aimPitch)`: point her down and the view
     * climbs so you are looking along the line she will cut — right, and
     * only half the job, because that `max(0, …)` threw away every upward
     * aim. Dropping the clamp (and NOT rescaling) keeps downward feeling
     * exactly as it always did and gives upward the same one back.
     */
    const wantPitch = Math.min(1.35, Math.max(0.06, 0.28 - this.aimPitch));
    this.camPitch += (wantPitch - this.camPitch) * Math.min(1, dt * 3);
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
      const fwd = S_FWD.copy(this.fwd);
      const upv = S_UP.copy(this.up);
      const dir = this.boreAim();
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
      const base = S_CENTER.copy(this.at).addScaledVector(upv, EYE_RISE);
      const eye = base.clone();
      for (let t = 1; t > 0.001; t -= 0.2) {
        const px = base.x + dir.x * EYE_FORWARD * t;
        const py = base.y + dir.y * EYE_FORWARD * t;
        const pz = base.z + dir.z * EYE_FORWARD * t;
        const blocked = this.soilDensityAt(px, py, pz) > 0
          || this.soilDensityAt(px + dir.x * EYE_SKIN, py + dir.y * EYE_SKIN,
            pz + dir.z * EYE_SKIN) > 0;
        if (!blocked) { eye.set(px, py, pz); break; }
      }
      this.camera.position.copy(eye);
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
      this.camera.up.copy(fwd).multiplyScalar(-Math.sin(this.fpPitch))
        .addScaledVector(upv, Math.cos(this.fpPitch));
      this.liftCameraClear();
      /* Aim from where the lens ACTUALLY ended up. The guard above may have
       * nudged it out of a roof, and looking at a target measured from the
       * old spot tilts the whole view by however far it moved — a pitch
       * that drifts on its own every time she brushes a ceiling. */
      const lens = this.camera.position;
      this.camera.lookAt(lens.x + dir.x, lens.y + dir.y, lens.z + dir.z);
      return;
    }
    if (this.underground) {
      /*
       * The tunnel chase: the camera follows HER PATH, a few millimetres
       * back — the path she walked is the one line guaranteed to lie inside
       * the bore, so following it needs no pathfinding and can never end up
       * inside a wall. A held drag OVERRIDES the view with a tight orbit —
       * the capsule keeps following her, the player just turns it — and
       * letting go hands it back to the trail.
       */
      /*
       * THE ROOM CAMERA rides on top of the chase: from ~3 mm outside a
       * chamber the view starts easing off the trail and onto a post under
       * the room's ceiling that turns to face her — so a room reads as a
       * PLACE the camera inhabits, not another stretch of tube — and the
       * same distance eases it back out on the way to the door. Distance
       * sets the target, time smooths the move.
       */
      let roomShare = 0;
      let roomBox: ChamberBox | null = null;
      for (const node of this.soil?.plan.nodes ?? []) {
        if (node.kind !== 'chamber') continue;
        const box = chamberBox(
          node.x / MM, node.y / MM, node.z / MM, node.radiusMm / MM,
        );
        const u = chamberNorm(box, this.at.x, this.at.y, this.at.z);
        const t = Math.min(1, Math.max(0,
          (CHAMBER_CAM_FAR - u) / (CHAMBER_CAM_FAR - CHAMBER_CAM_NEAR)));
        if (t > roomShare) { roomShare = t; roomBox = box; }
      }
      this.chamberCam += (roomShare - this.chamberCam) * Math.min(1, dt * 3);

      const desired = new THREE.Vector3();
      if (this.lookPointer !== null) {
        desired.copy(this.at).addScaledVector(this.orbitBack(S_PERP), 1.2);
      } else {
        desired.copy(this.trailPointBehind(1.0));
        /* Off her BACK. In a shaft she is on the wall and her back points
         * sideways; adding to world Y there lifts the chase camera into the
         * roof instead of holding it off her. */
        desired.addScaledVector(this.up, 0.32);
      }
      if (roomBox && this.chamberCam > 0.01) {
        desired.lerp(new THREE.Vector3(
          roomBox.cx, roomBox.cy + roomBox.ry * 0.55, roomBox.cz,
        ), this.chamberCam);
      }
      this.camera.position.lerp(desired, Math.min(1, dt * 9));
      /*
       * AND NEVER INSIDE THE WALL. A burrow is barely wider than she is —
       * eight millimetres for a nine millimetre ant — so there is no room
       * behind her for a chase camera to sit, and it ended up buried in
       * the soil looking at the inside of her own tunnel. Her PATH is the
       * one line certain to be clear, so a camera that finds itself in
       * solid walks back along it toward her until it is not.
       */
      for (let i = 0; i < 6; i += 1) {
        if (this.soilDensityAt(
          this.camera.position.x, this.camera.position.y, this.camera.position.z,
        ) <= 0) break;
        this.camera.position.lerp(this.at, 0.3);
      }
      this.liftCameraClear();
      this.camera.up.copy(this.up);
      const eyed = S_TARGET.copy(this.at).addScaledVector(this.up, 0.15);
      this.camera.lookAt(eyed.x, eyed.y, eyed.z);
      return;
    }
    /* The drag swings the arm off her tail and it decays back to zero, so
     * the camera returns behind her without ever holding an absolute world
     * bearing — which is the thing that stops meaning anything on a wall. */
    if (this.lookPointer === null) this.camYaw -= this.camYaw * Math.min(1, dt * 2.4);
    this.camera.position.copy(this.at)
      .addScaledVector(this.orbitBack(S_PERP), this.camDist);
    /* Over her shoulder the camera wants real air between it and the hill,
     * not just the lens's own skin — a shot grazing the grass reads as a
     * bug even when nothing is clipping. Pushed out along her up, because
     * on a wall "off the ground" is not "higher". */
    for (let i = 0; i < 8; i += 1) {
      const p = this.camera.position;
      if (this.soilDensityAt(
        p.x - this.up.x * 0.6, p.y - this.up.y * 0.6, p.z - this.up.z * 0.6,
      ) <= 0) break;
      p.addScaledVector(this.up, 0.12);
    }
    this.liftCameraClear();
    this.camera.up.copy(this.up);
    const look = S_TARGET.copy(this.at).addScaledVector(this.up, 0.4);
    this.camera.lookAt(look.x, look.y, look.z);
  }

  /**
   * The orbit arm, built in HER frame: back along her nose, swung off it by
   * the drag, and raised by the pitch — all about her own up.
   *
   * The old arm was `(sin camYaw, 0, cos camYaw)` with a world-vertical
   * rise, which is a rig bolted to the horizon. Underground the horizon is
   * not a thing she has: in a shaft her up is horizontal, and a camera that
   * insists on world vertical sits in the wall looking at dirt.
   */
  private orbitBack(into: THREE.Vector3): THREE.Vector3 {
    const nose = S_RAD.copy(this.fwd).applyAxisAngle(this.up, this.camYaw);
    return into.copy(nose).negate().multiplyScalar(Math.cos(this.camPitch))
      .addScaledVector(this.up, Math.sin(this.camPitch)).normalize();
  }

  /** A point `distance` back along her walked path (or straight behind her
   *  when the trail is still short). */
  private trailPointBehind(distance: number): THREE.Vector3 {
    let left = distance;
    let previous = this.at;
    for (let i = this.trail.length - 1; i >= 0; i -= 1) {
      const point = this.trail[i]!;
      const seg = previous.distanceTo(point);
      if (seg >= left) {
        return previous.clone().lerp(point, seg === 0 ? 0 : left / seg);
      }
      left -= seg;
      previous = point;
    }
    return this.at.clone().addScaledVector(this.fwd, -distance);
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
      dig.classList.toggle('is-grip', this.digMode);
      this.scoopBtn!.style.display = this.digMode ? '' : 'none';
      this.brushRow!.style.display = this.digMode ? '' : 'none';
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
     * HOW BIG THE SHAVE IS, on a slider, because the right answer depends
     * on whether you are easing one lip or a whole chamber floor and no
     * single constant is both.
     */
    const brushRow = document.createElement('div');
    brushRow.className = 'density-lab-subrow';
    brushRow.style.display = 'none';
    const brushLabel = document.createElement('span');
    brushLabel.className = 'density-lab-aim-readout';
    brushLabel.textContent = `${this.brushMm} mm`;
    const brush = document.createElement('input');
    brush.type = 'range';
    brush.min = String(SMOOTH_RADIUS_MIN_MM);
    brush.max = String(SMOOTH_RADIUS_MAX_MM);
    brush.step = '1';
    brush.value = String(this.brushMm);
    brush.className = 'density-lab-brush';
    brush.addEventListener('input', () => {
      this.brushMm = Number(brush.value);
      brushLabel.textContent = `${this.brushMm} mm`;
    });
    // The slider owns its own drags; without this the look-drag steals them.
    for (const stop of ['pointerdown', 'pointermove', 'pointerup']) {
      brush.addEventListener(stop, (e) => { e.stopPropagation(); });
    }
    brushRow.appendChild(brush);
    brushRow.appendChild(brushLabel);
    this.brushRow = brushRow;
    actions.insertBefore(brushRow, actions.firstChild);



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
      this.input.sprint = k.has('shift');
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
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.designer?.isOpen) { this.designer.handlePointerMove(e); return; }
      if (e.pointerId === this.stickPointer) {
        const dx = Math.max(-48, Math.min(48, e.clientX - this.stickOrigin.x));
        const dy = Math.max(-48, Math.min(48, e.clientY - this.stickOrigin.y));
        this.input.yaw = Math.abs(dx / 48) < 0.12 ? 0 : dx / 48;
        this.input.walk = Math.abs(dy / 48) < 0.12 ? 0 : -dy / 48;
        this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (e.pointerId === this.lookPointer) {
        if (this.firstPerson) {
          /* Her own eyes: the drag turns HER, and the glance IS the
           * aim — one number, so view and dig can never disagree about
           * which way she is pointed. */
          /* The rig is turned and nothing else: `simulate` reads the step
           * off it and applies it about her own up, so a look-drag on a
           * ceiling turns her along the ceiling. Writing `facing` here as
           * well would fight that for a frame. */
          this.bore.turn(-e.movementX * 0.004);
          this.aimPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
            this.aimPitch - e.movementY * 0.004));
          this.fpPitch = this.aimPitch;
        } else {
          // Third person: the drag pans the view — above ground a full
          // orbit, underground a tight override the trail cam resumes from
          // the moment the finger lifts.
          /* Over her shoulder the vertical drag AIMS HER, and the camera
           * elevation follows that aim, so what you are looking along is
           * always the line she will cut. */
          /* An OFFSET off her tail, bounded to half a turn either way — it
           * decays back to zero, which is how the view swings home. */
          this.camYaw = Math.max(-Math.PI, Math.min(Math.PI,
            this.camYaw - e.movementX * 0.005));
          this.aimPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
            this.aimPitch - e.movementY * 0.004));
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
      this.stickKnob.style.transform = 'translate(0px, 0px)';
      this.stickEl.style.display = 'none';
    };
    const release = (e: PointerEvent) => {
      if (this.designer?.isOpen) { this.designer.handlePointerUp(e); return; }
      if (e.pointerId === this.stickPointer) dropStick();
      if (e.pointerId === this.lookPointer) {
        this.lookPointer = null;
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
      band floor ${this.stream?.bandFloorMm ?? 0} m · scrolls ${this.stats.scrolls}
      (${this.stats.rebases} rebases) · last ${this.stats.lastScrollMs.toFixed(0)} ms<br>
      at (${(this.at.x * MM / 1000).toFixed(1)}, ${(this.at.z * MM / 1000).toFixed(1)}) m ·
      ${memory ? `heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB · ` : ''}fps ${this.stats.fps}
      @ ${this.pixelRatioNow.toFixed(2)}x
    `);
  }

  /* --------------------------------------------------------------- loop */

  private animate = (): void => {
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
    if (this.worker) return;
    this.workerAnchor.copy(this.at);
    this.worker = new QueenModel('worker');
    this.worker.root.visible = false;
    this.scene.add(this.worker.root);
    void this.worker.load().then((ok) => {
      this.workerReady = ok;
      if (this.worker) this.worker.root.visible = ok;
    });
  }

  private poseWorker(dt: number): void {
    if (!this.worker || !this.workerReady) return;
    this.workerJig += dt;
    const angle = this.workerJig * 0.55;
    const r = 1.1;
    const x = this.workerAnchor.x + Math.sin(angle) * r;
    const z = this.workerAnchor.z + Math.cos(angle) * r;
    const y = this.footingAt(x, z);
    this.worker.root.position.set(x, y + RIDE * 0.5, z);
    this.worker.root.rotation.set(0, angle + Math.PI / 2, 0);
    this.worker.update(dt, {
      speed: r * 0.55,
      turn: 0.55,
      digging: 0,
      carrying: 0,
      headYaw: 0,
    });
    this.worker.solveFeet(
      (px, pz) => this.footingAt(px, pz),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
    );
  }

  setPausedForTest(on: boolean): void { this.paused = on; }

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
    this.trail.length = 0;
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
      workerOut: this.worker && this.workerReady ? 1 : 0,
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
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.host.removeEventListener(name, this.refuseGesture);
    }
    this.statsPanel.dispose();
    this.designer?.dispose();
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.islandMaterial?.dispose();
    this.soilMaterial?.dispose();
    if (this.textures) for (const tex of Object.values(this.textures)) tex.dispose();
    this.nestView?.dispose();
    this.queen.dispose();
    this.worker?.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
