/**
 * THE CARRY ROOM — `?scene=carry`. Digging as picking things up.
 *
 * A 96 × 96 mm block of soil, 256 mm deep, built from 2 mm cubes — and a
 * 2 mm cube is very nearly one queen mouthful (her bite is 1.75 mm), so
 * the physical honesty every dig room fought for arrives here by
 * construction. Put the crosshair on a block and CARRY takes it in her
 * jaws; DROP sets it down against whatever face you are looking at. A
 * tunnel is exactly the blocks somebody walked out of it with.
 *
 * This is the old dig room's idea rebuilt on the procedural stack: the
 * real queen model with her gait, the rail room's cameras and HUD
 * conventions, and a fresh pure lattice (`blockCarry.ts`) instead of the
 * legacy `VoxelWorld`. One world unit is one millimetre, as in the rail
 * room.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import {
  BLOCK_MM, BlockGrid, meshChunk, raycastBlocks, type RayHit,
} from './blockCarry';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';

/** The room: 96 x 96 mm of soil, 256 mm deep, in 2 mm blocks. */
const CELLS_X = 48;
const SOIL_Y = 128;
const CELLS_Z = 48;

/**
 * The lattice is taller than the soil: 64 mm of air above the surface,
 * because spoil has to go SOMEWHERE — a grid solid to its own brim would
 * leave the first carried block with no legal cell to drop into.
 */
const CELLS_Y = SOIL_Y + 32;

/** The soil's top face sits at world y = 0; it extends down to -256. */
const FLOOR_MM = -SOIL_Y * BLOCK_MM;

/** Meshing chunk edge, in cells. 48/16 and 160/16 divide exactly. */
const CHUNK = 16;

const WALK_SPEED = 12;
const TURN_RATE = 2.4;

/** Her leg height — how far her body rides above what she stands on. */
const RIDE_MM = 1.2;

/** The tallest step she takes in stride: one block, and a hair for float
 *  error. Two blocks is a wall — DIG is how you pass a wall. */
const STEP_MM = BLOCK_MM + 0.2;

/** How far from her nose a block can be CARRIED from, or dropped to. */
const REACH_MM = 12;

/** How far the crosshair ray looks, in mm — targeting, not reaching. */
const RAY_MM = 260;

const MODEL_SCALE = 5;

const DEG = Math.PI / 180;

