/**
 * WHAT GROWS ON THE ISLAND, AND HOW OFTEN.
 *
 * The island is fifty-six metres square and 1,525 m² of it is above water.
 * A twenty-six metre tree carries a crown twelve metres across, so eight
 * hundred square metres of lowland has room for about six of them. That
 * single measurement decides the whole design: the giants CANNOT be the
 * forest. They are landmarks — you see one from across the island, you walk
 * to it, you climb it.
 *
 * The forest is the tiers underneath, and at an ant's scale it does not take
 * much to be one. She is nine millimetres long. A knee-high shrub is forty
 * times her height; a two-metre sapling is a redwood. So the thing that
 * makes the island feel wooded is not the giants at all, it is thousands of
 * waist-high plants she has to walk around.
 *
 *   landmark   18–30 m    ~10 on the island      one per ~150 m²
 *   canopy      5–11 m    ~130                   one per ~10 m²
 *   sapling   1.5–4 m     ~640                   one per ~2 m²
 *   bush      0.3–1.2 m   ~3,000                 one per ~0.5 m²
 *
 * Scatter is a JITTERED GRID rather than pure noise: one plant per cell,
 * thrown somewhere inside it. Pure random clumps and leaves bald patches,
 * which reads as a bug; a jittered grid gives the even-but-not-regular
 * spacing that competition for light actually produces, and it has the
 * property that matters here — the plant in a cell depends on nothing but
 * that cell, so any window of the island can be generated on its own,
 * repeatably, without generating the rest.
 */

/** A kind of plant, and the rules for where it grows. */
export interface Species {
  name: string;
  /** Height range, in millimetres. */
  minHeight: number;
  maxHeight: number;
  /** Trunk girth as a fraction of height. Small plants are proportionally
   *  stouter — a bush is not a scaled-down tree. */
  girthOfHeight: number;
  /** Grid pitch in millimetres: one plant per cell of this size. */
  spacing: number;
  /** How many cells actually carry one, 0..1 — thins a tier without
   *  changing its spacing, so the gaps stay irregular. */
  density: number;
  /** The elevation band it will grow in, in millimetres above sea level. */
  minElev: number;
  maxElev: number;
  /**
   * The steepest ground it will take, as the ground normal's Y.
   *
   * 1 is dead flat and 0 is a cliff, so this is a FLOOR: a plant needs at
   * least this much level under it. Big trees are fussier than scrub, which
   * is why cliffs read as bare rock with bushes in the cracks.
   */
  minFlat: number;
  /** Which detail level to bake the instanced form at. */
  detail: number;
  /** How many trunk sections and boughs its skeleton is built from. A bush
   *  given a twenty-six metre tree's skeleton is a thousand wasted
   *  triangles apiece — measured, and it was a million of them. */
  rings: number;
  boughs: number;
  twigs: boolean;
}

export const SPECIES: readonly Species[] = [
  {
    name: 'landmark',
    minHeight: 18000, maxHeight: 30000, girthOfHeight: 0.040,
    spacing: 12000, density: 0.55,
    minElev: 20, maxElev: 900, minFlat: 0.80,
    detail: 1, rings: 14, boughs: 9, twigs: false,
  },
  {
    name: 'canopy',
    minHeight: 5000, maxHeight: 11000, girthOfHeight: 0.055,
    spacing: 3600, density: 0.7,
    minElev: 8, maxElev: 1100, minFlat: 0.70,
    detail: 3, rings: 8, boughs: 7, twigs: false,
  },
  {
    name: 'sapling',
    minHeight: 1500, maxHeight: 4000, girthOfHeight: 0.075,
    spacing: 1800, density: 0.7,
    minElev: 4, maxElev: 1300, minFlat: 0.55,
    detail: 3, rings: 5, boughs: 6, twigs: false,
  },
  {
    name: 'bush',
    minHeight: 300, maxHeight: 1200, girthOfHeight: 0.16,
    spacing: 900, density: 0.8,
    minElev: 2, maxElev: 1450, minFlat: 0.35,
    detail: 3, rings: 3, boughs: 6, twigs: false,
  },
];

