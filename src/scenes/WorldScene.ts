/**
 * THE HYBRID WORLD PROTOTYPE — `?scene=world`. See docs/HYBRID_WORLD_PLAN.md.
 *
 * A 4 m landscape drawn as a cheap smooth macro sheet, with a 192 mm window
 * of fine diggable soil streaming under the ant. The window's density mesh is
 * the only surface inside its own footprint (the macro sheet discards there),
 * so digging through the surface needs no hole system — the nest's entrance
 * vent and any bite simply show, because nothing is drawn over them.
 *
 * This room exists to answer the architecture questions, not to be the game:
 * the walker is deliberately a SURFACE walker (no wall climb, no rails), the
 * camera is a plain boom, and everything interesting is instrumented. The
 * block room and the lab keep the real locomotion.
 */

import * as THREE from 'three';

import './DensityTerrainLabScene.css';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';
import { buildNestView, type NestView } from '../nest/nestView';
import { WorldStream, type ScrollReport } from '../world/WorldStream';
import { MacroSurface } from '../world/MacroSurface';
import {
  CELLS_Y, CELL_SIZE, MM, SAMPLES_Y, TILE_CELLS, WINDOW_CELLS, WINDOW_MM,
  WORLD_SPAN, WINDOW_BYTES, groundHeightAt, planForWorld,
} from '../world/worldScape';

/** Mesh-chunk edge, in cells — equal to the slide tile ON PURPOSE: a scroll
 *  then moves whole chunks, so retained soil keeps its mesh untouched. */
const CH = TILE_CELLS;
const CHUNKS_XZ = WINDOW_CELLS / CH;
const CHUNKS_Y = CELLS_Y / CH;

/** How many chunk meshes may rebuild per frame. The pacing knob. */
const MESH_BUDGET = 3;

/** Walking pace, world units/s (40 mm/s — a fire ant in a hurry). */
const WALK_SPEED = 8;
const TURN_RATE = 2.4;

/** Body ride height above the soil, world units. */
const RIDE = 1.3 / MM;

/** Recentre lead: how far ahead of her the window is asked to be. */
const LEAD_S = 0.45;
const LEAD_MAX = 24 / MM;

/** Fewest milliseconds between scrolls, so a wiggle cannot thrash. */
const SCROLL_COOLDOWN_MS = 150;

const BITE_RADIUS = 1.9 / MM;
const BITE_EVERY_S = 0.16;