export class CarryScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly grid = new BlockGrid({ x: CELLS_X, y: CELLS_Y, z: CELLS_Z });

  private readonly chunkMeshes = new Map<string, THREE.Mesh>();

  private readonly soilMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
  });

  /* ----------------------------------------------------------------- ant */

  private readonly queen = new QueenModel('queen');

  private queenReady = false;

  private cart: THREE.Group | null = null;

  private readonly antPos = new THREE.Vector3(
    (CELLS_X * BLOCK_MM) / 2, RIDE_MM, (CELLS_Z * BLOCK_MM) / 2,
  );

  private facing = Math.PI;

  private aimPitchDeg = -20;

  private walkInput = 0;

  private turnInput = 0;

  private firstPerson = false;

  /** The block in her jaws, or null. Capacity one — the dig room's law. */
  private carrying = false;

  private carriedMesh: THREE.Mesh | null = null;

  private removed = 0;

  /* ------------------------------------------------------------ targeting */

  private target: RayHit | null = null;

  private targetReachable = false;

  private readonly highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(
      BLOCK_MM * 1.04, BLOCK_MM * 1.04, BLOCK_MM * 1.04,
    )),
    new THREE.LineBasicMaterial({ color: 0x51e07a, depthTest: false }),
  );

  /* ------------------------------------------------------------- cameras */

  private camYaw = -0.6;

  private camPitch = 0.5;

  private camDist = 70;

  private dragPointer: number | null = null;

  /* ----------------------------------------------------------------- HUD */

  private readonly hud: HTMLElement;

  private actBtn: HTMLButtonElement | null = null;

  private viewBtn: HTMLButtonElement | null = null;

  private readout: HTMLElement | null = null;

  private readonly crosshair = document.createElement('div');

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  private readoutAt = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xbfd6e8);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(160, 240, 90);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.85));

    const gridHelper = new THREE.GridHelper(400, 40, 0x7d8a96, 0xa8b6c2);
    gridHelper.position.set(
      (CELLS_X * BLOCK_MM) / 2, FLOOR_MM - 0.1, (CELLS_Z * BLOCK_MM) / 2,
    );
    this.scene.add(gridHelper);

    // Soil fills the lower SOIL_Y layers; the rest is headroom for spoil.
    for (let z = 0; z < CELLS_Z; z += 1) {
      for (let y = 0; y < SOIL_Y; y += 1) {
        for (let x = 0; x < CELLS_X; x += 1) this.grid.set(x, y, z, true);
      }
    }
    this.remeshAll();

    this.highlight.visible = false;
    this.highlight.renderOrder = 8;
    this.scene.add(this.highlight);

    this.queen.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(this.queen.root);
    this.queen.root.visible = false;
    void this.queen.load().then((ok) => { this.queenReady = ok; });
    this.buildCart();

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindPointer();

    (window as unknown as { carryScene?: unknown }).carryScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.ready = true;
    this.animate();
  }

  private buildCart(): void {
    const cart = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3, 2, 5),
      new THREE.MeshLambertMaterial({ color: 0xd8563c }),
    );
    body.position.y = 1.2;
    cart.add(body);
    this.cart = cart;
    this.scene.add(cart);
  }

  /* ------------------------------------------------------------- meshing */

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private remeshAll(): void {
    for (let cz = 0; cz < CELLS_Z / CHUNK; cz += 1) {
      for (let cy = 0; cy < CELLS_Y / CHUNK; cy += 1) {
        for (let cx = 0; cx < CELLS_X / CHUNK; cx += 1) {
          this.remeshChunk(cx, cy, cz);
        }
      }
    }
  }

  private remeshChunk(cx: number, cy: number, cz: number): void {
    const key = this.chunkKey(cx, cy, cz);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    const data = meshChunk(
      this.grid,
      cx * CHUNK, cy * CHUNK, cz * CHUNK,
      Math.min(CELLS_X, (cx + 1) * CHUNK),
      Math.min(CELLS_Y, (cy + 1) * CHUNK),
      Math.min(CELLS_Z, (cz + 1) * CHUNK),
    );
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const mesh = new THREE.Mesh(geometry, this.soilMaterial);
    mesh.position.y = FLOOR_MM;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  /** Remesh the chunk holding a cell, and any neighbour sharing its face. */
  private remeshAround(x: number, y: number, z: number): void {
    const seen = new Set<string>();
    for (const [dx, dy, dz] of [
      [0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!this.grid.inBounds(nx, ny, nz)) continue;
      const key = this.chunkKey(
        Math.floor(nx / CHUNK), Math.floor(ny / CHUNK), Math.floor(nz / CHUNK),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      this.remeshChunk(cx, cy, cz);
    }
  }

  /* -------------------------------------------------------- carry & drop */

  /** World top of the column under a point, in mm — what she stands on. */
  private topAt(xMm: number, zMm: number): number {
    const top = this.grid.columnTop(
      Math.floor(xMm / BLOCK_MM), Math.floor(zMm / BLOCK_MM),
    );
    return top < 0 ? FLOOR_MM : FLOOR_MM + top * BLOCK_MM;
  }

  /** Her nose, roughly — reach is measured from here. */
  private jawPoint(into: THREE.Vector3): void {
    if (this.queenReady && this.queen.jawPosition(into)) return;
    into.set(
      this.antPos.x + Math.sin(this.facing) * 4,
      this.antPos.y + 1.2,
      this.antPos.z + Math.cos(this.facing) * 4,
    );
  }

  /** The ray the crosshair means: her look in 1P, the camera's in 3P. */
  private crosshairRay(origin: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.firstPerson) {
      const pitch = this.aimPitchDeg * DEG;
      origin.copy(this.antPos)
        .add(new THREE.Vector3(0, 2.8, 0))
        .addScaledVector(new THREE.Vector3(
          Math.sin(this.facing), 0, Math.cos(this.facing),
        ), 1.4);
      dir.set(
        Math.sin(this.facing) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(this.facing) * Math.cos(pitch),
      );
      return;
    }
    origin.copy(this.camera.position);
    this.camera.getWorldDirection(dir);
  }

  private readonly rayOrigin = new THREE.Vector3();

  private readonly rayDir = new THREE.Vector3();

  private readonly jawScratch = new THREE.Vector3();

  private updateTarget(): void {
    this.crosshairRay(this.rayOrigin, this.rayDir);
    this.target = raycastBlocks(
      this.grid,
      this.rayOrigin.x / BLOCK_MM,
      (this.rayOrigin.y - FLOOR_MM) / BLOCK_MM,
      this.rayOrigin.z / BLOCK_MM,
      this.rayDir.x, this.rayDir.y, this.rayDir.z,
      RAY_MM / BLOCK_MM,
    );
    if (!this.target) {
      this.highlight.visible = false;
      this.targetReachable = false;
      this.refreshAction();
      return;
    }
    const [x, y, z] = this.target.cell;
    const centre = new THREE.Vector3(
      (x + 0.5) * BLOCK_MM,
      FLOOR_MM + (y + 0.5) * BLOCK_MM,
      (z + 0.5) * BLOCK_MM,
    );
    this.jawPoint(this.jawScratch);
    this.targetReachable = centre.distanceTo(this.jawScratch) <= REACH_MM;
    this.highlight.position.copy(centre);
    this.highlight.visible = true;
    (this.highlight.material as THREE.LineBasicMaterial).color.setHex(
      this.targetReachable ? 0x51e07a : 0xe0b23c,
    );
    this.refreshAction();
  }

  /** CARRY: the targeted block leaves the ground and rides in her jaws. */
  private carry(): void {
    if (this.carrying || !this.target || !this.targetReachable) return;
    const [x, y, z] = this.target.cell;
    if (!this.grid.set(x, y, z, false)) return;
    this.removed += 1;
    this.remeshAround(x, y, z);
    this.carrying = true;
    if (!this.carriedMesh) {
      this.carriedMesh = new THREE.Mesh(
        new THREE.BoxGeometry(BLOCK_MM, BLOCK_MM, BLOCK_MM),
        new THREE.MeshLambertMaterial({ color: 0x8a6b48 }),
      );
      this.scene.add(this.carriedMesh);
    }
    this.carriedMesh.visible = true;
    this.refreshAction();
  }

  /**
   * DROP: the block lands in the cell against the face she is looking at —
   * the way blocks stack anywhere blocks stack. With nothing (placeable)
   * under the crosshair it goes down at her feet instead, on top of
   * whatever column is in front of her, so a load can always be put down.
   */
  private drop(): void {
    if (!this.carrying) return;
    let placed = false;
    if (this.target && this.targetReachable) {
      const [x, y, z] = this.target.cell;
      const [nx, ny, nz] = this.target.normal;
      placed = this.grid.set(x + nx, y + ny, z + nz, true);
      if (placed) this.remeshAround(x + nx, y + ny, z + nz);
    }
    if (!placed) {
      const aheadX = this.antPos.x + Math.sin(this.facing) * 5;
      const aheadZ = this.antPos.z + Math.cos(this.facing) * 5;
      const cx = Math.floor(aheadX / BLOCK_MM);
      const cz = Math.floor(aheadZ / BLOCK_MM);
      const top = this.grid.columnTop(cx, cz);
      placed = this.grid.set(cx, Math.max(0, top), cz, true);
      if (placed) this.remeshAround(cx, Math.max(0, top), cz);
    }
    if (!placed) return; // no room anywhere she can reach — keep holding it
    this.removed -= 1;
    this.carrying = false;
    if (this.carriedMesh) this.carriedMesh.visible = false;
    this.refreshAction();
  }

  /* ----------------------------------------------------------------- HUD */

  private buildControls(): void {
    const right = document.createElement('div');
    right.className = 'density-lab-actions';
    this.hud.appendChild(right);

    this.actBtn = document.createElement('button');
    this.actBtn.className = 'density-lab-button density-lab-dig';
    this.actBtn.textContent = 'CARRY';
    this.actBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.carrying) this.drop();
      else this.carry();
    });
    right.appendChild(this.actBtn);

    const left = document.createElement('div');
    left.className = 'density-lab-actions';
    left.style.left = 'max(16px, env(safe-area-inset-left))';
    left.style.right = 'auto';
    left.style.alignItems = 'flex-start';
    this.hud.appendChild(left);

    const hold = (
      label: string, set: (on: boolean) => void, parent: HTMLElement,
    ): void => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-dig';
      button.style.width = '58px';
      button.style.height = '58px';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.setPointerCapture(e.pointerId);
        set(true);
      });
      const stop = (): void => set(false);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('lostpointercapture', stop);
      parent.appendChild(button);
    };
    hold('⇧', (on) => { this.walkInput = on ? 1 : 0; }, left);
    hold('⇩', (on) => { this.walkInput = on ? -1 : 0; }, left);
    const turnRow = document.createElement('div');
    turnRow.style.display = 'flex';
    turnRow.style.gap = '11px';
    left.appendChild(turnRow);
    hold('◀', (on) => { this.turnInput = on ? 1 : 0; }, turnRow);
    hold('▶', (on) => { this.turnInput = on ? -1 : 0; }, turnRow);

    this.viewBtn = document.createElement('button');
    this.viewBtn.className = 'density-lab-button density-lab-mode';
    this.viewBtn.style.position = 'absolute';
    this.viewBtn.style.top = 'max(14px, env(safe-area-inset-top))';
    this.viewBtn.style.right = 'max(16px, env(safe-area-inset-right))';
    this.viewBtn.style.pointerEvents = 'auto';
    this.viewBtn.textContent = 'HER EYES';
    this.viewBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setFirstPerson(!this.firstPerson);
    });
    this.hud.appendChild(this.viewBtn);

    this.readout = document.createElement('div');
    this.readout.className = 'density-lab-status rail-status';
    this.hud.appendChild(this.readout);

    this.crosshair.className = 'density-lab-crosshair';
    this.crosshair.style.pointerEvents = 'none';
    this.hud.appendChild(this.crosshair);

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'w') { this.walkInput = 1; return; }
      if (key === 's') { this.walkInput = -1; return; }
      if (key === 'a') { this.turnInput = 1; return; }
      if (key === 'd') { this.turnInput = -1; return; }
      if (e.repeat) return;
      if (key === ' ') {
        e.preventDefault();
        if (this.carrying) this.drop();
        else this.carry();
      }
      if (key === 'v') this.setFirstPerson(!this.firstPerson);
    });
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if ((key === 'w' && this.walkInput === 1)
        || (key === 's' && this.walkInput === -1)) this.walkInput = 0;
      if ((key === 'a' && this.turnInput === 1)
        || (key === 'd' && this.turnInput === -1)) this.turnInput = 0;
    });
    window.addEventListener('blur', () => {
      this.walkInput = 0;
      this.turnInput = 0;
    });
  }

  private setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    if (this.viewBtn) this.viewBtn.textContent = on ? 'OVER HER' : 'HER EYES';
  }

  /** The one button says what it will do — and dims when it can't. */
  private refreshAction(): void {
    if (!this.actBtn) return;
    const label = this.carrying ? 'DROP' : 'CARRY';
    if (this.actBtn.textContent !== label) this.actBtn.textContent = label;
    const can = this.carrying || (this.target !== null && this.targetReachable);
    this.actBtn.style.opacity = can ? '' : '0.45';
  }

  private refreshReadout(): void {
    if (!this.readout) return;
    const now = performance.now();
    if (now - this.readoutAt < 200) return;
    this.readoutAt = now;
    const text = `<b>carry room</b> · ${this.grid.solid.toLocaleString()} blocks
      · ${this.removed} out · jaws ${this.carrying ? 'FULL' : 'empty'}
      · ${this.target ? (this.targetReachable ? 'in reach' : 'too far') : 'no block'}`;
    this.readout.innerHTML = text;
  }

  /* ------------------------------------------------------------- pointer */

  private bindPointer(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (this.dragPointer === null) this.dragPointer = e.pointerId;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragPointer) return;
      if (this.firstPerson) {
        this.facing -= e.movementX * 0.004;
        this.aimPitchDeg = Math.min(80, Math.max(-85,
          this.aimPitchDeg - e.movementY * 0.25));
        return;
      }
      this.camYaw -= e.movementX * 0.005;
      this.camPitch = Math.min(1.45, Math.max(0.05,
        this.camPitch + e.movementY * 0.004));
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId === this.dragPointer) this.dragPointer = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = Math.min(400, Math.max(15, this.camDist * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  /* ---------------------------------------------------------------- loop */

  private simulate(dt: number): void {
    this.facing += this.turnInput * TURN_RATE * dt;

    if (this.walkInput !== 0) {
      const speed = WALK_SPEED * this.walkInput;
      const nx = this.antPos.x + Math.sin(this.facing) * speed * dt;
      const nz = this.antPos.z + Math.cos(this.facing) * speed * dt;
      const margin = BLOCK_MM;
      const cx = Math.min(CELLS_X * BLOCK_MM - margin, Math.max(margin, nx));
      const cz = Math.min(CELLS_Z * BLOCK_MM - margin, Math.max(margin, nz));
      const there = this.topAt(cx, cz);
      // One block is a stair; two is a wall. Down is always allowed —
      // that is what walking into your own diggings means.
      if (there - (this.antPos.y - RIDE_MM) <= STEP_MM) {
        this.antPos.x = cx;
        this.antPos.z = cz;
      }
    }
    const floor = this.topAt(this.antPos.x, this.antPos.z) + RIDE_MM;
    // Settle to the standing height: instant up (a stair), eased down (a
    // fall-lite that reads as climbing down into her own pit).
    if (floor > this.antPos.y) this.antPos.y = floor;
    else this.antPos.y += (floor - this.antPos.y) * Math.min(1, dt * 10);

    this.poseAnt(dt);
    this.updateTarget();
    this.aimCamera(dt);
    this.refreshReadout();
  }

  private poseAnt(dt: number): void {
    const body = this.queenReady ? this.queen.root : this.cart;
    if (this.cart) this.cart.visible = !this.queenReady && !this.firstPerson;
    if (!body) return;
    if (this.queenReady) this.queen.root.visible = !this.firstPerson;
    body.position.copy(this.antPos);
    body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.facing);

    if (this.queenReady) {
      this.queen.update(dt, {
        speed: (this.walkInput !== 0 ? WALK_SPEED : 0) / MODEL_SCALE,
        turn: this.turnInput * TURN_RATE,
        digging: 0,
        carrying: this.carrying ? 1 : 0,
        headYaw: 0,
      });
      this.queen.solveFeet(
        (x, z) => this.topAt(x, z),
        FOOT_CLEARANCE_MM,
        RIDE_MM * 2,
      );
      // The load rides in her jaws, where a mouthful belongs.
      if (this.carriedMesh && this.carrying) {
        this.jawPoint(this.jawScratch);
        this.carriedMesh.position.copy(this.jawScratch);
        this.carriedMesh.quaternion.copy(body.quaternion);
      }
    } else if (this.carriedMesh && this.carrying) {
      this.jawPoint(this.jawScratch);
      this.carriedMesh.position.copy(this.jawScratch);
    }
  }

  private aimCamera(dt: number): void {
    this.crosshair.style.display = '';
    if (this.firstPerson) {
      const pitch = this.aimPitchDeg * DEG;
      const fwd = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      const eye = this.antPos.clone()
        .add(new THREE.Vector3(0, 2.8, 0))
        .addScaledVector(fwd, 1.4);
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(
        eye.x + fwd.x * Math.cos(pitch),
        eye.y + Math.sin(pitch),
        eye.z + fwd.z * Math.cos(pitch),
      );
      return;
    }
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.antPos.x + Math.sin(this.camYaw) * this.camDist * cp,
      Math.max(this.antPos.y + Math.sin(this.camPitch) * this.camDist, FLOOR_MM + 4),
      this.antPos.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.antPos.x, this.antPos.y + 2, this.antPos.z);
    void dt;
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setAimForTest(facingDeg: number, pitchDeg: number): void {
    this.facing = facingDeg * DEG;
    this.aimPitchDeg = pitchDeg;
  }

  setWalkForTest(dir: -1 | 0 | 1): void { this.walkInput = dir; }

  setViewForTest(first: boolean): void { this.setFirstPerson(first); }

  carryForTest(): void { this.carry(); }

  dropForTest(): void { this.drop(); }

  teleportMm(x: number, z: number): void {
    this.antPos.x = x;
    this.antPos.z = z;
    this.antPos.y = this.topAt(x, z) + RIDE_MM;
  }

  solidAtCell(x: number, y: number, z: number): boolean {
    return this.grid.get(x, y, z);
  }

  statsForTest(): Record<string, number> {
    return {
      blocks: this.grid.solid,
      removed: this.removed,
      carrying: this.carrying ? 1 : 0,
      antX: this.antPos.x,
      antY: this.antPos.y,
      antZ: this.antPos.z,
      facingDeg: this.facing / DEG,
      queen: this.queenReady ? 1 : 0,
      firstPerson: this.firstPerson ? 1 : 0,
      targetValid: this.target ? 1 : 0,
      targetReachable: this.targetReachable ? 1 : 0,
      targetX: this.target?.cell[0] ?? -1,
      targetY: this.target?.cell[1] ?? -1,
      targetZ: this.target?.cell[2] ?? -1,
      camX: this.camera.position.x,
      camY: this.camera.position.y,
      camZ: this.camera.position.z,
      chunks: this.chunkMeshes.size,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.queen.dispose();
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
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
}
