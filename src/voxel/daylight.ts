/**
 * Time of day, as a curve rather than a set of presets.
 *
 * Most of what sells a time of day is the LIGHT, not the picture, so the phases
 * below carry both: brightness, the colour the lights take, where the sun sits,
 * how strong the ambient fill is — and optionally an image of their own.
 *
 * A phase with no image falls back to the shared sky, graded. That is why night
 * and dusk read convincingly off a daylight JPEG. A phase WITH one gets it,
 * and the renderer swaps to whichever phase is nearer at the halfway mark; it
 * does not cross-fade the two images, because `scene.background` takes a single
 * texture and blending would mean drawing the background through a shader of
 * our own. The lighting interpolates continuously either way, which is what the
 * eye actually reads as time passing.
 *
 * So this is built to be extended by dropping files into public/sky/ and naming
 * them here — no renderer change needed.
 *
 * Pure — no three.js — so the interpolation is testable without a GL context.
 */

export interface SkyPhase {
  /** Name, for the manifest and for debugging. */
  readonly name: string;
  /** Hour of a 24-hour clock this phase is centred on. */
  readonly at: number;
  /** Equirectangular image, or null to use the shared sky graded. */
  readonly image: string | null;
  /** Multiplier on the sky as a BACKGROUND. Night is dim, noon is full. */
  readonly background: number;
  /** How hard the sky lights the world through the irradiance map. */
  readonly environment: number;
  /** Ambient fill that keeps tunnels from going pure black. */
  readonly hemisphere: number;
  /** Sun colour, linear RGB 0..1. */
  readonly sun: readonly [number, number, number];
  readonly sunIntensity: number;
  /** Sun elevation in radians: 0 is the horizon, negative is below it. */
  readonly elevation: number;
  /** Horizon colour the fog matches, so fog meets sky instead of banding. */
  readonly horizon: readonly [number, number, number];
}

/**
 * Ordered by hour and treated as a ring, so 23:00 blends into 01:00 the short
 * way round rather than running backwards through the whole day.
 */
export const SKY_PHASES: readonly SkyPhase[] = [
  {
    name: 'night',
    at: 0,
    image: null,
    background: 0.06,
    environment: 0.12,
    hemisphere: 0.22,
    sun: [0.44, 0.52, 0.78],
    sunIntensity: 0.25,
    elevation: -0.25,
    horizon: [0.05, 0.06, 0.11],
  },
  {
    name: 'sunrise',
    at: 6,
    image: null,
    background: 0.55,
    environment: 0.55,
    hemisphere: 0.34,
    sun: [1, 0.62, 0.36],
    sunIntensity: 1.5,
    elevation: 0.08,
    horizon: [0.55, 0.35, 0.26],
  },
  {
    name: 'noon',
    at: 12,
    // The brighter, bluer of the two we have — the one worth the extra 350 KB
    // is the one you spend the most daylight looking at.
    image: 'daysky_2k.jpg',
    background: 1,
    environment: 1,
    hemisphere: 0.28,
    sun: [1, 0.96, 0.88],
    sunIntensity: 2.4,
    elevation: 1.15,
    horizon: [0.62, 0.68, 0.78],
  },
  {
    name: 'sunset',
    at: 19,
    image: null,
    background: 0.5,
    environment: 0.5,
    hemisphere: 0.32,
    sun: [1, 0.5, 0.26],
    sunIntensity: 1.4,
    elevation: 0.06,
    horizon: [0.58, 0.3, 0.2],
  },
];

export const DAY_HOURS = 24;

export interface SkyGrade {
  background: number;
  environment: number;
  hemisphere: number;
  sun: [number, number, number];
  sunIntensity: number;
  elevation: number;
  horizon: [number, number, number];
  /** The two phases being blended and how far between them, for the renderer. */
  from: SkyPhase;
  to: SkyPhase;
  blend: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] => [
  lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t),
];

/** Hours into the day, wrapped, so callers can pass anything including negatives. */
export function wrapHours(hours: number): number {
  return ((hours % DAY_HOURS) + DAY_HOURS) % DAY_HOURS;
}

/**
 * The two phases either side of an hour, and how far between them.
 *
 * The ring is what makes this worth its own function: between the last phase
 * and the first, the gap runs through midnight, so the span has to be measured
 * forwards around the clock rather than as a subtraction that would come out
 * negative and put the blend outside 0..1.
 */
export function phasesAround(hours: number): { from: SkyPhase; to: SkyPhase; blend: number } {
  const h = wrapHours(hours);
  const phases = SKY_PHASES;
  let fromIndex = phases.length - 1;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i]!.at <= h) fromIndex = i;
  }
  const from = phases[fromIndex]!;
  const to = phases[(fromIndex + 1) % phases.length]!;
  const span = wrapHours(to.at - from.at) || DAY_HOURS;
  const travelled = wrapHours(h - from.at);
  return { from, to, blend: Math.min(1, travelled / span) };
}

/** Everything the renderer needs for one moment, fully interpolated. */
export function skyAt(hours: number): SkyGrade {
  const { from, to, blend } = phasesAround(hours);
  return {
    background: lerp(from.background, to.background, blend),
    environment: lerp(from.environment, to.environment, blend),
    hemisphere: lerp(from.hemisphere, to.hemisphere, blend),
    sun: lerp3(from.sun, to.sun, blend),
    sunIntensity: lerp(from.sunIntensity, to.sunIntensity, blend),
    elevation: lerp(from.elevation, to.elevation, blend),
    horizon: lerp3(from.horizon, to.horizon, blend),
    from,
    to,
    blend,
  };
}

/** Pack a linear RGB triple into the 0xRRGGBB three.js wants. */
export function packColor(rgb: readonly [number, number, number]): number {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (clamp(rgb[0]) << 16) | (clamp(rgb[1]) << 8) | clamp(rgb[2]);
}
