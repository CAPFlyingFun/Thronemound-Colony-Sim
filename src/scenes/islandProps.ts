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

/*
 * HOW MANY CONTACT POINTS A SHAPE IS REDUCED TO — forty, up from fourteen.
 *
 * The old note claimed fourteen was "enough that a twig cannot pivot
 * between two of them". Measured, it is not, and the tipping is what
 * exposed it: fourteen points over a 3000-vertex twig leaves only one or
 * two anywhere near its underside, so the support centroid was a single
 * point somewhere along the stick rather than the LINE a stick actually
 * rests on. Every frame that one point bore the whole load and reported a
 * full-length lever arm on a twig lying perfectly flat, and the thing
 * rotated for ever.
 *
 * A contact patch needs enough points to be a patch. Forty puts a handful
 * along a twig's underside, which is what makes its centroid land under the
 * middle and the tipping settle. The cost is a loop over forty field
 * samples per prop per substep, for the half-dozen props the island seeds —
 * measured against a frame, it does not show.
 */
const HULL_MAX = 40;
const HULL_SPREAD = 34;

const HULL_P = new THREE.Vector3();
const HIT_N = new THREE.Vector3();
const ROLL_N = new THREE.Vector3();
const ROLL_DOWN = new THREE.Vector3();
const ROLL_AXIS = new THREE.Vector3();
const ROLL_Q = new THREE.Quaternion();

/**
 * HOW HARD THINGS FALL — 600 mm/s², up from 45.
 *
 * Reported: "the twig did have gravity, but doesn't act like a real twig and
 * maybe the world gravity is too low", and confirmed as both halves of the
 * problem — "it falls too slowly" AND "it doesn't tumble or lever like a
 * stick". This is the first half.
 *
 * The old figure was 9 world units per second squared, which is 45 mm/s².
 * Measured, that is a twig taking most of a second to fall two centimetres,
 * which is what "too slowly" looks like. It also made the island disagree
 * with ITSELF: a thrown dig charge falls at `CHARGE_GRAVITY_MM`, 600 mm/s²,
 * so a lobbed lump of soil dropped thirteen times harder than a dropped
 * twig in the same world.
 *
 * 600 is therefore not a new invention, it is the number this game already
 * uses for a falling object, and the reasoning written on the charge holds
 * here word for word: real gravity at ant scale would end the fall before a
 * second frame drew it — 9810 mm/s² puts a twig through a 20 mm drop in
 * four frames — so the figure is theatre chosen to READ, and is stated as
 * game tuning rather than physics.
 *
 * DELIBERATELY NOT THE SAME CONSTANT as the charge's, though they are the
 * same value today. The charge's is solved against the soil window — its
 * arc has to complete inside 192 mm or the lob lands outside the field that
 * can record it — and a prop has no such constraint. Sharing one symbol
 * would mean a future retune of the lob's range quietly changing how a
 * dropped pebble falls.
 */
const PROP_GRAVITY = 120; //             120 wu/s² = 600 mm/s²

/**
 * Terminal velocity, 200 mm/s.
 *
 * The old 30 mm/s was the real limiter rather than the gravity: at 600
 * mm/s² a prop reached the old cap in a twentieth of a second and coasted
 * the rest of the way down, so raising gravity alone would have changed
 * almost nothing. Raising it is only safe because of the substepping in
 * `tick` — see there. The cap is what stops a prop that has fallen down a
 * long shaft from arriving with a step no number of substeps is worth.
 */
const PROP_FALL_MAX = 40; //             40 wu/s = 200 mm/s

/**
 * THE FURTHEST A PROP MAY MOVE BETWEEN TWO COLLISION CHECKS, world units.
 *
 * `pushOut` asks the density field whether the prop's own surface points
 * are inside soil. That question is only meaningful if the prop cannot pass
 * THROUGH something between two asks — and the ground is solid all the way
 * down, so the case that matters is a carved tunnel roof, which is a few
 * millimetres of soil with air on both sides.
 *
 * 0.2 world units is a millimetre, comfortably under any roof the shovel
 * leaves. `tick` splits its integration until each piece is under this,
 * which is what lets the terminal velocity above be an honest 200 mm/s
 * rather than a cap chosen to make one frame safe.
 */
const PROP_STEP_MAX = 0.2;

