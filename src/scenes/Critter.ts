/**
 * A CREATURE WITH A MODEL, A BRAIN, AND A PLACE TO STAND.
 *
 * Asked for: "I will want the fly, aphid and worm in the game", and the
 * aphid to replace the procedural ladybug at "about the same 2-3 mm like a
 * real aphid".
 *
 * The worm already had a body of its own, because a worm is not shaped like
 * anything else here — it is a tube laid along the hole it dug, and
 * `WormBody` exists for exactly that. This is the OTHER shape: a small
 * animal that stands on the ground on legs, which is the fly, the aphid,
 * and every beetle and ladybug that arrives later. One class, driven by the
 * species table, so a new one is a spawn rather than a file.
 *
 * ## It decides nothing itself
 *
 * The behaviour is `creatureBrain` and the numbers are `creatureKinds`.
 * What lives here is the part a brain cannot do: where the ground is, which
 * way the body is pointed, and how the model is drawn. Keeping that split
 * is what let thirty-one unit tests pin the FSM without a browser.
 *
 * ## The ground it stands on is the SOIL, not the heightfield
 *
 * `footingFrom(x, z, y)` — the same function the colonists were fixed to
 * use. This repo has shipped the other mistake four times: `walkGroundAt` is
 * the ORIGINAL heightfield and knows nothing about digging, so anything
 * seated on it stands on the ghost of ground that was carved away. Props
 * floated on it, the beetle stood on it, the colonists walked on it, and
 * the worms nearly did. It is written here as a parameter for that reason —
 * a caller has to pass a footing function, and there is no default to
 * reach for in a hurry.
 *
 * ## Animation, honestly
 *
 * None of these GLBs ship a single clip — measured, `aphid.glb` has 57
 * bones and zero animations. Joshua's read is right: they are six-legged
 * like the ant, so the ant's leg drive is the eventual home for this. That
 * is a real piece of work, because the rigs name their bones `Bone_000`
 * and the leg chains have to be identified by geometry rather than name.
 *
 * The legs are found by GEOMETRY, because the rigs do not name anything.
 * Every bone in `aphid.glb` is called `Bone_0NN`, so there is no "leg" to
 * look up. What there is instead is structure, and it is unambiguous once
 * measured: twelve bone tips, of which six sit at ground height in three
 * mirrored ±X pairs — front, middle and hind — while the rest are antennae
 * (high, off the head hub) and mouthparts (clustered at the front). See
 * `findLegs`, which reads that and nothing else.
 *
 * The gait is a TRIPOD, which is what a six-legged insect actually walks:
 * front-left, middle-right and hind-left swing together while the other
 * three carry, then they swap. It is driven by DISTANCE travelled rather
 * than by time, so a creature that slows down does not moonwalk.
 *
 * ## What the rig captures settled, and what they left approximate
 *
 * Joshua's aphid and housefly rig screenshots decided the swing axis. The
 * legs splay LATERALLY on both, so protraction and retraction happen about
 * a roughly VERTICAL axis at the body — an earlier cut swung them about X,
 * which lifts and drops a sideways leg instead of stepping with it.
 *
 * The housefly's front pair is the honest exception: it sweeps FORWARD
 * rather than out, so a vertical swing moves those two side to side rather
 * than fore and aft. Four legs of six are right and two are approximate.
 * Fixing it properly means a per-leg axis taken from the limb's own rest
 * direction, which is worth doing and is not what this is.
 *
 * The wings are safely ignored by construction rather than by a special
 * case: they are dorsal, and the search takes the six LOWEST tips.
 */
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MM } from '../world/worldScape';
import {
  type CreatureKind, type CreatureMind, newMind, setBehaviour, speedMm,
  think, thinkDue, tickMind,
} from './creatureBrain';
import { CREATURES } from './creatureScale';
import { aimRotation, footTarget } from '../anim/legIk';

/** How far it may stray from where it was put, in millimetres. */
const ROAM_MM = 60;

/** Seconds before it picks somewhere else to be. */
const DWELL_MIN_S = 2;
const DWELL_MAX_S = 6;

/** How fast it swings onto a new heading, radians a second. */
const TURN = 2.2;

/** The body's own bob, as a fraction of the animal's height. */
const BOB_SHARE = 0.06;

