/**
 * Sparse chunked voxel volume.
 *
 * Two properties make an ant-scale world affordable on a phone:
 *
 *  1. Chunks are generated lazily and stored as a single byte while they stay
 *     uniform. Untouched soil costs 1 byte per 32^3 voxels; a chunk only
 *     allocates its 32 KB array the first time something inside it changes.
 *  2. Only exposed faces are ever meshed (see mesher.ts), so render cost tracks
 *     how much has been DUG rather than how large the world is.
 *
 * No three.js in here on purpose — this is plain data so it can be unit-tested
 * without a GL context, the same way PheromoneField and FoodNode are.
 */

export const AIR = 0;
export const TOPSOIL = 1;
export const CLAY = 2;
export const SAND = 3;
export const STONE = 4;

export type VoxelId = number;

export interface Material {
  readonly id: VoxelId;
  readonly name: string;
  /** Base linear RGB, 0..1. Meshing jitters this per voxel so soil isn't flat. */
  readonly color: readonly [number, number, number];
  /**
   * How much longer this soil takes than topsoil, as a multiplier.
   *
   * Deliberately a ratio rather than a number of seconds. Absolute dig time is
   * a property of the *ant* — she starts slow and improves with practice — and
   * hardness is a property of the *dirt*. Storing seconds here conflated the
   * two, so neither could be retuned without silently moving the other.
   *
   * The ratios are also gentler than the seconds they replaced (which implied
   * 1 / 1.43 / 2). At 2x, clay costs an unpractised ant ten seconds a cube,
   * which is the point where the number stops describing strata and starts
   * describing waiting.
   */
  readonly hardness: number;
  /**
   * Bulk density in g/cm^3 — what a pellet of this stuff WEIGHS.
   *
   * Bulk rather than particle density, because a clod is soil with its pore
   * space still in it, not a lump of mineral. That is the difference between
   * about 1.3 and about 2.65 for the same material, so using the wrong one
   * would double every load.
   */
  readonly density: number;
  readonly diggable: boolean;
}

export const MATERIALS: readonly Material[] = [
  { id: AIR, name: 'Air', color: [0, 0, 0], hardness: 0, density: 0, diggable: false },
  { id: TOPSOIL, name: 'Topsoil', color: [0.28, 0.19, 0.11], hardness: 1, density: 1.3, diggable: true },
  { id: CLAY, name: 'Clay', color: [0.42, 0.21, 0.14], hardness: 1.5, density: 1.6, diggable: true },
  { id: SAND, name: 'Sand', color: [0.66, 0.56, 0.36], hardness: 1.25, density: 1.5, diggable: true },
  { id: STONE, name: 'Stone', color: [0.34, 0.34, 0.36], hardness: 0, density: 2.6, diggable: false },
];

export function materialOf(id: VoxelId): Material {
  return MATERIALS[id] ?? MATERIALS[0]!;
}

export function isSolid(id: VoxelId): boolean {
  return id !== AIR;
}

/**
 * How big a voxel is in the real world. One world unit is one cell is 5 mm, so
 * the 128^3 volume is a 64 cm cube of earth.
 *
 * Lives here rather than in the scene because it is a property of the WORLD,
 * and because weight is derived from it: a pellet's mass is its volume in
 * millimetres times the density above, and neither half of that belongs to a
 * renderer.
 */
export const VOXEL_MM = 5;

export const CHUNK = 32;

/**
 * How far from a voxel the mesher can still be reading it, in cells.
 *
 * Two, set by the cavity dish: it counts the solid around the AIR voxel beyond
 * a face, which reaches `normal + normal` — two cells out along one axis. The
 * chamfer is tighter at one cell, but DIAGONALLY, which is the part that keeps
 * getting missed. Anything within this radius of an edit has to be re-meshed.
 */
export const MESH_DEPENDENCY_RADIUS = 2;

/** Whether a chunk is entirely empty, entirely solid, or a mix of both. */
type Fill = 'air' | 'solid' | 'mixed';

interface Chunk {
  /**
   * Null until something inside the chunk is modified — an untouched chunk is
   * reproducible from the generator, so it costs zero bytes no matter what its
   * contents are. (Checking for a *uniform* chunk instead would achieve nothing
   * here: soil strata don't line up with chunk boundaries, so essentially every
   * chunk contains two materials and would allocate immediately.)
   */
  data: Uint8Array | null;
  /** Computed once at generation; only used to skip meshing buried chunks. */
  fill: Fill;
}

export type Generator = (x: number, y: number, z: number) => VoxelId;