/** One plant, placed. Millimetres, except `spin` which is radians. */
export interface Plant {
  xMm: number;
  zMm: number;
  /** The ground's own height here — the caller sinks the plant into it. */
  groundMm: number;
  heightMm: number;
  girthMm: number;
  spin: number;
  /** Its own seed, so its shape is repeatable and unlike its neighbours'. */
  seed: number;
}

/** What the ground is doing at a point, for deciding whether to plant. */
export interface GroundProbe {
  /** Height in millimetres above sea level. */
  elevMm: number;
  /** The ground normal's Y: 1 level, 0 vertical. */
  flat: number;
}

/**
 * A hash of two grid coordinates and a salt, in 0..1.
 *
 * Every decision about a plant comes out of this and nothing else — no
 * running state, no order dependence — which is what lets a window of the
 * island be grown without growing its neighbours, and lets the same window
 * come back identical after a scroll.
 */
function hash(cx: number, cz: number, salt: number): number {
  let h = Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1)
    ^ Math.imul(salt | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Every plant of one species inside a box, in millimetres.
 *
 * `ground` may answer null for somewhere off the map; nothing is planted
 * there. It is called once per candidate cell, so a species with a small
 * spacing over a large box asks a lot of questions — the caller decides how
 * big a box is worth it, which is why the small tiers are windowed around
 * her and the big ones are not.
 */
export function plantsIn(
  species: Species,
  box: { x0: number; z0: number; x1: number; z1: number },
  ground: (xMm: number, zMm: number) => GroundProbe | null,
  salt = 0,
): Plant[] {
  const out: Plant[] = [];
  const c0x = Math.floor(box.x0 / species.spacing);
  const c1x = Math.floor(box.x1 / species.spacing);
  const c0z = Math.floor(box.z0 / species.spacing);
  const c1z = Math.floor(box.z1 / species.spacing);
  for (let cz = c0z; cz <= c1z; cz += 1) {
    for (let cx = c0x; cx <= c1x; cx += 1) {
      if (hash(cx, cz, salt + 11) > species.density) continue;
      /* Thrown inside its own cell, never onto the line — a jitter that can
       * reach the edge lets two neighbours meet and read as a pair. */
      const jx = 0.12 + 0.76 * hash(cx, cz, salt + 1);
      const jz = 0.12 + 0.76 * hash(cx, cz, salt + 2);
      const xMm = (cx + jx) * species.spacing;
      const zMm = (cz + jz) * species.spacing;
      if (xMm < box.x0 || xMm > box.x1 || zMm < box.z0 || zMm > box.z1) continue;
      const probe = ground(xMm, zMm);
      if (!probe) continue;
      if (probe.elevMm < species.minElev || probe.elevMm > species.maxElev) continue;
      if (probe.flat < species.minFlat) continue;
      const t = hash(cx, cz, salt + 3);
      /*
       * Squared, so most of a stand is on the short side of its range and
       * the tall ones are exceptions. A flat distribution gives a plantation
       * of near-identical trees, which is the look this is avoiding.
       */
      const heightMm = species.minHeight
        + (species.maxHeight - species.minHeight) * t * t;
      out.push({
        xMm,
        zMm,
        groundMm: probe.elevMm,
        heightMm,
        girthMm: heightMm * species.girthOfHeight,
        spin: hash(cx, cz, salt + 4) * Math.PI * 2,
        seed: Math.floor(hash(cx, cz, salt + 5) * 0xffffffff) >>> 0,
      });
    }
  }
  return out;
}

/**
 * How deep a plant's foot is buried, in millimetres.
 *
 * The island's drawn surface is a 109 mm mesh and the fine soil window
 * redraws the same ground at one millimetre as she gets close, so the two
 * disagree wherever the hill curves. A plant seated exactly on the coarse
 * surface stands in mid-air the moment the fine one resolves under it.
 * Scaled to the plant, because a bush buried a hundred millimetres is a
 * buried bush.
 */
export function burialMm(heightMm: number): number {
  return Math.max(30, Math.min(150, heightMm * 0.05));
}
