/**
 * THE STREAMED WORLD, as functions — the prototype for the hybrid
 * surface-plus-underground architecture. See docs/HYBRID_WORLD_PLAN.md.
 *
 * Three descriptions with three jobs, deliberately kept apart:
 *
 *   heightMmAt        what the landscape looks like (macro surface)
 *   baseDensityAt     what soil exists here (fine window fills from this)
 *   the nest plan     where the tunnels are (carved INTO baseDensityAt)
 *
 * The nest is folded into the BASE function rather than stored as edits, and
 * that is the load-bearing decision: a strip of soil streaming back into the
 * window re-evaluates the same pure function and gets the same tunnels,
 * sample for sample, with nothing saved anywhere but the plan itself. The
 * request's "BASE WORLD + DELTAS" is this line of code.
 *
 * Everything here is millimetre-first. World units (1 unit = 5 mm) appear
 * only at the edges where THREE and DensityField need them.
 */

import { MOUND_SPREAD, groundOf, type NestPlan } from '../nest/nestPlan';
import {
  moundOf, planBounds, planHollow, ventOf, type Bounds,
} from '../nest/nestCarve';
import type { Field } from '../voxel/carve';

/** Millimetres per world unit, project-wide. */
export const MM = 5;

/** The logical world: 4.096 m square. Streaming makes this cheap to raise. */
export const WORLD_MM = 4096;

/** How deep the diggable soil column is, everywhere. */
export const SOIL_DEPTH_MM = 256;

/**
 * The fine window's sample spacing. One millimetre: tunnels and chambers
 * read cleanly, the surface is smooth at ant height, and the resident window
 * stays inside the memory envelope the 256-cube proved on a phone. What it
 * gives up is bite texture — the lab room keeps its quarter-millimetre cells
 * for that. See the plan doc, question 2.
 */
export const CELL_MM = 1;
export const CELL_SIZE = CELL_MM / MM;

/**
 * The slide granularity. 32 mm rather than the conceptual 64: the resident
 * window is the same 192 mm either way, but each scroll regenerates half the
 * strip volume, so the hitch is half the size and twice as frequent — the
 * better trade for frame pacing, which the request values over throughput.
 */
export const TILE_MM = 32;
export const TILE_CELLS = TILE_MM / CELL_MM;
export const WINDOW_TILES = 6;
export const WINDOW_CELLS = TILE_CELLS * WINDOW_TILES;
export const WINDOW_MM = TILE_MM * WINDOW_TILES;
export const WORLD_TILES = WORLD_MM / TILE_MM;
export const CELLS_Y = SOIL_DEPTH_MM / CELL_MM;
export const SAMPLES_Y = CELLS_Y + 1;
export const SOIL_DEPTH = SOIL_DEPTH_MM / MM;
export const TILE_SIZE = TILE_MM / MM;
export const WORLD_SPAN = WORLD_MM / MM;

/** Two planes of self-cap at the window rim — the lab's proven pattern. */
export const CAP_PLANES = 2;

/** What the resident window costs in Float32 samples, for the HUD. */
export const WINDOW_BYTES =
  (WINDOW_CELLS + 1) ** 2 * SAMPLES_Y * Float32Array.BYTES_PER_ELEMENT;

/**
 * The landscape. Nominal ground sits at 208 mm of the 256 mm column, so the
 * deepest valleys keep ~170 mm of soil under them and the tallest hills stay
 * under the column's ceiling.
 *
 * Octave jobs, at fire-ant scale (a 9 mm animal):
 *   ~1500 mm   the hill you are on — a landmark, not an obstacle
 *   ~430 mm    rises and hollows you choose between
 *   ~140 mm    the roughness of a slope under one ant
 *   ~45 mm     grit — amplitude well above the mesher's weld limit,
 *              the lesson labWorld paid for at 0.25 mm cells
 *
 * X and Z frequencies differ per octave; equal ones make a separable product
 * that reads as a checkerboard from ant height.
 */
export function heightMmAt(xMm: number, zMm: number): number {
  return 208
    + 24 * Math.sin(xMm * 0.00405) * Math.cos(zMm * 0.00437)
    + 9 * Math.sin(xMm * 0.0146 + 1.7) * Math.cos(zMm * 0.0171 - 0.9)
    + 3 * Math.sin(xMm * 0.0447 - 0.4) * Math.cos(zMm * 0.0409 + 2.2)
    + 0.9 * Math.sin(xMm * 0.139 + 0.8) * Math.cos(zMm * 0.151 - 1.3);
}

/** How far soil is closed in from the world's outer faces, in world units. */
export const WORLD_MARGIN = CELL_SIZE * 1.5;

/**
 * THE NEST THE WORLD IS BORN WITH — the prototype's proof piece.
 *
 * Authored so the drift crosses several 32 mm tile lines (2048 → 2160 mm
 * crosses three) and the entrance opens through the surface via the same
 * mound-and-vent carving the block room ships. Later this comes from the
 * Nest Designer; the architecture does not care where the plan came from.
 */
