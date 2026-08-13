import * as THREE from 'three';

import './sandboxTouch.css';
import { QueenModel } from '../../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../../anim/legDrive';
import {
  AIR, VOXEL_MM, VoxelWorld, isSolid, materialOf,
} from '../../voxel/VoxelWorld';
import {
  digAwareCornerHeight, groundHeight, isSurfaceCell,
  surfaceCornerHeight, surfaceFill, surfaceSlope,
  terrainGenerator, type TerrainOptions,
} from '../../voxel/terrain';
import { meshChunk } from '../../voxel/mesher';
import { raycastVoxel } from '../../voxel/raycast';
import { DigSession } from '../../voxel/DigSession';
import {
  createVoxelMaterial, type VoxelMaterialBundle,
} from '../../voxel/voxelMaterial';

/**
 * Ant mechanics sandbox — visual alignment + real digging pass.
 *
 * Controls:
 *   W/S walk, A/D turn, arrows aim the head.
 *   Space starts/cancels digging. E grabs/drops a loose clod.
 *
 * Presentation follows Joshy's current ?scene=sandbox scale/camera while the
 * terrain uses DigScene's smooth voxel-material path so it no longer looks
 * like a raw block/chunk debug world.
 */

const MODEL_SCALE = 5;
const WALK_SPEED_MM_S = 12;
const TURN_RATE = 2.4;
const RIDE_MM = 1.2;

const CAM_DIST_MM = 42;
const CAM_MIN_DIST_MM = 24;
const CAM_MAX_DIST_MM = 85;
const CAM_PITCH = 0.34;
const CAM_MIN_PITCH = -0.05;
const CAM_MAX_PITCH = 1.05;
const CAMERA_CHASE = 10;
const ORBIT_DRAG_YAW = 0.008;
const ORBIT_DRAG_PITCH = 0.006;

const WORLD_SIZE = 56;
const SURFACE_Y = 32;
const DIG_REACH_VOXELS = 2.2;
const DIG_PARTICLE_CAP = 28;
const DIG_PARTICLE_GRAVITY = 32;
const CLOD_SIZE_MM = 3.2;
const CLOD_GRAB_RANGE_MM = 13;
const CLOD_DROP_AHEAD_MM = 7;
const CARRY_FOLLOW_RATE = 18;

/** How far the touch stick's knob travels before it reads as full tilt. */
const STICK_RADIUS = 48;
/**
 * Radians of head aim per pixel of drag on the right half.
 *
 * Sized against the arrow keys rather than picked: they sweep at 1.5 rad/s,
 * so a brisk half-second press is about 0.75 rad. This puts that same sweep
 * in roughly a 190-pixel drag — a comfortable thumb's travel on a phone,
 * and the clamps (±45° yaw, ±30° pitch) stop it either way.
 */
const HEAD_DRAG_RATE = 0.004;

const TERRAIN: TerrainOptions = {
  surfaceY: SURFACE_Y,
  size: WORLD_SIZE,
  seed: 7,
};

const SKY_FALLBACK = 0xb9c7d4;
const SKY_URL = `${import.meta.env.BASE_URL}sky/puresky_2k.jpg`;

interface DigParticle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

export class AntMechanicsSandbox {
  ready = false;

  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly worker = new QueenModel('worker');
  private workerReady = false;

  private readonly world = new VoxelWorld(
    WORLD_SIZE,
    WORLD_SIZE,
    WORLD_SIZE,
    terrainGenerator(TERRAIN),
  );

  private readonly session = new DigSession(this.world, {
    capacityVoxels: 1,
    fractionOf: (x, y, z) => this.cellSoilFraction(x, y, z),

    // Sandbox tuning: immediate-feeling digging for interaction testing.
    // The full DigScene can keep its longer progression curve.
    digStart: 1.25,
    digStep: 0.04,
    digFloor: 0.65,
  });

  private readonly terrainRoot = new THREE.Group();
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly materialBundle: VoxelMaterialBundle;
  private readonly material: THREE.MeshStandardMaterial;

  private readonly hemisphere: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private sky: THREE.Texture | null = null;
  private environment: THREE.Texture | null = null;

  private readonly keys = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly antPos = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly jawScratch = new THREE.Vector3();
  private readonly soilFractionCache = new Map<string, number>();

  private facing = 0;
  private headYaw = 0;
  private headPitch = 0;

