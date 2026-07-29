/**
 * Chipping a voxel apart, one crumb at a time.
 *
 * A voxel used to sit visually perfect for five seconds and then vanish, which
 * reads as a health bar rather than as an ant loosening packed soil. This turns
 * the cube being worked into a 3x3x3 cluster of seeded crumbs that shrink,
 * shift and break away in an irregular order, so the SILHOUETTE changes
 * throughout the dig.
 *
 * Three properties matter and each falls out of the design rather than being
 * enforced afterwards:
 *
 *  - **Deterministic.** Everything derives from a hash of the coordinates and
 *    material, so a voxel always fractures the same way — across a cancel, a
 *    reload, or a save. No Math.random() anywhere in here.
 *  - **Monotonic.** Removal order is a fixed permutation and crumbs disappear
 *    at fixed per-crumb thresholds, so more progress can never restore soil.
 *  - **Pure.** No three.js, no renderer. The mesh builder emits the same plain
 *    typed arrays the chunk mesher does, so the effect shares one material with
 *    the world and can be unit tested headlessly.
 */

import { FACES, tangentAxes, voxelTint, type MeshData } from './mesher';
import { TILE_VOXELS } from './tileTextures';
import { CLAY, SAND, type VoxelId } from './VoxelWorld';

/**
 * Crumbs per axis. Five, because it is ODD.
 *
 * An even grid has no middle cell, so a crater has nothing to open from and
 * always starts off-centre against a seam. Five gives a single centre crumb on
 * every face for the first strike to bite into, and 125 pieces is fine enough
 * that the lattice never reads as a grid. It costs almost nothing, because
 * damage is local and undamaged regions emit no interior geometry at all.
 */
export const CHIP_CELLS = 5;
export const CELL_COUNT = CHIP_CELLS * CHIP_CELLS * CHIP_CELLS;

/**
 * The last crumb never breaks on its own. Removal is capped one short of the
 * full set so the voxel cannot disappear before the dig logic completes — the
 * scene is a view of the dig, never the thing that decides it is over.
 */
export const MAX_REMOVED = CELL_COUNT - 1;

/** Crumbs start breaking here, and the last one is due by here. */
/*
 * Crumbs break across almost the whole dig, so the rate is roughly even: 124
 * pieces over ~0.93 of a 12.5 second cube is about ten a second, which is what
 * a steady chipping-away should look like.
 */
const FIRST_BREAK = 0.06;
const LAST_BREAK = 0.99;

/**
 * How far ahead of its own turn a crumb starts to loosen, in progress.
 *
 * This is the most important number in the file. Erosion used to be GLOBAL:
 * every crumb shrank and tilted by the same amount at once, so the whole cube
 * loosened evenly, the lattice showed up as a grid, and it read as a block
 * dissolving rather than as something being chipped. Local erosion means only
 * the crumbs about to go are visibly chewed while the rest stays fused and
 * solid — a pickaxe biting one spot instead of the whole face crumbling.
 */
const EROSION_LEAD = 0.13;
const EROSION_MAX = 0.55;

/** Progress past which the remaining soil is loose enough to move. */
const WOBBLE_FROM = 0.7;

/** How far a fully eroded crumb can tilt, in radians. */
const MAX_TILT = 0.42;

/**
 * How far the remnant rounds off toward the clod it is about to become.
 *
 * The last thing standing used to be a squared-off stub that vanished and was
 * replaced by a rounded lump, which reads as a swap rather than as the same
 * piece of soil. Pulling the surviving crumbs toward a ball as the dig
 * finishes makes the cube visibly chisel down INTO the clod — ice to egg —
 * so the thing she picks up is the thing you watched her free.
 *
 * Held to zero for most of the dig: rounding a barely-touched cube would make
 * intact terrain look sanded.
 */
const ROUND_FROM = 0.55;
const ROUND_MAX = 0.55;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type DigEventKind =
  | 'DIG_CHIP_SMALL'
  | 'DIG_CHIP_LARGE'
  | 'DIG_CRACK'
  | 'DIG_RELEASE';

