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
import { HIT_BEVEL, hashVoxel } from './fracture';

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
 *
 * Narrowed from a tenth to a thirtieth when the pellet became the block. The
 * block she has been hitting is square; stretching what replaces it by a tenth
 * on one axis is a change of shape, and at the moment of the swap that is
 * exactly what the eye is looking for. This is enough to stop a heap reading as
 * stacked dice and small enough not to be the thing you notice.
 */
export const MIN_CLOD_AXIS_SCALE = 0.97;
export const MAX_CLOD_AXIS_SCALE = 1.03;

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

/**
 * Every loose piece is the WORKED BLOCK she just freed.
 *
 * It used to be a hex prism — square in the ground, hexagonal once it came
 * free, on the theory that a grain of soil settles into a different shape once
 * it is no longer packed against its neighbours. That reads fine in a heap and
 * badly at the one moment it matters: the block is on screen, twelve hits have
 * knocked its corners off, it gives, and it is replaced by a solid of a
 * different family at a different size. You watch the swap happen.
 *
 * So the pellet is the block. Same rhombicuboctahedron the chip mesh ends on,
 * same bevel, and — through pieceSource and clodSizeScale above — the same
 * size, to the float. Nothing pops because nothing changes.
 *
 * Variety comes from what already varied: per-cell size, resting angle, tint,
 * and a light roughening of the faces. Same shape, never the same lump twice.
 */

/**
 * How far the lumps are allowed to move the block's own silhouette.
 *
 * Low, and that is the whole point. At full strength the bulges swallowed the
 * bevel and the piece stopped being the block she had been hitting; this is
 * enough to keep a heap from reading as a pile of identical dice, and not
 * enough to change what the thing is.
 */
const BLOCK_ROUGHNESS = 0.15;

/**
 * Where one PIECE of a voxel gets its look from.
 *
 * A coordinate rather than a separate style function: shape identity already
 * travels with a clod as its source cell, through physics and through a save
 * file, so folding the piece index into that coordinate means everything
 * downstream — styleForVoxel, the instanced batches, toJSON — keeps working
 * untouched. Break a voxel into sixty-four and you get sixty-four different
 * lumps, still the same sixty-four after a reload.
 *
 * The first piece is the voxel ITSELF, unscrambled, and that part is load
 * bearing. Both the block and the pellet size themselves from a hash of a
 * coordinate, and while this scrambled the coordinate for every piece they were
 * hashing two different ones — same range, independent draws. The pellet came
 * out as much as a quarter off the block it replaced, at the exact moment the
 * player is watching that block become it. A voxel yielding one piece has
 * nothing to spread anyway.
 */
export function pieceSource(
  x: number,
  y: number,
  z: number,
  cell: number,
): { x: number; y: number; z: number } {
  if (cell === 0) return { x, y, z };
  return { x: x * 73 + cell, y: y * 149 + cell * 7, z: z * 211 + cell * 13 };
}

/* ------------------------------------------------------------- geometry */

/**
 * The worked block, built from its own vertices.
 *
 * Six squares, twelve bevels and eight corner triangles — the same solid the
 * chip mesh ends on, cut back by the same HIT_BEVEL. Built rather than
 * approximated, and that distinction turned out to matter: pushing an
 * icosphere onto the block's support function gets the SIZE exactly right and
 * the shape wrong, because none of the sphere's vertices land on the block's
 * edges. The flats came out rounded off and the pellet read as a faceted ball
 * sitting where a cube had been a frame earlier.
 *
 * Vertices are shared between faces, so the lumping below moves the whole
 * solid rather than pulling it apart at the seams.
 */
