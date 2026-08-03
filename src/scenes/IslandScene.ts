/**
 * KAUAI FOR ANTS — `?scene=island`. Beyond Extinction's island, 1:1000.
 *
 * BE ships Kauai as an 8×8 chessboard of real-elevation height tiles, 56 km
 * across, streamed and cross-faded because no phone can hold the full-scale
 * island. At ant scale the arithmetic flips: 56 km becomes 56 m, one real
 * metre becomes one in-world millimetre, and the WHOLE island — all 64
 * sections, baked to one 1025² grid by scripts/bakeKauai.py — fits in a
 * single static mesh. So this room does the opposite of streaming, on
 * purpose: every section is built once and never hidden, faded, clipped or
 * swapped. Nothing loads in front of you, so nothing can hole.
 *
 * Two deliberate choices against seams, the lesson of the last room:
 * vertex NORMALS come from central differences of the height grid, not from
 * computeVertexNormals — identical on both sides of every section border, so
 * no shading lines — and vertex POSITIONS come from global grid indices, so
 * shared edges are bit-identical.
 *
 * No digging yet — this room exists to prove the landscape. The soil-window
 * architecture from `?scene=world` slots under any height function,
 * including this grid, when the island earns it.
 */

import * as THREE from 'three';

import './DensityTerrainLabScene.css';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';

/** Millimetres per world unit, as everywhere in the project. */
const MM = 5;

/** The island: 56 km of Kauai at 1:1000. Real metres ARE in-world mm. */
const SPAN_MM = 56000;

/** The baked grid: 1025² int16 decimetres (see scripts/bakeKauai.py). */
const N = 1025;
const STEP_MM = SPAN_MM / (N - 1);

/** The rendered grid: every second sample — 513², 64 sections of 65². */
const MESH_N = 513;
const SECTIONS = 8;
const SEC_VERTS = (MESH_N - 1) / SECTIONS + 1;

const WALK_SPEED = 8;
const TURN_RATE = 2.4;
const RIDE = 1.3 / MM;