/**
 * How far a leg swings, in radians, and how many full strides it takes per
 * body length travelled.
 *
 * GAME TUNING, but measured rather than eyeballed — `legReportForTest`
 * reports each foot's travel IN THE CREATURE'S OWN FRAME, which is the only
 * way to see the leg rather than the journey. At 0.22 the aphid's foot
 * covers about a fifth of its body length per stride and the housefly's
 * about two fifths, which reads as walking. At 0.42 the fly's stride was
 * two thirds of its body and it flailed; these rigs are posed splayed and
 * do not take the arc a real insect does.
 */
const LEG_SWING = 0.22;
const STRIDES_PER_LENGTH = 1.8;

/** The idle's breath: how far the legs stir when it is standing still. */
const IDLE_STIR = 0.02;
/** And how fast, in cycles a second — slow enough to read as alive. */
const IDLE_RATE = 0.55;

/**
 * PUTTING SIX FEET ON THE GROUND — the numbers, and what each is for.
 *
 * Reported from the device: "some of the insects did not stay actually on
 * the ground mesh, but was like maybe doing the average of the mesh."
 *
 * Measured before touching anything, on the island's own soil: a housefly's
 * six feet ran from 5.51 mm BURIED to 5.77 mm in the AIR — an 11.28 mm
 * spread on a 6.5 mm animal, so the error was larger than the insect. The
 * body was seated exactly right (0.00 mm off the soil at its centre); the
 * legs simply never asked where the ground was. That is the "average" look:
 * one sample under the body, and six feet hanging wherever the swing left
 * them.
 */

/** How far the drawn claw is held off the surface, as a share of the
 *  creature's height — the same idea as `sole` on the queen, which exists
 *  because a target of exactly the surface lands a hair under it about half
 *  the time in float32. */
const FOOT_CLEAR = 0.02;

/*
 * THERE IS NO BAND, AND THAT IS DELIBERATE — the phase already knows.
 *
 * `QueenModel` uses a band to tell a stance foot from a swinging one: a foot
 * within a band of the ground is trying to stand and gets planted, anything
 * clearly higher is mid-step and is left alone. It has to guess that way,
 * because its gait poses legs without saying which are carrying.
 *
 * Here the gait is `pose`, and it knows exactly which half of the tripod is
 * swinging — that is what `Leg.phase` is. So a stance foot is planted
 * HOWEVER HIGH it starts, and only the swinging half is left up.
 *
 * Guessing by height was measured and it is not good enough: a housefly's
 * bind pose splays its legs so far that three of its six feet sat more than
 * 3 mm above the soil while it was standing perfectly still, and a band
 * wide enough to catch those would also drag down every foot mid-step.
 * Asking the gait costs nothing and cannot be wrong.
 */

/** How high the swinging half of the tripod lifts, as a share of height.
 *  Without it every foot is always in stance — the legs would grip the
 *  ground and the body would glide, which reads as a table on castors. */
const STEP_LIFT = 0.13;

/**
 * CCD passes per foot per frame.
 *
 * Measured across 4,500 aphid and 2,700 housefly foot samples, mean error
 * from the soil: 3 passes 0.264 / 0.527 mm, 6 passes 0.246 / 0.484, 10
 * passes 0.238 / 0.464. Four hundredths of a millimetre for twice the work
 * and two hundredths for three times it — so the residue is the limb not
 * quite REACHING with its coxa held by the gait, not the solver failing to
 * converge, and more passes cannot buy what the geometry will not give.
 */
const IK_PASSES = 3;

const S_FOOT = new THREE.Vector3();
const S_JOINT = new THREE.Vector3();
const S_TARGET = new THREE.Vector3();
const S_AXIS = new THREE.Vector3();
const S_SPIN = new THREE.Quaternion();
const S_PARENT = new THREE.Quaternion();

const S_WANT = new THREE.Vector3();
const S_FLAT = new THREE.Vector3();
const S_TURN = new THREE.Quaternion();

/** One leg: the bone that swings, its rest pose, and its tripod phase. */
export interface Leg {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  /** 0 or 1 — which half of the tripod it belongs to. */
  phase: number;
  /** The axis it swings about, in its parent's frame. */
  axis: THREE.Vector3;
  /** Where its foot rests, in the creature's frame — for gait checking. */
  seat: THREE.Vector3;
  /**
   * THE WHOLE LIMB, coxa first and foot last, with the pose it shipped in.
   *
   * The gait turns `bone` (the coxa) and nothing else. Planting a foot on
   * real ground needs the joints BELOW that to bend, which means keeping
   * them — and keeping their rest pose, because IK that composes onto last
   * frame's result winds the leg up over a few seconds exactly the way
   * `swingLeg` warns about. Every frame starts from the bind pose.
   */
  chain: THREE.Bone[];
  chainRest: THREE.Quaternion[];
  /** What `findLegs` decided, so a probe can check the DECISION. */
  side: number;
  rank: number;
}