export interface DigEvent {
  kind: DigEventKind;
  /** Where it happened, in voxel-local space (0..1 on each axis). */
  at: Vec3;
  /** How many crumbs went at once. Zero for cracks and the final release. */
  crumbs: number;
}

/** How a soil type comes apart. Modest differences on a shared system. */
export interface MaterialFeel {
  /** Crumbs that tend to let go together. Clay comes away in slabs. */
  clumping: number;
  /** Particle burst size multiplier. */
  dust: number;
  /** Multiplier on how far surviving crumbs shrink. */
  crumble: number;
}

const FEEL: Record<number, MaterialFeel> = {
  [SAND]: { clumping: 1, dust: 1.6, crumble: 1.15 },
  [CLAY]: { clumping: 3, dust: 0.6, crumble: 0.8 },
};
const DEFAULT_FEEL: MaterialFeel = { clumping: 2, dust: 1, crumble: 1 };

export function feelFor(voxel: VoxelId): MaterialFeel {
  return FEEL[voxel] ?? DEFAULT_FEEL;
}

/**
 * Stable per-voxel seed. Mixing the material in means the same cell fractures
 * differently once it is a different soil, which matters where strata meet.
 */
export function hashVoxel(x: number, y: number, z: number, material = 0): number {
  let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)
    ^ Math.imul(z | 0, 83492791) ^ Math.imul(material | 0, 2971215073);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — small, fast, and good enough for shape noise. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FracturePattern {
  seed: number;
  voxel: VoxelId;
  feel: MaterialFeel;
  /** Crumb indices in the order they break away. */
  order: Int32Array;
  /** Reverse of `order`: where each crumb sits in the queue. */
  rank: Int32Array;
  /** Progress at which order[i] disappears. Ascending, so removal is monotonic. */
  thresholds: Float32Array;
  /** Per-crumb drift and shrink: 4 floats each (dx, dy, dz, shrink). */
  jitter: Float32Array;
  /**
   * Per-crumb tilt, 3 floats each. Scaled by erosion, so it is exactly zero on
   * an untouched voxel and the crumbs tile back into a perfect cube. Without
   * it the cluster reads as a cube sliced on clean planes rather than as
   * broken soil — this is the single thing that makes it look crumbly.
   */
  spin: Float32Array;
  /** Where the first blow landed — the centre of the crater. */
  strike: Vec3;
  /** Axis the loosened soil rocks about once it is nearly free. */
  wobbleAxis: Vec3;
  wobblePhase: number;
}

export function cellCentre(cell: number): Vec3 {
  const cx = cell % CHIP_CELLS;
  const cy = Math.floor(cell / CHIP_CELLS) % CHIP_CELLS;
  const cz = Math.floor(cell / (CHIP_CELLS * CHIP_CELLS));
  const s = 1 / CHIP_CELLS;
  return { x: (cx + 0.5) * s, y: (cy + 0.5) * s, z: (cz + 0.5) * s };
}

/**
 * Build the fracture for one voxel.
 *
 * Crumbs are ranked by distance to two seeded attack points plus noise, so
 * damage eats outward from one or two irregular regions instead of dissolving
 * evenly or hollowing from the middle. Attack points are pulled toward the
 * surface, because soil gives way at an exposed face first.
 */