function workedBlock(): { verts: number[][]; faces: number[][] } {
  const on = 1;
  const back = 1 - HIT_BEVEL;
  const verts: number[][] = [];
  const seen = new Map<string, number>();
  const vertex = (p: number[]): number => {
    const key = p.map((v) => v.toFixed(5)).join(',');
    const found = seen.get(key);
    if (found !== undefined) return found;
    verts.push(p);
    seen.set(key, verts.length - 1);
    return verts.length - 1;
  };
  const at = (a: number, va: number, b: number, vb: number, c: number, vc: number) => {
    const p = [0, 0, 0];
    p[a] = va; p[b] = vb; p[c] = vc;
    return vertex(p);
  };

  const faces: number[][] = [];
  /** Fan a ring of vertices into triangles, wound to face outward. */
  const face = (ring: number[], n: number[]) => {
    const [p0, p1, p2] = [verts[ring[0]!]!, verts[ring[1]!]!, verts[ring[2]!]!];
    const e1 = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!];
    const e2 = [p2[0]! - p0[0]!, p2[1]! - p0[1]!, p2[2]! - p0[2]!];
    // Winding from the cross product against the intended normal, never
    // assumed — the trap that ate the crack quads and the hex room's walls.
    const facing = (e1[1]! * e2[2]! - e1[2]! * e2[1]!) * n[0]!
      + (e1[2]! * e2[0]! - e1[0]! * e2[2]!) * n[1]!
      + (e1[0]! * e2[1]! - e1[1]! * e2[0]!) * n[2]!;
    const out = facing >= 0 ? ring : [...ring].reverse();
    for (let i = 1; i + 1 < out.length; i++) faces.push([out[0]!, out[i]!, out[i + 1]!]);
  };

  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    for (const sa of [1, -1]) {
      const n = [0, 0, 0];
      n[a] = sa;
      face([
        at(a, sa * on, b, back, c, back),
        at(a, sa * on, b, -back, c, back),
        at(a, sa * on, b, -back, c, -back),
        at(a, sa * on, b, back, c, -back),
      ], n);
      // The bevel on the edge this face shares with the one on axis b. Taking
      // b as the NEXT axis visits each of the twelve edges exactly once.
      for (const sb of [1, -1]) {
        const bn = [0, 0, 0];
        bn[a] = sa; bn[b] = sb;
        face([
          at(a, sa * on, b, sb * back, c, -back),
          at(a, sa * on, b, sb * back, c, back),
          at(a, sa * back, b, sb * on, c, back),
          at(a, sa * back, b, sb * on, c, -back),
        ], bn);
      }
    }
  }
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        face([
          vertex([sx * on, sy * back, sz * back]),
          vertex([sx * back, sy * on, sz * back]),
          vertex([sx * back, sy * back, sz * on]),
        ], [sx, sy, sz]);
      }
    }
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
  const { verts, faces } = workedBlock();

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
  /*
   * The swell is kept SEPARATE from the block underneath it.
   *
   * What has to come out at a known size is the block: its faces have to land
   * on the same half-extent the chip mesh finished at, or the pellet is a
   * different size from the thing it replaced. Normalising the finished radii
   * would instead fix the shape's MEAN, which for a solid whose corners reach
   * 1.4x its faces is a different number entirely — and one that drifts with
   * however lumpy the material happens to be.
   *
   * So the lumps are measured on their own and divided back out, leaving the
   * block's own dimensions untouched however they are tuned.
   */
  const swell = verts.map((v) => {
    const len = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
    let bulge = 0;
    for (const lobe of lobes) {
      const d = (v[0]! * lobe.dir[0]! + v[1]! * lobe.dir[1]! + v[2]! * lobe.dir[2]!) / len;
      // Only the facing hemisphere bulges, and smoothly — raising a clamped
      // dot to a power keeps the falloff broad instead of creasing.
      bulge += lobe.amp * Math.pow(Math.max(0, d), lobe.tight);
    }
    return 1 + Math.min(bulge, bulgeCap) * BLOCK_ROUGHNESS;
  });
  const meanSwell = swell.reduce((a, b) => a + b, 0) / swell.length;
  // Half-extent 0.5, so a piece drawn at PIECE_SIZE spans exactly what the
  // block spanned. Everything else here perturbs around it.
  const correction = 0.5 / meanSwell;

  const shifted = verts.map((v, i) => {
    let r = swell[i]! * correction;
    // Settle the underside. Damped with the lumps, because the block already
    // has flat faces to rest on — this is a lean, not the sliced-off base a
    // rounded clod needed to stop looking like an egg balanced on a point.
    if (v[1]! < 0) r *= 1 - feel.flatten * BLOCK_ROUGHNESS * (-v[1]! / (Math.hypot(v[0]!, v[1]!, v[2]!) || 1));
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