/**
 * THE SIX LEGS, FOUND WITHOUT A SINGLE NAME.
 *
 * Measured on `aphid.glb`: 57 bones, two branch hubs, twelve tips. Six of
 * those tips sit at ground height in mirrored ±X pairs spread along Z —
 * front, middle, hind. The others are antennae (high on Y, off the head
 * hub) and the mouthpart cluster. So the legs are the six LOWEST tips, and
 * the bone that swings each one is the topmost bone of its chain — the
 * joint at the body, which is what a coxa is.
 *
 * Written as a measurement rather than a lookup table on purpose: the fly's
 * rig is a different file with the same problem, and a table would need
 * hand-maintaining per model for no benefit.
 */
export function findLegs(root: THREE.Object3D): Leg[] {
  const tips: THREE.Bone[] = [];
  root.updateMatrixWorld(true);
  root.traverse((n) => {
    const b = n as THREE.Bone;
    if (!b.isBone) return;
    if (b.children.some((c) => (c as THREE.Bone).isBone)) return;
    tips.push(b);
  });
  if (tips.length < 6) return [];
  /*
   * IN THE CREATURE'S OWN FRAME, AND THAT IS THE WHOLE FIX.
   *
   * This used to ask for each bone's WORLD position, and every question it
   * then asked of that position was the wrong question. "Is this foot on
   * the left?" became "is this foot east of the world origin?" — and the
   * island sits entirely at positive X, so the answer was YES for all six
   * legs of every creature on it. Measured: `side` was 1 for all six on
   * both the aphid and the housefly.
   *
   * The gait still looked like SOMETHING because the front-to-back rank,
   * also taken from world Z, happened to interleave the mirrored pairs
   * L, R, L, R — so the phases came out 1,0,1,0,1,0 and the animal walked
   * its three left legs against its three right. That is the "all moving
   * forward and back" Joshua saw: not a tripod, a breaststroke.
   *
   * Left/right and front/back are facts about the BODY, so they have to be
   * read in the body's frame. The lowest-six test moves here too — a
   * creature standing on a slope is tilted in world space, and "lowest"
   * would start picking antennae.
   */
  const localOf = new Map<THREE.Bone, THREE.Vector3>();
  for (const b of tips) {
    localOf.set(b, root.worldToLocal(
      new THREE.Vector3().setFromMatrixPosition(b.matrixWorld),
    ));
  }
  const at = (b: THREE.Bone): THREE.Vector3 => localOf.get(b)!;
  /* Lowest six: the ones standing on the ground. */
  const feet = tips.sort((a, b) => at(a).y - at(b).y).slice(0, 6);
  const legs: Leg[] = [];
  for (const foot of feet) {
    /* Up to the joint at the body — the last bone before the chain stops
     * being a single file, which is where a leg meets a thorax. */
    let bone: THREE.Bone = foot;
    for (;;) {
      const up = bone.parent as THREE.Bone | null;
      if (!up?.isBone) break;
      const kin = up.children.filter((c) => (c as THREE.Bone).isBone);
      if (kin.length > 1) break;
      bone = up;
    }
    const p = at(foot);
    /*
     * THE TRIPOD, from where the foot actually is. A real insect swings
     * front-left, middle-right and hind-left together; the pairing falls
     * straight out of the sign of X against the rank in Z.
     *
     * RANKED WITHIN ITS OWN SIDE, and getting that wrong is what made the
     * gait read as "all moving forward and back" on the device.
     *
     * The first cut ranked each foot against ALL SIX. The legs sit in
     * mirrored pairs at very nearly equal Z, so the counts came out 0, 0,
     * 2, 2, 4, 4 — every one of them EVEN. `(side + rank) % 2` then
     * reduces to `side`, and the animal walks its three left legs together
     * against its three right: not a tripod at all, and the shuffling
     * sideways gait Joshua saw.
     *
     * Counting only the feet on the same side gives the rank that was
     * meant — 0 front, 1 middle, 2 hind — so the two tripods come out
     * front-left/hind-left/middle-right against middle-left/front-right/
     * hind-right, which is the real insect alternating tripod.
     */
    const side = p.x >= 0 ? 1 : 0;
    const rank = feet.filter(
      (o) => (at(o).x >= 0 ? 1 : 0) === side && at(o).z < p.z,
    ).length;
    /*
     * IT SWINGS ABOUT A VERTICAL AXIS, and the rig's own screenshots are
     * what settled that.
     *
     * A first cut swung each leg about the body's X, reasoning about a
     * leg that points forward. Joshua's top-down rig capture shows these
     * legs splay LATERALLY — six long limbs out to the sides, the way an
     * aphid actually stands. Protraction and retraction of a sideways leg
     * is rotation about a roughly VERTICAL axis at the joint, not a
     * fore-and-aft one; swinging such a leg about X lifts and drops it
     * instead of stepping with it.
     *
     * Taken in the bone's PARENT frame, because that is where its own
     * quaternion is applied — the armature carries a transform of its own
     * and assuming an identity frame is a mistake this codebase has
     * already made once, in `WormBody`.
     */
    const parent = (bone.parent ?? root);
    const up = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
      .normalize();
    /* Coxa down to the tip — the joints the plant is allowed to bend. */
    const chain: THREE.Bone[] = [];
    for (let n: THREE.Bone | null = bone; n; ) {
      chain.push(n);
      if (n === foot) break;
      n = (n.children.find((c) => (c as THREE.Bone).isBone) ?? null) as THREE.Bone | null;
    }
    legs.push({
      bone,
      chain,
      chainRest: chain.map((b) => b.quaternion.clone()),
      rest: bone.quaternion.clone(),
      phase: (side + rank) % 2,
      axis: up,
      /* Kept so a probe can check the SEATING, not just that something
       * moved — see `legReportForTest`. Already in the creature's frame. */
      seat: p.clone(),
      side,
      rank,
    });
  }
  return legs;
}

