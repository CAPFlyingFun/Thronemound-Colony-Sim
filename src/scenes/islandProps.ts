/**
 * THE LOOSE THINGS — what INTERACT is for.
 *
 * INTERACT arrived with no subject. The mechanic exists in the sandbox as a
 * grab on the E key, but what it grabs there is a soil clod, and island
 * digging removes density without producing an object: there was literally
 * nothing on the island to pick up except a dead beetle, which CARRY
 * already handles. So the port is not the verb, it is the NOUN.
 *
 * WHAT SEPARATES THIS FROM CARRY, since both put something in her jaws:
 * CARRY is the colony's protein economy — prey, taken home, digested by
 * larvae, and it moves the FOOD store. INTERACT is manipulation, and these
 * are worth nothing to eat. A leaf is not food; it is a leaf. They share
 * one pair of jaws (the same `Carry`, so she cannot hold two things at
 * once, which is the physical truth) and nothing else.
 *
 * WEIGHTS ARE THE SANDBOX'S, unchanged, because the whole point of taking
 * them is that `STRENGTH` and `carryVerdict` already decide what each ant
 * can do with each of them — and the answers differ per caste, which is
 * what makes the queen-to-worker-to-major handoff a table row rather than a
 * rewrite. The queen carries a seed and drags a rock; the nanitic that
 * follows her will find the same rock immovable until a major exists.
 *
 * Deliberately NOT physics. The backlog card that describes these wants
 * top-down physics and pushing; this gives them a resting height on the
 * terrain and nothing else. A thing that can be picked up and put down is
 * the whole of what INTERACT needs, and gravity is a separate card.
 */
import * as THREE from 'three';
import type { Portable } from './islandCarry';

/**
 * WHAT A LOOSE THING NEEDS TO KNOW ABOUT THE GROUND — and it is one
 * question, deliberately.
 *
 * Not a heightfield lookup. The whole fault this replaces was asking the
 * ORIGINAL surface how high the floor is, in a game whose entire verb is
 * changing where the floor is. This asks for the first soil UNDER a point,
 * so a chamber floor, a tunnel roof's far side and the open surface are one
 * answer rather than three cases.
 */
export interface PropGround {
  /** The y a thing resting at (x, y, z) should sit at, searching down. */
  floorUnder(x: number, y: number, z: number): number;
  /**
   * Which way the soil FACES here — its outward normal.
   *
   * This is the density field's own gradient, which the walker already
   * computes to seat her feet, so a rolling pebble costs no new machinery:
   * the slope a thing rolls down is the same slope she climbs.
   */
  soilNormal(x: number, y: number, z: number, into: THREE.Vector3): void;
  /**
   * HOW FAR INSIDE THE SOIL a point is. Positive is buried, negative is air.
   *
   * This is what makes per-shape collision cheap here rather than a physics
   * engine's worth of work. The terrain is a signed DENSITY FIELD, not a
   * mesh — so a prop does not need mesh-against-mesh intersection, which is
   * the expensive thing people mean by "mesh collision". It needs to ask the
   * field, at points on its own surface, whether they are in the ground.
   * Shape falls out of WHERE you ask.
   */
  insideBy(x: number, y: number, z: number): number;
}

/** World units a second squared. Tuned so a prop dropped in a shaft lands
 *  in a beat rather than drifting — see `Prop.tick`. */
/** How many contact points a shape is reduced to, and the spread they are
 *  drawn from. Fourteen is the six extremes plus eight spread over the rest
 *  — enough that a twig cannot pivot between two of them. */
/** How far out of the soil a resting prop is held. Small enough to be
 *  invisible, large enough that the next frame's read cannot flip. */
/** Above this the contact is a floor and friction holds; below it, a wall,
 *  where the sideways push is the whole point. About sixty degrees. */
const FLOOR_FACES_UP = 0.5;

const PROP_SKIN = 0.004;

const HULL_MAX = 14;
const HULL_SPREAD = 10;