export class IslandScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly queen = new QueenModel('queen');

  private heights: Int16Array | null = null;

  private terrainVerts = 0;

  private terrainTris = 0;

  // Her state — the same simple surface walker the world room proves.
  private readonly at = new THREE.Vector3();

  private facing = Math.PI;

  private readonly velocity = new THREE.Vector3();

  readonly input = { walk: 0, yaw: 0 };

  private camYaw = 0;

  private camPitch = 0.5;

  private camDist = 30 / MM;

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  private readonly stats = { fps: 0, frames: 0, fpsAt: performance.now() };

  private readonly hud: HTMLElement;

  private readonly status: HTMLElement;

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
    this.status = document.createElement('div');
    this.status.className = 'density-lab-status';
    this.status.style.pointerEvents = 'none';
    this.hud.appendChild(this.status);
    this.buildControls();

    void this.load();

    (window as unknown as { islandScene?: unknown }).islandScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.animate();
  }

  private async load(): Promise<void> {
    const url = `${import.meta.env.BASE_URL}kauai-1025.bin`;
    const raw = await (await fetch(url)).arrayBuffer();
    this.heights = new Int16Array(raw);
    this.buildIsland();

    // The middle of the island: the Waiʻaleʻale plateau, ~1,300 m up.
    this.at.set(SPAN_MM / 2 / MM, 0, SPAN_MM / 2 / MM);
    this.at.y = this.groundHeightAt(this.at.x, this.at.z) + RIDE;

    const ok = await this.queen.load();
    this.queen.root.visible = ok;
    this.ready = ok;
  }

  /* ------------------------------------------------------------ the land */

  /** Height in mm (= real metres) at a data-grid index, clamped to edges. */
  private sample(col: number, row: number): number {
    const c = Math.min(N - 1, Math.max(0, col));
    const r = Math.min(N - 1, Math.max(0, row));
    return this.heights![r * N + c]! / 10;
  }

  /** Bilinear ground height in WORLD units at a world-unit position. */
  groundHeightAt(x: number, z: number): number {
    if (!this.heights) return 0;
    const gx = Math.min(N - 1.001, Math.max(0, (x * MM) / STEP_MM));
    const gz = Math.min(N - 1.001, Math.max(0, (z * MM) / STEP_MM));
    const c = Math.floor(gx);
    const r = Math.floor(gz);
    const fx = gx - c;
    const fz = gz - r;
    const h = this.sample(c, r) * (1 - fx) * (1 - fz)
      + this.sample(c + 1, r) * fx * (1 - fz)
      + this.sample(c, r + 1) * (1 - fx) * fz
      + this.sample(c + 1, r + 1) * fx * fz;
    return h / MM;
  }

  /** Where the ant may stand: the land, or wading depth at the shore. */
  private walkGroundAt(x: number, z: number): number {
    return Math.max(this.groundHeightAt(x, z), 0.5 / MM);
  }

  /**
   * All sixty-four sections, built once, never touched again. Colours are a
   * biome ramp by elevation and slope in the spirit of BE's texture blend:
   * reef and deep water, sand, lowland green into jungle, canyon rock on the
   * steeps, bare summit above the cloud line.
   */
  private buildIsland(): void {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const colour = new THREE.Color();
    const rock = new THREE.Color(0x8a6247);
    const pick = (hM: number, slope: number): THREE.Color => {
      if (hM < 0) {
        const t = Math.min(1, Math.max(0, 1 + hM / 80));
        return colour.setHex(0x0d2f47).lerp(new THREE.Color(0x3d8f7a), t);
      }
      if (hM < 4) return colour.setHex(0xd8c08a);
      if (hM < 500) {
        const t = (hM - 4) / 496;
        colour.setHex(0x86a659).lerp(new THREE.Color(0x3f6d33), t);
      } else if (hM < 1100) {
        const t = (hM - 500) / 600;
        colour.setHex(0x3f6d33).lerp(new THREE.Color(0x6b7a55), t);
      } else {
        colour.setHex(0x8f8578);
      }
      // Kauai's slopes are its face: canyon and pali walls turn to rock.
      const s = Math.min(1, Math.max(0, (slope - 0.35) / 0.5));
      return colour.lerp(rock, s);
    };

    for (let sz = 0; sz < SECTIONS; sz += 1) {
      for (let sx = 0; sx < SECTIONS; sx += 1) {
        this.scene.add(this.buildSection(sx, sz, material, pick));
      }
    }
  }

  private buildSection(
    sx: number, sz: number,
    material: THREE.Material,
    pick: (hM: number, slope: number) => THREE.Color,
  ): THREE.Mesh {
    const positions = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
    const normals = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
    const colors = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
    const stride = (N - 1) / (MESH_N - 1); // data samples per mesh step
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
        const c = pick(h, Math.hypot(dx, dz));
        colors[at] = c.r;
        colors[at + 1] = c.g;
        colors[at + 2] = c.b;
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
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(index);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    this.terrainVerts += SEC_VERTS * SEC_VERTS;
    this.terrainTris += (SEC_VERTS - 1) * (SEC_VERTS - 1) * 2;
    return mesh;
  }

  /* ------------------------------------------------------------ the walk */

  private simulate(dt: number): void {
    if (!this.heights) return;
    this.facing -= this.input.yaw * TURN_RATE * dt;
    const speed = this.input.walk * WALK_SPEED;
    this.velocity.set(Math.sin(this.facing) * speed, 0, Math.cos(this.facing) * speed);
    const span = SPAN_MM / MM;
    this.at.x = Math.min(span - 2, Math.max(2, this.at.x + this.velocity.x * dt));
    this.at.z = Math.min(span - 2, Math.max(2, this.at.z + this.velocity.z * dt));
    const want = this.walkGroundAt(this.at.x, this.at.z) + RIDE;
    this.at.y += (want - this.at.y) * Math.min(1, dt * 14);
    this.pose(dt);
    this.aimCamera(dt);
  }

  private pose(dt: number): void {
    if (!this.ready) return;
    const probe = 2 / MM;
    const hx = (this.walkGroundAt(this.at.x + probe, this.at.z)
      - this.walkGroundAt(this.at.x - probe, this.at.z)) / (probe * 2);
    const hz = (this.walkGroundAt(this.at.x, this.at.z + probe)
      - this.walkGroundAt(this.at.x, this.at.z - probe)) / (probe * 2);
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
      digging: 0,
      carrying: 0,
      headYaw: 0,
    });
    this.queen.solveFeet(
      (x, z) => this.walkGroundAt(x, z),
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
    const eyeGround = this.walkGroundAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < eyeGround + 0.6) this.camera.position.y = eyeGround + 0.6;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.at.x, this.at.y + 0.4, this.at.z);
  }

  /* ---------------------------------------------------------------- HUD */

  private buildControls(): void {
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
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const elevM = this.heights
      ? (this.groundHeightAt(this.at.x, this.at.z) * MM).toFixed(0)
      : '…';
    this.status.innerHTML = `
      <b>kauai island</b> · 56 m square · 1:1000 · all 64 sections resident<br>
      terrain ${this.terrainVerts.toLocaleString()} v / ${this.terrainTris.toLocaleString()} t
      · elevation ${elevM} m<br>
      at (${(this.at.x * MM / 1000).toFixed(1)}, ${(this.at.z * MM / 1000).toFixed(1)}) m ·
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

  setFacingForTest(radians: number): void { this.facing = radians; }

  teleportMm(xMm: number, zMm: number): void {
    this.at.x = xMm / MM;
    this.at.z = zMm / MM;
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;
    this.velocity.set(0, 0, 0);
  }

  /** Elevation in real metres at a position in island millimetres. */
  heightAtMm(xMm: number, zMm: number): number {
    return this.groundHeightAt(xMm / MM, zMm / MM) * MM;
  }

  statsForTest(): Record<string, number> {
    return {
      verts: this.terrainVerts,
      tris: this.terrainTris,
      loaded: this.heights ? 1 : 0,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.queen.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
