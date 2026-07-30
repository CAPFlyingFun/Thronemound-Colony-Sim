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
 * Pieces per axis. ONE — a cell is not subdivided at all any more.
 *
 * It was five (a crater eaten outward from a strike point), then four (64
 * pieces peeled off as four sheets of sixteen, a sheet per press). Both were
 * ways of making one voxel feel like more than one thing, and both had the same
 * tell: it read as one large cube breaking apart, because that is exactly what
 * it was. The sub-pieces were a PRESENTATION of a single authoritative unit
 * rather than units in their own right, which is also where every
 * soil-accounting bug came from — a voxel could be solid in the world and have
 * already issued pieces to the player, and reconciling those two views is what
 * `releaseActive`, `onSheetFreed` and the sheet bookkeeping all existed to do.
 *
 * So the cell IS the unit. One press takes one cell, the whole cell becomes one
 * pellet, and the sense of progress comes from watching it crack and shift in
 * place rather than from counting quarters off it. Nothing subdivides, so
 * nothing can disagree about how much soil exists.
 */
export const CHIP_CELLS = 1;
export const CELL_COUNT = CHIP_CELLS * CHIP_CELLS * CHIP_CELLS;
/** Pieces a whole voxel is worth. Soil conservation counts in these. */
export const PIECES_PER_VOXEL = CELL_COUNT;

/** Every piece comes away now — nothing is left standing to become a clod. */
export const MAX_REMOVED = CELL_COUNT;


/**
 * How far ahead of its own turn a piece starts to loosen — the whole dig.
 *
 * With one cell per press the cell is visibly cracking and shifting from the
 * first moment she strikes it until it lets go, and that IS the progress
 * readout now. Anything less leaves a dead stretch at the start where the dig
 * reads as not having begun.
 */
const EROSION_LEAD = 1;

/**
 * How long the cell takes to let go, as a fraction of the whole dig.
 *
 * Divided by the material's clumping, so clay lets go as a slab and sand
 * crumbles a fraction earlier.
 */
const LAYER_STAGGER = 0.05;
export const EROSION_MAX = 0.55;
/**
 * How far a cell shrinks by the time it lets go: a tenth, so it still reads as
 * the same block of soil that was there when she started.
 *
 * Normalised BY EROSION_MAX so the two cannot drift. Written as an absolute
 * fraction it silently meant whatever erosion happened to peak at — 13% at the
 * time, and any retune of the erosion curve moved it again.
 */
export const MAX_SHRINK = 0.10;
/**
 * How sharply the shrink lags the cracks.
 *
 * Squared, so early on the block barely moves while the cracks spread across
 * it, and it only starts visibly giving once they are established. Linear
 * shrink starts the moment the dig does, which is what put the deflation
 * BEFORE the splitting.
 */
const SHRINK_LAG = 2;

/** How far a fully eroded crumb can tilt, in radians. */
const MAX_TILT = 0.42;

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
  /** Where the first blow landed — the face she is working. */
  strike: Vec3;
  /** Which axis the layers stack along, and which end she is working from. */
  strikeAxis: 0 | 1 | 2;
  strikeSign: 1 | -1;
  /** Layer each piece belongs to: 0 is the one under her mandibles. */
  layer: Int32Array;
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
 * Pieces come away in LAYERS, nearest face first, sixteen at a time. Ranking
 * by distance from a strike point — the old crater — is wrong for this: it
 * takes bites out of the middle of a face and leaves a rim, when what an ant
 * actually does is shave the surface off in sheets. Layers also make the dig
 * legible, because each quarter of the bar is one visible sheet coming away,
 * and each sheet is exactly one scoop.
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

  // Which axis the layers stack along, and from which end.
  const strikeAxis: 0 | 1 | 2 = strike.x !== 0.5 ? 0 : strike.y !== 0.5 ? 1 : 2;
  const strikeSign: 1 | -1 = (
    strikeAxis === 0 ? strike.x : strikeAxis === 1 ? strike.y : strike.z
  ) > 0.5 ? 1 : -1;

  /*
   * Layer index per piece: 0 is the sheet against the face she is working.
   * Digging down, layer 0 is the top — which is also the one gravity would let
   * go of first, so the visible order and the physical order agree.
   */
  const layer = new Int32Array(CELL_COUNT);
  const noise = new Float64Array(CELL_COUNT);
  for (let cell = 0; cell < CELL_COUNT; cell++) {
    const cx = cell % CHIP_CELLS;
    const cy = Math.floor(cell / CHIP_CELLS) % CHIP_CELLS;
    const cz = Math.floor(cell / (CHIP_CELLS * CHIP_CELLS));
    const along = strikeAxis === 0 ? cx : strikeAxis === 1 ? cy : cz;
    layer[cell] = strikeSign > 0 ? CHIP_CELLS - 1 - along : along;
    noise[cell] = rand();
  }

  /*
   * Ordered by layer, then shuffled WITHIN the layer. Sorting the whole cube by
   * one score would let a piece from the second sheet come away before the
   * first has finished, which reads as the block rotting rather than as being
   * shaved. Inside a sheet the order is free, and randomising it is what stops
   * sixteen pieces letting go in a readable raster.
   */
  const order = Int32Array.from(
    Array.from({ length: CELL_COUNT }, (_, i) => i)
      .sort((a, b) => (layer[a]! - layer[b]!) || (noise[a]! - noise[b]!)),
  );
  const rank = new Int32Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) rank[order[i]!] = i;

  const thresholds = new Float32Array(CELL_COUNT);
  /*
   * One cell, due at the end of the dig.
   *
   * This was a per-sheet table with an ordering rule and an off-by-a-sheet bug
   * worth remembering: the thresholds were once squeezed into a [0.06, 0.99]
   * window, which put every sheet's soil a quarter of a cube late, so pressing
   * dig, watching a sheet finish and cancelling produced no soil at all. There
   * is nothing left to get out of order — the cell is due when the dig is done.
   */
  const stagger = LAYER_STAGGER / Math.max(1, feel.clumping);
  for (let i = 0; i < CELL_COUNT; i++) thresholds[i] = 1 - stagger;

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


  return {
    seed,
    voxel,
    feel,
    order,
    rank,
    thresholds,
    layer,
    strikeAxis,
    strikeSign,
    jitter,
    spin,
    strike,
  };
}

