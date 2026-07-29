/**
 * Phase A dig prototype — first person, at ant scale, in three.js.
 *
 * One world unit is one voxel is 5 mm, so the 128^3 volume is a 64 cm cube of
 * ground: about 128 ant-lengths across and 96 voxels of diggable soil deep,
 * which is a realistic footprint for a founding nest.
 *
 * All the rules live in ../voxel (pure TypeScript, unit tested). This file is
 * the renderer, the camera and the thumbs.
 */

import * as THREE from 'three';
import {
  AIR, CHUNK, MATERIALS, TOPSOIL, VoxelWorld,
  isSolid, layeredGenerator, materialOf, type VoxelId,
} from '../voxel/VoxelWorld';
import { meshChunk } from '../voxel/mesher';
import {
  buildFracture, chipMeshData, eventsBetween, hashVoxel, removedAt, wobbleAt,
  CELL_COUNT, type DigEvent, type DigEventKind, type FracturePattern,
} from '../voxel/fracture';
import {
  SOIL_CLOD_VARIANT_COUNT, buildClodShape, clodFeel, clodRadius, styleForVoxel,
  type ClodShape, type SoilLoadStyle,
} from '../voxel/clod';
import { CLOD_RADIUS, LooseSoil, type Clod } from '../voxel/LooseSoil';
import { raycastVoxel } from '../voxel/raycast';
import { DigSession } from '../voxel/DigSession';
import { createVoxelMaterial, type VoxelMaterialBundle } from '../voxel/voxelMaterial';
import { DEN_MIN_CHAMBER, DEN_MIN_DEPTH, QueenFounding } from '../voxel/QueenFounding';
import { DEFAULT_BANDS, approach, clampStickOrigin, speedForStick, stickVector } from '../voxel/locomotion';
import {
  WORLD_UP, applyOrientation, axisVector, createSurfaceState,
  INPUT_COMMIT_THRESHOLD, axisFromVector, canChangeOrientation,
  dragLook, evaluateEdge, lookVector, rankSurfaces, referenceRight, reframeLook,
  rollBetween, supportBelow, tickLock, type AxisDirection,
} from '../voxel/SurfaceFrame';

const WORLD_SIZE = 128;
const SURFACE_Y = 96;
const VOXEL_MM = 5;

/*
 * Ant-sized, and that is a gameplay requirement rather than a detail.
 *
 * A body 1.6 voxels tall and 0.9 wide is 8 mm x 4.5 mm — a human capsule, not
 * an insect. It also cannot ROTATE inside a one-voxel tunnel: lying against a
 * wall the body needs 1.6 of clearance along the wall normal, and the tunnel
 * only has 1. Gripping silently failed in exactly the tunnels the game is made
 * of.
 *
 * At 0.7 x 0.6 (3.5 mm x 3 mm) the ant fits both standing AND lying in a
 * single voxel, so a one-cube tunnel becomes fully wall-walkable. The lower eye
 * also makes the world read considerably larger, which is the whole point.
 */
const EYE_HEIGHT = 0.7;
const BODY_RADIUS = 0.3;
/** Speeds now come from the stick curve (locomotion.ts); these are its anchors. */
/**
 * Scaled down with the speeds. Acceleration is about the RATIO to top speed —
 * keeping 32 against a 7.5 top speed would reach full pace in 0.23 s and lose
 * the sense of mass the acceleration was added for.
 */
const WALK_ACCEL = 14;
const WALK_DECEL = 22;
/** Keyboard has no analogue axis, so it picks a band rather than full tilt. */
const KEY_MAGNITUDE = 0.7;
const STICK_RADIUS = 70;
/**
 * Tuned for an ant, not a person. By the square-cube law an ant has enormous
 * drag relative to its mass, so its terminal velocity is very low and falls
 * are effectively harmless — ants drop off things constantly and walk away.
 * The old 400 / -260 pair modelled a human being and read as heavy.
 */
const GRAVITY = 12;
/**
 * Small creatures hit terminal velocity almost instantly, so what you actually
 * see of an ant falling is a near-constant slow drift, not a build-up. Keeping
 * this low matters more to the feel than the acceleration does.
 */
const TERMINAL_VELOCITY = -30;
/**
 * Jump is expressed as a HEIGHT and the launch speed derived from it, because
 * the two are coupled (h = v^2 / 2g) and hand-tuning them separately has
 * already gone wrong once: softening gravity silently turned a 1.4 voxel hop
 * into a 3.2 voxel leap, enough to jump out of shafts and make climbing
 * pointless. Deriving it means gravity can now be retuned freely.
 */
const JUMP_HEIGHT = 1.45;
const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_HEIGHT);
/** Rise the ant steps over without jumping — one voxel plus a hair. */
const STEP_HEIGHT = 1.05;
/** Amplitude and rate of the crawl sway while climbing. */
const CLIMB_SWAY = 0.025;
const CLIMB_SWAY_HZ = 2.4;
/** Seconds the edge-arc bulge lasts. */
const CAMERA_TURN_TIME = 0.26;
/** Exponential rate the camera orientation chases the physics frame. */
const CAMERA_TURN_RATE = 13;
/** How far the eye swings out while rounding an edge, in voxels. */
const EDGE_ARC = 0.55;
/**
 * Below this the ant is inside the ground column and weightless. Above it —
 * the surface, and anything piled on top of it — gravity behaves normally, so
 * the world above still feels like somewhere you can fall off.
 *
 * Deliberately as shallow as this: holding position the moment you break the
 * surface is correct, because you are gripping the walls of the hole you are
 * standing in.
 */
const UNDERGROUND_Y = SURFACE_Y + 0.9;
/** Constant descent when nothing is underfoot below ground. 1 cm/s. */
const SETTLE_SPEED = 2;
/**
 * Underground is close work — braced against tunnel walls in the dark, not
 * striding across open ground.
 */
const UNDERGROUND_SPEED = 0.75;
/**
 * Hauling. Honest caveat: a real ant carries many times its own body weight, so
 * one grain of soil would barely slow it — this is a feel number, there so the
 * trip out reads as work, not a biology number.
 */
const CARRY_SPEED = 0.85;
/** Shown in the HUD so it's obvious at a glance whether a build is current. */
const BUILD_LABEL = `v${__APP_VERSION__} \u00b7 ${__BUILD_TIME__}`;
/**
 * An ant works the soil it is TOUCHING. A 5.5 voxel reach let you carve a
 * corridor five cubes deep without moving, which is both unrealistic and made
 * tunnels appear from nowhere. The ray is short, and REACH_CUBES additionally
 * clamps targets to the 3x3x3 shell around the ant's own cube — a hard limit
 * that a radius alone can't express, since a diagonal at 1.7 is further away
 * than a face at 1.9 yet much closer in cubes.
 */
const REACH = 2.2;
const REACH_CUBES = 1;

/**
 * Telling a dig-tap apart from a look-drag. The right half of the screen turns
 * the camera, so a tap has to be a press that goes nowhere and ends quickly.
 * Generous on both counts, because the failure is cheap in one direction only:
 * a stray tap starts a dig that another tap cancels, whereas a dig that refuses
 * to register reads as the game being broken.
 */
const TAP_MAX_MS = 250;
const TAP_MAX_PX = 10;

/**
 * Mounting a wall has to be DELIBERATE.
 *
 * "Movement was blocked" is far too weak a signal on its own: in a one-cube
 * tunnel the ant is boxed in on four sides, so moving diagonally leaves an axis
 * blocked more or less permanently and she mounts whichever face she happened
 * to graze. Two extra conditions fix it — push roughly at the wall rather than
 * along it, and keep pushing for a moment rather than a single frame.
 */
const MOUNT_FACING = 0.55;
const MOUNT_DWELL = 0.2;
/** How long contact is remembered through the block/creep stutter. */
const MOUNT_GRACE = 0.15;

/**
 * Hard cap on dirt fragments. One pooled InstancedMesh of this size is
 * allocated once and reused forever — a phone should never be asked to
 * allocate a mesh mid-dig.
 */
export const MAX_DIG_PARTICLES = 24;

/**
 * How long the clod takes to travel from the mandibles to where it lands.
 *
 * Dropped soil re-enters the voxel grid — that is what keeps the mound walkable
 * and `Dug = Carried + Mound` true — so the clod cannot stay a free object. It
 * flies for this long and then hands over to the deposited voxel, which is the
 * moment the terrain gains a cube.
 */
const CLOD_FLIGHT = 0.22;
/**
 * How the clod rides. It is one voxel of soil, but drawn a little under full
 * size so it reads as held rather than as a boulder stuck to the lens.
 *
 * Under a full voxel on purpose. The ant's collision body was shrunk to 0.7
 * voxels so she fits a one-cube tunnel, so a lump drawn at true voxel size is
 * nearly as tall as she is and swallows the view from a first-person camera
 * this low. It still represents exactly one voxel of soil.
 */
const CLOD_SIZE = 0.42;
const CLOD_AHEAD = 0.34;
const CLOD_DROP = 0.2;
/** Instances per variant batch. Twelve of these covers the heap cap. */
const SOIL_BATCH_CAPACITY = 24;
/** How hard walking into a clod shoves it. */
const CLOD_PUSH = 2.2;

interface DigParticle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

/**
 * The one voxel currently being chipped. There is never more than one, because
 * DigSession only ever locks one target.
 */
interface ActiveDigVisual {
  voxel: { x: number; y: number; z: number };
  pattern: FracturePattern;
  /** Highest progress seen. Latched, so the visual can never wind backwards. */
  progress: number;
  lastProgress: number;
  /** Crumb count the current geometry was built for; -1 means never built. */
  builtRemoved: number;
  mesh: THREE.Mesh | null;
}

/**
 * Equirectangular sky. Poly Haven's "Table Mountain 2 Pure Sky", CC0.
 *
 * A JPEG rather than a .hdr: at 180 KB it costs a fraction of the download and
 * the true high dynamic range buys nothing here, because nothing in this scene
 * is reflective enough to show it. The image is still the light source — three
 * builds an irradiance map from it, so the soil is lit by this sky rather than
 * by hand-placed lamps that only approximate one.
 */
const SKY_URL = `${import.meta.env.BASE_URL}sky/puresky_2k.jpg`;
/** Sampled from the horizon band, so fog meets the sky instead of banding. */
const SKY_HORIZON = 0xb9c7d4;
/** How hard the sky lights the world, and what the hemisphere keeps once it does. */
const SKY_LIGHT = 0.85;
const HEMI_WITH_SKY = 0.35;

