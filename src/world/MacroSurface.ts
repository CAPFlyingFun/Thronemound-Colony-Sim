/**
 * The MACRO surface: the landscape as a cheap smooth sheet, drawn everywhere
 * the fine window is not — now STREAMED, because at 57 m the whole sheet at
 * walking pitch would be ~13 million vertices.
 *
 * Three levels of tile, in rings around the ant:
 *
 *   L0   256 mm tile, 16 mm pitch     a 4 m box — everything you walk past
 *   L1   2 m tile,    128 mm pitch    a 16 m box — the hills around you
 *   L2   8 m tile,    512 mm pitch    the rest of the world, mostly fog
 *
 * Ring boxes SNAP to the next level's tile grid, so a finer ring always
 * covers whole coarser tiles exactly — a coarse tile is either fully
 * replaced or fully present, never half-drawn. Rings move only when the ant
 * crosses a 2 m (L0) or 8 m (L1) line, and the retile is diffed and built a
 * few tiles per frame, nearest first.
 *
 * Every tile wears a SKIRT: a short curtain dropped from its perimeter.
 * Where two pitches meet, the coarse edge is a chord of the fine curve and
 * daylight shows through the difference — the classic LOD T-junction crack,
 * the geometric half of what this room's "sky in the terrain" report turned
 * out to be. The skirt is sized to each level's worst sag, hides inside the
 * hill when edges agree exactly, and needs no stitching logic at all. The
 * world's outer rim gets a deep skirt to the soil floor besides.
 *
 * THE HAND-OFF, unchanged and still the whole trick: fragments inside the
 * fine window's rectangle are DISCARDED (one vec4 uniform, two comparisons
 * in the fragment shader), so inside that rectangle the streamed density
 * mesh is the only surface and holes need no machinery. Only L0 tiles ever
 * overlap the window.
 */

import * as THREE from 'three';

import { MM, WORLD_MM, groundHeightAt } from './worldScape';

/** Near streaming tile: deliberately DECOUPLED from the 32 mm soil tile. */
export const MACRO_TILE_MM = 256;

interface Level {
  tileMm: number;
  pitchMm: number;
  /** Ring box span in mm; the ring snaps to the NEXT level's tile grid. */
  spanMm: number;
  /** Skirt depth: the worst height this pitch can miss, with margin. */
  skirtMm: number;
}

const LEVELS: Level[] = [
  { tileMm: MACRO_TILE_MM, pitchMm: 16, spanMm: 4096, skirtMm: 8 },
  { tileMm: 2048, pitchMm: 128, spanMm: 16384, skirtMm: 24 },
  { tileMm: 8192, pitchMm: 512, spanMm: WORLD_MM, skirtMm: 64 },
];

/** How many tiles may be (re)built per update call. */
const BUILD_BUDGET = 4;

export class MacroSurface {
  readonly root = new THREE.Group();

  /** The fine window's rectangle, in world units. Fragments inside die. */
  private readonly clip = { value: new THREE.Vector4(0, 0, 0, 0) };

  private readonly material: THREE.MeshLambertMaterial;

  private readonly tiles = new Map<string, THREE.Mesh>();

  private readonly wanted = new Map<string, { level: number; tx: number; tz: number }>();

  private queue: string[] = [];

  /** Ring origins, mm; NaN forces the first update to lay everything out. */
  private readonly ringX = [Number.NaN, Number.NaN];

  private readonly ringZ = [Number.NaN, Number.NaN];

  tileCount = 0;

