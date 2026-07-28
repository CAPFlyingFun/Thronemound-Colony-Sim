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
  /** Seconds of sustained digging to remove one voxel. */
  readonly digSeconds: number;
  readonly diggable: boolean;
}

export const MATERIALS: readonly Material[] = [
  { id: AIR, name: 'Air', color: [0, 0, 0], digSeconds: 0, diggable: false },
  { id: TOPSOIL, name: 'Topsoil', color: [0.28, 0.19, 0.11], digSeconds: 0.35, diggable: true },
  { id: CLAY, name: 'Clay', color: [0.42, 0.21, 0.14], digSeconds: 0.7, diggable: true },
  { id: SAND, name: 'Sand', color: [0.66, 0.56, 0.36], digSeconds: 0.5, diggable: true },
  { id: STONE, name: 'Stone', color: [0.34, 0.34, 0.36], digSeconds: 0, diggable: false },
];

export function materialOf(id: VoxelId): Material {
  return MATERIALS[id] ?? MATERIALS[0]!;
}

export function isSolid(id: VoxelId): boolean {
  return id !== AIR;
}

export const CHUNK = 32;

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
    this.markDirty(cx, cy, cz, x, y, z);
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

  /** A face on a chunk edge belongs to the neighbour's mesh too. */
  private markDirty(cx: number, cy: number, cz: number, x: number, y: number, z: number): void {
    this.dirty.add(this.chunkIndex(cx, cy, cz));
    const lx = x & 31;
    const ly = y & 31;
    const lz = z & 31;
    const touch = (nx: number, ny: number, nz: number) => {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= this.chunksX || ny >= this.chunksY || nz >= this.chunksZ) return;
      this.dirty.add(this.chunkIndex(nx, ny, nz));
    };
    if (lx === 0) touch(cx - 1, cy, cz);
    if (lx === CHUNK - 1) touch(cx + 1, cy, cz);
    if (ly === 0) touch(cx, cy - 1, cz);
    if (ly === CHUNK - 1) touch(cx, cy + 1, cz);
    if (lz === 0) touch(cx, cy, cz - 1);
    if (lz === CHUNK - 1) touch(cx, cy, cz + 1);
  }
}