/**
 * HOW IT TUMBLES — the second half of the twig report.
 *
 * `TIP_GAIN` scales the torque a contact applies; 1 is the physical rate
 * for a thin rod and is what this uses. `TIP_DRAG` bleeds spin away so a
 * settling prop stops rather than rocking for ever, and `TIP_REST` is the
 * rate below which it is simply called still.
 */
/** Radians a second per unit of off-centre support, and the ceiling on it.
 *  Six radians a second sweeps a stick through a right angle in about a
 *  quarter of a second, which is what a stick falling over looks like. */
const TIP_RATE = 12;
const TIP_MAX = 6;
/** How far off centre the support may sit before it is a tip rather than a
 *  wobble, as a fraction of the prop's own length — its contact patch. See
 *  `tipOver`, where the alternative was a twig that crept for ever. */
const TIP_SETTLE = 0.12;
/** How close to the soil a hull point counts as bearing load. A few skins:
 *  a resting prop is held clear by one, so a band narrower than that sees a
 *  single contact where there are really several. See `pushOut`. */
const TIP_BAND = PROP_SKIN * 6;

/**
 * A SETTLED THING STOPS BEING SIMULATED, and this is the honest fix for the
 * last of the twig's fidgeting rather than another damping constant.
 *
 * With gravity, a contact patch and a centroid lever all in, a dropped twig
 * lands flat in a third of a second and then — measured over two simulated
 * minutes — rocked between half a degree and six, for ever. That is not a
 * force that needs tuning away. It is the discrete hull talking: fourteen
 * points against a sampled field give a support centroid that jitters by a
 * fraction of a millimetre each frame, and an integrator fed jitter
 * integrates it.
 *
 * Every physics engine answers this the same way and for the same reason: a
 * body whose motion stays under a threshold for long enough is put to
 * sleep, and stops being asked. It is not a cheat, it is an admission that
 * below some scale the simulation has nothing true left to say.
 *
 * WAKING IS THE PART THAT MATTERS, because this game digs. A twig asleep on
 * ground she then tunnels out from under must fall. Rather than a hook from
 * the shovel — which would mean every carve knowing about every prop — a
 * sleeper checks its own footing a few times a second. Fourteen field
 * samples four times a second, for a handful of props, is nothing next to
 * the frame it saves.
 */
/*
 * STILLNESS IS AN EXCURSION, NOT A PER-FRAME STEP, and getting that wrong
 * meant nothing ever slept.
 *
 * A prop at rest is not motionless frame to frame. Gravity pulls it 0.167
 * mm into the soil every frame and `pushOut` lifts it back out, so the
 * per-frame displacement of a perfectly settled twig is one whole frame of
 * gravity — measured, exactly the 0.0333 world units that arithmetic
 * predicts. A test against per-frame movement can therefore never pass, and
 * did not.
 *
 * What IS true of a settled prop is that it stays in the same PLACE: it
 * buzzes inside a fraction of a millimetre and goes nowhere. So the
 * reference is a remembered position, and the prop has to stay inside a
 * small ball around it — and hold the same attitude — for long enough.
 */
const SLEEP_AFTER = 0.5; //   seconds inside the ball before it nods off
const SLEEP_BALL = 0.06; //   0.3 mm of buzz is still the same place
const SLEEP_TURN = 0.05; //   ~3 degrees of attitude, likewise
const SLEEP_POLL = 0.2; //    seconds between a sleeper's footing checks

const TIP_LEVER = new THREE.Vector3();
const TIP_AXIS = new THREE.Vector3();
const TIP_TORQUE = new THREE.Vector3();
const TIP_Q = new THREE.Quaternion();

/**
 * WHICH THINGS ROLL — by shape, because that is what rolling is about.
 *
 * Asked for: "with say round objects or the egg shaped object, it should
 * naturally roll around when released and will move around until it finds
 * the right balance on the ground".
 *
 * A seed is a squashed sphere and a rock is a dodecahedron; both are round
 * enough that resting on a slope looks wrong. A twig is not — it stays put.
 * Kept as a set rather than a flag on every spec because it is a fact about
 * the SHAPE, and the shape is what `kind` already names.
 *
 * A CLOD DOES NOT ROLL, and that is the honest reading of what it is: a
 * lump of damp soil that fell out of a tunnel wall, not a pebble. It lands
 * where it lands.
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
  kind: 'seed' | 'crumb' | 'twig' | 'clod' | 'rock';
  massMg: number;
  /** Rough half-extent, mm — its footprint and its grab radius. */
  halfMm: number;
  colour: number;
  /**
   * The GLB under `public/models`, for the ones that have real art.
   *
   * Asked for: "can you replace the procedural objects with the real glb
   * models now like the twig, rock, dirt, etc." Where a model is named the
   * prop wears it; where one is not, the procedural shape stands, and it
   * stands anyway until the file arrives (and if it never does) — see
   * `Prop.dress`. A prop that vanished on a failed fetch would be a thing
   * she can still trip over and no longer see.
   */
  model?: string;
}