export class Critter {
  readonly root = new THREE.Object3D();

  /** Where it is, in world units. */
  readonly at = new THREE.Vector3();

  /** Which way it faces, radians about Y. */
  facing = 0;

  readonly mind: CreatureMind;

  /** Ready once its model has arrived — before that it is not drawn. */
  ready = false;

  private wantFacing = 0;

  private readonly home = new THREE.Vector3();

  private readonly want = new THREE.Vector3();

  private dwell = 0;

  /** Distance travelled, which is what drives the gait. */
  private gone = 0;

  /** Its own height in world units, measured off the model once it lands. */
  private tall = 0.2;

  /** The six that carry it, found by geometry — see `findLegs`. */
  private legs: Leg[] = [];

  /** Seconds alive, for the idle's breath. A TIME cycle rather than a
   *  distance one, because a standing animal covers no ground. */
  private aliveFor = 0;

  constructor(
    readonly kind: CreatureKind,
    x: number, y: number, z: number,
    private readonly rand: () => number = Math.random,
    index = 0,
  ) {
    this.id = `${kind.id}-${index}`;
    this.at.set(x, y, z);
    this.home.set(x, y, z);
    this.want.copy(this.at);
    /* Its think clock is offset from its neighbours' — see `newMind`. */
    this.mind = newMind(kind, rand());
    this.facing = rand() * Math.PI * 2;
    this.wantFacing = this.facing;
    this.root.position.copy(this.at);
  }

  /**
   * Give it its body. The template is loaded once by the scene and cloned
   * here, so ten aphids are one fetch.
   *
   * `SkeletonUtils.clone` rather than `Object3D.clone`, because a plain
   * clone of a skinned mesh copies the bones but leaves every clone's
   * skeleton pointing at the ORIGINAL's — they all move together and none
   * of them move right.
   */
  dress(template: THREE.Object3D): void {
    const body = cloneSkinned(template);
    const fit = CREATURES[this.kind.id]?.fit;
    if (fit) body.scale.setScalar(fit);
    this.root.add(body);
    /* Its own height, for the gait's bob and for the shove list — measured
     * off the scaled model rather than guessed from `size`, which is a
     * relative bulk and not a length. */
    const box = new THREE.Box3().setFromObject(body);
    this.tall = Math.max(0.05, box.max.y - box.min.y);
    /* Its legs, found by geometry — the rigs name nothing. */
    this.legs = findLegs(body);
    this.ready = true;
  }

  /** How far it reaches from its own centre, for the shove list. */
  get radius(): number { return Math.max(0.08, this.tall * 0.5); }

