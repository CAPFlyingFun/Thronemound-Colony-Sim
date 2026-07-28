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

const WORLD_SIZE = 128;
const SURFACE_Y = 96;
const VOXEL_MM = 5;

const EYE_HEIGHT = 1.6;
const BODY_RADIUS = 0.45;
const WALK_SPEED = 11;
const SPRINT_SPEED = 19;
const GRAVITY = 400;
const JUMP_SPEED = 34;
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
  private readonly material: THREE.MeshLambertMaterial;
  private readonly highlight: THREE.LineSegments;
  private readonly headlamp: THREE.PointLight;

  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private grounded = false;

  private mode: Mode = 'dig';
  private acting = false;
  private moveX = 0;
  private moveZ = 0;
  private sprinting = false;
  private jumpQueued = false;

  private readonly hud: HTMLDivElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly actionButton: HTMLButtonElement;

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

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });

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

    this.hud = document.createElement('div');
    this.modeButton = document.createElement('button');
    this.actionButton = document.createElement('button');
    this.buildOverlay();

    this.buildInitialMeshes();
    this.bindInput();
    this.resize();

    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));

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
    this.material.dispose();
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
    controls.appendChild(this.modeButton);
    controls.appendChild(this.actionButton);
    this.host.appendChild(this.hud);

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
      const half = canvas.clientWidth / 2;
      if (event.clientX < half && this.movePointer === null) {
        this.movePointer = event.pointerId;
        this.moveOrigin = { x: event.clientX, y: event.clientY };
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
        this.yaw -= dx * 0.0045;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0045, -1.5, 1.5);
      } else if (event.pointerId === this.movePointer) {
        const dx = event.clientX - this.moveOrigin.x;
        const dy = event.clientY - this.moveOrigin.y;
        const radius = 70;
        this.moveX = THREE.MathUtils.clamp(dx / radius, -1, 1);
        this.moveZ = THREE.MathUtils.clamp(dy / radius, -1, 1);
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
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const contextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', contextMenu);

    const keyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case 'KeyW': case 'ArrowUp': this.moveZ = -1; break;
        case 'KeyS': case 'ArrowDown': this.moveZ = 1; break;
        case 'KeyA': case 'ArrowLeft': this.moveX = -1; break;
        case 'KeyD': case 'ArrowRight': this.moveX = 1; break;
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

  /** Axis-separated AABB sweep so we slide along walls instead of sticking. */
  private moveAxis(axis: 'x' | 'y' | 'z', amount: number): void {
    if (amount === 0) return;
    const next = this.position.clone();
    next[axis] += amount;

    const minX = next.x - BODY_RADIUS;
    const maxX = next.x + BODY_RADIUS;
    const minY = next.y;
    const maxY = next.y + EYE_HEIGHT;
    const minZ = next.z - BODY_RADIUS;
    const maxZ = next.z + BODY_RADIUS;

    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        for (let z = Math.floor(minZ); z <= Math.floor(maxZ); z++) {
          if (!isSolid(this.world.get(x, y, z))) continue;
          if (axis === 'y') {
            if (amount < 0) this.grounded = true;
            this.velocity.y = 0;
          }
          return; // blocked on this axis; keep the other two
        }
      }
    }
    this.position.copy(next);
  }

  private updatePlayer(dt: number): void {
    const speed = this.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new THREE.Vector3()
      .addScaledVector(forward, -this.moveZ)
      .addScaledVector(right, this.moveX);
    if (wish.lengthSq() > 1) wish.normalize();

    if (this.jumpQueued && this.grounded) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpQueued = false;

    this.velocity.y -= GRAVITY * dt;
    this.velocity.y = Math.max(this.velocity.y, -260);
    this.grounded = false;

    this.moveAxis('x', wish.x * speed * dt);
    this.moveAxis('z', wish.z * speed * dt);
    this.moveAxis('y', this.velocity.y * dt);

    // Never let a mis-step drop the ant out of the volume.
    this.position.y = THREE.MathUtils.clamp(this.position.y, 1, WORLD_SIZE - 2);
    this.position.x = THREE.MathUtils.clamp(this.position.x, 1, WORLD_SIZE - 1);
    this.position.z = THREE.MathUtils.clamp(this.position.z, 1, WORLD_SIZE - 1);

    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
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

  private updateHud(): void {
    const readout = this.hud.querySelector('#dig-readout');
    if (!readout) return;
    const depth = Math.round((SURFACE_Y - this.position.y) * VOXEL_MM);
    const hit = this.currentTarget();
    const targetName = hit ? materialOf(hit.voxel).name : '—';
    const carried = this.session.carried;
    const mound = this.world.deposited;
    const chew = this.session.chewRatio;
    const bar = chew > 0 ? ` ${'▮'.repeat(Math.round(chew * 8)).padEnd(8, '▯')}` : '';
    readout.innerHTML = `
      <b>Depth</b> ${depth > 0 ? `${depth} mm` : 'surface'} &nbsp;
      <b>Carrying</b> ${carried}/${this.session.capacity} &nbsp;
      <b>Mound</b> ${mound} &nbsp;
      <b>Dug</b> ${this.world.excavated}<br>
      <span class="dim">Target: ${targetName}${bar} · ${(this.world.allocatedBytes() / 1024).toFixed(0)} KB voxels · ${this.meshes.size} chunks</span>
    `;
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private hudCounter = 0;

  private readonly tick = (now: number) => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    this.updatePlayer(dt);
    this.updateAction(dt);
    this.drainDirty();
    if (++this.hudCounter % 6 === 0) this.updateHud();

    this.renderer.render(this.scene, this.camera);
  };
}

/** Materials/constants re-exported so tests and future scenes agree on scale. */
export const DIG_CONSTANTS = {
  WORLD_SIZE, SURFACE_Y, VOXEL_MM, CHUNK, AIR, TOPSOIL, MATERIALS,
} as const;
