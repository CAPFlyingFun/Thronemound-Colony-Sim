/**
 * THE TRACK: the tunnel she has dug, written down as a path she can ride.
 *
 * The instability underground all came from the same place — her position and
 * her attitude were both re-derived every frame from voxel soil she was in the
 * middle of destroying. Measured while digging, the surface normal beneath her
 * jumped 5.3 degrees a FRAME. Nothing built on top of a signal like that is
 * going to feel steady, and damping it only trades shake for lag.
 *
 * A rail replaces the question. It is recorded once, while she digs, and after
 * that it is just a curve: smooth by construction, with a position and a frame
 * at every point along it that no amount of later excavation can jog. Riding
 * it, there is nothing left to jitter.
 *
 * Deliberately a POLYLINE with an arc-length parameter rather than a spline
 * through control points. The samples are laid a fraction of a millimetre
 * apart, so the interpolation error is far below anything visible, and in
 * exchange every operation the scene needs — how long is it, where am I on it,
 * what is the nearest point to here — is exact and cheap rather than a search
 * over a curve.
 */

export interface RailFrame {
  /** World position. */
  x: number; y: number; z: number;
  /** Which way is up for a body standing here. */
  ux: number; uy: number; uz: number;
  /** Which way the track runs. */
  fx: number; fy: number; fz: number;
}

interface RailPoint extends RailFrame {
  /** Distance along the track from its start, in millimetres. */
  s: number;
  /**
   * How far this sleeper is BANKED off level, in radians — the recorded up
   * expressed as one number.
   *
   * Stored as an angle because an angle averages and a direction does not.
   * Smoothing the up VECTOR threw the bank away entirely on a planned track
   * (a forty-five degree bank read back as level) while still not smoothing a
   * dug one properly; a scalar does both, because averaging noisy roll gives
   * roughly no roll, which is the right answer for a tunnel she chewed.
   */
  roll: number;
}

/** A three-vector, in whatever units the caller is using. */
export interface Vec3Like { x: number; y: number; z: number }

/**
 * How far either side of a point the track is averaged, in millimetres.
 *
 * SWEPT, not chosen — see `probe-railsmooth`, which reads one recorded track
 * at every width so the difference is the window's doing and nothing else's.
 * Her body's turn per frame while riding:
 *
 *     1 mm   4.942°   worst 176.15°   thrown off the track
 *     2 mm   1.046°   worst  54.24°
 *     4 mm   1.986°   worst   3.02°
 *     6 mm   0.328°   worst   1.19°
 *     9 mm   0.203°   worst   0.74°   <-
 *    14 mm   0.660°   worst   7.92°   thrown off the track
 *    20 mm   0.660°   worst   4.00°   thrown off the track
 *
 * Nine is where it bottoms out, and 0.203 degrees a frame is steadier than
 * she manages WALKING ON THE SURFACE (0.15, worst 4.0). Wider than that and
 * the average cuts the corner far enough from where she actually stands that
 * she falls off the track altogether — the smoothing and the capture radius
 * are two ends of the same tolerance.
 */
export const RAIL_SMOOTH_MM = 9;

/**
 * How close to vertical a bore has to run before world up stops being a usable
 * reference for which way is up in it. Past this the two are near enough
 * parallel that the rejection is noise, and her recorded roll is all there is.
 */
const UP_FROM_WORLD = 0.985;

const norm = (x: number, y: number, z: number): [number, number, number] => {
  const n = Math.hypot(x, y, z);
  return n < 1e-9 ? [0, 1, 0] : [x / n, y / n, z / n];
};

/** The un-banked up for a heading: world up, squared against it. */
function levelUp(fx: number, fy: number, fz: number): [number, number, number] {
  return norm(-fx * fy, 1 - fy * fy, -fz * fy);
}

/** How far an up is banked off level about its own heading, in radians. */
function rollOf(
  fx: number, fy: number, fz: number, ux: number, uy: number, uz: number,
): number {
  const [lx, ly, lz] = levelUp(fx, fy, fz);
  // Positive leans her back toward her LEFT, matching the piece convention.
  const sx = fy * lz - fz * ly;
  const sy = fz * lx - fx * lz;
  const sz = fx * ly - fy * lx;
  return Math.atan2(ux * sx + uy * sy + uz * sz, ux * lx + uy * ly + uz * lz);
}

