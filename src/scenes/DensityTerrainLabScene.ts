import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { TerrainStream } from '../density/TerrainStream';
import {
  BITE_DEPTH, BITE_DEPTH_MM, BITE_WIDTH_MM, BRUSH_RADIUS, CELLS_Y,
  CELL_SIZE, CHUNK_CELLS, PELLET_SOLIDITY, WORLD_UNIT_MM, clodJitter,
} from '../density/labMound';
import {
  SOIL_DEPTH, TILE_CELLS, TILE_MM, WINDOW_BYTES, WINDOW_CELLS, WINDOW_SIZE,
  WORLD_SPAN, WORLD_TILES, streamGroundHeight,
} from '../density/labWorld';
import './DensityTerrainLabScene.css';

const MAX_PELLETS = 36;

/** World units per second the scout walks. About 12 mm/s — a tile every 1.3 s. */
const SCOUT_SPEED = 2.4;

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
  age: number;
}

/**
 * Isolated density-terrain experiment. It deliberately does not share the
 * production voxel mesher, so failures here cannot disturb the main map.
 *
 * The soil is STREAMED: a three-by-three window of tiles is resident and it
 * slides to keep the scout in the middle one. See `TerrainStream` for why the
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
  private readonly scout: any;
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

    this.scout = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xd8492f, roughness: 0.5, emissive: 0x3a0d05 }),
    );
    this.scout.castShadow = true;
    this.scout.position.set(start, streamGroundHeight(start, start) + 0.16, start);
    this.scene.add(this.scout);

    /*
     * Framing in fractions of the WINDOW, not of the world. The window is what
     * exists; the world is four hundred tiles of formula and putting the camera
     * a fraction of it away would look at soil that is not loaded.
     */
    this.camera.position.set(
      start + WINDOW_SIZE * 0.16, this.scout.position.y + WINDOW_SIZE * 0.2, start + WINDOW_SIZE * 0.3,
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.scout.position);
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
    this.scene.fog = new THREE.Fog(0x8db4d6, WINDOW_SIZE * 0.42, WINDOW_SIZE * 0.98);
    this.addLighting();

    const hud = document.createElement('div');
    hud.className = 'density-lab-hud';
    hud.innerHTML = `
      <div class="density-lab-title">DENSITY TERRAIN LAB <span>${BITE_WIDTH_MM} mm bite · ${BITE_DEPTH_MM} mm deep</span></div>
      <div class="density-lab-status"></div>
      <div class="density-lab-crosshair" aria-hidden="true"></div>
      <div class="density-lab-hint">Drag to orbit · pinch to zoom · WASD or the pad to walk · space to dig</div>
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
    this.scout.geometry.dispose();
    if (this.scout.material instanceof THREE.Material) this.scout.material.dispose();
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
     * The shadow camera follows the scout rather than sitting over a fixed
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
     * that fills in last is under the scout's feet or out at the fog line.
     * Queued in raster order it was the former, which is the one place a gap
     * is unmissable.
     */
    const sx = this.scout.position.x / (CHUNK_CELLS * CELL_SIZE);
    const sz = this.scout.position.z / (CHUNK_CELLS * CELL_SIZE);
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

  private carveAtCrosshair(): void {
    if (this.chunks.size === 0) return;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects([...this.chunks.values()], false)[0];
    if (!hit) {
      this.status.dataset.message = 'Aim the ring at soil';
      this.updateStatus();
      return;
    }

    const inward = this.raycaster.ray.direction.clone().normalize();
    /*
     * The brush RIDES the surface and only dips in by BITE_DEPTH.
     *
     * Sinking the centre below the hit, as this did, buries most of the
     * sphere and the crater ends up as deep as the centre plus the whole
     * radius — 7.9 mm for what was advertised as a 5 mm scoop. A mandible
     * does not do that; it scrapes. Putting the centre (radius - depth)
     * ABOVE the surface leaves exactly a cap of height BITE_DEPTH below it,
     * which is the bite, and the offset is negative because `inward` points
     * into the soil.
     */
    const center = hit.point.clone().addScaledVector(inward, BITE_DEPTH - BRUSH_RADIUS);
    const result = this.stream.subtractSphere(center, BRUSH_RADIUS);
    if (result.changedSamples === 0 || result.removedVolume <= 0.0001) {
      this.status.dataset.message = 'No packed soil in that scoop';
      this.updateStatus();
      return;
    }

    this.totalRemoved += result.removedVolume;
    this.rebuildAround(result.bounds);
    this.spawnPellet(hit.point, hit.face?.normal ?? new THREE.Vector3(0, 1, 0), result.removedVolume);
    this.status.dataset.message = `${result.removedVolume.toFixed(2)} voxel³ pellet freed`;
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
    );
    /*
     * A knobbly lump, not a drum.
     *
     * This was `CylinderGeometry(r, 0.92r, 1.45r, 8)` — an octagonal tube,
     * and it read as exactly that. An icosahedron at detail 0 is twenty flat
     * triangles, which under flat shading is already closer to a chip of
     * earth than anything round; roughening each vertex breaks the symmetry
     * so no two clods are the same lump.
     */
    const geometry = new THREE.IcosahedronGeometry(radius, 0);
    const pos = geometry.getAttribute('position');
    const seed = this.pellets.length + volume * 1e4;
    for (let i = 0; i < pos.count; i++) {
      const k = clodJitter(seed, i);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.86, pos.getZ(i) * k);
    }
    pos.needsUpdate = true;
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
    mesh.position.copy(point).addScaledVector(normal, radius * 1.8);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.volume = volume;
    this.scene.add(mesh);

    this.pellets.push({
      mesh,
      velocity: normal.multiplyScalar(1.4).add(new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        1.3 + Math.random() * 0.7,
        (Math.random() - 0.5) * 0.8,
      )),
      age: 0,
    });
  }

  private updatePellets(delta: number): void {
    for (const pellet of this.pellets) {
      pellet.age += delta;
      pellet.velocity.y -= 9.5 * delta;
      pellet.mesh.position.addScaledVector(pellet.velocity, delta);
      pellet.mesh.rotation.x += delta * 1.7;
      pellet.mesh.rotation.z += delta * 1.2;
      const radius = (pellet.mesh.geometry.boundingSphere?.radius ?? 0.35) * 0.55;
      const floorY = this.groundAt(pellet.mesh.position.x, pellet.mesh.position.z) + radius;
      if (pellet.mesh.position.y < floorY) {
        pellet.mesh.position.y = floorY;
        if (Math.abs(pellet.velocity.y) > 0.22) pellet.velocity.y *= -0.28;
        else pellet.velocity.y = 0;
        pellet.velocity.x *= 0.82;
        pellet.velocity.z *= 0.82;
      }
    }
  }

  /**
   * Height of packed soil at a world position, read from the RESIDENT field
   * rather than from the formula, so the scout and the pellets drop into holes
   * that have actually been dug. Falls back to the formula outside the window,
   * where by construction nothing has been dug anyway.
   */
  private groundAt(worldX: number, worldZ: number): number {
    const x = worldX - this.stream.originWorldX;
    const z = worldZ - this.stream.originWorldZ;
    const span = WINDOW_CELLS * CELL_SIZE;
    if (x < 0 || x > span || z < 0 || z > span) return streamGroundHeight(worldX, worldZ);
    for (let y = CELLS_Y; y >= 0; y -= 1) {
      if (this.stream.field.get(Math.round(x / CELL_SIZE), y, Math.round(z / CELL_SIZE)) > 0) {
        return y * CELL_SIZE;
      }
    }
    return 0;
  }

  /**
   * Walk the scout, then let the window catch up.
   *
   * Movement is relative to where the camera is looking, because the pad has
   * no idea which way is north and neither does the player. The recentre is
   * checked every frame but only fires on a tile crossing, which is the whole
   * point of tiles being larger than a step.
   */
  private updateScout(delta: number): void {
    if (this.move.forward === 0 && this.move.strafe === 0) return;

    const forward = new THREE.Vector3()
      .subVectors(this.scout.position, this.camera.position);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) return;
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const step = new THREE.Vector3()
      .addScaledVector(forward, this.move.forward)
      .addScaledVector(right, this.move.strafe);
    if (step.lengthSq() === 0) return;
    step.normalize().multiplyScalar(SCOUT_SPEED * delta);

    const margin = CELL_SIZE * 3;
    const previous = this.scout.position.clone();
    this.scout.position.x = THREE.MathUtils.clamp(
      this.scout.position.x + step.x, margin, WORLD_SPAN - margin,
    );
    this.scout.position.z = THREE.MathUtils.clamp(
      this.scout.position.z + step.z, margin, WORLD_SPAN - margin,
    );
    this.scout.position.y = this.groundAt(this.scout.position.x, this.scout.position.z) + 0.16;

    // Carry the camera along by exactly the scout's step, so orbiting is
    // untouched by walking: the arm the player set stays the arm they set.
    const moved = this.scout.position.clone().sub(previous);
    this.camera.position.add(moved);
    this.controls.target.copy(this.scout.position);

    const scroll = this.stream.recentreOn(this.scout.position.x, this.scout.position.z);
    if (scroll) {
      this.lastScrollMs = scroll.ms;
      this.refreshResidency(false, scroll.retained);
      this.updateStatus();
    }
  }

  private updateStatus(): void {
    const message = this.status.dataset.message ?? 'Walk with the pad, aim, and press DIG';
    const physicalVolumeMm3 = this.totalRemoved * WORLD_UNIT_MM ** 3;
    const tileX = Math.floor(this.scout.position.x / (TILE_CELLS * CELL_SIZE));
    const tileZ = Math.floor(this.scout.position.z / (TILE_CELLS * CELL_SIZE));
    const megabytes = (WINDOW_BYTES / 1048576).toFixed(1);
    const queued = this.pending.length > 0 ? ` · ${this.pending.length} queued` : '';
    this.status.innerHTML = `
      <b>${message}</b><br>
      Removed: ${this.totalRemoved.toFixed(1)} voxel³ · ${physicalVolumeMm3.toFixed(0)} mm³<br>
      World: ${WORLD_TILES}×${WORLD_TILES} tiles of ${TILE_MM} mm = ${WORLD_SPAN * WORLD_UNIT_MM} mm<br>
      Tile ${tileX},${tileZ} · window ${WINDOW_CELLS}×${CELLS_Y}×${WINDOW_CELLS} = ${megabytes} MB<br>
      Mesh: ${this.lastMeshMs.toFixed(1)} ms · scroll ${this.lastScrollMs.toFixed(1)} ms${queued}<br>
      Dug: ${this.stream.editedSamples} samples kept
    `;
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
    this.updateScout(delta);
    this.controls.update();
    this.drainPending(now - this.previousFrameStart);
    this.previousFrameStart = now;
    this.updatePellets(delta);
    if (this.sun) {
      this.sun.position.set(
        this.scout.position.x + WINDOW_SIZE * 0.5,
        SOIL_DEPTH + WINDOW_SIZE * 0.7,
        this.scout.position.z + WINDOW_SIZE * 0.34,
      );
      this.sun.target.position.copy(this.scout.position);
      this.sun.target.updateMatrixWorld();
    }
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.animate);
  };
}