export function buildFracture(
  x: number,
  y: number,
  z: number,
  voxel: VoxelId,
  /** Outward normal of the face being worked, so the crater faces the ant. */
  face?: Vec3 | null,
): FracturePattern {
  const seed = hashVoxel(x, y, z, voxel);
  const rand = rng(seed);
  const feel = feelFor(voxel);

  /*
   * ONE strike point, at the centre of one seeded face.
   *
   * Crumbs then break in order of distance from it, so the damage is a crater
   * that opens in the middle of a face and grows outward in a rough circle,
   * deepening as it widens — a pickaxe biting the same spot repeatedly.
   *
   * Two scattered attack points read as the cube rotting in patches. Putting
   * the point in the middle of the VOLUME is worse still: the voxel hollows
   * from the inside while the shell stays intact, so nothing visible happens
   * until it suddenly caves.
   */
  const strike: Vec3 = { x: 0.5, y: 0.5, z: 0.5 };
  if (face && (face.x !== 0 || face.y !== 0 || face.z !== 0)) {
    // The face she is actually working. Seeding this meant the crater opened on
    // a different side every dig — front, then the side, then round the back
    // where you could not see it at all.
    const ax = Math.abs(face.x); const ay = Math.abs(face.y); const az = Math.abs(face.z);
    if (ax >= ay && ax >= az) strike.x = face.x > 0 ? 1 : 0;
    else if (ay >= az) strike.y = face.y > 0 ? 1 : 0;
    else strike.z = face.z > 0 ? 1 : 0;
  } else {
    // Total for callers with no approach to give: tests, and any future
    // digging that happens off-screen.
    const axis = Math.floor(rand() * 3);
    const positive = rand() < 0.5;
    if (axis === 0) strike.x = positive ? 1 : 0;
    else if (axis === 1) strike.y = positive ? 1 : 0;
    else strike.z = positive ? 1 : 0;
  }

  const scores = new Float64Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const c = cellCentre(cell);
    const d = Math.hypot(c.x - strike.x, c.y - strike.y, c.z - strike.z);
    /*
     * Noise deliberately SMALL against the distances it perturbs. Large noise
     * swamps the distance term and crumbs come off all over the cube in what
     * looks like random order; this is just enough to keep the rim of the
     * crater ragged rather than a machined circle.
     */
    scores[cell] = d + (rand() - 0.5) * 0.12;
  }

  const order = Int32Array.from(
    Array.from({ length: CELL_COUNT }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!),
  );
  const rank = new Int32Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) rank[order[i]!] = i;

  /*
   * Thresholds. Evenly spaced across the breaking window, then nudged and
   * re-sorted so no two voxels chip on the same beat. Clumping snaps groups of
   * crumbs onto a shared threshold, which is what makes clay come away in
   * slabs and sand trickle.
   */
  const span = LAST_BREAK - FIRST_BREAK;
  const raw = new Float32Array(MAX_REMOVED);
  for (let i = 0; i < MAX_REMOVED; i++) {
    const base = FIRST_BREAK + (span * (i + 0.5)) / MAX_REMOVED;
    raw[i] = base + (rand() - 0.5) * (span / MAX_REMOVED) * 1.6;
  }
  raw.sort();
  const thresholds = new Float32Array(MAX_REMOVED);
  const group = Math.max(1, Math.round(feel.clumping));
  for (let i = 0; i < MAX_REMOVED; i++) {
    // Snap to the head of each group so clumped crumbs let go together.
    thresholds[i] = raw[Math.floor(i / group) * group]!;
  }

  const jitter = new Float32Array(CELL_COUNT * 4);
  const spin = new Float32Array(CELL_COUNT * 3);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    jitter[cell * 4 + 0] = rand() - 0.5;
    jitter[cell * 4 + 1] = rand() - 0.5;
    jitter[cell * 4 + 2] = rand() - 0.5;
    jitter[cell * 4 + 3] = rand();
    spin[cell * 3 + 0] = rand() - 0.5;
    spin[cell * 3 + 1] = rand() - 0.5;
    spin[cell * 3 + 2] = rand() - 0.5;
  }

  const wa = { x: rand() - 0.5, y: rand() - 0.5, z: rand() - 0.5 };
  const len = Math.hypot(wa.x, wa.y, wa.z) || 1;

  return {
    seed,
    voxel,
    feel,
    order,
    rank,
    thresholds,
    jitter,
    spin,
    strike,
    wobbleAxis: { x: wa.x / len, y: wa.y / len, z: wa.z / len },
    wobblePhase: rand() * Math.PI * 2,
  };
}

