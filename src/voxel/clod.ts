/**
 * Excavated soil, as a clod rather than a cube.
 *
 * Terrain stays voxel-based — that is the whole game — but a lump of soil an
 * ant has broken free and is carrying in her mandibles has no reason to be a
 * perfect cube. This generates a small set of irregular low-poly clods and
 * picks one deterministically from the voxel it came out of, so a given cell
 * always yields the same shape.
 *
 * No three.js here, in line with the rest of src/voxel: it emits plain typed
 * arrays and the scene wraps them. That keeps the shape maths unit testable
 * without a GL context.
 */

import { CLAY, SAND, type VoxelId } from './VoxelWorld';
import { hashVoxel } from './fracture';

/**
 * Enough shapes that a mound doesn't read as repeated, few enough to build once
 * and keep forever. Real variety comes from multiplying these by rotation,
 * proportion and tint rather than from more meshes.
 */
export const SOIL_CLOD_VARIANT_COUNT = 12;

/**
 * Proportion variation, kept modest on purpose. Every clod is one voxel of
 * soil, so a clod that looked half the size of its neighbour would be a lie
 * about how much dirt is in it.
 */
export const MIN_CLOD_AXIS_SCALE = 0.9;
export const MAX_CLOD_AXIS_SCALE = 1.1;

