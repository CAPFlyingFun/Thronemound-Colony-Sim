/**
 * WHAT EACH CASTE DIGS — the one authoritative definition.
 *
 * Everything downstream reads this: the terrain carve, the debug preview, the
 * work-site planner, the dig jobs, the tests and the HUD readouts. The rule is
 * that a number appears HERE or nowhere, because the last version of this
 * scattered its dig geometry across three scene files and they drifted.
 *
 * ## Millimetres, deliberately
 *
 * The rest of the simulation works in world units where one unit is one 5 mm
 * voxel, and the density field works in 0.25 mm cells. Three unit systems have
 * already caused real bugs in this project, so the caste spec is written in the
 * unit the DESIGN is stated in — millimetres — and converted at the edges by
 * the callers that need something else. A number here can be checked against
 * the design document by reading it.
 *
 * ## The two anatomical references, and why there are two
 *
 * THORAX ORIGIN defines the PLANNED tunnel segment. It is where the bore's
 * centreline starts, so it is what gives a tunnel its diameter and its line.
 *
 * JAW defines what may ACTUALLY BE REMOVED right now. Soil never disappears
 * outside anatomical reach — she has to be able to touch it.
 *
 * These are not the same point and must not be conflated:
 *
 *     planned Queen bore, from the thorax centre
 *       thorax
 *          #===================================)
 *          <------------- 9 mm --------------->
 *
 *     what one bite may actually take
 *                jaws
 *                  v
 *          #=======C====)
 *
 * So the 9 mm is a work SEGMENT, realised over several bites as she advances
 * into it. The Queen's jaw sits 1.43 mm forward of her thorax centre, which
 * leaves 7.57 mm of planned segment beyond her mandibles — several bites and
 * at least one reposition, which is the visible behaviour this is for.
 *
 * ## Where the numbers came from
 *
 * The DIAMETERS and LENGTHS are design, given directly.
 *
 * The THORAX ORIGIN and JAW figures are MEASURED off the loaded rigs by
 * `scripts/probe-thorax.mjs`, and transcribed here as data on purpose: the dig
 * origin must be a stable declared number, not a skinned-vertex sweep run every
 * frame. Re-run that probe to check them.
 */

/** One world unit is one voxel is five millimetres. */
export const MM_PER_UNIT = 5;

export type Caste = 'queen' | 'worker' | 'major';

/** A point in her own frame, millimetres, +z forward and +y up. */
export interface BodyPointMm {
  x: number;
  y: number;
  z: number;
}

export interface CasteDigSpec {
  /** The bore's diameter, and so the tunnel's. */
  diameterMm: number;
  /** How far the planned segment runs FROM THE THORAX ORIGIN. */
  lengthMm: number;
  /**
   * Where the bore's centreline starts, in her own frame — the middle of the
   * thorax chain, not either of its ends.
   */
  thoraxOriginMm: BodyPointMm;
  /**
   * How far her jaw sits forward of that origin. The reach gate measures from
   * the live rig, not from this; the number is here so the planner can reason
   * about how much of a segment is beyond her mandibles before she starts.
   */
  jawForwardOfThoraxMm: number;
  /** And how far below it — her head hangs under the thorax midline. */
  jawBelowThoraxMm: number;
}

/**
 * WIDTH EQUALS HEIGHT for every caste, so the natural excavation is round and
 * a circular bore is exact rather than an approximation.
 *
 * NOMINAL, AND KEPT NOMINAL. Measured planted-stance widths are WIDER than
 * these tunnels — queen 7.22 mm against a 6.0 mm bore, worker 3.37 against
 * 3.0, major 4.62 against 4.0. That is deliberate and is not to be silently
 * "fixed" by enlarging the tunnels: a round bore is not a flat floor, and an
 * ant can brace her outer feet part way up a curved wall. Whether these sizes
 * are actually traversable is a MEASURED question for phases 2 and 3 —
 * standing, crawling, walking, turning, replanting — and if a nominal size
 * genuinely fails, the measured minimum gets reported rather than applied.
 */
export const CASTE_DIG: Readonly<Record<Caste, CasteDigSpec>> = {
  queen: {
    diameterMm: 6,
    lengthMm: 9,
    thoraxOriginMm: { x: 0.006, y: 2.308, z: 2.66 },
    jawForwardOfThoraxMm: 1.43,
    jawBelowThoraxMm: 0.93,
  },
  worker: {
    diameterMm: 3,
    lengthMm: 6,
    thoraxOriginMm: { x: -0.003, y: 1.197, z: 0.699 },
    jawForwardOfThoraxMm: 0.95,
    jawBelowThoraxMm: 0.42,
  },
  major: {
    diameterMm: 4,
    lengthMm: 7,
    thoraxOriginMm: { x: 0.004, y: 2.018, z: 0.235 },
    jawForwardOfThoraxMm: 2.0,
    jawBelowThoraxMm: 0.6,
  },
};

/** The bore's radius, which is the number the SDF actually wants. */
export function boreRadiusMm(caste: Caste): number {
  return CASTE_DIG[caste].diameterMm / 2;
}

/**
 * How much of a planned segment lies beyond her mandibles — so how much of it
 * she has to advance into rather than reach.
 *
 * Queen 7.57 mm, worker 5.05, major 5.00. A segment is therefore always
 * several bites and at least one reposition, never one instant removal.
 */
export function segmentBeyondJawMm(caste: Caste): number {
  const spec = CASTE_DIG[caste];
  return spec.lengthMm - spec.jawForwardOfThoraxMm;
}

/** Millimetres to world units, for callers working in voxels. */
export function toUnits(mm: number): number {
  return mm / MM_PER_UNIT;
}
