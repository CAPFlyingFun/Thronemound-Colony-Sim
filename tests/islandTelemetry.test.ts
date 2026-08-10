import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_MAX_SECONDS,
  TelemetryRecorder,
  type TelemetrySample,
} from '../src/scenes/IslandTelemetry';

/** A still frame: everything zero, one foot down, no corner. */
const still = (over: Partial<Omit<TelemetrySample, 't' | 'upRateDeg'>> = {}) => ({
  x: 0, y: 0, z: 0,
  upX: 0, upY: 1, upZ: 0,
  walk: 0, yaw: 0, strafe: 0, sprint: false,
  reqMmS: 0, actMmS: 0, heldBackMm: 0,
  planted: 6, groping: 0, strain: 0, allowed: 1, clearanceMm: 1,
  phase: 'none', turnDeg: 0, candidateMm: 0, onNew: 0, onOld: 6,
  ...over,
});

describe('telemetry recorder', () => {
  it('stays idle until she actually moves', () => {
    const rec = new TelemetryRecorder();
    for (let i = 0; i < 10; i += 1) rec.offer(still(), 0.016);
    expect(rec.status).toBe('idle');
    expect(rec.count).toBe(0);

    rec.offer(still({ reqMmS: 22, actMmS: 21 }), 0.016);
    expect(rec.status).toBe('recording');
    expect(rec.count).toBe(1);
  });

  it('times from the first moving frame, not from construction', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    for (let i = 0; i < 100; i += 1) rec.offer(still(), 0.5);   // ignored entirely
    rec.offer(move, 0.5);                                       // arms at t = 0
    rec.offer(move, 0.5);
    expect(rec.elapsed).toBeCloseTo(0.5, 5);
  });

  it('stops itself at the cap', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    rec.offer(move, 0.016);
    rec.offer(move, TELEMETRY_MAX_SECONDS + 1);
    expect(rec.status).toBe('stopped');
  });

  it('ignores frames after a manual stop', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    rec.offer(move, 0.016);
    rec.stop();
    rec.offer(move, 0.016);
    expect(rec.count).toBe(1);
  });

  /*
   * The whole point of the instrument: a body that swings 90 degrees in one
   * frame has to read as a huge rate, because that is the snap we are hunting.
   */
  it('measures the body swing as a rate, not as a difference', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    rec.offer(move, 0.016);
    rec.offer({ ...move, upX: 1, upY: 0, upZ: 0 }, 0.016);
    const fast = rec.report('h');
    expect(fast).toMatch(/fastest body rotation : 5625 deg\/s/);
  });

  it('reports no rotation when up holds still', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    for (let i = 0; i < 5; i += 1) rec.offer(move, 0.016);
    expect(rec.report('h')).toMatch(/fastest body rotation : 0 deg\/s/);
  });

  it('expands every corner phase change at full rate', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    for (let i = 0; i < 20; i += 1) rec.offer(move, 0.016);
    for (let i = 20; i < 40; i += 1) {
      rec.offer({ ...move, phase: 'reaching' }, 0.016);
    }
    const evs = rec.events();
    expect(evs.some((e) => e.why.includes('none -> reaching'))).toBe(true);
    expect(rec.report('h')).toContain('phase none -> reaching');
  });

  it('names the worst speed loss with the phase it happened in', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    for (let i = 0; i < 10; i += 1) rec.offer(move, 0.016);
    rec.offer(still({ reqMmS: 22, actMmS: 2.2, phase: 'crossing' }), 0.016);
    const out = rec.report('h');
    expect(out).toMatch(/worst speed loss      : 90%/);
    expect(out).toMatch(/phase crossing/);
  });

  it('counts frames with nothing planted — the float, if there is one', () => {
    const rec = new TelemetryRecorder();
    const move = still({ reqMmS: 22, actMmS: 22 });
    rec.offer(move, 0.016);
    rec.offer({ ...move, planted: 0 }, 0.016);
    rec.offer({ ...move, planted: 0 }, 0.016);
    expect(rec.report('h')).toMatch(/frames with no foot down: 2/);
  });

  /*
   * The distinction the stick was added for: a thumb coming off the stick and
   * the game refusing a held stick must never read the same.
   */
  it('separates a released stick from a refused one', () => {
    const released = new TelemetryRecorder();
    released.offer(still({ walk: 1, reqMmS: 22, actMmS: 22 }), 0.016);
    released.offer(still({ walk: 0, reqMmS: 0, actMmS: 0 }), 0.016);
    expect(released.report('h')).not.toContain('stick down, going nowhere');

    const jammed = new TelemetryRecorder();
    jammed.offer(still({ walk: 1, reqMmS: 22, actMmS: 22 }), 0.016);
    jammed.offer(still({ walk: 1, reqMmS: 22, actMmS: 0 }), 0.016);
    expect(jammed.report('h')).toContain('stick down, going nowhere: 1 frames');
  });

  it('says so plainly when nothing was recorded', () => {
    expect(new TelemetryRecorder().report('h')).toContain('she never moved');
  });

  it('re-arms after a reset', () => {
    const rec = new TelemetryRecorder();
    rec.offer(still({ reqMmS: 22, actMmS: 22 }), 0.016);
    rec.stop();
    rec.reset();
    expect(rec.status).toBe('idle');
    expect(rec.count).toBe(0);
    rec.offer(still({ reqMmS: 22, actMmS: 22 }), 0.016);
    expect(rec.status).toBe('recording');
  });
});
