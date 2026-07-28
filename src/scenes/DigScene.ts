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

const WORLD_SIZE = 128;
const SURFACE_Y = 96;
const VOXEL_MM = 5;

const EYE_HEIGHT = 1.6;
const BODY_RADIUS = 0.45;
/** Speeds now come from the stick curve (locomotion.ts); these are its anchors. */
const WALK_ACCEL = 32;
const WALK_DECEL = 40;
/** Keyboard has no analogue axis, so it picks a band rather than full tilt. */
const KEY_MAGNITUDE = 0.7;
const STICK_RADIUS = 70;
/**
 * Tuned for an ant, not a person. By the square-cube law an ant has enormous
 * drag relative to its mass, so its terminal velocity is very low and falls
 * are effectively harmless — ants drop off things constantly and walk away.
 * The old 400 / -260 pair modelled a human being and read as heavy.
 */
const GRAVITY = 180;
const TERMINAL_VELOCITY = -60;
/**
 * Kept at ~1.45 voxels of jump height. Gravity and jump are coupled
 * (h = v^2 / 2g), so softening gravity without re-deriving this would have
 * silently turned a 1.4 voxel hop into a 3.2 voxel leap — enough to jump out
 * of shafts and make climbing pointless.
 */
const JUMP_SPEED = 23;
/** Rise the ant steps over without jumping — one voxel plus a hair. */
const STEP_HEIGHT = 1.05;
/** A crawl, about two body lengths per second. */
const CLIMB_SPEED = 4.5;
/** Seconds to reach full climb speed. Snapping to it read as levitating. */
const CLIMB_RAMP = 0.15;
/** Radians of lean toward a wall you're gripping. */
const CLIMB_LEAN = 0.07;
/** Amplitude and rate of the crawl sway while climbing. */
const CLIMB_SWAY = 0.025;
const CLIMB_SWAY_HZ = 2.4;
const REACH = 5.5;

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
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private grounded = false;
  private climbing = false;
  private climbRamp = 0;
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

  private mode: Mode = 'dig';
  private acting = false;
  private moveX = 0;
  private moveZ = 0;
  private stickMagnitude = 0;
  private keyboardDriving = false;
  private readonly horizontal = new THREE.Vector2();
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
    this.session = new DigSession(this.world, { capacity: 12 });

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

    const down = (event: PointerEvent) => {
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

  /** Does the ant's box overlap any solid voxel at this position? */
  private collides(at: THREE.Vector3): boolean {
    const minX = Math.floor(at.x - BODY_RADIUS);
    const maxX = Math.floor(at.x + BODY_RADIUS);
    const minY = Math.floor(at.y);
    const maxY = Math.floor(at.y + EYE_HEIGHT);
    const minZ = Math.floor(at.z - BODY_RADIUS);
    const maxZ = Math.floor(at.z + BODY_RADIUS);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
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
      if (axis === 'y') {
        if (amount < 0) this.grounded = true;
        this.velocity.y = 0;
      }
      return false;
    }
    this.position.copy(next);
    return true;
  }

  /**
   * Horizontal move with a step-up. Walking into a rise of one voxel lifts the
   * ant over it, which is what turns a dug staircase into a usable ramp — no
   * sloped geometry required, and the nest keeps looking like a real nest
   * (near-vertical shafts) rather than being forced into 45 degree corridors.
   */
  private moveHorizontal(axis: 'x' | 'z', amount: number): boolean {
    if (this.tryAxis(axis, amount)) return true;
    const savedY = this.position.y;
    const lifted = this.position.clone();
    lifted.y += STEP_HEIGHT;
    if (!this.collides(lifted)) {
      this.position.y = lifted.y;
      if (this.tryAxis(axis, amount)) return true;
      this.position.y = savedY;
    }
    // Blocked: the wall faces back along the way we were heading.
    this.wallNormal.set(0, 0, 0);
    this.wallNormal[axis] = amount > 0 ? -1 : 1;
    this.hasWall = true;
    return false;
  }

  private updatePlayer(dt: number): void {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new THREE.Vector3()
      .addScaledVector(forward, -this.moveZ)
      .addScaledVector(right, this.moveX);
    // Direction and magnitude are separate: direction comes from the stick
    // angle, speed from how far it's pushed. A keyboard has no analogue axis,
    // so it selects a band instead of always running flat out.
    const magnitude = this.keyboardDriving
      ? (this.sprinting ? 1 : KEY_MAGNITUDE)
      : Math.min(1, this.stickMagnitude);
    if (wish.lengthSq() > 0) wish.normalize();
    const targetSpeed = speedForStick(magnitude, DEFAULT_BANDS);

    // Accelerate toward the wish velocity rather than snapping to it — this is
    // what gives the ant any sense of mass at all.
    const targetX = wish.x * targetSpeed;
    const targetZ = wish.z * targetSpeed;
    this.horizontal.set(
      approach(this.horizontal.x, targetX, WALK_ACCEL, WALK_DECEL, dt),
      approach(this.horizontal.y, targetZ, WALK_ACCEL, WALK_DECEL, dt),
    );
    const pressing = targetSpeed > 0.01;

    if (this.jumpQueued && this.grounded) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpQueued = false;

    // Horizontal first, so we know whether a wall is in the way before deciding
    // between falling and climbing.
    const movedX = this.moveHorizontal('x', this.horizontal.x * dt);
    const movedZ = this.moveHorizontal('z', this.horizontal.y * dt);
    const wallAhead = pressing && (!movedX || !movedZ);
    // Kill the component that hit a wall so we don't keep integrating speed
    // into a surface we can't enter.
    if (!movedX) this.horizontal.x = 0;
    if (!movedZ) this.horizontal.y = 0;

    /**
     * Ants climb. Pushing into a wall walks straight up it, which is both what
     * real ants do and the thing that makes a vertical shaft survivable — a
     * 1.44 voxel jump can't get you out of a hole you dug three deep.
     */
    // Only climb when there is somewhere to climb TO. Without this check the
    // ant pins against a ceiling and hovers there — velocity is cancelled by
    // the blocked move but she never becomes grounded, so she can neither rise
    // nor fall. Refusing to climb lets gravity drop her back to the floor,
    // where she can walk to the shaft instead.
    const headroom = this.position.clone();
    headroom.y += 0.5;
    this.climbing = wallAhead && !this.collides(headroom);
    if (this.climbing) {
      // Ease into the climb. Jumping straight to full speed was most of why
      // this read as flying rather than crawling.
      this.climbRamp = Math.min(1, this.climbRamp + dt / CLIMB_RAMP);
      this.climbPhase += dt * CLIMB_SWAY_HZ * Math.PI * 2;
      this.velocity.y = CLIMB_SPEED * this.climbRamp;
    } else {
      this.climbRamp = Math.max(0, this.climbRamp - dt / CLIMB_RAMP);
      this.velocity.y -= GRAVITY * dt;
      this.velocity.y = Math.max(this.velocity.y, TERMINAL_VELOCITY);
    }
    if (!wallAhead) this.hasWall = false;

    this.grounded = false;
    this.tryAxis('y', this.velocity.y * dt);

    // Never let a mis-step drop the ant out of the volume.
    this.position.y = THREE.MathUtils.clamp(this.position.y, 1, WORLD_SIZE - 2);
    this.position.x = THREE.MathUtils.clamp(this.position.x, 1, WORLD_SIZE - 1);
    this.position.z = THREE.MathUtils.clamp(this.position.z, 1, WORLD_SIZE - 1);

    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);

    // Visual proof you're gripping something: lean into the wall, and sway as
    // the legs cycle. Without a cue like this, ascending a sheer face is
    // indistinguishable from levitating. Eased so it never snaps.
    let targetRoll = 0;
    if (this.climbing && this.hasWall) {
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const lateral = this.wallNormal.dot(right); // -1..1, which side the wall is on
      targetRoll = lateral * CLIMB_LEAN + Math.sin(this.climbPhase) * CLIMB_SWAY;
      targetRoll *= this.climbRamp;
    }
    this.cameraRoll = THREE.MathUtils.lerp(this.cameraRoll, targetRoll, 1 - Math.exp(-10 * dt));
    if (Math.abs(this.cameraRoll) > 1e-4) this.camera.rotateZ(this.cameraRoll);

    this.headlamp.position.copy(this.camera.position);
  }

  private currentTarget() {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return raycastVoxel(
      this.world,
      this.camera.position.x, this.camera.position.y, this.camera.position.z,
      dir.x, dir.y, dir.z,
      REACH,
    );
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
        <span class="dim">Colony view \u00b7 drag to orbit \u00b7 pinch or scroll to zoom</span>
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
      <span class="dim">${this.debug ? `pos ${this.position.x.toFixed(2)},${this.position.y.toFixed(2)},${this.position.z.toFixed(2)} \u00b7 spd ${this.horizontal.length().toFixed(2)} \u00b7 ` : ''}${this.climbing ? '\u{1F9D7} climbing \u00b7 ' : ''}Target: ${targetName}${bar}${chamber} \u00b7 ${(this.world.allocatedBytes() / 1024).toFixed(0)} KB voxels \u00b7 ${this.meshes.size} chunks</span>
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
    if (++this.hudCounter % 6 === 0) this.updateHud();

    this.renderer.render(this.scene, this.camera);
  };
}

/** Materials/constants re-exported so tests and future scenes agree on scale. */
export const DIG_CONSTANTS = {
  WORLD_SIZE, SURFACE_Y, VOXEL_MM, CHUNK, AIR, TOPSOIL, MATERIALS,
} as const;
