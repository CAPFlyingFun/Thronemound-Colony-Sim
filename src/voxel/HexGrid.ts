/**
 * Hex-prism grid — an experiment, deliberately kept off to one side.
 *
 * The cube world is not going anywhere: raycasting is a cubic DDA, collision is
 * axis-separated AABBs, and the whole six-axis wall-walking model rests on
 * "every surface is an axis-aligned cube face". A hex prism has eight faces and
 * its six sides are not axis-aligned, so none of that survives contact with it.
 *
 * So this is a sandbox for one question — does a hex grid LOOK better as soil,
 * and does grabbing one cell read as picking up a clod? — with no route back
 * into the cube world. Nothing here is imported by DigScene.
 *
 * Pointy-top hexes in axial coordinates (q, r), stacked in layers along Y.
 */

export const HEX_RADIUS = 0.6;
/** Flat-to-flat width, which is the spacing along a row. */
export const HEX_WIDTH = Math.sqrt(3) * HEX_RADIUS;
export const HEX_HEIGHT = 1;

export const HEX_AIR = 0;

export interface HexCoord {
  q: number;
  r: number;
  y: number;
}

/** Centre of a cell in world space. */
export function hexCentre(q: number, r: number, y: number): { x: number; y: number; z: number } {
  return {
    x: HEX_WIDTH * (q + r / 2),
    y: y * HEX_HEIGHT,
    z: HEX_RADIUS * 1.5 * r,
  };
}

/**
 * The six in-plane neighbours, ORDERED TO MATCH the side faces.
 *
 * Side face i spans corners i and i+1, whose midpoint lies at 60 + 60i degrees,
 * so neighbour i has to be the one in that direction. Listing them in the
 * conventional [1,0] first order puts every entry one step out of phase, which
 * culls the wrong faces — the walls come out as disconnected vertical slats
 * with gaps you can see the sky through.
 */
export const HEX_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0],
];

/** Corner offsets of a pointy-top hex, counter-clockwise from the +X vertex. */
export function hexCorners(): { x: number; z: number }[] {
  const corners: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    // Pointy-top: first vertex at 30 degrees, so flats face +/-X.
    const angle = (Math.PI / 180) * (60 * i + 30);
    corners.push({ x: HEX_RADIUS * Math.cos(angle), z: HEX_RADIUS * Math.sin(angle) });
  }
  return corners;
}

export interface HexMeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  faceCount: number;
}

/**
 * A small hex-prism world.
 *
 * Dense storage on purpose: this is a test room a few dozen cells across, not a
 * streaming world, and the sparse-chunk machinery would only be in the way of
 * answering the question.
 */
export class HexWorld {
  readonly radius: number;
  readonly depth: number;
  readonly surface: number;
  private readonly cells = new Map<string, number>();

  constructor(radius: number, depth: number, surface: number) {
    this.radius = radius;
    this.depth = depth;
    this.surface = surface;
  }

  static key(q: number, r: number, y: number): string {
    return `${q},${r},${y}`;
  }

  /** Inside the hexagonal footprint? Axial distance from the origin. */
  inBounds(q: number, r: number, y: number): boolean {
    const distance = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
    return distance <= this.radius && y > this.surface - this.depth && y <= this.surface;
  }

  get(q: number, r: number, y: number): number {
    if (!this.inBounds(q, r, y)) return HEX_AIR;
    const found = this.cells.get(HexWorld.key(q, r, y));
    if (found !== undefined) return found;
    return this.generate(y);
  }

  /** Same strata as the cube world, so the comparison is like for like. */
  private generate(y: number): number {
    const depth = this.surface - y;
    if (depth < 2) return 1; // topsoil
    if (depth < 8) return 2; // clay
    return 3; // sand
  }

  dig(q: number, r: number, y: number): number {
    const value = this.get(q, r, y);
    if (value === HEX_AIR) return HEX_AIR;
    this.cells.set(HexWorld.key(q, r, y), HEX_AIR);
    return value;
  }

  /** Every cell in the footprint, for meshing. */
  *all(): Generator<HexCoord> {
    for (let y = this.surface; y > this.surface - this.depth; y--) {
      for (let q = -this.radius; q <= this.radius; q++) {
        for (let r = -this.radius; r <= this.radius; r++) {
          if (this.inBounds(q, r, y)) yield { q, r, y };
        }
      }
    }
  }
}

/**
 * Mesh the whole world, culling faces that touch a solid neighbour.
 *
 * Same idea as the cube mesher, and the reason a hex grid is affordable at all:
 * a buried cell emits nothing, so cost tracks how much has been dug rather than
 * how big the room is. Eight faces per prism instead of six.
 */
export function meshHexWorld(world: HexWorld, tint: (q: number, r: number, y: number) => number): HexMeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let faceCount = 0;

  const corners = hexCorners();
  const half = HEX_HEIGHT / 2;

  const push = (
    verts: { x: number; y: number; z: number }[],
    nx: number, ny: number, nz: number,
    shade: number,
  ) => {
    const first = positions.length / 3;
    for (const v of verts) {
      positions.push(v.x, v.y, v.z);
      normals.push(nx, ny, nz);
      colors.push(shade, shade, shade);
    }
    // Fan from the first vertex; every face here is convex.
    for (let i = 1; i < verts.length - 1; i++) indices.push(first, first + i, first + i + 1);
    faceCount++;
  };

  for (const { q, r, y } of world.all()) {
    if (world.get(q, r, y) === HEX_AIR) continue;
    const centre = hexCentre(q, r, y);
    const shade = tint(q, r, y);

    // Six sides.
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = HEX_NEIGHBOURS[i]!;
      if (world.get(q + dq, r + dr, y) !== HEX_AIR) continue;
      const a = corners[i]!;
      const b = corners[(i + 1) % 6]!;
      // Outward normal of this side, in the XZ plane.
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const len = Math.hypot(mx, mz) || 1;
      push([
        { x: centre.x + a.x, y: centre.y - half, z: centre.z + a.z },
        { x: centre.x + b.x, y: centre.y - half, z: centre.z + b.z },
        { x: centre.x + b.x, y: centre.y + half, z: centre.z + b.z },
        { x: centre.x + a.x, y: centre.y + half, z: centre.z + a.z },
      ], mx / len, 0, mz / len, shade * 0.82);
    }

    // Cap and floor.
    if (world.get(q, r, y + 1) === HEX_AIR) {
      push(corners.map((c) => ({ x: centre.x + c.x, y: centre.y + half, z: centre.z + c.z })),
        0, 1, 0, shade);
    }
    if (world.get(q, r, y - 1) === HEX_AIR) {
      push([...corners].reverse().map((c) => ({ x: centre.x + c.x, y: centre.y - half, z: centre.z + c.z })),
        0, -1, 0, shade * 0.55);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    faceCount,
  };
}

/**
 * Which cell a world position falls in.
 *
 * Axial rounding: convert to fractional cube coordinates, round all three, then
 * correct whichever drifted furthest. Rounding q and r independently lands in
 * the wrong cell near a shared edge, which is the classic hex-grid trap.
 */
export function hexAt(x: number, y: number, z: number): HexCoord {
  const fr = (z / (HEX_RADIUS * 1.5));
  const fq = x / HEX_WIDTH - fr / 2;
  const fs = -fq - fr;

  let rq = Math.round(fq);
  let rr = Math.round(fr);
  const rs = Math.round(fs);
  const dq = Math.abs(rq - fq);
  const dr = Math.abs(rr - fr);
  const ds = Math.abs(rs - fs);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;

  return { q: rq, r: rr, y: Math.round(y / HEX_HEIGHT) };
}
