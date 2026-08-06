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
import {
  chamberBox, chamberNorm, insideChamber, type ChamberBox,
} from './ChamberMovement';
import { BoreRig } from './BoreControl';
import { DebugStatsPanel } from './DebugStatsPanel';
import { LoadingOverlay } from './LoadingOverlay';
import { IslandStream, type IslandScrollReport } from '../world/IslandStream';
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
const S_TAN = new THREE.Vector3();
const S_PERP = new THREE.Vector3();
const S_RAD = new THREE.Vector3();
const S_CENTER = new THREE.Vector3();
const S_TARGET = new THREE.Vector3();
const S_FWD = new THREE.Vector3();
const S_UP = new THREE.Vector3();
const S_RIGHT = new THREE.Vector3();
const S_MAT = new THREE.Matrix4();
const S_QUAT = new THREE.Quaternion();

/** The tallest ledge she steps up in one stride; anything higher is a WALL
 *  and blocks her — the fix for walking "through" tunnel ends. */
const CLIMB_STEP = 2.5 / MM;

/** Pressed against a wall with the stick held, she climbs it slowly —
 *  enough to scale the nest's shaft and get back out of a dug hole. */
const CLIMB_RATE = 2.4;

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
 * One mouthful, in world units: her MANDIBLE, not her tunnel.
 *
 * 1.75 mm for a queen, from `CASTE_BITE_MM` where it was tuned against the
 * models. A worker's is 0.75 and a major's 2.5, and a major out-digging a
 * queen is most of the point of a major.
 */
const BITE_WIDTH_MM = 1.75;
const BITE_DEPTH_MM = 0.5;

/**
 * A mouthful is a SCOOP, not a ball.
 *
 * 1.75 mm across and half a millimetre deep — her mandibles closing on a
 * face, not a sphere the width of her head vanishing out of the hillside.
 * Cutting a 1.75 mm RADIUS sphere took three and a half millimetres of soil
 * per bite, seven times the depth of the real thing, which is why tunnels
 * appeared out of nowhere.
 *
 * A sphere still does the cutting, because that is what the field
 * subtracts; it is simply set BACK so only the front of it breaks the
 * surface. Radius from the chord: a sphere of radius r cutting depth d
 * leaves a mouth of width w where r = (w²/4 + d²) / 2d.
 */
const BITE_RADIUS = ((BITE_WIDTH_MM * BITE_WIDTH_MM) / 4 + BITE_DEPTH_MM * BITE_DEPTH_MM)
  / (2 * BITE_DEPTH_MM) / MM;

/** How far behind the face its centre sits, so it only cuts BITE_DEPTH. */
const BITE_SETBACK = BITE_RADIUS - BITE_DEPTH_MM / MM;

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

/**
 * HER BODY, as the space she needs rather than as a point.
 *
 * A centre-point test is what let her wear her tunnels: the point fits
 * anywhere, so she squeezed through holes half her width and the model
 * clipped the walls. These are the oval she actually occupies — as long as
 * her body, as wide as her legs, as tall as her tallest point — and if that
 * oval does not fit, she does not go there.
 *
 * Fallbacks only. The real numbers are measured off the loaded model in
 * `measureBody`, because a rig is the honest source for how big she is.
 */
const BODY_HALF_LEN = (CASTE_LENGTH_MM.queen / 2) / MM;
const BODY_HALF_WIDE = stanceRadius();
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

const BODY_SHELL: number[][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [0.6, 0.6, 0], [0.6, -0.6, 0], [-0.6, 0.6, 0], [-0.6, -0.6, 0],
  [0, 0, 0],
];

/** Riding TOWARD a gate this close ASKS whether to surface. Riding away
 *  never asks, however close she passes — the heading is what makes the
 *  question worth asking, and what kept the old prompt from nagging. */
const SURFACE_ASK_MM = 3;

/** A declined gate goes quiet until she is this far from it again. */
const GATE_RESET_MM = 8;

/** Chamber-norm threshold (1 = the carved shell): the rail lets go once
 *  its centerline point is this far inside the room, and does not reach
 *  for her again until she has walked back out through the shell — which
 *  is the hysteresis that stops a grab/release flicker at the mouth. */