/*
 * THE SET, and it is chosen to span all three verdicts for the ant playing
 * today rather than to decorate. A queen carries the first four and drags
 * the two rocks; the 120mg rock she cannot move at all, which is the only
 * way `immobile` is ever taught before there is a second caste to teach it.
 *
 * THE LEAF HAS GONE, at Joshua's ask: "can drop the leaf until I get a real
 * model." It was the one prop whose procedural shape was a flat disc, which
 * is why it needed the double-sided special case — that has gone with it and
 * will come back as a fact about the model rather than about a circle.
 *
 * THE CLOD IS NEW, and it is the "dirt" of the ask. It is also the heaviest
 * thing she can still CARRY rather than drag, which is a gap the set did not
 * cover: seed, crumb and twig are all comfortably inside her 20 mg limit and
 * the pebble at 22 is just outside it, so nothing sat at the top of the
 * carry band where the pace taper actually bites.
 */
export const PROP_SPECS: Record<string, PropSpec> = {
  seed: { kind: 'seed', massMg: 3, halfMm: 1.1, colour: 0xb99a5c },
  crumb: { kind: 'crumb', massMg: 5, halfMm: 1.2, colour: 0xa8793e },
  twig: { kind: 'twig', massMg: 8, halfMm: 5.5, colour: 0x77563a, model: 'twig-model.glb' },
  /*
   * 3.2 mm across and 13 mg. Soil runs about 1.5 mg per cubic millimetre
   * wet, and the model's box at this size holds roughly nine — so the mass
   * is the volume rather than a number picked to feel right. GAME TUNING in
   * that the density is a textbook figure and not a measurement of this
   * island's dirt.
   */
  clod: { kind: 'clod', massMg: 13, halfMm: 1.6, colour: 0x6b5138, model: 'dirt-clod.glb' },
  pebble: { kind: 'rock', massMg: 22, halfMm: 2.4, colour: 0x8d8d94, model: 'rock-model.glb' },
  stone: { kind: 'rock', massMg: 120, halfMm: 4.4, colour: 0x7d7d86, model: 'rock-model.glb' },
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

  /** How fast it turned last frame, radians a second — for the sleep test.
   *  Angular things only; see `tipOver`. */
  private turning = 0;

  /** Seconds it has been near enough to still, and whether it has nodded
   *  off — see `SLEEP_AFTER`. */
  private still = 0;

  private asleep = false;

  private napFor = 0;

  /** Where and how it was sitting when it last looked settled — the centre
   *  of the ball it has to stay inside. See `SLEEP_BALL`. */
  private readonly restAt = new THREE.Vector3();

  private readonly restQ = new THREE.Quaternion();

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

  /** The stand-in shape, kept so `dress` can take it away again. */
  private drawn: THREE.Mesh | null = null;

  /** Which way it is longest, in its own frame, and by how much against its
   *  next widest axis. Measured off the hull — see `measureShape`. */
  private readonly longAxis = new THREE.Vector3(0, 0, 1);

  private slender = 1;

  /** Has it already found its balance? See the latch note in `tipOver`. */
  private balanced = false;

  constructor(
    readonly id: string,
    readonly spec: PropSpec,
    x: number, y: number, z: number,
  ) {
    this.massMg = spec.massMg;
    this.at.set(x, y, z);
    this.root.position.copy(this.at);

    /*
     * THE PROCEDURAL SHAPE, which is now the FALLBACK rather than the
     * finished article for anything with a `model` — see `dress`. It is
     * built either way and deliberately: a prop that drew nothing until a
     * fetch came back would be a thing she can walk into and cannot see,
     * and if the fetch fails it would stay that way.
     *
     * Every shape here is a closed solid, so single-sided is not just fine
     * but wanted: you can never see the inside of a rock, and drawing it is
     * fill rate spent on nothing. The one exception was the leaf, a single
     * disc whose underside was missing until it was made double-sided —
     * that has gone with the leaf, and when a leaf MODEL arrives its
     * sidedness will be a fact about the mesh rather than about a circle.
     */
    const mat = new THREE.MeshLambertMaterial({ color: spec.colour });
    const r = spec.halfMm / MM;
    let geo: THREE.BufferGeometry;
    if (spec.kind === 'twig') {
      geo = new THREE.CylinderGeometry(r * 0.12, r * 0.15, r * 2, 8);
      geo.rotateX(Math.PI / 2);
    } else if (spec.kind === 'seed') {
      geo = new THREE.SphereGeometry(r, 10, 8);
      geo.scale(1, 0.7, 1.5);
    } else {
      geo = new THREE.DodecahedronGeometry(r, spec.kind === 'rock' ? 1 : 0);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    this.root.add(mesh);
    this.drawn = mesh;
    this.buildHull(geo);
    this.measureShape();
    /* A stone is not a sphere sitting on a plane; it is bedded in. Half a
     * radius down looks planted rather than balanced. */
    this.root.rotation.y = (spec.massMg * 1.7) % Math.PI;
  }

  /**
   * GIVE IT ITS REAL BODY — the GLB in place of the stand-in shape.
   *
   * Asked for: "can you replace the procedural objects with the real glb
   * models now like the twig, rock, dirt, etc."
   *
   * The template is fetched ONCE per file by the scene and handed here, so
   * two rocks are one download and one geometry; `Object3D.clone` shares
   * both, which is exactly what is wanted for scenery.
   *
   * ## The fit is measured, not tabled
   *
   * `creatureScale` carries a hand-computed `fit` per creature because a
   * creature's size is a biological claim that has to reproduce exactly.
   * A prop's is not: `halfMm` already says how big the thing is, so the
   * scale is just whatever makes the model that size, and computing it from
   * the template's own box means re-exporting a model at a different scale
   * cannot silently resize the prop. There is no number here to go stale.
   *
   * ## And the hull is rebuilt, which is the part that matters
   *
   * The collision points come off the MESH — asked for directly: "could do
   * it mesh instead of shape for the collisions and would naturally be the
   * right shape." Dressing a prop without re-hulling it would leave a twig
   * that looks like a twig and collides like a cylinder, which is the
   * same class of bug as standing on the stale heightfield: the picture and
   * the physics describing different objects.
   */
  dress(template: THREE.Object3D): void {
    const body = template.clone(true);
    const box = new THREE.Box3().setFromObject(body);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (!(longest > 0)) return;
    /* `halfMm` is a HALF-extent, so the whole thing is twice it. */
    const fit = (this.spec.halfMm * 2) / MM / longest;
    /*
     * A LONG THING LIES ALONG Z, because that is the convention the rest of
     * this file already uses — the procedural twig is a cylinder rotated
     * onto Z, and `grip` records a carried pose relative to that. The twig
     * model is modelled along X, so without this it would be carried and
     * dropped across her rather than in front of her.
     *
     * Only for shapes that are genuinely elongated. Measured on the three
     * models: the twig is 1.90 against 0.47 on its next axis, while the
     * rock (1.90 / 1.69) and the clod (1.89 / 1.56) are within half again
     * of round — turning those would be turning a rock for no reason.
     */
    const axes = [size.x, size.y, size.z];
    const next = axes.slice().sort((a, b) => b - a)[1] ?? longest;
    if (longest > next * 1.5) {
      if (longest === size.x) body.rotation.y = Math.PI / 2;
      else if (longest === size.y) body.rotation.x = Math.PI / 2;
    }
    body.scale.setScalar(fit);
    body.updateMatrixWorld(true);
    if (this.drawn) {
      this.root.remove(this.drawn);
      this.drawn.geometry.dispose();
    }
    this.root.add(body);
    this.drawn = null;
    /*
     * RE-HULLED IN THE PROP'S OWN FRAME. `buildHull` reads a geometry's raw
     * vertices, which for a scaled and turned clone are not where the thing
     * actually is — so the points are taken through the clone's world
     * matrix relative to the prop's root instead.
     */
    this.hull.length = 0;
    const toLocal = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    this.root.updateMatrixWorld(true);
    body.traverse((n) => {
      const m = n as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const geo2 = m.geometry.clone();
      geo2.applyMatrix4(new THREE.Matrix4()
        .multiplyMatrices(toLocal, m.matrixWorld));
      this.buildHull(geo2);
      geo2.dispose();
    });
    this.measureShape();
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

  /**
   * WHICH WAY IT IS LONGEST, off the hull it actually collides with.
   *
   * Taken from the hull rather than the spec so it survives `dress`: a prop
   * wearing a GLB has whatever proportions the model has, and asking the
   * shape is the only way to know them. `slender` is the ratio against the
   * next widest axis, which is what decides whether "its long axis" is a
   * meaningful idea for this shape at all.
   */
  private measureShape(): void {
    let ex = 0;
    let ey = 0;
    let ez = 0;
    for (let i = 0; i < this.hull.length; i += 3) {
      ex = Math.max(ex, Math.abs(this.hull[i]!));
      ey = Math.max(ey, Math.abs(this.hull[i + 1]!));
      ez = Math.max(ez, Math.abs(this.hull[i + 2]!));
    }
    const sorted = [ex, ey, ez].sort((a, b) => b - a);
    this.slender = sorted[1]! > 1e-6 ? sorted[0]! / sorted[1]! : 1;
    if (ex >= ey && ex >= ez) this.longAxis.set(1, 0, 0);
    else if (ey >= ez) this.longAxis.set(0, 1, 0);
    else this.longAxis.set(0, 0, 1);
  }

  /** For tests and probes: whether it has settled, and how it is moving. */
  get restForTest(): {
    asleep: boolean; balanced: boolean; still: number; turning: number;
    slender: number;
    longAxis: [number, number, number];
  } {
    return {
      asleep: this.asleep, balanced: this.balanced,
      still: +this.still.toFixed(3),
      turning: +this.turning.toFixed(3), slender: +this.slender.toFixed(2),
      longAxis: [this.longAxis.x, this.longAxis.y, this.longAxis.z],
    };
  }

  /** For tests: how fast it is ROLLING, which is not how fast it is
   *  travelling — on a steep face most of the travel is a fall. */
  get rollSpeedForTest(): number { return this.roll.length(); }

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
    /*
     * TWO ANSWERS FROM ONE SWEEP, and they are different questions.
     *
     * The DEEPEST point decides how far to push out — resolving the worst
     * penetration is what un-buries the shape.
     *
     * The lever for `tipOver` is the depth-weighted CENTROID of everything
     * touching, which is not the same place and must not be. A rod lying
     * flat on the ground touches along its whole length; taking the single
     * deepest of those contacts picks an arbitrary point off to one side
     * and reports a lever that is not there. Measured with the deepest
     * point, a settled twig never stopped — it crept 3.6 degrees every five
     * seconds for ever, because the phantom lever kept feeding it torque.
     *
     * The centroid gets it right at both ends by construction: spread the
     * contacts along a rod and they average to a point under its centre,
     * which is zero torque and a thing at rest. Put them all at one end and
     * the average IS that end, which is the full lever and a stick that
     * levers.
     */
    let load = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < this.hull.length; i += 3) {
      HULL_P.set(this.hull[i]!, this.hull[i + 1]!, this.hull[i + 2]!)
        .applyQuaternion(this.root.quaternion)
        .add(this.at);
      const depth = rest.insideBy(HULL_P.x, HULL_P.y, HULL_P.z);
      if (depth > worst) { worst = depth; wx = HULL_P.x; wy = HULL_P.y; wz = HULL_P.z; }
      /*
       * SUPPORT COMES FROM EVERYTHING TOUCHING, not only from what is
       * buried — and the band is what makes a settled prop settle.
       *
       * `pushOut` resolves a penetration and adds `PROP_SKIN` on top, so a
       * prop at rest is held just clear of the soil and typically has
       * exactly ONE point actually inside it on any given frame. Weighting
       * the centroid by penetration alone therefore put the whole support
       * on that single point, which for a twig is somewhere near an end:
       * a full-length lever arm, on a twig lying perfectly flat. Measured,
       * it rocked through seven degrees and never stopped.
       *
       * A band a few skins deep counts a point that is ALMOST touching as
       * bearing load, which is what it is. A flat twig then has most of its
       * length supporting it, the centroid lands under the middle, and the
       * arm falls inside the contact patch where `tipOver` calls it still.
       */
      const bearing = depth + TIP_BAND;
      if (bearing <= 0) continue;
      load += bearing;
      cx += HULL_P.x * bearing;
      cy += HULL_P.y * bearing;
      cz += HULL_P.z * bearing;
    }
    if (worst <= 0) return false;
    rest.soilNormal(wx, wy, wz, HIT_N);
    if (HIT_N.lengthSq() < 1e-9) { HIT_N.set(0, 1, 0); } else { HIT_N.normalize(); }
    /* WHERE it is being held up, from the centre — the lever arm, which is
     * the whole of what makes a stick behave like a stick. See `tipOver`. */
    TIP_LEVER.set(
      cx / load - this.at.x, cy / load - this.at.y, cz / load - this.at.z,
    );
    /* A skin, so it rests ON the surface rather than exactly in it, where
     * the next frame's read could go either way and the prop would buzz. */
    this.at.addScaledVector(HIT_N, worst + PROP_SKIN);
    return true;
  }

  /**
   * IT TIPS AND LEVERS — for the things that are not round.
   *
   * Reported: the twig "doesn't tumble or lever like a stick". It did not,
   * and could not: `rollOn` turns the ROUND props and nothing turned the
   * others at all, so a twig kept whatever angle it was scattered with for
   * the whole game. Drop one across a ridge and it stayed a rigid bar lying
   * at the angle it happened to have.
   *
   * ## It is a lever, not a physics engine
   *
   * Gravity acts at the centre of mass and the ground pushes back at the
   * CONTACT. When those two are not in line the pair is a couple, and the
   * body turns — that is the entire mechanism, and it is one cross product.
   * `pushOut` has already found the contact and its normal, so nothing new
   * has to be searched for.
   *
   * The consequences fall out rather than being written:
   *
   *   - a stick landing on one end swings the free end down, because the
   *     lever is nearly the whole half-length and square to the push;
   *   - a stick balanced across a ridge under its middle barely turns,
   *     because the lever is short;
   *   - anything lying flat STOPS, because a contact directly under the
   *     centre gives a lever parallel to the normal and a zero cross
   *     product. Coming to rest is the same equation reaching zero rather
   *     than a separate "is it settled" test.
   *
   * ## The rate is a rod's, not a fudge
   *
   * For a thin rod of length L the moment of inertia about its centre is
   * mL²/12, so the angular acceleration under a support force mg at lever r
   * is 12 g (r x n) / L². Written that way `TIP_GAIN` is 1 and means it:
   * turning it down is admitting to slowing the world, which is the thing
   * the report was about in the first place.
   */
  private tipOver(dt: number): void {
    if (dt <= 0) return;
    const len = (this.spec.halfMm * 2) / MM;
    /*
     * A THING RESTS ON A PATCH, NOT ON A POINT — and without saying so it
     * never comes to rest at all.
     *
     * The moment arm is the part of the lever ACROSS the support, and for a
     * settled prop it is never exactly nought: the hull is fourteen points
     * against a sampled field, so the support centroid wanders by a
     * fraction of a millimetre every frame. Real objects do not tip on
     * that, and the reason is not damping — a body is stable while its
     * support is anywhere under it, because the contact is an AREA. So the
     * arm has to clear a fraction of the prop's own length before it counts
     * as a tip rather than a wobble.
     */
    if (this.balanced) return;
    const along = TIP_LEVER.dot(HIT_N);
    const arm = Math.sqrt(Math.max(0, TIP_LEVER.lengthSq() - along * along));
    /*
     * ONCE BALANCED, IT STAYS BALANCED until something wakes it — and the
     * latch is what makes this terminate at all.
     *
     * Re-asking every frame does not converge. The support centroid comes
     * off fourteen hull points against a sampled field, so it wanders by a
     * fraction of a millimetre frame to frame, and every so often it lands
     * at an end and reports a full-length lever on a twig that is lying
     * perfectly flat. One such frame is a tenth of a radian of rotation,
     * which is enough to keep the prop from ever being still long enough to
     * fall asleep — measured, that is exactly what kept it awake.
     *
     * A latch says the thing an unlatched threshold cannot: this prop has
     * already found its balance, and a later frame's noisier reading is not
     * new information. `wake` clears it, and `wake` is called on a lift, a
     * drop, and by a sleeper that finds its footing gone.
     */
    if (arm < TIP_SETTLE * len) { this.balanced = true; return; }
    /*
     * DERIVED, NOT INTEGRATED — and that is the whole difference between a
     * stick that tips over and a stick that flaps.
     *
     * The first cut was honest physics: torque from the couple, integrated
     * into an angular velocity, damped. It oscillated, and badly — measured,
     * a twig dropped at an angle was still moving half a millimetre and
     * five degrees EVERY FRAME two minutes later. That is what an explicit
     * integrator does against a penalty contact with no impulse and no
     * restitution: the push kicks it past balance, the next frame kicks it
     * back, and the pair never agree.
     *
     * `rollOn` already solved the same problem the same way and says so —
     * "the spin is derived from the travel rather than integrated
     * separately, so it cannot visually skid". Here the rotation is derived
     * from the ARM: turn toward putting the support back under the centre,
     * at a rate set by how far off it is and bounded so one frame can never
     * overshoot. It cannot oscillate, because the rate goes to zero exactly
     * where the thing is balanced, and it cannot flap, because nothing is
     * stored between frames to build up.
     *
     * What this gives up is a stick that keeps tumbling through the air
     * after it is knocked. Nothing on this island throws one far enough for
     * that to be visible — a dropped twig falls about two millimetres — and
     * it is the honest trade for a twig that actually settles.
     */
    TIP_TORQUE.copy(TIP_LEVER).cross(HIT_N);
    /*
     * NOT ABOUT ITS OWN LONG AXIS, or it barrel-rolls for ever.
     *
     * A rod is symmetric about its length, so turning it that way changes
     * nothing about where it is supported: the arm that drove the rotation
     * is exactly as long afterwards, and the next frame turns it again the
     * same way. Measured, that is precisely what happened — a twig lying
     * flat with its support a hair to one side span at the full six radians
     * a second, for ever, and the rotation could not possibly fix the thing
     * that caused it.
     *
     * A real stick in that position does not spin either. It either rolls
     * sideways, which is a TRANSLATION this shape does not do (it is not
     * round — see `ROLLS`), or it simply sits there, which is the honest
     * answer for a twig on flat ground.
     *
     * Only for shapes that HAVE a long axis, measured off the hull rather
     * than assumed: a lump has no barrel to roll about and suppressing an
     * arbitrary axis on one would be removing a real degree of freedom.
     */
    if (this.slender > 1.35) {
      TIP_AXIS.copy(this.longAxis).applyQuaternion(this.root.quaternion);
      TIP_TORQUE.addScaledVector(TIP_AXIS, -TIP_TORQUE.dot(TIP_AXIS));
    }
    const swing = TIP_TORQUE.length();
    if (swing < 1e-9) return;
    const rate = Math.min(TIP_MAX, (TIP_RATE * arm) / len);
    TIP_Q.setFromAxisAngle(TIP_TORQUE.divideScalar(swing), rate * dt);
    this.root.quaternion.premultiply(TIP_Q).normalize();
    /*
     * IT PIVOTS ABOUT THE CONTACT, NOT ABOUT ITS OWN CENTRE — and this is
     * the difference between a stick tipping over and a stick on a
     * treadmill.
     *
     * Turning a body about its centre drives one end straight into the
     * ground. `pushOut` then lifts the whole prop back out along the
     * normal, which undoes exactly the tilt that was just applied: measured,
     * the twig turned at the full six radians a second FOR EVER while its
     * attitude never changed by more than a fraction of a degree, because
     * every frame's rotation was being cancelled by that frame's push.
     *
     * A real stick tipping over an edge pivots about the edge. The contact
     * stays put and the CENTRE swings — which is what makes the free end
     * come down and, crucially, what makes the support geometry change so
     * the arm shrinks and the thing settles. One line, and it is the line
     * that turns an endless rotation into a fall.
     */
    this.turning = rate;
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
      this.turning = 0;
      /* In her jaws it is being carried, not resting — so the moment she
       * puts it down it has to fall, not resume a nap it took before she
       * picked it up. */
      this.wake();
      return;
    }
    /*
     * SUBSTEPPED, so a fast fall is still a fall and not a teleport.
     *
     * `pushOut` asks whether the prop's surface is inside soil. Between two
     * asks it must not have passed clean THROUGH anything — and now that
     * terminal velocity is 200 mm/s rather than 30, one frame at 60 Hz is
     * over three millimetres, which is thicker than some tunnel roofs the
     * shovel leaves. Splitting the frame is what lets the speed be honest
     * instead of being held down to whatever one step could survive.
     *
     * Capped at eight pieces: past that the prop is moving faster than
     * anything on this island throws it, and the cost of being exactly
     * right stops being worth paying every frame.
     */
    /*
     * ASLEEP: nothing to do but check now and then that the ground it
     * settled on is still there. See `SLEEP_AFTER`.
     */
    if (this.asleep) {
      this.napFor += dt;
      if (this.napFor < SLEEP_POLL) return;
      this.napFor = 0;
      if (this.footed(rest)) return;
      this.wake();
    }

    const travel = Math.abs(this.fall * dt) + this.roll.length() * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(travel / PROP_STEP_MAX)));
    for (let n = 0; n < steps; n += 1) this.step(rest, dt / steps);

    /*
     * HAS IT GONE ANYWHERE? Position and attitude both, because a prop can
     * be turning on the spot or sliding without turning, and either one
     * means it is not finished.
     */
    if (this.still <= 0) {
      this.restAt.copy(this.at);
      this.restQ.copy(this.root.quaternion);
    }
    const strayed = this.at.distanceTo(this.restAt) > SLEEP_BALL
      || this.root.quaternion.angleTo(this.restQ) > SLEEP_TURN;
    if (strayed) {
      this.still = 0;
      return;
    }
    this.still += dt;
    if (this.still >= SLEEP_AFTER) {
      this.asleep = true;
      this.napFor = 0;
      this.turning = 0;
      this.roll.set(0, 0, 0);
      this.fall = 0;
      /* Parked exactly where it was remembered, so the frame it falls
       * asleep is not also a frame it visibly hops. */
      this.at.copy(this.restAt);
      this.root.quaternion.copy(this.restQ);
      this.root.position.copy(this.at);
    }
  }

  /**
   * Put it back to work — after a lift, a drop, or anything else that means
   * where it was resting is no longer where it is.
   */
  wake(): void {
    this.asleep = false;
    this.balanced = false;
    this.still = 0;
    this.napFor = 0;
  }

  /** Is any part of it still touching soil? A sleeper's own footing check. */
  private footed(rest: PropGround): boolean {
    for (let i = 0; i < this.hull.length; i += 3) {
      HULL_P.set(this.hull[i]!, this.hull[i + 1]!, this.hull[i + 2]!)
        .applyQuaternion(this.root.quaternion)
        .add(this.at);
      if (rest.insideBy(HULL_P.x, HULL_P.y, HULL_P.z) > -TIP_BAND * 3) return true;
    }
    return false;
  }

  /** One piece of a frame — see the substepping note in `tick`. */
  private step(rest: PropGround, dt: number): void {
    this.turning = 0;
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
      /* ROUND THINGS ROLL, ANGULAR THINGS TIP — one or the other, never
       * both, or a pebble would be turned twice by two rules that disagree
       * about which way. `rollOn` already returns immediately for anything
       * outside `ROLLS`, so this is the other half of that same split. */
      if (!ROLLS.has(this.spec.kind)) this.tipOver(dt);
    } else {
      /* Airborne: it keeps whatever sideways travel it had, and gravity
       * does the rest. No air steering — and no torque either, because
       * nothing is pushing on it. A stick knocked spinning keeps spinning
       * until it lands, which is what a thrown stick does. */
      this.roll.multiplyScalar(Math.max(0, 1 - ROLL_DRAG * dt * 0.25));
    }
    this.root.position.copy(this.at);
  }

  /** Where its centre rests above the ground it sits on. */
  private get rest(): number {
    const r = this.spec.halfMm / MM;
    /* A twig is thin, so its centre sits close to the ground; a clod is
     * flattish and sits lower than a rock without lying flat. Measured off
     * each model's own box against its longest axis: the twig 0.25, the
     * clod 0.51, the rock 1.14 — halved, because this is a centre height
     * rather than a thickness, and scaled to `halfMm` like everything else
     * on this class. */
    if (this.spec.kind === 'twig') return r * 0.14;
    if (this.spec.kind === 'clod') return r * 0.26;
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
  { key: 'clod', dxMm: 48, dzMm: 26 },
  { key: 'twig', dxMm: -40, dzMm: -34 },
  { key: 'pebble', dxMm: 22, dzMm: 52 },
  { key: 'stone', dxMm: -56, dzMm: 12 },
];