/** How many crumbs have broken away at this progress. Never decreases. */
export function removedAt(pattern: FracturePattern, progress: number): number {
  if (progress <= 0) return 0;
  let n = 0;
  while (n < MAX_REMOVED && pattern.thresholds[n]! <= progress) n++;
  return n;
}

/** Whether a given crumb is still there. */
export function cellSurvives(pattern: FracturePattern, cell: number, progress: number): boolean {
  const removed = removedAt(pattern, progress);
  for (let i = 0; i < removed; i++) if (pattern.order[i] === cell) return false;
  return true;
}

/**
 * Shrink and drift of the surviving crumbs.
 *
 * Exactly 0 at rest so an untouched voxel is a perfect cube; jumps to
 * EROSION_MIN as soon as work starts, which both reads as the surface being
 * scratched up and keeps the newly separate internal faces out of z-fight
 * range.
 */
export function erosionFor(pattern: FracturePattern, cell: number, progress: number): number {
  if (progress <= 0) return 0;
  const rank = pattern.rank[cell]!;
  // The crumb that never breaks has no moment of its own; peg it to the last
  // one so the final remnant still looks worked rather than factory-fresh.
  const due = pattern.thresholds[Math.min(rank, MAX_REMOVED - 1)]!;
  const t = (progress - (due - EROSION_LEAD)) / EROSION_LEAD;
  if (t <= 0) return 0;
  return Math.min(1, t) * EROSION_MAX * pattern.feel.crumble;
}

/** The worst erosion anywhere on the voxel — how chewed it looks overall. */
export function erosionAt(pattern: FracturePattern, progress: number): number {
  let worst = 0;
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    worst = Math.max(worst, erosionFor(pattern, cell, progress));
  }
  return worst;
}

/**
 * Events between two progress readings, for particles and audio.
 *
 * Driven off crumbs actually breaking rather than off a frame timer, so sound
 * and dust land on the visible chips instead of hissing continuously.
 */
export function eventsBetween(
  pattern: FracturePattern,
  from: number,
  to: number,
): DigEvent[] {
  const events: DigEvent[] = [];
  if (to <= from) return events;

  const before = removedAt(pattern, from);
  const after = removedAt(pattern, to);
  if (after > before) {
    // Everything that went at once shares one event, so a clay slab is one
    // heavy sound rather than three overlapping small ones.
    const crumbs = after - before;
    const at = cellCentre(pattern.order[after - 1]!);
    events.push({ kind: crumbs >= 2 ? 'DIG_CHIP_LARGE' : 'DIG_CHIP_SMALL', at, crumbs });
  }

  // One creak as the remaining soil goes slack, and the release at the end.
  if (from < WOBBLE_FROM && to >= WOBBLE_FROM) {
    events.push({ kind: 'DIG_CRACK', at: { x: 0.5, y: 0.5, z: 0.5 }, crumbs: 0 });
  }
  if (from < 1 && to >= 1) {
    events.push({ kind: 'DIG_RELEASE', at: { x: 0.5, y: 0.5, z: 0.5 }, crumbs: 0 });
  }
  return events;
}

/** Loosened rocking near the end. Small on purpose — a creak, not a cartoon shake. */
export function wobbleAt(pattern: FracturePattern, progress: number, seconds: number): number {
  if (progress < WOBBLE_FROM) return 0;
  const ramp = Math.min(1, (progress - WOBBLE_FROM) / (1 - WOBBLE_FROM));
  return Math.sin(seconds * 11 + pattern.wobblePhase) * 0.02 * ramp;
}

/**
 * Geometry for the crumbs still standing, in the chunk mesher's exact vertex
 * format so it can share the world's material and texture array.
 *
 * Faces between two surviving crumbs are culled only while erosion is zero —
 * that is the one moment they are coincident. Once the crumbs separate, every
 * face is emitted so the crevices between them are properly solid rather than
 * see-through. Worst case is 27 crumbs x 6 faces = 162 quads.
 */