/** How many crumbs have broken away at this progress. Never decreases. */
export function removedAt(pattern: FracturePattern, progress: number): number {
  if (progress <= 0) return 0;
  let n = 0;
  while (n < CELL_COUNT && pattern.thresholds[n]! <= progress) n++;
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
  const due = pattern.thresholds[Math.min(rank, CELL_COUNT - 1)]!;
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

  /*
   * Every crack that opens sheds a little soil.
   *
   * Without this the dig is silent until the cell lets go: one cell means one
   * removal event, so the whole 64-piece trickle of chip events went with the
   * sheets. A crack appearing is the only thing actually HAPPENING during a
   * press, so it is the thing worth a puff of dust — and it puts the dust where
   * the damage is rather than in a generic cloud around the block.
   */
  for (let fi = 0; fi < FACES.length; fi++) {
    for (const seg of crackSegments(pattern, fi)) {
      if (seg.at <= from || seg.at > to) continue;
      events.push({
        kind: 'DIG_CHIP_SMALL',
        at: crackPoint(fi, (seg.ax + seg.bx) / 2, (seg.ay + seg.by) / 2),
        crumbs: 1,
      });
    }
  }

  if (from < 1 && to >= 1) {
    events.push({ kind: 'DIG_RELEASE', at: { x: 0.5, y: 0.5, z: 0.5 }, crumbs: 0 });
  }
  return events;
}

/**
 * Cracks spreading across the face she is working.
 *
 * With one cell per press there is nothing left to SUBTRACT during a dig — the
 * cell is whole until it is gone — so the progress a player reads has to come
 * from the surface itself. Branches run out from the strike point and lengthen
 * as she works, which is what packed soil actually does under a mandible, and
 * it costs no soil-accounting at all because a crack is pure decoration.
 *
 * Deterministic from the pattern's own seed, like everything else here: the
 * same cell cracks the same way across a cancel, a reload or a save.
 */
export const CRACK_BRANCHES = 7;
export const CRACK_JOINTS = 4;
/**
 * Progress before the first crack shows. Almost nothing.
 *
 * It was 0.12, which at twelve seconds a cell is a second and a half of the
 * block visibly SHRINKING before anything cracked — the wrong way round, and it
 * read as the soil deflating and then splitting rather than splitting and then
 * giving. Cracks lead now; the shrink follows them (see MAX_SHRINK).
 */
export const CRACK_START = 0.02;
/** How far the crack sits proud of the face, so it does not z-fight with it. */
export const CRACK_LIFT = 0.006;
/**
 * Half-width of a crack at its root, in face-local units where the face spans
 * -1..1. At 0.05 these came out as fat dark bars painted across the cell rather
 * than as soil splitting — the width has to read as a LINE at the distance an
 * ant works from, which is about a body length off the face.
 */
export const CRACK_WIDTH = 0.014;

