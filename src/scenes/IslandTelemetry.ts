/**
 * THE FLIGHT RECORDER — what actually happened, frame by frame.
 *
 * ## Why per frame and not per second
 *
 * The thing this exists to catch — the float, the snap, the lingering slow
 * state on a ground<->tree transition — lasts between three and twenty frames.
 * A once-a-second sample steps straight over it and reports a smooth run. So
 * the buffer takes EVERY frame and the *report* summarises per second, with
 * the interesting moments expanded back to full rate. Same amount to read,
 * without throwing away the evidence.
 *
 * ## Why it is a pure module
 *
 * Numbers in, string out. No THREE, no DOM, no scene — so the report format
 * and the event picking are testable without a renderer, and the scene's only
 * job is to hand it a sample each frame and paste what comes back.
 */

/** One frame, in millimetres and degrees — the units a reader thinks in. */
export interface TelemetrySample {
  /** Seconds since recording armed. */
  t: number;
  x: number; y: number; z: number;
  /** Her up, unit length, in world axes. */
  upX: number; upY: number; upZ: number;
  /** How fast that up is swinging. This is the snap, as a number. */
  upRateDeg: number;
  /** What the stick asked for. */
  reqMmS: number;
  /** What the feet actually delivered. */
  actMmS: number;
  heldBackMm: number;
  planted: number;
  groping: number;
  strain: number;
  allowed: number;
  clearanceMm: number;
  /** Corner scheduler state, or 'none'. */
  phase: string;
  turnDeg: number;
  candidateMm: number;
  onNew: number;
  onOld: number;
}

export const TELEMETRY_MAX_SECONDS = 60;

/** How much of the ask has to survive before a frame counts as moving. */
const ARM_MM_S = 0.5;

/** Frames either side of an event that get printed at full rate. */
const WINDOW = 8;

/** At most this many event windows, so a paste stays a paste. */
const MAX_EVENTS = 6;

export type TelemetryState = 'idle' | 'recording' | 'stopped';

export class TelemetryRecorder {
  private samples: TelemetrySample[] = [];

  private state: TelemetryState = 'idle';

  /**
   * Seconds recorded, accumulated from the frame steps rather than read off
   * the wall clock. A probe that steps the scene a thousand times in a tight
   * loop covers sixteen seconds of ant time in a few milliseconds of real
   * time; clocking off `performance.now()` would file all of it under t=0.
   */
  private clock = 0;

  /** Previous up, for the angular rate — the recorder owns it so the scene
   *  cannot forget to pass a delta. */
  private lastUp: [number, number, number] | null = null;

  get status(): TelemetryState { return this.state; }

  get count(): number { return this.samples.length; }

  /** Seconds recorded so far. */
  get elapsed(): number {
    const last = this.samples[this.samples.length - 1];
    return last ? last.t : 0;
  }

  /**
   * Offer a frame.
   *
   * Arms itself the moment she is actually moving rather than the moment the
   * scene loads, so the buffer is 60 seconds of walking instead of 60 seconds
   * of somebody deciding where to walk. Stops itself at the cap.
   */
  offer(frame: Omit<TelemetrySample, 't' | 'upRateDeg'>, dt: number): void {
    if (this.state === 'stopped') return;
    if (this.state === 'idle') {
      if (frame.actMmS < ARM_MM_S && frame.reqMmS < ARM_MM_S) return;
      this.state = 'recording';
      this.clock = 0;
    } else {
      this.clock += dt;
    }
    const t = this.clock;
    if (t > TELEMETRY_MAX_SECONDS) { this.state = 'stopped'; return; }

    /* The angular rate between this up and the last one. Guarded because a
     * dt of zero on a stalled frame would otherwise report infinity. */
    const up: [number, number, number] = [frame.upX, frame.upY, frame.upZ];
    let upRateDeg = 0;
    if (this.lastUp && dt > 1e-6) {
      const dot = Math.max(-1, Math.min(1,
        this.lastUp[0] * up[0] + this.lastUp[1] * up[1] + this.lastUp[2] * up[2]));
      upRateDeg = (Math.acos(dot) * 180) / Math.PI / dt;
    }
    this.lastUp = up;
    this.samples.push({ ...frame, t, upRateDeg });
  }

  stop(): void { if (this.state === 'recording') this.state = 'stopped'; }

  reset(): void {
    this.samples = [];
    this.state = 'idle';
    this.lastUp = null;
    this.clock = 0;
  }

  /** The frames worth expanding: every corner phase change, then the sharpest
   *  swings of `up` that a phase change did not already cover. */
  events(): { at: number; why: string }[] {
    const out: { at: number; why: string }[] = [];
    for (let i = 1; i < this.samples.length; i += 1) {
      const a = this.samples[i - 1]!;
      const b = this.samples[i]!;
      if (a.phase !== b.phase) out.push({ at: i, why: `phase ${a.phase} -> ${b.phase}` });
    }
    const bySwing = this.samples
      .map((s, i) => ({ i, rate: s.upRateDeg }))
      .sort((p, q) => q.rate - p.rate);
    for (const cand of bySwing) {
      if (out.length >= MAX_EVENTS) break;
      if (cand.rate <= 0) break;
      if (out.some((e) => Math.abs(e.at - cand.i) <= WINDOW)) continue;
      out.push({ at: cand.i, why: `up swing ${cand.rate.toFixed(0)} deg/s` });
    }
    return out.sort((p, q) => p.at - q.at).slice(0, MAX_EVENTS);
  }

