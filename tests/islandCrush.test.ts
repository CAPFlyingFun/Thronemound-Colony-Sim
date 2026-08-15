import { describe, expect, it } from 'vitest';
import {
  CRUSH_FREE, CRUSH_FULL, CRUSH_SHARE, crushDamage,
} from '../src/scenes/islandCrush';

const HEALTH = 100;

describe('being run over', () => {
  /*
   * Asked for: "we should like take some HP loss if like getting run over by
   * a heavy rock or something, maybe like 30% since ants' bodies are
   * flexible but too much will obviously kill/injure them greatly".
   */
  it('costs the asked-for 30% for a stone at a full roll', () => {
    /* 120 mg at the 1.8 a stone settles at on a steep bank. */
    expect(crushDamage(120, 1.8, HEALTH)).toBeCloseTo(30, 5);
  });

  it('costs nothing at all for the small stuff she shoves about all day', () => {
    /* A 3 mg seed at a full roll is 5 units of momentum against a free band
     * of 25. She pushes seeds around constantly and none of it is an
     * injury — a bar that ticks down every time she brushes something is a
     * bar the player learns to ignore. */
    expect(crushDamage(3, 1.8, HEALTH)).toBe(0);
    /* A 22 mg pebble rolling gently, likewise. */
    expect(crushDamage(22, 0.5, HEALTH)).toBe(0);
  });

  it('costs nothing for a heavy thing that is not moving', () => {
    /* Standing against a stone is not being crushed by it. Mass alone must
     * not hurt, or resting beside one would be fatal. */
    expect(crushDamage(120, 0, HEALTH)).toBe(0);
  });

  it('flattens, so twice the impact is nothing like twice the harm', () => {
    /*
     * A straight line was the first attempt and the live probe killed her
     * with it: a stone falls at up to 6 against a roll of 1.8, so a drop of
     * fifteen millimetres came to 109% of the bar. The curve is concave
     * because a cuticle CRUMPLES — each further increment of impulse is
     * absorbed a little better than the last.
     */
    const once = crushDamage(120, 1.8, HEALTH);
    const twice = crushDamage(240, 1.8, HEALTH);
    expect(twice).toBeLessThan(once * 1.6);
    expect(twice).toBeGreaterThan(once);
  });

  it('makes a rock dropped on her a severe injury, not an instant death', () => {
    /* A stone at the fall cap of 6. Measured before the curve was made
     * concave: 100 damage from full health, off a ledge a body-length up. */
    const dropped = crushDamage(120, 6, HEALTH);
    expect(dropped).toBeGreaterThan(HEALTH * 0.5);
    expect(dropped).toBeLessThan(HEALTH * 0.7);
  });

  it('hurts a small ant more than a large one, for the same rock', () => {
    /* The curve is a FRACTION of health, so a nanitic with a smaller pool
     * loses less in points and the same share of what it has. That is the
     * right way round: the flexibility being modelled is the cuticle's, and
     * it does not get better with size. */
    expect(crushDamage(120, 1.8, 40)).toBeCloseTo(12, 5);
    expect(crushDamage(120, 1.8, 40) / 40).toBeCloseTo(CRUSH_SHARE, 5);
  });

  it('will kill, if something heavy enough ever exists', () => {
    /*
     * "Too much will obviously kill/injure them greatly." Nothing on the
     * island reaches this today — the worst it holds is a stone dropped on
     * her — but the curve must not quietly refuse, or its own numbers are a
     * lie. A kill needs about 2,150: roughly a 360 mg thing at a full fall.
     */
    expect(crushDamage(360, 6, HEALTH)).toBe(HEALTH);
    expect(crushDamage(120, 6, HEALTH)).toBeLessThan(HEALTH);
  });

  it('never returns more than the bar holds, or less than nothing', () => {
    expect(crushDamage(1e6, 1e6, HEALTH)).toBe(HEALTH);
    expect(crushDamage(-5, 2, HEALTH)).toBe(0);
    expect(crushDamage(120, -2, HEALTH)).toBe(0);
  });

  it('is exactly zero at the edge of the free band, not a sliver', () => {
    expect(crushDamage(CRUSH_FREE, 1, HEALTH)).toBe(0);
    expect(crushDamage(CRUSH_FREE + 1, 1, HEALTH)).toBeGreaterThan(0);
  });

  it('keeps the stone that sets the curve honest', () => {
    /* CRUSH_FULL is written as 120 x 1.8 — the stone's mass times the speed
     * islandProps settles it at. If either moves and this is not revisited,
     * "30% for a rock" quietly becomes some other number. */
    expect(CRUSH_FULL).toBeCloseTo(216, 5);
  });
});
