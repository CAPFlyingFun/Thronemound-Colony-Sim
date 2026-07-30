/**
 * Ground-speed curve and acceleration, kept out of the scene so it can be
 * reasoned about and tested without a renderer.
 *
 * Two things this fixes. Movement used to set velocity directly from input
 * every frame, so it started and stopped instantly — fine for a debug camera,
 * wrong for a creature. And touch input was effectively binary at full tilt,
 * which makes precise positioning while digging almost impossible.
 */

/** Below this the stick is treated as centred. */
export const STICK_DEADZONE = 0.08;

export interface SpeedBands {
  /** Careful placement pace. */
  crawl: number;
  /** Ordinary travel. */
  walk: number;
  /** Full tilt. */
  run: number;
}

/**
 * Anchored to measured fire-ant locomotion rather than picked by feel.
 * Solenopsis invicta running speed averages ~1.96 cm/s in foraging tunnels,
 * and ants generally move at roughly 9 body lengths per second. At 5 mm per
 * voxel that puts a real ant's run at about 4 voxels/s — the previous "run" of
 * 16 was roughly four times an actual ant.
 *
 *   crawl 2.0 voxels/s = 1.0 cm/s   deliberate placement
 *   walk  4.5           = 2.25 cm/s  measured foraging pace
 *   run   7.5           = 3.75 cm/s  a sprint, above average but plausible
 */
export const DEFAULT_BANDS: SpeedBands = { crawl: 2, walk: 4.5, run: 7.5 };

/** Which band a full throw of the stick reaches. */
export type Gait = 'crawl' | 'walk' | 'run';

/** Ordered slowest to fastest, for cycling and for tests. */
export const GAITS: readonly Gait[] = ['crawl', 'walk', 'run'];

/**
 * Walking, unless she is told otherwise.
 *
 * The three bands used to live inside a SINGLE throw of the stick: a third of
 * the way out was a crawl, three quarters a walk, the rim a run. On a thumb
 * stick that is a curve nobody can drive — you plant your thumb on the rim and
 * leave it there. So every band below the last was unreachable in practice and
 * she sprinted everywhere, which is also why she read as too fast for a fire
 * ant when the top of the range is meant to be a genuine sprint.
 *
 * The gait is a MODE now, chosen deliberately, and the stick stays analogue
 * within whichever one is set.
 */
export const DEFAULT_GAIT: Gait = 'walk';

/** What a full throw of the stick is worth in this gait. */
export function topSpeed(gait: Gait, bands: SpeedBands = DEFAULT_BANDS): number {
  if (gait === 'crawl') return bands.crawl;
  if (gait === 'run') return bands.run;
  return bands.walk;
}

/**
 * Map stick magnitude (0..1) to a speed within the current gait.
 *
 * Linear on purpose. The gait already gives the thumb the landmarks the old
 * piecewise curve was reaching for, and keeping the curve as well would leave
 * two separate things deciding one number — which is the shape of most of the
 * bugs in this project.
 */
export function speedForStick(
  magnitude: number,
  gait: Gait = DEFAULT_GAIT,
  bands: SpeedBands = DEFAULT_BANDS,
): number {
  const m = Math.min(1, Math.max(0, magnitude));
  if (m <= STICK_DEADZONE) return 0;
  const t = (m - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  return topSpeed(gait, bands) * t;
}

/**
 * Approach a target speed at a fixed rate. Accelerating and decelerating at
 * different rates is what makes a creature feel like it has mass: slow to wind
 * up, quicker to plant its feet.
 */
export function approach(current: number, target: number, accel: number, decel: number, dt: number): number {
  const rate = Math.abs(target) > Math.abs(current) ? accel : decel;
  const delta = target - current;
  const step = rate * dt;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

/** Clamp a joystick origin into a region, so the stick can't spawn under the HUD. */
export function clampStickOrigin(
  x: number,
  y: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): { x: number; y: number } {
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, y)),
  };
}

/** Stick offset -> unit-ish vector, clamped to the stick radius. */
export function stickVector(dx: number, dy: number, radius: number): { x: number; y: number; magnitude: number } {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0, magnitude: 0 };
  const clamped = Math.min(length, radius);
  return { x: (dx / length) * (clamped / radius), y: (dy / length) * (clamped / radius), magnitude: clamped / radius };
}