  vertexCount = 0;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({
      color: 0x8a6a45, side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uClip = this.clip;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n'
          + 'vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vWorldPos;\nuniform vec4 uClip;',
        )
        .replace(
          '#include <clipping_planes_fragment>',
          'if (vWorldPos.x > uClip.x && vWorldPos.x < uClip.z\n'
          + '  && vWorldPos.z > uClip.y && vWorldPos.z < uClip.w) discard;\n'
          + '#include <clipping_planes_fragment>',
        );
    };
    this.root.add(this.buildRimSkirt());
  }

  /**
   * Follow the ant. Cheap when nothing crossed a ring line: one comparison
   * per level, then up to `budget` queued tiles built nearest-first.
   */
  update(antXMm: number, antZMm: number, budget = BUILD_BUDGET): void {
    let moved = false;
    for (let level = 0; level < 2; level += 1) {
      const snap = LEVELS[level + 1]!.tileMm;
      const span = LEVELS[level]!.spanMm;
      const ox = this.ringOrigin(antXMm, span, snap);
      const oz = this.ringOrigin(antZMm, span, snap);
      if (ox !== this.ringX[level] || oz !== this.ringZ[level]) {
        this.ringX[level] = ox;
        this.ringZ[level] = oz;
        moved = true;
      }
    }
    if (moved) this.retile(antXMm, antZMm);
    for (let built = 0; built < budget && this.queue.length > 0;) {
      const key = this.queue.shift()!;
      const want = this.wanted.get(key);
      if (!want || this.tiles.has(key)) continue;
      this.addTile(key, want.level, want.tx, want.tz);
      built += 1;
    }
  }

  get pendingTiles(): number { return this.queue.length; }

  drainForTest(): void {
    while (this.queue.length > 0) {
      const key = this.queue.shift()!;
      const want = this.wanted.get(key);
      if (!want || this.tiles.has(key)) continue;
      this.addTile(key, want.level, want.tx, want.tz);
    }
  }

  private ringOrigin(centreMm: number, spanMm: number, snapMm: number): number {
    const raw = Math.round((centreMm - spanMm / 2) / snapMm) * snapMm;
    return Math.min(WORLD_MM - spanMm, Math.max(0, raw));
  }

  /** Recompute the wanted set, drop strays, queue the missing near-first. */
  private retile(antXMm: number, antZMm: number): void {
    this.wanted.clear();
    const inRing = (level: number, xMm: number, zMm: number, tileMm: number) =>
      level < 2
      && xMm >= this.ringX[level]!
      && xMm + tileMm <= this.ringX[level]! + LEVELS[level]!.spanMm
      && zMm >= this.ringZ[level]!
      && zMm + tileMm <= this.ringZ[level]! + LEVELS[level]!.spanMm;
    for (let level = 0; level < LEVELS.length; level += 1) {
      const { tileMm, spanMm } = LEVELS[level]!;
      const x0 = level < 2 ? this.ringX[level]! : 0;
      const z0 = level < 2 ? this.ringZ[level]! : 0;
      for (let zMm = z0; zMm < z0 + spanMm; zMm += tileMm) {
        for (let xMm = x0; xMm < x0 + spanMm; xMm += tileMm) {
          // Skip a tile a finer ring already covers completely.
          if (level > 0 && inRing(level - 1, xMm, zMm, tileMm)) continue;
          this.wanted.set(`${level}:${xMm / tileMm}:${zMm / tileMm}`, {
            level, tx: xMm / tileMm, tz: zMm / tileMm,
          });
        }
      }
    }
    for (const [key, mesh] of this.tiles) {
      if (this.wanted.has(key)) continue;
      this.dropTile(key, mesh);
    }
    const missing: { key: string; d: number }[] = [];
    for (const [key, want] of this.wanted) {
      if (this.tiles.has(key)) continue;
      const { tileMm } = LEVELS[want.level]!;
      missing.push({
        key,
        d: Math.hypot(
          (want.tx + 0.5) * tileMm - antXMm, (want.tz + 0.5) * tileMm - antZMm,
        ),
      });
    }
    missing.sort((a, b) => a.d - b.d);
    this.queue = missing.map((m) => m.key);
  }

  private addTile(key: string, level: number, tx: number, tz: number): void {
    const mesh = this.buildTile(level, tx, tz);
    this.tiles.set(key, mesh);
    this.root.add(mesh);
    this.tileCount += 1;
    this.vertexCount += mesh.geometry.getAttribute('position').count;
  }

  private dropTile(key: string, mesh: THREE.Mesh): void {
    this.tiles.delete(key);
    this.root.remove(mesh);
    this.tileCount -= 1;
    this.vertexCount -= mesh.geometry.getAttribute('position').count;
    mesh.geometry.dispose();
  }

  /**
   * One tile: a displaced grid with a skirt around it. Positions are
   * WORLD-anchored (the mesh sits at the origin) so the clip test needs no
   * per-tile bookkeeping, and heights come from the shared ground function —
   * mound included, so the anthill shows from across the map.
   *
   * Vertices are computed from GLOBAL grid indices, never from a per-tile
   * origin plus a local offset: `x0 + i * step` and the neighbour's
   * `x0' + 0 * step` are the same point in exact arithmetic and different
   * points in floats, and that difference rendered as hairline cracks of sky
   * along every tile seam. An integer times a step is bit-identical on both
   * sides of the seam.
   */
  private buildTile(level: number, tx: number, tz: number): THREE.Mesh {
    const { tileMm, pitchMm, skirtMm } = LEVELS[level]!;
    const step = pitchMm / MM;
    const drop = skirtMm / MM;
    const segments = tileMm / pitchMm;
    const side = segments + 1;
    const positions = new Float32Array((side * side + side * 4) * 3);
    let at = 0;
    for (let j = 0; j < side; j += 1) {
      for (let i = 0; i < side; i += 1) {
        const x = (tx * segments + i) * step;
        const z = (tz * segments + j) * step;
        positions[at] = x;
        positions[at + 1] = groundHeightAt(x, z);
        positions[at + 2] = z;
        at += 3;
      }
    }
    /* The skirt ring: a dropped copy of each perimeter vertex, one edge at a
     * time (south, north, west, east) so the strip indexing stays simple. */
    const rim: number[] = [];
    for (let i = 0; i < side; i += 1) rim.push(i);
    for (let i = 0; i < side; i += 1) rim.push(side * (side - 1) + i);
    for (let j = 0; j < side; j += 1) rim.push(side * j);
    for (let j = 0; j < side; j += 1) rim.push(side * j + side - 1);
    const skirtBase = side * side;
    for (const p of rim) {
      positions[at] = positions[p * 3]!;
      positions[at + 1] = positions[p * 3 + 1]! - drop;
      positions[at + 2] = positions[p * 3 + 2]!;
      at += 3;
    }
    const index: number[] = [];
    for (let j = 0; j < segments; j += 1) {
      for (let i = 0; i < segments; i += 1) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    for (let edge = 0; edge < 4; edge += 1) {
      for (let s = 0; s < side - 1; s += 1) {
        const rimAt = edge * side + s;
        const a = rim[rimAt]!;
        const b = rim[rimAt + 1]!;
        const a2 = skirtBase + rimAt;
        const b2 = skirtBase + rimAt + 1;
        // The material is double-sided; the winding only has to be consistent.
        index.push(a, a2, b, b, a2, b2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /**
   * THE WORLD'S EDGE, CLOSED: a curtain around the rim from the ground line
   * to the soil floor, so a finite heightfield seen from a low camera cannot
   * show sky under its own last row. Same global 512 mm grid indices as the
   * far tiles' edges, so the top seam is crackless.
   */
  private buildRimSkirt(): THREE.Mesh {
    const step = LEVELS[2]!.pitchMm / MM;
    const count = WORLD_MM / LEVELS[2]!.pitchMm;
    const positions: number[] = [];
    const index: number[] = [];
    const edge = (gx0: number, gz0: number, dx: number, dz: number) => {
      const base = positions.length / 3;
      for (let s = 0; s <= count; s += 1) {
        const x = (gx0 + dx * s) * step;
        const z = (gz0 + dz * s) * step;
        positions.push(x, groundHeightAt(x, z), z, x, 0, z);
      }
      for (let s = 0; s < count; s += 1) {
        const a = base + s * 2;
        index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    };
    edge(0, 0, 1, 0);
    edge(0, count, 1, 0);
    edge(0, 0, 0, 1);
    edge(count, 0, 0, 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position', new THREE.BufferAttribute(new Float32Array(positions), 3),
    );
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  /** Move the hand-off rectangle to the fine window's footprint. */
  setWindow(x0: number, z0: number, x1: number, z1: number): void {
    this.clip.value.set(x0, z0, x1, z1);
  }

  dispose(): void {
    for (const child of this.root.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
    }
    this.material.dispose();
    this.root.clear();
    this.tiles.clear();
    this.wanted.clear();
    this.queue.length = 0;
  }
}