export interface CrackSegment {
  /** Face-local, -1..1 across the struck face. */
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Progress at which this segment has finished appearing. */
  at: number;
  /** Half-width, in the same face-local units. */
  width: number;
}

/** A point on a face, from face-local -1..1 to voxel-local 0..1. */
export function crackPoint(face: number, u: number, v: number): Vec3 {
  const fn = FACES[face]!.normal;
  const axis = fn[0] !== 0 ? 0 : fn[1] !== 0 ? 1 : 2;
  const [ca, cb] = tangentAxes(fn);
  const p: [number, number, number] = [0, 0, 0];
  p[axis] = fn[axis]! > 0 ? 1 : 0;
  const clamp = (n: number) => Math.max(0, Math.min(1, (n + 1) / 2));
  p[ca] = clamp(u);
  p[cb] = clamp(v);
  return { x: p[0], y: p[1], z: p[2] };
}

export function crackSegments(pattern: FracturePattern, face = -1): CrackSegment[] {
  /*
   * Every face cracks, not just the one she struck.
   *
   * A cell is a free-standing lump the moment there is air around it, so it is
   * seen from every side — cracking only the struck face means walking round it
   * shows a pristine block, and which side is pristine depends on where she
   * happened to hit it. Each face gets its own seed, so no two match and the
   * lump does not read as one pattern stamped six times.
   */
  const struck = face < 0 || (
    FACES[face]!.normal[pattern.strikeAxis] === pattern.strikeSign
  );
  const rand = rng(pattern.seed ^ 0x9e3779b9 ^ Math.imul(face + 2, 0x85ebca6b));
  const axes: [number, number, number] = [0, 0, 0];
  if (face < 0) axes[pattern.strikeAxis] = pattern.strikeSign;
  else { axes[0] = FACES[face]!.normal[0]; axes[1] = FACES[face]!.normal[1]; axes[2] = FACES[face]!.normal[2]; }
  const [axisA, axisB] = tangentAxes([axes[0]!, axes[1]!, axes[2]!]);
  const strike = [pattern.strike.x, pattern.strike.y, pattern.strike.z];

  /*
   * Where the branches start, in face-local -1..1.
   *
   * On the face she is actually working that is the blow itself, so the damage
   * reads as radiating from one point. On the others there is no blow to
   * radiate from, so it is a seeded point somewhere near the middle — cracks
   * carrying THROUGH the lump rather than a copy of the front.
   */
  const su = struck ? strike[axisA]! * 2 - 1 : (rand() - 0.5) * 1.1;
  const sv = struck ? strike[axisB]! * 2 - 1 : (rand() - 0.5) * 1.1;
  // Fewer, later cracks away from the blow: the far side gives last.
  const branches = struck ? CRACK_BRANCHES : CRACK_BRANCHES - 3;
  const delay = struck ? 0 : 0.18;

  const segments: CrackSegment[] = [];
  const span = 0.86 - CRACK_START - delay;
  for (let b = 0; b < branches; b++) {
    let angle = (b / branches) * Math.PI * 2 + rand() * 0.9;
    const reach = 0.35 + rand() * 0.5;
    let px = su;
    let py = sv;
    // Branches stagger their start, so they do not all appear on one frame.
    const opens = CRACK_START + delay + (b / branches) * 0.08;
    for (let j = 0; j < CRACK_JOINTS; j++) {
      // Wander, so a crack forks and kinks the way a real one does instead of
      // running dead straight out from the middle.
      angle += (rand() - 0.5) * 0.9;
      const step = (reach / CRACK_JOINTS) * (1 - j * 0.15);
      const nx = px + Math.cos(angle) * step;
      const ny = py + Math.sin(angle) * step;
      segments.push({
        ax: px,
        ay: py,
        bx: nx,
        by: ny,
        /*
         * Squared, so the FIRST joint lands almost at once and later ones
         * spread out.
         *
         * Spacing them evenly meant the earliest visible crack was a quarter of
         * the span in — about three seconds at twelve seconds a cell — which is
         * what made the block appear to shrink before it cracked even after
         * CRACK_START was pulled back to nothing. It is also how fracture
         * actually goes: the split is sudden, the spread is slow.
         */
        at: opens + (((j + 1) / CRACK_JOINTS) ** 2) * span,
        // Tapers along its length: widest at the blow, hairline at the tip.
        width: CRACK_WIDTH * (1 - (j / CRACK_JOINTS) * 0.65),
      });
      px = nx;
      py = ny;
    }
  }
  return segments;
}

