/**
 * The island's diggable soil as a pure function — worldScape's pattern
 * (base world + nest plan folded into the density function) re-aimed at
 * Kauai. The height comes from the baked grid instead of sine octaves;
 * everything else is the proven recipe: a PRE-AUTHORED nest at the spawn
 * (gate, hall, bend, store — the "pre-tunnel"), its mound piled on and its
 * vent bored through, all inside a fast XZ reject so the soil that is
 * nowhere near the nest pays one comparison per sample.
 *
 * Millimetre-first, like everything: the island's lucky coincidence is that
 * at 1:1000 one real metre IS one in-world millimetre, so the baked grid's
 * "metres" slot straight into the nest modules' mm-space.
 */

import { type NestPlan } from '../nest/nestPlan';
import {
  moundOf, planBounds, planHollow, ventOf, type Bounds,
} from '../nest/nestCarve';
import type { Field } from '../voxel/carve';
import { CELL_SIZE, MM } from './worldScape';

export interface IslandSoil {
  plan: NestPlan;
  reject: Bounds;
  /** The nest's natural ground line, mm. */
  planGroundMm: number;
  /**
   * Swap in a NEW plan — the designer's DIG IT. The carve fields and the
   * reject box are rebuilt so the very next density sample reads the new
   * nest; the CALLER owns regenerating the streamed window over the union
   * of the old and new reject boxes (a deleted tunnel must refill too).
   */
  setPlan(next: NestPlan): void;
  /** Mound-aware top of a column, mm — for stamping the island grid. */
  moundTopMm(xMm: number, zMm: number, naturalMm: number): number;
  /**
   * Density in WORLD units at a world-unit position: the column's soil from
   * its surface down to the band floor, nest carved in near the plan.
   * `height` and `floorY` are the column top and the band's closing floor.
   */
  densityUnder(height: number, floorY: number, x: number, y: number, z: number): number;
}

/**
 * The pre-tunnel, dug into the summit plateau just east of the spawn:
 * the same proof-piece layout the streamed world ships — a mound-and-vent
 * gate, a 56 mm shaft, a drift that crosses 32 mm stream-tile lines, and a
 * store chamber — so every reconstruction property carries over unchanged.
 */
export function makeIslandSoil(
  heightMmAt: (xMm: number, zMm: number) => number,
): IslandSoil {
  const ex = 28040;
  const ez = 28000;
  const ground = heightMmAt(ex, ez);
  const plan: NestPlan = {
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

  const rejectOf = (of: NestPlan): Bounds => {
    const b = planBounds(of) ?? { min: [0, 0, 0], max: [0, 0, 0] };
    const spread = 8 * 3.2 + 4;
    return {
      min: [b.min[0] - spread, b.min[1] - 4, b.min[2] - spread],
      max: [b.max[0] + spread, b.max[1] + 8 * 1.1 + 4, b.max[2] + spread],
    };
  };

  /* Mutable so setPlan can swap the whole carve in one move — everything
   * below reads these through the closure, so a new plan is live for the
   * very next densityUnder call. */
  let HOLLOW: Field = planHollow(plan, { stepMm: 1 });
  let MOUNDS: Field[] = plan.nodes.map(moundOf).filter((f): f is Field => f !== null);
  let VENTS: Field[] = plan.nodes.map(ventOf).filter((f): f is Field => f !== null);
  let reject: Bounds = rejectOf(plan);

  const soil: IslandSoil = {
    plan,
    reject,
    planGroundMm: ground,

    setPlan(next: NestPlan): void {
      HOLLOW = planHollow(next, { stepMm: 1 });
      MOUNDS = next.nodes.map(moundOf).filter((f): f is Field => f !== null);
      VENTS = next.nodes.map(ventOf).filter((f): f is Field => f !== null);
      reject = rejectOf(next);
      soil.plan = next;
      soil.reject = reject;
    },

    moundTopMm(xMm: number, zMm: number, naturalMm: number): number {
      if (xMm < reject.min[0] || xMm > reject.max[0]
        || zMm < reject.min[2] || zMm > reject.max[2]) return naturalMm;
      let h = naturalMm;
      for (const mound of MOUNDS) {
        // The heap's top at this column: mound fields are radial, so march
        // the few mm involved. Coarse is fine — the fine soil owns close-up.
        for (let up = 12; up > 0; up -= 1) {
          if (mound(xMm, h + up, zMm) > 0) { h += up; break; }
        }
        break;
      }
      return h;
    },

    densityUnder(
      height: number, floorY: number, x: number, y: number, z: number,
    ): number {
      let soil = Math.min(height - y, y - floorY - CELL_SIZE * 1.5);
      const xMm = x * MM;
      const yMm = y * MM;
      const zMm = z * MM;
      if (xMm < reject.min[0] || xMm > reject.max[0]
        || zMm < reject.min[2] || zMm > reject.max[2]
        || yMm < reject.min[1] || yMm > reject.max[1]) {
        return soil;
      }
      /* Near the nest: heap first, then cut — the vent has to bore through
       * the heap. The fields are DISTANCES in mm; divide back to world units
       * or the carve blends five times too hard (worldScape's warning). */
      for (const mound of MOUNDS) soil = Math.max(soil, mound(xMm, yMm, zMm) / MM);
      let out = soil;
      out = Math.min(out, -HOLLOW(xMm, yMm, zMm) / MM);
      for (const vent of VENTS) out = Math.min(out, -vent(xMm, yMm, zMm) / MM);
      return out;
    },
  };
  return soil;
}
