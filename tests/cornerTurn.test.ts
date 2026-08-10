/**
 * THE CORNER, WITHOUT A TREE AND WITHOUT A RENDERER.
 *
 * The world here is a floor and a wall — two half-spaces and nothing else.
 * That is deliberate: everything the scheduler is allowed to know is "a
 * surface, and which way it faces", so if any of this needed a trunk the
 * design would be wrong. The same tests are the ground-to-rock-wall case,
 * the tunnel-floor-to-wall case, and (by handing them a frame that is not
 * world Y) the wall-to-ceiling one.
 *
 * ## No doubles
 *
 * `LegDrive` does not own her attitude — `SurfaceWalker` does — so these runs
 * use the real walker, and a frame here is exactly what a frame is on the
 * island: the legs move her, the walker seats her. That coupling IS the
 * corner. An earlier version of this file stood in for the walker with a
 * hand-rolled ease, and the harness quietly walked her through the wall,
 * which no amount of scheduling could have survived.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HANDOFF_GRACE, LegDrive, type DriveInput, type Ground, type LegSetup,
} from '../src/anim/legDrive';
import { CORNER_DEG, rowsFromHomes } from '../src/anim/cornerTurn';
import { SurfaceWalker } from '../src/world/surfaceWalk';

const MM = 5;

/**
 * The queen's own legs, as `scripts/shot-corner.mjs` read them off her rig.
 * Real numbers rather than a tidy hexagon, because the reach margins these
 * produce are what the front-leg choice is decided on.
 */
const HOMES: Array<[string, number, number, number, number]> = [
  ['frontLeft', -1.796, 0.308, 3.796, 2.982],
  ['frontRight', 1.833, 0.308, 3.796, 3.000],
  ['midLeft', -3.574, 0.234, 0.093, 3.364],
  ['midRight', 3.611, 0.234, 0.093, 3.398],
  ['rearLeft', -2.314, 0.234, -3.611, 4.100],
  ['rearRight', 2.352, 0.234, -3.611, 4.117],
];

/** Her origin rests a hair BELOW the contact — the rig's own rest height. */
const RIDE = -0.259 / MM;

const setup = (): LegSetup[] => HOMES.map(([slot, x, y, z, reach]) => ({
  slot,
  home: new THREE.Vector3(x / MM, y / MM, z / MM),
  reach: reach / MM,
}));

/* ------------------------------------------------------------ the world */

/**
 * A floor and a wall — two half-spaces, in axes the caller chooses, walked
 * by the REAL `SurfaceWalker`.
 *
 * Handing the drive a hand-rolled world was a mistake worth recording: with
 * nothing seating her body, she walked straight through the wall and the
 * corner could never finish, so the harness was measuring its own missing
 * collision. The walker is the thing that owns her attitude and her seat on
 * the island, and a corner is precisely a negotiation between it and the
 * legs — leaving it out tests neither half.
 *
 * Nothing here is a tree. Give it a different `up` and `ahead` and the same
 * two half-spaces are a wall and a ceiling.
 */