/**
 * Default world profile: flat ground with stratified soil below it.
 * `y` is up, so depth below the surface is `surfaceY - y`.
 */
export function layeredGenerator(surfaceY: number): Generator {
  return (_x, y, _z) => {
    if (y > surfaceY) return AIR;
    const depth = surfaceY - y;
    if (depth < 6) return TOPSOIL;
    if (depth < 34) return CLAY;
    if (depth < 78) return SAND;
    return STONE;
  };
}

export class VoxelWorld {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunksZ: number;

  private readonly chunks: (Chunk | undefined)[];
  private readonly gen: Generator;

  /** Chunk indices whose geometry is stale. The renderer drains this. */
  readonly dirty = new Set<number>();

  /** Running totals — the mound above ground is the soil taken from below. */
  excavated = 0;
  deposited = 0;

  constructor(sizeX: number, sizeY: number, sizeZ: number, gen: Generator) {
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.sizeZ = sizeZ;
    this.chunksX = Math.ceil(sizeX / CHUNK);
    this.chunksY = Math.ceil(sizeY / CHUNK);
    this.chunksZ = Math.ceil(sizeZ / CHUNK);
    this.chunks = new Array<Chunk | undefined>(this.chunksX * this.chunksY * this.chunksZ);
    this.gen = gen;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sizeX && y < this.sizeY && z < this.sizeZ;
  }

  chunkIndex(cx: number, cy: number, cz: number): number {
    return (cy * this.chunksZ + cz) * this.chunksX + cx;
  }

  chunkCoords(index: number): [number, number, number] {
    const cx = index % this.chunksX;
    const cz = Math.floor(index / this.chunksX) % this.chunksZ;
    const cy = Math.floor(index / (this.chunksX * this.chunksZ));
    return [cx, cy, cz];
  }

  /**
   * Out of bounds reads are STONE on the sides and floor (invisible walls the
   * player can't dig through) and AIR above, so the sky stays open.
   */
  get(x: number, y: number, z: number): VoxelId {
    if (y >= this.sizeY) return AIR;
    if (!this.inBounds(x, y, z)) return STONE;
    const chunk = this.ensureChunk(x >> 5, y >> 5, z >> 5);
    if (chunk.data === null) return this.gen(x, y, z);
    return chunk.data[VoxelWorld.localIndex(x, y, z)]!;
  }

