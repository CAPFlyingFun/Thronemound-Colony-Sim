import { DensityField } from './DensityField';

export interface SurfaceNetMesh {
  positions: Float32Array;
  indices: Uint32Array;
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
 */
export function buildSurfaceNets(field: DensityField, isoLevel = 0): SurfaceNetMesh {
  const { cellsX, cellsY, cellsZ, cellSize } = field;
  const vertexByCell = new Int32Array(cellsX * cellsY * cellsZ);
  vertexByCell.fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const densities = new Float64Array(8);

  for (let z = 0; z < cellsZ; z += 1) {
    for (let y = 0; y < cellsY; y += 1) {
      for (let x = 0; x < cellsX; x += 1) {
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
        vertexByCell[cellIndex(x, y, z, cellsX, cellsY)] = vertex;
      }
    }
  }

  const vertexAt = (x: number, y: number, z: number): number => {
    if (x < 0 || x >= cellsX || y < 0 || y >= cellsY || z < 0 || z >= cellsZ) return -1;
    return vertexByCell[cellIndex(x, y, z, cellsX, cellsY)] ?? -1;
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

  for (let z = 0; z < cellsZ; z += 1) {
    for (let y = 0; y < cellsY; y += 1) {
      for (let x = 0; x < cellsX; x += 1) {
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