const HULL_P = new THREE.Vector3();
const HIT_N = new THREE.Vector3();
const ROLL_N = new THREE.Vector3();
const ROLL_DOWN = new THREE.Vector3();
const ROLL_AXIS = new THREE.Vector3();
const ROLL_Q = new THREE.Quaternion();

const PROP_GRAVITY = 9;
/** And capped, so nothing tunnels a thin floor between two frames. */
const PROP_FALL_MAX = 6;

/**
 * WHICH THINGS ROLL — by shape, because that is what rolling is about.
 *
 * Asked for: "with say round objects or the egg shaped object, it should
 * naturally roll around when released and will move around until it finds
 * the right balance on the ground".
 *
 * A seed is a squashed sphere and a rock is a dodecahedron; both are round
 * enough that resting on a slope looks wrong. A leaf and a twig are not —
 * a twig on a slope stays put, and a rolling leaf would look sillier than a
 * still one. Kept as a set rather than a flag on every spec because it is a
 * fact about the SHAPE, and the shape is what `kind` already names.
 */
const ROLLS = new Set<PropSpec['kind']>(['seed', 'rock']);

/**
 * Below this slope it has found its balance and stays there.
 *
 * The slope is `sin` of the angle off level, so 0.09 is about five degrees
 * — shallow enough that a pebble settles in a dimple rather than creeping
 * forever, steep enough that it will not sit on the side of a mound.
 *
 * It is no longer TESTED for. It is the angle at which the slope's push and
 * the rolling resistance are equal, so `ROLL_FRICTION` is derived from it
 * and the resting angle comes out of the arithmetic rather than out of a
 * second rule that had to be kept in step with the first.
 */
const ROLL_RESTS_BELOW = 0.09;
/**
 * HOW FAST IT ENDS UP GOING IS THE SLOPE'S ANSWER, NOT THE CAP'S.
 *
 * Reported: "the physics on the rocks and objects are too constant meaning
 * it keeps moving at the same speed downhill or straight". Exactly right,
 * and the arithmetic said so before the eye did.
 *
 * Push against linear drag settles at `ROLL_PUSH / ROLL_DRAG * slope` — a
 * speed PROPORTIONAL to steepness, which is the behaviour wanted. But the
 * old numbers made that 5 / 1.9 = 2.6 x slope, so anything past a slope of
 * 0.53 — about 32 degrees, which most of this island's banks beat —
 * settled ABOVE the 1.4 cap and got clamped to it. Every real hill
 * therefore rolled at the same 1.4, and the cap, not the ground, was the
 * physics. A steeper bank changed nothing; that is the "constant".
 *
 * So the ratio comes down to 2.0 and the cap goes UP to 2.6, which puts the
 * clamp back where it was meant to be: a backstop against a freak frame,
 * not the number you watch. Across the slopes the island actually has, a
 * gentle 0.15 now creeps at 0.3 and a steep 0.9 runs at 1.8 — six times the
 * difference, where before there was none.
 *
 * `ROLL_PUSH` stays at 5 because it is not a speed, it is the ACCELERATION,
 * and 5 x slope is close to the 5/7 g sin(theta) of a solid sphere rolling
 * without slipping at this scene's gravity of 9. Keeping it means a pebble
 * still gathers pace over about a second rather than snapping to its
 * terminal speed, and the ramp is most of what reads as weight.
 */
const ROLL_PUSH = 5;
const ROLL_DRAG = 2.5;
/**
 * A backstop, not a governor: nothing here should reach it. Terminal speed
 * on a vertical face is 2.0, so this only catches a frame where the field's
 * normal is degenerate or dt spikes.
 */
const ROLL_MAX = 2.6;