export class TunnelRail {
  private readonly points: RailPoint[] = [];

  /**
   * How much this particular track needs smoothing, in millimetres either
   * side. A track she DUG is a recording of a shaking body and needs it; a
   * track computed from a plan is already exact, and smoothing it only rounds
   * the geometry off — a ninety degree bend came out at 86.4 and a two-piece
   * descent lost two thirds of a millimetre at the join.
   */
  smoothMm = RAIL_SMOOTH_MM;

  /** How much track there is, in millimetres. */
  get lengthMm(): number {
    return this.points.length ? this.points[this.points.length - 1]!.s : 0;
  }

  get count(): number { return this.points.length; }

  /**
   * Lay another sleeper, if she has moved far enough since the last one.
   *
   * Spacing is a floor, not a target: the point of it is that standing still
   * and chewing does not pile a thousand samples on one spot, which would make
   * `nearest` slow and the frame at that spot an average of every direction she
   * fidgeted in. Returns whether anything was recorded.
   */
  record(at: Vec3Like, up: Vec3Like, forward: Vec3Like, minSpacingMm: number): boolean {
    const last = this.points[this.points.length - 1];
    let step = 0;
    if (last) {
      step = Math.hypot(at.x - last.x, at.y - last.y, at.z - last.z);
      if (step < minSpacingMm) return false;
    }
    const [ux, uy, uz] = norm(up.x, up.y, up.z);
    const [fx, fy, fz] = norm(forward.x, forward.y, forward.z);
    this.points.push({
      x: at.x, y: at.y, z: at.z, ux, uy, uz, fx, fy, fz,
      roll: rollOf(fx, fy, fz, ux, uy, uz),
      s: (last?.s ?? 0) + step,
    });
    return true;
  }

  /** The index of the last sleeper at or before `s`. */
  private indexAt(s: number): number {
    let lo = 0;
    let hi = this.points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid]!.s <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The average of every sleeper within `window` of `s` — the smoothing, and
   * the reason a rail is worth having at all.
   *
   * Recording her raw frame and playing it back exactly reproduces the shake
   * it was recorded with, which is what the first version did: riding the
   * track her body still turned 3.6 degrees a frame against 3.8 while digging,
   * a saving of nothing. The jitter is in the samples, so it has to come out
   * in the reading. A centred box average over a couple of millimetres is
   * enough — she is nine millimetres long, so it is a fraction of her own body
   * and cuts no corner she could feel.
   */
  private averageAt(s: number, window: number): { x: number; y: number; z: number;
    ux: number; uy: number; uz: number; roll: number } {
    const want = Math.min(Math.max(s, 0), this.lengthMm);
    let x = 0; let y = 0; let z = 0;
    let ux = 0; let uy = 0; let uz = 0;
    let roll = 0;
    let total = 0;
    const lowest = want - window;
    // A zero window has no weights to compute — the bracketing interpolation
    // below IS the answer, and dividing by it here produced NaN at both ends.
    const from = window > 1e-9 ? this.indexAt(Math.max(0, lowest)) : this.points.length;
    for (let i = from; i < this.points.length; i += 1) {
      const p = this.points[i]!;
      // `indexAt` lands on the sleeper at or BEFORE the window's edge, so the
      // first one is usually outside it. Including it dragged the average
      // half a spacing backward — a straight run sampled at 3.5 read 3.0.
      if (p.s < lowest) continue;
      if (p.s > want + window) break;
      /*
       * TRIANGULAR weights, not a flat box.
       *
       * A box kernel is a discontinuous filter: slide along by a tenth of a
       * millimetre and a sleeper POPS in or out of the window, shifting the
       * mean by a whole sample's worth. On jittery track that made the frame
       * turn 15.9 degrees over a tenth of a millimetre — the smoothing had
       * simply moved the shake from the samples into the window's own edges.
       * A weight that fades to nothing at the edge lets them arrive and leave
       * continuously, and there is no step left to find.
       */
      const w = 1 - Math.abs(p.s - want) / window;
      x += p.x * w; y += p.y * w; z += p.z * w;
      ux += p.ux * w; uy += p.uy * w; uz += p.uz * w;
      roll += p.roll * w;
      total += w;
    }
    if (total < 1e-9) {
      /*
       * Sparser track than the window is wide: every sleeper in reach sits on
       * the edge, where a triangular weight is zero. Fall back to plain
       * interpolation between the two that bracket the point — snapping to
       * one of them instead reported the frame at a sleeper 2 mm away as the
       * frame here, which on a two-sleeper rail is the whole track.
       */
      const i = this.indexAt(want);
      const a = this.points[i]!;
      const bb = this.points[Math.min(i + 1, this.points.length - 1)]!;
      const span = bb.s - a.s;
      const t = span > 1e-9 ? Math.min(1, Math.max(0, (want - a.s) / span)) : 0;
      const mix = (p: number, q: number): number => p + (q - p) * t;
      return {
        x: mix(a.x, bb.x), y: mix(a.y, bb.y), z: mix(a.z, bb.z),
        ux: mix(a.ux, bb.ux), uy: mix(a.uy, bb.uy), uz: mix(a.uz, bb.uz),
        roll: mix(a.roll, bb.roll),
      };
    }
    return {
      x: x / total, y: y / total, z: z / total,
      ux: ux / total, uy: uy / total, uz: uz / total, roll: roll / total,
    };
  }

