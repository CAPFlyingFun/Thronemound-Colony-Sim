/**
 * Claustral founding — the opening act of every ant colony, and of this game.
 *
 * A newly mated queen lands after the nuptial flight, sheds her wings, digs a
 * sealed chamber, and never leaves it again. She survives on her own metabolised
 * flight muscles until the first workers hatch, and from then on she is an
 * egg-laying organ rather than an animal that goes places.
 *
 * So the handoff from "playable queen" to "queen is now infrastructure" isn't a
 * game concession — it's what actually happens. Which makes it a clean tutorial:
 * the queen phase teaches digging with no UI at all, and founding the den is the
 * colony being born.
 *
 * Pure logic, no renderer — the scene asks it what to display and when to offer
 * the button.
 */

import { isSolid, type VoxelWorld } from './VoxelWorld';

/** How far below the surface the den must sit. 40 voxels x 5 mm = 20 cm. */
export const DEN_MIN_DEPTH = 40;
/**
 * Hollow space required around the den, counted as air voxels inside a radius-2
 * ball (33 cells, ignoring corners). A bare shaft yields about 5, so this can
 * only be satisfied by genuinely widening a chamber rather than dropping straight
 * down — which is exactly the behaviour that makes the den feel earned.
 */
export const DEN_MIN_CHAMBER = 14;
export const CHAMBER_RADIUS = 2;

export type FoundingPhase = 'digging' | 'ready' | 'founded';

export interface FoundingStatus {
  phase: FoundingPhase;
  /** Voxels below the surface; negative above it. */
  depth: number;
  depthMm: number;
  /** Air voxels within CHAMBER_RADIUS of the queen. */
  chamber: number;
  depthMet: boolean;
  chamberMet: boolean;
  /** Short imperative for the HUD. */
  objective: string;
}

export interface DenSite {
  x: number;
  y: number;
  z: number;
  depth: number;
}

/** Air voxels inside a radius-r ball centred on a cell. */
export function countChamberAir(
  world: Pick<VoxelWorld, 'get'>,
  x: number,
  y: number,
  z: number,
  radius = CHAMBER_RADIUS,
): number {
  let air = 0;
  const r2 = radius * radius + 0.5;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        if (!isSolid(world.get(x + dx, y + dy, z + dz))) air++;
      }
    }
  }
  return air;
}

export class QueenFounding {
  readonly surfaceY: number;
  readonly voxelMm: number;
  private site: DenSite | null = null;

  constructor(surfaceY: number, voxelMm = 5) {
    this.surfaceY = surfaceY;
    this.voxelMm = voxelMm;
  }

  get den(): DenSite | null {
    return this.site;
  }

  get founded(): boolean {
    return this.site !== null;
  }

  evaluate(world: Pick<VoxelWorld, 'get'>, x: number, y: number, z: number): FoundingStatus {
    const depth = this.surfaceY - Math.floor(y);
    const depthMm = depth * this.voxelMm;

    if (this.site) {
      return {
        phase: 'founded', depth, depthMm,
        chamber: DEN_MIN_CHAMBER, depthMet: true, chamberMet: true,
        objective: 'The queen is sealed in. She will not leave again.',
      };
    }

    const depthMet = depth >= DEN_MIN_DEPTH;
    // Only bother counting once deep enough — it's 33 world reads per frame.
    const chamber = depthMet ? countChamberAir(world, Math.floor(x), Math.floor(y), Math.floor(z)) : 0;
    const chamberMet = chamber >= DEN_MIN_CHAMBER;

    let objective: string;
    if (!depthMet) {
      const remaining = (DEN_MIN_DEPTH - depth) * this.voxelMm;
      objective = `Dig down — ${Math.max(0, remaining)} mm to go`;
    } else if (!chamberMet) {
      objective = `Hollow out a chamber — ${chamber}/${DEN_MIN_CHAMBER}`;
    } else {
      objective = 'This will do. Found the den.';
    }

    return {
      phase: depthMet && chamberMet ? 'ready' : 'digging',
      depth, depthMm, chamber, depthMet, chamberMet, objective,
    };
  }

  /** Commit the den. Refuses unless the site currently qualifies. */
  found(world: Pick<VoxelWorld, 'get'>, x: number, y: number, z: number): DenSite | null {
    if (this.site) return this.site;
    const status = this.evaluate(world, x, y, z);
    if (status.phase !== 'ready') return null;
    this.site = { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), depth: status.depth };
    return this.site;
  }
}
