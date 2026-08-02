/**
 * CARVING: voids cut out of solid before anyone has bitten anything.
 *
 * The scene's density field is positive-inside-solid — the block is built as
 * `min(x - LOW, HIGH - x, ...)`, the distance to the nearest face. Everything
 * here keeps that convention, which makes subtraction one operation: a void
 * is a shape that is also positive inside itself, and taking `min(solid,
 * -void)` leaves soil everywhere the void is not.
 *
 * The reason for having it at all is measurement. A tunnel she DUG is a
 * recording of every wobble she had while digging it, so anything measured in
 * one is measuring the digging as much as the thing under test. A tunnel cut
 * to a number is exactly the shape it claims to be, which makes it possible to
 * ask what her grip and the camera do in a bore of known width and known angle
 * with nothing else going on.
 */

/** A point, in the same units as the field. */
export type Point = readonly [number, number, number];

/**
 * A shape, as a function that is positive inside it and negative outside, and
 * roughly a distance either way.
 */
export type Field = (x: number, y: number, z: number) => number;

/** A box, given opposite corners. Positive inside. */
export function box(min: Point, max: Point): Field {
  return (x, y, z) => Math.min(
    x - min[0], max[0] - x,
    y - min[1], max[1] - y,
    z - min[2], max[2] - z,
  );
}

/**
 * A round bore between two points. Positive inside.
 *
 * A segment rather than an infinite axis, so a shaft has a bottom and a
 * drift has an end — and so the two can be joined by putting one's end
 * inside the other.
 */
export function bore(from: Point, to: Point, radius: number): Field {
  const ax = to[0] - from[0];
  const ay = to[1] - from[1];
  const az = to[2] - from[2];
  const len2 = ax * ax + ay * ay + az * az;
  return (x, y, z) => {
    const px = x - from[0];
    const py = y - from[1];
    const pz = z - from[2];
    let t = len2 > 1e-12 ? (px * ax + py * ay + pz * az) / len2 : 0;
    t = Math.min(1, Math.max(0, t));
    const dx = px - ax * t;
    const dy = py - ay * t;
    const dz = pz - az * t;
    return radius - Math.hypot(dx, dy, dz);
  };
}

/** Everything in `parts` at once — positive inside ANY of them. */
export function anyOf(parts: readonly Field[]): Field {
  return (x, y, z) => {
    let best = -Infinity;
    for (const part of parts) best = Math.max(best, part(x, y, z));
    return best;
  };
}

/**
 * `solid` with `void` taken out of it.
 *
 * `min(solid, -void)`: inside the void the second term is negative, so the
 * result is negative and nothing is there. Everywhere else the void's own
 * distance is positive and the soil is unchanged, except within a void's
 * radius of the cut where the two blend — which is the rounding a real
 * excavation has anyway.
 */
export function carve(solid: Field, hollow: Field): Field {
  return (x, y, z) => Math.min(solid(x, y, z), -hollow(x, y, z));
}