  /**
   * The frame at a distance along the track, smoothed.
   *
   * The heading comes from the PATH — the smoothed positions a little either
   * side — rather than from the forward she happened to be facing when the
   * sleeper was laid. A tunnel points the way it goes; her nose at the moment
   * of biting is a different and much noisier thing. Up is the recorded
   * average, squared against that heading so the frame stays orthogonal.
   *
   * Past either end it clamps rather than returning null: the end of the track
   * is a place she can stand, and a train at the buffers is still on the rails.
   */
  sample(s: number, window = this.smoothMm): RailFrame | null {
    if (this.points.length === 0) return null;
    if (this.points.length === 1) return { ...this.points[0]! };
    const want = Math.min(Math.max(s, 0), this.lengthMm);
    /*
     * NO smoothing means no smoothing — read the sleepers straight.
     *
     * Not a shortcut: a zero window divides by zero in the weights, and even
     * guarded, deriving the heading from a chord across the nearest half
     * millimetre is an approximation an exact track does not need. A planned
     * ninety degree bend came out of it at 86.4.
     */
    if (window <= 1e-9) {
      const i = this.indexAt(want);
      const a = this.points[i]!;
      const bb = this.points[Math.min(i + 1, this.points.length - 1)]!;
      const span = bb.s - a.s;
      const t = span > 1e-9 ? Math.min(1, Math.max(0, (want - a.s) / span)) : 0;
      const mix = (p: number, q: number): number => p + (q - p) * t;
      const [nfx, nfy, nfz] = norm(mix(a.fx, bb.fx), mix(a.fy, bb.fy), mix(a.fz, bb.fz));
      const [nux, nuy, nuz] = norm(mix(a.ux, bb.ux), mix(a.uy, bb.uy), mix(a.uz, bb.uz));
      return {
        x: mix(a.x, bb.x), y: mix(a.y, bb.y), z: mix(a.z, bb.z),
        ux: nux, uy: nuy, uz: nuz, fx: nfx, fy: nfy, fz: nfz,
      };
    }
    /*
     * The window TAPERS to nothing at the ends rather than sliding off them.
     *
     * A centred average near an end only has sleepers on one side, so it
     * reports a point back up the line and quietly shortens the tunnel. The
     * first fix for that sampled where the window fitted and extrapolated the
     * rest along the heading — which keeps the length but puts the smoothed
     * curve up to six millimetres off the raw one on a bend. That matters
     * because `nearest` measures against the raw line: she boarded a track she
     * was within four millimetres of and was set down six millimetres away
     * from it, outside her own tunnel, and fell off again the next frame.
     *
     * Shrinking the window instead means the two agree exactly at the ends and
     * smooth in the middle, with nothing extrapolated anywhere.
     */
    const fit = Math.max(0, Math.min(window, want, this.lengthMm - want));
    const here = this.averageAt(want, fit);
    const step = Math.max(fit, 0.5);
    const ahead = this.averageAt(Math.min(this.lengthMm, want + step), fit);
    const behind = this.averageAt(Math.max(0, want - step), fit);
    let [fx, fy, fz] = norm(ahead.x - behind.x, ahead.y - behind.y, ahead.z - behind.z);
    if (!Number.isFinite(fx) || (fx === 0 && fy === 1 && fz === 0)) {
      const near = this.points[this.indexAt(want)]!;
      [fx, fy, fz] = norm(near.fx, near.fy, near.fz);
    }
    /*
     * UP IS BUILT FROM THE PATH, not played back from the recording.
     *
     * Averaging the recorded up cannot work, and it is worth saying why rather
     * than widening the window again. She lays sleepers every 0.4 mm while her
     * body is swinging about four degrees a FRAME, so consecutive sleepers
     * differ by ten degrees or more. Averaging N of those leaves a residual
     * proportional to the noise over the root of N: ten sleepers took 3.8
     * degrees a frame down to 3.4, and reaching the steadiness of the surface
     * walk would need thousands. The noise is not a wobble on a good signal,
     * it IS the signal.
     *
     * So the frame is constructed instead. The heading already comes from the
     * smoothed path; up is world up squared against it, which makes the floor
     * of the tunnel level in exactly the way a floor should be and is smooth
     * for the same reason the path is. The recording is only consulted where
     * that fails — a bore within a few degrees of vertical, where world up is
     * parallel to the heading and has no answer to give.
     */
    const vertical = fy;
    let ux: number; let uy: number; let uz: number;
    if (Math.abs(vertical) < UP_FROM_WORLD) {
      [ux, uy, uz] = levelUp(fx, fy, fz);
      // ...then banked by however much the track is banked here. On a dug
      // tunnel that average is near enough nothing, which is the floor being
      // level; on a planned one it is the roll the piece asked for.
      if (Math.abs(here.roll) > 1e-9) {
        const c = Math.cos(here.roll);
        const sn = Math.sin(here.roll);
        const crossX = fy * uz - fz * uy;
        const crossY = fz * ux - fx * uz;
        const crossZ = fx * uy - fy * ux;
        const kdot = fx * ux + fy * uy + fz * uz;
        [ux, uy, uz] = norm(
          ux * c + crossX * sn + fx * kdot * (1 - c),
          uy * c + crossY * sn + fy * kdot * (1 - c),
          uz * c + crossZ * sn + fz * kdot * (1 - c),
        );
      }
    } else {
      // Near vertical: keep her recorded roll, squared against the heading.
      const dot = here.ux * fx + here.uy * fy + here.uz * fz;
      [ux, uy, uz] = norm(
        here.ux - fx * dot, here.uy - fy * dot, here.uz - fz * dot,
      );
    }
    return { x: here.x, y: here.y, z: here.z, ux, uy, uz, fx, fy, fz };
  }