export function worldPlan(): NestPlan {
  const ex = 2048;
  const ez = 2048;
  const ground = heightMmAt(ex, ez);
  return {
    nodes: [
      { id: 'gate', kind: 'entrance', x: ex, y: ground, z: ez, radiusMm: 8 },
      { id: 'hall', kind: 'junction', x: ex, y: ground - 56, z: ez, radiusMm: 4 },
      { id: 'bend', kind: 'junction', x: ex + 64, y: ground - 72, z: ez + 10, radiusMm: 4 },
      { id: 'store', kind: 'chamber', x: ex + 112, y: ground - 84, z: ez + 18, radiusMm: 10 },
    ],
    edges: [
      { id: 'shaft', from: 'gate', to: 'hall', radiusMm: 4, flow: 'both' },
      { id: 'drift', from: 'hall', to: 'bend', radiusMm: 4, flow: 'both' },
      { id: 'run', from: 'bend', to: 'store', radiusMm: 4, flow: 'both' },
    ],
  };
}

/* Built once: the plan's carve and mound as mm fields, plus a fast XZ reject
 * so the 99% of every streamed strip that is nowhere near the nest pays one
 * comparison, not a field evaluation. */
const PLAN = worldPlan();
const HOLLOW: Field = planHollow(PLAN, { stepMm: 1 });
const MOUNDS: Field[] = PLAN.nodes.map(moundOf).filter((f): f is Field => f !== null);
const VENTS: Field[] = PLAN.nodes.map(ventOf).filter((f): f is Field => f !== null);
const REJECT: Bounds = (() => {
  const b = planBounds(PLAN) ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const spread = 8 * MOUND_SPREAD + 4;
  return {
    min: [b.min[0] - spread, b.min[1] - 4, b.min[2] - spread],
    max: [b.max[0] + spread, b.max[1] + 8 * 1.1 + 4, b.max[2] + spread],
  };
})();

export function planForWorld(): NestPlan { return PLAN; }

/** The plan's ground line, for anything that needs "below the nest's surface". */
export const PLAN_GROUND_MM = groundOf(PLAN) ?? 208;

/**
 * The base soil, in world units, before any hand-digging: heightfield down,
 * closed at the world's six faces, with the nest's mound piled on and its
 * tunnels carved out. Pure, so streaming is reproduction rather than storage.
 */
export function baseDensityAt(x: number, y: number, z: number): number {
  return baseDensityUnder(heightMmAt(x * MM, z * MM) / MM, x, y, z);
}

/** Same, with this column's height already computed (the strip-fill fast path). */
export function baseDensityUnder(
  height: number, x: number, y: number, z: number,
): number {
  let soil = Math.min(
    height - y,
    y - WORLD_MARGIN,
    SOIL_DEPTH - WORLD_MARGIN - y,
    x - WORLD_MARGIN,
    WORLD_SPAN - WORLD_MARGIN - x,
    z - WORLD_MARGIN,
    WORLD_SPAN - WORLD_MARGIN - z,
  );
  const xMm = x * MM;
  const yMm = y * MM;
  const zMm = z * MM;
  if (xMm < REJECT.min[0] || xMm > REJECT.max[0]
    || zMm < REJECT.min[2] || zMm > REJECT.max[2]
    || yMm < REJECT.min[1] || yMm > REJECT.max[1]) {
    return soil;
  }
  /*
   * Near the nest: heap first, then cut — the vent has to bore through the
   * heap, and the fields are DISTANCES, so everything mm-valued is divided
   * back to world units. Returning mm here would blend the carve five times
   * too hard while still, misleadingly, cutting the right shape — the same
   * trap `inWorldUnits` documents.
   */
  for (const mound of MOUNDS) soil = Math.max(soil, mound(xMm, yMm, zMm) / MM);
  let out = soil;
  out = Math.min(out, -HOLLOW(xMm, yMm, zMm) / MM);
  for (const vent of VENTS) out = Math.min(out, -vent(xMm, yMm, zMm) / MM);
  return out;
}

/**
 * The window's self-capping density: two sharp planes at the rim so loaded
 * soil ends in an honest cut face instead of an open edge. Copied from the
 * lab's `cappedDensity`, whose comment explains why a smooth ramp is wrong
 * and why the position is an integer cell index and not a distance.
 */
export function cappedDensityAt(
  height: number,
  worldX: number, worldY: number, worldZ: number,
  cellX: number, cellZ: number,
): number {
  const soil = baseDensityUnder(height, worldX, worldY, worldZ);
  const edge = Math.min(cellX, WINDOW_CELLS - cellX, cellZ, WINDOW_CELLS - cellZ);
  if (edge >= CAP_PLANES) return soil;
  return Math.min(soil, (edge - 1.5) * CELL_SIZE);
}

/**
 * The untouched ground height, in world units — what the macro tiles and the
 * spawn use. Inside the fine window the walker asks the FIELD instead, so
 * hand-dug holes are real underfoot; this is the world before anyone touched
 * it. The mound is included so the macro sheet shows the anthill from afar.
 */
export function groundHeightAt(x: number, z: number): number {
  const xMm = x * MM;
  const zMm = z * MM;
  let h = heightMmAt(xMm, zMm);
  if (xMm >= REJECT.min[0] && xMm <= REJECT.max[0]
    && zMm >= REJECT.min[2] && zMm <= REJECT.max[2]) {
    for (const mound of MOUNDS) {
      // The heap's top at this column: mound fields are radial, so march the
      // few mm involved. Coarse is fine — the fine window owns the close-up.
      for (let up = 12; up > 0; up -= 1) {
        if (mound(xMm, h + up, zMm) / MM > 0) { h += up; break; }
      }
      break;
    }
  }
  return Math.max(WORLD_MARGIN, Math.min(h, SOIL_DEPTH_MM - 1)) / MM;
}
