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
  isSolid, layeredGenerator, materialOf,
} from '../voxel/VoxelWorld';
import { meshChunk } from '../voxel/mesher';
import { raycastVoxel } from '../voxel/raycast';
import { DigSession } from '../voxel/DigSession';
import { createVoxelMaterial, type VoxelMaterialBundle } from '../voxel/voxelMaterial';
import { DEN_MIN_CHAMBER, DEN_MIN_DEPTH, QueenFounding } from '../voxel/QueenFounding';
import { DEFAULT_BANDS, approach, clampStickOrigin, speedForStick, stickVector } from '../voxel/locomotion';
import {
  WORLD_UP, applyOrientation, attachableWall, axisVector, createSurfaceState,
  INPUT_COMMIT_THRESHOLD, axisFromVector, canChangeOrientation,
  evaluateEdge, rankSurfaces, supportBelow, tickLock, type AxisDirection,
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

type Mode = 'dig' | 'place';

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
  /** Outward normal of the wall currently being pushed into, if any. */
  private readonly wallNormal = new THREE.Vector3();
  private hasWall = false;

  private readonly founding = new QueenFounding(SURFACE_Y, VOXEL_MM);
  /** After founding, the camera detaches from the queen and orbits the den. */
  private debug = false;
  private colonyView = false;
  private orbit = { yaw: 0.7, pitch: 0.55, distance: 26 };
  private pinchStart: { distance: number; orbit: number } | null = null;
  /** Every live touch, so a second finger can be recognised as a pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>();

  private mode: Mode = 'dig';
  private acting = false;
  private moveX = 0;
  private moveZ = 0;
  private stickMagnitude = 0;
  private keyboardDriving = false;
  private sprinting = false;
  private jumpQueued = false;

  private readonly hud: HTMLDivElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly actionButton: HTMLButtonElement;
  private readonly foundButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly objective: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;

  private lookPointer: number | null = null;
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

    this.scene.background = new THREE.Color(0x9fb98a);
    this.scene.fog = new THREE.Fog(0x9fb98a, 40, 150);

    this.world = new VoxelWorld(WORLD_SIZE, WORLD_SIZE, WORLD_SIZE, layeredGenerator(SURFACE_Y));
    // One cube at a time. An ant carries a grain, not a wheelbarrow — and it
    // makes the mound something you actually build rather than dump.
    this.session = new DigSession(this.world, { capacity: 1 });

    this.materialBundle = createVoxelMaterial();
    this.material = this.materialBundle.material;

    const hemisphere = new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.15);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.5);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    // Tunnels get genuinely dark once the sky is behind you; without this the
    // whole underground half of the game is unplayable.
    this.headlamp = new THREE.PointLight(0xffd9a0, 1.6, 26, 1.4);
    this.scene.add(this.headlamp);

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
    this.modeButton = document.createElement('button');
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

  private rebuildChunk(index: number): void {
    const [cx, cy, cz] = this.world.chunkCoords(index);
    const data = meshChunk(this.world, cx, cy, cz);
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
      <div class="dig-hint">Left half: walk &nbsp;·&nbsp; Right half: look &nbsp;·&nbsp; Hold ACTION to dig</div>
    `;
    const controls = this.hud.querySelector('.dig-controls')!;
    this.modeButton.className = 'dig-btn dig-mode';
    this.modeButton.textContent = '⛏ REMOVE';
    this.actionButton.className = 'dig-btn dig-action';
    this.actionButton.textContent = 'ACTION';
    this.jumpButton.className = 'dig-btn dig-jump';
    this.jumpButton.textContent = '\u2191 JUMP';
    controls.appendChild(this.modeButton);
    controls.appendChild(this.jumpButton);
    controls.appendChild(this.actionButton);

    const jumpDown = (event: Event) => {
      event.preventDefault();
      this.toggleGrip();
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

    const toggle = (event: Event) => {
      event.preventDefault();
      this.setMode(this.mode === 'dig' ? 'place' : 'dig');
    };
    this.modeButton.addEventListener('pointerdown', toggle);
    this.cleanups.push(() => this.modeButton.removeEventListener('pointerdown', toggle));

    const actionDown = (event: PointerEvent) => {
      event.preventDefault();
      this.acting = true;
      try { this.actionButton.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    };
    const actionUp = () => {
      this.acting = false;
      this.session.cancelDig();
    };
    this.actionButton.addEventListener('pointerdown', actionDown);
    this.actionButton.addEventListener('pointerup', actionUp);
    this.actionButton.addEventListener('pointercancel', actionUp);
    this.cleanups.push(() => {
      this.actionButton.removeEventListener('pointerdown', actionDown);
      this.actionButton.removeEventListener('pointerup', actionUp);
      this.actionButton.removeEventListener('pointercancel', actionUp);
    });
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
   * One button rather than three. Screen space is the scarce resource on a
   * phone, especially in landscape, so the label changes with context instead
   * of the layout changing under the thumb.
   */
  private refreshGripButton(): void {
    if (this.colonyView) return;
    const attached = this.surface.mode === 'attached';
    const { forward } = this.surfaceBasis();
    const wall = attached ? null : attachableWall(this.world, this.position, this.surface, forward);
    const label = attached ? '\u2934 RELEASE' : wall ? '\u{1F9D7} CLIMB' : '\u2191 JUMP';
    if (this.jumpButton.textContent !== label) this.jumpButton.textContent = label;
    this.jumpButton.classList.toggle('is-grip', attached || wall !== null);
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.session.cancelDig();
    this.modeButton.textContent = mode === 'dig' ? '⛏ REMOVE' : '▦ ADD';
    this.modeButton.classList.toggle('is-place', mode === 'place');
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
        this.acting = true;
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
      this.yaw -= event.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0022, -1.5, 1.5);
    };
    const lockChange = () => {
      if (!locked()) {
        this.acting = false;
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
          this.yaw -= dx * 0.0045;
          this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0045, -1.5, 1.5);
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
      if (event.pointerType === 'mouse') {
        this.acting = false;
        this.session.cancelDig();
        return;
      }
      if (event.pointerId === this.lookPointer) {
        this.lookPointer = null;
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
        case 'KeyG': this.toggleGrip(); event.preventDefault(); break;
        case 'KeyE': case 'Tab':
          this.setMode(this.mode === 'dig' ? 'place' : 'dig');
          event.preventDefault();
          break;
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

  /**
   * A deterministic reference right-vector for each `up`, so yaw means the same
   * thing every time you attach to a given face. Forward falls out as up x
   * right, which keeps the basis right-handed in all six frames.
   */
  private referenceRight(): THREE.Vector3 {
    const axis = this.upAxis();
    return axis === 'y' ? new THREE.Vector3(1, 0, 0)
      : axis === 'x' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
  }

  /** Movement basis in the plane perpendicular to `up`, rotated by yaw. */
  private surfaceBasis(): { forward: THREE.Vector3; right: THREE.Vector3 } {
    const up = this.upVec();
    const r0 = this.referenceRight();
    const f0 = up.clone().cross(r0).normalize();
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const forward = f0.clone().multiplyScalar(cos).addScaledVector(r0, -sin).normalize();
    const right = r0.clone().multiplyScalar(cos).addScaledVector(f0, sin).normalize();
    return { forward, right };
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

  /** Grip the wall in front, or let go of the one we're on. */
  private toggleGrip(): void {
    if (this.surface.mode === 'attached') {
      applyOrientation(this.surface, WORLD_UP, null);
      this.upVelocity = 0;
      this.beginCameraTurn();
      return;
    }
    const { forward } = this.surfaceBasis();
    const wall = attachableWall(this.world, this.position, this.surface, forward);
    if (!wall) {
      if (this.grounded) {
        this.upVelocity = JUMP_SPEED;
        this.grounded = false;
      }
      return;
    }
    const support = supportBelow(this.world, this.position, wall);
    const contact = support ? this.surfaceContact(wall, support) : null;
    if (!contact) return; // no room on that face — better to refuse than embed
    this.position.copy(contact);
    applyOrientation(this.surface, wall, support);
    this.upVelocity = 0;
    this.planarSpeed = 0;
    this.beginCameraTurn();
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
    if (wish.lengthSq() > 0) wish.normalize();
    const targetSpeed = speedForStick(magnitude, DEFAULT_BANDS);

    this.planarSpeed = approach(this.planarSpeed, targetSpeed, WALK_ACCEL, WALK_DECEL, dt);
    const step = wish.clone().multiplyScalar(this.planarSpeed * dt);
    const pressing = targetSpeed > 0.01;

    if (this.jumpQueued && this.grounded && !this.weightless) {
      this.upVelocity = JUMP_SPEED;
      this.grounded = false;
    }
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
    this.weightless = this.position.y < UNDERGROUND_Y && touching;
    if (this.weightless) {
      /*
       * Weightless does not mean motionless. Zeroing velocity outright meant
       * the ant hovered over the hole it had just dug beneath itself, so
       * digging downward stopped lowering you at all.
       *
       * Instead: supported -> hold still; unsupported -> settle at a constant
       * slow rate until something is underfoot. Constant, so it is a controlled
       * descent rather than a fall — no acceleration means no speed to build
       * up, and therefore still no way to get trapped at the bottom of
       * anything.
       */
      const supported = supportBelow(this.world, this.position, this.surface.up) !== null;
      this.upVelocity = supported ? 0 : -SETTLE_SPEED;
      this.grounded = supported;
    } else {
      this.upVelocity -= GRAVITY * dt;
      this.upVelocity = Math.max(this.upVelocity, TERMINAL_VELOCITY);
    }
    if (!wallAhead) this.hasWall = false;

    this.grounded = false;
    this.tryAxis(upAxis, this.upVelocity * dt * this.upSign());

    // Crossing onto an adjacent face. Proximity alone never commits — movement
    // has to point across the edge too, which is what lets you stand still low
    // on a wall without being yanked onto the floor.
    /*
     * Underground, walking INTO a wall mounts it — the concave case.
     *
     * evaluateEdge only fires when support runs out, which handles crawling
     * over a lip but never happens while standing on a shaft floor. Without
     * this, "walk up the wall" simply did nothing in the one place it matters
     * most. It is gated on committed movement and on the hysteresis lock, so
     * brushing a wall while positioning to dig can't flip you, and a corner
     * can't ping-pong between two faces.
     */
    if (this.weightless && wallAhead && this.hasWall
      && magnitude >= INPUT_COMMIT_THRESHOLD && canChangeOrientation(this.surface)) {
      const mount = axisFromVector(this.wallNormal);
      if (mount !== this.surface.up) {
        const mountSupport = supportBelow(this.world, this.position, mount);
        const contact = mountSupport ? this.surfaceContact(mount, mountSupport) : null;
        if (contact) {
          this.position.copy(contact);
          applyOrientation(this.surface, mount, mountSupport);
          this.upVelocity = 0;
          this.beginCameraTurn();
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
          applyOrientation(this.surface, decision.up, nextSupport);
          this.upVelocity = 0;
          this.beginCameraTurn();
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
    if (Math.abs(this.cameraRoll) > 1e-4) this.camera.rotateZ(this.cameraRoll);

    this.headlamp.position.copy(this.camera.position);
  }

  private currentTarget() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const hit = raycastVoxel(
      this.world,
      this.camera.position.x, this.camera.position.y, this.camera.position.z,
      dir.x, dir.y, dir.z,
      REACH,
    );
    if (!hit) return null;
    // Chebyshev distance from the cube the eye is in: only the shell of cubes
    // immediately around the ant is workable.
    const ex = Math.floor(this.camera.position.x);
    const ey = Math.floor(this.camera.position.y);
    const ez = Math.floor(this.camera.position.z);
    const cubes = Math.max(Math.abs(hit.x - ex), Math.abs(hit.y - ey), Math.abs(hit.z - ez));
    return cubes <= REACH_CUBES ? hit : null;
  }

  private updateAction(dt: number): void {
    const hit = this.currentTarget();
    if (!hit) {
      this.highlight.visible = false;
      this.session.cancelDig();
      return;
    }

    if (this.mode === 'dig') {
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.highlight.visible = true;
      if (this.acting) this.session.digTick(hit.x, hit.y, hit.z, dt);
      else this.session.cancelDig();
      return;
    }

    // Place mode targets the empty cell against the face being looked at.
    const px = hit.x + hit.nx;
    const py = hit.y + hit.ny;
    const pz = hit.z + hit.nz;
    this.highlight.position.set(px + 0.5, py + 0.5, pz + 0.5);
    this.highlight.visible = true;
    if (!this.acting) return;
    // Don't brick yourself inside the ant's own body.
    const dx = Math.abs(px + 0.5 - this.position.x);
    const dz = Math.abs(pz + 0.5 - this.position.z);
    const overlapsSelf = dx < BODY_RADIUS + 0.5 && dz < BODY_RADIUS + 0.5
      && py + 1 > this.position.y && py < this.position.y + EYE_HEIGHT;
    if (overlapsSelf) return;
    if (this.session.place(px, py, pz).kind === 'placed') this.acting = false;
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
    this.acting = false;
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
    this.modeButton.hidden = true;
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

    const hit = this.currentTarget();
    const targetName = hit ? materialOf(hit.voxel).name : '\u2014';
    const chew = this.session.chewRatio;
    const bar = chew > 0 ? ` ${'\u25AE'.repeat(Math.round(chew * 8)).padEnd(8, '\u25AF')}` : '';
    const chamber = status.depthMet ? ` \u00b7 Chamber ${status.chamber}/${DEN_MIN_CHAMBER}` : '';
    readout.innerHTML = `
      <b>Depth</b> ${status.depth > 0 ? `${status.depthMm} mm` : 'surface'} &nbsp;
      <b>Carrying</b> ${this.session.carried}/${this.session.capacity} &nbsp;
      <b>Mound</b> ${this.world.deposited} &nbsp;
      <b>Dug</b> ${this.world.excavated}<br>
      <span class="dim">${BUILD_LABEL} \u00b7 ${this.debug ? `pos ${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)} \u00b7 up ${this.surface.up} \u00b7 spd ${this.planarSpeed.toFixed(2)} \u00b7 ` : ''}${this.weightless ? '\u{1FAB5} weightless \u00b7 ' : this.surface.mode === 'attached' ? '\u{1F9D7} gripping \u00b7 ' : ''}Target: ${targetName}${bar}${chamber} \u00b7 ${(this.world.allocatedBytes() / 1024).toFixed(0)} KB voxels \u00b7 ${this.meshes.size} chunks</span>
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
    this.drainDirty();
    if (++this.hudCounter % 6 === 0) { this.updateHud(); this.refreshGripButton(); }

    this.renderer.render(this.scene, this.camera);
  };
}

/** Materials/constants re-exported so tests and future scenes agree on scale. */
export const DIG_CONSTANTS = {
  WORLD_SIZE, SURFACE_Y, VOXEL_MM, CHUNK, AIR, TOPSOIL, MATERIALS,
} as const;
