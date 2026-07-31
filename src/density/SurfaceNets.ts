import { DensityField } from './DensityField';

export interface SurfaceNetMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * A box of cells to mesh, in cell indices, upper bounds exclusive.
 *
 * Without one, remeshing after a dig costs the whole WORLD, which is why the
 * lab's mound had to be a 16 mm pea: a 64 mm map at the same cell size is
 * 64 times the samples and half a second a tap. A bite only disturbs its own
 * neighbourhood, so with a region the cost tracks the BITE instead and the map
 * can be as large as memory allows.
 */
export interface CellRegion {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
}

const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const cellIndex = (x: number, y: number, z: number, cellsX: number, cellsY: number): number =>
  x + cellsX * (y + cellsY * z);

/**
 * Builds a watertight surface-net mesh from a signed density field.
 * One representative vertex is placed in every mixed-sign cell, then quads
 * are emitted around each sign-changing grid edge.
 *
 * With a `region`, only quads OWNED by cells inside it are emitted — but
 * vertices are still built for one cell beyond its low side, because a quad
 * reaches back to (x-1, y-1, z-1) for three of its four corners. Pad the wrong
 * side, or not at all, and every chunk comes out with a torn face against its
 * neighbour. Regions tile exactly: each cell owns its quads and no other cell
 * emits them, so meshing a region is the same surface as meshing the lot.
 */
export function buildSurfaceNets(
  field: DensityField,
  isoLevel = 0,
  region?: CellRegion,
): SurfaceNetMesh {
  const { cellsX, cellsY, cellsZ, cellSize } = field;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const qx0 = region ? clamp(region.x0, cellsX) : 0;
  const qy0 = region ? clamp(region.y0, cellsY) : 0;
  const qz0 = region ? clamp(region.z0, cellsZ) : 0;
  const qx1 = region ? clamp(region.x1, cellsX) : cellsX;
  const qy1 = region ? clamp(region.y1, cellsY) : cellsY;
  const qz1 = region ? clamp(region.z1, cellsZ) : cellsZ;
  // Vertices, padded one cell back so the quads above have corners to use.
  const vx0 = Math.max(0, qx0 - 1);
  const vy0 = Math.max(0, qy0 - 1);
  const vz0 = Math.max(0, qz0 - 1);

  /*
   * The vertex lookup is sized to the REGION, not to the field.
   *
   * Sizing it to the field costs an allocate-and-fill of the whole world on
   * every chunk — 33 MB a time at 256 cells a side — which made a chunked
   * rebuild SLOWER than the whole-field one it replaced: 122 ms to redraw a
   * four-millimetre bite. The saving from meshing less is entirely undone by
   * clearing a map of everything.
   */
  const rx = qx1 - vx0;
  const ry = qy1 - vy0;
  const rz = qz1 - vz0;
  const vertexByCell = new Int32Array(Math.max(0, rx * ry * rz));
  vertexByCell.fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const densities = new Float64Array(8);

  for (let z = vz0; z < qz1; z += 1) {
    for (let y = vy0; y < qy1; y += 1) {
      for (let x = vx0; x < qx1; x += 1) {
        let insideCount = 0;
        for (let corner = 0; corner < 8; corner += 1) {
          const offset = CORNERS[corner];
          if (!offset) continue;
          const value = field.get(x + offset[0], y + offset[1], z + offset[2]) - isoLevel;
          densities[corner] = value;
          if (value > 0) insideCount += 1;
        }
        if (insideCount === 0 || insideCount === 8) continue;

        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let crossings = 0;
        for (const [a, b] of EDGES) {
          const da = densities[a] ?? 0;
          const db = densities[b] ?? 0;
          if ((da > 0) === (db > 0)) continue;
          const ca = CORNERS[a];
          const cb = CORNERS[b];
          if (!ca || !cb) continue;
          const t = da / (da - db);
          sumX += ca[0] + (cb[0] - ca[0]) * t;
          sumY += ca[1] + (cb[1] - ca[1]) * t;
          sumZ += ca[2] + (cb[2] - ca[2]) * t;
          crossings += 1;
        }
        if (crossings === 0) continue;

        const vertex = positions.length / 3;
        positions.push(
          (x + sumX / crossings) * cellSize,
          (y + sumY / crossings) * cellSize,
          (z + sumZ / crossings) * cellSize,
        );
        vertexByCell[cellIndex(x - vx0, y - vy0, z - vz0, rx, ry)] = vertex;
      }
    }
  }

  const vertexAt = (x: number, y: number, z: number): number => {
    if (x < vx0 || x >= qx1 || y < vy0 || y >= qy1 || z < vz0 || z >= qz1) return -1;
    return vertexByCell[cellIndex(x - vx0, y - vy0, z - vz0, rx, ry)] ?? -1;
  };

  /*
   * All three axes pass the SAME flip rule, and that is the whole of it.
   *
   * Each of the three quads below lists its four vertices in the identical
   * cyclic pattern — (m, m-du, m-du-dv, m-dv) with (du, dv) cycling as
   * (Y,Z), (Z,X), (X,Y) — so the winding they need is identical too. The
   * first version gave the Y quad the opposite sign, which left the mesh
   * perfectly CLOSED and not consistently ORIENTED: 2,040 of its 21,138
   * edges had both their triangles running the same way round, and every
   * one of those faces is backface-culled. You could see through a tenth of
   * the hill while every boundary-edge count said the surface was sealed.
   *
   * Which is why the test beside this one checks ORIENTATION, not just
   * closure. Counting edges cannot tell the two apart — an edge shared by
   * two triangles is shared by two triangles whichever way they wind.
   */
  const addQuad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) {
      indices.push(a, d, c, a, c, b);
    } else {
      indices.push(a, b, c, a, c, d);
    }
  };

  for (let z = qz0; z < qz1; z += 1) {
    for (let y = qy0; y < qy1; y += 1) {
      for (let x = qx0; x < qx1; x += 1) {
        const start = field.get(x, y, z) - isoLevel;

        if ((start > 0) !== (field.get(x + 1, y, z) - isoLevel > 0)) {
          addQuad(
            vertexAt(x, y, z),
            vertexAt(x, y - 1, z),
            vertexAt(x, y - 1, z - 1),
            vertexAt(x, y, z - 1),
            start < 0,
          );
        }

        if ((start > 0) !== (field.get(x, y + 1, z) - isoLevel > 0)) {
          addQuad(
            vertexAt(x, y, z),
            vertexAt(x, y, z - 1),
            vertexAt(x - 1, y, z - 1),
            vertexAt(x - 1, y, z),
            start < 0,
          );
        }

        if ((start > 0) !== (field.get(x, y, z + 1) - isoLevel > 0)) {
          addQuad(
            vertexAt(x, y, z),
            vertexAt(x - 1, y, z),
            vertexAt(x - 1, y - 1, z),
            vertexAt(x, y - 1, z),
            start < 0,
          );
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
}