  /**
   * Where on the track a world point is, and how far off it — the boarding
   * test.
   *
   * Measured against the SEGMENTS rather than the sleepers, because a point
   * halfway between two sleepers is on the track and a nearest-sleeper search
   * would report it half a spacing away. That matters: the capture radius is
   * itself only a couple of millimetres.
   */
  nearest(p: Vec3Like): { s: number; distMm: number } | null {
    if (this.points.length === 0) return null;
    if (this.points.length === 1) {
      const only = this.points[0]!;
      return { s: 0, distMm: Math.hypot(p.x - only.x, p.y - only.y, p.z - only.z) };
    }
    let bestS = 0;
    let bestDist = Infinity;
    for (let i = 0; i + 1 < this.points.length; i += 1) {
      const a = this.points[i]!;
      const b = this.points[i + 1]!;
      const ax = b.x - a.x;
      const ay = b.y - a.y;
      const az = b.z - a.z;
      const len2 = ax * ax + ay * ay + az * az;
      let t = 0;
      if (len2 > 1e-12) {
        t = ((p.x - a.x) * ax + (p.y - a.y) * ay + (p.z - a.z) * az) / len2;
        t = Math.min(1, Math.max(0, t));
      }
      const dx = p.x - (a.x + ax * t);
      const dy = p.y - (a.y + ay * t);
      const dz = p.z - (a.z + az * t);
      const dist = Math.hypot(dx, dy, dz);
      if (dist < bestDist) {
        bestDist = dist;
        bestS = a.s + (b.s - a.s) * t;
      }
    }
    return { s: bestS, distMm: bestDist };
  }
}