function corner(wallMm: number, opts: {
  up?: THREE.Vector3; ahead?: THREE.Vector3; wall?: boolean;
} = {}) {
  const up = (opts.up ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const ahead = (opts.ahead ?? new THREE.Vector3(0, 0, 1)).clone().normalize();
  const wallN = ahead.clone().negate();
  const wallAt = wallMm / MM;
  /** Mutable, so a target can be taken away mid-run without a new walker. */
  const state = { wall: opts.wall ?? true };

  /* Signed, positive inside; a union is the larger of the two, exactly as
   * the island unions its soil with its wood. */
  const P = new THREE.Vector3();
  const density = (x: number, y: number, z: number): number => {
    P.set(x, y, z);
    const floor = -P.dot(up);
    return state.wall ? Math.max(floor, P.dot(ahead) - wallAt) : floor;
  };
  const solid = (x: number, y: number, z: number): boolean => density(x, y, z) > 0;

  const walker = new SurfaceWalker(density, {
    cell: 0.2, ride: RIDE, gripLift: 3 / MM, gripReach: 9 / MM,
    align: 12, maxTiltRate: (240 * Math.PI) / 180,
    tiltAccel: (2400 * Math.PI) / 180, snap: 14, deadband: 0.06,
    gravity: 9,
  }, solid);

  const S = new THREE.Vector3();
  const ground: Ground & { probes: number } = {
    probes: 0,
    nearest: (at, u, down, rise) => walker.cast(
      S.copy(at).addScaledVector(u, rise).clone(), u.clone().negate(), rise + down,
    ),
    probeContact(origin, dir, maxDistance) {
      ground.probes += 1;
      /* The defect this exists to fix: a ray that starts inside something
       * reports a hit at zero range, which is a foothold inside the wall. */
      if (walker.solidAt(origin.x, origin.y, origin.z)) return null;
      const hit = walker.cast(origin, dir, maxDistance);
      if (!hit) return null;
      const normal = new THREE.Vector3();
      walker.normalAt(hit, normal);
      return { point: hit, normal };
    },
  };
  return { ground, walker, up, ahead, wallN, wallAt, state, solid };
}

/** A floor and no wall at all. */
const openGround = () => corner(0, { wall: false });

/* ------------------------------------------------------------- the runs */

interface Snap {
  frame: number;
  phase: string;
  onNew: number;
  onOld: number;
  planted: number;
  swinging: string | null;
  turnDeg: number;
  /** Feet that left the surface THIS frame, whatever released them. */
  released: string[];
  owner: Record<string, string>;
  state: Record<string, string>;
  at: THREE.Vector3;
  up: THREE.Vector3;
}

interface RunOpts {
  frames?: number;
  walk?: number;
  speedMm?: number;
  mayTransition?: boolean;
  world?: ReturnType<typeof corner>;
  startMm?: number;
  /** Her heading, when it is not square to the wall. World frame. */
  facing?: THREE.Vector3;
}

function rig(o: RunOpts = {}) {
  const world = o.world ?? corner(0);
  const drive = new LegDrive(setup());
  /* Built from the WORLD'S axes, not from world Y — the whole point of the
   * frame test is that neither this nor the scheduler knows which way is up. */
  const forward = (o.facing ?? world.ahead).clone();
  forward.addScaledVector(world.up, -forward.dot(world.up)).normalize();
  const body = {
    /* Her soles on the floor: the rig rests them 0.26 mm below her origin. */
    at: world.ahead.clone().multiplyScalar(world.wallAt - (o.startMm ?? 8) / MM)
      .addScaledVector(world.up, RIDE),
    up: world.up.clone(),
    forward,
  };
  drive.plantAll(body, world.ground);
  const input: DriveInput = {
    walk: o.walk ?? 1,
    yaw: 0,
    speed: (o.speedMm ?? 7.5) / MM,
    yawRate: 2.53,
    spin: false,
    /* The walker seats her, as it does on the island. */
    settle: false,
    mayTransition: o.mayTransition ?? true,
  };
  return { world, drive, body, input };
}

/** One frame of the coupled system: the legs move her, the walker seats her. */
function tick(r: ReturnType<typeof rig>) {
  const report = r.drive.step(1 / 60, r.body, r.input, r.world.ground);
  r.world.walker.settle(r.body, 1 / 60);
  return report;
}

function walkAt(o: RunOpts = {}) {
  const r = rig(o);
  const track: Snap[] = [];
  let was: Record<string, string> = {};
  for (let f = 0; f < (o.frames ?? 600); f += 1) {
    const c = tick(r).corner;
    const owner: Record<string, string> = {};
    const state: Record<string, string> = {};
    const released: string[] = [];
    for (const foot of c.feet) {
      owner[foot.slot] = foot.owner;
      state[foot.slot] = foot.state;
      if (was[foot.slot] === 'PLANT' && foot.state !== 'PLANT') released.push(foot.slot);
    }
    was = state;
    track.push({
      frame: f,
      phase: c.phase,
      onNew: c.onNew,
      onOld: c.onOld,
      planted: c.planted,
      swinging: c.swinging,
      turnDeg: c.turnDeg,
      released,
      owner,
      state,
      at: r.body.at.clone(),
      up: r.body.up.clone(),
    });
  }
  return { track, ...r };
}

const last = (t: Snap[]) => t[t.length - 1]!;
const reached = (t: Snap[], onNew: number) => t.find((s) => s.onNew >= onNew);
/**
 * The frame the corner FINISHED — which is the frame nothing was left
 * standing on the surface she came from AND every foot had been carried
 * across at least once, not the frame all six happened to carry the new
 * label. One foot is nearly always in the air.
 */
const finished = (t: Snap[]) => t.findIndex((s) => s.phase === 'settle');

/* ------------------------------------------------------------ the tests */

describe('arming: no grip, no climb', () => {
  it('does nothing at all on open ground, however hard she walks', () => {
    const { track } = walkAt({ world: openGround(), frames: 240 });
    for (const s of track) {
      expect(s.phase, `armed at frame ${s.frame}`).toBe('normal');
      expect(s.onNew).toBe(0);
    }
    /* And her frame is untouched: a scheduler that never ran cannot have
     * turned her. */
    expect(last(track).up.y).toBeCloseTo(1, 9);
  });

  it('does not arm at a steep wall she cannot yet reach', () => {
    /*
     * Her front foot homes sit 3.80 mm ahead of her centre with 2.82 mm of
     * spread, so at a 10 mm gap the wall is 6.2 mm off — inside the 12 mm
     * look-ahead, so she can SEE it, and well outside her legs. Seeing is
     * not gripping.
     */
    const { track } = walkAt({ frames: 2, startMm: 10 });
    expect(track[0]!.phase).toBe('normal');
    expect(track[0]!.onNew).toBe(0);
  });

  it('arms once a front foot can actually touch it', () => {
    const { track } = walkAt({ frames: 240 });
    const armed = track.find((s) => s.phase !== 'normal');
    expect(armed, 'never armed').toBeTruthy();
    expect(armed!.phase).toBe('acquireFront');
    /* And it armed at a real corner: ninety degrees between the two. */
    const turning = track.find((s) => s.turnDeg > 0);
    expect(turning!.turnDeg).toBeGreaterThanOrEqual(CORNER_DEG.enter);
  });

  it('never arms while the caller vetoes it — a dodge is not a decision', () => {
    const { track } = walkAt({ frames: 240, mayTransition: false });
    for (const s of track) expect(s.phase).toBe('normal');
    expect(last(track).onNew).toBe(0);
  });

  it('is not bypassed by speed — a sprint reaches for the same contact', () => {
    /* Twice the walk. If contact acquisition were anything but reach-driven,
     * a run would arrive on the wall without having gripped it. */
    const fast = walkAt({ frames: 400, speedMm: 14.9 });
    for (const s of fast.track) {
      /* Nothing is ever labelled NEW without having been the scheduled foot
       * first — no foot appears on the wall by arriving fast. */
      if (s.onNew > 0) expect(s.turnDeg).toBeGreaterThanOrEqual(CORNER_DEG.exit);
    }
    expect(reached(fast.track, 1), 'a run never gripped').toBeTruthy();
  });

  it('refuses a foothold whose probe starts inside the surface', () => {
    /* The measured defect, held directly: a cast from inside the wood
     * returns its own origin, and that must read as NO CONTACT. */
    const w = corner(0);
    const inside = w.ahead.clone().multiplyScalar(w.wallAt + 1 / MM);
    expect(w.solid(inside.x, inside.y, inside.z)).toBe(true);
    expect(w.ground.probeContact!(inside, w.ahead.clone().negate(), 2)).toBeNull();
  });
});

describe('the queue', () => {
  it('lifts one foot at a time, never a tripod', () => {
    const { track } = walkAt({ frames: 600 });
    for (const s of track) {
      if (s.phase === 'normal') continue;
      expect(s.released.length, `${s.released.join(',')} let go together at ${s.frame}`)
        .toBeLessThanOrEqual(1);
    }
  });

  /*
   * The queue's discipline is judged from its FIRST RELEASE, not from the
   * arming frame. Arming no longer waits for a standing start — the fold is
   * reachable for barely a gait cycle on the way down, and the old all-six
   * gate meant the tripod could carry her straight past it into the floor —
   * so the first armed frames may inherit up to three ordinary swings
   * mid-flight. The queue releases nothing until every one of them is down;
   * from that release onward the old contract holds untouched.
   */
  const afterFirstRelease = (track: ReturnType<typeof walkAt>['track']) => {
    const first = track.findIndex((s) => s.phase !== 'normal' && s.released.length > 0);
    expect(first, 'the queue never released a foot').toBeGreaterThanOrEqual(0);
    return track.slice(first);
  };

  it('flies at most the crossing and one companion — and crosses the front alone', () => {
    /*
     * The overlap contract. A crossing may carry ONE ordinary step under it
     * — that is what buys back the corner's speed — but never two, and
     * never while the front row is still being acquired: hurrying
     * `acquireFront` is the one thing every attempt has shown jams her on
     * the descent.
     */
    const { track } = walkAt({ frames: 600 });
    for (const s of afterFirstRelease(track)) {
      if (s.phase === 'normal') continue;
      const up = Object.values(s.state).filter((v) => v !== 'PLANT').length;
      const cap = s.phase === 'acquireFront' || s.phase === 'recover' ? 1 : 2;
      expect(up, `${up} feet in the air in ${s.phase} at frame ${s.frame}`)
        .toBeLessThanOrEqual(cap);
    }
  });

  it('keeps at least four feet on a surface, always', () => {
    const { track } = walkAt({ frames: 600 });
    for (const s of afterFirstRelease(track)) {
      if (s.phase === 'normal') continue;
      expect(s.planted, `only ${s.planted} down at frame ${s.frame}`)
        .toBeGreaterThanOrEqual(4);
    }
  });

  it('inherits mid-flight feet at arming but releases nothing until they land', () => {
    /* The relaxation itself, held: any armed frame with more than TWO feet
     * in the air (the crossing plus its one companion) is carrying
     * INHERITED swings — the queue must not have let go of anything yet. */
    const { track } = walkAt({ frames: 600 });
    let released = 0;
    for (const s of track) {
      if (s.phase === 'normal') continue;
      released += s.released.length;
      const up = Object.values(s.state).filter((v) => v !== 'PLANT').length;
      if (up > 2) expect(released, `released under ${up} airborne at ${s.frame}`).toBe(0);
    }
  });

  it('reaches two new and four old before it touches a middle leg', () => {
    const { track } = walkAt({ frames: 600 });
    const twoUp = reached(track, 2);
    expect(twoUp, 'never got two feet across').toBeTruthy();
    /* Both of them are the leading row, and everything else is still OLD. */
    const rows = rowsFromHomes(setup().map((l) => ({ slot: l.slot, home: l.home })));
    for (const slot of rows[0]!) expect(twoUp!.owner[slot]).toBe('new');
    for (const row of rows.slice(1)) {
      for (const slot of row) expect(twoUp!.owner[slot]).toBe('old');
    }
    /*
     * Two new and four old is a claim about SURFACE OWNERSHIP, not about how
     * many feet happen to be down on the frame it is read — one of the four
     * may be mid-step on the old floor. So: two across, four still belonging
     * to the surface she came from, and the counts add up to what is planted.
     */
    expect(twoUp!.onNew).toBe(2);
    expect(twoUp!.onNew + twoUp!.onOld).toBe(twoUp!.planted);
    expect(Object.values(twoUp!.owner).filter((o) => o === 'old')).toHaveLength(4);
  });

  it('takes the middles one at a time, then the rears', () => {
    const { track } = walkAt({ frames: 900 });
    const rows = rowsFromHomes(setup().map((l) => ({ slot: l.slot, home: l.home })));
    const four = reached(track, 4);
    expect(four, 'never got four feet across').toBeTruthy();
    for (const slot of rows[1]!) expect(four!.owner[slot]).toBe('new');
    for (const slot of rows[2]!) expect(four!.owner[slot]).toBe('old');
    /* And the rear row goes last, and it does go. */
    const end = finished(track);
    expect(end, 'the corner never finished').toBeGreaterThan(0);
    expect(track[end]!.onOld, 'still standing on the old surface').toBe(0);
    /* Strictly after the middles: the row indices are a queue, not a hint. */
    expect(end).toBeGreaterThan(track.indexOf(four!));
    /* Every rear foot got there by being SCHEDULED, never by arriving. */
    for (const slot of rows[2]!) {
      expect(track.some((s) => s.swinging === slot), `${slot} never reached`).toBe(true);
    }
  });

  it('chooses the front foot by reach, not by a fixed order', () => {
    /*
     * The wall is skewed so one shoulder meets it first. Whichever foot has
     * the margin must go first, and turning the skew round must turn the
     * answer round — a scheduler that always reads the left slot first
     * passes one of these and fails the other.
     */
    const leadOf = (skew: number) => {
      /* The WALL stays put and SHE comes in at an angle, which is the only
       * way one shoulder meets it first: both front feet are exactly
       * equidistant from a plane she is square to, whatever the plane. */
      const { track } = walkAt({
        frames: 600, startMm: 9, facing: new THREE.Vector3(skew, 0, 1),
      });
      return track.find((s) => s.swinging)?.swinging ?? null;
    };
    const left = leadOf(0.35);
    const right = leadOf(-0.35);
    expect(left, 'never scheduled a foot with the wall skewed left').toBeTruthy();
    expect(right, 'never scheduled a foot with the wall skewed right').toBeTruthy();
    expect(left).not.toBe(right);
  });
});

describe('the player, and giving up', () => {
  it('pauses safely when she lets go of forward', () => {
    const r = rig();
    /* Walk until the queue is running and one foot has crossed. */
    let report = tick(r);
    for (let i = 0; i < 600 && report.corner.onNew < 1; i += 1) report = tick(r);
    expect(report.corner.onNew, 'never got a foot across').toBeGreaterThan(0);

    /* Thumb off. Nothing further is released, the feet that crossed stay
     * across, and support does not fall. */
    r.input.walk = 0;
    const before = report.corner.onNew;
    for (let i = 0; i < 240; i += 1) {
      report = tick(r);
      expect(report.corner.planted).toBeGreaterThanOrEqual(4);
    }
    expect(report.corner.onNew).toBe(before);
    expect(report.corner.swinging).toBeNull();
  });

  it('recovers to the old surface when she reverses before committing', () => {
    const r = rig();
    let report = tick(r);
    for (let i = 0; i < 600 && report.corner.phase === 'normal'; i += 1) report = tick(r);
    expect(report.corner.phase).not.toBe('normal');

    r.input.walk = -1;
    for (let i = 0; i < 120; i += 1) report = tick(r);
    expect(report.corner.phase).toBe('normal');
    expect(report.corner.onNew).toBe(0);
    /*
     * Backing off is not falling off. Three, not four: she is walking
     * BACKWARDS on the floor by now, and an ordinary tripod gait has three
     * feet in the air for part of every cycle. The four-foot floor is the
     * transition's promise, and she is no longer in one.
     */
    expect(report.corner.planted).toBeGreaterThanOrEqual(3);
    expect(r.body.up.y).toBeCloseTo(1, 6);
  });

  it('does not teleport a foot when the target goes away', () => {
    /*
     * The wall is pulled out from under a scheduled reach. The foot must end
     * up somewhere the world actually answers for — never at the remembered
     * contact, which is now thin air.
     */
    const r = rig();
    let report = tick(r);
    for (let i = 0; i < 600 && !report.corner.swinging; i += 1) report = tick(r);
    const lost = report.corner.swinging;
    expect(lost, 'nothing was ever scheduled').toBeTruthy();

    /* The wall vanishes out from under the reach. Only a floor is left, and
     * the SAME walker answers for it — so this is the target disappearing,
     * not the world being swapped for a different one. */
    r.world.state.wall = false;
    for (let i = 0; i < 240; i += 1) report = tick(r);

    /* Whatever that foot is doing, it is not standing on the wall that is no
     * longer there, and she has not fallen apart. */
    const foot = r.drive.anchorFor(lost!)!;
    const p = new THREE.Vector3(foot[0], foot[1], foot[2]);
    expect(p.dot(r.world.up)).toBeGreaterThan(-1 / MM);
    expect(report.corner.planted).toBeGreaterThanOrEqual(3);
    expect(report.corner.phase, 'still armed at a wall that is gone').toBe('normal');
  });
});

describe('the handoff, and what it must not disturb', () => {
  it('does not fire a whole tripod on the first frame back', () => {
    const { track } = walkAt({ frames: 900 });
    const done = finished(track);
    expect(done, 'the corner never finished').toBeGreaterThan(0);
    /*
     * The settle frame and the first ordinary frame after it. That is the
     * whole of what the guard has to cover — a body frame that has just
     * swung ninety degrees makes every excursion large AT ONCE, and the risk
     * is one frame reading a spent tripod and lifting three feet together.
     * Beyond that the ordinary tripod is SUPPOSED to lift three, so a wider
     * window would fail on the gait working.
     *
     * Not sized from `HANDOFF_GRACE` any more. It used to be, and when the
     * constant was narrowed to a single frame the window came with it and
     * this test quietly stopped inspecting anything.
     */
    expect(Math.round(HANDOFF_GRACE * 60)).toBeGreaterThanOrEqual(1);
    for (const s of track.slice(done, done + 2)) {
      expect(s.released.length, `${s.released.length} let go at frame ${s.frame}`)
        .toBeLessThanOrEqual(1);
    }
    /* And she is still standing on it a good while later — the strain the
     * first normal frames inherit is survivable, however it is spent. */
    for (const s of track.slice(done, done + 60)) {
      expect(s.planted, `only ${s.planted} down at frame ${s.frame}`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('hands back to the ordinary gait rather than staying armed', () => {
    const { track } = walkAt({ frames: 900 });
    const done = finished(track);
    expect(done, 'the corner never finished').toBeGreaterThan(0);
    expect(track[done]!.onOld).toBe(0);
    expect(track[done + 1]!.phase, 'settle must last exactly one frame').toBe('normal');
    /*
     * And she keeps walking afterwards: the tripod resumes rather than her
     * standing on the wall having arrived. Six down, then three, then six —
     * an alternation, which is what the ordinary gait looks like.
     */
    const after = track.slice(done + 2, done + 120).map((s) => s.planted);
    expect(Math.min(...after)).toBeLessThan(6);
    expect(Math.max(...after)).toBe(6);
  });

  it('leaves the flat-ground walk numerically identical', () => {
    /*
     * The strongest form of "nothing special until a front foot can reach":
     * the same run, with and without the world being ABLE to answer the new
     * question at all, must agree to the last digit.
     */
    const runWith = (probes: boolean) => {
      const world = openGround();
      const ground: Ground = probes ? world.ground : { nearest: world.ground.nearest };
      const drive = new LegDrive(setup());
      const body = {
        at: new THREE.Vector3(0, -0.259 / MM, 0),
        up: new THREE.Vector3(0, 1, 0),
        forward: new THREE.Vector3(0, 0, 1),
      };
      drive.plantAll(body, ground);
      const input: DriveInput = {
        walk: 1, yaw: 0.3, speed: 7.5 / MM, yawRate: 2.53, spin: true, settle: true,
      };
      const out: number[] = [];
      for (let i = 0; i < 360; i += 1) {
        const r = drive.step(1 / 60, body, input, ground);
        out.push(r.movedMm, r.planted, r.groping, r.strain, r.allowed);
      }
      out.push(body.at.x, body.at.y, body.at.z);
      return out;
    };
    expect(runWith(true)).toEqual(runWith(false));
  });
});

describe('the frame', () => {
  it('turns a corner that has nothing to do with world Y', () => {
    /*
     * She is on a WALL, walking up it, and a ceiling juts out ahead. Nothing
     * in the scheduler mentions vertical, so this must run exactly as the
     * floor case does — same queue, same counts.
     */
    const onWall = corner(0, {
      up: new THREE.Vector3(1, 0, 0),
      ahead: new THREE.Vector3(0, 1, 0),
    });
    const { track } = walkAt({ world: onWall, frames: 600, startMm: 8 });
    const armed = track.find((s) => s.phase !== 'normal');
    expect(armed, 'never armed off the world floor').toBeTruthy();
    expect(reached(track, 2), 'never got the leading row across').toBeTruthy();
    /* From the queue's first release — the armed frames before it may still
     * carry the ordinary gait's inherited swings; see "the queue" above. */
    const first = track.findIndex((s) => s.phase !== 'normal' && s.released.length > 0);
    expect(first, 'the queue never released a foot').toBeGreaterThanOrEqual(0);
    for (const s of track.slice(first)) {
      if (s.phase === 'normal') continue;
      expect(s.released.length).toBeLessThanOrEqual(1);
      expect(s.planted).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('the cost', () => {
  it('asks the world about the new surface only a handful of times a frame', () => {
    /* Phones. A scheduler that re-discovers the world per leg per frame is
     * not shippable however correct it is. */
    const world = corner(0);
    const drive = new LegDrive(setup());
    const body = {
      at: new THREE.Vector3(0, -0.259 / MM, world.wallAt - 8 / MM),
      up: world.up.clone(),
      forward: world.ahead.clone(),
    };
    drive.plantAll(body, world.ground);
    const input: DriveInput = {
      walk: 1, yaw: 0, speed: 7.5 / MM, yawRate: 2.53, spin: false, settle: false,
    };
    world.ground.probes = 0;
    const frames = 240;
    for (let i = 0; i < frames; i += 1) drive.step(1 / 60, body, input, world.ground);
    expect(world.ground.probes / frames).toBeLessThan(6);
  });

  it('asks nothing at all when she is not walking forward', () => {
    const world = corner(0);
    const drive = new LegDrive(setup());
    const body = {
      at: new THREE.Vector3(0, -0.259 / MM, world.wallAt - 8 / MM),
      up: world.up.clone(),
      forward: world.ahead.clone(),
    };
    drive.plantAll(body, world.ground);
    const input: DriveInput = {
      walk: 0, yaw: 0, speed: 7.5 / MM, yawRate: 2.53, spin: false, settle: false,
    };
    world.ground.probes = 0;
    for (let i = 0; i < 120; i += 1) drive.step(1 / 60, body, input, world.ground);
    expect(world.ground.probes).toBe(0);
  });
});