/**
 * The pieces that came away between two progress readings.
 *
 * The whole point of the change: a piece that leaves the lattice is not
 * deleted, it is handed to the scene to become a real lump of soil at the
 * position it was sitting in. Returns cell indices, in the order they broke.
 */
export function releasedBetween(
  pattern: FracturePattern,
  from: number,
  to: number,
): number[] {
  const first = removedAt(pattern, from);
  const last = removedAt(pattern, to);
  const cells: number[] = [];
  for (let i = first; i < last; i++) cells.push(pattern.order[i]!);
  return cells;
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
    const shrink = 1 - ((erosion / EROSION_MAX) ** SHRINK_LAG) * MAX_SHRINK * (0.85 + 0.3 * js);
    const half = (size * shrink) / 2;
    const drift = erosion * size * 0.22;
    const midX = (cx + 0.5) * size + jx * drift;
    const midY = (cy + 0.5) * size + jy * drift;
    const midZ = (cz + 0.5) * size + jz * drift;


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

    /*
     * Cracks, on every face of the lump.
     *
     * Emitted in the SAME buffers and through the same spin as the cell itself,
     * so they stay glued to it as it rocks — built separately they would slide
     * across a surface that is tilting underneath them. They are dark vertex
     * colour on the ordinary soil material rather than a texture or a second
     * mesh, because the material already multiplies vertex colour over the
     * albedo, so a crack costs one quad and no new state.
     */
    for (let fi = 0; fi < FACES.length; fi++) {
      const fn = FACES[fi]!.normal;
      const faceAxis = fn[0] !== 0 ? 0 : fn[1] !== 0 ? 1 : 2;
      const faceSign = fn[faceAxis]!;
      const [ca, cb] = tangentAxes(fn);
      const crackNormal = spinVec(fn[0], fn[1], fn[2]);
      const crackTangent: [number, number, number] = [0, 0, 0];
      crackTangent[ca] = 1;
      for (const seg of crackSegments(pattern, fi)) {
        if (progress < seg.at - 0.0001) continue;
        const dx = seg.bx - seg.ax;
        const dy = seg.by - seg.ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const px = (-dy / len) * seg.width;
        const py = (dx / len) * seg.width;
        const quad: [number, number][] = [
          [seg.ax + px, seg.ay + py],
          [seg.bx + px, seg.by + py],
          [seg.bx - px, seg.by - py],
          [seg.ax - px, seg.ay - py],
        ];
        const base = positions.length / 3;
        const world3: [number, number, number][] = [];
        for (const [u, v] of quad) {
          const l: [number, number, number] = [0, 0, 0];
          l[faceAxis] = faceSign * (half + CRACK_LIFT);
          l[ca] = u * half;
          l[cb] = v * half;
          const rot = spinVec(l[0]!, l[1]!, l[2]!);
          const wx = x + midX + rot[0];
          const wy = y + midY + rot[1];
          const wz = z + midZ + rot[2];
          world3.push([wx, wy, wz]);
          positions.push(wx, wy, wz);
          normals.push(crackNormal[0], crackNormal[1], crackNormal[2]);
          layers.push(pattern.voxel);
          tangents.push(crackTangent[0], crackTangent[1], crackTangent[2]);
          const w = [wx, wy, wz] as const;
          uvs.push(w[ca]! / TILE_VOXELS, w[cb]! / TILE_VOXELS);
          // Dark enough to read as an opening rather than a painted line, and
          // still tinted by the cell so it belongs to this lump of soil.
          const dark = 0.24 * tint;
          colors.push(dark, dark, dark);
        }
        /*
         * Wind it to face OUT, decided by the cross product rather than assumed.
         *
         * The face-local (u, v) basis is not consistently right-handed against
         * the face normal — on a top face the tangent axes are X and Z, and
         * cross(X, Z) is -Y — so a fixed index order leaves the crack facing
         * INTO the soil on half the faces and back-face culling eats it. Third
         * time that has bitten here, after the hex room's walls and the chamfer
         * bevels, so it is computed rather than assumed.
         */
        const e1 = [world3[1]![0] - world3[0]![0], world3[1]![1] - world3[0]![1],
          world3[1]![2] - world3[0]![2]];
        const e2 = [world3[2]![0] - world3[0]![0], world3[2]![1] - world3[0]![1],
          world3[2]![2] - world3[0]![2]];
        const facing = (e1[1]! * e2[2]! - e1[2]! * e2[1]!) * crackNormal[0]
          + (e1[2]! * e2[0]! - e1[0]! * e2[2]!) * crackNormal[1]
          + (e1[0]! * e2[1]! - e1[1]! * e2[0]!) * crackNormal[2];
        if (facing >= 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
        quadCount++;
      }
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