/**
 * Build the track a PLAN describes, before a single bite is taken.
 *
 * The plan used to steer her and nothing more: it set the gyro to the piece's
 * grade and pushed the stick, and left her path to `hold()`. Measured, that
 * flew the attitude perfectly and went nowhere — a piece asking for thirty
 * degrees down held her nose at -30.4 and dropped her 0.01 mm over ten
 * millimetres, because `hold()` re-seats her on the surface every frame
 * whatever angle she is holding. She scraped along the top with her face in
 * the dirt, which is exactly what it looked like.
 *
 * So the geometry is worked out first and she rides it. Ten millimetres at
 * thirty degrees down goes down five millimetres because that is what the
 * arithmetic says, not because the soil happened to allow it.
 *
 * The conventions are the ones the pieces are written in — see `digPlan`:
 * pitch absolute against world horizontal, turn relative and spread across the
 * length, roll relative to the surface.
 */
export function railFromPlan(
  pieces: readonly { pitch: number; turn: number; roll: number; length: number }[],
  start: { at: Vec3Like; forward: Vec3Like },
  stepMm = 0.4,
): TunnelRail {
  const rail = new TunnelRail();
  // Computed geometry needs no smoothing; see `smoothMm`.
  rail.smoothMm = 0;
  const DEG = Math.PI / 180;
  const at = { x: start.at.x, y: start.at.y, z: start.at.z };
  // Her heading as a world bearing, so a turn is an addition to one number.
  let heading = Math.atan2(start.forward.x, start.forward.z);
  const push = (grade: number, roll: number): void => {
    const cos = Math.cos(grade);
    const fx = Math.sin(heading) * cos;
    const fy = Math.sin(grade);
    const fz = Math.cos(heading) * cos;
    // Up is world up squared against the heading, then banked about it —
    // the same construction `sample` uses, so a planned track and a dug one
    // describe up the same way.
    const dot = fy;
    /* VERTICAL IS ALLOWED. The world-up projection vanishes at |fy|=1;
     * its continuous limit is the heading line itself — up faces back
     * along the approach heading in a climb, along it in a dive — and
     * `heading` is integrator state here, defined straight through the
     * vertical run. */
    let [ux, uy, uz] = Math.abs(fy) > 0.9995
      ? norm(-Math.sin(heading) * fy, 0, -Math.cos(heading) * fy)
      : norm(-fx * dot, 1 - fy * dot, -fz * dot);
    if (Math.abs(roll) > 1e-9) {
      const c = Math.cos(roll);
      const sn = Math.sin(roll);
      // Rodrigues about the heading.
      const kx = fx; const ky = fy; const kz = fz;
      const crossX = ky * uz - kz * uy;
      const crossY = kz * ux - kx * uz;
      const crossZ = kx * uy - ky * ux;
      const kdot = kx * ux + ky * uy + kz * uz;
      [ux, uy, uz] = norm(
        ux * c + crossX * sn + kx * kdot * (1 - c),
        uy * c + crossY * sn + ky * kdot * (1 - c),
        uz * c + crossZ * sn + kz * kdot * (1 - c),
      );
    }
    rail.record(at, { x: ux, y: uy, z: uz }, { x: fx, y: fy, z: fz }, 0);
  };
  for (const piece of pieces) {
    const grade = piece.pitch * DEG;
    const roll = piece.roll * DEG;
    const turnPerMm = piece.length > 0 ? (piece.turn * DEG) / piece.length : 0;
    for (let travelled = 0; travelled < piece.length - 1e-9; travelled += stepMm) {
      const ds = Math.min(stepMm, piece.length - travelled);
      push(grade, roll);
      heading += turnPerMm * ds;
      const cos = Math.cos(grade);
      at.x += Math.sin(heading) * cos * ds;
      at.y += Math.sin(grade) * ds;
      at.z += Math.cos(heading) * cos * ds;
    }
  }
  // The far end, so the last piece reaches its full length.
  if (pieces.length) {
    const lastPiece = pieces[pieces.length - 1]!;
    push(lastPiece.pitch * DEG, lastPiece.roll * DEG);
  }
  return rail;
}
