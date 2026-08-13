/**
 * THE BLOCK GRID — soil as pieces you can pick up.
 *
 * The carry room's whole idea: the ground is a grid of small cubes, and
 * digging is not editing a field, it is TAKING A BLOCK. One block is very
 * nearly one mouthful (2 mm against the queen's 1.75 mm bite), so the
 * physicality the density rooms fought for arrives here by construction —
 * a tunnel is exactly the blocks somebody carried out of it, one at a time.
 *
 * Pure on purpose: a Uint8 lattice, a face-culling cube mesher, a DDA ray
 * walk, and a column-top query. No THREE, no scene — every rule the room
 * runs on is testable as arithmetic. (The legacy `VoxelWorld` does some of
 * this for the old dig room; it is welded to 5 mm cells, its own material
 * atlas and that room's chunking, which is why this is a fresh 200 lines
 * rather than an adaptation of 1,000.)
 */

/** One cube's edge, in millimetres — the room's whole scale. */
export const BLOCK_MM = 2;

export interface GridSize {
  x: number;
  y: number;
  z: number;
}

/** A solid lattice: 1 is soil, 0 is air. Indexed [x + y*X + z*X*Y]. */
export class BlockGrid {
  readonly size: GridSize;

  readonly cells: Uint8Array;

  private solidCount = 0;

  constructor(size: GridSize) {
    this.size = size;
    this.cells = new Uint8Array(size.x * size.y * size.z);
  }

  get solid(): number { return this.solidCount; }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.size.x
      && y >= 0 && y < this.size.y
      && z >= 0 && z < this.size.z;
  }

  private at(x: number, y: number, z: number): number {
    return x + y * this.size.x + z * this.size.x * this.size.y;
  }

  get(x: number, y: number, z: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    return this.cells[this.at(x, y, z)] === 1;
  }

  set(x: number, y: number, z: number, solid: boolean): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.at(x, y, z);
    const now = solid ? 1 : 0;
    if (this.cells[i] === now) return false;
    this.cells[i] = now;
    this.solidCount += solid ? 1 : -1;
    return true;
  }

  /** Fill every cell solid — the undug block. */
  fillAll(): void {
    this.cells.fill(1);
    this.solidCount = this.cells.length;
  }

  /**
   * The top of a column: the highest solid cell's UPPER surface, in cell
   * units — what an ant stands on. -1 for a column dug to nothing.
   */
  columnTop(x: number, z: number): number {
    if (x < 0 || x >= this.size.x || z < 0 || z >= this.size.z) return -1;
    for (let y = this.size.y - 1; y >= 0; y -= 1) {
      if (this.cells[this.at(x, y, z)] === 1) return y + 1;
    }
    return -1;
  }
}

export interface RayHit {
  /** The solid cell the ray entered. */
  cell: [number, number, number];
  /** The face it entered through, as an outward unit normal. */
  normal: [number, number, number];
  /** Distance travelled, in the caller's units. */
  dist: number;
}

/**
 * Amanatides–Woo DDA through the lattice: the first solid cell along a ray,
 * and which face it was entered through — which is the cell a dropped block
 * lands in. Origin and direction in CELL units.
 */
export function raycastBlocks(
  grid: BlockGrid,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
): RayHit | null {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  const dirX = dx / len;
  const dirY = dy / len;
  const dirZ = dz / len;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const stepX = dirX > 0 ? 1 : -1;
  const stepY = dirY > 0 ? 1 : -1;
  const stepZ = dirZ > 0 ? 1 : -1;
  const tDeltaX = dirX !== 0 ? Math.abs(1 / dirX) : Infinity;
  const tDeltaY = dirY !== 0 ? Math.abs(1 / dirY) : Infinity;
  const tDeltaZ = dirZ !== 0 ? Math.abs(1 / dirZ) : Infinity;
  const frac = (v: number): number => v - Math.floor(v);
  let tMaxX = dirX !== 0
    ? (dirX > 0 ? (1 - frac(ox)) : frac(ox)) * tDeltaX : Infinity;
  let tMaxY = dirY !== 0
    ? (dirY > 0 ? (1 - frac(oy)) : frac(oy)) * tDeltaY : Infinity;
  let tMaxZ = dirZ !== 0
    ? (dirZ > 0 ? (1 - frac(oz)) : frac(oz)) * tDeltaZ : Infinity;

  let normal: [number, number, number] = [0, 0, 0];
  let t = 0;
  // A ray that STARTS inside soil reports that cell with no entry face —
  // the caller decides what a buried eye means.
  if (grid.get(x, y, z)) return { cell: [x, y, z], normal: [0, 0, 0], dist: 0 };

  while (t <= maxDist) {
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      normal = [-stepX, 0, 0];
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      normal = [0, -stepY, 0];
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      normal = [0, 0, -stepZ];
    }
    if (t > maxDist) return null;
    if (grid.get(x, y, z)) return { cell: [x, y, z], normal, dist: t };
  }
  return null;
}

export interface ChunkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** The six faces: outward normal and the quad's corners (unit cube). */
const FACES: readonly {
  n: [number, number, number];
  corners: readonly [number, number, number][];
}[] = [
  { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { n: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { n: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { n: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

/** A cheap, stable per-cell tint so individual blocks read as blocks. */
function shade(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return 0.88 + ((h >>> 16) % 100) / 100 * 0.24; // 0.88 .. 1.12
}

/**
 * Face-culled cube mesh for a sub-box of the grid, in millimetres.
 * Only faces against AIR are emitted — the block look, at block cost.
 */
export function meshChunk(
  grid: BlockGrid,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): ChunkMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let z = z0; z < z1; z += 1) {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!grid.get(x, y, z)) continue;
        const tint = shade(x, y, z);
        for (const face of FACES) {
          if (grid.get(x + face.n[0], y + face.n[1], z + face.n[2])) continue;
          const base = positions.length / 3;
          for (const c of face.corners) {
            positions.push(
              (x + c[0]) * BLOCK_MM,
              (y + c[1]) * BLOCK_MM,
              (z + c[2]) * BLOCK_MM,
            );
            normals.push(face.n[0], face.n[1], face.n[2]);
            colors.push(
              0.55 * tint, 0.42 * tint, 0.28 * tint,
            );
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