  /**
   * What it weighs, in milligrams — GAME TUNING from its bulk against the
   * queen's 12 mg, so a fly shoulders an aphid aside and both give way to
   * a worm. Nothing here is a measured mass.
   */
  get massMg(): number { return 12 * this.kind.size; }

  /*
   * ================================================================
   * IT CAN BE FOUGHT, AND THEN CARRIED HOME
   * ================================================================
   *
   * Reported: "I am not able to attack the Aphid and Fly yet."
   *
   * The reason was narrow and structural rather than a missing mechanic.
   * `islandCombat` works on a `Quarry` and `islandCarry` on a `Portable`,
   * and BOTH are structural interfaces — id, somewhere to be, a size, hit
   * points — deliberately so, because that file "does no geometry and
   * should not import a renderer". The only thing standing between a
   * critter and a fight was that `quarryInReach` searched `this.quarry`,
   * which holds beetles, and a critter is not one.
   *
   * So this is the shape rather than a system: four fields, and the jaws
   * that already work on a beetle work on an aphid.
   *
   * HIT POINTS PROXY THE BRAIN rather than sitting beside it. `Combat`
   * writes `hp` directly and the FSM reads `mind.health` to decide whether
   * to run — two numbers for one fact would mean a creature bitten to
   * within an inch of its life wandering about unbothered. One number,
   * read and written through here.
   *
   * A FELLED ONE BECOMES CARGO, which is the beetle's own rule ("a live
   * thing cannot be carried... this is what makes killing it the price of
   * taking it"). Carrying was not asked for and is included anyway,
   * because attacking something you then cannot pick up is a dead end: the
   * fields `Portable` wants beyond `Quarry`'s are `massMg`, which was
   * already here, and the protein below.
   */

  /** `Quarry` and `Portable` both want a string, and it has to be unique
   *  across the island — the kind alone is not. */
  readonly id: string;

  get hp(): number { return this.mind.health; }

  set hp(v: number) { this.mind.health = Math.max(0, v); }

  get hpMax(): number { return this.kind.maxHealth; }

  get alive(): boolean { return this.mind.health > 0; }

  /**
   * Killing it is writing its health to nought, so the brain agrees.
   *
   * `Combat` sets `alive = false` the moment `hp` hits zero, and if that
   * only flipped a flag here the FSM would carry on wandering a corpse
   * about — `think` decides `dead` from `mind.health`, not from a boolean.
   */
  set alive(v: boolean) {
    if (!v) { this.mind.health = 0; this.mind.behaviour = 'dead'; }
  }

  /** Venom sitting in it, and how fast it bleeds off — `Combat` owns both. */
  venomLoad = 0;

  venomRate = 0;

  /**
   * What the colony gets for it, milligrams of usable protein.
   *
   * GAME TUNING, scaled off the beetle's 27 mg by relative bulk so a
   * bestiary stays consistent without a second table: an aphid is a fifth
   * of a beetle and returns about a fifth. Meat is worth roughly half its
   * wet mass here, which is the beetle's ratio and is stated so the number
   * can be argued with rather than rediscovered.
   */
  get proteinMg(): number { return +(this.massMg * 0.5).toFixed(1); }

  /** Set while she has it in her jaws — `Prop` carries the same flag. */
  carried = false;

  /**
   * WHAT IT COSTS TO HOLD ON, and both come off the species table rather
   * than being typed per creature — a bestiary whose fight numbers are
   * hand-written per row drifts the moment a row is added.
   *
   * STRUGGLE is damage a second to the ant gripping it, and it is a
   * QUARTER of what the animal hits for. That is the procedural beetle's
   * own ratio (14 damage, 3.5 struggle), reused rather than reinvented, and
   * it gives the right answer at the bottom of the range for free: an aphid
   * and a housefly have `damage: 0` because neither can hurt an ant, so
   * neither costs anything to hold. Grabbing one should be safe.
   */
  get struggle(): number { return this.kind.damage / 4; }

  /**
   * BREAK-FREE is the chance a second of throwing her off, and a small fast
   * animal is the hard one to keep hold of — so it comes off the creature's
   * own escape speed.
   *
   * The formula is a check on itself: at the beetle's 14 mm/s it returns
   * 0.15 against the hand-tuned 0.16 the procedural beetle has carried
   * since it was the only fight in the game. Reproducing a number that was
   * chosen by feel is the evidence that this is not invented. A housefly at
   * 30 mm/s comes out 0.23 — half again as slippery, which is the whole
   * point of a fly — and an aphid at 5 mm/s barely wriggles at 0.10.
   *
   * GAME TUNING, not biology.
   */
  get breakFree(): number {
    return Math.min(0.6, 0.08 + this.kind.chaseSpeedMm / 200);
  }

