import { describe, expect, it, vi } from 'vitest';
import {
  RESTORE_GRACE_MS,
  guardContext,
  type ContextGuardClock,
} from '../src/render/contextGuard';

/** A stand-in canvas: the guard only ever asks for addEventListener. */
const canvas = (): EventTarget => new EventTarget();

const lose = (target: EventTarget): Event => {
  /* Cancelable, because the whole question is whether preventDefault is
   * called — an uncancelable event would let a broken guard pass. */
  const event = new Event('webglcontextlost', { cancelable: true });
  target.dispatchEvent(event);
  return event;
};

const restore = (target: EventTarget): void => {
  target.dispatchEvent(new Event('webglcontextrestored'));
};

/** A clock with a hand on it. */
function fakeClock(): ContextGuardClock & { run(): void; pending(): number } {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer(fn) {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    run() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
    pending() {
      return timers.size;
    },
  };
}

const hooks = () => ({
  onLost: vi.fn(),
  onRestored: vi.fn(),
  onAbandoned: vi.fn(),
});

describe('the lost-context guard', () => {
  /*
   * The one that cannot be got wrong: an unprevented webglcontextlost tells
   * the browser the page has given up, and webglcontextrestored is then never
   * sent at all. Everything else here is about what the player sees; this is
   * about whether recovery is possible in the first place.
   */
  it('prevents the default, or the context could never come back', () => {
    const el = canvas();
    guardContext(el, hooks(), fakeClock());
    expect(lose(el).defaultPrevented).toBe(true);
  });

  it('tells the scene at once, and does not give up in the same breath', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    expect(h.onLost).toHaveBeenCalledTimes(1);
    expect(h.onAbandoned).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1);
  });

  it('gives up only after the grace has run out', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    clock.run();
    expect(h.onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('says nothing at all when the context comes back in time', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    restore(el);
    expect(h.onRestored).toHaveBeenCalledTimes(1);
    /* The pending give-up must be cancelled, not merely ignored — otherwise
     * a scene that recovered gets told four seconds later that it did not. */
    expect(clock.pending()).toBe(0);
    clock.run();
    expect(h.onAbandoned).not.toHaveBeenCalled();
  });

  /*
   * A device that was thrashing can hand the context back long after anyone
   * expected it to. That is a recovery, and the scene has a banner up that
   * needs taking down.
   */
  it('still takes a restore that arrives after it gave up', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    clock.run();
    expect(h.onAbandoned).toHaveBeenCalledTimes(1);
    restore(el);
    expect(h.onRestored).toHaveBeenCalledTimes(1);
  });

  it('treats a repeated loss as the same loss', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    lose(el);
    expect(h.onLost).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(1);
  });

  it('ignores a restore that follows no loss', () => {
    const el = canvas();
    const h = hooks();
    guardContext(el, h, fakeClock());
    restore(el);
    expect(h.onRestored).not.toHaveBeenCalled();
  });

  it('can be lost, restored and lost again', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    guardContext(el, h, clock);
    lose(el);
    restore(el);
    lose(el);
    expect(h.onLost).toHaveBeenCalledTimes(2);
    clock.run();
    expect(h.onAbandoned).toHaveBeenCalledTimes(1);
  });

  it('lets go when told to, timer and all', () => {
    const el = canvas();
    const h = hooks();
    const clock = fakeClock();
    const stop = guardContext(el, h, clock);
    lose(el);
    stop();
    expect(clock.pending()).toBe(0);
    lose(el);
    expect(h.onLost).toHaveBeenCalledTimes(1);
  });

  it('waits a few seconds, not a few frames and not forever', () => {
    expect(RESTORE_GRACE_MS).toBeGreaterThan(1_000);
    expect(RESTORE_GRACE_MS).toBeLessThanOrEqual(10_000);
  });
});
