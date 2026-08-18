/**
 * THE DIG JOB — one cylinder of soil, eaten over seconds.
 *
 * Joshua's blueprint (drawn, 2026-08-18): the cut is a CYLINDER, one body
 * length long, its diameter off the ant's own height, chipped away over
 * `volume / DIG_RATE_MM3_S` seconds ROUNDED UP to a whole second — "it can
 * animate the digging and that will also be the cooldown". This class is
 * the timer and the geometry of that; what a chip DOES to the soil is the
 * caller's (`carveBrush` in `islandDig`), so the whole schedule can be
 * unit-tested without a terrain.
 *
 * WHY A JOB AND NOT A BIGGER SCOOP. The popcorn complaint was tangent
 * spheres — every press a discrete pocket, the walls remembering each one.
 * A job carves the SAME cylinder as a sweep of heavily-overlapping spheres
 * on a steady beat, front face marching away from her, so the bore comes
 * out rounded the way the worms' do (`islandWorm` proves the look with the
 * same carving tech). The duration doubling as the cooldown is what makes
 * a bigger ant a slower digger with no second rule.
 */
import * as THREE from 'three';
import { MM } from '../world/worldScape';
import { DIG_BEAT_S, DIG_RATE_MM3_S } from './islandTuning';

/**
 * How far apart the sweep's spheres may sit, in radii. Half a radius is
 * deep overlap — the waist between two spheres at this spacing is under
 * 4% of the radius, which the one-way smoothing erases entirely.
 */
export const SWEEP_STEP_R = 0.5;

/** Joshua's arithmetic, kept in one place: cylinder volume in cubic mm,
 *  over the colony-wide rate, rounded UP to a whole second. */
export function digDurationS(radiusWu: number, lengthWu: number): number {
  const rMm = radiusWu * MM;
  const lMm = lengthWu * MM;
  const volMm3 = Math.PI * rMm * rMm * lMm;
  return Math.max(1, Math.ceil(volMm3 / DIG_RATE_MM3_S));
}

export class DigJob {
  /** Where the bore begins — the face end nearest her. */
  readonly origin: THREE.Vector3;

  /** Unit direction the bore runs. */
  readonly aim: THREE.Vector3;

  readonly lengthWu: number;

  readonly radiusWu: number;

  /** Whole seconds, by the formula — and the cooldown, by decree. */
  readonly durationS: number;

  /** Samples the sweep has actually changed — the caller's ledger, so a
   *  bore that ate only wood and air can say so when it finishes. */
  carved = 0;

  private readonly beatsTotal: number;

  private beatsDone = 0;

  private elapsed = 0;

  /** How deep the face has been carved so far, world units from origin. */
  private faceWu = 0;

  constructor(
    origin: THREE.Vector3,
    aim: THREE.Vector3,
    lengthWu: number,
    radiusWu: number,
  ) {
    this.origin = origin.clone();
    this.aim = aim.clone().normalize();
    this.lengthWu = lengthWu;
    this.radiusWu = radiusWu;
    this.durationS = digDurationS(radiusWu, lengthWu);
    this.beatsTotal = Math.max(1, Math.round(this.durationS / DIG_BEAT_S));
  }

  get done(): boolean {
    return this.beatsDone >= this.beatsTotal;
  }

  /** 0..1, for anything that wants to show progress. */
  get progress(): number {
    return this.beatsDone / this.beatsTotal;
  }

  /**
   * Advance the clock and hand back the sphere centres to carve NOW.
   *
   * Beat zero fires on the first call — a press answers immediately, not
   * half a second later — and each beat marches the face one share
   * further down the cylinder, filling the ground covered with spheres
   * every `SWEEP_STEP_R` radii so no beat can leave a waist behind it.
   * An empty array is a frame between beats, not a fault.
   */
  tick(dt: number): THREE.Vector3[] {
    if (this.done) return [];
    this.elapsed += Math.max(0, dt);
    const out: THREE.Vector3[] = [];
    while (
      this.beatsDone < this.beatsTotal
      && this.elapsed >= this.beatsDone * DIG_BEAT_S
    ) {
      const to = ((this.beatsDone + 1) / this.beatsTotal) * this.lengthWu;
      const step = this.radiusWu * SWEEP_STEP_R;
      /* From just past the last face to the new one, never skipping the
       * new face itself — the far lip is the fact the next beat builds
       * on. The first beat also carves depth 0, the near lip, so the
       * mouth of the bore opens on the press. */
      let at = this.beatsDone === 0 ? 0 : this.faceWu + step;
      for (; at < to; at += step) {
        out.push(this.origin.clone().addScaledVector(this.aim, at));
      }
      out.push(this.origin.clone().addScaledVector(this.aim, to));
      this.faceWu = to;
      this.beatsDone += 1;
    }
    return out;
  }
}