/**
 * ROLLING RESISTANCE, WHICH IS WHAT ACTUALLY STOPS IT.
 *
 * Asked: "do the objects have friction that will slow them down, so if it
 * was on a steep slope and gets to a flat part, will it naturally slow down
 * and stop based on friction and gravity, instead of still crawling along?"
 *
 * There WAS friction, and it was the wrong kind. `ROLL_DRAG` takes a share
 * of the speed every second, so what is left decays exponentially and never
 * reaches nothing. Measured on a stone leaving a steep bank onto the level,
 * one line per second of travel:
 *
 *     0.25333  0.05161  0.01052  0.00214  0.00044  0.00006
 *
 * It is still visibly creeping in the third second and still technically
 * moving in the sixth. That is the crawl in the report, and it is inherent
 * to drag: a force proportional to speed cannot remove the last of it.
 *
 * Real rolling resistance is near enough a CONSTANT retarding force — it
 * comes from the contact patch deforming, which does not care how fast the
 * thing is going. A constant deceleration reaches zero at a definite moment
 * and STAYS there, which is both the honest model and the behaviour asked
 * for. Drag stays alongside it because it is what makes the terminal speed
 * proportional to the slope; friction is what ends the roll.
 *
 * 0.45 is `ROLL_PUSH * ROLL_RESTS_BELOW` on purpose, so the slope a thing
 * comes to rest on is unchanged at about five degrees — it is now a
 * CONSEQUENCE of the friction rather than a separate threshold, which is
 * why the old explicit test for it is gone. A stone now runs out in about
 * nine tenths of a second and 2.6 mm, and then it is still.
 */
const ROLL_FRICTION = ROLL_PUSH * ROLL_RESTS_BELOW;
import { MM } from '../world/worldScape';

/** The kinds the island seeds, and what each weighs in milligrams. */
export interface PropSpec {
  kind: 'seed' | 'crumb' | 'twig' | 'leaf' | 'rock';
  massMg: number;
  /** Rough half-extent, mm — its footprint and its grab radius. */
  halfMm: number;
  colour: number;
}

/*
 * THE SET, and it is chosen to span all three verdicts for the ant playing
 * today rather than to decorate. A queen carries the first four and drags
 * the two rocks; the 120mg rock she cannot move at all, which is the only
 * way `immobile` is ever taught before there is a second caste to teach it.
 */
export const PROP_SPECS: Record<string, PropSpec> = {
  seed: { kind: 'seed', massMg: 3, halfMm: 1.1, colour: 0xb99a5c },
  crumb: { kind: 'crumb', massMg: 5, halfMm: 1.2, colour: 0xa8793e },
  leaf: { kind: 'leaf', massMg: 4, halfMm: 4.4, colour: 0x5f7a34 },
  twig: { kind: 'twig', massMg: 8, halfMm: 5.5, colour: 0x77563a },
  pebble: { kind: 'rock', massMg: 22, halfMm: 2.4, colour: 0x8d8d94 },
  stone: { kind: 'rock', massMg: 120, halfMm: 4.4, colour: 0x7d7d86 },
};

/**
 * One loose object. A `Portable` with no protein — worth nothing to the
 * colony, which is what stops the delivery at the nest from swallowing it.
 */
export class Prop implements Portable {
  readonly root = new THREE.Group();

  readonly at = new THREE.Vector3();

  /** Never alive, so `Carry` never refuses one for fighting back. */
  readonly alive = false;

  readonly massMg: number;

  /** Nothing here is food. See the file's opening note. */
  readonly proteinMg = 0;

  carried = false;

  /**
   * HOW IT IS TURNED IN HER FRAME, captured the moment she picks it up.
   *
   * Reported: "we need to store the object angle on collision (carry) with
   * the ant so whatever angle you carry it at first and grab, is stays that
   * way and follows relative to the ant so the twig doesn't stay a fix
   * angle in world space... as it looks weird with it rotating through the
   * ant and all around."
   *
   * Exactly the bug: `tick` wrote POSITION and nothing else, so a carried
   * twig kept the world rotation it was scattered with. Walk her in a
   * circle and the twig swings through her head, because the twig is not
   * turning at all — she is turning under it.
   *
   * Stored as her rotation INVERTED times its own, which is its pose
   * expressed in her frame. Multiplying that back by her current rotation
   * each frame reproduces the grip she took rather than one chosen for her:
   * pick a twig up sideways and she carries it sideways.
   */
  readonly grip = new THREE.Quaternion();

