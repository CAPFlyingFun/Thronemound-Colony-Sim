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

export const DEFAULT_BANDS: SpeedBands = { crawl: 3.5, walk: 9, run: 16 };

/** Stick magnitudes at which each band is reached. */
export const BAND_EDGES = { crawl: 0.35, walk: 0.75 } as const;

/**
 * Map stick magnitude (0..1) to a speed. Piecewise-linear through the band
 * anchors rather than three discrete steps: the bands give the thumb
 * meaningful landmarks, but the response in between stays continuous so the
 * ant never jumps between speeds.
 */
export function speedForStick(magnitude: number, bands: SpeedBands = DEFAULT_BANDS): number {
  const m = Math.min(1, Math.max(0, magnitude));
  if (m <= STICK_DEADZONE) return 0;
  const t = (m - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  if (t <= BAND_EDGES.crawl) {
    return bands.crawl * (t / BAND_EDGES.crawl);
  }
  if (t <= BAND_EDGES.walk) {
    const k = (t - BAND_EDGES.crawl) / (BAND_EDGES.walk - BAND_EDGES.crawl);
    return bands.crawl + (bands.walk - bands.crawl) * k;
  }
  const k = (t - BAND_EDGES.walk) / (1 - BAND_EDGES.walk);
  return bands.walk + (bands.run - bands.walk) * k;
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
