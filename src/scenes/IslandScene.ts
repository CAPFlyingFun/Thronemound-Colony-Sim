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
import { buildNestView, type NestView } from '../nest/nestView';
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

const BITE_RADIUS = 1.9 / MM;
const BITE_EVERY_S = 0.16;

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

  private terrainVerts = 0;

  private terrainTris = 0;

  private readonly at = new THREE.Vector3();

  private facing = Math.PI;

  private readonly velocity = new THREE.Vector3();

  readonly input = { walk: 0, yaw: 0, dig: false, sprint: false };

  private readonly keysDown = new Set<string>();

  private spaceWasDown = false;

  private camYaw = 0;

  private camPitch = 0.5;

  private camDist = 30 / MM;

  private firstPerson = false;

  private fpPitch = 0;

  private underground = false;

  /** Her recent path — the underground chase camera follows THIS, because
   *  the path she walked is guaranteed to be inside the tunnel. */
  private readonly trail: THREE.Vector3[] = [];

  /** The last position whose centre provably sampled AIR — the anchor the
   *  anti-embed safety net snaps back to. */
  private readonly lastSafe = new THREE.Vector3();

  private hasSafe = false;

  private embedFrames = 0;

  private queenReady = false;

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

  private readonly status: HTMLElement;

  private stickPointer: number | null = null;

  private lookPointer: number | null = null;

  private readonly stickOrigin = { x: 0, y: 0 };

  private readonly stickEl = document.createElement('div');

  private readonly stickKnob = document.createElement('div');

  private readonly crosshair = document.createElement('div');

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
    const [raw, textures] = await Promise.all([
      (await fetch(url)).arrayBuffer(),
      loadBiomeTextures(import.meta.env.BASE_URL),
    ]);
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

    /* The WORLD is ready here; the queen's model arrives when it arrives.
     * Gating `ready` on her GLB made every probe hostage to one slow fetch. */
    this.ready = true;
    void this.queen.load().then((ok) => {
      this.queen.root.visible = ok;
      this.queenReady = ok;
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
    const stream = this.stream;
    if (!stream) return null;
    const fine = stream.surfaceBelowY(x, z, fromY);
    if (fine === null) return null;
    const ceiling = stream.bandFloorWu + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
    if (fine >= ceiling - CELL_SIZE) return Math.max(fine, this.walkGroundAt(x, z));
    return fine;
  }

  /** Underfoot at HER height: tunnel floors are real, roofs above are not. */
  private footingAt(x: number, z: number): number {
    return this.floorBelow(x, z, this.at.y + 0.4) ?? this.walkGroundAt(x, z);
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
    this.queue.length = 0;
    this.queued.clear();
    const jobs: { cx: number; cy: number; cz: number; d: number }[] = [];
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) {
          if (this.chunkMeshes.has(this.key(cx, cy, cz))) continue;
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
    const cx0 = Math.ceil(keep.x0 / CH) * CH;
    const cx1 = Math.floor(keep.x1 / CH) * CH;
    const cz0 = Math.ceil(keep.z0 / CH) * CH;
    const cz1 = Math.floor(keep.z1 / CH) * CH;
    const inset = CELL_SIZE * 2;
    if (cx1 - cx0 > 0 && cz1 - cz0 > 0) {
      this.clip.value.set(
        this.stream!.originWorldX + cx0 * CELL_SIZE + inset,
        this.stream!.originWorldZ + cz0 * CELL_SIZE + inset,
        this.stream!.originWorldX + cx1 * CELL_SIZE - inset,
        this.stream!.originWorldZ + cz1 * CELL_SIZE - inset,
      );
    } else {
      this.clip.value.set(0, 0, 0, 0);
    }
    this.clipPending = true;
  }

  private reveal(): void {
    if (!this.clipPending || this.queue.length > 0) return;
    this.clipPending = false;
    this.clipToWindow();
  }

  private clipToWindow(): void {
    const inset = CELL_SIZE * 2;
    this.clip.value.set(
      this.stream!.originWorldX + inset,
      this.stream!.originWorldZ + inset,
      this.stream!.originWorldX + WINDOW_CELLS * CELL_SIZE - inset,
      this.stream!.originWorldZ + WINDOW_CELLS * CELL_SIZE - inset,
    );
  }

  /* ------------------------------------------------------------ the walk */

  private simulate(dt: number): void {
    if (!this.heights) return;
    this.facing -= this.input.yaw * TURN_RATE * dt;
    const speed = this.input.walk * WALK_SPEED * (this.input.sprint ? SPRINT : 1);
    this.velocity.set(Math.sin(this.facing) * speed, 0, Math.cos(this.facing) * speed);
    const span = SPAN_MM / MM;
    const nx = Math.min(span - 2, Math.max(2, this.at.x + this.velocity.x * dt));
    const nz = Math.min(span - 2, Math.max(2, this.at.z + this.velocity.z * dt));

    /*
     * Walls are walls, holes are holes. The floor at the DESTINATION is
     * looked up from her own height downward: a tunnel floor is a real
     * floor, the roof above it is invisible to her, and a floor more than
     * one stride ABOVE her is a wall — the move is refused instead of
     * easing her up through the ceiling ("it bounced me back up"). Refused
     * with the stick still held means she is pressing against the wall, and
     * she climbs it slowly — enough to get out of the shaft or a dug pit.
     */
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

    this.underground = this.at.y + RIDE
      < this.walkGroundAt(this.at.x, this.at.z) - UNDER_MM / MM;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(this.at) > 0.3) {
      this.trail.push(this.at.clone());
      if (this.trail.length > 240) this.trail.shift();
    }

    if (this.stream) {
      if (this.input.dig) this.bite(dt);

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

      let built = 0;
      while (built < MESH_BUDGET && this.queue.length > 0) {
        const job = this.queue.shift()!;
        this.queued.delete(this.key(job.cx, job.cy, job.cz));
        this.meshChunk(job.cx, job.cy, job.cz);
        built += 1;
      }
      this.reveal();
    }

    this.pose(dt);
    this.aimCamera(dt);
  }

  private bite(dt: number): void {
    this.biteAt += dt;
    if (this.biteAt < BITE_EVERY_S) return;
    this.biteAt = 0;
    const mouth = this.at.clone().addScaledVector(
      new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing)), 1.4 / MM,
    );
    mouth.y = this.at.y - RIDE * 0.4;
    const result = this.stream!.subtractSphere(mouth, BITE_RADIUS);
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
    if (!this.queenReady) return;
    const probe = 2 / MM;
    const hx = (this.footingAt(this.at.x + probe, this.at.z)
      - this.footingAt(this.at.x - probe, this.at.z)) / (probe * 2);
    const hz = (this.footingAt(this.at.x, this.at.z + probe)
      - this.footingAt(this.at.x, this.at.z - probe)) / (probe * 2);
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
      (x, z) => this.footingAt(x, z),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
    );
  }

  private aimCamera(dt: number): void {
    /* In her eyes her own body would fill the frame — hidden there, shown
     * everywhere else (and only once her model has actually loaded). */
    this.queen.root.visible = this.queenReady && !this.firstPerson;
    this.crosshair.style.display = this.firstPerson ? '' : 'none';
    if (this.firstPerson) {
      /* Her own eyes: at the head, looking where she faces; the mouse (or
       * right-half drag) turns HER, and pitch is a look, not an orbit. */
      const fwd = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      const eye = this.at.clone().addScaledVector(fwd, 0.26);
      eye.y += 0.3;
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(
        eye.x + fwd.x * Math.cos(this.fpPitch),
        eye.y + Math.sin(this.fpPitch),
        eye.z + fwd.z * Math.cos(this.fpPitch),
      );
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
      if (this.lookPointer !== null) {
        const cp = Math.cos(this.camPitch);
        const dist = 1.2;
        this.camera.position.lerp(new THREE.Vector3(
          this.at.x + Math.sin(this.camYaw) * dist * cp,
          this.at.y + Math.sin(this.camPitch) * dist,
          this.at.z + Math.cos(this.camYaw) * dist * cp,
        ), Math.min(1, dt * 10));
      } else {
        const behind = this.trailPointBehind(1.0);
        behind.y += 0.32;
        this.camera.position.lerp(behind, Math.min(1, dt * 8));
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

    const dig = document.createElement('button');
    dig.className = 'density-lab-button density-lab-dig';
    dig.textContent = 'DIG';
    dig.addEventListener('pointerdown', (e) => { e.preventDefault(); this.input.dig = true; });
    const stop = () => { this.input.dig = false; };
    dig.addEventListener('pointerup', stop);
    dig.addEventListener('pointercancel', stop);
    actions.appendChild(dig);

    const plan = document.createElement('button');
    plan.className = 'density-lab-button density-lab-mode';
    plan.textContent = 'PLAN';
    plan.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.showPlan = !this.showPlan;
      if (this.nestView) this.nestView.root.visible = this.showPlan;
    });
    actions.appendChild(plan);

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
     * W/S walk, A/D turn, Shift sprint, Space digs, V swaps the view.
     * Arrows mirror WASD. Keys and stick write the same inputs.
     */
    const applyKeys = () => {
      const k = this.keysDown;
      const forward = (k.has('w') || k.has('arrowup') ? 1 : 0)
        - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const turn = (k.has('d') || k.has('arrowright') ? 1 : 0)
        - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      if (this.stickPointer === null) {
        this.input.walk = forward;
        this.input.yaw = turn;
      }
      this.input.sprint = k.has('shift');
      const space = k.has(' ');
      if (space !== this.spaceWasDown) {
        this.input.dig = space;
        this.spaceWasDown = space;
      }
    };
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
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
        if (this.firstPerson) {
          // In her eyes the drag turns HER; pitch is a glance up or down.
          this.facing -= e.movementX * 0.004;
          this.fpPitch = Math.min(1.1, Math.max(-1.1, this.fpPitch - e.movementY * 0.004));
        } else {
          // Third person: the drag pans the view — above ground a full
          // orbit, underground a tight override the trail cam resumes from
          // the moment the finger lifts.
          this.camYaw -= e.movementX * 0.005;
          this.camPitch = Math.min(1.35, Math.max(0.06, this.camPitch + e.movementY * 0.004));
        }
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
      soil window ${WINDOW_MM} mm · ${(WINDOW_BYTES / 1048576).toFixed(1)} MB ·
      chunks ${this.chunkMeshes.size} · queued ${this.queue.length} ·
      dug ${this.stream?.editedSamples ?? 0}<br>
      band floor ${this.stream?.bandFloorMm ?? 0} m · scrolls ${this.stats.scrolls}
      (${this.stats.rebases} rebases) · last ${this.stats.lastScrollMs.toFixed(0)} ms<br>
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
    this.trail.length = 0;
    this.underground = false;
    this.hasSafe = false;
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
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
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
