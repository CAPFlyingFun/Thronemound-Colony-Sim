/**
 * THE FLICK, AND THE BURST — without a browser.
 *
 * The half of this that can be checked headlessly is the half where the
 * bugs live: whether a pan can be mistaken for a flick, whether a
 * near-diagonal settles the same way twice, and whether a burst actually
 * carries her the distance it was asked for. What needs a browser is
 * whether the scene wires it up, and that is `scripts/shot-dodge.mjs`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DODGE, Dodge, FLICK, NUDGE_PX, readFlick, readNudge, type Swipe,
} from '../src/scenes/dodge';

const MM = 5;

/** A gesture, with the path length defaulting to a straight one. */
const swipe = (dx: number, dy: number, ms: number, travel?: number): Swipe => ({
  dx, dy, ms, travelPx: travel ?? Math.hypot(dx, dy),
});

describe('reading a flick off a pointer', () => {
  it('takes a short fast throw', () => {
    expect(readFlick(swipe(60, 0, 100))).toBe('right');
    expect(readFlick(swipe(-60, 0, 100))).toBe('left');
    /* Screen y grows downward, so up is negative. */
    expect(readFlick(swipe(0, -60, 100))).toBe('forward');
    expect(readFlick(swipe(0, 60, 100))).toBe('back');
  });

  it('refuses a LOOK, which is the whole point', () => {
    /* Far but slow — an ordinary pan across the screen. */
    expect(readFlick(swipe(300, 0, 900))).toBeNull();
    /* Fast but tiny — a twitch, or two samples of jitter. */
    expect(readFlick(swipe(12, 0, 20))).toBeNull();
    /* Brief and far but under the velocity floor. */
    expect(readFlick(swipe(40, 0, 200))).toBeNull();
    /* Nothing at all. */
    expect(readFlick(swipe(0, 0, 50))).toBeNull();
  });

  it('refuses a scrub that went out and came back', () => {
    /* Displacement of a flick, path of a scribble: 60 px of net movement
     * over 400 px of travel is a wander, however fast it was. */
    expect(readFlick(swipe(60, 0, 100, 400))).toBeNull();
    /* The same displacement travelled straight is a flick. */
    expect(readFlick(swipe(60, 0, 100, 62))).toBe('right');
  });

  it('sits exactly on its own thresholds', () => {
    const t = FLICK;
    /* One millisecond over the duration cap, and it is a look. */
    expect(readFlick(swipe(200, 0, t.maxMs))).not.toBeNull();
    expect(readFlick(swipe(200, 0, t.maxMs + 1))).toBeNull();
    /* One pixel under the reach, and it is a twitch. */
    expect(readFlick(swipe(t.minPx, 0, 50))).not.toBeNull();
    expect(readFlick(swipe(t.minPx - 1, 0, 50))).toBeNull();
  });

  it('settles a near-diagonal the same way every time', () => {
    /* 46 across against 44 down is a coin toss without the bias — and a
     * control that gives left one time and back the next is unusable. */
    expect(readFlick(swipe(46, 44, 90))).toBe('back');
    expect(readFlick(swipe(46, -44, 90))).toBe('forward');
    /* Clearly sideways still reads sideways. */
    expect(readFlick(swipe(60, 20, 90))).toBe('right');
    expect(readFlick(swipe(-60, 20, 90))).toBe('left');
  });

  it('takes its thresholds as an argument, for tuning on a phone', () => {
    const strict = { ...FLICK, minPxPerSec: 5000 };
    expect(readFlick(swipe(60, 0, 100))).toBe('right');
    expect(readFlick(swipe(60, 0, 100), strict)).toBeNull();
  });
});

