/**
 * THE ROUTE TRACE — the tunnel as a picture, for the digger who cannot see.
 *
 * Reported: "the display of the pitch, roll, and heading is confusing when
 * you're underground and just see arrows." Asked what would help instead,
 * Joshua chose a depth/route trace.
 *
 * The four dig gauges were built for a real blindness — a player heading UP
 * who believed she was heading down — but they answer it with numbers the
 * player has to integrate into a tunnel in their head. Underground there is
 * nothing to check them against. So below grade the panel becomes THIS: a
 * side-on profile of the route she has actually cut — depth against
 * distance travelled — with her own position at the end of the line. "Am I
 * going down or looping back up" stops being arithmetic and becomes a
 * shape.
 *
 * PURE LOGIC HERE, plus one draw function handed a 2D context. No THREE, no
 * DOM lookups, no scene — the scene feeds it travel and depth, the HUD
 * gives it a canvas, and the split is what makes the sampling testable
 * without a browser.
 */

/** One point of the route: how far along it, and how far down. Both mm. */
export interface RouteSample {
  d: number;
  depth: number;
}

/** Travel between samples, before decimation. At her walking pace this is
 *  several samples a second — a line, not a scatter. */
export const TRACE_STEP_MM = 4;

/**
 * Most samples kept. When the route outgrows it the resolution HALVES —
 * every second sample is dropped and the step doubles — so a long tunnel
 * coarsens instead of scrolling off. The whole route always fits, which is
 * the point: a trace that forgets its beginning cannot show a loop.
 */
export const TRACE_CAP = 240;

/** A single step longer than this is a teleport, not travel — a load, a
 *  respawn, a probe's hand — and is not part of any tunnel she walked. */
export const TRACE_JUMP_MM = 24;

export class RouteTrace {
  readonly samples: RouteSample[] = [];

  /** mm of travel between samples — doubles on decimation. */
  private stepMm = TRACE_STEP_MM;

  /** Travel since the last kept sample. */
  private sinceMm = 0;

  /** Total route length recorded, mm. Monotonic: walking BACK down your
   *  own tunnel still adds route, which is what makes a loop legible —
   *  the depth comes back up while the distance keeps growing. */
  private totalMm = 0;

  get lengthMm(): number {
    return this.totalMm + this.sinceMm;
  }

  /**
   * One frame of travel. `travelMm` is the full 3D distance she moved —
   * horizontal-only would record a plumb shaft as no route at all.
   */
  add(travelMm: number, depthMm: number): void {
    if (!(travelMm >= 0) || travelMm > TRACE_JUMP_MM) return;
    /* The first sighting plants the start — and then this same frame's
     * travel still counts, or every trace under-reports by one step. */
    if (this.samples.length === 0) this.samples.push({ d: 0, depth: depthMm });
    this.sinceMm += travelMm;
    if (this.sinceMm < this.stepMm) return;
    this.totalMm += this.sinceMm;
    this.sinceMm = 0;
    this.samples.push({ d: this.totalMm, depth: depthMm });
    if (this.samples.length > TRACE_CAP) this.decimate();
  }

  clear(): void {
    this.samples.length = 0;
    this.stepMm = TRACE_STEP_MM;
    this.sinceMm = 0;
    this.totalMm = 0;
  }

  /** Halve the resolution, keeping the first and last points — the ends
   *  are the two facts the eye anchors on. */
  private decimate(): void {
    const kept: RouteSample[] = [];
    for (let i = 0; i < this.samples.length; i += 2) kept.push(this.samples[i]!);
    const last = this.samples[this.samples.length - 1]!;
    if (kept[kept.length - 1] !== last) kept.push(last);
    this.samples.length = 0;
    this.samples.push(...kept);
    this.stepMm *= 2;
  }
}

/* The panel never draws at a scale where these lie: a fresh trace two
 * samples long stretched to fill the panel would read as a cliff. The
 * floors keep early shapes honest until the real route outgrows them. */
const SPAN_FLOOR_MM = 60;
const DEPTH_FLOOR_MM = 12;
const PAD = 3;

/** TCS black/gold. The gold matches the readout chips' `#f0d88e`. */
const LINE = '#f0d88e';
const SURFACE = 'rgba(240, 216, 142, 0.32)';
const HER = '#ffd23f';
const INK = 'rgba(240, 216, 142, 0.85)';

/**
 * Draw the profile into a 2D context. `w`/`h` are CSS pixels — the caller
 * owns backing-store scale (devicePixelRatio) via `ctx.setTransform`.
 *
 * Depth grows DOWNWARD on screen, because that is what depth does; the
 * surface line sits at the top and her line hangs under it, which is the
 * side-on view of the hill a player already has in their head.
 */
export function drawRouteTrace(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  trace: RouteTrace,
  depthNowMm: number,
): void {
  ctx.clearRect(0, 0, w, h);

  const span = Math.max(SPAN_FLOOR_MM, trace.lengthMm);
  let deepest = DEPTH_FLOOR_MM;
  for (const s of trace.samples) deepest = Math.max(deepest, s.depth);
  deepest = Math.max(deepest, depthNowMm);

  const x = (d: number): number => PAD + (d / span) * (w - PAD * 2);
  const y = (depth: number): number => PAD + (depth / deepest) * (h - PAD * 2);

  /* The surface — the one reference line the whole picture hangs from. */
  ctx.strokeStyle = SURFACE;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD, y(0));
  ctx.lineTo(w - PAD, y(0));
  ctx.stroke();
  ctx.setLineDash([]);

  /* The route, ending at HER — the live point rides the trace's current
   * length and depth, so the line reaches her even between samples. */
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const first = trace.samples[0];
  ctx.moveTo(x(first ? first.d : 0), y(first ? first.depth : depthNowMm));
  for (let i = 1; i < trace.samples.length; i += 1) {
    const s = trace.samples[i]!;
    ctx.lineTo(x(s.d), y(s.depth));
  }
  ctx.lineTo(x(trace.lengthMm), y(depthNowMm));
  ctx.stroke();

  ctx.fillStyle = HER;
  ctx.beginPath();
  ctx.arc(x(trace.lengthMm), y(depthNowMm), 2, 0, Math.PI * 2);
  ctx.fill();

  /* The number, because a picture answers "which way" and the number
   * answers "how far" — the two halves of the question the old panel
   * split across four gauges. */
  ctx.fillStyle = INK;
  ctx.font = '800 9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`▼ ${Math.round(depthNowMm)}mm`, w - PAD - 1, h - PAD + 1);
}
