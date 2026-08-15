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
}

/** World units a second squared. Tuned so a prop dropped in a shaft lands
 *  in a beat rather than drifting — see `Prop.tick`. */
const PROP_GRAVITY = 9;
/** And capped, so nothing tunnels a thin floor between two frames. */
const PROP_FALL_MAX = 6;
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
    /* A stone is not a sphere sitting on a plane; it is bedded in. Half a
     * radius down looks planted rather than balanced. */
    this.root.rotation.y = (spec.massMg * 1.7) % Math.PI;
  }

  /** How close her jaws have to be, from its centre. */
  get radius(): number { return this.spec.halfMm / MM; }

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
    const floor = rest.floorUnder(this.at.x, this.at.y, this.at.z) + this.rest;
    if (this.at.y <= floor + 1e-6) {
      /* Landed, or was already resting. Sitting it exactly on the floor
       * rather than easing means a prop the player dug out from under
       * cannot hover a hair above the new one. */
      this.at.y = floor;
      this.fall = 0;
    } else {
      /*
       * FALLING, rather than snapping down. A prop whose support is dug
       * away should drop, and a teleport reads as a glitch where a fall
       * reads as the world working. Terminal speed is capped so nothing
       * can tunnel through a thin floor between two frames.
       */
      this.fall = Math.min(PROP_FALL_MAX, this.fall + PROP_GRAVITY * dt);
      this.at.y = Math.max(floor, this.at.y - this.fall * dt);
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
