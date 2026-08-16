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
 * So what is here is a BODY gait and not a leg gait: the animal leans into
 * its travel and bobs at a rate set by its own speed, and holds still when
 * the brain says idle. It reads as alive at ant scale and it is not
 * pretending to be more than it is — see `pose`.
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

/**
 * The gait's bob, as a fraction of the animal's own height, and how many
 * strides it takes per body length travelled.
 *
 * Tied to DISTANCE rather than to time, so a creature that slows down does
 * not moonwalk — the same reason the ant's legs are driven by travel.
 */
const BOB_SHARE = 0.06;
const STRIDES_PER_LENGTH = 1.8;

const S_WANT = new THREE.Vector3();
const S_FLAT = new THREE.Vector3();

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
    if (!moving) {
      this.root.position.y = this.at.y;
      return;
    }
    const strides = (this.gone / Math.max(0.01, this.tall)) * STRIDES_PER_LENGTH;
    const bob = Math.abs(Math.sin(strides * Math.PI)) * this.tall * BOB_SHARE;
    this.root.position.y = this.at.y + bob;
  }

  dispose(): void {
    this.root.traverse((n) => {
      const m = n as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}