  /**
   * One frame.
   *
   * `groundAt` must be SOIL-AWARE — see the note at the top of this file.
   */
  step(dt: number, groundAt: (x: number, z: number) => number): void {
    if (dt <= 0 || !this.alive) return;

    this.aliveFor += dt;
    tickMind(this.kind, this.mind, dt, this.mind.behaviour === 'flee');
    if (thinkDue(this.mind)) {
      /*
       * Nothing reports a threat to it yet, so the FSM settles on wander.
       * The senses are wired HERE rather than faked — when there is
       * something for a fly to be startled by, this is the one line that
       * changes, and the flee behaviour behind it is already tested.
       */
      setBehaviour(this.mind, think(this.kind, this.mind, {
        threat: null,
        prey: null,
        fromHomeMm: this.at.distanceTo(this.home) * MM,
      }));
    }

    const pace = speedMm(this.kind, this.mind) / MM;
    if (pace > 0) {
      this.dwell -= dt;
      if (this.dwell <= 0 || this.at.distanceTo(this.want) < 0.05) {
        /* Somewhere else within reach of where it was put. A creature with
         * no leash is over the horizon in a minute — the same lesson the
         * colonists' roam encodes. */
        const a = this.rand() * Math.PI * 2;
        const r = (ROAM_MM / MM) * (0.3 + this.rand() * 0.7);
        this.want.set(
          this.home.x + Math.cos(a) * r, this.at.y, this.home.z + Math.sin(a) * r,
        );
        this.dwell = DWELL_MIN_S + this.rand() * (DWELL_MAX_S - DWELL_MIN_S);
      }
      S_WANT.copy(this.want).sub(this.at);
      S_WANT.y = 0;
      if (S_WANT.lengthSq() > 1e-9) {
        this.wantFacing = Math.atan2(S_WANT.x, S_WANT.z);
        S_FLAT.copy(S_WANT).normalize().multiplyScalar(pace * dt);
        this.at.x += S_FLAT.x;
        this.at.z += S_FLAT.z;
        this.gone += S_FLAT.length();
      }
    }

    /* Turn toward the heading at a limited rate, the short way round. */
    let gap = this.wantFacing - this.facing;
    while (gap > Math.PI) gap -= Math.PI * 2;
    while (gap < -Math.PI) gap += Math.PI * 2;
    const swing = Math.min(Math.abs(gap), TURN * dt) * Math.sign(gap);
    this.facing += swing;

    /* And it stands on the SOIL, which is the caller's to answer. */
    this.at.y = groundAt(this.at.x, this.at.z);
    this.pose(pace > 0);
    this.plantFeet(groundAt, pace > 0);
  }