export class DigScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: VoxelWorld;
  private readonly session: DigSession;

  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly materialBundle: VoxelMaterialBundle;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly highlight: THREE.LineSegments;
  private readonly headlamp: THREE.PointLight;
  /** Equirectangular sky and the irradiance map derived from it. */
  private sky: THREE.Texture | null = null;
  private environment: THREE.Texture | null = null;
  private readonly hemisphere: THREE.HemisphereLight;

  /** The voxel being chipped, and the pooled dirt it throws off. */
  private chip: ActiveDigVisual | null = null;
  private chipClock = 0;
  private readonly particles: DigParticle[] = [];
  private readonly particleMesh: THREE.InstancedMesh;
  private readonly particleDummy = new THREE.Object3D();
  /** Decaying camera nudge from the last big chip. */
  private cameraKick = 0;
  /**
   * Audio hook. Left unset here on purpose — the events are wired and correctly
   * timed, so sound is a matter of assigning this, not of finding where the
   * chips happen.
   */
  digAudio: ((kind: DigEventKind, at: THREE.Vector3) => void) | null = null;

  /* The carried soil, as an irregular clod rather than a cube. */
  private readonly clodMesh: THREE.Mesh;
  private readonly clodMaterial: THREE.MeshStandardMaterial;
  /** Built once per (material, variant) and kept. Never regenerated in a frame. */
  private readonly clodGeometries = new Map<string, THREE.BufferGeometry>();
  private clodStyle: SoilLoadStyle | null = null;
  /** Set while a dropped clod is flying to the cell it will become. */
  private clodFlight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  private readonly clodAnchor = new THREE.Vector3();

  /* Spoil lying around: real objects, shovable and re-carryable. */
  private readonly soil = new LooseSoil();
  /**
   * One InstancedMesh per clod variant, so a whole nest of spoil costs twelve
   * draw calls no matter how many clods there are. Per-instance colour carries
   * the material and tint, so they all share a single material too.
   */
  private readonly soilBatches = new Map<string, THREE.InstancedMesh>();
  private readonly soilMaterial: THREE.MeshStandardMaterial;
  private readonly soilDummy = new THREE.Object3D();
  private readonly soilColor = new THREE.Color();
  /** Last frame's planar movement, so pushes go the way she is actually going. */
  private readonly lastStep = new THREE.Vector3();

  private readonly position = new THREE.Vector3();
  private readonly surface = createSurfaceState();
  /** Speed along `up`; replaces a world-Y velocity now that up moves. */
  private upVelocity = 0;
  /** Speed in the surface plane. */
  private planarSpeed = 0;
  private readonly cameraQuat = new THREE.Quaternion();
  /** 1 -> 0 while an edge turn plays out. */
  private cameraTurn = 0;
  private toastCooldown = 0;
  private weightless = false;
  private yaw = 0;
  private pitch = 0;
  private grounded = false;
  private climbPhase = 0;
  private cameraRoll = 0;
  /** Roll carried over from a frame change, decaying to zero. */
  private rollOffset = 0;
  /** Outward normal of the wall currently being pushed into, if any. */
  private readonly wallNormal = new THREE.Vector3();
  private hasWall = false;
  /** Seconds spent pushing at the current wall, gating a deliberate mount. */
  private mountDwell = 0;
  /** Grace remaining on wall contact, so the block/creep stutter reads as continuous. */
  private wallContact = 0;

  private readonly founding = new QueenFounding(SURFACE_Y, VOXEL_MM);
  /** After founding, the camera detaches from the queen and orbits the den. */
  private debug = false;
  private colonyView = false;
  private orbit = { yaw: 0.7, pitch: 0.55, distance: 26 };
  private pinchStart: { distance: number; orbit: number } | null = null;
  /** Every live touch, so a second finger can be recognised as a pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>();

  private moveX = 0;
  private moveZ = 0;
  private stickMagnitude = 0;
  private keyboardDriving = false;
  private sprinting = false;
  private jumpQueued = false;
  /** Jumped and not yet landed — suspends weightlessness so the leap survives. */
  private airborne = false;

  private readonly hud: HTMLDivElement;
  private readonly actionButton: HTMLButtonElement;
  private readonly foundButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly objective: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;

  private lookPointer: number | null = null;
  /** Where and when the look pointer went down, so a tap can be told from a drag. */
  private lookDown = { x: 0, y: 0, at: 0 };
  private movePointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private moveOrigin = { x: 0, y: 0 };

  private frame = 0;
  private lastTime = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(host.clientWidth || window.innerWidth, host.clientHeight || window.innerHeight);
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 400);

    // Flat fill until the sky decodes, so first paint never waits on a texture.
    // Tinted to the HDRI's horizon rather than the old green, so the swap is a
    // sharpening rather than a colour change.
    this.scene.background = new THREE.Color(SKY_HORIZON);
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 40, 150);
    this.loadSky();

    this.world = new VoxelWorld(WORLD_SIZE, WORLD_SIZE, WORLD_SIZE, layeredGenerator(SURFACE_Y));
    // One cube at a time. An ant carries a grain, not a wheelbarrow — and it
    // makes the mound something you actually build rather than dump.
    this.session = new DigSession(this.world, { capacity: 1 });

    this.materialBundle = createVoxelMaterial();
    this.material = this.materialBundle.material;

    // Stands in for the sky until the real one decodes, then steps aside — an
    // environment map does the same job properly, and running both double-counts
    // the ambient term and washes the soil out.
    this.hemisphere = new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.15);
    this.scene.add(this.hemisphere);
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    // Tunnels get genuinely dark once the sky is behind you; without this the
    // whole underground half of the game is unplayable.
    this.headlamp = new THREE.PointLight(0xffd9a0, 1.6, 26, 1.4);
    this.scene.add(this.headlamp);

    // Pooled dirt. Allocated once, at full capacity, so a chip mid-dig never
    // triggers a mesh allocation on a phone.
    this.particleMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x6b543a, roughness: 1, metalness: 0 }),
      MAX_DIG_PARTICLES,
    );
    this.particleMesh.frustumCulled = false;
    this.particleMesh.count = 0;
    this.particleMesh.visible = false;
    this.scene.add(this.particleMesh);
    for (let i = 0; i < MAX_DIG_PARTICLES; i++) {
      this.particles.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 0.05,
      });
    }

    /*
     * The carried clod. One mesh and one material for the whole game — the
     * geometry is swapped when a load is picked up, never rebuilt, and the
     * colour is tinted per clod through the material rather than by cloning it.
     */
    this.clodMaterial = new THREE.MeshStandardMaterial({ roughness: 0.98, metalness: 0 });
    this.clodMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.clodMaterial);
    this.clodMesh.frustumCulled = false;
    this.clodMesh.visible = false;
    this.scene.add(this.clodMesh);

    // Batched spoil shares one material; per-instance colour carries the tint.
    // White base, because instanceColor MULTIPLIES it.
    this.soilMaterial = new THREE.MeshStandardMaterial({ roughness: 0.98, metalness: 0 });

    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xfff2a8, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.highlight.renderOrder = 2;
    this.highlight.visible = false;
    this.scene.add(this.highlight);
    box.dispose();

    this.position.set(WORLD_SIZE / 2 + 0.5, SURFACE_Y + 3, WORLD_SIZE / 2 + 0.5);

    // ?debug=den pre-carves a qualifying shaft + chamber and drops the queen in
    // it. Founding otherwise needs 40 voxels of hand-digging, which makes both
    // manual iteration and the smoke test impractical.
    const debugFlag = new URLSearchParams(window.location.search).get('debug');
    this.debug = debugFlag !== null;
    if (debugFlag === 'den') {
      this.carveDebugDen();
    }

    this.hud = document.createElement('div');
    this.actionButton = document.createElement('button');
    this.foundButton = document.createElement('button');
    this.jumpButton = document.createElement('button');
    this.objective = document.createElement('div');
    this.stick = document.createElement('div');
    this.stickKnob = document.createElement('div');
    this.buildOverlay();

    this.buildInitialMeshes();
    this.bindInput();
    this.resize();

    // iOS Safari fires `resize` mid-rotation with the OLD dimensions, so a
    // single handler isn't enough — re-measure on the visual viewport and
    // again shortly after an orientation change settles.
    const onResize = () => this.resize();
    const onRotate = () => {
      this.resize();
      window.setTimeout(onResize, 120);
      window.setTimeout(onResize, 400);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onRotate);
    window.visualViewport?.addEventListener('resize', onResize);
    this.cleanups.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onRotate);
      window.visualViewport?.removeEventListener('resize', onResize);
    });

    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.cleanups.forEach((fn) => fn());
    this.meshes.forEach((mesh) => {
      mesh.geometry.dispose();
      this.scene.remove(mesh);
    });
    this.meshes.clear();
    this.materialBundle.dispose();
    this.endChip();
    for (const batch of this.soilBatches.values()) this.scene.remove(batch);
    this.soilBatches.clear();
    this.soilMaterial.dispose();
    for (const geometry of this.clodGeometries.values()) geometry.dispose();
    this.clodGeometries.clear();
    this.clodMaterial.dispose();
    this.particleMesh.geometry.dispose();
    (this.particleMesh.material as THREE.Material).dispose();
    this.sky?.dispose();
    this.environment?.dispose();
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.hud.remove();
  }

  // ---------------------------------------------------------------- meshing

  private buildInitialMeshes(): void {
    for (const index of this.world.allMeshableChunks()) this.rebuildChunk(index);
  }

  /**
   * The world as the MESHER should see it — identical, except that the voxel
   * currently being chipped reads as air.
   *
   * `meshChunk` only wants `{ get }`, so hiding the target costs a four-line
   * proxy and no change to the mesher at all. This is deliberately render-only:
   * `this.world` remains the single source of truth for what exists, and the
   * mask exists purely so the procedural chipped mesh isn't drawn inside an
   * intact cube.
   */
  private meshSampler(): { get(x: number, y: number, z: number): number } {
    const hidden = this.chip?.voxel;
    if (!hidden) return this.world;
    return {
      get: (x, y, z) => (x === hidden.x && y === hidden.y && z === hidden.z
        ? AIR
        : this.world.get(x, y, z)),
    };
  }

  private rebuildChunk(index: number): void {
    const [cx, cy, cz] = this.world.chunkCoords(index);
    const data = meshChunk(this.meshSampler(), cx, cy, cz);
    const existing = this.meshes.get(index);
    if (!data) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        this.meshes.delete(index);
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('aTileUv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(data.layers, 1));
    geometry.setAttribute('aTangent', new THREE.BufferAttribute(data.tangents, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = true;
    this.scene.add(mesh);
    this.meshes.set(index, mesh);
  }

  private drainDirty(): void {
    if (this.world.dirty.size === 0) return;
    for (const index of this.world.dirty) this.rebuildChunk(index);
    this.world.dirty.clear();
  }

  // ------------------------------------------------------------------ input

  private buildOverlay(): void {
    this.hud.className = 'dig-hud';
    this.hud.innerHTML = `
      <div class="dig-readout" id="dig-readout"></div>
      <div class="dig-crosshair"></div>
      <div class="dig-controls"></div>
      <div class="dig-hint">Left half: walk &nbsp;·&nbsp; Right half: look &nbsp;·&nbsp; Tap soil to dig, tap a clod to carry</div>
    `;
    const controls = this.hud.querySelector('.dig-controls')!;
    this.actionButton.className = 'dig-btn dig-action';
    this.actionButton.textContent = '⛏ DIG';
    this.jumpButton.className = 'dig-btn dig-jump';
    this.jumpButton.textContent = '\u2191 JUMP';
    controls.appendChild(this.jumpButton);
    controls.appendChild(this.actionButton);

    const jumpDown = (event: Event) => {
      event.preventDefault();
      this.jumpQueued = true;
    };
    this.jumpButton.addEventListener('pointerdown', jumpDown);
    this.cleanups.push(() => this.jumpButton.removeEventListener('pointerdown', jumpDown));

    this.objective.className = 'dig-objective';
    this.objective.id = 'dig-objective';
    this.foundButton.className = 'dig-found';
    this.foundButton.id = 'dig-found';
    this.foundButton.textContent = '\u{1F451} FOUND THE QUEEN\u2019S DEN';
    this.foundButton.hidden = true;
    this.stick.className = 'dig-stick';
    this.stick.id = 'dig-stick';
    this.stickKnob.className = 'dig-stick-knob';
    this.stick.appendChild(this.stickKnob);
    this.hud.appendChild(this.stick);
    this.hud.appendChild(this.objective);
    this.hud.appendChild(this.foundButton);
    this.host.appendChild(this.hud);

    const foundDown = (event: Event) => {
      event.preventDefault();
      this.foundDen();
    };
    this.foundButton.addEventListener('pointerdown', foundDown);
    this.cleanups.push(() => this.foundButton.removeEventListener('pointerdown', foundDown));

    /*
     * The crosshair path, kept for two reasons the world-tap can't cover.
     *
     * CANCEL has to live somewhere fixed: once a dig is running the camera is
     * free to look away, and "tap the cube again" is no help if you can no
     * longer see it. And the cube underfoot is mostly hidden behind the HUD, so
     * looking down and pressing DIG beats trying to tap it.
     */
    const actionDown = (event: Event) => {
      event.preventDefault();
      this.doAction();
    };
    this.actionButton.addEventListener('pointerdown', actionDown);
    this.cleanups.push(() => this.actionButton.removeEventListener('pointerdown', actionDown));
  }

  /**
   * Swap the flat fill for the real sky once it decodes.
   *
   * Asynchronous and entirely optional: if the fetch fails the scene keeps the
   * solid horizon colour and stays perfectly playable, which is why this does
   * not block the constructor or the first frame.
   *
   * PMREM turns the equirectangular image into the pre-filtered mip chain that
   * MeshStandardMaterial needs for image-based lighting. Skipping it and
   * assigning the raw texture to `environment` produces a hard, sparkly result
   * because there is no roughness-aware blur.
   */
  private loadSky(): void {
    new THREE.TextureLoader().load(SKY_URL, (texture) => {
      if (this.disposed) return;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.SRGBColorSpace;

      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const environment = pmrem.fromEquirectangular(texture).texture;
      pmrem.dispose();

      this.sky = texture;
      this.environment = environment;
      this.scene.environment = environment;
      this.scene.environmentIntensity = SKY_LIGHT;
      // The stand-in hemisphere light hands over rather than stacking. A trace
      // is kept because image-based lighting alone leaves deep tunnels, which
      // the sky cannot see into, almost black.
      this.hemisphere.intensity = HEMI_WITH_SKY;
      // The colony view is a cutaway lit as underground; it must keep its dark
      // earth background even if the sky arrives after founding.
      if (!this.colonyView) this.scene.background = texture;
    }, undefined, () => {
      // Left on the flat colour deliberately — a missing sky is cosmetic.
    });
  }

  /* ------------------------------------------------- chipping the target */

  /**
   * Start showing the target coming apart.
   *
   * Hides the real voxel from chunk meshing, then draws the seeded crumb
   * cluster in its place. One chunk rebuild here and one when it ends; nothing
   * per frame. Refuses anything the dig logic wouldn't accept anyway, so
   * bedrock never gets a visual.
   */
  private beginChip(x: number, y: number, z: number): void {
    this.endChip();
    const voxel = this.world.get(x, y, z);
    if (!isSolid(voxel) || !materialOf(voxel).diggable) return;

    this.chip = {
      voxel: { x, y, z },
      pattern: buildFracture(x, y, z, voxel),
      progress: 0,
      lastProgress: 0,
      builtRemoved: -1,
      mesh: null,
    };
    this.rebuildChunkAt(x, y, z);
    this.refreshChipMesh();
  }

  /** Drop the temporary visual and put the intact voxel back on screen. */
  private endChip(): void {
    const chip = this.chip;
    if (!chip) return;
    if (chip.mesh) {
      this.scene.remove(chip.mesh);
      chip.mesh.geometry.dispose();
    }
    const { x, y, z } = chip.voxel;
    this.chip = null;
    // Clearing `chip` first is what un-masks it — the rebuild below sees the
    // real world again.
    this.rebuildChunkAt(x, y, z);
  }

  /**
   * Rebuild the chunk holding this voxel — AND any neighbour across a seam.
   *
   * Masking a voxel opens up its neighbours' faces toward it, and a face on a
   * chunk edge belongs to the NEIGHBOUR's mesh rather than this one. Rebuilding
   * only the owning chunk left those faces culled, so you could see straight
   * through the excavation into the sky. (64, 96, 64) sits on all three
   * boundaries at once, which is exactly where it showed up.
   *
   * The same rule VoxelWorld.markDirty already applies for real edits — the
   * render mask needs it for the same reason.
   */
  private rebuildChunkAt(x: number, y: number, z: number): void {
    const span = Math.ceil(WORLD_SIZE / CHUNK);
    const cx = Math.floor(x / CHUNK);
    const cy = Math.floor(y / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const touch = (nx: number, ny: number, nz: number) => {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= span || ny >= span || nz >= span) return;
      this.rebuildChunk(this.world.chunkIndex(nx, ny, nz));
    };
    touch(cx, cy, cz);
    const lx = x & (CHUNK - 1);
    const ly = y & (CHUNK - 1);
    const lz = z & (CHUNK - 1);
    if (lx === 0) touch(cx - 1, cy, cz);
    if (lx === CHUNK - 1) touch(cx + 1, cy, cz);
    if (ly === 0) touch(cx, cy - 1, cz);
    if (ly === CHUNK - 1) touch(cx, cy + 1, cz);
    if (lz === 0) touch(cx, cy, cz - 1);
    if (lz === CHUNK - 1) touch(cx, cy, cz + 1);
  }

  /**
   * Reconcile the visual with whatever DigSession currently says.
   *
   * Done in one place every frame rather than hooked onto each of the seven
   * call sites that can start or stop a dig. The session stays the only thing
   * that decides what is being dug; this just follows it, so no start, cancel,
   * out-of-reach abort or completion path can leave a stale crumb cluster
   * behind.
   */
  private syncChip(): void {
    const target = this.session.digging;
    if (!target) {
      if (this.chip) this.endChip();
      return;
    }
    const chip = this.chip;
    if (!chip || chip.voxel.x !== target.x || chip.voxel.y !== target.y || chip.voxel.z !== target.z) {
      this.beginChip(target.x, target.y, target.z);
    }
  }

  /** Regenerate the crumb geometry. Called only when a crumb actually breaks. */
  private refreshChipMesh(): void {
    const chip = this.chip;
    if (!chip) return;
    const { x, y, z } = chip.voxel;
    const data = chipMeshData(chip.pattern, x, y, z, chip.progress);
    if (!data) {
      if (chip.mesh) {
        this.scene.remove(chip.mesh);
        chip.mesh.geometry.dispose();
        chip.mesh = null;
      }
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setAttribute('aTileUv', new THREE.BufferAttribute(data.uvs, 2));
    geometry.setAttribute('aLayer', new THREE.BufferAttribute(data.layers, 1));
    geometry.setAttribute('aTangent', new THREE.BufferAttribute(data.tangents, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    if (chip.mesh) {
      chip.mesh.geometry.dispose();
      chip.mesh.geometry = geometry;
      return;
    }
    // Same material as the world, so the crumbs carry the same soil texture and
    // cost one extra draw call rather than a second shader.
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    chip.mesh = mesh;
  }

  /**
   * Advance the visual to match the dig.
   *
   * Geometry is rebuilt only when the number of surviving crumbs changes —
   * roughly a dozen times across a whole dig. Everything else here is a
   * transform, so holding a dig costs nothing per frame.
   */
  private updateChip(dt: number): void {
    const chip = this.chip;
    if (!chip) return;

    chip.lastProgress = chip.progress;
    chip.progress = Math.max(chip.progress, this.session.chewRatio);

    for (const event of eventsBetween(chip.pattern, chip.lastProgress, chip.progress)) {
      this.onDigEvent(event, chip);
    }

    const removed = removedAt(chip.pattern, chip.progress);
    if (removed !== chip.builtRemoved) {
      chip.builtRemoved = removed;
      this.refreshChipMesh();
    }

    if (chip.mesh) {
      // Loosened soil rocks slightly once it is nearly free. A transform, so it
      // costs nothing and never touches the geometry.
      this.chipClock += dt;
      const wobble = wobbleAt(chip.pattern, chip.progress, this.chipClock);
      const axis = chip.pattern.wobbleAxis;
      chip.mesh.position.set(axis.x * wobble, axis.y * wobble, axis.z * wobble);
      chip.mesh.rotation.set(axis.x * wobble, axis.y * wobble, axis.z * wobble);
    }
  }

  /**
   * Dust, sound cue and a nudge of the camera when soil actually gives way.
   *
   * Hooked off crumbs breaking rather than a frame timer, so the cadence
   * follows what you can see instead of hissing continuously.
   */
  private onDigEvent(event: DigEvent, chip: ActiveDigVisual): void {
    const origin = new THREE.Vector3(
      chip.voxel.x + event.at.x,
      chip.voxel.y + event.at.y,
      chip.voxel.z + event.at.z,
    );
    this.digAudio?.(event.kind, origin);

    if (event.kind === 'DIG_CHIP_SMALL' || event.kind === 'DIG_CHIP_LARGE') {
      const burst = Math.round((event.kind === 'DIG_CHIP_LARGE' ? 5 : 3) * chip.pattern.feel.dust);
      this.spawnDigParticles(origin, burst, chip.pattern.seed + chip.builtRemoved);
    }
    if (event.kind === 'DIG_RELEASE') {
      this.spawnDigParticles(origin, Math.round(8 * chip.pattern.feel.dust), chip.pattern.seed);
    }
    // Only the bigger moments move the camera, and barely. Continuous shake
    // while digging would be unbearable on a phone.
    if (event.kind === 'DIG_CHIP_LARGE') this.cameraKick = Math.max(this.cameraKick, 0.012);
    if (event.kind === 'DIG_RELEASE') this.cameraKick = Math.max(this.cameraKick, 0.03);
  }

  /* --------------------------------------------------------- carried soil */

  /**
   * Geometry for one (material, variant), built on first use and kept forever.
   *
   * There are at most 12 variants x 4 materials of ~80 triangles, so the whole
   * cache is trivial and nothing is ever generated during a frame.
   */
  private clodGeometry(material: VoxelId, variant: number): THREE.BufferGeometry {
    const key = `${material}:${variant}`;
    const cached = this.clodGeometries.get(key);
    if (cached) return cached;

    const shape: ClodShape = buildClodShape(variant, clodFeel(material));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(shape.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(shape.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(shape.indices, 1));
    geometry.computeBoundingSphere();
    geometry.userData.radius = clodRadius(shape);
    this.clodGeometries.set(key, geometry);
    return geometry;
  }

  /**
   * Keep the carried clod in step with the load.
   *
   * The load's `source` cell is its identity: the shape is a pure function of
   * where the soil came from, so the clod picked up is exactly the clod put
   * down, and the same cell dug again yields the same lump.
   */
  private syncClod(dt: number): void {
    if (this.clodFlight) {
      this.advanceClodFlight(dt);
      return;
    }

    const load = this.session.topLoad;
    if (!load || !load.source) {
      this.clodMesh.visible = false;
      this.clodStyle = null;
      return;
    }

    const style = styleForVoxel(load.source.x, load.source.y, load.source.z, load.material);
    if (!this.clodStyle || this.clodStyle.seed !== style.seed) {
      this.clodStyle = style;
      this.clodMesh.geometry = this.clodGeometry(style.material, style.variant);
      const base = materialOf(style.material).color;
      this.clodMaterial.color.setRGB(
        base[0] * style.tint, base[1] * style.tint, base[2] * style.tint,
      );
      this.clodMesh.scale.set(
        CLOD_SIZE * style.axisScale[0],
        CLOD_SIZE * style.axisScale[1],
        CLOD_SIZE * style.axisScale[2],
      );
      this.clodMesh.rotation.set(style.spin[0], style.spin[1], style.spin[2]);
    }
    this.clodMesh.visible = true;
    this.clodMesh.position.copy(this.mandiblePoint());
  }

  /**
   * Where the clod rides: just below and ahead of the eye, in the CAMERA's
   * frame, so it follows the head naturally and stays put on walls and
   * ceilings without any special-casing per orientation.
   */
  private mandiblePoint(): THREE.Vector3 {
    this.clodAnchor.set(0, -CLOD_DROP, -CLOD_AHEAD).applyQuaternion(this.camera.quaternion);
    return this.clodAnchor.add(this.camera.position);
  }

  /**
   * Throw the clod to the cell it is about to become.
   *
   * A short arc rather than an instant swap, so the player sees an irregular
   * lump being set down instead of a cube blinking into existence. The voxel
   * itself is deposited when the flight lands, so soil is in exactly one place
   * at every instant.
   */
  private beginClodFlight(to: THREE.Vector3): void {
    this.clodFlight = { from: this.mandiblePoint().clone(), to: to.clone(), t: 0 };
  }

  private advanceClodFlight(dt: number): void {
    const flight = this.clodFlight;
    if (!flight) return;
    flight.t = Math.min(1, flight.t + dt / CLOD_FLIGHT);
    const k = flight.t;
    this.clodMesh.visible = true;
    this.clodMesh.position.lerpVectors(flight.from, flight.to, k);
    // A small hop over the middle of the throw, so it reads as tossed rather
    // than slid along an invisible rail.
    this.clodMesh.position.y += Math.sin(k * Math.PI) * 0.18;
    this.clodMesh.rotation.x += dt * 5;
    if (flight.t >= 1) {
      this.clodFlight = null;
      this.clodMesh.visible = false;
      this.clodStyle = null;
    }
  }

  /* ------------------------------------------------------------ loose soil */

  /** The batch for one (material, variant), created on first sight of it. */
  private soilBatch(material: VoxelId, variant: number): THREE.InstancedMesh {
    const key = `${material}:${variant}`;
    const found = this.soilBatches.get(key);
    if (found) return found;
    const batch = new THREE.InstancedMesh(
      this.clodGeometry(material, variant), this.soilMaterial, SOIL_BATCH_CAPACITY,
    );
    batch.frustumCulled = false;
    batch.count = 0;
    batch.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(SOIL_BATCH_CAPACITY * 3), 3,
    );
    this.scene.add(batch);
    this.soilBatches.set(key, batch);
    return batch;
  }

  /**
   * Simulate and draw the spoil heap.
   *
   * Resting clods are asleep and cost nothing to simulate, so a nest full of
   * dirt stays affordable; only what is actually moving integrates. Drawing is
   * one pass that refills the instance matrices, which is cheap because there
   * are at most a couple of hundred of them and no allocation happens here.
   */
  private updateLooseSoil(dt: number): void {
    this.soil.step(this.world, dt, GRAVITY);

    /*
     * Clods deliberately ignore the ant, and she walks straight through them.
     *
     * She is the one piling the heap up, so a mound that shoved her around
     * would fight the thing it exists to let you build — you could never stand
     * on your own anthill. Spoil still falls, settles and stacks; it just does
     * not treat the digger as an obstacle.
     *
     * `LooseSoil.displace` stays for the things that SHOULD move it: other
     * insects, and weather once that exists. It is unwired for the player on
     * purpose, not by omission.
     */

    for (const batch of this.soilBatches.values()) batch.count = 0;
    for (const clod of this.soil.clods) {
      const style = styleForVoxel(clod.source.x, clod.source.y, clod.source.z, clod.material);
      const batch = this.soilBatch(clod.material, style.variant);
      if (batch.count >= SOIL_BATCH_CAPACITY) continue;
      const slot = batch.count;
      this.soilDummy.position.set(clod.position.x, clod.position.y, clod.position.z);
      this.soilDummy.rotation.set(style.spin[0], style.spin[1], style.spin[2]);
      this.soilDummy.scale.set(
        CLOD_SIZE * style.axisScale[0],
        CLOD_SIZE * style.axisScale[1],
        CLOD_SIZE * style.axisScale[2],
      );
      this.soilDummy.updateMatrix();
      batch.setMatrixAt(slot, this.soilDummy.matrix);
      const base = materialOf(clod.material).color;
      this.soilColor.setRGB(base[0] * style.tint, base[1] * style.tint, base[2] * style.tint);
      batch.setColorAt(slot, this.soilColor);
      batch.count = slot + 1;
    }
    for (const batch of this.soilBatches.values()) {
      batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------- particles */

  /**
   * Dirt fragments, pooled.
   *
   * One InstancedMesh with a hard cap, so this is a single draw call and
   * allocates nothing after construction. Purely cosmetic: particles are never
   * voxels, never counted, and never touch the carry load — soil conservation
   * runs entirely through DigSession and is not aware these exist.
   */
  private spawnDigParticles(origin: THREE.Vector3, count: number, seed: number): void {
    let spawned = 0;
    for (let i = 0; i < this.particles.length && spawned < count; i++) {
      const p = this.particles[i]!;
      if (p.life > 0) continue;
      // Seeded so a given chip always throws dirt the same way.
      const h = hashVoxel(seed + i, spawned, i * 7 + 1);
      const a = ((h & 0xffff) / 0xffff) * Math.PI * 2;
      const b = (((h >>> 16) & 0xffff) / 0xffff);
      const speed = 0.6 + b * 1.6;
      p.position.copy(origin);
      p.velocity.set(Math.cos(a) * speed * 0.6, 0.8 + b * 1.4, Math.sin(a) * speed * 0.6);
      p.life = 0.45 + b * 0.4;
      p.maxLife = p.life;
      p.size = 0.03 + b * 0.05;
      spawned++;
    }
  }

  private updateDigParticles(dt: number): void {
    let live = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      // Gravity plus drag. No collision — at this size it would cost more than
      // it would show, and these settle out of sight in under a second anyway.
      p.velocity.y -= GRAVITY * dt * 0.5;
      p.velocity.multiplyScalar(1 - Math.min(1, 2.4 * dt));
      p.position.addScaledVector(p.velocity, dt);
      const fade = Math.max(0, p.life / p.maxLife);
      this.particleDummy.position.copy(p.position);
      this.particleDummy.scale.setScalar(p.size * (0.4 + 0.6 * fade));
      this.particleDummy.rotation.set(p.position.x * 9, p.position.y * 7, p.position.z * 11);
      this.particleDummy.updateMatrix();
      this.particleMesh.setMatrixAt(live, this.particleDummy.matrix);
      live++;
    }
    this.particleMesh.count = live;
    this.particleMesh.visible = live > 0;
    if (live > 0) this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  /** Would a grain placed here end up inside the ant? */
  private overlapsSelf(x: number, y: number, z: number): boolean {
    const dx = Math.abs(x + 0.5 - this.position.x);
    const dz = Math.abs(z + 0.5 - this.position.z);
    return dx < BODY_RADIUS + 0.5 && dz < BODY_RADIUS + 0.5
      && y + 1 > this.position.y && y < this.position.y + EYE_HEIGHT;
  }

  private canDropAt(x: number, y: number, z: number): boolean {
    return this.world.get(x, y, z) === AIR
      && this.withinReach(x, y, z)
      && !this.overlapsSelf(x, y, z);
  }

  /**
   * Put the carried grain down.
   *
   * Prefers the cell the crosshair faces, but does NOT insist on it. At
   * one-cube reach the aim window on flat ground is genuinely narrow — pitch
   * too shallow and the ground you are looking at is two cubes out, too steep
   * and the placement cell is your own body — so insisting made DROP silently
   * do nothing at a lot of perfectly reasonable angles. That is the same
   * "I pressed it and nothing happened" failure the mode toggle was deleted for.
   *
   * An ant putting down a grain does not aim. She puts it down.
   */
  private dropCarried(): void {
    if (this.session.carried === 0) return;

    // Release it as a LOOSE clod rather than depositing a voxel. It lands, it
    // stays put, and from then on it can be shoved, knocked down a tunnel, or
    // picked up again — none of which terrain could be.
    const unit = this.session.release();
    // release() has ALREADY taken the unit out of the load, so every path from
    // here has to either place it or put it back. Returning early here was
    // silently destroying soil.
    if (!unit) return;
    if (!unit.source) {
      this.session.load.push(unit);
      return;
    }
    const at = this.dropSpot();
    const { forward } = this.surfaceBasis();
    const dropped = this.soil.drop(
      { x: at.x, y: at.y, z: at.z },
      unit.material,
      unit.source,
      // Barely a toss. It used to be flung forward hard enough to skitter over
      // the lip of the shaft she had just climbed out of and fall back in.
      { x: forward.x * 0.35, y: 0.15, z: forward.z * 0.35 },
    );
    if (!dropped) {
      // Heap full — put it straight back rather than destroying soil.
      this.session.load.push(unit);
      return;
    }
    this.clodStyle = null;
    this.digAudio?.('DIG_RELEASE', at.clone());
  }

  /**
   * Somewhere to set the clod down that it will not immediately roll away from.
   *
   * Dropping a fixed distance ahead pitched the clod straight down the shaft
   * she had just hauled it out of — you would carry a load to the surface, put
   * it down, and watch it fall back in. An ant tipping spoil onto a mound picks
   * a spot with ground under it, so this walks outward from her feet and takes
   * the first one that is actually supported.
   */
  private dropSpot(): THREE.Vector3 {
    const { forward, right } = this.surfaceBasis();
    const base = this.mandiblePoint();
    const down = this.upVec().negate();

    const clear = BODY_RADIUS + CLOD_RADIUS + 0.15;
    let fallback: THREE.Vector3 | null = null;
    // Straight ahead first, then fanned to either side — she will step around
    // a hole rather than tip the load into it.
    for (const side of [0, -0.5, 0.5, -0.9, 0.9]) {
      for (const ahead of [clear, clear + 0.5, clear + 1]) {
        const at = base.clone().addScaledVector(forward, ahead).addScaledVector(right, side);
        if (this.solidAt(at.x, at.y, at.z)) continue; // inside rock
        fallback ??= at;
        const below = at.clone().addScaledVector(down, CLOD_RADIUS + 0.4);
        if (this.solidAt(below.x, below.y, below.z)) return at;
      }
    }
    // Nothing supported within reach — put it down in front anyway and let it
    // fall. Better than refusing the drop and stranding her with a full load.
    return fallback ?? base.clone().addScaledVector(forward, clear);
  }

  /**
   * Turn the cube she has just freed into a clod lying in the hole.
   *
   * tickDig() puts the unit in the load first and this hands it straight out
   * again, which looks roundabout but is what keeps conservation airtight: the
   * soil is never in limbo, and if the heap is somehow full it simply stays in
   * the load rather than evaporating.
   */
  private spillDug(cell: { x: number; y: number; z: number }): void {
    const unit = this.session.release();
    if (!unit) return;
    const placed = this.soil.drop(
      { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 },
      unit.material,
      unit.source ?? cell,
    );
    if (!placed) this.session.load.push(unit);
  }

  /** The loose clod she could pick up right now, if any. */
  private clodInReach(): Clod | null {
    if (this.session.isFull) return null;
    const eye = this.camera.position;
    return this.soil.nearest({ x: eye.x, y: eye.y, z: eye.z }, REACH);
  }

  /** Pick a loose clod back up, if a hand is free. */
  private takeClod(clod: Clod): boolean {
    if (this.session.isFull) return false;
    if (!this.soil.remove(clod)) return false;
    this.session.load.push({ material: clod.material, count: 1, source: { ...clod.source } });
    return true;
  }

  /**
   * The best neighbouring cell to set a grain down in.
   *
   * Scored rather than first-match, so the spoil lands somewhere that reads as
   * deliberate: resting against something solid rather than hanging in the air,
   * low rather than overhead, and in front of her rather than behind.
   */
  private fallbackDropCell(): { x: number; y: number; z: number } | null {
    const eye = this.camera.position;
    const base = { x: Math.floor(eye.x), y: Math.floor(eye.y), z: Math.floor(eye.z) };
    const { forward } = this.surfaceBasis();
    const up = this.upVec();

    let best: { x: number; y: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let dy = -REACH_CUBES; dy <= REACH_CUBES; dy++) {
      for (let dz = -REACH_CUBES; dz <= REACH_CUBES; dz++) {
        for (let dx = -REACH_CUBES; dx <= REACH_CUBES; dx++) {
          const x = base.x + dx;
          const y = base.y + dy;
          const z = base.z + dz;
          if (!this.canDropAt(x, y, z)) continue;

          // Resting against something beats floating in mid-air.
          const braced = isSolid(this.world.get(x + 1, y, z)) || isSolid(this.world.get(x - 1, y, z))
            || isSolid(this.world.get(x, y + 1, z)) || isSolid(this.world.get(x, y - 1, z))
            || isSolid(this.world.get(x, y, z + 1)) || isSolid(this.world.get(x, y, z - 1));

          const to = new THREE.Vector3(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z).normalize();
          const score = (braced ? 100 : 0)
            + 10 * to.dot(forward)   // in front of her
            - 8 * to.dot(up);        // and down rather than overhead
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, z };
          }
        }
      }
    }
    return best;
  }

  /** Start (or cancel) a dig on a specific cube, if it's within reach. */
  private startDig(x: number, y: number, z: number): void {
    if (!this.withinReach(x, y, z)) return;
    this.session.toggleDig(x, y, z);
  }

  private showStick(visible: boolean): void {
    if (!visible) {
      this.stick.classList.remove('is-live');
      return;
    }
    this.stick.classList.add('is-live');
    this.stick.style.left = `${this.moveOrigin.x}px`;
    this.stick.style.top = `${this.moveOrigin.y}px`;
    this.stickKnob.style.transform =
      `translate(-50%, -50%) translate(${this.moveX * STICK_RADIUS}px, ${this.moveZ * STICK_RADIUS}px)`;
  }

  /**
   * DIG while idle, CANCEL while working. One button, because the two are never
   * both available and screen space is the scarce resource on a phone — the
   * same reasoning that made JUMP/CLIMB a single button.
   */
  /**
   * What the one action button does right now.
   *
   * Four states on a single button rather than two buttons that are each wrong
   * most of the time. DROP in particular only exists while she is actually
   * holding something — a standing DROP button is an invitation to throw soil
   * you did not know you had picked up, which is exactly what happened.
   */
  private actionMode(): 'cancel' | 'drop' | 'carry' | 'dig' {
    if (this.session.digging) return 'cancel';
    if (this.session.carried > 0) return 'drop';
    if (this.clodInReach()) return 'carry';
    return 'dig';
  }

  private refreshActionButton(): void {
    const mode = this.actionMode();
    const label = mode === 'cancel' ? '\u2715 CANCEL'
      : mode === 'drop' ? '\u2935 DROP'
        : mode === 'carry' ? '\u2934 CARRY'
          : '\u26cf DIG';
    if (this.actionButton.textContent !== label) this.actionButton.textContent = label;
    this.actionButton.classList.toggle('is-cancel', mode === 'cancel');
    this.actionButton.classList.toggle('is-carry', mode === 'carry');
    this.actionButton.classList.toggle('is-drop', mode === 'drop');
  }

  /** The one action, whatever it happens to be. Button, click and key share it. */
  private doAction(): void {
    switch (this.actionMode()) {
      case 'cancel':
        this.session.cancelDig();
        return;
      case 'drop':
        this.dropCarried();
        return;
      case 'carry': {
        const clod = this.clodInReach();
        if (clod) this.takeClod(clod);
        return;
      }
      default: {
        const hit = this.currentTarget();
        if (hit) this.startDig(hit.x, hit.y, hit.z);
      }
    }
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;

    // Desktop uses pointer lock: without it, the same drag that turns the
    // camera would also count as a dig, and you excavate whatever you look at.
    const locked = () => document.pointerLockElement === canvas;

    /** Distance between the two live touches, or 0. */
    const pinchSpan = (): number => {
      const pts = [...this.pointers.values()];
      const a = pts[0];
      const b = pts[1];
      if (!a || !b) return 0;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const down = (event: PointerEvent) => {
      // Suppresses the residual long-press gesture on browsers that ignore
      // -webkit-touch-callout. Safe because every input here is handled
      // manually; nothing depends on the default click/focus behaviour.
      if (event.cancelable) event.preventDefault();
      if (event.pointerType !== 'mouse') {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        // A second finger in colony view starts a pinch rather than an orbit.
        if (this.colonyView && this.pointers.size === 2) {
          this.pinchStart = { distance: pinchSpan(), orbit: this.orbit.distance };
          this.lookPointer = null;
          this.movePointer = null;
          this.showStick(false);
          return;
        }
      }
      if (event.pointerType === 'mouse') {
        if (!locked()) {
          void canvas.requestPointerLock();
          return; // this click only captures the cursor
        }
        // Locked, so there is no cursor to aim with — the crosshair is the
        // pointer, and click does whatever the action button would.
        this.doAction();
        return;
      }
      // Left 42% is the stick's activation zone; the rest looks.
      const zone = canvas.clientWidth * 0.42;
      if (event.clientX < zone && this.movePointer === null) {
        this.movePointer = event.pointerId;
        // The stick appears under the thumb, but its centre is clamped into a
        // lower-left region — a purely free-floating stick can spawn beside the
        // HUD or halfway up the screen, which wrecks precision while digging.
        this.moveOrigin = clampStickOrigin(event.clientX, event.clientY, {
          minX: STICK_RADIUS + 8,
          maxX: Math.max(STICK_RADIUS + 8, zone - STICK_RADIUS - 8),
          minY: canvas.clientHeight * 0.42,
          maxY: canvas.clientHeight - STICK_RADIUS - 12,
        });
        this.showStick(true);
      } else if (this.lookPointer === null) {
        this.lookPointer = event.pointerId;
        this.lookLast = { x: event.clientX, y: event.clientY };
        this.lookDown = { x: event.clientX, y: event.clientY, at: performance.now() };
      }
      // Throws if the pointer is already gone (fast taps, synthetic events);
      // capture is a nicety here, not something worth breaking the frame over.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    };

    const mouseLook = (event: MouseEvent) => {
      if (!locked()) return;
      if (this.colonyView) {
        this.orbit.yaw -= event.movementX * 0.004;
        this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + event.movementY * 0.003, -0.2, 1.4);
        return;
      }
      this.dragLook(event.movementX * 0.0022, event.movementY * 0.0022);
    };
    const lockChange = () => {
      if (!locked()) {
        this.session.cancelDig();
      }
    };
    document.addEventListener('mousemove', mouseLook);
    document.addEventListener('pointerlockchange', lockChange);

    const move = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      if (this.pointers.has(event.pointerId)) {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      // Pinch wins over orbit while two fingers are down.
      if (this.colonyView && this.pinchStart && this.pointers.size >= 2) {
        const span = pinchSpan();
        if (span > 8 && this.pinchStart.distance > 8) {
          // Fingers apart -> zoom in, so distance scales by the INVERSE ratio.
          const ratio = this.pinchStart.distance / span;
          this.orbit.distance = THREE.MathUtils.clamp(this.pinchStart.orbit * ratio, 6, 90);
        }
        return;
      }
      if (event.pointerId === this.lookPointer) {
        const dx = event.clientX - this.lookLast.x;
        const dy = event.clientY - this.lookLast.y;
        this.lookLast = { x: event.clientX, y: event.clientY };
        if (this.colonyView) {
          this.orbit.yaw -= dx * 0.006;
          this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.005, -0.2, 1.4);
        } else {
          this.dragLook(dx * 0.0045, dy * 0.0045);
        }
      } else if (event.pointerId === this.movePointer) {
        const v = stickVector(event.clientX - this.moveOrigin.x, event.clientY - this.moveOrigin.y, STICK_RADIUS);
        this.moveX = v.x;
        this.moveZ = v.y;
        this.stickMagnitude = v.magnitude;
        this.keyboardDriving = false;
        this.showStick(true);
      }
    };

    const up = (event: PointerEvent) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
      // Mouse digging is driven entirely by pointerdown now; releasing the
      // button must NOT cancel, or a click could never start a dig at all.
      if (event.pointerType === 'mouse') return;
      if (event.pointerId === this.lookPointer) {
        this.lookPointer = null;
        // A press that went nowhere and ended quickly was a tap at a cube, not
        // a look-drag. Colony view has nothing to dig, so it only ever looks.
        const travel = Math.hypot(event.clientX - this.lookDown.x, event.clientY - this.lookDown.y);
        const held = performance.now() - this.lookDown.at;
        if (!this.colonyView && travel <= TAP_MAX_PX && held <= TAP_MAX_MS) {
          this.tapAt(event.clientX, event.clientY);
        }
      }
      if (event.pointerId === this.movePointer) {
        this.movePointer = null;
        this.moveX = 0;
        this.moveZ = 0;
        this.stickMagnitude = 0;
        this.showStick(false);
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const contextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', contextMenu);

    const wheel = (event: WheelEvent) => {
      if (!this.colonyView) return;
      event.preventDefault();
      this.orbit.distance = THREE.MathUtils.clamp(this.orbit.distance + event.deltaY * 0.05, 6, 90);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });

    const keyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW': case 'ArrowUp': this.moveZ = -1; this.keyboardDriving = true; break;
        case 'KeyS': case 'ArrowDown': this.moveZ = 1; this.keyboardDriving = true; break;
        case 'KeyA': case 'ArrowLeft': this.moveX = -1; this.keyboardDriving = true; break;
        case 'KeyD': case 'ArrowRight': this.moveX = 1; this.keyboardDriving = true; break;
        case 'ShiftLeft': case 'ShiftRight': this.sprinting = true; break;
        case 'Space': this.jumpQueued = true; event.preventDefault(); break;
        case 'KeyG': this.jumpQueued = true; event.preventDefault(); break;
        case 'KeyE': case 'Tab': this.doAction(); event.preventDefault(); break;
        case 'KeyF': this.doAction(); event.preventDefault(); break;
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW': case 'ArrowUp': case 'KeyS': case 'ArrowDown': this.moveZ = 0; break;
        case 'KeyA': case 'ArrowLeft': case 'KeyD': case 'ArrowRight': this.moveX = 0; break;
        case 'ShiftLeft': case 'ShiftRight': this.sprinting = false; break;
      }
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);

    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('contextmenu', contextMenu);
      canvas.removeEventListener('wheel', wheel);
      document.removeEventListener('mousemove', mouseLook);
      document.removeEventListener('pointerlockchange', lockChange);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    });
  }

  // -------------------------------------------------------------- simulation

  private solidAt(x: number, y: number, z: number): boolean {
    return isSolid(this.world.get(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  // ------------------------------------------------------- surface frame

  /** World axis letter that the current `up` runs along. */
  private upAxis(): 'x' | 'y' | 'z' {
    const u = this.surface.up;
    return u.endsWith('_x') ? 'x' : u.endsWith('_y') ? 'y' : 'z';
  }

  private upSign(): number {
    return this.surface.up.startsWith('pos') ? 1 : -1;
  }

  private upVec(): THREE.Vector3 {
    const v = axisVector(this.surface.up);
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  /** Movement basis in the plane perpendicular to `up`, rotated by yaw. */
  private surfaceBasis(): { forward: THREE.Vector3; right: THREE.Vector3 } {
    const up = this.upVec();
    const rr = referenceRight(this.surface.up);
    const r0 = new THREE.Vector3(rr.x, rr.y, rr.z);
    const f0 = up.clone().cross(r0).normalize();
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const forward = f0.clone().multiplyScalar(cos).addScaledVector(r0, -sin).normalize();
    const right = r0.clone().multiplyScalar(cos).addScaledVector(f0, sin).normalize();
    return { forward, right };
  }

  /**
   * Change `up` without moving the view.
   *
   * yaw and pitch are measured inside a frame, so carrying the same numbers
   * across a reorientation points the camera somewhere unrelated — you look
   * down a shaft, mount its wall, and end up facing sideways. Solving them
   * again for the world direction you were already looking makes mounting
   * change only which way is down.
   */
  private reorient(up: AxisDirection, support: { x: number; y: number; z: number } | null): void {
    const from = this.surface.up;
    const look = lookVector(from, this.yaw, this.pitch);
    applyOrientation(this.surface, up, support);
    const solved = reframeLook(look, up, this.yaw);
    this.yaw = solved.yaw;
    this.pitch = solved.pitch;
    /*
     * Screen-up is always the frame's up, so preserving the look direction is
     * only half the job — the picture still spins about the centre of the
     * screen in a single frame. Seed the discontinuity as an offset that
     * cancels it exactly at the moment of the change and let it decay, so the
     * world TURNS into the new frame instead of cutting to it.
     */
    this.rollOffset += rollBetween(look, from, up);
    this.beginCameraTurn();
  }

  /**
   * Apply a screen drag to the look direction.
   *
   * Rotating the look vector about the camera's own axes and re-solving
   * yaw/pitch, rather than nudging yaw and pitch directly. Those two are
   * frame-relative, so driving them from a drag makes the controls change
   * meaning the moment the ant mounts a wall: sideways starts running along the
   * shaft and vertical starts moving toward and away from the rock.
   */
  private dragLook(dx: number, dy: number): void {
    const look = lookVector(this.surface.up, this.yaw, this.pitch);
    const turned = dragLook(look, this.surface.up, dx, dy);
    const solved = reframeLook(turned, this.surface.up, this.yaw);
    this.yaw = solved.yaw;
    this.pitch = solved.pitch;
  }

  /**
   * Does the ant's box overlap solid voxels here?
   *
   * The box is axis-aligned in the CURRENT frame: it runs EYE_HEIGHT along
   * `up` from the contact point, and BODY_RADIUS either side on the two
   * tangent axes. It is never interpolated through an in-between orientation —
   * an axis-aligned box at 43 degrees fits nowhere, and allowing one would
   * throw away the entire six-direction simplification.
   */
  private collides(at: THREE.Vector3, up = this.surface.up): boolean {
    const axis = up.endsWith('_x') ? 'x' : up.endsWith('_y') ? 'y' : 'z';
    const sign = up.startsWith('pos') ? 1 : -1;
    const lo = { x: 0, y: 0, z: 0 };
    const hi = { x: 0, y: 0, z: 0 };
    for (const a of ['x', 'y', 'z'] as const) {
      if (a === axis) {
        const reach = EYE_HEIGHT * sign;
        lo[a] = at[a] + Math.min(0, reach);
        hi[a] = at[a] + Math.max(0, reach);
      } else {
        lo[a] = at[a] - BODY_RADIUS;
        hi[a] = at[a] + BODY_RADIUS;
      }
    }
    for (let x = Math.floor(lo.x); x <= Math.floor(hi.x); x++) {
      for (let y = Math.floor(lo.y); y <= Math.floor(hi.y); y++) {
        for (let z = Math.floor(lo.z); z <= Math.floor(hi.z); z++) {
          if (isSolid(this.world.get(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  /** Axis-separated sweep so we slide along walls instead of sticking. */
  private tryAxis(axis: 'x' | 'y' | 'z', amount: number): boolean {
    if (amount === 0) return true;
    const next = this.position.clone();
    next[axis] += amount;
    if (this.collides(next)) {
      if (axis === this.upAxis()) {
        // Moving against `up` and blocked means we landed on our surface.
        if (amount * this.upSign() < 0) this.grounded = true;
        this.upVelocity = 0;
      }
      return false;
    }
    this.position.copy(next);
    return true;
  }

  /**
   * Move along the surface plane with a step-up. Walking into a rise of one
   * voxel lifts the ant over it, which is what turns a dug staircase into a
   * usable ramp — no sloped geometry required.
   */
  private moveOnSurface(axis: 'x' | 'y' | 'z', amount: number): boolean {
    if (this.tryAxis(axis, amount)) return true;
    const up = this.upVec();
    const saved = this.position.clone();
    const lifted = this.position.clone().addScaledVector(up, STEP_HEIGHT);
    if (!this.collides(lifted)) {
      this.position.copy(lifted);
      if (this.tryAxis(axis, amount)) return true;
      this.position.copy(saved);
    }
    this.wallNormal.set(0, 0, 0);
    this.wallNormal[axis] = amount > 0 ? -1 : 1;
    this.hasWall = true;
    return false;
  }

  /**
   * Jump — and jumping is the ONLY way off a surface.
   *
   * The ant clings to whatever she is on and crosses edges onto neighbouring
   * faces automatically; there is no release button, because "am I gripping?"
   * was a mode the player had to track for no benefit. Letting go is a
   * deliberate act with a cost, which is also how an ant behaves.
   *
   * Underground she is weightless, so a jump has to suspend that too or the
   * leap would be cancelled by the very rule it is meant to escape. `airborne`
   * holds gravity on until she lands again.
   */
  private jump(): void {
    if (this.surface.mode === 'attached') {
      /*
       * Releasing has to MOVE her, not just relabel which way is up.
       *
       * Every other frame change routes through surfaceContact() because the
       * body's footprint changes shape when `up` does — lying against a wall it
       * runs EYE_HEIGHT along Z and BODY_RADIUS along Y, and standing it is the
       * other way round. Release skipped that, so she reoriented while still
       * embedded in the wall and then launched from inside solid rock.
       *
       * There is no support voxel to stand on when letting go, so step out
       * along the wall normal until the standing body fits.
       */
      const away = this.upVec();
      const freed = this.position.clone();
      let fits = false;
      for (const step of [0, BODY_RADIUS + 0.05, 0.5, 1]) {
        const at = this.position.clone().addScaledVector(away, step);
        if (!this.collides(at, WORLD_UP)) { freed.copy(at); fits = true; break; }
      }
      if (!fits) return; // nowhere to let go into — better to keep hold
      this.position.copy(freed);
      this.reorient(WORLD_UP, null);
      this.upVelocity = JUMP_SPEED;
      this.grounded = false;
      this.airborne = true;
      return;
    }
    if (!this.grounded && !this.weightless) return;
    this.upVelocity = JUMP_SPEED;
    this.grounded = false;
    this.airborne = true;
  }

  private beginCameraTurn(): void {
    this.cameraTurn = 1;
  }

  /**
   * Place the contact point ON the face we're about to stand on.
   *
   * `position` is the contact point and the body runs EYE_HEIGHT along `up`,
   * so when `up` changes the body's footprint changes shape entirely — it
   * stops extending along Y and starts extending along Z, straight into the
   * wall being gripped. Without this the ant reorients while embedded in dirt.
   *
   * Returns null if the ant wouldn't fit there, in which case the caller must
   * refuse the transition rather than reorient into solid ground.
   */
  private surfaceContact(up: AxisDirection, voxel: { x: number; y: number; z: number }): THREE.Vector3 | null {
    const axis = up.endsWith('_x') ? 'x' : up.endsWith('_y') ? 'y' : 'z';
    const sign = up.startsWith('pos') ? 1 : -1;
    const oldUp = this.upVec();
    const oldAxis = this.upAxis();

    // The face of `voxel` pointing along `up`, nudged a hair clear so the
    // box's far edge doesn't floor() back into the voxel itself.
    const face = sign > 0 ? voxel[axis] + 1 + 0.002 : voxel[axis] - 0.002;

    /*
     * Rotating swaps which axis is the body's LONG one. Standing, the ant is
     * EYE_HEIGHT tall in Y and BODY_RADIUS wide in X/Z. Lying against a wall it
     * is EYE_HEIGHT long in Z and BODY_RADIUS wide in X *and Y* — so an ant
     * whose feet were flat on the floor now needs half its width of clearance
     * below, and the naive snap put it through the floor. Lift along the old up
     * until it fits, which is exactly what an ant does: it steps up onto the
     * wall rather than pivoting in place.
     */
    const lifts = oldAxis === axis ? [0] : [0, BODY_RADIUS + 0.05, 1, EYE_HEIGHT];
    for (const lift of lifts) {
      const at = this.position.clone().addScaledVector(oldUp, lift);
      at[axis] = face;
      if (!this.collides(at, up)) return at;
    }
    return null;
  }

  private updatePlayer(dt: number): void {
    tickLock(this.surface, dt * 1000);

    const { forward, right } = this.surfaceBasis();
    const wish = new THREE.Vector3()
      .addScaledVector(forward, -this.moveZ)
      .addScaledVector(right, this.moveX);
    const magnitude = this.keyboardDriving
      ? (this.sprinting ? 1 : KEY_MAGNITUDE)
      : Math.min(1, this.stickMagnitude);
    /*
     * Speed needs a DIRECTION, not just a magnitude.
     *
     * `magnitude` comes from the stick throw, and for keyboard it is pinned at
     * KEY_MAGNITUDE for as long as keyboardDriving is set — which outlives the
     * keypress. So releasing W left targetSpeed at walking pace forever: the
     * ant stood still (wish is the zero vector, so the step is zero) while
     * reporting 3.4 voxels/s and swaying as though mid-stride.
     */
    const moving = wish.lengthSq() > 1e-6;
    if (moving) wish.normalize();
    // Underground is close work, and a loaded ant is a working ant. Keyed off
    // depth rather than `weightless`, so speed depends on where she is and not
    // on what she happens to be brushing against.
    const load = this.position.y < UNDERGROUND_Y ? UNDERGROUND_SPEED : 1;
    const haul = this.session.carried > 0 ? CARRY_SPEED : 1;
    const targetSpeed = moving ? speedForStick(magnitude, DEFAULT_BANDS) * load * haul : 0;

    this.planarSpeed = approach(this.planarSpeed, targetSpeed, WALK_ACCEL, WALK_DECEL, dt);
    const step = wish.clone().multiplyScalar(this.planarSpeed * dt);
    this.lastStep.copy(wish);
    const pressing = targetSpeed > 0.01;

    if (this.jumpQueued) this.jump();
    this.jumpQueued = false;

    const upAxis = this.upAxis();
    const planarAxes = (['x', 'y', 'z'] as const).filter((a) => a !== upAxis);
    let blocked = false;
    for (const axis of planarAxes) {
      if (!this.moveOnSurface(axis, step[axis])) {
        blocked = true;
        this.planarSpeed = 0;
      }
    }
    const wallAhead = pressing && blocked;

    /*
     * Underground the ant is weightless.
     *
     * An ant in a tunnel is never really falling — it is inside a tube, in
     * contact with something at every moment. Removing gravity below the
     * surface deletes the whole "trapped at the bottom of a shaft" problem
     * class outright rather than mitigating it, and it is closer to how ants
     * actually move than any amount of floaty gravity tuning.
     *
     * The touching test is the safety valve: dig the floor out from under
     * yourself with nothing else in reach and gravity comes back, so you settle
     * onto something instead of hanging in a void forever.
     *
     * Above ground, gravity still pulls along -up as before — which is also
     * what makes gripping work, since attached `up` is the wall's normal and
     * gravity then presses the ant INTO the wall rather than down it.
     */
    const touching = rankSurfaces(this.world, this.position, this.surface, wish).length > 0;
    // `airborne` is what makes "jump releases you" true underground: without
    // it the leap would be cancelled by the weightlessness it is escaping.
    this.weightless = !this.airborne && this.position.y < UNDERGROUND_Y && touching;
    if (this.weightless) {
      /*
       * Always settle, and let COLLISION decide when she has landed.
       *
       * This used to ask supportBelow() whether something was underfoot and
       * zero the velocity if so. That is a grid query — it floors the position
       * to a cube and looks at the cube below THAT — being used to decide a
       * continuous position, and it left the ant hovering. Settling from 97.0
       * into a one-deep pit, the moment she crossed to 96.99 the cube below
       * (95) read solid, velocity was zeroed, and she stopped a full 0.99
       * voxels above a floor she is only 0.7 tall.
       *
       * The gravity branch never had this bug because it never asks: it moves
       * and lets collides() stop it, which is sub-voxel accurate. So does this
       * now. Constant speed rather than acceleration, so it stays a controlled
       * descent with no way to build up momentum — the only thing the original
       * design actually needed.
       */
      this.upVelocity = -SETTLE_SPEED;
    } else {
      this.upVelocity -= GRAVITY * dt;
      this.upVelocity = Math.max(this.upVelocity, TERMINAL_VELOCITY);
    }
    if (!wallAhead) this.hasWall = false;

    this.grounded = false;
    this.tryAxis(upAxis, this.upVelocity * dt * this.upSign());
    // Landed: gravity hands back to weightlessness, and sticking resumes.
    if (this.grounded) this.airborne = false;

    // Crossing onto an adjacent face. Proximity alone never commits — movement
    // has to point across the edge too, which is what lets you stand still low
    // on a wall without being yanked onto the floor.
    /*
     * Walking INTO a wall mounts it — the concave case.
     *
     * evaluateEdge only fires when support runs out, which handles crawling
     * over a lip but never happens while standing on a shaft floor. Without
     * this, "walk up the wall" did nothing in the one place it matters most.
     *
     * No longer gated on being weightless: the ant clings to whatever she
     * touches everywhere, above ground as well as below, and jumping is the
     * only way off. Excluding the surface made a wall behave differently
     * depending on which side of an invisible line it stood on.
     *
     * Still gated on committed movement and the hysteresis lock, so brushing a
     * wall while lining up a dig can't flip you and a corner can't ping-pong
     * between two faces. Step-up runs first, so `blocked` only means a rise the
     * ant genuinely cannot walk over.
     */
    // Pushing roughly AT the wall, not merely sliding along something that
    // happens to block an axis. `wallNormal` points back out of the wall, so a
    // head-on push gives a strongly negative dot.
    /*
     * Wall contact FLICKERS, and the dwell timer has to survive that.
     *
     * Being blocked zeroes planarSpeed, so the next frame she creeps forward
     * unobstructed and the frame after is blocked again. Measured while she
     * stood hard against a chamber wall: `blocked` alternated every frame, so a
     * timer that reset on any unblocked frame sat at 0.10 s forever and the
     * mount never fired at all. A short grace window reads that stutter as what
     * it actually is — continuous contact.
     */
    if (wallAhead && this.hasWall) this.wallContact = MOUNT_GRACE;
    else this.wallContact = Math.max(0, this.wallContact - dt);

    const intoWall = this.wallContact > 0 && pressing
      && wish.dot(this.wallNormal) <= -MOUNT_FACING;
    this.mountDwell = intoWall ? this.mountDwell + dt : 0;

    if (intoWall && !this.airborne && this.mountDwell >= MOUNT_DWELL
      && magnitude >= INPUT_COMMIT_THRESHOLD && canChangeOrientation(this.surface)) {
      const mount = axisFromVector(this.wallNormal);
      if (mount !== this.surface.up) {
        const mountSupport = supportBelow(this.world, this.position, mount);
        const contact = mountSupport ? this.surfaceContact(mount, mountSupport) : null;
        if (contact) {
          this.position.copy(contact);
          this.reorient(mount, mountSupport);
          this.upVelocity = 0;
        }
      }
    }

    // Walking across an edge makes the new face your floor — the convex case.
    if (this.weightless || this.surface.mode === 'attached' || this.surface.up !== WORLD_UP) {
      const decision = evaluateEdge(this.world, this.position, this.surface, wish, magnitude);
      if (decision.commit && decision.up) {
        const nextSupport = supportBelow(this.world, this.position, decision.up);
        const contact = nextSupport ? this.surfaceContact(decision.up, nextSupport) : null;
        if (contact) {
          this.position.copy(contact);
          this.reorient(decision.up, nextSupport);
          this.upVelocity = 0;
        }
      }
    }
    this.surface.support = supportBelow(this.world, this.position, this.surface.up);

    this.position.y = THREE.MathUtils.clamp(this.position.y, 1, WORLD_SIZE - 2);
    this.position.x = THREE.MathUtils.clamp(this.position.x, 1, WORLD_SIZE - 1);
    this.position.z = THREE.MathUtils.clamp(this.position.z, 1, WORLD_SIZE - 1);

    this.updateCamera(dt);
  }

  /**
   * Physics snaps between discrete frames; the camera eases. A 90 degree
   * first-person flip is among the most nausea-inducing things a game can do,
   * so the orientation slerps and the camera also bulges slightly outward
   * mid-turn — that reads as the body crawling AROUND the edge rather than the
   * world spinning about a stationary head.
   */
  private updateCamera(dt: number): void {
    const up = this.upVec();
    const { forward, right } = this.surfaceBasis();
    const basis = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
    const target = new THREE.Quaternion().setFromRotationMatrix(basis);

    this.cameraTurn = Math.max(0, this.cameraTurn - dt / CAMERA_TURN_TIME);
    const blend = 1 - Math.exp(-CAMERA_TURN_RATE * dt);
    this.cameraQuat.slerp(target, blend);

    const eye = this.position.clone().addScaledVector(up, EYE_HEIGHT);
    // A nudge when soil actually lets go, decaying fast. Only the bigger
    // moments set it, so this is a knock rather than a shake.
    if (this.cameraKick > 0) {
      this.cameraKick = Math.max(0, this.cameraKick - dt * 0.12);
      eye.addScaledVector(up, -this.cameraKick);
    }
    if (this.cameraTurn > 0) {
      // Peak the bulge mid-turn so the arc reads as travel over the edge.
      const arc = Math.sin(this.cameraTurn * Math.PI) * EDGE_ARC;
      eye.addScaledVector(up, arc);
    }
    this.camera.position.copy(eye);
    this.camera.quaternion.copy(this.cameraQuat);
    this.camera.rotateX(this.pitch);

    // A gentle sway while actually moving, so walking reads as legs cycling
    // rather than gliding. Nothing to do with orientation changes.
    const swayTarget = this.planarSpeed > 0.2
      ? Math.sin((this.climbPhase += dt * CLIMB_SWAY_HZ * Math.PI * 2)) * CLIMB_SWAY
      : 0;
    this.cameraRoll = THREE.MathUtils.lerp(this.cameraRoll, swayTarget, 1 - Math.exp(-10 * dt));
    // Bleed off the roll inherited from the last frame change at the same rate
    // the orientation itself eases, so the two read as one movement.
    this.rollOffset *= Math.exp(-CAMERA_TURN_RATE * dt);
    if (Math.abs(this.rollOffset) < 1e-4) this.rollOffset = 0;
    const roll = this.cameraRoll + this.rollOffset;
    if (Math.abs(roll) > 1e-4) this.camera.rotateZ(roll);

    this.headlamp.position.copy(this.camera.position);
  }

  /**
   * Chebyshev distance from the cube the eye is in — only the 3x3x3 shell of
   * cubes immediately around the ant is workable.
   */
  private withinReach(x: number, y: number, z: number): boolean {
    const ex = Math.floor(this.camera.position.x);
    const ey = Math.floor(this.camera.position.y);
    const ez = Math.floor(this.camera.position.z);
    return Math.max(Math.abs(x - ex), Math.abs(y - ey), Math.abs(z - ez)) <= REACH_CUBES;
  }

  /** Cast into the world along an arbitrary direction and clamp to reach. */
  private targetAlong(dir: THREE.Vector3) {
    const hit = raycastVoxel(
      this.world,
      this.camera.position.x, this.camera.position.y, this.camera.position.z,
      dir.x, dir.y, dir.z,
      REACH,
    );
    if (!hit) return null;
    return this.withinReach(hit.x, hit.y, hit.z) ? hit : null;
  }

  /** What the crosshair is on. */
  private currentTarget() {
    return this.targetAlong(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion));
  }

  /**
   * Dig the cube under a screen point.
   *
   * Same ray as the crosshair, just unprojected through the touch position
   * instead of screen centre — everything downstream is identical, which is why
   * tap-targeting and crosshair-targeting are one mechanic rather than two.
   */
  private tapAt(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize();
    // A clod sitting against a wall is in front of that wall, so a tap there
    // means the loose lump, not the soil behind it.
    const clod = this.clodInReach();
    if (clod && this.takeClod(clod)) return;
    const hit = this.targetAlong(dir);
    if (hit) this.startDig(hit.x, hit.y, hit.z);
  }

  private updateAction(dt: number): void {
    // The dig runs against its LOCKED cube, so looking away doesn't interrupt
    // it. Reach is the scene's business, so it is enforced here rather than in
    // the session: walk out of range and she stops working.
    const digging = this.session.digging;
    if (digging) {
      if (this.withinReach(digging.x, digging.y, digging.z)) {
        const outcome = this.session.tickDig(dt);
        // Freeing a cube leaves the spoil ON THE GROUND. Digging used to load
        // the ant silently, so DROP appeared without being asked for and the
        // next tap threw soil she did not know she was holding. Picking it up
        // is now its own deliberate act.
        if (outcome.kind === 'dug') this.spillDug(digging);
      } else this.session.cancelDig();
    }
    this.syncChip();
    this.updateChip(dt);
    this.syncClod(dt);

    // The highlight shows the locked cube while working, and whatever the
    // crosshair is on otherwise.
    const shown = this.session.digging ?? this.currentTarget();
    if (!shown) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.position.set(shown.x + 0.5, shown.y + 0.5, shown.z + 0.5);
    this.highlight.visible = true;
  }

  /**
   * Dev shortcut: a shaft down to den depth with a chamber hollowed at the
   * bottom. Deliberately a BOX rather than a sphere, because that is what a
   * player actually digs — and standing on the floor of a sphere samples only
   * 11 air voxels (the radius-2 ball reaches into the ground beneath), which
   * would fail the requirement that a real 3x3x3 pocket comfortably passes.
   */
  private carveDebugDen(): void {
    const cx = Math.floor(WORLD_SIZE / 2);
    const cz = Math.floor(WORLD_SIZE / 2);
    const floorY = SURFACE_Y - DEN_MIN_DEPTH - 2;
    for (let y = SURFACE_Y; y >= floorY; y--) this.world.dig(cx, y, cz);
    for (let dy = 0; dy < 3; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) this.world.dig(cx + dx, floorY + dy, cz + dz);
      }
    }
    this.position.set(cx + 0.5, floorY, cz + 0.5);
  }

  // ------------------------------------------------------------- founding

  /**
   * Commit the den and hand off. The queen stops being a character and becomes
   * the fixed point the colony is built around, so the camera detaches and
   * starts orbiting the chamber she just sealed herself into.
   */
  private foundDen(): void {
    const site = this.founding.found(this.world, this.position.x, this.position.y, this.position.z);
    if (!site) return;
    this.colonyView = true;
    // Orbiting from inside a solid volume means back-face culling shows you
    // straight through the soil, leaving the nest hanging in the sky colour.
    // That cutaway is genuinely the clearest way to read a burrow — it's what
    // an ant farm looks like — so lean into it: swap the sky for dark earth so
    // it reads as a cross-section rather than a rendering fault.
    this.scene.background = new THREE.Color(0x1a1410);
    this.scene.fog = new THREE.Fog(0x1a1410, 30, 190);
    this.session.cancelDig();
    this.highlight.visible = false;
    this.foundButton.hidden = true;
    this.actionButton.hidden = true;
    this.jumpButton.hidden = true;
    this.showStick(false);
    this.hud.classList.add('is-colony');
    // Frame the den from slightly above and outside.
    this.orbit = { yaw: this.yaw + Math.PI, pitch: 0.5, distance: 26 };
    this.announce(
      'The queen sheds her wings and seals the chamber.',
      'She will never leave it again \u2014 from here she lives on her own flight muscles until the first workers hatch.',
    );
  }

  private announce(title: string, body: string): void {
    const el = document.createElement('div');
    el.className = 'dig-toast';
    el.innerHTML = `<b>${title}</b><span>${body}</span>`;
    this.hud.appendChild(el);
    const timer = window.setTimeout(() => el.classList.add('is-out'), 6000);
    const gone = window.setTimeout(() => el.remove(), 7200);
    this.cleanups.push(() => {
      window.clearTimeout(timer);
      window.clearTimeout(gone);
      el.remove();
    });
  }

  /** Orbit the sealed den. Drag rotates, two fingers (or wheel) zoom. */
  private updateColonyCamera(): void {
    const den = this.founding.den;
    if (!den) return;
    const target = new THREE.Vector3(den.x + 0.5, den.y + 0.5, den.z + 0.5);
    const { yaw, pitch, distance } = this.orbit;
    this.camera.position.set(
      target.x + Math.sin(yaw) * Math.cos(pitch) * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * Math.cos(pitch) * distance,
    );
    this.camera.lookAt(target);
    this.headlamp.position.copy(target);
  }

  private updateHud(): void {
    const readout = this.hud.querySelector('#dig-readout');
    if (!readout) return;

    const status = this.founding.evaluate(this.world, this.position.x, this.position.y, this.position.z);
    this.objective.textContent = status.objective;
    this.objective.classList.toggle('is-ready', status.phase === 'ready');
    // Only offer the button while the site actually qualifies — step out of the
    // chamber and the offer withdraws, which teaches the requirement better
    // than any tooltip.
    this.foundButton.hidden = status.phase !== 'ready';

    if (this.colonyView) {
      const den = this.founding.den!;
      readout.innerHTML = `
        <b>Queen\u2019s den</b> ${den.depth * VOXEL_MM} mm down &nbsp;
        <b>Excavated</b> ${this.world.excavated} &nbsp;
        <b>Mound</b> ${this.world.deposited}<br>
        <span class="dim">${BUILD_LABEL} \u00b7 ${this.debug ? `dist ${this.orbit.distance.toFixed(1)} \u00b7 ` : ''}Colony view \u00b7 drag to orbit \u00b7 pinch or scroll to zoom</span>
      `;
      return;
    }

    // While digging, the readout follows the locked cube \u2014 the crosshair may be
    // pointing anywhere by then, and reporting what it sees would be a lie.
    const working = this.session.digging;
    const hit = working
      ? { voxel: this.world.get(working.x, working.y, working.z) }
      : this.currentTarget();
    const targetName = hit ? materialOf(hit.voxel).name : '\u2014';
    const chew = this.session.chewRatio;
    const bar = chew > 0 ? ` ${'\u25AE'.repeat(Math.round(chew * 8)).padEnd(8, '\u25AF')}` : '';
    // Practice is deliberately debug-only: she should just get better and you
    // should feel it, rather than watching a stat bar fill.
    const skill = this.debug
      ? ` \u00B7 ${this.session.secondsPerCube.toFixed(1)}s/cube after ${this.session.practiced}`
      : '';
    // Crumbs left on the voxel being chipped. Debug-only, but it is the one
    // piece of the effect a headless test can actually assert on.
    const chipping = this.debug && this.chip
      ? ` \u00B7 chip ${CELL_COUNT - removedAt(this.chip.pattern, this.chip.progress)}/${CELL_COUNT}`
      : '';
    const chamber = status.depthMet ? ` \u00b7 Chamber ${status.chamber}/${DEN_MIN_CHAMBER}` : '';
    readout.innerHTML = `
      <b>Depth</b> ${status.depth > 0 ? `${status.depthMm} mm` : 'surface'} &nbsp;
      <b>Carrying</b> ${this.session.carried}/${this.session.capacity} &nbsp;
      <b>Loose</b> ${this.soil.count} &nbsp;
      <b>Dug</b> ${this.world.excavated}<br>
      <span class="dim">${BUILD_LABEL} \u00b7 ${this.debug ? `pos ${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)} \u00b7 up ${this.surface.up} \u00b7 spd ${this.planarSpeed.toFixed(2)} \u00b7 ` : ''}${this.weightless ? '\u{1FAB5} weightless \u00b7 ' : this.surface.mode === 'attached' ? '\u{1F9D7} gripping \u00b7 ' : ''}Target: ${targetName}${bar}${chamber}${skill}${chipping} \u00b7 ${(this.world.allocatedBytes() / 1024).toFixed(0)} KB voxels \u00b7 ${this.meshes.size} chunks</span>
    `;
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    // updateStyle must stay ON. Passing `false` here resizes the draw buffer
    // but leaves the canvas element's CSS size frozen at whatever it was on
    // first paint, so rotating to landscape rendered a 852x393 buffer into a
    // 393x852 element — stretched, and hanging off the screen.
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    // Landscape on a phone is short; give the HUD a chance to compact itself.
    this.hud.classList.toggle('is-short', height < 500);
  }

  private hudCounter = 0;

  private readonly tick = (now: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    if (this.colonyView) {
      this.updateColonyCamera();
    } else {
      this.updatePlayer(dt);
      this.updateAction(dt);
    }
    // Dirt keeps falling through the founding cutscene, so this runs in both
    // views. It is a no-op with nothing alive.
    this.updateDigParticles(dt);
    if (!this.colonyView) this.updateLooseSoil(dt);
    this.drainDirty();
    if (++this.hudCounter % 6 === 0) {
      this.updateHud();
      this.refreshActionButton();
    }

    this.renderer.render(this.scene, this.camera);
  };
}

/** Materials/constants re-exported so tests and future scenes agree on scale. */
export const DIG_CONSTANTS = {
  WORLD_SIZE, SURFACE_Y, VOXEL_MM, CHUNK, AIR, TOPSOIL, MATERIALS,
} as const;
