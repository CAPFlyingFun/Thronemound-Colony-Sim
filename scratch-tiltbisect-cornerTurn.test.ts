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
  LegDrive, type DriveInput, type Ground, type LegSetup,
} from './src/anim/legDrive';
import { CORNER_DEG, rowsFromHomes } from './src/anim/cornerTurn';
import { SurfaceWalker } from './src/world/surfaceWalk';

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
  /** The wall's pitch from the floor: 90 is vertical, 60 is a steep ramp. */
  slopeDeg?: number;
} = {}) {
  const up = (opts.up ?? new THREE.Vector3(0, 1, 0)).clone().normalize();
  const ahead = (opts.ahead ?? new THREE.Vector3(0, 0, 1)).clone().normalize();
  const slope = ((opts.slopeDeg ?? 90) * Math.PI) / 180;
  /* The wall's outward normal: straight back at 90, tilted up as it lays
   * down toward a ramp. The half-space pivots where it meets the floor. */
  const wallN = up.clone().multiplyScalar(Math.cos(slope))
    .addScaledVector(ahead, -Math.sin(slope))
    .normalize();
  const wallAt = wallMm / MM;
  /** Mutable, so a target can be taken away mid-run without a new walker. */
  const state = { wall: opts.wall ?? true };

  /* Signed, positive inside; a union is the larger of the two, exactly as
   * the island unions its soil with its wood. */
  const P = new THREE.Vector3();
  const density = (x: number, y: number, z: number): number => {
    P.set(x, y, z);
    const floor = -P.dot(up);
    const wall = -P.dot(wallN) - wallAt * Math.sin(slope);
    return state.wall ? Math.max(floor, wall) : floor;
  };
  const solid = (x: number, y: number, z: number): boolean => density(x, y, z) > 0;

  const walker = new SurfaceWalker(density, {
    cell: 0.2, ride: RIDE, gripLift: 3 / MM, gripReach: 9 / MM,
    align: 12, maxTiltRate: (Number(process.env.TILT_CAP ?? 240) * Math.PI) / 180,
    tiltAccel: (Number(process.env.TILT_ACC ?? 2400) * Math.PI) / 180, goalGain: 1000, snap: 14, deadband: 0.06,
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
  /** Planted anchors, world frame, straight off the drive. */
  anchors: Record<string, [number, number, number]>;
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
    const anchors: Record<string, [number, number, number]> = {};
    for (const foot of c.feet) {
      owner[foot.slot] = foot.owner;
      state[foot.slot] = foot.state;
      if (was[foot.slot] === 'PLANT' && foot.state !== 'PLANT') released.push(foot.slot);
      if (foot.state === 'PLANT') {
        const a = r.drive.anchorFor(foot.slot);
        if (a) anchors[foot.slot] = [a[0], a[1], a[2]];
      }
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
      anchors,
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

const TRIPOD_A = ['frontLeft', 'midRight', 'rearLeft'];
const groupOf = (slot: string) => (TRIPOD_A.includes(slot) ? 'A' : 'B');

describe('the tripods, through the corner', () => {
  /*
   * THE CONTRACT CHANGED, and these tests are the new one. The corner used
   * to run a queue of its own — one foot at a time, front row first, four
   * planted always — and the stop-start motion at every fold was that
   * second cadence showing. Now the ordinary alternating tripod runs
   * straight through: whole groups lift, whichever surface answers a foot's
   * ordinary step is the surface it lands on, and the corner only keeps the
   * ledger and holds the body off the face. So: three planted, not four;
   * three released together, not one; and the order feet cross in is
   * geometry, not a schedule.
   */
  it('never mixes tripods in a single release', () => {
    const { track } = walkAt({ frames: 900 });
    for (const s of track) {
      if (s.released.length < 2) continue;
      const groups = new Set(s.released.map(groupOf));
      expect(groups.size, `${s.released.join(',')} let go together at ${s.frame}`)
        .toBe(1);
    }
  });



  it('alternates A and B straight through the transition', () => {
    const { track } = walkAt({ frames: 900 });
    expect(finished(track), 'the corner never finished').toBeGreaterThan(0);
    /*
     * Gait turns are the releases of two or more feet at once. Mid-fold a
     * turn can SHRINK to a single foot — a tripod whose crossed feet keep
     * their grips (a grip is never traded for a maybe) and whose old feet
     * are groping at the crease has only one foot free to move, and moving
     * it IS that tripod's turn. So the law is stated the only way the
     * trace can still tell truth from double-dipping: the same group may
     * not lead two multi-foot turns in a row unless the OTHER group
     * released something — anything — in between. On the flat every
     * release is three feet and the check is as strict as it reads.
     */
    const turns = track.filter((s) => s.released.length > 0)
      .map((s) => ({
        frame: s.frame,
        group: groupOf(s.released[0]!),
        full: s.released.length >= 2,
      }));
    expect(turns.filter((t) => t.full).length, 'too few gait turns to judge alternation')
      .toBeGreaterThan(4);
    let lastFull: string | null = null;
    let otherSince = false;
    for (const turn of turns) {
      if (!turn.full) {
        if (turn.group !== lastFull) otherSince = true;
        continue;
      }
      if (turn.group === lastFull) {
        expect(otherSince, `${turn.group} led twice in a row at frame ${turn.frame}`)
          .toBe(true);
      }
      lastFull = turn.group;
      otherSince = false;
    }
  });

  it('keeps a full stance planted through every armed frame', () => {
    const { track } = walkAt({ frames: 900 });
    for (const s of track) {
      if (s.phase === 'normal') continue;
      expect(s.planted, `only ${s.planted} down at frame ${s.frame}`)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('crosses front first, and the rows in anatomical order — by reach, not schedule', () => {
    const { track } = walkAt({ frames: 900 });
    const firstNew: Record<string, number> = {};
    for (const s of track) {
      for (const [slot, o] of Object.entries(s.owner)) {
        if (o === 'new' && !(slot in firstNew)) firstNew[slot] = s.frame;
      }
    }
    const rows = rowsFromHomes(setup().map((l) => ({ slot: l.slot, home: l.home })));
    const rowAt = rows.map((row) => Math.min(...row.map((s) => firstNew[s] ?? Infinity)));
    expect(rowAt[0], 'the front row never crossed').toBeLessThan(Infinity);
    expect(rowAt[0]!).toBeLessThan(rowAt[1]!);
    expect(rowAt[1]!, 'the middle row never crossed').toBeLessThan(rowAt[2]!);
    expect(rowAt[2]!, 'the rear row never crossed').toBeLessThan(Infinity);
  });

  it('leads with whichever tripod is due, not a hardcoded foot', () => {
    /*
     * Different approach distances put the gait at a different point in its
     * cycle when the wall comes into reach, so across a spread of starts
     * BOTH fronts must get to lead. A scheduler with a favourite foot fails
     * this however well it climbs.
     */
    const leaders = new Set<string>();
    for (const startMm of [6, 8, 10, 12, 14]) {
      const { track } = walkAt({ frames: 900, startMm });
      const first = track.find((s) => Object.values(s.owner).includes('new'));
      if (!first) continue;
      for (const [slot, o] of Object.entries(first.owner)) {
        if (o === 'new') leaders.add(slot);
      }
    }
    expect(leaders.has('frontLeft'), `frontLeft never led (${[...leaders].join(',')})`)
      .toBe(true);
    expect(leaders.has('frontRight'), `frontRight never led (${[...leaders].join(',')})`)
      .toBe(true);
  });

  it('never drags a planted foot', () => {
    const { track } = walkAt({ frames: 900 });
    for (let i = 1; i < track.length; i += 1) {
      const a = track[i - 1]!.anchors;
      const b = track[i]!.anchors;
      for (const slot of Object.keys(b)) {
        if (!(slot in a)) continue;
        const d = Math.hypot(
          b[slot]![0] - a[slot]![0], b[slot]![1] - a[slot]![1], b[slot]![2] - a[slot]![2],
        ) * MM;
        expect(d, `${slot} slid ${d.toFixed(4)} mm while planted at frame ${i}`)
          .toBeLessThan(0.001);
      }
    }
  });

  it('makes no sustained backward progress', () => {
    /*
     * Progress measured along the BLENDED path — approach along the floor
     * plus climb up the wall — never in her own rotating frame, where the
     * fold itself reads as motion. The seat may breathe a fraction of a
     * millimetre; a slide is a different order of thing.
     */
    const { track, world } = walkAt({ frames: 900 });
    expect(finished(track), 'the corner never finished').toBeGreaterThan(0);
    let worst = 0;
    let total = 0;
    for (let i = 1; i < track.length; i += 1) {
      const s = (t: Snap) => t.at.dot(world.ahead) + t.at.dot(world.up);
      const d = (s(track[i]!) - s(track[i - 1]!)) * MM;
      if (d < 0) { total -= d; worst = Math.max(worst, -d); }
    }
    expect(worst, `a ${worst.toFixed(3)} mm single-frame reverse`).toBeLessThan(0.5);
    expect(total, `${total.toFixed(3)} mm of accumulated reverse`).toBeLessThan(3);
  });

  const climbs = (slopeDeg: number, speedMm: number) => {
    const world = corner(0, { slopeDeg });
    const { track } = walkAt({ world, frames: 1200, speedMm });
    const done = finished(track);
    expect(done, `never finished the ${slopeDeg}-degree wall`).toBeGreaterThan(0);
    for (const s of track) {
      if (s.released.length < 2) continue;
      expect(new Set(s.released.map(groupOf)).size, `mixed release at ${s.frame}`)
        .toBe(1);
      expect(s.planted).toBeGreaterThanOrEqual(3);
    }
  };

  it('climbs a 60-degree wall with the same gait', () => climbs(60, 7.5));
  it('climbs a 75-degree wall with the same gait', () => climbs(75, 7.5));
  it('takes the vertical wall at a walk and at a sprint', () => {
    climbs(90, 7.5);
    climbs(90, 22);
  });
});

describe('the player, and giving up', () => {
  it('pauses safely when she lets go of forward', () => {
    const r = rig();
    /* Walk until the queue is running and one foot has crossed. */
    let report = tick(r);
    for (let i = 0; i < 600 && report.corner.onNew < 1; i += 1) report = tick(r);
    expect(report.corner.onNew, 'never got a foot across').toBeGreaterThan(0);

    /* Thumb off. The tripod in flight (if one is) lands, nothing further
     * is released, and the feet that crossed stay across. Three is the
     * tripod gait's own support floor while that landing finishes. */
    r.input.walk = 0;
    for (let i = 0; i < 240; i += 1) {
      report = tick(r);
      expect(report.corner.planted).toBeGreaterThanOrEqual(3);
    }
    expect(report.corner.planted).toBe(6);
    expect(report.corner.onNew).toBeGreaterThan(0);
    expect(report.corner.swinging).toBeNull();
  });

  it('times out a hands-off pause that is measurably going somewhere', () => {
    /*
     * The telemetry that forced this: parked at an armed corner with every
     * foot planted and the thumb off, the seat treadmilled her backwards at
     * about a millimetre a second for ten seconds, and the guard read the
     * whole thing as a pause by design. A pause is NOT MOVING; a "pause"
     * with measured drift must bench like any other stall.
     */
    const r = rig();
    let report = tick(r);
    for (let i = 0; i < 600 && report.corner.onNew < 1; i += 1) report = tick(r);
    expect(report.corner.onNew, 'never got a foot across').toBeGreaterThan(0);

    r.input.walk = 0;
    /* Drift her backwards at 1.2 mm/s — hands off, nothing swinging. */
    const drift = r.world.ahead.clone().multiplyScalar(-(1.2 / MM) / 60);
    let freed = -1;
    for (let i = 0; i < 300; i += 1) {
      r.body.at.add(drift);
      report = tick(r);
      if (report.corner.phase === 'normal') { freed = i; break; }
    }
    expect(freed, 'drifting "pause" never benched the corner')
      .toBeGreaterThanOrEqual(0);
    /* Within the stall guard's own horizon, not eventually. */
    expect(freed / 60).toBeLessThan(3.5);
  });

  it('does not let a hands-off loss of the wall jam her', () => {
    /*
     * The startled-player script: feet are crossing, the wall vanishes, and
     * the thumb comes OFF. There is no scheduled reach to call off any more
     * — a swing that loses its new-surface answer simply lands through the
     * ordinary probe on what is left — so the whole claim is that every
     * foot comes home to the floor, hands-free, and the first push at the
     * vanished wall benches the corner within its own stall horizon.
     */
    const r = rig();
    let report = tick(r);
    for (let i = 0; i < 900 && report.corner.onNew < 1; i += 1) report = tick(r);
    expect(report.corner.onNew, 'never got a foot across').toBeGreaterThan(0);

    r.world.state.wall = false;
    r.input.walk = 0;
    let home = -1;
    for (let i = 0; i < 420; i += 1) {
      report = tick(r);
      if (report.corner.planted === 6) { home = i; break; }
    }
    expect(home, 'her feet never all came home hands-free').toBeGreaterThanOrEqual(0);
    expect(home / 60).toBeLessThan(4);

    /* And the first push at the vanished wall benches it in seconds. */
    r.input.walk = 1;
    let freed = -1;
    for (let i = 0; i < 300; i += 1) {
      report = tick(r);
      if (report.corner.phase === 'normal') { freed = i; break; }
    }
    expect(freed, 'push at a vanished corner never benched it')
      .toBeGreaterThanOrEqual(0);
    expect(freed / 60).toBeLessThan(3.5);
  });

  it('does not read a respawn as drift', () => {
    /*
     * The slip detector's blind spot: a teleport read as one frame of
     * velocity poisons the low-pass for seconds, and a genuinely stationary
     * hands-off pause right after arriving would bench as a "drift".
     * `reset()` (which every fresh plant calls) must forget where she was.
     * The wall is an infinite plane, so a huge SIDEWAYS hop keeps the
     * corner exactly as reachable as before it.
     */
    const r = rig();
    /* A life before the hop, so there is a remembered position to poison. */
    for (let i = 0; i < 30; i += 1) tick(r);
    const aside = r.world.up.clone().cross(r.world.ahead).normalize();
    r.body.at.addScaledVector(aside, 300000 / MM);
    r.drive.plantAll(r.body, r.world.ground);

    /* Pause the moment it ARMS — the earliest a pause can exist, and the
     * window where a poisoned filter is still hot enough to bench it. */
    let report = tick(r);
    for (let i = 0; i < 600 && report.corner.phase === 'normal'; i += 1) report = tick(r);
    expect(report.corner.phase, 'never re-armed after the hop').not.toBe('normal');

    /* Thumb off, feet planted, body still: the pause by design. */
    r.input.walk = 0;
    for (let i = 0; i < 240; i += 1) {
      report = tick(r);
      expect(report.corner.phase, `benched a stationary pause at frame ${i}`)
        .not.toBe('normal');
    }
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
     * The wall is pulled out from under feet that have already crossed. The
     * feet must end up somewhere the world actually answers for — never at
     * the remembered contact, which is now thin air.
     */
    const r = rig();
    let report = tick(r);
    for (let i = 0; i < 900 && report.corner.onNew < 1; i += 1) report = tick(r);
    expect(report.corner.onNew, 'never got a foot across').toBeGreaterThan(0);
    const across = report.corner.feet
      .filter((f) => f.owner === 'new')
      .map((f) => f.slot);
    expect(across.length).toBeGreaterThan(0);

    /* The wall vanishes out from under them. Only a floor is left, and the
     * SAME walker answers for it — so this is the target disappearing, not
     * the world being swapped for a different one. */
    r.world.state.wall = false;
    for (let i = 0; i < 300; i += 1) report = tick(r);

    /* Whatever those feet are doing, they are standing on the floor that
     * still exists — not hovering where the wall used to be — and she has
     * not fallen apart. */
    for (const slot of across) {
      const foot = r.drive.anchorFor(slot)!;
      const p = new THREE.Vector3(foot[0], foot[1], foot[2]);
      expect(p.dot(r.world.up) * MM, `${slot} ended above the floor`).toBeLessThan(3);
      expect(p.dot(r.world.up) * MM, `${slot} ended inside the floor`).toBeGreaterThan(-1);
    }
    expect(report.corner.planted).toBeGreaterThanOrEqual(3);
    expect(report.corner.phase, 'still armed at a wall that is gone').toBe('normal');
  });
});

describe('the handoff, and what it must not disturb', () => {
  it('keeps her feet under her through the handoff', () => {
    /*
     * The old guard here — no whole tripod on the first frames back —
     * guarded a seam that no longer exists: the gait was never paused, so
     * there is no first frame back, and a tripod firing on it is just the
     * gait. What must still hold is that the strain the first post-corner
     * frames inherit — homes computed in a body frame that has swung ninety
     * degrees — is survivable: the support floor holds, and she keeps
     * walking rather than standing on the wall having arrived.
     */
    const { track } = walkAt({ frames: 900 });
    const done = finished(track);
    expect(done, 'the corner never finished').toBeGreaterThan(0);
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
    /* Same gait, same counts: whole tripods, never mixed, three down. */
    for (const s of track) {
      if (s.phase === 'normal') continue;
      if (s.released.length >= 2) {
        expect(new Set(s.released.map(groupOf)).size, `mixed release at ${s.frame}`)
          .toBe(1);
      }
      expect(s.planted).toBeGreaterThanOrEqual(3);
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