  /**
   * PUT EACH FOOT WHERE THE GROUND ACTUALLY IS.
   *
   * `pose` above turns each coxa about a vertical axis, which swings the leg
   * fore and aft and says nothing at all about height. That is why the feet
   * floated and sank: the body was seated on the soil at one sample and the
   * six legs were drawn wherever the swing left them, which on any slope or
   * lump is nowhere near it.
   *
   * The rule is the queen's, reused rather than reinvented — `footTarget`
   * decides the height a foot wants and `aimRotation` is one step of cyclic
   * coordinate descent toward it. What is different here is only the shape
   * of the animal: a critter stands on world up, where she walks walls and
   * carries her own up vector, so the whole surface-frame apparatus that
   * makes `QueenModel` complicated is not needed.
   *
   * ## Every frame starts from the bind pose
   *
   * The chain is reset before the gait and the plant run, for the reason
   * `swingLeg` already gives: IK composed onto its own last answer winds the
   * limb further round every frame and ties the animal in a knot within
   * seconds. The coxa gets its swing from `pose`, and these bend under it.
   *
   * ## The swinging tripod lifts
   *
   * Without a lift every foot is permanently in stance — planted, and
   * sliding as the body moves, which reads as a table on castors rather
   * than an insect. The half of the tripod that is swinging is raised, and
   * `footTarget`'s band then leaves it alone precisely because it is high.
   * So the lift and the plant are the same rule seen from two sides.
   */
  private plantFeet(
    groundAt: (x: number, z: number) => number, moving: boolean,
  ): void {
    if (this.legs.length === 0) return;
    const clear = this.tall * FOOT_CLEAR;
    const lift = this.tall * STEP_LIFT;
    /* The stride's phase, so the two tripods alternate — the same cycle
     * `pose` swings them on, read here rather than recomputed. */
    const strides = (this.gone / Math.max(0.01, this.tall)) * STRIDES_PER_LENGTH;
    this.root.updateMatrixWorld(true);

    for (const leg of this.legs) {
      const foot = leg.chain[leg.chain.length - 1];
      if (!foot || leg.chain.length < 2) continue;
      foot.getWorldPosition(S_FOOT);
      const ground = groundAt(S_FOOT.x, S_FOOT.z);
      /* A swinging foot is asked to be off the ground; a stance foot is
       * asked to be on it. `footTarget` does both from one number. */
      const swinging = moving
        && Math.sin(strides * Math.PI * 2 + leg.phase * Math.PI) > 0;
      /*
       * EVERY FOOT IS PLACED, stance on the soil and swing a little above
       * it — so the band is unbounded in both cases and `footTarget`
       * reduces to its resting height. It is still worth calling rather
       * than inlining: the clearance rule it carries is the reason a foot
       * does not land a hair UNDER the surface half the time in float32.
       *
       * Leaving a swinging foot where the gait put it was tried and
       * measured: the housefly's bind pose splays its legs so wide that a
       * swinging foot sat up to 7.19 mm above the soil on a 6 mm animal —
       * a leg waving in the air rather than taking a step. The gait here
       * only yaws the coxa, so it never had a sensible height to leave
       * alone in the first place.
       */
      const wanted = footTarget(
        S_FOOT.y, ground + (swinging ? lift : 0), clear, Infinity,
      );
      if (Math.abs(wanted - S_FOOT.y) < 1e-6) continue;
      S_TARGET.set(S_FOOT.x, wanted, S_FOOT.z);

      /*
       * TIP-FIRST. CCD converges from either end, and starting at the joint
       * nearest the foot spends the correction on the smallest bones, which
       * keeps the limb's silhouette close to the one the gait posed.
       *
       * The coxa is excluded — index 0 — because the gait owns it. Bending
       * it here would fight `swingLeg` for the same joint and the leg would
       * buzz between the two answers.
       */
      for (let pass = 0; pass < IK_PASSES; pass += 1) {
        for (let j = leg.chain.length - 2; j >= 1; j -= 1) {
          const joint = leg.chain[j]!;
          joint.getWorldPosition(S_JOINT);
          foot.getWorldPosition(S_FOOT);
          const turn = aimRotation(
            [S_JOINT.x, S_JOINT.y, S_JOINT.z],
            [S_FOOT.x, S_FOOT.y, S_FOOT.z],
            [S_TARGET.x, S_TARGET.y, S_TARGET.z],
          );
          if (turn.angle < 1e-6) continue;
          /*
           * The rotation is worked out in WORLD space and a bone stores a
           * LOCAL one, so it is conjugated by the parent's world rotation on
           * the way in. Applying a world quaternion straight to a local one
           * is correct only for a bone whose parents are unrotated — true of
           * every one of these in the bind pose and of none of them once the
           * animal turns.
           */
          S_AXIS.set(turn.axis[0], turn.axis[1], turn.axis[2]);
          S_SPIN.setFromAxisAngle(S_AXIS, turn.angle);
          if (joint.parent) joint.parent.getWorldQuaternion(S_PARENT);
          else S_PARENT.identity();
          joint.quaternion.premultiply(
            S_PARENT.clone().invert().multiply(S_SPIN).multiply(S_PARENT),
          );
          joint.updateMatrixWorld(true);
        }
      }
    }
  }