const CHAMBER_RELEASE_NORM = 0.55;

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

  /** Half-extents of the oval she occupies: along her body, across her
   *  legs, and up to her tallest point. Measured from the model on load. */
  private readonly body = {
    len: BODY_HALF_LEN, wide: BODY_HALF_WIDE, tall: BODY_HALF_TALL,
  };

  /** True from the first stroke until she is back out in the open — while
   *  it holds, travel follows the bore's line, so letting go of the button
   *  means "stop", not "level out and grind into the wall". */
  private boreEngaged = false;

  private readonly keysDown = new Set<string>();

  private spaceWasDown = false;

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

  /** The nest plan as rails: centerline segments with bore radii (wu). */
  private rails: { a: THREE.Vector3; b: THREE.Vector3; r: number; from: string; to: string }[] = [];

  private readonly railNodes = new Map<string,
  { p: THREE.Vector3; kind: string; r: number }>();

  /** GRIP is the law of the tunnels: railEdge >= 0 IS the GRIP state, and
   *  it engages itself whenever she is underground near a planned bore.
   *  FREE exists only where it is safe — the surface, or inside a room. */
  private railEdge = -1;

  private railT = 0;

  private railDir: 1 | -1 = 1;

  private readonly railForward = new THREE.Vector3(0, 0, 1);

  private readonly railUp = new THREE.Vector3(0, 1, 0);

  /** Vertical-bore reverse latch: true while the back-pedal that already
   *  turned her around is still held, so it only turns her ONCE. */
  private railRev = false;

  /** The remembered wall she crawls in a plumb shaft, where gravity picks
   *  no floor — unit vector, kept perpendicular to the current bore. */
  private readonly railWall = new THREE.Vector3(1, 0, 0);

  /** The room she is loose in, or null. Set when the rail hands her into a
   *  chamber (and when free walking carries her into one); cleared when a
   *  mouth grabs her back or she surfaces. */
  private chamberId: string | null = null;

  /** The room camera's share of the underground view, eased 0..1. */
  private chamberCam = 0;

  /** The nearest gate on her current bore, refreshed by moveOnRail: how
   *  far along the tube it is, and whether she is riding AT it. */
  private railGate: { id: string; distMm: number; toward: boolean } | null = null;

  /** The question on screen, if any. Nothing crosses the threshold in
   *  either direction without an answer to it. */
  private gateAsk: { kind: 'enter' | 'surface'; gateId: string } | null = null;

  /** False from the moment a room takes her until she has stepped clear
   *  of its doorway — see chamberMouthGrab. */
  private chamberGrabArmed = false;

  /** Gates she has said no to, quiet until she is GATE_RESET_MM away. */
  private enterDeclined: string | null = null;

  private surfaceDeclined: string | null = null;

  private askEl: HTMLElement | null = null;

  private askLabel: HTMLElement | null = null;

  /** The GRIP / FREE indicator chip. */
  private modeBtn: HTMLButtonElement | null = null;

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

  /** Her oval, drawn — green while it fits, red where it does not. */
  private capsule: THREE.Mesh | null = null;

  /* On by default while the digging is being worked out: it is the thing
   * deciding where she may go, and a debug view you have to remember to
   * switch on is a debug view nobody sees. */
  private showCapsule = true;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
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
    this.islandMaterial = makeBiomeMaterial(textures, this.clip);
    this.soilMaterial = makeBiomeMaterial(textures);

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
    this.remeshEverything();
    this.clipToWindow();

    this.nestView = buildNestView(this.soil.plan);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.visible = this.showPlan;
    this.scene.add(this.nestView.root);

    // The plan's graph doubles as the underground RAIL network.
    this.rebuildRails();

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
      if (ok) this.measureBody();
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
    const lid = this.ventLidAt(x, z, fromY);
    if (lid !== null) return lid;
    const stream = this.stream;
    if (!stream) return null;
    const fine = stream.surfaceBelowY(x, z, fromY);
    if (fine === null) return null;
    const ceiling = stream.bandFloorWu + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
    if (fine >= ceiling - CELL_SIZE) return Math.max(fine, this.walkGroundAt(x, z));
    return fine;
  }

  /**
   * A MOUTH IS A LID UNTIL SHE SAYS OTHERWISE.
   *
   * The vent is a real hole bored through the anthill, so the walker fell
   * straight down it: walking west to east across her own nest dropped her
   * fifty millimetres down the shaft without a word. Reported as being
   * teleported underground, and fairly — she never asked to go in.
   *
   * So from ABOVE, a mouth reads as ground at the gate's own height. She
   * can stand on her anthill and walk over it, and the ENTER? question is
   * what opens it. From below there is no lid at all — this only answers
   * something coming down ONTO the mouth — so riding up the shaft and
   * surfacing is untouched.
   */
  private ventLidAt(x: number, z: number, fromY: number): number | null {
    for (const node of this.railNodes.values()) {
      if (node.kind !== 'entrance') continue;
      const dx = x - node.p.x;
      const dz = z - node.p.z;
      if (dx * dx + dz * dz > node.r * node.r) continue;
      // Only for a body standing ON the mouth, never one already below it,
      // or the lid would form under her feet while she is in the shaft.
      if (fromY < node.p.y + RIDE) continue;
      return node.p.y;
    }
    return null;
  }

  /**
   * THE WAY OUT OF A ROOM IS ITS DOORWAY, WHEREVER THAT IS.
   *
   * Inside a chamber the rail keeps its hands off, or every edge — they
   * all run to the room's centre — would glue her to the middle of her own
   * room. But that left the room a pit: a chamber whose only tunnel leaves
   * through the CEILING, which is exactly what the designer's PLACE chain
   * builds (each piece dropped straight below the last), has its doorway
   * above the middle of the floor, and no amount of walking or wall-
   * climbing gets a body up to it. Reported as being stuck in a room, and
   * it was — the containment was only half of that bug.
   *
   * So the rail is offered again at the DOORWAY: the point where each
   * tunnel crosses out through the room's shell. A tunnel that leaves
   * sideways has its doorway in the wall, and she walks to it. One that
   * leaves upward has its doorway in the ceiling, and she stands under it.
   * Measured horizontally, so "under the hole in the roof" counts as being
   * at it, which is the whole point. The doorway sits at norm ~1 and the
   * rail only lets go below 0.55, so grabbing there cannot flicker.
   */
  private chamberMouthGrab(roomId: string): { i: number; t: number; d: number } | null {
    const room = this.railNodes.get(roomId);
    if (!room || room.kind !== 'chamber') return null;
    const box = chamberBox(room.p.x, room.p.y, room.p.z, room.r);
    let best: { i: number; t: number; d: number } | null = null;
    for (let i = 0; i < this.rails.length; i += 1) {
      const e = this.rails[i]!;
      const atFrom = e.from === roomId;
      if (!atFrom && e.to !== roomId) continue;
      for (let k = 1; k <= 24; k += 1) {
        const t = atFrom ? k / 24 : 1 - k / 24;
        const px = e.a.x + (e.b.x - e.a.x) * t;
        const py = e.a.y + (e.b.y - e.a.y) * t;
        const pz = e.a.z + (e.b.z - e.a.z) * t;
        if (chamberNorm(box, px, py, pz) <= 1) continue;
        // The doorway. How far is she from standing in it, on the floor?
        const d = Math.hypot(this.at.x - px, this.at.z - pz);
        if (!best || d < best.d) best = { i, t, d };
        break;
      }
    }
    /*
     * ARMED BY LEAVING IT. On arrival the rail sets her down a stride
     * inside the room — still within reach of the doorway she just came
     * through — so an unguarded test grabbed her back on the very frame it
     * released her, and she hovered in the entrance instead of walking
     * into her own room. Tightening the reach only traded that for a
     * doorway she could no longer find on the way out.
     *
     * So the doorway goes live once she has been properly clear of it, and
     * one reach serves both directions: step in, it arms behind her; come
     * back to it, it takes her.
     */
    if (!best) return null;
    const reach = this.rails[best.i]!.r * 1.6;
    if (best.d > reach) {
      this.chamberGrabArmed = true;
      return null;
    }
    return this.chamberGrabArmed ? best : null;
  }

  /** The mouth she is standing on, if any — what ENTER? asks about. */
  private gateUnderfoot(): string | null {
    for (const [id, node] of this.railNodes) {
      if (node.kind !== 'entrance') continue;
      const dx = this.at.x - node.p.x;
      const dz = this.at.z - node.p.z;
      if (dx * dx + dz * dz > node.r * node.r) continue;
      if (this.at.y < node.p.y - RIDE) continue;
      return id;
    }
    return null;
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
   * HER FRAME IN A BURROW — which way is up for her, and where the surface
   * under a point is measured ALONG that up.
   *
   * On open ground up is world vertical and a foot falls to a height. In a
   * tunnel neither is true: she is inside a tube, her up is whatever her
   * body is pressed against, and the surface under a foot may be a wall or
   * a ceiling. The solver has always been able to take this frame; the
   * island simply never gave it one, so her legs went on solving against a
   * floor that was not underneath her — and she could not climb out.
   */
  private boreFrame(): {
    up: readonly [number, number, number];
    surface: (x: number, y: number, z: number) => number;
  } {
    const aim = this.boreAim();
    /* Perpendicular to the way she is pointed, in the vertical plane that
     * contains it: level in a level drift, and tipping over as she climbs
     * so a shaft is walked up its wall rather than fallen down. */
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(aim, -aim.y);
    if (up.lengthSq() < 1e-4) up.set(-Math.sin(this.facing), 0, -Math.cos(this.facing));
    up.normalize();
    const stream = this.stream;
    const probe = new THREE.Vector3();
    const REACH = (this.body.tall * 2) + BODY_FLOOR_MARGIN;
    const STEPS = 14;
    return {
      up: [up.x, up.y, up.z] as const,
      surface: (x: number, y: number, z: number): number => {
        const elevOf = (px: number, py: number, pz: number) => px * up.x + py * up.y + pz * up.z;
        if (!stream) return elevOf(x, this.walkGroundAt(x, z), z);
        /* Feel DOWN her own up until the soil starts, and report where it
         * started. Nothing found means open tube — she keeps her stance. */
        for (let i = 0; i <= STEPS; i += 1) {
          const t = (i / STEPS) * REACH;
          probe.set(x - up.x * t, y - up.y * t, z - up.z * t);
          if (stream.solidAtWu(probe.x, probe.y, probe.z) === true) {
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

  /**
   * THE OVAL, MADE VISIBLE.
   *
   * The fit test is the thing deciding where she may go, so when it
   * disagrees with what the screen shows there is no way to tell which is
   * wrong without seeing it. Drawn as the ellipsoid it actually is —
   * scaled to her measured half-extents, sat on her body rather than on
   * her feet, turned to her heading — and coloured by the live answer:
   * green where she fits, red where something is in the way.
   */
  private updateCapsule(): void {
    if (!this.showCapsule) {
      if (this.capsule) this.capsule.visible = false;
      return;
    }
    if (!this.capsule) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0x51e07a, wireframe: true, transparent: true, opacity: 0.55,
          depthTest: false,
        }),
      );
      mesh.renderOrder = 8;
      this.capsule = mesh;
      this.scene.add(mesh);
    }
    const mesh = this.capsule;
    mesh.visible = true;
    mesh.scale.set(this.body.wide, this.body.tall, this.body.len);
    const lift = Math.max(0, this.body.tall - RIDE) + BODY_FLOOR_MARGIN;
    mesh.position.set(this.at.x, this.at.y + lift, this.at.z);
    mesh.rotation.set(0, this.facing, 0);
    /*
     * Red only where the oval is what DECIDES. On open ground the walker
     * has her and her body genuinely overlaps the hillside she is standing
     * on — every slope and tussock read as a collision, so it was red most
     * of the time and meant nothing. Underground it gates her, and there
     * red is worth seeing.
     */
    const govern = this.boreEngaged;
    const fits = !govern || this.bodyFits(this.at);
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(
      !govern ? 0x6f8fa8 : (fits ? 0x51e07a : 0xe0553f),
    );
  }

  /** Which part of her oval is in the soil one step ahead — the wedge,
   *  named. -1 means she fits. For diagnosing a stuck dig. */
  blockedShellForTest(): { idx: number; aimY: number; stepMm: number } {
    const aim = this.boreAim();
    const next = this.at.clone().addScaledVector(aim, (3 * (1 / 30)));
    const fwd = S_FWD.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const right = S_RIGHT.set(fwd.z, 0, -fwd.x);
    const lift = Math.max(0, this.body.tall - RIDE) + BODY_FLOOR_MARGIN;
    let idx = -1;
    for (let i = 0; i < BODY_SHELL.length; i += 1) {
      const o = BODY_SHELL[i]!;
      const p = next.clone()
        .addScaledVector(fwd, o[0]! * this.body.len)
        .addScaledVector(right, o[1]! * this.body.wide);
      p.y += lift + o[2]! * this.body.tall;
      if (this.stream?.solidAtWu(p.x, p.y, p.z) === true) { idx = i; break; }
    }
    return { idx, aimY: aim.y, stepMm: (this.at.distanceTo(next)) * MM };
  }

  setCapsuleForTest(on: boolean): void { this.showCapsule = on; }

  /** Does her oval fit where she stands? For probing the wedge directly. */
  bodyFitsForTest(): { fits: number; engaged: number; under: number } {
    return {
      fits: this.bodyFits(this.at) ? 1 : 0,
      engaged: this.boreEngaged ? 1 : 0,
      under: this.underground ? 1 : 0,
    };
  }

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

  railStateForTest(): { edge: number; t: number; offMm: number; rMm: number } {
    if (this.railEdge < 0) return { edge: -1, t: 0, offMm: -1, rMm: 0 };
    const e = this.rails[this.railEdge]!;
    const center = e.a.clone().lerp(e.b, Math.min(1, Math.max(0, this.railT)));
    return {
      edge: this.railEdge,
      t: this.railT,
      offMm: center.distanceTo(this.at) * MM,
      rMm: e.r * MM,
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
    this.facing = bore.heading;
    if (bore.digging) this.boreEngaged = true;
    else if (!this.underground) this.boreEngaged = false;
    const speed = this.input.walk * WALK_SPEED * (this.input.sprint ? SPRINT : 1);
    this.velocity.set(Math.sin(this.facing) * speed, 0, Math.cos(this.facing) * speed);

    if (this.railEdge >= 0) {
      this.moveOnRail(dt, speed);
    } else if (this.boreEngaged) {
      /*
       * UNDERGROUND THERE IS NO FALLING.
       *
       * An ant in a burrow is not a thing balanced on a floor — it is
       * gripping the tube it is inside, and it walks up a shaft as readily
       * as along a drift. Running the surface walker down here gave her
       * gravity she should never have had: she dug a pit, dropped into it
       * the moment the jaws stopped, and then had nothing to climb with,
       * so she kept digging and kept sinking.
       *
       * So once she has BORED IN — and only then; a surface walk that dips
       * through a hollow must stay a walk — she travels along the line she
       * is pointed, up or down, and the only thing that may stop her is
       * her own body not fitting. Pull back and she retraces it, which is
       * how she gets out of anything she can get into.
       */
      this.moveBore(dt, speed);
    } else {
      this.moveFree(dt, speed);
    }

    this.underground = this.at.y + RIDE
      < this.walkGroundAt(this.at.x, this.at.z) - UNDER_MM / MM;

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
    this.chamberId = this.underground && this.railEdge < 0
      ? this.chamberAt(this.at)
      : null;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(this.at) > 0.3) {
      this.trail.push(this.at.clone());
      if (this.trail.length > 240) this.trail.shift();
    }

    /*
     * GRIP — playtest's own architecture, now the LAW of the tunnels:
     * underground she follows "a path right down the middle of the tube",
     * pitch locked to the tube's axis, roll irrelevant, the camera orbiting
     * the line. The nest plan IS that path — a graph of centerlines with
     * radii — so the moment she is underground and near a planned bore the
     * rail snaps her on, and the noisy free-walker pose that let her
     * abdomen swing through the shaft wall never runs down there at all.
     * There is no FREE in a bore any more; FREE lives on the surface and
     * inside rooms only. Loose in a room the rail keeps its hands off —
     * every edge into a chamber ends at its centre, so a bare proximity
     * test would glue her to the middle of her own room — and it picks her
     * up again the moment she walks out of the room's shell, by whichever
     * opening she used: a planned tunnel, or a hole she chewed herself.
     */
    if (this.railEdge < 0 && this.underground && this.rails.length > 0) {
      const take = this.chamberId === null
        ? this.nearestRail(this.at)
        : this.chamberMouthGrab(this.chamberId);
      if (take && take.d < this.rails[take.i]!.r * 1.6) {
        this.railEdge = take.i;
        this.railT = take.t;
        const e = this.rails[take.i]!;
        const tan = e.b.clone().sub(e.a).normalize();
        /* A shaft is ENTERED downward; a level bore takes whichever way
         * she faces. Her wall starts on the side she faced when the rail
         * took her. */
        /* A shaft is normally ENTERED downward, from its top. Leaving a
         * room through a doorway in the CEILING is the other case: the
         * grab point is above her, so travel has to run that way or the
         * rail would take her straight back down into the room she is
         * trying to leave. */
        const up = this.rails[take.i]!.a.clone().lerp(this.rails[take.i]!.b, take.t).y
          > this.at.y + RIDE;
        this.railDir = Math.abs(tan.y) > 0.7
          ? (up ? (tan.y > 0 ? 1 : -1) : (tan.y > 0 ? -1 : 1))
          : ((Math.sin(this.facing) * tan.x + Math.cos(this.facing) * tan.z) >= 0 ? 1 : -1);
        this.railRev = false;
        this.railWall.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      }
    }

    if (this.stream) {
      // Soil leaves at the bottom of the stroke, not on the button.
      if (bore.bite) this.bite();

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

    this.updateGateAsk();
    this.updateCapsule();
    this.refreshModeChip();
    this.pose(dt);
    // While the designer is up the camera is ITS fly rig, not the follow cam.
    if (!this.designer?.isOpen) this.aimCamera(dt);
  }

  /* ------------------------------------------------ chambers and the modes */

  /** Which room contains this point, if any. */
  private chamberAt(p: THREE.Vector3): string | null {
    for (const [id, node] of this.railNodes) {
      if (node.kind !== 'chamber') continue;
      const box = chamberBox(node.p.x, node.p.y, node.p.z, node.r);
      if (insideChamber(box, p.x, p.y, p.z)) return id;
    }
    return null;
  }

  /**
   * AUTO-SURFACE: riding TOWARD a gate arms the exit inside ~3 mm and lets
   * go at half a millimetre, placing her on the daylight surface beside the
   * mouth. Riding AWAY never surfaces her, however close she passes. The
   * old SURFACE? YES/NO prompt is gone — the heading is the answer.
   */
  private surfaceTo(gateId: string): void {
    const node = this.railNodes.get(gateId);
    if (!node) return;
    this.railEdge = -1;
    this.railGate = null;
    this.chamberId = null;
    /* Standing on her own mouth, the ENTER? question would fire the very
     * next frame. It stays quiet until she has walked away and come back. */
    this.enterDeclined = gateId;
    this.hideGateAsk();
    /* Beside the vent, not on it: dropped dead-centre she stands over the
     * hole she just left and sinks straight back in. Her travel direction
     * (or facing, up a plumb shaft) picks which side of the mound. */
    const out = new THREE.Vector3(this.railForward.x, 0, this.railForward.z);
    if (out.lengthSq() < 0.01) out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    out.normalize();
    const x = node.p.x + out.x * node.r * 1.6;
    const z = node.p.z + out.z * node.r * 1.6;
    /* ON the anthill, not inside it. Beside a gate the FINE soil carries
     * the real spoil heap, which stands proud of the coarse island grid
     * that `walkGroundAt` reads — planted at the grid height she arrives
     * buried in her own mound and the anti-embed net has to dig her out.
     * The streamed surface is the truth here; the grid is the fallback
     * for a column the window does not hold. */
    const fine = this.stream?.surfaceHeightAt(x, z);
    const top = fine === null || fine === undefined
      ? this.walkGroundAt(x, z)
      : Math.max(this.walkGroundAt(x, z), fine);
    this.at.set(x, top + RIDE, z);
    this.trail.length = 0;
  }

  /**
   * THE THRESHOLD IS ALWAYS A QUESTION.
   *
   * Nothing carries her between daylight and the nest on its own — not
   * walking over the vent, not riding into the gate. Above it she is asked
   * ENTER?; riding up to it she is asked SURFACE?; a no is remembered until
   * she is GATE_RESET_MM away, so it neither nags nor forgets.
   */
  private updateGateAsk(): void {
    if (this.designer?.isOpen) { this.hideGateAsk(); return; }

    if (this.railEdge >= 0) {
      const near = this.railGate;
      this.enterDeclined = null; // underground: the way IN is behind her
      if (!near) { this.hideGateAsk(); return; }
      if (near.distMm > GATE_RESET_MM && this.surfaceDeclined === near.id) {
        this.surfaceDeclined = null;
      }
      const ask = near.toward && near.distMm <= SURFACE_ASK_MM
        && this.surfaceDeclined !== near.id;
      this.showGateAsk(ask ? { kind: 'surface', gateId: near.id } : null);
      return;
    }

    this.surfaceDeclined = null; // on the surface: the way OUT is behind her
    const under = this.gateUnderfoot();
    if (under === null) {
      /* Off the mouth entirely — a declined gate re-arms once she has put
       * real distance between herself and it, not merely stepped aside. */
      if (this.enterDeclined !== null) {
        const node = this.railNodes.get(this.enterDeclined);
        if (!node || this.at.distanceTo(node.p) * MM > GATE_RESET_MM) {
          this.enterDeclined = null;
        }
      }
      this.showGateAsk(null);
      return;
    }
    this.showGateAsk(this.enterDeclined === under
      ? null
      : { kind: 'enter', gateId: under });
  }

  /** YES on ENTER?: down the vent and onto the bore below it. */
  private enterVia(gateId: string): void {
    const node = this.railNodes.get(gateId);
    if (!node) return;
    this.hideGateAsk();
    this.enterDeclined = null;
    /* Riding out again would be asked SURFACE? on the first frame, at the
     * gate she just came through. Quiet until she has gone somewhere. */
    this.surfaceDeclined = gateId;
    this.trail.length = 0;
    for (let i = 0; i < this.rails.length; i += 1) {
      const e = this.rails[i]!;
      const atFrom = e.from === gateId;
      if (!atFrom && e.to !== gateId) continue;
      this.railEdge = i;
      this.railT = atFrom ? 0 : 1;
      this.railDir = atFrom ? 1 : -1;
      this.railRev = false;
      this.railWall.set(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.at.copy(atFrom ? e.a : e.b);
      this.underground = true;
      this.chamberId = null;
      return;
    }
    /* A mouth with nothing dug under it yet: step off the lid into its own
     * vent and let the walker find the bottom. */
    this.at.set(node.p.x, node.p.y - node.r, node.p.z);
    this.underground = true;
  }

  answerGateForTest(yes: boolean): void { this.answerGate(yes); }

  gateAskForTest(): { kind: string; gateId: string; shown: boolean } | null {
    if (!this.gateAsk) return null;
    return {
      ...this.gateAsk,
      shown: this.askEl !== null && this.askEl.style.display !== 'none',
    };
  }

  private answerGate(yes: boolean): void {
    const ask = this.gateAsk;
    if (!ask) return;
    if (!yes) {
      if (ask.kind === 'enter') this.enterDeclined = ask.gateId;
      else this.surfaceDeclined = ask.gateId;
      this.showGateAsk(null);
      return;
    }
    if (ask.kind === 'surface') this.surfaceTo(ask.gateId);
    else this.enterVia(ask.gateId);
  }

  private showGateAsk(ask: { kind: 'enter' | 'surface'; gateId: string } | null): void {
    const same = this.gateAsk?.kind === ask?.kind
      && this.gateAsk?.gateId === ask?.gateId;
    this.gateAsk = ask;
    if (!this.askEl || !this.askLabel) return;
    if (!ask) { this.askEl.style.display = 'none'; return; }
    if (!same) this.askLabel.textContent = ask.kind === 'enter' ? 'ENTER?' : 'SURFACE?';
    this.askEl.style.display = '';
  }

  private hideGateAsk(): void { this.showGateAsk(null); }

  /** The GRIP/FREE chip is an INDICATOR — the states switch themselves, so
   *  the chip's whole job is to make the current one obvious. */
  private refreshModeChip(): void {
    if (!this.modeBtn) return;
    const grip = this.railEdge >= 0;
    const label = grip ? 'GRIP' : 'FREE';
    if (this.modeBtn.textContent !== label) this.modeBtn.textContent = label;
    this.modeBtn.classList.toggle('is-grip', grip);
  }

  /**
   * The free walker: walls are walls, holes are holes. The floor at the
   * DESTINATION is looked up from her own height downward: a tunnel floor
   * is a real floor, the roof above it is invisible to her, and a floor
   * more than one stride ABOVE her is a wall — the move is refused instead
   * of easing her up through the ceiling ("it bounced me back up").
   * Refused with the stick still held means she is pressing against the
   * wall, and she climbs it slowly — enough to get out of a dug pit.
   */
  private moveFree(dt: number, speed: number): void {
    const span = SPAN_MM / MM;
    const nx = Math.min(span - 2, Math.max(2, this.at.x + this.velocity.x * dt));
    const nz = Math.min(span - 2, Math.max(2, this.at.z + this.velocity.z * dt));
    const there = this.floorBelow(nx, nz, this.at.y + 0.5);
    /*
     * SHE HAS TO FIT. Finding a floor below the destination is not enough:
     * at tunnel joints the bores leave thin ribs of soil at body height
     * with an air pocket underneath, and "there's a floor down there" would
     * happily walk her centre INTO the rib. Embedded, the camera is inside
     * soil and the whole world renders see-through — playtest saw it as
     * "holes all over" and being "forced into the terrain". So a move
     * commits only when the air at her NEW centre (destination floor plus
     * ride height) is actually air.
     */
    /* Stepping UP means her new centre (floor + ride) must be air; moving
     * flat or DOWN means the destination must be air at her CURRENT height
     * — a floor far below with soil at body height is the rib trap, and
     * also exactly how she used to ghost sideways through walls. */
    const clearAt = (yy: number) => this.stream?.solidAtWu(nx, yy, nz) !== true;
    const fits = (floorY: number) => (floorY > this.at.y
      ? clearAt(floorY + RIDE)
      : clearAt(this.at.y + 0.1));
    let want: number;
    let blocked = false;
    if (there !== null) {
      if (there - this.at.y > CLIMB_STEP || !fits(there)) {
        blocked = true;
        want = this.at.y;
      } else {
        this.at.x = nx;
        this.at.z = nz;
        want = there + RIDE;
      }
    } else {
      const ground = this.walkGroundAt(nx, nz);
      if (ground - this.at.y <= CLIMB_STEP && fits(ground)) {
        this.at.x = nx;
        this.at.z = nz;
        want = ground + RIDE;
      } else {
        blocked = true;
        want = this.at.y;
      }
    }
    if (blocked && Math.abs(speed) > 0) {
      // Climbing needs HEADROOM: open air above her. In the shaft that is
      // true and she scales it; under a tunnel roof it is not, and she
      // stays put — going up through a ceiling is what DIG is for. (The
      // first cut skipped this check and she climbed through the hillside.)
      const overhead = this.stream?.solidAtWu(this.at.x, this.at.y + 0.5, this.at.z);
      if (overhead !== true) {
        this.at.y += CLIMB_RATE * dt;
        want = this.at.y;
      }
    }
    this.at.y += (want - this.at.y) * Math.min(1, dt * 14);
    /*
     * The safety net under all of it: if anything above still managed to
     * put her centre inside soil (rounding at a curved wall, an edit under
     * her feet), snap back to the last position that was provably in air
     * rather than let an embedded frame escape — one embedded frame is a
     * see-through world.
     */
    if (this.stream?.solidAtWu(this.at.x, this.at.y, this.at.z) === true) {
      // Three CONSECUTIVE solid frames means truly embedded. One frame is
      // usually the 1 mm rounding flickering while she hugs a curved wall —
      // snapping on it yanked her off the shaft wall mid-climb, every climb.
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

  /**
   * The rail: travel is a single parameter along the plan edge's
   * centerline. Pitch follows the tube's axis by construction, the joints
   * hand her from bore to bore by best tangent alignment, the gate node
   * hands her back to the free walker on the surface — and none of the
   * free walker's wall problems can exist here, because her position is
   * DERIVED from the centerline instead of tested against soil.
   */
  private moveOnRail(dt: number, speed: number): void {
    const e = this.rails[this.railEdge]!;
    const tan = S_TAN.copy(e.b).sub(e.a);
    const len = tan.length();
    tan.divideScalar(len);
    // Turning re-aims travel when her facing meaningfully agrees or
    // disagrees with the bore. A VERTICAL bore has no facing to steer
    // with, so the HEADING is the state: forward rides the way she faces
    // along the shaft, and pulling back TURNS HER AROUND — once. Release
    // and push forward again and she carries on the NEW way (playtest:
    // "as soon as I press W it doesn't continue that same direction").
    const align = Math.sin(this.facing) * tan.x + Math.cos(this.facing) * tan.z;
    let drive = speed;
    if (Math.abs(tan.y) > 0.7) {
      const reversing = speed < -1e-6;
      if (reversing && !this.railRev) this.railDir = this.railDir === 1 ? -1 : 1;
      this.railRev = reversing;
      drive = Math.abs(speed);
    } else {
      this.railRev = false;
      if (Math.abs(align) > 0.35) this.railDir = align >= 0 ? 1 : -1;
    }
    this.railT += (drive * this.railDir * dt) / len;

    if (this.railT > 1 || this.railT < 0) {
      const nodeId = this.railT > 1 ? e.to : e.from;
      const node = this.railNodes.get(nodeId);
      const travel = tan.clone().multiplyScalar(this.railT > 1 ? 1 : -1);
      if (node && node.kind === 'entrance') {
        /* The gate does not eject her: she parks at the joint and SURFACE?
         * decides. Riding into the end of the tube is not consent to be
         * put out in the open. */
        this.railT = Math.min(1, Math.max(0, this.railT));
        return;
      }
      let best = -1;
      let bestDot = 0.2;
      let bestStart = 0;
      let bestDir: 1 | -1 = 1;
      for (let i = 0; i < this.rails.length; i += 1) {
        if (i === this.railEdge) continue;
        const c = this.rails[i]!;
        let start: number;
        let dir: 1 | -1;
        if (c.from === nodeId) { start = 0; dir = 1; } else if (c.to === nodeId) { start = 1; dir = -1; } else continue;
        const ct = c.b.clone().sub(c.a).normalize().multiplyScalar(dir);
        const d = ct.dot(travel);
        if (d > bestDot) {
          best = i;
          bestDot = d;
          bestStart = start;
          bestDir = dir;
        }
      }
      if (best >= 0) {
        this.railEdge = best;
        this.railT = bestStart;
        /* railDir maps her INPUT onto the edge parameter. bestDir is the
         * parameter direction that CONTINUES the travel; when she is
         * riding backwards (walk < 0), the same continuation needs the
         * opposite mapping — without this she ping-ponged at every joint
         * on the way out (the playtest's suspected "- for a +", found).
         * A VERTICAL next edge runs on |speed| along the heading instead,
         * so there the continuation IS bestDir — and a held reverse was
         * already spent turning her, so the latch must not flip again. */
        const nt = this.rails[best]!;
        const ny = Math.abs(nt.b.y - nt.a.y) / nt.b.distanceTo(nt.a);
        if (ny > 0.7) {
          this.railDir = bestDir;
          this.railRev = speed < -1e-6;
        } else {
          this.railDir = speed < 0 ? (bestDir === 1 ? -1 : 1) : bestDir;
          this.railRev = false;
        }
      } else {
        this.railT = Math.min(1, Math.max(0, this.railT)); // dead end
      }
      return;
    }

    // She CRAWLS the bore, never floats in it: gravity settles her onto
    // the floor of a level tube; a plumb shaft — where gravity picks no
    // wall — keeps a REMEMBERED wall instead. Legs on the bore, back to
    // the centerline (playtest's screenshot spec: top of the ant at the
    // center point, legs away, crawling).
    const center = S_CENTER.copy(e.a).lerp(e.b, Math.min(1, Math.max(0, this.railT)));

    /* ARRIVING IN A ROOM: every edge into a chamber runs to its centre, so
     * "the point she rides is well inside the carved shell" is the moment
     * the tunnel has become the room. The rail lets go there and she is
     * FREE on the chamber floor — the tunnel's grip ends where the walls
     * stop being close. */
    for (const roomId of [e.from, e.to]) {
      const cn = this.railNodes.get(roomId);
      if (!cn || cn.kind !== 'chamber') continue;
      const box = chamberBox(cn.p.x, cn.p.y, cn.p.z, cn.r);
      if (chamberNorm(box, center.x, center.y, center.z) < CHAMBER_RELEASE_NORM) {
        this.railEdge = -1;
        this.chamberId = roomId;
        this.chamberGrabArmed = false;
        this.railGate = null;
        /* The hand-off must never strand her inside a rounding-thin wall:
         * her body lags the centerline by a frame of lerp. The centerline
         * point is air by construction — if her centre is not, take it. */
        if (this.stream?.solidAtWu(this.at.x, this.at.y, this.at.z) === true) {
          this.at.copy(center);
        }
        this.embedFrames = 0;
        this.lastSafe.copy(this.at);
        this.hasSafe = true;
        return;
      }
    }

    /* How near the nearest gate is, and whether she is riding AT it. This
     * only REPORTS — updateGateAsk turns it into the SURFACE? question and
     * a tap turns that into daylight. Distance is measured from her point
     * ON the centerline, not her body, which rides offset toward the floor
     * by nearly the bore radius and would never read as "3 mm close". */
    const step = drive * this.railDir;
    let gateId: string | null = null;
    let gateP: THREE.Vector3 | null = null;
    let dist = Infinity;
    for (const [id, gn] of this.railNodes) {
      if (gn.kind !== 'entrance') continue;
      const d = center.distanceTo(gn.p);
      if (d < dist) { dist = d; gateId = id; gateP = gn.p; }
    }
    this.railGate = gateId && gateP
      ? {
        id: gateId,
        distMm: dist * MM,
        toward: Math.abs(step) > 1e-6 && (tan.x * (gateP.x - center.x)
          + tan.y * (gateP.y - center.y)
          + tan.z * (gateP.z - center.z)) * Math.sign(step) > 0,
      }
      : null;
    /* Facing the way she travels, so an exit taken from here steps off on
     * the side she was heading for. */
    if (Math.abs(step) > 1e-6) S_FWD.copy(tan).multiplyScalar(Math.sign(step));

    const perp = S_PERP.set(0, -1, 0).addScaledVector(tan, tan.y);
    this.railWall.addScaledVector(tan, -this.railWall.dot(tan));
    if (this.railWall.lengthSq() < 0.05) {
      this.railWall.set(Math.sin(this.facing), 0, Math.cos(this.facing))
        .addScaledVector(tan, -align);
    }
    this.railWall.normalize();
    const level = perp.length(); // 1 in a level bore, 0 in a plumb shaft
    const rad = S_RAD.copy(perp)
      .addScaledVector(this.railWall, Math.max(0, 1 - level)).normalize();
    const target = S_TARGET.copy(center).addScaledVector(rad, Math.max(0, e.r - RIDE));
    this.at.lerp(target, Math.min(1, dt * 12));
    /* She FACES the way she is travelling: pulling back rides the bore the
     * other way and the model turns WITH it, instead of moonwalking with
     * the stick held forward (playtest caught her walking backwards). */
    if (Math.abs(drive) > 1e-6) {
      this.railForward.copy(tan).multiplyScalar(this.railDir * (drive < 0 ? -1 : 1));
    }
    this.railUp.copy(rad).multiplyScalar(-1);
    this.hasSafe = true;
    this.lastSafe.copy(this.at);
    this.embedFrames = 0;
  }

  /**
   * How big she actually is, off the rig rather than out of the air.
   *
   * Taken in her rest pose with her legs where they sit, so the width is a
   * real leg span and the height reaches her tallest point. The stance
   * radius is kept as a floor on the width: a bounding box drawn at one
   * instant can catch her mid-stride with her legs gathered, and a tunnel
   * cut to that would pinch her the moment she spread them again.
   */
  private measureBody(): void {
    const box = new THREE.Box3().setFromObject(this.queen.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.x) || size.x <= 0) return;
    this.body.len = Math.max(size.z / 2, BODY_HALF_LEN);
    this.body.wide = Math.max(size.x / 2, BODY_HALF_WIDE);
    this.body.tall = Math.max(size.y / 2, BODY_HALF_TALL);
  }

  /**
   * DOES SHE FIT HERE? The oval, not the point.
   *
   * Sampled on the shell of the oval rather than through its volume: what
   * traps her is soil at her edges — a roof on her back, a wall at her
   * shoulder — and the middle of her body is wherever the middle of the
   * tunnel is. Cheap enough to ask every frame, which is what it takes to
   * stop a body entering somewhere its own model cannot go.
   */
  private bodyFits(at: THREE.Vector3): boolean {
    const stream = this.stream;
    if (!stream) return true;
    const fwd = S_FWD.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const right = S_RIGHT.set(fwd.z, 0, -fwd.x);
    /*
     * Her oval is centred on her BODY, not on `at`, which is a point a ride
     * height above whatever she is standing on. Without the lift its belly
     * sits below her own feet, so the floor she is standing on counts as
     * soil in the way and she can never move anywhere at all.
     */
    /* Strictly ABOVE her feet, not level with them: a belly probe sitting
     * exactly on the floor samples the floor as soil in the way, and she
     * could never move anywhere at all. */
    const lift = Math.max(0, this.body.tall - RIDE) + BODY_FLOOR_MARGIN;
    const probe = S_TARGET;
    for (let i = 0; i < BODY_SHELL.length; i += 1) {
      const o = BODY_SHELL[i]!;
      probe.copy(at)
        .addScaledVector(fwd, o[0]! * this.body.len)
        .addScaledVector(right, o[1]! * this.body.wide);
      probe.y += lift + o[2]! * this.body.tall;
      if (stream.solidAtWu(probe.x, probe.y, probe.z) === true) return false;
    }
    return true;
  }

  /**
   * How far her oval reaches along an arbitrary direction.
   *
   * Exact for an axis-aligned ellipsoid, and the reason the face has to ask
   * at all: her body lies flat whatever the aim does, so a shaft driven
   * straight DOWN has to be cut as wide as she is LONG, while a level run
   * only has to clear her cross-section. Sizing the face off a fixed radius
   * cut a 3.4 mm slot for a 9 mm ant and left her nose and tail buried in
   * the floor, which read as digging that did nothing at all.
   */
  private bodyReach(dir: THREE.Vector3): number {
    const fwd = Math.sin(this.facing) * dir.x + Math.cos(this.facing) * dir.z;
    const right = dir.x * Math.cos(this.facing) - dir.z * Math.sin(this.facing);
    return Math.hypot(
      fwd * this.body.len, right * this.body.wide, dir.y * this.body.tall,
    );
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
    const cp = Math.cos(this.aimPitch);
    return new THREE.Vector3(
      Math.sin(this.facing) * cp, Math.sin(this.aimPitch), Math.cos(this.facing) * cp,
    );
  }

  /**
   * Travel along the bore's line, paced by the space she has cleared.
   *
   * No floor-following and no step limit down here: she is in a tube she
   * cut herself, and the only thing that may stop her is soil that is still
   * there. That check is what makes the jaws set the rate of tunnelling —
   * without it the stick drives her straight through the working face and
   * out the far side of the hill, and the digging becomes decoration.
   */
  private moveBore(dt: number, speed: number): void {
    if (Math.abs(speed) < 1e-6) return;
    const span = SPAN_MM / MM;
    const next = this.at.clone().addScaledVector(this.boreAim(), speed * dt);
    next.x = Math.min(span - 2, Math.max(2, next.x));
    next.z = Math.min(span - 2, Math.max(2, next.z));
    /* THE OVAL DECIDES. She goes where her body goes and nowhere else, so
     * a tunnel that has not been opened to her size simply stops her —
     * which is what makes the jaws, and not the stick, the thing that digs. */
    if (!this.bodyFits(next)) return;
    this.at.copy(next);
    this.lastSafe.copy(this.at);
    this.hasSafe = true;
    this.embedFrames = 0;
  }

  private nearestRail(p: THREE.Vector3): { i: number; t: number; d: number } | null {
    let best: { i: number; t: number; d: number } | null = null;
    const ap = new THREE.Vector3();
    const ab = new THREE.Vector3();
    for (let i = 0; i < this.rails.length; i += 1) {
      const e = this.rails[i]!;
      ab.copy(e.b).sub(e.a);
      ap.copy(p).sub(e.a);
      const t = Math.min(1, Math.max(0, ap.dot(ab) / ab.lengthSq()));
      const d = ap.addScaledVector(ab, -t).length();
      if (!best || d < best.d) best = { i, t, d };
    }
    return best;
  }

  /**
   * ONE MOUTHFUL. 1.75 mm across, half a millimetre deep, where she is
   * pointed — and that is the whole of what a stroke removes.
   *
   * Nothing here opens a tunnel. A bore is many times the width of a bite,
   * so a hole big enough to fit through is made by TAKING MORE BITES:
   * sweep the aim across the face and chew it out. The capsule is what
   * makes that necessary rather than optional — she cannot enter a space
   * her body does not fit, so a passage exists only once it has actually
   * been cut to size.
   *
   * This replaced a body-sized sweep that opened her whole oval every time
   * she moved. That made tunnels instantly, and it also made the mandible
   * decoration: about fifty cubic millimetres left per millimetre
   * travelled, against two thirds of one in a bite — ninety-nine parts in
   * a hundred of the digging had nothing to do with her jaws.
   */
  private bite(): void {
    const aim = this.boreAim();
    // Set back so the sphere's leading cap cuts BITE_DEPTH and no more.
    /* From her MOUTH: the front of her oval along the way she is pointed,
     * plus a whisker, plus the set-back that keeps the cut half a
     * millimetre deep. */
    const reach = this.bodyReach(aim) + JAW_PAST_NOSE + BITE_SETBACK;
    const centre = this.at.clone().addScaledVector(aim, reach);

    let touched = 0;
    let minX = Infinity; let minY = Infinity; let minZ = Infinity;
    let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
    const result = this.stream!.subtractSphere(centre, BITE_RADIUS);
    if (result.changedSamples > 0) {
      touched = result.changedSamples;
      const b = result.bounds;
      minX = b.minX; maxX = b.maxX;
      minY = b.minY; maxY = b.maxY;
      minZ = b.minZ; maxZ = b.maxZ;
    }
    if (touched === 0) return;

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

  /* ------------------------------------------------- the tunnel designer */

  /** The plan's graph IS the rail network — rebuilt whenever the plan is. */
  private rebuildRails(): void {
    if (!this.soil) return;
    this.railNodes.clear();
    for (const n of this.soil.plan.nodes) {
      this.railNodes.set(n.id, {
        p: new THREE.Vector3(n.x / MM, n.y / MM, n.z / MM),
        kind: n.kind,
        r: n.radiusMm / MM,
      });
    }
    this.rails = this.soil.plan.edges.map((edge) => ({
      a: this.railNodes.get(edge.from)!.p,
      b: this.railNodes.get(edge.to)!.p,
      r: edge.radiusMm / MM,
      from: edge.from,
      to: edge.to,
    }));
  }

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
    this.rebuildRails();
    /* Her rail may have been resized, moved or deleted: let go and let the
     * regrab find whatever bore is under her now. The room she stood in may
     * be gone too — it re-derives from her position next frame. */
    this.railEdge = -1;
    this.railRev = false;
    this.chamberId = null;
    this.boreEngaged = false;
    this.railGate = null;
    this.enterDeclined = null;
    this.surfaceDeclined = null;
    this.hideGateAsk();
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
    if (this.railEdge >= 0) {
      /* On the rail her BODY follows the bore: pitch is the tube's axis,
       * up points back at the centerline, roll is nothing — playtest's
       * spec, and the end of the abdomen-through-the-shaft-wall shots. */
      const fwd = S_FWD.copy(this.railForward).normalize();
      const up0 = S_UP.copy(this.railUp).addScaledVector(fwd, -this.railUp.dot(fwd));
      if (up0.lengthSq() < 0.05) up0.set(0, 1, 0).addScaledVector(fwd, -fwd.y);
      up0.normalize();
      const right = S_RIGHT.crossVectors(up0, fwd).normalize();
      this.queen.root.position.copy(this.at);
      /* Slerp instead of snap: turning to face the other way (and joint
       * hand-offs) reads as HER turning, not the model teleporting. */
      const railPose = S_QUAT.setFromRotationMatrix(S_MAT.makeBasis(right, up0, fwd));
      this.queen.root.quaternion.slerp(railPose, Math.min(1, dt * 10));
      this.queen.update(dt, {
        speed: Math.hypot(this.velocity.x, this.velocity.z),
        turn: -this.input.yaw * TURN_RATE,
        digging: this.input.dig ? 1 : 0,
        carrying: 0,
        headYaw: 0,
      });
      this.queen.solveFeet(
        (x, z, y) => this.footingFrom(x, z, y),
        FOOT_CLEARANCE_MM / MM,
        RIDE * 2,
      );
      return;
    }
    const probe = 2 / MM;
    const hx = (this.footingAt(this.at.x + probe, this.at.z)
      - this.footingAt(this.at.x - probe, this.at.z)) / (probe * 2);
    const hz = (this.footingAt(this.at.x, this.at.z + probe)
      - this.footingAt(this.at.x, this.at.z - probe)) / (probe * 2);
    const up = S_UP.set(-hx, 1, -hz).normalize();
    const forward = S_FWD.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    forward.addScaledVector(up, -forward.dot(up)).normalize();
    const right = S_RIGHT.crossVectors(up, forward).normalize();
    this.queen.root.position.copy(this.at);
    this.queen.root.quaternion.setFromRotationMatrix(S_MAT.makeBasis(right, up, forward));
    this.queen.update(dt, {
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      turn: -this.input.yaw * TURN_RATE,
      digging: this.input.dig ? 1 : 0,
      carrying: 0,
      headYaw: 0,
    });
    this.queen.solveFeet(
      (x, z, y) => this.footingFrom(x, z, y),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
      undefined,
      this.boreEngaged ? this.boreFrame() : undefined,
    );
  }

  private aimCamera(dt: number): void {
    /* In her eyes her own body would fill the frame — hidden there, shown
     * everywhere else (and only once her model has actually loaded). */
    this.queen.root.visible = this.queenReady && !this.firstPerson;
    this.crosshair.style.display = this.firstPerson ? '' : 'none';
    if (this.firstPerson) {
      /* Her own eyes: at the head, looking where she faces; the mouse (or
       * right-half drag) turns HER, and pitch is a look, not an orbit. On
       * the rail the eyes follow the BORE's axis — looking up a vertical
       * shaft means looking up it, not at its wall. */
      const onRail = this.railEdge >= 0;
      const fwd = onRail
        ? this.railForward.clone().normalize()
        : new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      const upv = onRail && this.railUp.lengthSq() > 0.1
        ? this.railUp.clone().normalize()
        : new THREE.Vector3(0, 1, 0);
      const eye = this.at.clone().addScaledVector(fwd, 0.26).addScaledVector(upv, 0.3);
      this.camera.position.copy(eye);
      this.camera.up.copy(upv);
      const dir = fwd.clone().multiplyScalar(Math.cos(this.fpPitch))
        .addScaledVector(upv, Math.sin(this.fpPitch));
      this.camera.lookAt(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z);
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
      for (const node of this.railNodes.values()) {
        if (node.kind !== 'chamber') continue;
        const box = chamberBox(node.p.x, node.p.y, node.p.z, node.r);
        const u = chamberNorm(box, this.at.x, this.at.y, this.at.z);
        const t = Math.min(1, Math.max(0,
          (CHAMBER_CAM_FAR - u) / (CHAMBER_CAM_FAR - CHAMBER_CAM_NEAR)));
        if (t > roomShare) { roomShare = t; roomBox = box; }
      }
      this.chamberCam += (roomShare - this.chamberCam) * Math.min(1, dt * 3);

      const desired = new THREE.Vector3();
      if (this.lookPointer !== null) {
        const cp = Math.cos(this.camPitch);
        const dist = 1.2;
        desired.set(
          this.at.x + Math.sin(this.camYaw) * dist * cp,
          this.at.y + Math.sin(this.camPitch) * dist,
          this.at.z + Math.cos(this.camYaw) * dist * cp,
        );
      } else {
        desired.copy(this.trailPointBehind(1.0));
        desired.y += 0.32;
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
        if (this.stream?.solidAtWu(
          this.camera.position.x, this.camera.position.y, this.camera.position.z,
        ) !== true) break;
        this.camera.position.lerp(this.at, 0.3);
      }
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.at.x, this.at.y + 0.15, this.at.z);
      return;
    }
    const wantYaw = this.facing + Math.PI;
    let d = wantYaw - this.camYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (this.lookPointer === null) this.camYaw += d * Math.min(1, dt * 2.4);
    /* The camera FOLLOWS the aim: point her down and the view climbs so you
     * are looking along the line she will cut, rather than at the back of
     * her head while she vanishes into the floor. */
    const wantPitch = Math.min(1.35, Math.max(0.06, 0.28 + Math.max(0, -this.aimPitch)));
    this.camPitch += (wantPitch - this.camPitch) * Math.min(1, dt * 3);
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.at.x + Math.sin(this.camYaw) * this.camDist * cp,
      this.at.y + Math.sin(this.camPitch) * this.camDist,
      this.at.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    const eyeGround = this.footingAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < eyeGround + 0.6) this.camera.position.y = eyeGround + 0.6;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.at.x, this.at.y + 0.4, this.at.z);
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
    return this.at.clone().add(new THREE.Vector3(
      -Math.sin(this.facing) * distance, 0, -Math.cos(this.facing) * distance,
    ));
  }

  /* ---------------------------------------------------------------- HUD */

  private buildControls(): void {
    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    this.hud.appendChild(actions);

    /*
     * DIG IS HER JAWS AGAIN, and it is the drive: hold it and she strokes,
     * a bite of soil leaves at the bottom of each stroke, and she can walk
     * forward into exactly as much room as she has made. A tunnel is then
     * wherever she chewed — no plan to lay out first, nothing authored to
     * be locked into, and nothing to ask her permission about at either
     * end of it.
     */
    const dig = document.createElement('button');
    dig.className = 'density-lab-button density-lab-dig';
    dig.textContent = 'DIG';
    dig.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dig.setPointerCapture(e.pointerId);
      this.input.dig = true;
    });
    const stopDig = () => { this.input.dig = false; };
    dig.addEventListener('pointerup', stopDig);
    dig.addEventListener('pointercancel', stopDig);
    dig.addEventListener('lostpointercapture', stopDig);
    actions.appendChild(dig);

    /* Her collision oval, on demand — for seeing WHY she will not go. */
    const bodyChip = document.createElement('button');
    bodyChip.className = 'density-lab-button density-lab-mode';
    bodyChip.textContent = 'BODY';
    bodyChip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.showCapsule = !this.showCapsule;
      bodyChip.classList.toggle('is-grip', this.showCapsule);
    });
    actions.appendChild(bodyChip);

    /* The nest tools are still here; they are just no longer what DIG means. */
    const tools = document.createElement('button');
    tools.className = 'density-lab-button density-lab-mode';
    tools.textContent = 'PLAN';
    tools.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.openDesigner();
    });
    actions.appendChild(tools);

    /* GRIP / FREE — an indicator, not a switch: the tunnel takes her, the
     * room and the surface free her, all by themselves. It exists so the
     * player always knows which rules they are moving under. */
    const mode = document.createElement('button');
    mode.className = 'density-lab-button density-lab-mode is-indicator';
    mode.textContent = 'FREE';
    this.modeBtn = mode;
    actions.appendChild(mode);

    const plan = document.createElement('button');
    plan.className = 'density-lab-button density-lab-mode';
    plan.textContent = 'SONAR';
    plan.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.showPlan = !this.showPlan;
      if (this.nestView) this.nestView.root.visible = this.showPlan;
    });
    actions.appendChild(plan);

    /*
     * THE THRESHOLD PROMPT — and the reason the last one did nothing.
     *
     * `.density-lab-hud` is pointer-events:none, and every control that
     * works turns it back on (the actions bar, the designer panel, the
     * stats chip). The old SURFACE? box was styled inline and never did,
     * and neither button class sets it — only the actions CONTAINER does.
     * So every tap fell straight through the prompt to the canvas, where
     * the left half spawns the joystick: the buttons were untappable by
     * construction, which is why they got removed. The class below lives
     * in the stylesheet WITH pointer-events:auto, so they take a tap.
     */
    const ask = document.createElement('div');
    ask.className = 'density-lab-gate-ask';
    ask.style.display = 'none';
    const askLabel = document.createElement('span');
    askLabel.className = 'density-lab-gate-label';
    ask.appendChild(askLabel);
    const answer = (yes: boolean) => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-mode';
      button.textContent = yes ? 'YES' : 'NO';
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.answerGate(yes);
      });
      return button;
    };
    ask.appendChild(answer(true));
    ask.appendChild(answer(false));
    this.hud.appendChild(ask);
    this.askEl = ask;
    this.askLabel = askLabel;

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
      /* Space is the jaws, and it is HELD — the button is the drive. */
      const space = k.has(' ');
      if (space !== this.spaceWasDown) {
        this.input.dig = space;
        this.spaceWasDown = space;
      }
    };
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      /* The threshold question takes a key as well as a tap — E or Enter
       * to go through, Escape to stay put — so the PC hand never has to
       * reach for the mouse mid-walk. */
      if (this.gateAsk && !e.repeat) {
        if (key === 'e' || key === 'enter') { this.answerGate(true); return; }
        if (key === 'escape') { this.answerGate(false); return; }
      }
      if (key === 'b' && !e.repeat) this.openDesigner();
      if (key === 'c' && !e.repeat) this.showCapsule = !this.showCapsule;
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
          /* In her eyes the drag turns HER, and the glance IS the aim —
           * one number, so the view and the bore can never disagree about
           * which way she is pointed. */
          this.bore.turn(-e.movementX * 0.004);
          this.facing = this.bore.heading;
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
          this.camYaw -= e.movementX * 0.005;
          this.aimPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
            this.aimPitch - e.movementY * 0.004));
        }
      }
    });
    const release = (e: PointerEvent) => {
      if (this.designer?.isOpen) { this.designer.handlePointerUp(e); return; }
      if (e.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.input.walk = 0;
        this.input.yaw = 0;
        this.stickEl.style.display = 'none';
      }
      if (e.pointerId === this.lookPointer) this.lookPointer = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    window.addEventListener('pointerup', release);
  }

  private updateStatus(): void {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const elevM = this.heights
      ? (this.groundHeightAt(this.at.x, this.at.z) * MM).toFixed(0)
      : '…';
    const mode = this.railEdge >= 0 ? 'GRIP' : this.chamberId ? 'FREE (room)' : 'FREE';
    this.statsPanel.setHTML(`
      <b>kauai island</b> · 56 m square · 1:1000 · all 64 sections resident<br>
      terrain ${this.terrainVerts.toLocaleString()} v / ${this.terrainTris.toLocaleString()} t
      · elevation ${elevM} m · mode ${mode}<br>
      aim ${((this.aimPitch * 180) / Math.PI).toFixed(0)}° ·
      body ${(this.body.len * MM * 2).toFixed(1)} x ${(this.body.wide * MM * 2).toFixed(1)}
      x ${(this.body.tall * MM * 2).toFixed(1)} mm ·
      bite ${BITE_WIDTH_MM} x ${BITE_DEPTH_MM} mm<br>
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

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setFacingForTest(radians: number): void {
    /* The RIG owns the heading now, so setting the field alone would be
     * overwritten on the next step. Turn the rig to match. */
    this.facing = radians;
    this.bore.turn(radians - this.bore.heading);
  }

  teleportMm(xMm: number, zMm: number): void {
    this.at.x = xMm / MM;
    this.at.z = zMm / MM;
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;
    this.velocity.set(0, 0, 0);
    this.trail.length = 0;
    this.underground = false;
    this.hasSafe = false;
    /* A teleport leaves the rail behind like everything else it resets —
     * stale rail state used to drag her back into the tunnel she left. */
    this.railEdge = -1;
    this.railRev = false;
    this.chamberId = null;
    this.boreEngaged = false;
    this.railGate = null;
    this.enterDeclined = null;
    this.surfaceDeclined = null;
    this.hideGateAsk();
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
      railBound: this.railEdge >= 0 ? 1 : 0,
      // GRIP and FREE are one coin: on the rail is GRIP, everything else
      // (surface, chamber) is FREE. `chamberNow` says which FREE.
      free: this.railEdge >= 0 ? 0 : 1,
      chamberNow: this.chamberId !== null ? 1 : 0,
      aimDeg: (this.aimPitch * 180) / Math.PI,
      bodyLenMm: this.body.len * MM,
      bodyWideMm: this.body.wide * MM,
      bodyTallMm: this.body.tall * MM,
      biteWidthMm: BITE_WIDTH_MM,
      biteDepthMm: BITE_DEPTH_MM,
      asking: this.gateAsk ? 1 : 0,
      playerReady: this.playerReady ? 1 : 0,
      statsOpen: this.statsPanel.bodyVisible ? 1 : 0,
      designing: this.designer?.isOpen ? 1 : 0,
      rails: this.rails.length,
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

  dispose(): void {
    cancelAnimationFrame(this.frame);
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
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
