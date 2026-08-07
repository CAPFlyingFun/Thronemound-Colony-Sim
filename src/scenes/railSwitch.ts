/**
 * THE POINTS: a junction is a switch you SET, not a guess from where you look.
 *
 * This exists because of one bug that survived every attempt to tune it. The
 * rail rider derived which way she travelled along a tube from her FACING —
 * and facing is what the camera drag writes. Pan the view far enough off the
 * tunnel's axis and her direction of travel flipped, taking the model with
 * it, so the body angle and the direction could never agree for longer than
 * a frame. Tuning the threshold only moved the angle at which it happened.
 *
 * The fix is not a better guess. It is to stop guessing: on a railway the
 * points are thrown BEFORE the train arrives, the train takes whatever road
 * they are set to, and nothing about where the driver is looking enters into
 * it. So a junction here offers its roads, labelled the way a driver would
 * name them — straight, left, right, up, down, back — one is selected, and
 * arriving at the node takes that one. Direction becomes state that is only
 * ever changed deliberately, and the model's facing is DERIVED from it
 * rather than the other way round.
 *
 * Everything here is arithmetic over plain data: no THREE, no scene, so the
 * grammar of a junction can be checked without a renderer.
 */

import { type Vec3Like } from './tunnelRail';

/** One tunnel of the network, as the rider sees it. */
export interface SwitchEdge {
  a: Vec3Like;
  b: Vec3Like;
  from: string;
  to: string;
}

/** How a road leaves a junction, named the way a driver would name it. */
export type TurnLabel = 'straight' | 'left' | 'right' | 'up' | 'down' | 'back';

export interface SwitchOption {
  /** Index into the rails array. */
  edge: number;
  /** Where on that edge she starts riding: 0 at `a`, 1 at `b`. */
  startT: 0 | 1;
  /** Which way the edge's parameter runs as she travels it. */
  dir: 1 | -1;
  /** What this road is, relative to the way she arrived. */
  label: TurnLabel;
  /** Degrees off the arrival bearing, left positive. */
  turnDeg: number;
  /** The road's grade, nose-up positive. */
  pitchDeg: number;
}

/**
 * Steeper than this and a road is UP or DOWN whatever its bearing says — a
 * shaft has no meaningful left or right, and naming one from the noise in a
 * near-zero horizontal component is how a plumb drop ends up labelled
 * "sharp left".
 */
const VERTICAL_DEG = 60;

/** Inside this of dead ahead is STRAIGHT: the road you take by not choosing. */
const STRAIGHT_DEG = 35;

/** Beyond this it is the way you came from, near enough. */
const BACK_DEG = 145;

const DEG = 180 / Math.PI;

function labelFor(turnDeg: number, pitchDeg: number): TurnLabel {
  if (pitchDeg >= VERTICAL_DEG) return 'up';
  if (pitchDeg <= -VERTICAL_DEG) return 'down';
  const off = Math.abs(turnDeg);
  if (off <= STRAIGHT_DEG) return 'straight';
  if (off >= BACK_DEG) return 'back';
  return turnDeg > 0 ? 'left' : 'right';
}

/**
 * Every road out of a junction, labelled against the way she arrived.
 *
 * The arrival road is excluded — a switch does not offer you the way you
 * came — so a plain corner yields one option, a T yields two, a cross three,
 * and the caller can show a chooser only when there is a choice to make.
 */
export function optionsAt(
  rails: readonly SwitchEdge[], nodeId: string,
  arrivalEdge: number, arrivalDir: Vec3Like,
): SwitchOption[] {
  const arrivalHeading = Math.atan2(arrivalDir.x, arrivalDir.z) * DEG;
  const options: SwitchOption[] = [];
  for (let i = 0; i < rails.length; i += 1) {
    if (i === arrivalEdge) continue;
    const e = rails[i]!;
    let startT: 0 | 1;
    let dir: 1 | -1;
    if (e.from === nodeId) { startT = 0; dir = 1; } else if (e.to === nodeId) { startT = 1; dir = -1; } else continue;
    const head = startT === 0 ? e.a : e.b;
    const tail = startT === 0 ? e.b : e.a;
    const vx = tail.x - head.x;
    const vy = tail.y - head.y;
    const vz = tail.z - head.z;
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-9) continue;
    const pitchDeg = Math.asin(Math.max(-1, Math.min(1, vy / len))) * DEG;
    /*
     * A vertical road's heading is the arrival's, borrowed — atan2 of two
     * near-zeroes is noise, and the label does not use the bearing for a
     * shaft anyway. Borrowing keeps `turnDeg` reportable rather than random.
     */
    const flat = Math.hypot(vx, vz);
    const heading = flat > 1e-6 ? Math.atan2(vx, vz) * DEG : arrivalHeading;
    let turnDeg = heading - arrivalHeading;
    while (turnDeg > 180) turnDeg -= 360;
    while (turnDeg < -180) turnDeg += 360;
    options.push({
      edge: i, startT, dir, label: labelFor(turnDeg, pitchDeg), turnDeg, pitchDeg,
    });
  }
  /*
   * Sorted straightest-first, so the default is index 0 and a chooser reads
   * in the order a driver would expect rather than in whatever order the
   * plan's edges happen to be stored.
   */
  options.sort((p, q) => Math.abs(p.turnDeg) - Math.abs(q.turnDeg));
  return options;
}

/**
 * The road taken by NOT choosing: straight on where there is a straight on,
 * otherwise the straightest thing available, and never the way she came
 * unless that is genuinely all there is (a dead end, where turning round is
 * the only move left).
 */
export function defaultOption(options: readonly SwitchOption[]): SwitchOption | null {
  if (options.length === 0) return null;
  const forward = options.filter((o) => o.label !== 'back');
  return (forward[0] ?? options[0])!;
}

/**
 * Move the selection along the offered roads, for a LEFT/RIGHT pair of
 * buttons or a single cycling one. Wraps, because a chooser you can get
 * stuck at the end of is a chooser that needs a second button to escape.
 */
export function cycleSelection(
  options: readonly SwitchOption[], current: number, step: number,
): number {
  if (options.length === 0) return 0;
  const n = options.length;
  return ((current + step) % n + n) % n;
}

/**
 * Which offered road best matches a label — how a button marked LEFT finds
 * the road it means without the caller counting indices.
 */
export function optionByLabel(
  options: readonly SwitchOption[], label: TurnLabel,
): number {
  return options.findIndex((o) => o.label === label);
}