  // Free third-person orbit. Zero means directly behind the ant.
  private orbitYaw = 0;
  private orbitPitch = CAM_PITCH;
  private orbitDistance = CAM_DIST_MM;
  private orbitPointer: number | null = null;
  private orbitLast = { x: 0, y: 0 };

  // Immediate visual feedback while DigSession is counting down.
  private readonly digPreviewMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6b35a,
    emissive: 0x5a2f08,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.38,
    wireframe: true,
    depthWrite: false,
  });
  private readonly digPreview = new THREE.Mesh(
    new THREE.BoxGeometry(VOXEL_MM * 0.92, VOXEL_MM * 0.92, VOXEL_MM * 0.92),
    this.digPreviewMaterial,
  );

  private readonly digParticles: DigParticle[] = [];
  private readonly particleDummy = new THREE.Object3D();
  private readonly particleMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(0.45, 0),
    new THREE.MeshStandardMaterial({ color: 0x6b543a, roughness: 1, metalness: 0 }),
    DIG_PARTICLE_CAP,
  );
  private lastParticleStep = 0;

  private readonly looseClods: THREE.Mesh[] = [];
  private readonly clodGeometry = new THREE.DodecahedronGeometry(CLOD_SIZE_MM / 2, 0);
  private readonly clodMaterial = new THREE.MeshStandardMaterial({
    color: 0x70543b,
    roughness: 0.98,
    metalness: 0,
  });
  private heldClod: THREE.Mesh | null = null;
  private readonly carryTarget = new THREE.Vector3();

  /* ------------------------------------------------------- the thumb layer */

  /** The stick's contribution, in the same -1..1 the keys produce. */
  private touchWalk = 0;

  private touchTurn = 0;

  private stickPointer: number | null = null;

  private stickOrigin = { x: 0, y: 0 };

  /** While latched, the right half orbits the camera instead of aiming her
   *  head. Off by default: aiming is what this room is for. */
  private camLatch = false;

  private hud: HTMLDivElement | null = null;

  private stickEl: HTMLDivElement | null = null;

  private stickKnob: HTMLDivElement | null = null;

  private digBtn: HTMLButtonElement | null = null;

  private grabBtn: HTMLButtonElement | null = null;

  private camBtn: HTMLButtonElement | null = null;

  private disposed = false;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(SKY_FALLBACK);
    this.scene.fog = new THREE.Fog(SKY_FALLBACK, 120, 700);

    // Matches Joshy's current sandbox presentation.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);

    // Same stand-in lighting family as DigScene.
    this.hemisphere = new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.15);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
    this.sun.position.set(60, 120, 40);
    this.scene.add(this.hemisphere, this.sun);

    // Use DigScene's actual terrain material instead of a flat brown material.
    this.materialBundle = createVoxelMaterial();
    this.material = this.materialBundle.material;

    // meshChunk outputs voxel-space coordinates; sandbox/world presentation is mm.
    this.terrainRoot.scale.setScalar(VOXEL_MM);
    this.scene.add(this.terrainRoot);
    this.buildInitialMeshes();

    this.worker.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(this.worker.root);

    this.digPreview.visible = false;
    this.digPreview.renderOrder = 4;
    this.scene.add(this.digPreview);

    this.particleMesh.count = 0;
    this.particleMesh.visible = false;
    this.particleMesh.frustumCulled = false;
    this.scene.add(this.particleMesh);
    for (let i = 0; i < DIG_PARTICLE_CAP; i += 1) {
      this.digParticles.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        size: 0.3,
      });
    }

    const sx = Math.floor(WORLD_SIZE / 2);
    const sz = Math.floor(WORLD_SIZE / 2);
    const surfaceMm = groundHeight(sx, sz, TERRAIN) * VOXEL_MM;
    this.antPos.set(
      (sx + 0.5) * VOXEL_MM,
      surfaceMm + RIDE_MM,
      (sz + 0.5) * VOXEL_MM - 20,
    );

    void this.worker.load().then((ok) => {
      this.workerReady = ok;
    });

    this.loadSky();

    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);

    this.renderer.domElement.addEventListener('pointerdown', this.onOrbitDown);
    this.renderer.domElement.addEventListener('pointermove', this.onOrbitMove);
    this.renderer.domElement.addEventListener('pointerup', this.onOrbitUp);
    this.renderer.domElement.addEventListener('pointercancel', this.onOrbitUp);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });

    this.buildTouchHud();
    this.resize();
    /* Reachable from a console and from a probe, the way the island scene
     * is — a room whose controls cannot be driven from a test is a room
     * whose controls get verified by hand, once, and then trusted. */
    (window as unknown as { antSandbox?: unknown }).antSandbox = this;
    this.ready = true;
    this.animate();
  }

  /** Where she is and where she is looking — for a probe. */
  probeForTest(): {
    x: number; z: number; facing: number; headYaw: number; headPitch: number;
    digging: boolean; carrying: boolean;
  } {
    return {
      x: this.antPos.x,
      z: this.antPos.z,
      facing: this.facing,
      headYaw: this.headYaw,
      headPitch: this.headPitch,
      digging: this.session.digging !== null,
      carrying: this.heldClod !== null,
    };
  }

  /**
   * THE ON-SCREEN CONTROLS — the same actions the keys fire, nothing new.
   *
   * Every button calls the method the key calls, so there is one definition
   * of what DIG means and the two input routes cannot drift apart. Built
   * unconditionally rather than sniffing for a touch screen: a desktop
   * player loses nothing by having them, and a "is this mobile" test is a
   * thing that is wrong on somebody's device.
   */
  private buildTouchHud(): void {
    this.host.classList.add('tms-host');
    const hud = document.createElement('div');
    hud.className = 'tms-hud';

    const stick = document.createElement('div');
    stick.className = 'tms-stick';
    stick.style.display = 'none';
    const knob = document.createElement('div');
    knob.className = 'tms-stick-knob';
    stick.appendChild(knob);
    hud.appendChild(stick);

    const actions = document.createElement('div');
    actions.className = 'tms-actions';

    const button = (
      label: string, big: boolean, onPress: () => void,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = `tms-btn${big ? ' is-big' : ''}`;
      b.textContent = label;
      /* pointerdown, not click: a click waits to see whether the touch was
       * a drag, and a shovel that answers 300 ms late feels broken. */
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPress();
      });
      actions.appendChild(b);
      return b;
    };

    this.digBtn = button('\u{1FA8F}', true, () => this.toggleDigAction());
    this.grabBtn = button('\u{270B}', true, () => this.grabAction());
    this.camBtn = button('CAM', false, () => {
      this.camLatch = !this.camLatch;
      this.refreshTouchChips();
    });
    button('RESET', false, () => this.recentreCamera());

    hud.appendChild(actions);

    const hint = document.createElement('div');
    hint.className = 'tms-hint';
    /*
     * THE BUILD IS ON THE HINT, and it is not decoration.
     *
     * This room had no version anywhere, so "the controls are not there" and
     * "the controls are there and I am looking at last week's bundle" were
     * the same picture. The service worker only OFFERS an update — it never
     * takes over on its own, by design — so running old code after a deploy
     * is the normal case, not the exotic one. A stamp turns that question
     * into a glance.
     */
    hint.textContent = `v${__APP_VERSION__} · left half: move · right half:`
      + ' aim her head · CAM: orbit instead';
    hud.appendChild(hint);

    this.host.appendChild(hud);
    this.hud = hud;
    this.stickEl = stick;
    this.stickKnob = knob;
    this.refreshTouchChips();
  }

  /** DIG latches while a dig is locked; CAM latches while it owns the drag. */
  private refreshTouchChips(): void {
    this.digBtn?.classList.toggle('is-on', this.session.digging !== null);
    this.grabBtn?.classList.toggle('is-on', this.heldClod !== null);
    this.camBtn?.classList.toggle('is-on', this.camLatch);
  }

  private showStick(x: number, y: number, dx: number, dy: number): void {
    if (!this.stickEl || !this.stickKnob) return;
    this.stickEl.style.left = `${x}px`;
    this.stickEl.style.top = `${y}px`;
    this.stickEl.style.display = '';
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /* Pointer capture is best-effort. A synthetic event, a pointer the browser
   * has already forgotten, an id from a device that has gone away — all of
   * them throw, and none of them should take the frame down with them. */
  private capture(id: number): void {
    try { this.renderer.domElement.setPointerCapture(id); } catch { /* fine */ }
  }

  private release(id: number): void {
    try { this.renderer.domElement.releasePointerCapture(id); } catch { /* fine */ }
  }

  private hideStick(): void {
    if (!this.stickEl || !this.stickKnob) return;
    this.stickEl.style.display = 'none';
    this.stickKnob.style.transform = 'translate(0px, 0px)';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);

    this.renderer.domElement.removeEventListener('pointerdown', this.onOrbitDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onOrbitMove);
    this.renderer.domElement.removeEventListener('pointerup', this.onOrbitUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.onOrbitUp);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);

    this.hud?.remove();
    this.hud = null;

    for (const mesh of this.meshes.values()) {
      this.terrainRoot.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();

    this.materialBundle.dispose();
    this.sky?.dispose();
    this.environment?.dispose();

    this.scene.remove(this.digPreview);
    this.digPreview.geometry.dispose();
    this.digPreviewMaterial.dispose();

    this.scene.remove(this.particleMesh);
    this.particleMesh.geometry.dispose();
    (this.particleMesh.material as THREE.Material).dispose();

    for (const clod of this.looseClods) this.scene.remove(clod);
    if (this.heldClod) this.scene.remove(this.heldClod);
    this.looseClods.length = 0;
    this.clodGeometry.dispose();
    this.clodMaterial.dispose();

    this.worker.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private loadSky(): void {
    new THREE.TextureLoader().load(
      SKY_URL,
      (texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }

        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;

        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const environment = pmrem.fromEquirectangular(texture).texture;
        pmrem.dispose();

        this.sky = texture;
        this.environment = environment;
        this.scene.background = texture;
        this.scene.environment = environment;
        this.scene.environmentIntensity = 0.85;
        this.hemisphere.intensity = 0.35;
      },
      undefined,
      () => {
        // Cosmetic only: keep fallback sky if the texture is unavailable.
      },
    );
  }

  // ---------------------------------------------------------- smooth terrain

  private static cellKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private readonly soilFill = (x: number, y: number, z: number): number => (
    surfaceFill(x, y, z, TERRAIN)
  );

  private readonly soilSlope = (
    x: number,
    y: number,
    z: number,
  ): readonly [number, number, number] | null => (
    isSurfaceCell(x, y, z, TERRAIN) ? surfaceSlope(x, z, TERRAIN) : null
  );

  private readonly readVoxel = (x: number, y: number, z: number): number => (
    this.world.get(x, y, z)
  );

  private readonly soilCorner = (cx: number, cz: number): number => (
    this.world.excavated === 0
      ? surfaceCornerHeight(cx, cz, TERRAIN)
      : digAwareCornerHeight(this.readVoxel, cx, cz, TERRAIN)
  );

  private cellSoilFraction(x: number, y: number, z: number): number {
    if (!isSurfaceCell(x, y, z, TERRAIN)) return 1;

    const key = AntMechanicsSandbox.cellKey(x, y, z);
    const cached = this.soilFractionCache.get(key);
    if (cached !== undefined) return cached;

    const c00 = this.soilCorner(x, z) - y;
    const c10 = this.soilCorner(x + 1, z) - y;
    const c01 = this.soilCorner(x, z + 1) - y;
    const c11 = this.soilCorner(x + 1, z + 1) - y;

    let sum = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const u = (i + 0.5) / 3;
        const v = (j + 0.5) / 3;
        const fill = (
          c00 * (1 - u) * (1 - v)
          + c10 * u * (1 - v)
          + c01 * (1 - u) * v
          + c11 * u * v
        );
        sum += Math.min(1, Math.max(0, fill));
      }
    }

    const fraction = Math.max(0.05, sum / 9);
    this.soilFractionCache.set(key, fraction);
    return fraction;
  }

  private meshSampler(): {
    get(x: number, y: number, z: number): number;
    fill(x: number, y: number, z: number): number;
    slope(x: number, y: number, z: number): readonly [number, number, number] | null;
    cornerHeight(cx: number, cz: number): number;
  } {
    return {
      get: (x, y, z) => this.world.get(x, y, z),
      fill: this.soilFill,
      slope: this.soilSlope,
      cornerHeight: this.soilCorner,
    };
  }

  private buildInitialMeshes(): void {
    for (const index of this.world.allMeshableChunks()) {
      this.rebuildChunk(index);
    }
    this.world.dirty.clear();
  }

  private rebuildChunk(index: number): void {
    const [cx, cy, cz] = this.world.chunkCoords(index);
    const data = meshChunk(this.meshSampler(), cx, cy, cz);
    const existing = this.meshes.get(index);

    if (!data) {
      if (existing) {
        this.terrainRoot.remove(existing);
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
    this.terrainRoot.add(mesh);
    this.meshes.set(index, mesh);
  }

  private drainDirty(): void {
    if (this.world.dirty.size === 0) return;
    for (const index of this.world.dirty) this.rebuildChunk(index);
    this.world.dirty.clear();
  }

  // --------------------------------------------------------------------- input

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code.toLowerCase();

    if (
      code === 'space'
      || code.startsWith('arrow')
      || code === 'keyw'
      || code === 'keya'
      || code === 'keys'
      || code === 'keyd'
      || code === 'keyr'
      || code === 'keye'
    ) {
      event.preventDefault();
    }

    /* The three ACTIONS live in their own methods so the on-screen buttons
     * press exactly what the keys press. Two code paths for one action is
     * how a control ends up behaving differently depending on which hand
     * you used. */
    if (code === 'space' && !event.repeat) this.toggleDigAction();
    if (code === 'keye' && !event.repeat) this.grabAction();
    if (code === 'keyr' && !event.repeat) this.recentreCamera();

    this.keys.add(code);
  };

  /** Press starts a locked dig; press again cancels. DigScene's behaviour. */
  private toggleDigAction(): void {
    if (this.session.digging) {
      this.session.cancelDig();
      this.digPreview.visible = false;
    } else {
      this.startReachableDig();
    }
  }

  /** Hands full? put it down. Hands empty? pick the nearest one up. */
  private grabAction(): void {
    if (this.session.digging) return;
    if (this.heldClod) this.dropHeldClod();
    else this.tryGrabClod();
  }

  /** Back to a familiar rear chase view after free orbiting. */
  private recentreCamera(): void {
    this.orbitYaw = 0;
    this.orbitPitch = CAM_PITCH;
    this.orbitDistance = CAM_DIST_MM;
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.session.cancelDig();
    /* The stick goes with them. A finger that left while the tab did has no
     * pointerup coming, and she would walk on for ever. */
    this.stickPointer = null;
    this.touchWalk = 0;
    this.touchTurn = 0;
    this.hideStick();
  };

  /*
   * ONE PLACE DECIDES WHAT A DRAG MEANS, and the screen is split the way
   * the island splits it: the LEFT half is the stick, the RIGHT half is the
   * aim. A player who has held the island already knows this room.
   *
   * The right half AIMS HER HEAD — it is the arrow keys, which is what was
   * asked for ("the mouse pan as the arrow keys"), and it is the right
   * default because head aim is what this room exists to exercise: the dig
   * and the grab both work off where her jaws point. Orbiting the camera is
   * still there, on the CAM latch, because a room you cannot look around is
   * not much of a sandbox.
   */
  private readonly onOrbitDown = (event: PointerEvent): void => {
    const half = (this.host.clientWidth || window.innerWidth) * 0.5;
    if (event.clientX < half) {
      if (this.stickPointer !== null) return;
      this.stickPointer = event.pointerId;
      this.stickOrigin = { x: event.clientX, y: event.clientY };
      this.showStick(event.clientX, event.clientY, 0, 0);
      this.capture(event.pointerId);
      return;
    }
    if (this.orbitPointer !== null) return;
    this.orbitPointer = event.pointerId;
    this.orbitLast = { x: event.clientX, y: event.clientY };
    this.capture(event.pointerId);
  };

  private readonly onOrbitMove = (event: PointerEvent): void => {
    if (event.pointerId === this.stickPointer) {
      const dx = Math.max(-STICK_RADIUS, Math.min(STICK_RADIUS,
        event.clientX - this.stickOrigin.x));
      const dy = Math.max(-STICK_RADIUS, Math.min(STICK_RADIUS,
        event.clientY - this.stickOrigin.y));
      /* Up the screen walks her forward; across TURNS her, matching W/S and
       * A/D rather than inventing a third meaning for sideways. */
      this.touchWalk = -dy / STICK_RADIUS;
      this.touchTurn = -dx / STICK_RADIUS;
      this.showStick(this.stickOrigin.x, this.stickOrigin.y, dx, dy);
      return;
    }
    if (event.pointerId !== this.orbitPointer) return;

    const dx = event.clientX - this.orbitLast.x;
    const dy = event.clientY - this.orbitLast.y;
    this.orbitLast = { x: event.clientX, y: event.clientY };

    if (this.camLatch) {
      this.orbitYaw -= dx * ORBIT_DRAG_YAW;
      this.orbitPitch = THREE.MathUtils.clamp(
        this.orbitPitch + dy * ORBIT_DRAG_PITCH,
        CAM_MIN_PITCH,
        CAM_MAX_PITCH,
      );
      return;
    }
    /* Her head, on the same clamps the arrow keys answer to — applied in
     * `animate`, so there is still exactly one place that bounds them. */
    this.headYaw -= dx * HEAD_DRAG_RATE;
    this.headPitch -= dy * HEAD_DRAG_RATE;
  };

  private readonly onOrbitUp = (event: PointerEvent): void => {
    if (event.pointerId === this.stickPointer) {
      this.release(event.pointerId);
      this.stickPointer = null;
      /* A stick whose finger vanished — capture stolen, tab hidden — must
       * not leave her walking. The island learned this one twice. */
      this.touchWalk = 0;
      this.touchTurn = 0;
      this.hideStick();
      return;
    }
    if (event.pointerId !== this.orbitPointer) return;

    this.release(event.pointerId);
    this.orbitPointer = null;
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();

    this.orbitDistance = THREE.MathUtils.clamp(
      this.orbitDistance + event.deltaY * 0.04,
      CAM_MIN_DIST_MM,
      CAM_MAX_DIST_MM,
    );
  };

  private readonly resize = (): void => {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  // --------------------------------------------------------- dig/carry feedback

  private spawnDigParticles(origin: THREE.Vector3, count: number): void {
    let spawned = 0;
    for (const p of this.digParticles) {
      if (spawned >= count) break;
      if (p.life > 0) continue;
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 9;
      p.position.copy(origin);
      p.velocity.set(
        Math.cos(angle) * speed,
        8 + Math.random() * 10,
        Math.sin(angle) * speed,
      );
      p.life = 0.35 + Math.random() * 0.45;
      p.maxLife = p.life;
      p.size = 0.28 + Math.random() * 0.5;
      spawned += 1;
    }
  }

  private updateDigParticles(dt: number): void {
    let live = 0;
    for (const p of this.digParticles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.velocity.y -= DIG_PARTICLE_GRAVITY * dt;
      p.velocity.multiplyScalar(1 - Math.min(0.9, dt * 2.8));
      p.position.addScaledVector(p.velocity, dt);
      const fade = Math.max(0, p.life / p.maxLife);
      this.particleDummy.position.copy(p.position);
      this.particleDummy.scale.setScalar(p.size * (0.45 + fade * 0.55));
      this.particleDummy.updateMatrix();
      this.particleMesh.setMatrixAt(live, this.particleDummy.matrix);
      live += 1;
    }
    this.particleMesh.count = live;
    this.particleMesh.visible = live > 0;
    if (live > 0) this.particleMesh.instanceMatrix.needsUpdate = true;
  }

  private spawnLooseClod(cell: { x: number; y: number; z: number }): void {
    const clod = new THREE.Mesh(this.clodGeometry, this.clodMaterial);
    clod.position.set(
      (cell.x + 0.5) * VOXEL_MM,
      (cell.y + 1.15) * VOXEL_MM,
      (cell.z + 0.5) * VOXEL_MM,
    );
    clod.rotation.set(Math.random(), Math.random(), Math.random());
    this.scene.add(clod);
    this.looseClods.push(clod);
  }

  private tryGrabClod(): void {
    if (!this.workerReady || this.looseClods.length === 0) return;
    const jaw = this.jawPositionMm(this.jawScratch);
    const forward = this.scratch.set(Math.sin(this.facing), 0, Math.cos(this.facing)).normalize();

    let best: THREE.Mesh | null = null;
    let bestScore = Infinity;
    for (const clod of this.looseClods) {
      const delta = clod.position.clone().sub(jaw);
      const distance = delta.length();
      if (distance > CLOD_GRAB_RANGE_MM) continue;
      const ahead = distance > 1e-4 ? delta.normalize().dot(forward) : 1;
      if (ahead < -0.15) continue;
      const score = distance - ahead * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = clod;
      }
    }
    if (!best) return;
    const index = this.looseClods.indexOf(best);
    if (index >= 0) this.looseClods.splice(index, 1);
    this.heldClod = best;
  }

  private dropHeldClod(): void {
    const clod = this.heldClod;
    if (!clod) return;
    const forward = this.scratch.set(Math.sin(this.facing), 0, Math.cos(this.facing)).normalize();
    const x = this.antPos.x + forward.x * CLOD_DROP_AHEAD_MM;
    const z = this.antPos.z + forward.z * CLOD_DROP_AHEAD_MM;
    const y = this.surfaceAtMm(x, z) + CLOD_SIZE_MM * 0.55;
    clod.position.set(x, y, z);
    clod.rotation.set(Math.random(), Math.random(), Math.random());
    this.looseClods.push(clod);
    this.heldClod = null;
  }

  private syncHeldClod(dt: number): void {
    const clod = this.heldClod;
    if (!clod || !this.workerReady) return;
    const jaw = this.jawPositionMm(this.carryTarget);
    jaw.x += Math.sin(this.facing) * 1.1;
    jaw.y -= 0.25;
    jaw.z += Math.cos(this.facing) * 1.1;
    clod.position.lerp(jaw, Math.min(1, dt * CARRY_FOLLOW_RATE));
    clod.rotation.y += dt * 1.2;
  }

  // ------------------------------------------------------------------- digging

  private jawPositionMm(into: THREE.Vector3): THREE.Vector3 {
    if (this.workerReady && this.worker.jawPosition(into)) return into;

    into.set(
      this.antPos.x + Math.sin(this.facing) * 3.4,
      this.antPos.y + 1,
      this.antPos.z + Math.cos(this.facing) * 3.4,
    );
    return into;
  }

  private startReachableDig(): void {
    const jaw = this.jawPositionMm(this.jawScratch);
    const dir = this.scratch.set(
      Math.sin(this.facing),
      -0.6,
      Math.cos(this.facing),
    ).normalize();

    const hit = raycastVoxel(
      this.world,
      jaw.x / VOXEL_MM,
      jaw.y / VOXEL_MM,
      jaw.z / VOXEL_MM,
      dir.x,
      dir.y,
      dir.z,
      DIG_REACH_VOXELS,
    );

    if (!hit) return;
    if (!isSolid(hit.voxel) || !materialOf(hit.voxel).diggable) return;

    const outcome = this.session.toggleDig(hit.x, hit.y, hit.z);

    if (outcome.kind === 'progress') {
      this.lastParticleStep = 0;
      this.digPreview.position.set(
        (hit.x + 0.5) * VOXEL_MM,
        (hit.y + 0.5) * VOXEL_MM,
        (hit.z + 0.5) * VOXEL_MM,
      );
      this.digPreview.scale.setScalar(1);
      this.digPreviewMaterial.opacity = 0.38;
      this.digPreview.visible = true;
    }
  }

  private updateDig(dt: number): void {
    const working = this.session.digging;

    if (!working) {
      this.digPreview.visible = false;
      this.lastParticleStep = 0;
      return;
    }

    const ratio = this.session.chewRatio;
    const origin = new THREE.Vector3(
      (working.x + 0.5) * VOXEL_MM,
      (working.y + 0.75) * VOXEL_MM,
      (working.z + 0.5) * VOXEL_MM,
    );

    this.digPreview.visible = true;
    this.digPreview.rotation.y += dt * (0.8 + ratio * 3.2);
    this.digPreview.rotation.x = ratio * 0.22;
    this.digPreview.scale.setScalar(1 - ratio * 0.34);
    this.digPreviewMaterial.opacity = 0.24 + ratio * 0.5;

    const particleStep = Math.floor(ratio * 8);
    if (particleStep > this.lastParticleStep) {
      this.spawnDigParticles(origin, 2 + Math.min(4, particleStep));
      this.lastParticleStep = particleStep;
    }

    const dugCell = { x: working.x, y: working.y, z: working.z };
    const outcome = this.session.tickDig(dt);

    if (outcome.kind === 'progress') return;

    if (outcome.kind === 'dug') {
      this.spawnDigParticles(origin, 10);
      this.spawnLooseClod(dugCell);
      this.digPreview.visible = false;
      this.lastParticleStep = 0;
      this.drainDirty();
      return;
    }

    this.digPreview.visible = false;
    this.lastParticleStep = 0;
  }

  // -------------------------------------------------------------- movement/gait

  private surfaceAtMm(xMm: number, zMm: number): number {
    const vx = xMm / VOXEL_MM;
    const vz = zMm / VOXEL_MM;

    if (vx < 0 || vz < 0 || vx >= WORLD_SIZE || vz >= WORLD_SIZE) return 0;

    if (this.world.excavated === 0) {
      return groundHeight(vx, vz, TERRAIN) * VOXEL_MM;
    }

    const x = Math.floor(vx);
    const z = Math.floor(vz);
    let y = Math.min(WORLD_SIZE - 1, Math.floor(this.antPos.y / VOXEL_MM) + 2);

    while (y >= 0 && this.world.get(x, y, z) === AIR) y -= 1;
    return (y + 1) * VOXEL_MM;
  }

  private poseWorker(dt: number, walk: number, turn: number): void {
    if (!this.workerReady) return;

    const digging = this.session.digging !== null;
    const carrying = this.heldClod !== null;

    this.worker.root.position.copy(this.antPos);
    this.worker.root.position.y = this.antPos.y - RIDE_MM;
    this.worker.root.rotation.set(0, this.facing, 0);

    this.worker.update(dt, {
      speed: Math.abs(walk) > 0.05 ? WALK_SPEED_MM_S / MODEL_SCALE : 0,
      turn: turn * TURN_RATE,
      digging: digging ? 1 : 0,
      carrying: carrying ? 1 : 0,
      headYaw: this.headYaw,
      headPitch: this.headPitch,
    });

    this.worker.solveFeet(
      (x, z) => this.surfaceAtMm(x, z),
      FOOT_CLEARANCE_MM,
      RIDE_MM * 2,
    );
  }

  private updateCamera(dt: number): void {
    // Orbit is relative to the ant's heading:
    //   0 = behind, ±PI/2 = either side, PI = looking back at her face.
    const viewYaw = this.facing + this.orbitYaw;
    const cp = Math.cos(this.orbitPitch);

    const desired = new THREE.Vector3(
      this.antPos.x - Math.sin(viewYaw) * this.orbitDistance * cp,
      this.antPos.y + Math.sin(this.orbitPitch) * this.orbitDistance,
      this.antPos.z - Math.cos(viewYaw) * this.orbitDistance * cp,
    );

    const cameraFloor = this.surfaceAtMm(desired.x, desired.z);
    desired.y = Math.max(desired.y, cameraFloor + 3);

    this.camera.position.lerp(desired, Math.min(1, dt * CAMERA_CHASE));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(
      this.antPos.x,
      this.antPos.y + 1.5,
      this.antPos.z,
    );
  }

  // ---------------------------------------------------------------- animation

  private animate = (): void => {
    if (this.disposed) return;

    const dt = Math.min(this.clock.getDelta(), 0.05);

    /* Keys OR stick, whichever is actually being asked for — clamped so
     * holding both cannot double her pace. */
    const walk = THREE.MathUtils.clamp(
      (this.keys.has('keyw') ? 1 : 0)
      - (this.keys.has('keys') ? 1 : 0)
      + this.touchWalk, -1, 1,
    );

    const turn = THREE.MathUtils.clamp(
      (this.keys.has('keya') ? 1 : 0)
      - (this.keys.has('keyd') ? 1 : 0)
      + this.touchTurn, -1, 1,
    );

    /* The latches are driven by state rather than by the taps that set it:
     * a dig ends on its own, and a carried clod is dropped by the same
     * button that picked it up. */
    this.refreshTouchChips();

    const headAimSpeed = 1.5;
    if (this.keys.has('arrowleft')) this.headYaw += headAimSpeed * dt;
    if (this.keys.has('arrowright')) this.headYaw -= headAimSpeed * dt;
    if (this.keys.has('arrowup')) this.headPitch += headAimSpeed * dt;
    if (this.keys.has('arrowdown')) this.headPitch -= headAimSpeed * dt;

    this.headYaw = THREE.MathUtils.clamp(
      this.headYaw,
      THREE.MathUtils.degToRad(-45),
      THREE.MathUtils.degToRad(45),
    );
    this.headPitch = THREE.MathUtils.clamp(
      this.headPitch,
      THREE.MathUtils.degToRad(-30),
      THREE.MathUtils.degToRad(30),
    );

    // The locked dig owns the worker while active; turning remains available.
    const canWalk = !this.session.digging;

    this.facing += turn * TURN_RATE * dt;

    if (canWalk && walk !== 0) {
      this.antPos.x += Math.sin(this.facing) * walk * WALK_SPEED_MM_S * dt;
      this.antPos.z += Math.cos(this.facing) * walk * WALK_SPEED_MM_S * dt;
    }

    const floor = this.surfaceAtMm(this.antPos.x, this.antPos.z) + RIDE_MM;
    this.antPos.y += (floor - this.antPos.y) * Math.min(1, dt * 12);

    this.updateDig(dt);
    this.updateDigParticles(dt);
    this.poseWorker(dt, canWalk ? walk : 0, turn);
    this.syncHeldClod(dt);
    this.updateCamera(dt);
    this.drainDirty();

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  };
}