export class WorldScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly stream: WorldStream;

  private readonly macro: MacroSurface;

  private readonly queen = new QueenModel('queen');

  private nestView: NestView | null = null;

  private readonly chunkMeshes = new Map<string, THREE.Mesh>();

  private readonly queue: { cx: number; cy: number; cz: number }[] = [];

  private readonly queued = new Set<string>();

  private readonly soilMaterial = new THREE.MeshLambertMaterial({
    color: 0x7a5c3d, side: THREE.FrontSide,
  });

  // Her state — a surface walker's worth and no more.
  private readonly at = new THREE.Vector3();

  private facing = 0;

  private readonly velocity = new THREE.Vector3();

  readonly input = { walk: 0, yaw: 0, dig: false };

  private camYaw = 0;

  private camPitch = 0.5;

  private camDist = 26 / MM;

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  private lastScrollAt = 0;

  private biteAt = 0;

  /** A scroll shrank the macro discard to the retained soil; grow it back
   *  to the full window once every queued chunk has meshed. */
  private clipPending = false;

  // Diagnostics, exactly the ones the request asks for.
  private readonly stats = {
    scrolls: 0,
    lastScrollMs: 0,
    lastMeshMs: 0,
    initialMeshMs: 0,
    meshedChunks: 0,
    triangles: 0,
    vertices: 0,
    fps: 0,
    frames: 0,
    fpsAt: performance.now(),
  };

  private readonly hud: HTMLElement;

  private readonly status: HTMLElement;

  private debugBoxes = true;

  private readonly windowBox: THREE.LineSegments;

  private readonly tileGrid: THREE.LineSegments;

  private stickPointer: number | null = null;

  private lookPointer: number | null = null;

  private readonly stickOrigin = { x: 0, y: 0 };

  private readonly stickEl = document.createElement('div');

  private readonly stickKnob = document.createElement('div');

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9cbedd);
    /*
     * The fog is DUST, not sky, and the distinction was learned the hard way:
     * with fog dyed the sky's exact blue, far ridges faded to sky colour and
     * read as slivers of sky showing THROUGH the terrain — reported as holes,
     * and chased as holes, when a red-background probe showed the silhouette
     * was airtight all along. Hazing the distance toward a pale dust tone
     * keeps far hills reading as land under atmosphere.
     */
    this.scene.fog = new THREE.Fog(0xbcb29c, WINDOW_MM / MM * 1.2, WORLD_SPAN * 0.7);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, WORLD_SPAN * 2);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
    sun.position.set(300, 500, 200);
    this.scene.add(sun, new THREE.AmbientLight(0xbfd4e8, 0.75));

    // The landscape sheet, then the streamed soil under the spawn.
    this.macro = new MacroSurface();
    this.scene.add(this.macro.root);

    const spawn = planForWorld().nodes[0]!;
    this.at.set(
      spawn.x / MM, 0, (spawn.z - spawn.radiusMm * 3.2 - 8) / MM,
    );
    this.at.y = groundHeightAt(this.at.x, this.at.z) + RIDE;

    this.stream = new WorldStream(this.at.x, this.at.z);
    const t0 = performance.now();
    this.remeshEverything();
    this.stats.initialMeshMs = performance.now() - t0;
    this.macroClip();

    // The plan drawn through the soil — the sonar look, for orientation.
    this.nestView = buildNestView(planForWorld());
    this.nestView.root.scale.setScalar(1 / MM);
    this.scene.add(this.nestView.root);

    this.windowBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffe082 }),
    );
    this.scene.add(this.windowBox);
    this.tileGrid = this.buildTileGrid();
    this.scene.add(this.tileGrid);

    this.scene.add(this.queen.root);
    void this.queen.load().then((ok) => {
      this.ready = ok;
      this.queen.root.visible = ok;
    });

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.status = document.createElement('div');
    this.status.className = 'density-lab-status';
    this.status.style.pointerEvents = 'none';
    this.hud.appendChild(this.status);
    this.buildControls();

    (window as unknown as { worldScene?: unknown }).worldScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.animate();
  }

  /* ------------------------------------------------------------- meshing */

  private key(cx: number, cy: number, cz: number): string { return `${cx},${cy},${cz}`; }

  private remeshEverything(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.queue.length = 0;
    this.queued.clear();
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) this.meshChunk(cx, cy, cz);
      }
    }
  }

  private meshChunk(cx: number, cy: number, cz: number): void {
    const started = performance.now();
    const key = this.key(cx, cy, cz);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    const data = buildSurfaceNets(this.stream.field, 0, {
      x0: cx * CH, y0: cy * CH, z0: cz * CH,
      x1: Math.min(WINDOW_CELLS, (cx + 1) * CH),
      y1: Math.min(CELLS_Y, (cy + 1) * CH),
      z1: Math.min(WINDOW_CELLS, (cz + 1) * CH),
    });
    this.stats.lastMeshMs = performance.now() - started;
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.soilMaterial);
    /*
     * World position is fixed at BUILD time. After a scroll the retained
     * soil's local indices change but its world position does not, and the
     * rekeying below relies on exactly that: a kept chunk's mesh needs no
     * touch at all, which is what makes a scroll pop-free.
     */
    mesh.position.set(this.stream.originWorldX, 0, this.stream.originWorldZ);
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

  /**
   * A scroll moved the window by whole chunks (the tile IS the chunk).
   * Retained chunks keep their meshes under new keys; everything else is
   * disposed and queued, nearest the ant first.
   */
  private onScroll(scroll: ScrollReport): void {
    this.stats.scrolls += 1;
    this.stats.lastScrollMs = scroll.ms;
    const moved = new Map<string, THREE.Mesh>();
    const keep = scroll.retained;
    for (const [key, mesh] of this.chunkMeshes) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      const nx = cx - scroll.tilesX;
      const nz = cz - scroll.tilesZ;
      const inside = nx >= 0 && nx < CHUNKS_XZ && nz >= 0 && nz < CHUNKS_XZ
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
    this.queue.length = 0;
    this.queued.clear();
    const jobs: { cx: number; cy: number; cz: number; d: number }[] = [];
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) {
          if (this.chunkMeshes.has(this.key(cx, cy, cz))) continue;
          const wx = this.stream.originWorldX + (cx + 0.5) * CH * CELL_SIZE;
          const wz = this.stream.originWorldZ + (cz + 0.5) * CH * CELL_SIZE;
          jobs.push({ cx, cy, cz, d: Math.hypot(wx - this.at.x, wz - this.at.z) });
        }
      }
    }
    jobs.sort((a, b) => a.d - b.d);
    for (const job of jobs) this.enqueue(job.cx, job.cy, job.cz);
    /*
     * THE CLIP MUST NEVER OUTRUN THE MESHES. Discarding the macro sheet over
     * the whole new window while the strip's chunks are still queued opens a
     * window-sized hole to the sky — briefly at 60 fps, glaringly in a
     * software-rendered screenshot. So the discard rectangle shrinks to the
     * retained chunks (rounded inward to whole chunk meshes) and only grows
     * to the full window when the queue drains, in reveal(). Until then the
     * macro sheet covers the regenerating strip, and since both layers
     * sample the same ground the reveal is a material change, not a pop.
     */
    const cx0 = Math.ceil(keep.x0 / CH) * CH;
    const cx1 = Math.floor(keep.x1 / CH) * CH;
    const cz0 = Math.ceil(keep.z0 / CH) * CH;
    const cz1 = Math.floor(keep.z1 / CH) * CH;
    const inset = CELL_SIZE * 2;
    if (cx1 - cx0 > 0 && cz1 - cz0 > 0) {
      this.macro.setWindow(
        this.stream.originWorldX + cx0 * CELL_SIZE + inset,
        this.stream.originWorldZ + cz0 * CELL_SIZE + inset,
        this.stream.originWorldX + cx1 * CELL_SIZE - inset,
        this.stream.originWorldZ + cz1 * CELL_SIZE - inset,
      );
    } else {
      this.macro.setWindow(0, 0, 0, 0);
    }
    this.clipPending = true;
    if (this.nestView) {
      // The sonar overlay is world-anchored; nothing to move. This hook is
      // where per-chunk culling of it would go if the plan grew huge.
    }
  }

  /** Hand the full window over to the fine mesh — only once it all exists. */
  private reveal(): void {
    if (!this.clipPending || this.queue.length > 0) return;
    this.clipPending = false;
    this.macroClip();
  }

  private macroClip(): void {
    const inset = CELL_SIZE * 2;
    this.macro.setWindow(
      this.stream.originWorldX + inset,
      this.stream.originWorldZ + inset,
      this.stream.originWorldX + WINDOW_CELLS * CELL_SIZE - inset,
      this.stream.originWorldZ + WINDOW_CELLS * CELL_SIZE - inset,
    );
  }

  private buildTileGrid(): THREE.LineSegments {
    const points: number[] = [];
    const step = (256 / MM);
    const top = 220 / MM;
    for (let i = 0; i <= WORLD_SPAN / step; i += 1) {
      points.push(i * step, top, 0, i * step, top, WORLD_SPAN);
      points.push(0, top, i * step, WORLD_SPAN, top, i * step);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x4477aa, transparent: true, opacity: 0.35 }),
    );
  }

  /* ------------------------------------------------------------ the walk */

  private simulate(dt: number): void {
    this.facing -= this.input.yaw * TURN_RATE * dt;
    const speed = this.input.walk * WALK_SPEED;
    this.velocity.set(Math.sin(this.facing) * speed, 0, Math.cos(this.facing) * speed);
    this.at.x = Math.min(WORLD_SPAN - 2, Math.max(2, this.at.x + this.velocity.x * dt));
    this.at.z = Math.min(WORLD_SPAN - 2, Math.max(2, this.at.z + this.velocity.z * dt));

    /*
     * Underfoot is the FIELD wherever it is loaded, so a dug-open entrance is
     * a real drop; the analytic ground is only the out-of-window fallback the
     * camera needs. Eased, because soil edited under her feet would otherwise
     * teleport her a cell per bite.
     */
    const ground = this.stream.surfaceHeightAt(this.at.x, this.at.z)
      ?? groundHeightAt(this.at.x, this.at.z);
    const want = ground + RIDE;
    this.at.y += (want - this.at.y) * Math.min(1, dt * 14);

    if (this.input.dig) this.bite(dt);

    // Directional prefetch: recentre on where she is HEADED, not where she
    // is, with a cooldown so hovering on a line cannot thrash the window.
    const lead = Math.min(LEAD_MAX, speed * LEAD_S);
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

    let built = 0;
    while (built < MESH_BUDGET && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queued.delete(this.key(job.cx, job.cy, job.cz));
      this.meshChunk(job.cx, job.cy, job.cz);
      built += 1;
    }
    this.reveal();

    this.pose(dt);
    this.aimCamera(dt);
  }

  private bite(dt: number): void {
    this.biteAt += dt;
    if (this.biteAt < BITE_EVERY_S) return;
    this.biteAt = 0;
    const mouth = this.at.clone()
      .addScaledVector(new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing)), 1.4 / MM);
    mouth.y = this.at.y - RIDE * 0.4;
    const result = this.stream.subtractSphere(mouth, BITE_RADIUS);
    if (result.changedSamples === 0) return;
    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
    const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
    for (let cz = lo(result.bounds.minZ); cz <= hi(result.bounds.maxZ, CHUNKS_XZ); cz += 1) {
      for (let cy = lo(result.bounds.minY); cy <= hi(result.bounds.maxY, CHUNKS_Y); cy += 1) {
        for (let cx = lo(result.bounds.minX); cx <= hi(result.bounds.maxX, CHUNKS_XZ); cx += 1) {
          this.enqueue(cx, cy, cz);
        }
      }
    }
  }

  private pose(dt: number): void {
    if (!this.ready) return;
    const probe = 2 / MM;
    const hx = (groundHeightAt(this.at.x + probe, this.at.z)
      - groundHeightAt(this.at.x - probe, this.at.z)) / (probe * 2);
    const hz = (groundHeightAt(this.at.x, this.at.z + probe)
      - groundHeightAt(this.at.x, this.at.z - probe)) / (probe * 2);
    const up = new THREE.Vector3(-hx, 1, -hz).normalize();
    const forward = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    forward.addScaledVector(up, -forward.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(up, forward).normalize();
    this.queen.root.position.copy(this.at);
    this.queen.root.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, forward),
    );
    this.queen.update(dt, {
      speed: Math.hypot(this.velocity.x, this.velocity.z),
      turn: -this.input.yaw * TURN_RATE,
      digging: this.input.dig ? 1 : 0,
      carrying: 0,
      headYaw: 0,
    });
    this.queen.solveFeet(
      (x, z) => (this.stream.surfaceHeightAt(x, z) ?? groundHeightAt(x, z)),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
    );
  }

  private aimCamera(dt: number): void {
    const wantYaw = this.facing + Math.PI;
    let d = wantYaw - this.camYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (this.lookPointer === null) this.camYaw += d * Math.min(1, dt * 2.4);
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.at.x + Math.sin(this.camYaw) * this.camDist * cp,
      this.at.y + Math.sin(this.camPitch) * this.camDist,
      this.at.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    const eyeGround = groundHeightAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < eyeGround + 0.6) this.camera.position.y = eyeGround + 0.6;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.at.x, this.at.y + 0.4, this.at.z);
  }

  /* ---------------------------------------------------------------- HUD */

  private buildControls(): void {
    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    this.hud.appendChild(actions);

    const dig = document.createElement('button');
    dig.className = 'density-lab-button density-lab-dig';
    dig.textContent = 'DIG';
    dig.addEventListener('pointerdown', (e) => { e.preventDefault(); this.input.dig = true; });
    const stop = () => { this.input.dig = false; };
    dig.addEventListener('pointerup', stop);
    dig.addEventListener('pointercancel', stop);
    actions.appendChild(dig);

    const boxes = document.createElement('button');
    boxes.className = 'density-lab-button density-lab-mode';
    boxes.textContent = 'BOXES';
    boxes.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.debugBoxes = !this.debugBoxes;
    });
    actions.appendChild(boxes);

    this.stickEl.className = 'nest-stick';
    this.stickEl.style.display = 'none';
    this.stickKnob.className = 'nest-stick-knob';
    this.stickEl.appendChild(this.stickKnob);
    this.hud.appendChild(this.stickEl);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
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
      if (e.pointerId === this.stickPointer) {
        const dx = Math.max(-48, Math.min(48, e.clientX - this.stickOrigin.x));
        const dy = Math.max(-48, Math.min(48, e.clientY - this.stickOrigin.y));
        this.input.yaw = Math.abs(dx / 48) < 0.12 ? 0 : dx / 48;
        this.input.walk = Math.abs(dy / 48) < 0.12 ? 0 : -dy / 48;
        this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      } else if (e.pointerId === this.lookPointer) {
        this.camYaw -= e.movementX * 0.005;
        this.camPitch = Math.min(1.35, Math.max(0.06, this.camPitch + e.movementY * 0.004));
      }
    });
    const release = (e: PointerEvent) => {
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
    let triangles = 0;
    let vertices = 0;
    for (const mesh of this.chunkMeshes.values()) {
      triangles += (mesh.geometry.getIndex()?.count ?? 0) / 3;
      vertices += mesh.geometry.getAttribute('position').count;
    }
    this.stats.triangles = triangles;
    this.stats.vertices = vertices;
    this.stats.meshedChunks = this.chunkMeshes.size;
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.status.innerHTML = `
      <b>hybrid world</b> · ${WORLD_SPAN * MM / 1000} m² · window ${WINDOW_MM} mm · 1 mm cells<br>
      surface tiles ${this.macro.tileCount} (${this.macro.vertexCount.toLocaleString()} v) ·
      soil chunks ${this.stats.meshedChunks}/${CHUNKS_XZ * CHUNKS_XZ * CHUNKS_Y} · queued ${this.queue.length}<br>
      window samples ${((WINDOW_CELLS + 1) ** 2 * SAMPLES_Y / 1e6).toFixed(1)} M
      (${(WINDOW_BYTES / 1048576).toFixed(1)} MB) · dug ${this.stream.editedSamples}<br>
      soil ${this.stats.vertices.toLocaleString()} v / ${Math.round(this.stats.triangles).toLocaleString()} t<br>
      scrolls ${this.stats.scrolls} · last ${this.stats.lastScrollMs.toFixed(0)} ms ·
      mesh ${this.stats.lastMeshMs.toFixed(1)} ms · first build ${this.stats.initialMeshMs.toFixed(0)} ms<br>
      ${memory ? `heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB · ` : ''}fps ${this.stats.fps}
    `;
  }

  /* --------------------------------------------------------------- loop */

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);

    this.stats.frames += 1;
    if (now - this.stats.fpsAt > 1000) {
      this.stats.fps = Math.round(this.stats.frames * 1000 / (now - this.stats.fpsAt));
      this.stats.frames = 0;
      this.stats.fpsAt = now;
      this.updateStatus();
    }

    this.windowBox.visible = this.debugBoxes;
    this.tileGrid.visible = this.debugBoxes;
    if (this.nestView) this.nestView.root.visible = this.debugBoxes;
    if (this.debugBoxes) {
      const w = WINDOW_CELLS * CELL_SIZE;
      this.windowBox.scale.set(w, CELLS_Y * CELL_SIZE, w);
      this.windowBox.position.set(
        this.stream.originWorldX + w / 2,
        CELLS_Y * CELL_SIZE / 2,
        this.stream.originWorldZ + w / 2,
      );
    }

    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  /** Is there soil at this world position, in millimetres? Off the LIVE field. */
  solidAtMm(xMm: number, yMm: number, zMm: number): boolean | null {
    const x = Math.round((xMm / MM - this.stream.originWorldX) / CELL_SIZE);
    const z = Math.round((zMm / MM - this.stream.originWorldZ) / CELL_SIZE);
    const y = Math.round(yMm / MM / CELL_SIZE);
    if (x < 0 || x > WINDOW_CELLS || z < 0 || z > WINDOW_CELLS
      || y < 0 || y >= SAMPLES_Y) return null;
    return this.stream.field.get(x, y, z) > 0;
  }

  teleportMm(xMm: number, zMm: number): void {
    this.at.x = xMm / MM;
    this.at.z = zMm / MM;
    this.at.y = groundHeightAt(this.at.x, this.at.z) + RIDE;
    this.velocity.set(0, 0, 0);
    const scroll = this.stream.recentreOn(this.at.x, this.at.z);
    if (scroll) this.onScroll(scroll);
  }

  originMm(): { x: number; z: number } {
    return { x: this.stream.originWorldX * MM, z: this.stream.originWorldZ * MM };
  }

  statsForTest(): Record<string, number> {
    return {
      scrolls: this.stats.scrolls,
      lastScrollMs: this.stats.lastScrollMs,
      initialMeshMs: this.stats.initialMeshMs,
      meshed: this.chunkMeshes.size,
      queued: this.queue.length,
      edited: this.stream.editedSamples,
    };
  }

  drainQueueForTest(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queued.delete(this.key(job.cx, job.cy, job.cz));
      this.meshChunk(job.cx, job.cy, job.cz);
    }
    this.reveal();
  }

  setFacingForTest(radians: number): void { this.facing = radians; }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.soilMaterial.dispose();
    this.macro.dispose();
    this.nestView?.dispose();
    this.queen.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