  /**
   * The whole of the animation, and it is deliberately small.
   *
   * These models ship no clips, so there is nothing to play. A bob tied to
   * DISTANCE travelled — not to time — is what stops a slowing creature
   * moonwalking, and holding perfectly still while idle is what makes the
   * two states read as different at all.
   *
   * When the leg drive learns these rigs this is what it replaces.
   */
  private pose(moving: boolean): void {
    this.root.position.copy(this.at);
    this.root.rotation.y = this.facing;
    this.root.position.y = this.at.y;
    /* Bind pose first — the gait below and the plant after it both compose
     * from rest rather than from last frame. See `plantFeet`. */
    this.restLimbs();

    /*
     * WALKING IS A TRIPOD; IDLING IS A BREATH.
     *
     * The walk is driven by DISTANCE travelled, so a creature that slows
     * does not moonwalk — the same rule the ant's legs follow. The idle is
     * driven by TIME, and it has to be: a standing animal covers no ground,
     * so a distance-driven idle would be perfectly frozen, which is exactly
     * what made these read as models rather than animals.
     */
    if (moving) {
      const strides = (this.gone / Math.max(0.01, this.tall)) * STRIDES_PER_LENGTH;
      const t = strides * Math.PI * 2;
      const bob = Math.abs(Math.sin(strides * Math.PI)) * this.tall * BOB_SHARE;
      this.root.position.y = this.at.y + bob;
      for (const leg of this.legs) {
        /* Half of them a half-cycle out: front-left, middle-right and
         * hind-left swing while the other three carry. */
        this.swingLeg(leg, Math.sin(t + leg.phase * Math.PI) * LEG_SWING);
      }
      return;
    }
    for (const leg of this.legs) {
      this.swingLeg(leg, Math.sin(
        this.aliveFor * IDLE_RATE * Math.PI * 2 + leg.phase * Math.PI,
      ) * IDLE_STIR);
    }
  }

  /**
   * Turn one leg by `angle` FROM ITS REST POSE, never from where it was.
   *
   * Composing onto the live quaternion accumulates: a leg driven that way
   * winds further round every frame and the animal ties itself in a knot
   * within seconds. Every frame is an offset from the pose the rig shipped
   * in — the same reason `QueenModel` keeps a `rest` map.
   */
  /** Back to the bind pose, so neither the gait nor the plant composes onto
   *  its own last answer. See `plantFeet`. */
  private restLimbs(): void {
    for (const leg of this.legs) {
      for (let i = 0; i < leg.chain.length; i += 1) {
        leg.chain[i]!.quaternion.copy(leg.chainRest[i]!);
      }
    }
  }

  private swingLeg(leg: Leg, angle: number): void {
    S_TURN.setFromAxisAngle(leg.axis, angle);
    leg.bone.quaternion.copy(leg.rest).multiply(S_TURN);
  }

  /** For probes: the legs themselves, so a probe can ask where each foot
   *  actually is against the soil rather than in the creature's own frame. */
  get legsForTest(): readonly Leg[] { return this.legs; }

  /** For probes: its own height in world units. */
  get tallForTest(): number { return this.tall; }

  /**
   * For probes: how many legs it found and where their feet are right now.
   *
   * The foot positions are the point. "Six legs were located" only says the
   * search ran; feet that MOVE between frames say the gait is driving them.
   */
  legReportForTest(): {
    legs: number; feetY: number[];
    seats: { x: number; z: number; phase: number; side: number; rank: number }[];
  } {
    this.root.updateMatrixWorld(true);
    return {
      legs: this.legs.length,
      /*
       * WHERE EACH LEG SITS AND WHICH HALF OF THE TRIPOD IT IS IN.
       *
       * `feetY` below proves the legs MOVE. It cannot prove they move in
       * the right PATTERN, and that is the half that was wrong: reported
       * from the device as "aren't walking tri-pod style for 6 legs and
       * they are all moving forward and back". A gait check needs the
       * seating, not just the motion.
       */
      seats: this.legs.map((l) => ({
        x: +l.seat.x.toFixed(3), z: +l.seat.z.toFixed(3), phase: l.phase,
        side: l.side, rank: l.rank,
      })),
      feetY: this.legs.map((l) => {
        const p = new THREE.Vector3();
        /* The far end of the chain, not the joint — a joint at the body
         * barely moves however hard the leg is swinging. */
        let tip: THREE.Object3D = l.bone;
        while (tip.children.some((c) => (c as THREE.Bone).isBone)) {
          tip = tip.children.find((c) => (c as THREE.Bone).isBone)!;
        }
        /*
         * IN THE CREATURE'S OWN FRAME, not the world's.
         *
         * A first cut returned world positions and measured the animal
         * WALKING: every foot translates with the body, so it reported a
         * 6.5 mm fly swinging its feet 22 mm and barely changed when the
         * swing was cut fourfold. Local space isolates the leg from the
         * journey, which is the only thing this is asking about.
         */
        p.setFromMatrixPosition(tip.matrixWorld);
        this.root.worldToLocal(p);
        return +p.z.toFixed(4);
      }),
    };
  }

  dispose(): void {
    this.root.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
