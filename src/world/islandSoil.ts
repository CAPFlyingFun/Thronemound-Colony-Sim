/**
 * The island's diggable soil as a pure function. Kauai supplies the natural
 * surface; the nest plan is folded into the density field only after the
 * player builds one in the designer.
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
  /** The natural ground line at the island spawn, mm. */
  planGroundMm: number;
  setPlan(next: NestPlan): void;
  moundTopMm(xMm: number, zMm: number, naturalMm: number): number;
  densityUnder(height: number, floorY: number, x: number, y: number, z: number): number;
}

export function makeIslandSoil(
  heightMmAt: (xMm: number, zMm: number) => number,
): IslandSoil {
  const spawnX = 28000;
  const spawnZ = 28000;
  const ground = heightMmAt(spawnX, spawnZ);
  const plan: NestPlan = { nodes: [], edges: [] };

  const rejectOf = (of: NestPlan): Bounds => {
    const b = planBounds(of);
    if (!b) {
      return {
        min: [spawnX, ground, spawnZ],
        max: [spawnX, ground, spawnZ],
      };
    }
    const widestEntrance = Math.max(
      8,
      ...of.nodes.filter((n) => n.kind === 'entrance').map((n) => n.radiusMm),
    );
    const spread = widestEntrance * 3.2 + 4;
    return {
      min: [b.min[0] - spread, b.min[1] - 4, b.min[2] - spread],
      max: [b.max[0] + spread, b.max[1] + widestEntrance * 1.1 + 4, b.max[2] + spread],
    };
  };

  let HOLLOW: Field = planHollow(plan, { stepMm: 1 });
  let MOUNDS: Field[] = [];
  let VENTS: Field[] = [];
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
      if (MOUNDS.length === 0) return naturalMm;
      if (xMm < reject.min[0] || xMm > reject.max[0]
        || zMm < reject.min[2] || zMm > reject.max[2]) return naturalMm;
      let h = naturalMm;
      for (const mound of MOUNDS) {
        for (let up = 24; up > 0; up -= 1) {
          if (mound(xMm, h + up, zMm) > 0) { h += up; break; }
        }
        break;
      }
      return h;
    },

    densityUnder(
      height: number, floorY: number, x: number, y: number, z: number,
    ): number {
      let earth = Math.min(height - y, y - floorY - CELL_SIZE * 1.5);
      if (soil.plan.nodes.length === 0 && soil.plan.edges.length === 0) return earth;

      const xMm = x * MM;
      const yMm = y * MM;
      const zMm = z * MM;
      if (xMm < reject.min[0] || xMm > reject.max[0]
        || zMm < reject.min[2] || zMm > reject.max[2]
        || yMm < reject.min[1] || yMm > reject.max[1]) {
        return earth;
      }
      for (const mound of MOUNDS) earth = Math.max(earth, mound(xMm, yMm, zMm) / MM);
      let out = Math.min(earth, -HOLLOW(xMm, yMm, zMm) / MM);
      for (const vent of VENTS) out = Math.min(out, -vent(xMm, yMm, zMm) / MM);
      return out;
    },
  };
  return soil;
}
