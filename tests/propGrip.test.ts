import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { carryVerdict } from '../src/scenes/mandibleReach';

import {
  Prop, PROP_SCATTER, PROP_SPECS, type PropGround,
} from '../src/scenes/islandProps';

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

  /**
   * The speed a roll settles at, in world units per second, measured the way
   * an eye measures it: how far it got over the last second, once it has had
   * long enough to stop accelerating.
   */
  const settledSpeed = (grade: number): number => {
    const p = seed();
    p.carried = false;
    const ground = sloped(grade);
    for (let i = 0; i < 240; i += 1) p.tick(ground, 1 / 60);
    const from = p.at.clone();
    for (let i = 0; i < 60; i += 1) p.tick(ground, 1 / 60);
    /* Distance ALONG THE SLOPE, not along x. On a steep bank most of the
     * travel is downwards, so measuring x alone reads a near-vertical face
     * as slower than a gentle one. */
    return p.at.distanceTo(from);
  };

  it('rolls FASTER down a steeper bank, rather than the same speed down all of them', () => {
    /*
     * Reported: "the physics on the rocks and objects are too constant
     * meaning it keeps moving at the same speed downhill or straight".
     *
     * Push against linear drag settles at push / drag * slope, which is
     * proportional to steepness and is the whole point — but the old ratio
     * put that above the speed cap for any slope past about 32 degrees, so
     * every real bank clamped to the same number and the CAP was the
     * physics.
     *
     * These three grades are roughly 17, 39 and 58 degrees. All three are
     * BANKS and not walls: past about 60 the contact stops being a floor
     * and `pushOut` treats it as something to stop against instead, which
     * is a different behaviour and not what this is measuring. An earlier
     * draft used 72 and was quietly testing the wall path.
     */
    const gentle = settledSpeed(0.3);
    const middling = settledSpeed(0.8);
    const steep = settledSpeed(1.6);
    expect(middling).toBeGreaterThan(gentle * 2);
    expect(steep).toBeGreaterThan(middling * 1.3);
  });

  it('never reaches the cap on ground the island actually has', () => {
    /* The clamp is a backstop against a degenerate normal or a spiked
     * frame. If a hill can reach it, it has become the tuning. Even a
     * near-vertical face must settle below it. */
    expect(settledSpeed(20)).toBeLessThan(2.6);
  });

  it('runs out and STOPS when a bank gives way to the flat', () => {
    /*
     * Asked: "do the objects have friction that will slow them down, so if
     * it was on a steep slope and gets to a flat part, will it naturally
     * slow down and stop based on friction and gravity, instead of still
     * crawling along?"
     *
     * There was friction, and it was the wrong kind: drag proportional to
     * speed decays exponentially and never lands. Measured on this exact
     * setup before the fix, distance covered in each second on the level:
     *
     *     0.25333  0.05161  0.01052  0.00214  0.00044  0.00006
     *
     * Visibly creeping into the third second. Constant rolling resistance
     * is what ends a roll, so the test is that it comes to a genuine,
     * early, PERMANENT stop rather than an ever-smaller drift.
     */
    const p = new Prop('stone', PROP_SPECS.stone!, 0, 0, 0);
    p.carried = false;
    const hill = sloped(3);
    for (let i = 0; i < 300; i += 1) p.tick(hill, 1 / 60);
    expect(p.speed).toBeGreaterThan(1);

    /* A level plane where it currently is, so the run-out is measured and
     * not a fall onto a floor that moved. */
    const y0 = p.at.y;
    const flat: PropGround = {
      floorUnder: () => y0,
      soilNormal: (_x, _y, _z, into) => { into.set(0, 1, 0); },
      insideBy: (_x, y) => y0 - y,
    };

    const from = p.at.x;
    for (let i = 0; i < 45; i += 1) p.tick(flat, 1 / 60);
    /*
     * WHERE IT IS, not what `speed` says. A prop at rest still reports a
     * fraction of a fall: it settles a hair, is pushed back out, and does
     * it again, so the fall term never sits at a clean zero. Position is
     * the thing the question was about and the thing that cannot lie.
     */
    const atThreeQuarters = p.at.x;
    for (let i = 0; i < 15; i += 1) p.tick(flat, 1 / 60);
    const firstSecond = p.at.x - from;
    /* Already still by three quarters of a second, and inside a body
     * length or so of ground: about 2.6 mm at MM = 5. */
    expect(p.at.x).toBe(atThreeQuarters);
    expect(firstSecond).toBeLessThan(0.75);

    /* And it stays stopped. The old curve was still moving here. */
    for (let i = 0; i < 300; i += 1) p.tick(flat, 1 / 60);
    expect(p.at.x).toBe(atThreeQuarters);
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

describe('how a loose thing is drawn', () => {
  /*
   * Reported: "leaf works, but only shows 1-sided." A leaf is one disc of
   * geometry with all its normals facing one way, so from underneath there
   * is nothing there — she picks it up, turns, and it vanishes.
   */
  const sideOf = (p: Prop): number | null => {
    let side: number | null = null;
    p.root.traverse((n) => {
      const mat = (n as THREE.Mesh).material as THREE.Material | undefined;
      if (mat && 'side' in mat) side = (mat as THREE.Material).side;
    });
    return side;
  };

  /*
   * THE LEAF HAS GONE, and with it the only double-sided case. Asked for:
   * "can drop the leaf until I get a real model." It was the one prop whose
   * stand-in shape was a flat disc, which is why it needed the rule at all.
   *
   * The test is not deleted so much as inverted: what has to hold now is
   * that NOTHING is drawn two-sided, because every remaining shape is
   * closed. When a leaf model arrives its sidedness will be a fact about
   * the mesh rather than about a circle, and this is where that gets said.
   */
  it('leaves every shape single-sided, now they are all closed', () => {
    /* You can never see the inside of a rock, so drawing it is fill rate
     * spent on nothing. The rule is about the SHAPE, not about props. */
    for (const key of Object.keys(PROP_SPECS)) {
      const spec = PROP_SPECS[key]!;
      expect(sideOf(new Prop(key, spec, 0, 0, 0))).toBe(THREE.FrontSide);
    }
  });

  it('has no leaf to draw', () => {
    expect(PROP_SPECS.leaf).toBeUndefined();
    expect(PROP_SCATTER.some((p) => p.key === 'leaf')).toBe(false);
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

/**
 * THE LOOSE THINGS WEAR REAL ART NOW.
 *
 * Asked for: "can you replace the procedural objects with the real glb
 * models now like the twig, rock, dirt, etc. Can drop the leaf for now
 * until I get a real model."
 *
 * What is testable without a browser is the WIRING — that every model named
 * is a file that exists, that the two rocks share one download, and that
 * the ones with no art still have a shape to fall back on. The dressing
 * itself needs a GL context and is measured by `probe:props`.
 */
describe('the props that have models', () => {
  const models = Object.entries(PROP_SPECS)
    .filter(([, s]) => !!s.model);

  it('names a file that is actually in the build', () => {
    expect(models.length).toBeGreaterThan(0);
    for (const [key, spec] of models) {
      const path = resolve(__dirname, '..', 'public', 'models', spec.model!);
      expect(existsSync(path), `${key} -> ${spec.model}`).toBe(true);
    }
  });

  it('fetches one file per model, not one per prop', () => {
    /* The pebble and the stone are the same rock at two sizes. A loop that
     * downloaded per PROP would fetch it twice and build two copies of one
     * geometry — see the `Set` in `spawnProps`. */
    expect(PROP_SPECS.pebble!.model).toBe(PROP_SPECS.stone!.model);
    const files = new Set(models.map(([, s]) => s.model));
    expect(files.size).toBeLessThan(models.length);
  });

  it('still builds a stand-in shape for every one of them', () => {
    /* The model arrives over the network and may never arrive at all. A
     * prop that drew nothing until it did would be a thing she can walk
     * into and cannot see. */
    for (const [key, spec] of Object.entries(PROP_SPECS)) {
      const p = new Prop(key, spec, 0, 0, 0);
      let meshes = 0;
      p.root.traverse((n) => { if ((n as THREE.Mesh).isMesh) meshes += 1; });
      expect(meshes, key).toBeGreaterThan(0);
      /* And it collides, on its own shape, before any art lands. */
      expect(p.hullForTest.length, key).toBeGreaterThan(0);
    }
  });

  it('scatters every kind it defines, and only kinds it defines', () => {
    for (const { key } of PROP_SCATTER) {
      expect(PROP_SPECS[key], key).toBeDefined();
    }
    /* The clod took the leaf's place on the ground rather than the set
     * quietly shrinking by one. */
    expect(PROP_SCATTER.some((p) => p.key === 'clod')).toBe(true);
  });
});

/**
 * THE CLOD IS THE HEAVIEST THING SHE CAN STILL CARRY.
 *
 * Not decoration: the set had a gap. Seed, crumb and twig are all well
 * inside a queen's 20 mg carry limit and the pebble at 22 is just outside
 * it, so nothing sat at the top of the carry band where the pace taper
 * actually bites and where the meter's amber stop now sits.
 */
describe('the dirt clod', () => {
  it('is carried, not dragged, by a queen', () => {
    expect(carryVerdict(PROP_SPECS.clod!.massMg, 'queen').mode).toBe('carry');
  });

  it('is the heaviest thing on the island that is', () => {
    const carried = Object.values(PROP_SPECS)
      .filter((s) => carryVerdict(s.massMg, 'queen').mode === 'carry');
    expect(Math.max(...carried.map((s) => s.massMg))).toBe(PROP_SPECS.clod!.massMg);
  });

  it('is too much for a worker, who has to drag it', () => {
    /* A worker carries 6 mg. The same object being a carry for the queen
     * and a drag for a worker is the caste table doing its job. */
    expect(carryVerdict(PROP_SPECS.clod!.massMg, 'worker').mode).toBe('drag');
  });
});
