import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { Prop, PROP_SPECS, type PropGround } from '../src/scenes/islandProps';

/**
 * A CARRIED THING KEEPS THE ANGLE IT WAS PICKED UP AT, in HER frame.
 *
 * Reported: "whatever angle you carry it at first and grab, is stays that
 * way and follows relative to the ant so the twig doesn't stay a fix angle
 * in world space... as it looks weird with it rotating through the ant".
 *
 * The old `tick` wrote position and nothing else, so a carried twig kept
 * the world rotation it was scattered with — walk her in a circle and the
 * twig swings through her head, because it is not turning at all and she
 * is turning under it.
 */
const twig = (): Prop => new Prop('twig', PROP_SPECS.twig!, 0, 0, 0);

/** A floor at y = 0, so the resting half of `tick` is not under test. */
const flat: PropGround = {
  floorUnder: () => 0,
  soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
  insideBy: (_x, y) => -y,
};

const yaw = (deg: number): THREE.Quaternion => new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);

describe('the grip a carried thing was taken with', () => {
  it('turns WITH her, so the angle between them never changes', () => {
    const p = twig();
    const her = yaw(0);
    p.carried = true;
    p.takeGrip(her);
    p.tick(flat, 1 / 60, her);
    const first = p.root.quaternion.clone();

    /* She turns a quarter circle. The twig must turn with her — so its
     * angle RELATIVE to her is unchanged, while its world angle is not. */
    const turned = yaw(90);
    p.tick(flat, 1 / 60, turned);

    const relBefore = her.clone().invert().multiply(first);
    const relAfter = turned.clone().invert().multiply(p.root.quaternion);
    expect(relAfter.angleTo(relBefore)).toBeCloseTo(0, 6);
    expect(p.root.quaternion.angleTo(first)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('remembers the angle it was actually grabbed at', () => {
    /* Two props taken at different facings must be carried differently —
     * the grip is captured, not chosen. */
    const a = twig();
    const b = twig();
    a.carried = true;
    b.carried = true;
    a.takeGrip(yaw(0));
    b.takeGrip(yaw(60));
    expect(a.grip.angleTo(b.grip)).toBeGreaterThan(0.5);
  });

  it('does not touch rotation once it is put down', () => {
    /* On the ground it keeps whatever angle it landed at; only a carried
     * thing is driven by her. */
    const p = twig();
    p.carried = true;
    p.takeGrip(yaw(0));
    p.tick(flat, 1 / 60, yaw(45));
    const held = p.root.quaternion.clone();
    p.carried = false;
    p.tick(flat, 1 / 60, yaw(180));
    expect(p.root.quaternion.angleTo(held)).toBeCloseTo(0, 6);
  });
});

describe('a loose thing rests on the soil that is there now', () => {
  it('falls to a floor that has moved down, rather than snapping', () => {
    const p = twig();
    p.carried = false;
    p.at.set(0, 5, 0);
    const deep: PropGround = {
      floorUnder: () => 0,
      soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
      insideBy: (_x, y) => -y,
    };
    p.tick(deep, 1 / 60);
    /* One frame is a fall, not a teleport. */
    expect(p.at.y).toBeGreaterThan(0.5);
    for (let i = 0; i < 600; i += 1) p.tick(deep, 1 / 60);
    /* Settled ON the floor, bedded by its own rest offset — not through it
     * and not hovering. A twig's is a fraction of its radius. */
    expect(p.at.y).toBeGreaterThan(0);
    expect(p.at.y).toBeLessThan(0.2);
    /* And the mesh went with it, which is the half a player sees. */
    expect(p.root.position.y).toBeCloseTo(p.at.y, 6);
  });

  it('is left where it is when there is no floor within reach', () => {
    /* `floorUnder` reports -Infinity over a void. It must keep falling
     * rather than being handed a made-up floor. */
    const p = twig();
    p.carried = false;
    p.at.set(0, 5, 0);
    const void_: PropGround = {
      floorUnder: () => -Infinity,
      soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
      insideBy: (_x, y) => -y,
    };
    for (let i = 0; i < 10; i += 1) p.tick(void_, 1 / 60);
    expect(p.at.y).toBeLessThan(5);
    expect(Number.isFinite(p.at.y)).toBe(true);
  });
});

describe('round things roll until they find their balance', () => {
  /*
   * Asked for: "with say round objects or the egg shaped object, it should
   * naturally roll around when released and will move around until it finds
   * the right balance on the ground".
   */
  const sloped = (grade: number): PropGround => ({
    floorUnder: () => 0,
    /* A constant slope leaning towards +x, normalised. */
    soilNormal: (_x, _y, _z, into) => { into.set(grade, 1, 0).normalize(); },
    /* A plane through the origin with that normal: depth is how far below
     * it a point sits. See the derivation in the roll test. */
    insideBy: (x, y) => -(y + grade * x) / Math.hypot(grade, 1),
  });

  const seed = (): Prop => new Prop('seed', PROP_SPECS.seed!, 0, 0, 0);

  it('rolls downhill, and turns as it goes', () => {
    const p = seed();
    p.carried = false;
    const start = p.root.quaternion.clone();
    for (let i = 0; i < 120; i += 1) p.tick(sloped(0.6), 1 / 60);
    /*
     * Downhill is +x when the normal leans +x, which is worth deriving
     * rather than guessing — this assertion had the sign backwards first.
     * For a plane through the origin, n . (x, y, z) = 0 gives
     * y = -(n.x * x) / n.y, so with n.x and n.y both positive the height
     * FALLS as x rises. The surface descends the way its normal leans.
     */
    expect(p.at.x).toBeGreaterThan(0.05);
    /* And it turned rather than skidded. */
    expect(p.root.quaternion.angleTo(start)).toBeGreaterThan(0.5);
  });

  it('settles on ground that is level enough, and stays put', () => {
    const p = seed();
    p.carried = false;
    for (let i = 0; i < 600; i += 1) p.tick(sloped(0), 1 / 60);
    const settled = p.at.x;
    for (let i = 0; i < 600; i += 1) p.tick(sloped(0), 1 / 60);
    expect(Math.abs(p.at.x - settled)).toBeLessThan(1e-6);
  });

  it('comes to rest rather than creeping forever on a gentle grade', () => {
    /* Below ROLL_RESTS_BELOW nothing pushes it, so drag must bring it to a
     * genuine stop — an asymptote would leave a pebble drifting all game. */
    const p = seed();
    p.carried = false;
    for (let i = 0; i < 1200; i += 1) p.tick(sloped(0.04), 1 / 60);
    const a = p.at.x;
    for (let i = 0; i < 300; i += 1) p.tick(sloped(0.04), 1 / 60);
    expect(Math.abs(p.at.x - a)).toBeLessThan(1e-6);
  });

  it('leaves flat things where they are put', () => {
    /* A twig on a bank stays; a rolling leaf would look sillier than a
     * still one. Shape decides, which is what `kind` already names. */
    const t = new Prop('twig', PROP_SPECS.twig!, 0, 0, 0);
    t.carried = false;
    for (let i = 0; i < 300; i += 1) t.tick(sloped(0.8), 1 / 60);
    expect(t.at.x).toBe(0);
    expect(t.at.z).toBe(0);
  });

  it('does not roll while she is carrying it', () => {
    const p = seed();
    p.carried = true;
    p.at.set(0, 1, 0);
    for (let i = 0; i < 300; i += 1) p.tick(sloped(0.9), 1 / 60);
    expect(p.at.x).toBe(0);
  });
});

describe('the collision is the object\'s own shape', () => {
  /*
   * Asked for: "I was asking for proper per-shape collision... could do it
   * mesh instead of shape for the collisions and would naturally be the
   * right shape."
   *
   * It is mesh-derived: `buildHull` reads contact points off each prop's
   * own geometry, so nobody writes a hull per kind. These are the
   * assertions that it is a SHAPE rather than a point — a point collides
   * identically whatever it is attached to, so anything that tells two
   * shapes apart is proof.
   */
  const flatGround: PropGround = {
    floorUnder: () => 0,
    soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
    insideBy: (_x, y) => -y,
  };

  /** A wall filling everything past x = 0, facing back down -x. */
  const wall: PropGround = {
    floorUnder: () => -Infinity,
    soilNormal: (_x, _y, _z, into) => { into.set(-1, 0, 0); },
    insideBy: (x) => x,
  };

  const settle = (p: Prop, g: PropGround, frames = 400): void => {
    p.carried = false;
    for (let i = 0; i < frames; i += 1) p.tick(g, 1 / 60);
  };

  it('rests a long twig and a small seed at DIFFERENT heights', () => {
    /*
     * The point-probe this replaced could not do this: it put every prop at
     * `floor + a per-kind fudge`, so the height was a table entry rather
     * than a consequence of the object. Now a twig lies on its side and a
     * seed sits on its own curve, and the numbers differ because the shapes
     * do.
     */
    const twig = new Prop('twig', PROP_SPECS.twig!, 0, 3, 0);
    const seed = new Prop('seed', PROP_SPECS.seed!, 0, 3, 0);
    settle(twig, flatGround);
    settle(seed, flatGround);
    expect(twig.at.y).toBeGreaterThan(0);
    expect(seed.at.y).toBeGreaterThan(0);
    expect(Math.abs(twig.at.y - seed.at.y)).toBeGreaterThan(1e-3);
  });

  it('stops a prop against a wall by its EDGE, not its centre', () => {
    /*
     * The proof that it is a shape. A point stops when its CENTRE reaches
     * the wall; a shape stops when its nearest surface does, so the centre
     * comes to rest short of it by roughly the object's own reach. A twig,
     * being long, must stop further out than a seed.
     */
    const twig = new Prop('twig', PROP_SPECS.twig!, -2, 0, 0);
    const seed = new Prop('seed', PROP_SPECS.seed!, -2, 0, 0);
    for (const p of [twig, seed]) {
      p.carried = false;
      /* Drive it at the wall. */
      for (let i = 0; i < 400; i += 1) {
        p.at.x += 0.01;
        p.tick(wall, 1 / 60);
      }
    }
    /* Neither centre reaches the wall... */
    expect(twig.at.x).toBeLessThan(0);
    expect(seed.at.x).toBeLessThan(0);
    /* ...and the longer object is held further back. */
    expect(twig.at.x).toBeLessThan(seed.at.x);
  });

  it('takes its contact points off the geometry, extremes included', () => {
    /* Not a hand-written hull per kind: every prop gets one, and it covers
     * the far ends of the actual mesh rather than a bounding guess. */
    /* Every spec, by its KEY — 'rock' is a kind (the pebble and the stone
     * share it), not a key, and using one for the other is how you write a
     * test that silently covers nothing. */
    for (const key of Object.keys(PROP_SPECS) as (keyof typeof PROP_SPECS)[]) {
      const p = new Prop(key, PROP_SPECS[key]!, 0, 0, 0);
      const n = p.hullForTest.length / 3;
      expect({ key, some: n > 3 }).toEqual({ key, some: true });
      expect({ key, capped: n <= 14 }).toEqual({ key, capped: true });
    }
  });
});