  /** Falling speed while it is unsupported, in world units a second. */
  private fall = 0;

  /** Where it is rolling, in world units a second. See `tick`. */
  private readonly roll = new THREE.Vector3();

  /**
   * ITS OWN SURFACE, AS POINTS — the collision shape, taken off the mesh.
   *
   * Asked for directly: "I was asking for proper per-shape collision... could
   * do it mesh instead of shape for the collisions and would naturally be
   * the right shape." That is exactly what this is, and in this world it is
   * cheap rather than extravagant, because the TERRAIN IS A FIELD. Mesh
   * collision usually means mesh-against-mesh intersection; here the ground
   * answers "are you inside me?" at any point, so a shape only has to know
   * where its own surface is. Ask at the right places and the shape is
   * automatic.
   *
   * Read off the geometry rather than typed per kind, so a prop added later
   * gets its true shape without anyone writing a hull for it: a twig's
   * points run the length of its cylinder, a seed's wrap its ellipsoid, a
   * rock's sit on its facets. That is the "naturally the right shape" part.
   *
   * STRIDED AND CAPPED. A sphere is 99 vertices and a dodecahedron more;
   * asking the field at every one of them, per prop, per frame, is the
   * expense that makes people reach for an engine. The extremes plus a
   * spread of the rest is the same shape to within a fraction of a
   * millimetre at this scale, for a tenth of the reads.
   */
  private readonly hull: number[] = [];