describe('the burst it starts', () => {
  /** Integrate the sampled speed, which is what the scene actually moves by. */
  const carry = (dir: 'left' | 'right' | 'forward' | 'back', tune = DEFAULT_DODGE) => {
    const d = new Dodge(tune);
    expect(d.start(dir, MM)).toBe(true);
    let gone = 0;
    let frames = 0;
    let seconds = 0;
    const dt = 1 / 240;
    while (d.active) {
      const s = d.sample(dt);
      gone += s.speed * dt;
      seconds += dt;
      frames += 1;
      expect(frames).toBeLessThan(10000);
    }
    return { mm: gone * MM, seconds };
  };

  it('carries her the distance it was asked for, in the time it was given', () => {
    /*
     * WITHIN 2%, not to the digit. The speed profile integrates to the
     * asked distance in the continuous limit; sampled at the END of each
     * step it under-reads the eased tail slightly, and a quarter of a
     * second at 240 Hz leaves about one per cent on the table. On eleven
     * millimetres that is a tenth of one, which is a fiftieth of her body
     * — the wrong thing to spend a smaller timestep on.
     */
    for (const [dir, want] of [
      ['left', DEFAULT_DODGE.lateralMm], ['right', DEFAULT_DODGE.lateralMm],
      ['forward', DEFAULT_DODGE.forwardMm], ['back', DEFAULT_DODGE.backMm],
    ] as const) {
      const got = carry(dir);
      expect(Math.abs(got.mm - want) / want, `${dir} ${got.mm.toFixed(2)}mm`)
        .toBeLessThan(0.02);
      expect(got.seconds, dir).toBeCloseTo(DEFAULT_DODGE.seconds, 2);
    }
  });

  it('points the right way in HER frame, with no world axes anywhere', () => {
    const d = new Dodge();
    d.start('right', MM);
    expect(d.sample(0.01).side).toBe(1);
    d.cancel();
    d.start('left', MM);
    expect(d.sample(0.01).side).toBe(-1);
    d.cancel();
    d.start('forward', MM);
    expect(d.sample(0.01).forward).toBe(1);
    d.cancel();
    d.start('back', MM);
    expect(d.sample(0.01).forward).toBe(-1);
  });

  it('hands control back over the tail rather than dropping it', () => {
    const d = new Dodge();
    d.start('right', MM);
    const seen: number[] = [];
    while (d.active) seen.push(d.sample(1 / 120).authority);
    /* Full authority early, nothing by the end, and monotonic between. */
    expect(seen[0]).toBeCloseTo(1, 2);
    expect(seen[seen.length - 1]).toBeLessThan(0.05);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]! + 1e-9);
    }
  });

  it('is a burst, not a stroll — several times her run', () => {
    const d = new Dodge();
    d.start('right', MM);
    const peak = d.sample(1 / 240).speed * MM;
    /* Walk is 7.5 mm/s and a run 15; a dodge that does not clearly beat
     * both of them is not an evasion, it is a step. */
    expect(peak).toBeGreaterThan(30);
    expect(peak).toBeLessThan(120);
  });

  it('scales with the species and maturity knobs the RPG layer will set', () => {
    const big = carry('right', { ...DEFAULT_DODGE, speciesScale: 2 });
    expect(big.mm / (DEFAULT_DODGE.lateralMm * 2)).toBeCloseTo(1, 1);
    const young = carry('right', { ...DEFAULT_DODGE, maturityScale: 0.5 });
    expect(young.mm / (DEFAULT_DODGE.lateralMm * 0.5)).toBeCloseTo(1, 1);
  });

  it('honours a cooldown when one is set, and has none by default', () => {
    expect(DEFAULT_DODGE.cooldownSeconds).toBe(0);
    const d = new Dodge({ ...DEFAULT_DODGE, cooldownSeconds: 1 });
    expect(d.start('right', MM)).toBe(true);
    while (d.active) d.sample(1 / 120);
    /* Finished, but not yet allowed again. */
    expect(d.start('left', MM)).toBe(false);
    for (let i = 0; i < 130; i += 1) d.sample(1 / 120);
    expect(d.start('left', MM)).toBe(true);
  });

  it('reports nothing at all when idle, so the mixer is a no-op', () => {
    const d = new Dodge();
    const s = d.sample(1 / 60);
    expect(s.active).toBe(false);
    expect(s.authority).toBe(0);
    expect(s.speed).toBe(0);
    expect(s.forward).toBe(0);
    expect(s.side).toBe(0);
  });

  it('can be cancelled dead, for a dig arming mid-burst', () => {
    const d = new Dodge();
    d.start('forward', MM);
    d.sample(0.05);
    d.cancel();
    expect(d.active).toBe(false);
    expect(d.sample(1 / 60).authority).toBe(0);
  });
});

/*
 * THE DODGE BUTTON'S GESTURE. It answers a different question about
 * WHETHER a drag counts and must answer the identical one about WHICH WAY,
 * or the same thumb movement would dodge left off the plate and forward
 * off the canvas.
 */
describe('reading a nudge off the dodge button', () => {
  it('names the four directions the way the flick reader does', () => {
    expect(readNudge(60, 0)).toBe('right');
    expect(readNudge(-60, 0)).toBe('left');
    /* Screen y grows downward: a drag UP is forward. */
    expect(readNudge(0, -60)).toBe('forward');
    expect(readNudge(0, 60)).toBe('back');
  });

  it('agrees with the flick reader on every direction it accepts', () => {
    for (const [dx, dy] of [[60, 0], [-60, 0], [0, -60], [0, 60],
      [70, 30], [-70, 30], [30, -70], [-30, 70]] as [number, number][]) {
      const flick = readFlick({ dx, dy, travelPx: Math.hypot(dx, dy), ms: 100 });
      expect(flick).not.toBeNull();
      expect(readNudge(dx, dy)).toBe(flick);
    }
  });

  it('takes a SLOW deliberate drag, which the flick reader rejects', () => {
    /* The whole reason the button has its own reader: a press-aim-release
     * on a dedicated control is not a twitch, and demanding one would mean
     * "I pressed dodge and nothing happened". */
    const slow: Swipe = { dx: 0, dy: 60, travelPx: 60, ms: 900 };
    expect(readFlick(slow)).toBeNull();
    expect(readNudge(slow.dx, slow.dy)).toBe('back');
  });

  it('refuses a tap — a dodge with no direction is not a dodge', () => {
    expect(readNudge(0, 0)).toBeNull();
    expect(readNudge(NUDGE_PX - 1, 0)).toBeNull();
    expect(readNudge(NUDGE_PX + 1, 0)).toBe('right');
  });

  it('will not fire a second burst while one is in flight', () => {
    const d = new Dodge(DEFAULT_DODGE);
    expect(d.start(readNudge(60, 0)!, 5)).toBe(true);
    expect(d.start(readNudge(0, 60)!, 5)).toBe(false);
  });
});
