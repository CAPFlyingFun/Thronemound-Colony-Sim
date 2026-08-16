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

const S_WANT = new THREE.Vector3();
const S_FLAT = new THREE.Vector3();
const S_TURN = new THREE.Quaternion();

/** One leg: the bone that swings, its rest pose, and its tripod phase. */
interface Leg {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  /** 0 or 1 — which half of the tripod it belongs to. */
  phase: number;
  /** The axis it swings about, in its parent's frame. */
  axis: THREE.Vector3;
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
function findLegs(root: THREE.Object3D): Leg[] {
  const tips: THREE.Bone[] = [];
  root.updateMatrixWorld(true);
  root.traverse((n) => {
    const b = n as THREE.Bone;
    if (!b.isBone) return;
    if (b.children.some((c) => (c as THREE.Bone).isBone)) return;
    tips.push(b);
  });
  if (tips.length < 6) return [];
  const at = (b: THREE.Bone): THREE.Vector3 =>
    new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
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
     */
    const side = p.x >= 0 ? 1 : 0;
    const rank = feet.filter((o) => at(o).z < p.z).length;
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
    legs.push({
      bone,
      rest: bone.quaternion.clone(),
      phase: (side + rank) % 2,
      axis: up,
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
    readonly id = 0,
  ) {
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

  get alive(): boolean { return this.mind.health > 0; }

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
  private swingLeg(leg: Leg, angle: number): void {
    S_TURN.setFromAxisAngle(leg.axis, angle);
    leg.bone.quaternion.copy(leg.rest).multiply(S_TURN);
  }

  /**
   * For probes: how many legs it found and where their feet are right now.
   *
   * The foot positions are the point. "Six legs were located" only says the
   * search ran; feet that MOVE between frames say the gait is driving them.
   */
  legReportForTest(): { legs: number; feetY: number[] } {
    this.root.updateMatrixWorld(true);
    return {
      legs: this.legs.length,
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
