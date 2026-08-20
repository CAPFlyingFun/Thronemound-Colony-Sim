/**
 * THE DIRECTIONAL BORE — a tunnel that starts where she does.
 *
 * `carve.bore(from, to, radius)` is a CAPSULE: it clamps its parameter to
 * [0, 1] and measures distance to the segment, so at the `from` end it is a
 * full hemisphere of radius `r` centred on `from`. That is right for a tunnel
 * carved BETWEEN two points and wrong for one carved FORWARD from an animal:
 * anchored at the Queen's thorax, a 3 mm capsule scoops three millimetres of
 * soil out from behind her, where her own gaster is and where she is not
 * digging.
 *
 *     capsule from the thorax          what is actually wanted
 *
 *         (=================)             #=================)
 *        ^                              ^
 *        3 mm of soil removed           flat at the thorax plane,
 *        behind her                     rounded at the work face
 *
 * The fix is one term. `carve`'s fields are POSITIVE INSIDE, so intersection
 * is `Math.min`: take the capsule and cut it with the half-space in front of
 * the origin. The front cap keeps its round work face, and the back becomes a
 * flat disc at the thorax plane.
 *
 * ## Why this lives here and not in `carve.ts`
 *
 * `src/voxel/carve.ts` is the ONE file the frozen island build and the colony
 * sim share. Changing `bore` would change the island's digging, and the island
 * is frozen. So this is a sibling that composes with it rather than an edit to
 * it — the same reason the rest of `src/sim` wraps shared code instead of
 * reaching into it.
 */

import type { Field, Point } from '../../voxel/carve';

/** A direction that has been checked, so the SDF cannot divide by zero. */
function unit(aim: Point): Point | null {
  const length = Math.hypot(aim[0], aim[1], aim[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [aim[0] / length, aim[1] / length, aim[2] / length];
}

/**
 * A bore running FORWARD from `origin` along `aim` for `length`, of the given
 * `radius`. Flat where it starts, rounded where it works.
 *
 * All arguments in the same units — this file has no opinion about which, so
 * a caller in world units and a caller in density cells both work, as long as
 * neither mixes them. `casteDig` states the design in millimetres.
 *
 * A zero-length aim yields a field that is inside nothing, rather than a NaN
 * that would quietly poison every sample it touched.
 */
export function boreFrom(
  origin: Point, aim: Point, length: number, radius: number,
): Field {
  const dir = unit(aim);
  if (dir === null || !(length > 0) || !(radius > 0)) return () => -Infinity;
  const [ax, ay, az] = dir;

  return (x: number, y: number, z: number): number => {
    const px = x - origin[0];
    const py = y - origin[1];
    const pz = z - origin[2];

    /* How far along the centreline this point sits. Negative is behind her. */
    const along = px * ax + py * ay + pz * az;

    /*
     * Distance to the SEGMENT, clamped — this is the capsule, and on its own
     * it is what rounds both ends.
     */
    const t = Math.max(0, Math.min(length, along));
    const dx = px - ax * t;
    const dy = py - ay * t;
    const dz = pz - az * t;
    const capsule = radius - Math.hypot(dx, dy, dz);

    /*
     * AND CUT AT THE THORAX PLANE. `min` is intersection for a positive-inside
     * field, so anything behind the origin is outside the bore however close
     * to the centreline it is. The front end is untouched by this, because
     * `along` is large and positive there and the capsule term is the smaller
     * of the two — which is what leaves the work face round.
     */
    return Math.min(capsule, along);
  };
}