  /** The whole thing as pasteable text. */
  report(header: string): string {
    if (!this.samples.length) return `${header}\nno samples — she never moved.`;
    const lines: string[] = [];
    const n = (v: number, w = 6, d = 1) => v.toFixed(d).padStart(w);

    lines.push(header);
    lines.push(`samples=${this.samples.length} seconds=${this.elapsed.toFixed(1)} `
      + `state=${this.state}`);

    /* ---- per second, so the shape of the run is readable at a glance ---- */
    lines.push('');
    lines.push('PER SECOND  (upMax = fastest body rotation in that second)');
    lines.push('   t     x      y      z    req   act  held  plant grope '
      + 'upMax  strain  phase');
    for (let sec = 0; sec <= Math.floor(this.elapsed); sec += 1) {
      const inSec = this.samples.filter((s) => Math.floor(s.t) === sec);
      if (!inSec.length) continue;
      const mid = inSec[Math.floor(inSec.length / 2)]!;
      const avg = (pick: (s: TelemetrySample) => number) => (
        inSec.reduce((a, s) => a + pick(s), 0) / inSec.length
      );
      const upMax = Math.max(...inSec.map((s) => s.upRateDeg));
      const phases = [...new Set(inSec.map((s) => s.phase))].join('/');
      lines.push(`${n(sec, 4, 0)} ${n(mid.x)} ${n(mid.y)} ${n(mid.z)} `
        + `${n(avg((s) => s.reqMmS), 5)} ${n(avg((s) => s.actMmS), 5)} `
        + `${n(avg((s) => s.heldBackMm), 5, 2)} `
        + `${n(avg((s) => s.planted), 5, 1)} ${n(avg((s) => s.groping), 5, 1)} `
        + `${n(upMax, 6, 0)} ${n(avg((s) => s.strain), 6, 2)}  ${phases}`);
    }

    /* ---- and the moments that a per-second row would have hidden ---- */
    const events = this.events();
    lines.push('');
    lines.push(`EVENTS (${events.length}) — full rate, +/-${WINDOW} frames`);
    for (const ev of events) {
      const from = Math.max(0, ev.at - WINDOW);
      const to = Math.min(this.samples.length - 1, ev.at + WINDOW);
      lines.push('');
      lines.push(`-- frame ${ev.at} @ ${this.samples[ev.at]!.t.toFixed(2)}s: ${ev.why}`);
      lines.push('     t    req   act  held  plant grope  upRate  turn  cand '
        + 'new old  clear  phase');
      for (let i = from; i <= to; i += 1) {
        const s = this.samples[i]!;
        lines.push(`${i === ev.at ? '>' : ' '}${n(s.t, 6, 2)} `
          + `${n(s.reqMmS, 5)} ${n(s.actMmS, 5)} ${n(s.heldBackMm, 5, 2)} `
          + `${n(s.planted, 5, 0)} ${n(s.groping, 5, 0)} ${n(s.upRateDeg, 7, 0)} `
          + `${n(s.turnDeg, 5, 0)} ${n(s.candidateMm, 5, 1)} `
          + `${n(s.onNew, 3, 0)} ${n(s.onOld, 3, 0)} ${n(s.clearanceMm, 6, 2)}  ${s.phase}`);
      }
    }

    /* ---- the one-line verdict, so the paste leads with the answer ---- */
    const worstUp = this.samples.reduce((a, s) => (s.upRateDeg > a.upRateDeg ? s : a));
    const moving = this.samples.filter((s) => s.reqMmS > ARM_MM_S);
    const worstDrag = moving.length
      ? moving.reduce((a, s) => (s.actMmS / s.reqMmS < a.actMmS / a.reqMmS ? s : a))
      : null;
    lines.push('');
    lines.push('SUMMARY');
    lines.push(`  fastest body rotation : ${worstUp.upRateDeg.toFixed(0)} deg/s `
      + `at t=${worstUp.t.toFixed(2)}s (phase ${worstUp.phase})`);
    if (worstDrag) {
      lines.push(`  worst speed loss      : `
        + `${((1 - worstDrag.actMmS / worstDrag.reqMmS) * 100).toFixed(0)}% `
        + `(${worstDrag.actMmS.toFixed(1)} of ${worstDrag.reqMmS.toFixed(1)} mm/s) `
        + `at t=${worstDrag.t.toFixed(2)}s (phase ${worstDrag.phase})`);
    }
    const airborne = this.samples.filter((s) => s.planted === 0);
    lines.push(`  frames with no foot down: ${airborne.length}`
      + (airborne.length ? ` (first at t=${airborne[0]!.t.toFixed(2)}s)` : ''));
    return lines.join('\n');
  }
}
