import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { QueenModel } from '../anim/QueenModel';
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

/** Radians per second she can turn. A little over half a turn a second. */
const TURN_RATE = 3.6;

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
 * How close the camera may be dragged to her by an obstruction — 4 mm.
 *
 * Below about half a body length the view stops being a view of an ant and
 * becomes a view of one leg: at 1.5 mm she filled the top of the frame and
 * everything else was the sky above the shaft. When even 4 mm is still inside
 * the soil the arm gives up and the camera escapes upward instead, which at
 * least looks down the hole from the rim.
 */
const MIN_CAMERA_ARM = 4 / WORLD_UNIT_MM;

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
  private readonly controls: any;
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
  /** Her actual velocity, eased toward what the pad asks for. */
  private readonly velocity = new THREE.Vector3();
  /** 0..1, decaying. Drives the gait's dig animation after a bite. */
  private digPulse = 0;
  /** Her current up axis, eased toward the slope so she does not shiver. */
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** How far the worst foot was under the soil before the last solve. */
  private footPenetration = 0;
  /** Where the last bite was centred, so the smoke can check it was her jaws. */
  private readonly lastBite = new THREE.Vector3();
  /** How far the fail-safe had to lift her on the last frame. */
  private guardLift = 0;
  /** The zoom the player set, kept while the camera is pulled in past it. */
  private orbitDistance = 0;
  private cameraPulled = false;
  private sun: any = null;
  private readonly move = { forward: 0, strafe: 0 };
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
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.antPosition);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = WINDOW_SIZE * 0.05;
    this.controls.maxDistance = WINDOW_SIZE * 0.62;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

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
      <div class="density-lab-crosshair" aria-hidden="true"></div>
      <div class="density-lab-hint">Drag to orbit · pinch to zoom · WASD or the pad to walk · space to bite (she digs with her jaws, so walk up to it)</div>
      <div class="density-lab-pad"></div>
      <div class="density-lab-actions"></div>
    `;
    host.appendChild(hud);

    const status = hud.querySelector<HTMLDivElement>('.density-lab-status');
    const actions = hud.querySelector<HTMLDivElement>('.density-lab-actions');
    const pad = hud.querySelector<HTMLDivElement>('.density-lab-pad');
    if (!status || !actions || !pad) throw new Error('Density terrain lab HUD failed to initialize');
    this.status = status;

    this.digButton = document.createElement('button');
    this.digButton.className = 'density-lab-button density-lab-dig';
    this.digButton.textContent = 'DIG';
    this.digButton.setAttribute('aria-label', `Carve a ${BITE_WIDTH_MM} millimetre scoop`);
    actions.appendChild(this.digButton);

    this.resetButton = document.createElement('button');
    this.resetButton.className = 'density-lab-button density-lab-reset';
    this.resetButton.textContent = 'RESET';
    actions.appendChild(this.resetButton);

    this.buildPad(pad);
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
    this.controls.dispose();
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
   * The walk pad: four buttons that behave like held keys.
   *
   * `pointerdown` sets the direction and `pointerup`/`pointercancel`/
   * `pointerleave` all clear it. Leaving out any one of the three is how a
   * touch pad ends up walking forever after a finger slides off it.
   */
  private buildPad(pad: HTMLDivElement): void {
    const keys: Array<[string, string, number, number]> = [
      ['▲', 'walk forward', 1, 0],
      ['◀', 'walk left', 0, -1],
      ['▶', 'walk right', 0, 1],
      ['▼', 'walk back', -1, 0],
    ];
    for (const [glyph, label, forward, strafe] of keys) {
      const button = document.createElement('button');
      button.className = 'density-lab-padkey';
      button.textContent = glyph;
      button.setAttribute('aria-label', label);
      const press = (event: PointerEvent): void => {
        event.preventDefault();
        if (forward) this.move.forward = forward;
        if (strafe) this.move.strafe = strafe;
      };
      const release = (): void => {
        if (forward) this.move.forward = 0;
        if (strafe) this.move.strafe = 0;
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
      pad.appendChild(button);
      this.padButtons.push(button);
    }
  }

  private readonly onDigPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.carveAtCrosshair();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') {
      event.preventDefault();
      this.carveAtCrosshair();
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      this.resetTerrain();
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
    this.move.forward = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    this.move.strafe = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
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
          if (this.pending.some((p) => p[0] === gx && p[1] === gy && p[2] === gz)) continue;
          if (immediate) this.buildChunk(gx, gy, gz);
          else this.pending.push([gx, gy, gz]);
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
      if (entry && !wanted.has(`${entry[0]},${entry[1]},${entry[2]}`)) this.pending.splice(i, 1);
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
    this.refreshResidency(true);
  }

  private rebuildAround(bounds: {
    minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  }): void {
    const started = performance.now();
    const lo = (v: number) => Math.floor(Math.max(0, v - 1) / CHUNK_CELLS);
    const hi = (v: number, cells: number) => Math.floor(Math.min(cells - 1, v) / CHUNK_CELLS);
    const baseX = this.stream.originCellX / CHUNK_CELLS;
    const baseZ = this.stream.originCellZ / CHUNK_CELLS;
    for (let cz = lo(bounds.minZ); cz <= hi(bounds.maxZ, WINDOW_CELLS); cz += 1)
      for (let cy = lo(bounds.minY); cy <= hi(bounds.maxY, CELLS_Y); cy += 1)
        for (let cx = lo(bounds.minX); cx <= hi(bounds.maxX, WINDOW_CELLS); cx += 1)
          this.buildChunk(baseX + cx, cy, baseZ + cz);
    this.lastMeshMs = performance.now() - started;
    this.updateStatus();
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
    this.refreshResidency(true);
  };

  /**
   * Bite with her JAWS, in front of her face.
   *
   * It used to carve wherever the crosshair struck, which is the camera's
   * centre and therefore roughly her middle — so the crater opened UNDER her
   * and she lay across it like a plank over a hole, which is not what an ant
   * does with a hole. She digs face first, so the bite starts at her
   * mouthparts and goes where she is looking.
   *
   * The crosshair still aims: the direction runs from her jaws toward whatever
   * it is pointed at, so orbiting the camera decides whether she scrapes down
   * at her feet or forward into a bank. What the crosshair no longer does is
   * decide WHERE the soil is removed. If it is aimed at something she cannot
   * reach, she cannot reach it, and that is the answer rather than a crater
   * appearing at arm's length.
   */
  private carveAtCrosshair(): void {
    if (this.chunks.size === 0) return;
    const jaws = new THREE.Vector3();
    if (!this.queenReady || !this.queen.jawPosition(jaws)) {
      this.status.dataset.message = 'Waiting for the queen';
      this.updateStatus();
      return;
    }

    /*
     * Aim from the jaws, not from the camera. The crosshair picks the target;
     * the ray that does the digging starts at her face. Where the crosshair
     * hits nothing — sky, or past the edge of the loaded window — she scrapes
     * forward and down, which is what she would do anyway.
     */
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const aimed = this.raycaster.intersectObjects([...this.chunks.values()], false)[0];
    const heading = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    const direction = aimed
      ? aimed.point.clone().sub(jaws)
      : heading.clone().addScaledVector(this.up, -Math.tan(DIG_PITCH));
    if (direction.lengthSq() < 1e-10) direction.copy(heading);
    direction.normalize();

    /*
     * Walk out from the jaws until the soil starts, and no further than she
     * can reach. Marching the FIELD rather than raycasting the mesh, because
     * her mandibles are often already buried — inside the soil there is no
     * surface ahead to hit, and a mesh raycast from in there either misses
     * everything or finds the far wall of the chamber.
     */
    const scrape = heading.clone()
      .addScaledVector(this.up, -Math.tan(DIG_PITCH)).normalize();
    /*
     * The aimed direction first, then the scrape. Aiming is what makes the
     * crosshair mean anything; the scrape is what she does when it does not
     * point at soil she can reach, which on open ground is most of the time
     * because the target is metres of ant-scale away and the ray comes out
     * nearly level.
     */
    /*
     * Three things to try, in the order an ant would: where you are looking,
     * then forward and down, then straight down — putting her mouth to the
     * floor, which is the one that cannot miss for want of a shallow angle.
     *
     * The last was added because the other two do miss. Her height is eased
     * now rather than snapped, so while walking she rides a fraction of a
     * millimetre above the true ground, and the fail-safe adds a little more;
     * that was enough to lift her jaws past what a three-millimetre ray at
     * forty degrees can reach, and every bite after a walk reported that she
     * could not reach it. Straight down gets a longer reach because lowering
     * the head is a bigger motion than leaning into a bank.
     */
    let surface: any = null;
    const attempts: Array<[any, number]> = [
      [direction, JAW_REACH],
      [scrape, JAW_REACH],
      [this.up.clone().negate(), JAW_REACH * 2],
    ];
    for (const [way, reach] of attempts) {
      surface = this.firstSoilFromJaws(jaws, way, reach);
      if (!surface) continue;
      // The bite direction has to be the one that actually found the soil, or
      // the brush is offset along a ray that missed and the crater opens
      // beside the hole rather than in it.
      direction.copy(way);
      break;
    }
    if (!surface) {
      this.status.dataset.message = 'Her jaws cannot reach that';
      this.updateStatus();
      return;
    }

    /*
     * The brush RIDES the surface and only dips in by BITE_DEPTH.
     *
     * Sinking the centre below the hit buries most of the sphere and the
     * crater ends up as deep as the centre plus the whole radius — 7.9 mm for
     * what was advertised as a 5 mm scoop. A mandible does not do that; it
     * scrapes. Putting the centre (radius - depth) BEHIND the surface along
     * the bite direction leaves exactly a cap of height BITE_DEPTH in front of
     * it, which is the bite.
     */
    const center = surface.clone().addScaledVector(direction, BITE_DEPTH - BRUSH_RADIUS);
    const result = this.stream.subtractSphere(center, BRUSH_RADIUS);
    if (result.changedSamples === 0 || result.removedVolume <= 0.0001) {
      this.status.dataset.message = 'No packed soil in that scoop';
      this.updateStatus();
      return;
    }

    this.totalRemoved += result.removedVolume;
    this.digPulse = 1;
    this.lastBite.copy(center);
    this.rebuildAround(result.bounds);
    /*
     * Spoil goes BACKWARD, over her shoulder, not straight back out of the
     * hole. Out of the hole is toward her own face — the bite direction runs
     * from her jaws into the soil, so its negation points at her head, and the
     * clods spawned inside her thorax and flew through her.
     *
     * Which is also what an ant does with it: she passes the load back under
     * the body and drops it behind, so the spoil ends up in a heap at the
     * mouth of the burrow rather than back in the hole she just made.
     */
    const toss = this.up.clone().multiplyScalar(1.1)
      .addScaledVector(heading, -0.9).normalize();
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
      for (let y = start + 1; y <= top; y += 1) {
        const here = this.stream.field.sample(x, y * CELL_SIZE, z);
        if (here <= 0) return (y - 1 + neighbour / (neighbour - here)) * CELL_SIZE;
        neighbour = here;
      }
      return top * CELL_SIZE;
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
  private stand(dt: number): void {
    const ground = this.stance(this.antPosition.x, this.antPosition.z);
    // Eased, not assigned. The ground under her changes every time she bites,
    // and following it exactly is a jolt on every frame that removes a cell.
    const ease = 1 - Math.exp(-HEIGHT_EASE * dt);
    const rise = (ground.height - this.antPosition.y) * ease;
    this.antPosition.y += rise;
    // The camera rides the rise as well, or descending a shaft leaves the view
    // hanging at the surface looking at the back of her head.
    this.camera.position.y += rise;
    this.controls.target.copy(this.antPosition);
    if (!this.queenReady) return;
    this.queen.root.position.copy(this.antPosition);

    /*
     * Built as a BASIS rather than as yaw plus a tilt. Her up is the terrain
     * normal and her forward is the heading flattened against that up, so on a
     * slope she pitches and rolls with the ground instead of standing plumb
     * with her feet through it. Composing two rotations does not give this —
     * the two orders disagree the moment both angles are non-zero.
     */
    /*
     * Eased toward the new normal rather than snapped to it. Her feet cross a
     * cell every twentieth of a second at walking pace, and the ground has
     * quarter-millimetre grit on it, so taking each frame's slope literally
     * makes her shiver.
     */
    this.up.lerp(ground.up, 0.15).normalize();
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    forward.addScaledVector(this.up, -forward.dot(this.up));
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(this.up, forward).normalize();
    this.queen.root.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, this.up, forward),
    );
  }

  /**
   * Walk the queen, then let the window catch up.
   *
   * Movement is relative to where the camera is looking, because the pad has
   * no idea which way is north and neither does the player. The recentre is
   * checked every frame but only fires on a tile crossing, which is the whole
   * point of tiles being larger than a step.
   */
  private walk(dt: number): void {
    const ease = 1 - Math.exp(-SPEED_EASE * dt);
    if (this.move.forward === 0 && this.move.strafe === 0) {
      // Coast to a stop rather than halting on the frame the finger lifts.
      this.velocity.multiplyScalar(1 - ease);
      this.walkSpeed = this.velocity.length();
      if (this.walkSpeed < 1e-3) { this.velocity.set(0, 0, 0); this.walkSpeed = 0; return; }
      this.glide(dt);
      return;
    }

    const forward = new THREE.Vector3()
      .subVectors(this.antPosition, this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) return;
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const step = new THREE.Vector3()
      .addScaledVector(forward, this.move.forward)
      .addScaledVector(right, this.move.strafe);
    if (step.lengthSq() === 0) return;
    step.normalize().multiplyScalar(WALK_SPEED);
    this.velocity.lerp(step, ease);
    this.walkSpeed = this.velocity.length();

    /*
     * She turns toward where she is going rather than snapping to it, so a tap
     * on the pad reads as an animal deciding to go that way. The shortest way
     * round is taken explicitly — the naive difference sends her the long way
     * whenever the heading crosses the wrap at pi, which is a full spin in
     * place for one step sideways.
     */
    const wanted = Math.atan2(step.x, step.z);
    let turn = wanted - this.facing;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const turned = THREE.MathUtils.clamp(turn, -TURN_RATE * dt, TURN_RATE * dt);
    this.facing += turned;
    this.turnRate = dt > 0 ? turned / dt : 0;

    this.glide(dt);
  }

  /**
   * Carry her by the current velocity, and everything that has to follow her.
   *
   * Shared by the walking and the coasting branches, because the camera, the
   * orbit target and the streaming window all have to keep up whether she is
   * being driven or merely still slowing down — and a stop that leaves the
   * window behind is a stop that streams a tile late.
   */
  private glide(dt: number): void {
    if (this.velocity.lengthSq() < 1e-12) return;
    const margin = CELL_SIZE * 3;
    const previous = this.antPosition.clone();
    this.antPosition.x = THREE.MathUtils.clamp(
      this.antPosition.x + this.velocity.x * dt, margin, WORLD_SPAN - margin,
    );
    this.antPosition.z = THREE.MathUtils.clamp(
      this.antPosition.z + this.velocity.z * dt, margin, WORLD_SPAN - margin,
    );

    // Carry the camera along by exactly her step, so orbiting is untouched by
    // walking: the arm the player set stays the arm they set.
    const moved = this.antPosition.clone().sub(previous);
    this.camera.position.add(moved);
    this.controls.target.copy(this.antPosition);

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
      Queen: ${this.queenReady
        ? `${CASTE_LENGTH_MM.queen} mm · feet ${(this.footPenetration * WORLD_UNIT_MM).toFixed(2)} mm`
          + ` · guard ${(this.guardLift * WORLD_UNIT_MM).toFixed(3)} mm`
        : 'loading…'}<br>
      Mesh: ${this.lastMeshMs.toFixed(1)} ms · scroll ${this.lastScrollMs.toFixed(1)} ms${queued}<br>
      Dug: ${this.stream.editedSamples} samples kept
    `;
  }

  /**
   * Keep the camera in open air, on the line to her.
   *
   * Following an ant down a shaft puts a camera two centimetres behind her
   * inside the bank, where every surface it can see is a backface — so the
   * terrain culls away and the screen goes sky blue. Reported as a blue pool
   * sitting in the crater, which is what it looks like when only PART of the
   * near wall is between you and the hole.
   *
   * Shortening the arm rather than lifting the camera, because lifting it out
   * of the soil leaves it on the rim staring at the bank while she is out of
   * frame below — the whole screen brown instead of the whole screen blue.
   * Pulling in along the sight line keeps her framed and is what makes a
   * burrow watchable at all.
   *
   * The zoom the player set is remembered separately and restored the moment
   * the way is clear. Orbit controls derive their state from the camera's
   * position, so writing a shortened arm back into it would be read as the
   * player having zoomed in, and one trip down a hole would permanently
   * shrink the view.
   */
  private keepCameraClear(): void {
    const target = this.controls.target;
    const arm = this.camera.position.clone().sub(target);
    const distance = arm.length();
    if (distance < 1e-6) return;
    arm.divideScalar(distance);

    const step = CELL_SIZE * 2;
    let clear = distance;
    for (let d = step; d <= distance; d += step) {
      PROBE.copy(target).addScaledVector(arm, d);
      if (this.solidAt(PROBE)) {
        /*
         * Closer than the zoom limit is allowed here, and has to be: a pull-in
         * is a collision, not a zoom. Floored at the orbit's own minimum, the
         * camera stopped two and a half millimetres out — still inside the
         * shaft wall — and rendered the inside of the soil, which is to say
         * nothing at all.
         */
        clear = Math.max(MIN_CAMERA_ARM, d - CELL_SIZE * 2);
        break;
      }
    }
    this.cameraPulled = clear < distance - 1e-6;
    if (this.cameraPulled) this.camera.position.copy(target).addScaledVector(arm, clear);

    /*
     * Last resort. A shaft narrower than the shortest arm leaves the camera in
     * the dirt however far in it is pulled, and a camera in the dirt renders
     * the world as sky. Climbing to the surface above itself is worse framing
     * and an honest picture.
     */
    if (this.solidAt(this.camera.position)) {
      this.camera.position.y = this.groundAt(
        this.camera.position.x, this.camera.position.z, this.camera.position.y,
      ) + CAMERA_CLEARANCE;
      this.cameraPulled = true;
    }

    /*
     * And never below her. Shortening the arm preserves its direction, which
     * near the horizontal leaves the camera level with her or under her —
     * inside a shaft that means looking UP past her at a circle of sky, with
     * the walls filling the rest of the frame. Diagnosed exactly that way: the
     * terrain was intact and 270,000 triangles were being drawn, and what
     * looked like a hole in the floor was the shaft's own mouth.
     */
    const floor = this.controls.target.y + MIN_CAMERA_ARM * 0.5;
    if (this.camera.position.y < floor) {
      this.camera.position.y = floor;
      this.cameraPulled = true;
    }
  }

  /** Give the arm back its full length before the controls read it. */
  private restoreCameraArm(): void {
    if (!this.cameraPulled) {
      this.orbitDistance = this.camera.position.distanceTo(this.controls.target);
      return;
    }
    const arm = this.camera.position.clone().sub(this.controls.target);
    if (arm.lengthSq() < 1e-12) return;
    this.camera.position.copy(this.controls.target)
      .addScaledVector(arm.normalize(), this.orbitDistance);
  }

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

  private animate = (): void => {
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.previousTime) / 1000);
    this.previousTime = now;
    this.walk(delta);
    this.stand(delta);
    this.digPulse = Math.max(0, this.digPulse - DIG_DECAY * delta);
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
       * Both solvers get the floor below HER, not the top of the world. In a
       * burrow those are different by the whole depth of it, and taking the
       * second is what used to convince the guard she was buried and heave her
       * out through the ceiling.
       */
      const under = (x: number, z: number): number =>
        this.groundAt(x, z, this.antPosition.y + STEP_UP);
      this.footPenetration = this.queen.solveFeet(
        under, FOOT_CLEARANCE, FOOT_PLANT_BAND,
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
    this.restoreCameraArm();
    this.controls.update();
    this.keepCameraClear();
    this.drainPending(now - this.previousFrameStart);
    this.previousFrameStart = now;
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
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