export function positiveModulo(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How a soil type holds together, as shape parameters rather than a whole system. */
export interface ClodFeel {
  /** Depth of the broad surface undulation. */
  lumpiness: number;
  /** How many separate bulges. Fewer and wider reads as cohesive. */
  lobes: number;
  /** How much the resting side is squashed flat. */
  flatten: number;
}

const FEEL: Record<number, ClodFeel> = {
  // Looser, flatter, finer-grained — a scoop of sand slumps.
  [SAND]: { lumpiness: 0.18, lobes: 4, flatten: 0.3 },
  // Cohesive: broad faces, few bumps, reads dense and heavy.
  [CLAY]: { lumpiness: 0.22, lobes: 2, flatten: 0.2 },
};
/**
 * Topsoil: crumbly, angular.
 *
 * Lumpiness up half again from the first pass. Subtle displacement over a
 * sphere is still a sphere, and it showed — the clods came out as eggs. A clod
 * needs to be visibly out of round before flat shading has facets to catch.
 *
 * Not further, though: the "lumpy but not spiky" test caught 0.32 + 0.34 at a
 * max/min radius ratio of 2.4, which is a starfish. Flat shading does most of
 * the work here; the displacement only has to give it something to shade.
 */
const DEFAULT_FEEL: ClodFeel = { lumpiness: 0.26, lobes: 3, flatten: 0.26 };

export function clodFeel(voxel: VoxelId): ClodFeel {
  return FEEL[voxel] ?? DEFAULT_FEEL;
}

export interface ClodShape {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Everything needed to draw one carried load, all derived from its origin. */
export interface SoilLoadStyle {
  seed: number;
  variant: number;
  material: VoxelId;
  /** Per-axis proportion. The product is 1, so soil quantity reads constant. */
  axisScale: [number, number, number];
  /** Resting orientation, as Euler angles. */
  spin: [number, number, number];
  /** Multiplier on the soil colour, so no two clods are quite the same shade. */
  tint: number;
}

/**
 * The look of the soil from one specific cell.
 *
 * Everything is a pure function of the voxel it came out of, so the clod the
 * ant picks up is the clod she puts down, and reconstructing it from a save
 * gives the same shape rather than a new one.
 */
export function styleForVoxel(x: number, y: number, z: number, material: VoxelId): SoilLoadStyle {
  const seed = hashVoxel(x, y, z, material);
  const rand = rng(seed ^ 0x9e3779b9);

  // Two axes vary freely; the third compensates so the product stays 1. A
  // wider clod is a shorter one, never simply a bigger one.
  const span = MAX_CLOD_AXIS_SCALE - MIN_CLOD_AXIS_SCALE;
  const sx = MIN_CLOD_AXIS_SCALE + rand() * span;
  const sy = MIN_CLOD_AXIS_SCALE + rand() * span;
  const sz = 1 / (sx * sy);

  return {
    seed,
    variant: positiveModulo(seed, SOIL_CLOD_VARIANT_COUNT),
    material,
    axisScale: [sx, sy, sz],
    spin: [rand() * Math.PI * 2, rand() * Math.PI * 2, rand() * Math.PI * 2],
    tint: 0.86 + rand() * 0.28,
  };
}

/* ------------------------------------------------------------- geometry */

const T = (1 + Math.sqrt(5)) / 2;

/** Icosahedron vertices, unnormalised. */
const ICO_VERTS: readonly (readonly [number, number, number])[] = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];

const ICO_FACES: readonly (readonly [number, number, number])[] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

/**
 * A subdivided icosahedron, built here rather than taken from three so this
 * module stays engine-free. One subdivision is 80 triangles — enough to read as
 * a rounded lump at ant scale, cheap enough to forget about.
 */
function icosphere(): { verts: number[][]; faces: number[][] } {
  const verts = ICO_VERTS.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
  const midpoints = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const found = midpoints.get(key);
    if (found !== undefined) return found;
    const va = verts[a]!;
    const vb = verts[b]!;
    const m = [(va[0]! + vb[0]!) / 2, (va[1]! + vb[1]!) / 2, (va[2]! + vb[2]!) / 2];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    verts.push([m[0]! / l, m[1]! / l, m[2]! / l]);
    const index = verts.length - 1;
    midpoints.set(key, index);
    return index;
  };

  const faces: number[][] = [];
  for (const [a, b, c] of ICO_FACES) {
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  return { verts, faces };
}

/**
 * One irregular clod.
 *
 * Displacement is deliberately LOW frequency — a handful of broad lobes rather
 * than per-vertex noise. Per-vertex noise gives a crumpled, spiky ball; broad
 * lobes give the uneven, compacted look of soil that broke off a wall.
 *
 * Steps: sum a few smooth directional bulges, squash the underside so the clod
 * has somewhere to rest, then rescale so every variant encloses about the same
 * volume — because every clod is exactly one voxel of soil regardless of shape.
 */
export function buildClodShape(variant: number, feel: ClodFeel = DEFAULT_FEEL): ClodShape {
  const rand = rng(hashVoxel(variant + 1, 7919, 104729));
  const { verts, faces } = icosphere();

  // A few random directions, each pushing the surface out where it faces them.
  const lobes: { dir: number[]; amp: number; tight: number }[] = [];
  for (let i = 0; i < feel.lobes; i++) {
    const a = rand() * Math.PI * 2;
    const b = Math.acos(rand() * 2 - 1);
    lobes.push({
      dir: [Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)],
      amp: (0.55 + rand() * 0.85) * feel.lumpiness,
      tight: 1.1 + rand() * 1.5,
    });
  }

  /*
   * Lobes STACK, so the total bulge has to be bounded rather than trusted.
   *
   * Where two or three lobes point the same way their amplitudes simply add,
   * and the result is a spike — with three lobes the worst case was over twice
   * the base radius, which is a starfish, not a clod. Tuning the amplitudes
   * down until it happened to pass would have left the same unbounded sum one
   * unlucky seed away from a spike again.
   */
  const bulgeCap = feel.lumpiness * 1.5;
  const radii = verts.map((v) => {
    let bulge = 0;
    for (const lobe of lobes) {
      const d = v[0]! * lobe.dir[0]! + v[1]! * lobe.dir[1]! + v[2]! * lobe.dir[2]!;
      // Only the facing hemisphere bulges, and smoothly — raising a clamped
      // dot to a power keeps the falloff broad instead of creasing.
      bulge += lobe.amp * Math.pow(Math.max(0, d), lobe.tight);
    }
    let r = 1 + Math.min(bulge, bulgeCap);
    // Squash the underside. Moderate, so it reads as a resting face rather
    // than as a sliced plane.
    if (v[1]! < 0) r *= 1 - feel.flatten * (-v[1]!);
    return r;
  });

  // Equalise volume. Mean radius cubed tracks volume closely enough for shapes
  // this convex, and it is what stops one variant looking like more soil.
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const correction = 0.5 / mean;

  const shifted = verts.map((v, i) => {
    const r = radii[i]! * correction;
    return [v[0]! * r, v[1]! * r, v[2]! * r];
  });

  /*
   * FLAT shaded, so each facet catches the light on its own.
   *
   * Smoothed vertex normals over a rounded hull is exactly what makes a clod
   * read as an egg — the silhouette was already irregular, but the shading
   * blended every facet into one continuous curve so none of it showed. Flat
   * normals turn the same geometry into broken soil, which is why this emits
   * non-indexed triangles: shared vertices cannot carry two different normals.
   */
  const positions = new Float32Array(faces.length * 9);
  const normals = new Float32Array(faces.length * 9);
  const indices = new Uint32Array(faces.length * 3);

  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = faces[f]! as [number, number, number];
    const va = shifted[a]!; const vb = shifted[b]!; const vc = shifted[c]!;
    const ux = vb[0]! - va[0]!; const uy = vb[1]! - va[1]!; const uz = vb[2]! - va[2]!;
    const wx = vc[0]! - va[0]!; const wy = vc[1]! - va[1]!; const wz = vc[2]! - va[2]!;
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    [va, vb, vc].forEach((v, k) => {
      const o = f * 9 + k * 3;
      positions[o + 0] = v[0]!;
      positions[o + 1] = v[1]!;
      positions[o + 2] = v[2]!;
      normals[o + 0] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
      indices[f * 3 + k] = f * 3 + k;
    });
  }

  return { positions, normals, indices };
}

/** Longest half-extent, for placing a clod clear of the ant without intersecting. */
export function clodRadius(shape: ClodShape): number {
  let max = 0;
  for (let i = 0; i < shape.positions.length; i += 3) {
    max = Math.max(max, Math.hypot(shape.positions[i]!, shape.positions[i + 1]!, shape.positions[i + 2]!));
  }
  return max;
}