export function chipMeshData(
  pattern: FracturePattern,
  x: number,
  y: number,
  z: number,
  progress: number,
): MeshData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const tangents: number[] = [];
  const indices: number[] = [];
  let quadCount = 0;

  const removed = removedAt(pattern, progress);
  const gone = new Set<number>();
  for (let i = 0; i < removed; i++) gone.add(pattern.order[i]!);

  // Per-crumb erosion, computed once. A crumb with none is still fused to its
  // neighbours and contributes no interior faces at all.
  const erosionOf = new Float32Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    erosionOf[cell] = erosionFor(pattern, cell, progress);
  }
  const size = 1 / CHIP_CELLS;
  const round = progress <= ROUND_FROM
    ? 0
    : ((progress - ROUND_FROM) / (1 - ROUND_FROM)) * ROUND_MAX;

  for (let cell = 0; cell < CELL_COUNT; cell++) {
    if (gone.has(cell)) continue;

    const cx = cell % CHIP_CELLS;
    const cy = Math.floor(cell / CHIP_CELLS) % CHIP_CELLS;
    const cz = Math.floor(cell / (CHIP_CELLS * CHIP_CELLS));

    const erosion = erosionOf[cell]!;
    const jx = pattern.jitter[cell * 4 + 0]!;
    const jy = pattern.jitter[cell * 4 + 1]!;
    const jz = pattern.jitter[cell * 4 + 2]!;
    const js = pattern.jitter[cell * 4 + 3]!;

    // Shrink toward the crumb's own centre, then drift a little. Both scale
    // with erosion, so at rest this is exactly the original lattice.
    // Rotation about each axis, scaled by erosion so an intact voxel is exactly
    // the original lattice. Small-angle sin/cos, applied as three shears.
    const ax = pattern.spin[cell * 3 + 0]! * erosion * MAX_TILT;
    const ay = pattern.spin[cell * 3 + 1]! * erosion * MAX_TILT;
    const az = pattern.spin[cell * 3 + 2]! * erosion * MAX_TILT;
    const spinVec = (vx: number, vy: number, vz: number): [number, number, number] => {
      let a = vx; let b = vy; let c = vz;
      let s = Math.sin(ax); let k = Math.cos(ax);
      [b, c] = [b * k - c * s, b * s + c * k];
      s = Math.sin(ay); k = Math.cos(ay);
      [a, c] = [a * k + c * s, -a * s + c * k];
      s = Math.sin(az); k = Math.cos(az);
      [a, b] = [a * k - b * s, a * s + b * k];
      return [a, b, c];
    };

    /*
     * Barely shrink. This was `0.35 + 0.55 * js`, which halved an eroding crumb
     * — and with ~20 eroding at once that is a band of half-size crumbs with
     * gaps between them, so within a couple of seconds you could see straight
     * through the cube to the far side. The block appeared to dissolve rather
     * than to lose pieces.
     *
     * Shrink now does exactly one job: keep the newly exposed interior faces
     * out of z-fight range. At a 0.2 cell that is a ~26 micron gap, invisible
     * as a hole but decisive for the depth buffer. Removal is what you see.
     */
    const shrink = 1 - erosion * (0.1 + 0.14 * js);
    const half = (size * shrink) / 2;
    const drift = erosion * size * 0.22;
    let midX = (cx + 0.5) * size + jx * drift;
    let midY = (cy + 0.5) * size + jy * drift;
    let midZ = (cz + 0.5) * size + jz * drift;

    // Chisel the remnant toward the clod: pull each surviving crumb in from the
    // corners toward a ball, so the block rounds off as it is worked rather
    // than staying a stub that pops into a lump at the end.
    if (round > 0) {
      const ox = midX - 0.5;
      const oy = midY - 0.5;
      const oz = midZ - 0.5;
      const d = Math.hypot(ox, oy, oz);
      if (d > 1e-6) {
        // 0.5 is the cube's half-width; a sphere of that radius is the target.
        const k = (0.5 / d) * round + (1 - round);
        midX = 0.5 + ox * k;
        midY = 0.5 + oy * k;
        midZ = 0.5 + oz * k;
      }
    }

    // Crumb-level brightness variation, so the cluster reads as loose grain
    // rather than one carved block.
    const tint = voxelTint(x * CHIP_CELLS + cx, y * CHIP_CELLS + cy, z * CHIP_CELLS + cz);

    /*
     * Cheap ambient occlusion: a crumb still walled in by its neighbours sits
     * deeper in shadow than one left standing on its own. Without this the
     * cluster renders brighter than the pit around it — the terrain mesher
     * applies real AO and the crumbs were getting none, so freshly broken soil
     * looked lit from nowhere.
     */
    let buried = 0;
    for (const face of FACES) {
      const ax = cx + face.normal[0];
      const ay = cy + face.normal[1];
      const az = cz + face.normal[2];
      const inside = ax >= 0 && ax < CHIP_CELLS && ay >= 0 && ay < CHIP_CELLS
        && az >= 0 && az < CHIP_CELLS;
      if (!inside) continue;
      if (!gone.has(ax + ay * CHIP_CELLS + az * CHIP_CELLS * CHIP_CELLS)) buried++;
    }
    const occlusion = 1 - (buried / FACES.length) * 0.55;

    for (const face of FACES) {
      const [nx, ny, nz] = face.normal;
      /*
       * Fuse with an untouched neighbour.
       *
       * Two crumbs that have BOTH eroded nothing are still perfectly tiled, so
       * the face between them is coincident and must be culled — that is what
       * keeps the undamaged part of the voxel reading as one solid mass rather
       * than as a stack of blocks. As soon as either one starts to loosen they
       * have separated, and the face has to be drawn or you would see into a
       * hollow shell.
       */
      const ax = cx + nx;
      const ay = cy + ny;
      const az = cz + nz;
      const inside = ax >= 0 && ax < CHIP_CELLS && ay >= 0 && ay < CHIP_CELLS
        && az >= 0 && az < CHIP_CELLS;
      if (inside) {
        const neighbour = ax + ay * CHIP_CELLS + az * CHIP_CELLS * CHIP_CELLS;
        if (!gone.has(neighbour) && erosion <= 0 && erosionOf[neighbour]! <= 0) continue;
      }

      const [axisA, axisB] = tangentAxes(face.normal);
      const first = positions.length / 3;
      const tangent: [number, number, number] = [0, 0, 0];
      tangent[axisA] = 1;

      // Tilt the whole crumb. Small angles, but enough that no two faces of
      // neighbouring crumbs stay parallel — which is what stops the cluster
      // reading as a cube cut on clean planes.
      const rn = spinVec(nx, ny, nz);
      for (const corner of face.corners) {
        const local = spinVec(
          (corner[0] * 2 - 1) * half,
          (corner[1] * 2 - 1) * half,
          (corner[2] * 2 - 1) * half,
        );
        const wx = x + midX + local[0];
        const wy = y + midY + local[1];
        const wz = z + midZ + local[2];
        positions.push(wx, wy, wz);
        normals.push(rn[0], rn[1], rn[2]);
        layers.push(pattern.voxel);
        tangents.push(tangent[0], tangent[1], tangent[2]);
        const world = [wx, wy, wz] as const;
        uvs.push(world[axisA]! / TILE_VOXELS, world[axisB]! / TILE_VOXELS);
        // Downward faces are darker, the way the terrain mesher's AO already
        // makes pit floors read. Combined with the burial term this gives the
        // cluster real depth for the cost of two multiplies.
        const facing = ny > 0.5 ? 1 : ny < -0.5 ? 0.55 : 0.78;
        const lit = 0.92 * tint * occlusion * facing;
        colors.push(lit, lit, lit);
      }

      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      quadCount++;
    }
  }

  if (quadCount === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    layers: new Float32Array(layers),
    tangents: new Float32Array(tangents),
    indices: new Uint32Array(indices),
    quadCount,
  };
}