  constructor(
    readonly id: string,
    readonly spec: PropSpec,
    x: number, y: number, z: number,
  ) {
    this.massMg = spec.massMg;
    this.at.set(x, y, z);
    this.root.position.copy(this.at);

    const mat = new THREE.MeshLambertMaterial({ color: spec.colour });
    const r = spec.halfMm / MM;
    let geo: THREE.BufferGeometry;
    if (spec.kind === 'twig') {
      geo = new THREE.CylinderGeometry(r * 0.12, r * 0.15, r * 2, 8);
      geo.rotateX(Math.PI / 2);
    } else if (spec.kind === 'leaf') {
      geo = new THREE.CircleGeometry(r, 16);
      geo.scale(1, 1.4, 1);
      geo.rotateX(-Math.PI / 2);
    } else if (spec.kind === 'seed') {
      geo = new THREE.SphereGeometry(r, 10, 8);
      geo.scale(1, 0.7, 1.5);
    } else {
      geo = new THREE.DodecahedronGeometry(r, spec.kind === 'rock' ? 1 : 0);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    this.root.add(mesh);
    this.buildHull(geo);
    /* A stone is not a sphere sitting on a plane; it is bedded in. Half a
     * radius down looks planted rather than balanced. */
    this.root.rotation.y = (spec.massMg * 1.7) % Math.PI;
  }

  /**
   * Pick the contact points off the geometry — see `hull`.
   *
   * The six axis extremes always go in, because those are the parts that
   * touch first and losing one would let a corner sink. The rest are taken
   * at a stride, which spreads them over the surface without caring what
   * shape it is.
   */
  private buildHull(geo: THREE.BufferGeometry): void {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const n = pos.count;
    if (n === 0) return;
    /* The extremes, by index, so each is a real vertex rather than a
     * corner of a box the shape never reaches. */
    const far = [0, 0, 0, 0, 0, 0];
    const best = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < n; i += 1) {
      const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      for (let a = 0; a < 3; a += 1) {
        if (v[a]! < best[a * 2]!) { best[a * 2] = v[a]!; far[a * 2] = i; }
        if (v[a]! > best[a * 2 + 1]!) { best[a * 2 + 1] = v[a]!; far[a * 2 + 1] = i; }
      }
    }
    const take = new Set<number>(far);
    const stride = Math.max(1, Math.floor(n / HULL_SPREAD));
    for (let i = 0; i < n && take.size < HULL_MAX; i += stride) take.add(i);
    for (const i of take) {
      this.hull.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
  }

  /** For tests: the contact points this shape collides with. */
  get hullForTest(): readonly number[] { return this.hull; }

  /** How close her jaws have to be, from its centre. */
  get radius(): number { return this.spec.halfMm / MM; }

  /**
   * How fast it is MOVING, world units a second — rolling and falling both.
   *
   * Read by the scene to decide whether a contact is a nudge or a crushing
   * (see `islandCrush`), and the fall belongs in it: a stone dropped down a
   * shaft onto her is the same injury as one that rolls into her, and a
   * version of this that counted only `roll` would have said a rock landing
   * on her head was harmless. The two are perpendicular, so they combine as
   * a magnitude rather than a sum.
   *
   * NOT A CLEAN ZERO AT REST. A prop sitting on the ground settles by a
   * hair each frame, is pushed back out, and does it again, so the fall
   * term hovers around one frame of gravity — 0.15 — rather than nothing.
   * That is under the crush system's free band for everything the island
   * holds, but it is a real floor under this number, and anything that
   * wants "is it moving" should compare positions instead.
   *
   * The vectors themselves stay private — nothing outside is allowed to
   * steer a rolling thing.
   */
  get speed(): number { return Math.hypot(this.roll.length(), this.fall); }

  /**
   * PUSH THE SHAPE OUT OF THE SOIL, and report which way it was pushed.
   *
   * Every hull point is asked how deep it is; the deepest one wins and the
   * whole prop moves out along the field's gradient there. One resolve per
   * frame rather than iterating to convergence — the next frame gets
   * another go, and a prop that needs many is one being crushed by terrain
   * appearing around it, which no amount of iteration would fix.
   *
   * The gradient is taken AT THE CONTACT, not under the centre, which is
   * the whole reason this reads as shape: a twig meeting a wall is pushed
   * sideways because the soil there faces sideways.
   *
   * Returns false when nothing is touching, leaving `HIT_N` untouched, so
   * the caller can tell resting from falling without a second query.
   */
  private pushOut(rest: PropGround): boolean {
    if (this.hull.length === 0) return false;
    let worst = 0;
    let wx = 0;
    let wy = 0;
    let wz = 0;
    for (let i = 0; i < this.hull.length; i += 3) {
      HULL_P.set(this.hull[i]!, this.hull[i + 1]!, this.hull[i + 2]!)
        .applyQuaternion(this.root.quaternion)
        .add(this.at);
      const depth = rest.insideBy(HULL_P.x, HULL_P.y, HULL_P.z);
      if (depth > worst) { worst = depth; wx = HULL_P.x; wy = HULL_P.y; wz = HULL_P.z; }
    }
    if (worst <= 0) return false;
    rest.soilNormal(wx, wy, wz, HIT_N);
    if (HIT_N.lengthSq() < 1e-9) { HIT_N.set(0, 1, 0); } else { HIT_N.normalize(); }
    /* A skin, so it rests ON the surface rather than exactly in it, where
     * the next frame's read could go either way and the prop would buzz. */
    this.at.addScaledVector(HIT_N, worst + PROP_SKIN);
    return true;
  }

  /**
   * IT ROLLS UNTIL IT FINDS ITS BALANCE — for the things that are round.
   *
   * Asked for: round and egg-shaped things "should naturally roll around
   * when released and will move around until it finds the right balance on
   * the ground". This is that, and it is deliberately NOT a physics engine.
   *
   * The soil's own normal is the slope. Gravity minus its component along
   * that normal is the downhill tangent, which is zero on the level by
   * construction — so "is it on a slope" and "which way is downhill" are one
   * subtraction rather than a test and a search. The walker already computes
   * this gradient to seat her feet, so a rolling pebble adds no new
   * machinery to the frame.
   *
   * WHAT IT IS NOT: there are no contacts here. It rolls down the soil it is
   * resting on and stops where the soil is level; it will not bounce off a
   * chamber wall or come to rest against one, because a prop still collides
   * with the world as a POINT. That is the honest limit — see the note on
   * `PropGround`.
   *
   * The spin is derived from the travel rather than integrated separately:
   * distance over radius is the angle a wheel of that radius turns, about
   * the axis across its direction of travel. So it cannot visually skid.
   */
  private rollOn(rest: PropGround, dt: number): void {
    if (!ROLLS.has(this.spec.kind) || dt <= 0) return;
    /* The surface it is actually resting ON, which `pushOut` just found —
     * not the field under its centre, which on a slope is a different
     * place and on a wall is meaningless. */
    ROLL_N.copy(HIT_N);
    if (ROLL_N.lengthSq() < 1e-9) return;
    /* Gravity, less the part the ground holds up: the downhill tangent. */
    ROLL_DOWN.set(0, -1, 0).addScaledVector(ROLL_N, ROLL_N.y);
    const slope = ROLL_DOWN.length();
    /*
     * The push goes on at EVERY slope now, with no "is it steep enough"
     * test in front of it. Friction is what decides whether a bank can
     * move the thing at all: below about five degrees the constant bite
     * below takes back more than the slope put in, so it never gets going.
     * One rule instead of a rule and a threshold that had to agree.
     */
    if (slope > 1e-6) {
      ROLL_DOWN.multiplyScalar(1 / slope);
      this.roll.addScaledVector(ROLL_DOWN, ROLL_PUSH * slope * dt);
    }
    /* Drag: proportional to speed, and what sets the terminal speed on a
     * bank. It cannot stop anything — see `ROLL_FRICTION`. */
    this.roll.multiplyScalar(Math.max(0, 1 - ROLL_DRAG * dt));
    /* Rolling resistance: a constant bite out of the speed, whatever the
     * speed is. Taken as a length so it never reverses the direction of
     * travel — friction stops a thing, it does not drive it backwards. */
    const speed = this.roll.length();
    const bite = ROLL_FRICTION * dt;
    if (speed <= bite) { this.roll.set(0, 0, 0); return; }
    this.roll.multiplyScalar((speed - bite) / speed);
    if (this.roll.lengthSq() > ROLL_MAX * ROLL_MAX) {
      this.roll.setLength(ROLL_MAX);
    }
    const step = this.roll.length() * dt;
    if (step < 1e-6) { this.roll.set(0, 0, 0); return; }
    this.at.addScaledVector(this.roll, dt);
    /* Turn it by the distance it covered, about the axis across its travel
     * — the definition of rolling rather than sliding. */
    ROLL_AXIS.crossVectors(ROLL_N, this.roll);
    if (ROLL_AXIS.lengthSq() < 1e-12) return;
    ROLL_AXIS.normalize();
    ROLL_Q.setFromAxisAngle(ROLL_AXIS, step / Math.max(1e-4, this.radius));
    this.root.quaternion.premultiply(ROLL_Q);
  }

  /**
   * Remember how it sat in her jaws, at the moment she closed them.
   *
   * Called by the scene on a successful lift. Her rotation inverted times
   * its own is its pose in HER frame; see `grip`.
   */
  takeGrip(holder: THREE.Quaternion): void {
    this.grip.copy(holder).invert().multiply(this.root.quaternion);
  }

  /**
   * One frame. It either rides at her jaws — the scene writes `at` — or it
   * sits on the ground. The same split the beetle makes, and for the same
   * reason: a carried thing must not be dragged back down to the terrain
   * every frame while she walks off with it.
   */
  tick(rest: PropGround, dt = 0, holder?: THREE.Quaternion): void {
    if (this.carried) {
      this.root.position.copy(this.at);
      /* Her rotation, times the grip it was taken with — see `grip`. */
      if (holder) this.root.quaternion.copy(holder).multiply(this.grip);
      this.fall = 0;
      this.roll.set(0, 0, 0);
      return;
    }
    /*
     * IT RESTS ON THE SOIL THAT IS THERE NOW, and falls if there is none.
     *
     * This used to be `at.y = groundAt(x, z) + rest`, where `groundAt` is
     * the ORIGINAL surface heightfield — which knows nothing about carving.
     * So an uncarried prop was re-pinned to the un-dug surface every single
     * frame. It was never falling through the world; it was being
     * teleported back up to where the ground used to be. Reported twice,
     * the second time exactly: "after I released the twig 11mm
     * underground, it still popped up at the surface".
     *
     * `floorUnder` asks the SOIL — the same field the walker stands on and
     * the same one the digging carves — so a chamber floor is a floor.
     */
    /*
     * FALL FIRST, THEN PUSH THE SHAPE OUT OF WHATEVER IT IS IN.
     *
     * The point probe this replaces asked "how high is the floor under my
     * centre" — which is a sphere of radius zero, and is why a twig could
     * lie half-buried across a ridge and why nothing ever stopped against a
     * wall. `pushOut` asks the field at points on the prop's OWN surface
     * instead, so a floor, a chamber wall and a tunnel roof are the same
     * question answered in different directions.
     */
    const wasX = this.at.x;
    const wasZ = this.at.z;
    this.fall = Math.min(PROP_FALL_MAX, this.fall + PROP_GRAVITY * dt);
    this.at.y -= this.fall * dt;
    this.at.addScaledVector(this.roll, dt);

    const touched = this.pushOut(rest);
    if (touched) {
      /*
       * FRICTION, and without it nothing on a slope ever stops.
       *
       * Resolving a penetration means pushing out along the surface normal,
       * which is correct — and on a slope that push has a sideways part. So
       * gravity pulls the prop in, the push shoves it out and a little
       * downhill, and next frame it does it again: a twig laid on a bank
       * creeps to the bottom, and a pebble that should have settled drifts
       * for ever. That is exactly what a frictionless object does, and it is
       * not what either of these is.
       *
       * So a FLOOR contact contributes no sideways travel at all: the only
       * thing allowed to move a prop across the ground is `roll`, which is
       * deliberate and has its own drag. A WALL contact is left alone,
       * because there the sideways push IS the collision — it is what stops
       * a rolling seed rather than letting it grind through.
       */
      if (HIT_N.y > FLOOR_FACES_UP) {
        this.at.x = wasX + this.roll.x * dt;
        this.at.z = wasZ + this.roll.z * dt;
      }
      /* Landed. Kill the fall, and take the part of the roll that was
       * heading into the surface with it — a pebble against a wall stops
       * rather than grinding along it. */
      this.fall = 0;
      const into = this.roll.dot(HIT_N);
      if (into < 0) this.roll.addScaledVector(HIT_N, -into);
      this.rollOn(rest, dt);
    } else {
      /* Airborne: it keeps whatever sideways travel it had, and gravity
       * does the rest. No air steering. */
      this.roll.multiplyScalar(Math.max(0, 1 - ROLL_DRAG * dt * 0.25));
    }
    this.root.position.copy(this.at);
  }

  /** Where its centre rests above the ground it sits on. */
  private get rest(): number {
    const r = this.spec.halfMm / MM;
    if (this.spec.kind === 'leaf') return r * 0.08;
    if (this.spec.kind === 'twig') return r * 0.14;
    return r * 0.7;
  }

  dispose(): void {
    this.root.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
  }
}

/**
 * Where the island seeds them: a scatter around her founding spot, close
 * enough to meet by walking rather than by searching. Offsets are in mm and
 * deliberately spread over the arc she does not start facing, so the first
 * one is found rather than handed over.
 */
export const PROP_SCATTER: { key: string; dxMm: number; dzMm: number }[] = [
  { key: 'seed', dxMm: 34, dzMm: -18 },
  { key: 'crumb', dxMm: -26, dzMm: 30 },
  { key: 'leaf', dxMm: 48, dzMm: 26 },
  { key: 'twig', dxMm: -40, dzMm: -34 },
  { key: 'pebble', dxMm: 22, dzMm: 52 },
  { key: 'stone', dxMm: -56, dzMm: 12 },
];
