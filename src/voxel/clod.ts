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
  [SAND]: { lumpiness: 0.1, lobes: 5, flatten: 0.3 },
  // Cohesive: broad smooth faces, few bumps, reads dense.
  [CLAY]: { lumpiness: 0.13, lobes: 2, flatten: 0.14 },
};
/** Topsoil: crumbly, medium bumps. */
const DEFAULT_FEEL: ClodFeel = { lumpiness: 0.18, lobes: 3, flatten: 0.2 };

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

  const radii = verts.map((v) => {
    let r = 1;
    for (const lobe of lobes) {
      const d = v[0]! * lobe.dir[0]! + v[1]! * lobe.dir[1]! + v[2]! * lobe.dir[2]!;
      // Only the facing hemisphere bulges, and smoothly — raising a clamped
      // dot to a power keeps the falloff broad instead of creasing.
      r += lobe.amp * Math.pow(Math.max(0, d), lobe.tight);
    }
    // Squash the underside. Moderate, so it reads as a resting face rather
    // than as a sliced plane.
    if (v[1]! < 0) r *= 1 - feel.flatten * (-v[1]!);
    return r;
  });

  // Equalise volume. Mean radius cubed tracks volume closely enough for shapes
  // this convex, and it is what stops one variant looking like more soil.
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const correction = 0.5 / mean;

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i]!;
    const r = radii[i]! * correction;
    positions[i * 3 + 0] = v[0]! * r;
    positions[i * 3 + 1] = v[1]! * r;
    positions[i * 3 + 2] = v[2]! * r;
  }

  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => {
    indices[i * 3 + 0] = f[0]!;
    indices[i * 3 + 1] = f[1]!;
    indices[i * 3 + 2] = f[2]!;
  });

  // Area-weighted vertex normals, so the facets read as a rounded lump with
  // flats rather than as a faceted gem.
  const normals = new Float32Array(verts.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i]! as [number, number, number];
    const ax = positions[a * 3]!; const ay = positions[a * 3 + 1]!; const az = positions[a * 3 + 2]!;
    const ux = positions[b * 3]! - ax; const uy = positions[b * 3 + 1]! - ay; const uz = positions[b * 3 + 2]! - az;
    const vx = positions[c * 3]! - ax; const vy = positions[c * 3 + 1]! - ay; const vz = positions[c * 3 + 2]! - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const idx of [a, b, c]) {
      normals[idx * 3 + 0] = (normals[idx * 3 + 0] ?? 0) + nx;
      normals[idx * 3 + 1] = (normals[idx * 3 + 1] ?? 0) + ny;
      normals[idx * 3 + 2] = (normals[idx * 3 + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i < verts.length; i++) {
    const l = Math.hypot(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!) || 1;
    normals[i * 3 + 0] = (normals[i * 3 + 0] ?? 0) / l;
    normals[i * 3 + 1] = (normals[i * 3 + 1] ?? 0) / l;
    normals[i * 3 + 2] = (normals[i * 3 + 2] ?? 0) / l;
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