  set(x: number, y: number, z: number, value: VoxelId): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const cx = x >> 5;
    const cy = y >> 5;
    const cz = z >> 5;
    const chunk = this.ensureChunk(cx, cy, cz);
    if (chunk.data === null) {
      if (this.gen(x, y, z) === value) return false;
      chunk.data = this.materialize(cx, cy, cz);
      chunk.fill = 'mixed';
    }
    const i = VoxelWorld.localIndex(x, y, z);
    if (chunk.data[i] === value) return false;
    chunk.data[i] = value;
    this.markDirty(x, y, z);
    return true;
  }

  /** Remove a voxel. Returns the id that was there, or AIR if nothing changed. */
  dig(x: number, y: number, z: number): VoxelId {
    const existing = this.get(x, y, z);
    if (!isSolid(existing) || !materialOf(existing).diggable) return AIR;
    if (!this.set(x, y, z, AIR)) return AIR;
    this.excavated++;
    return existing;
  }

  /** Place a voxel into empty space. Returns true if it landed. */
  deposit(x: number, y: number, z: number, value: VoxelId): boolean {
    if (this.get(x, y, z) !== AIR) return false;
    if (!this.set(x, y, z, value)) return false;
    this.deposited++;
    return true;
  }

  /**
   * True when a chunk could contribute geometry. A uniform chunk whose six
   * neighbours are uniform and equally solid is fully interior — meshing it
   * would emit nothing, so the mesher skips it outright.
   */
  chunkMayHaveFaces(cx: number, cy: number, cz: number): boolean {
    const chunk = this.ensureChunk(cx, cy, cz);
    if (chunk.fill === 'air') return false;
    if (chunk.fill === 'mixed') return true;
    const neighbours: [number, number, number][] = [
      [cx - 1, cy, cz], [cx + 1, cy, cz],
      [cx, cy - 1, cz], [cx, cy + 1, cz],
      [cx, cy, cz - 1], [cx, cy, cz + 1],
    ];
    for (const [nx, ny, nz] of neighbours) {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= this.chunksX || ny >= this.chunksY || nz >= this.chunksZ) {
        // Outside the volume: solid on the sides/floor, open above.
        if (ny >= this.chunksY) return true;
        continue;
      }
      if (this.ensureChunk(nx, ny, nz).fill !== 'solid') return true;
    }
    return false;
  }

  /** Every chunk index that should be considered for meshing right now. */
  allMeshableChunks(): number[] {
    const out: number[] = [];
    for (let cy = 0; cy < this.chunksY; cy++) {
      for (let cz = 0; cz < this.chunksZ; cz++) {
        for (let cx = 0; cx < this.chunksX; cx++) {
          if (this.chunkMayHaveFaces(cx, cy, cz)) out.push(this.chunkIndex(cx, cy, cz));
        }
      }
    }
    return out;
  }

  /**
   * Every in-bounds chunk whose MESH depends on this voxel.
   *
   * Not the six face neighbours. The chamfer decides each corner by asking
   * whether the convex edge runs on PAST it, and that question reads voxels
   * diagonally across — so a cell in one chunk can decide geometry in a chunk
   * it meets only along an edge or at a single corner. The cavity dish reaches
   * further still, two cells out along a face normal, and that is the widest
   * anything in the mesher looks; hence the radius.
   *
   * Rebuilding only the face neighbours is what left a stale rim beside a fresh
   * one. The rebuilt side pulled its corners in for the new pit, the diagonal
   * chunk went on chamfering as though nothing had been dug, and the wedge
   * between the two was open sky — a triangle of background at the corner of
   * the excavation, which is exactly how it was reported from play.
   */
  chunksNear(x: number, y: number, z: number): number[] {
    const out: number[] = [];
    const span = (v: number, count: number): [number, number] => [
      Math.max(0, (v - MESH_DEPENDENCY_RADIUS) >> 5),
      Math.min(count - 1, (v + MESH_DEPENDENCY_RADIUS) >> 5),
    ];
    const [x0, x1] = span(x, this.chunksX);
    const [y0, y1] = span(y, this.chunksY);
    const [z0, z1] = span(z, this.chunksZ);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) out.push(this.chunkIndex(cx, cy, cz));
      }
    }
    return out;
  }

  /** Bytes actually allocated for voxel storage — proves the sparseness claim. */
  allocatedBytes(): number {
    let bytes = 0;
    for (const chunk of this.chunks) {
      if (chunk?.data) bytes += chunk.data.length;
    }
    return bytes;
  }

  private static localIndex(x: number, y: number, z: number): number {
    return (((y & 31) << 5) + (z & 31)) * CHUNK + (x & 31);
  }

  private ensureChunk(cx: number, cy: number, cz: number): Chunk {
    const index = this.chunkIndex(cx, cy, cz);
    const existing = this.chunks[index];
    if (existing) return existing;
    const chunk = this.generateChunk(cx, cy, cz);
    this.chunks[index] = chunk;
    return chunk;
  }

  /**
   * Classify a chunk without keeping it. Only the air/solid verdict is
   * retained; the voxels themselves are recomputed on demand until the chunk
   * is written to.
   */
  private generateChunk(cx: number, cy: number, cz: number): Chunk {
    const baseX = cx * CHUNK;
    const baseY = cy * CHUNK;
    const baseZ = cz * CHUNK;
    let sawAir = false;
    let sawSolid = false;
    for (let y = 0; y < CHUNK && !(sawAir && sawSolid); y++) {
      for (let z = 0; z < CHUNK && !(sawAir && sawSolid); z++) {
        for (let x = 0; x < CHUNK; x++) {
          if (isSolid(this.gen(baseX + x, baseY + y, baseZ + z))) sawSolid = true;
          else sawAir = true;
          if (sawAir && sawSolid) break;
        }
      }
    }
    const fill: Fill = sawAir && sawSolid ? 'mixed' : sawSolid ? 'solid' : 'air';
    return { data: null, fill };
  }

  private materialize(cx: number, cy: number, cz: number): Uint8Array {
    const baseX = cx * CHUNK;
    const baseY = cy * CHUNK;
    const baseZ = cz * CHUNK;
    const data = new Uint8Array(CHUNK * CHUNK * CHUNK);
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          data[(y * CHUNK + z) * CHUNK + x] = this.gen(baseX + x, baseY + y, baseZ + z);
        }
      }
    }
    return data;
  }

  /** Whatever the mesher can see from here has to be rebuilt. */
  private markDirty(x: number, y: number, z: number): void {
    for (const index of this.chunksNear(x, y, z)) this.dirty.add(index);
  }
}
