/**
 * THE FIRST THING ON THE ISLAND THAT CAN BE FOUGHT.
 *
 * A stylised beetle, built the way the sandbox's combat dummy is built —
 * primitives, no rig, no animation beyond a walk wobble — because the
 * point of it is to have a `Quarry` with hit points standing on the
 * terrain, not to have a beetle. When there is a real bestiary this file
 * is where the first one stops being a placeholder.
 *
 * It does three things: it wanders, it fights back while held, and it
 * falls over. That is enough to make the sting a mechanic rather than an
 * animation, and it is deliberately not enough to be an enemy — it does
 * not hunt her, it does not flee, and if she leaves it alone it will
 * potter about the same patch of ground forever.
 */
import * as THREE from 'three';
import type { Quarry } from './islandCombat';
import type { Portable } from './islandCarry';
import { MM } from '../world/worldScape';

const S_STEP = new THREE.Vector3();
const FALL_Z = Math.PI * 0.85;
const WALK_WOBBLE_Z = 0.03;
const HELD_WOBBLE_Z = 0.12;

export class Beetle implements Quarry, Portable {
  readonly id: string;

  readonly root = new THREE.Group();

  alive = true;

  hp = 100;

  readonly hpMax = 100;

  venomLoad = 0;

  /* Set by whoever stings it — see `Quarry.venomRate`. Zero until then,
   * which is also what "nothing has stung it" means. */
  venomRate = 0;

  /**
   * What it does to her while she is on it, in health a second.
   *
   * Small on purpose: her whole health bar is a hundred, and a first
   * encounter that costs a quarter of it for a fight she is meant to win
   * would teach the wrong lesson about grip-and-sting. It is the pressure
   * that stops "grab it and wait" being the answer, not the threat.
   */
  readonly struggle = 3.5;

  /** Chance a second of throwing her off. Roughly one grip in six. */
  readonly breakFree = 0.16;

  readonly at = new THREE.Vector3();

  /** Where it potters about, and how far it will stray. */
  private readonly home = new THREE.Vector3();

  private heading = 0;

  private turnIn = 0;

  private wobble = 0;

  /**
   * `at.y` is the terrain CONTACT height, because combat and carry reach
   * read `at`. The primitive art, however, is not authored with its lowest
   * vertex at local y=0: even standing, the shell reaches below the root,
   * and the fallen pose used to rotate the whole beetle around that ground
   * plane and bury most of it.
   *
   * These are visual-only lifts measured once from the actual rendered
   * bounds. Keeping them off `at` preserves every gameplay distance while
   * putting the pixels where the terrain says the ground is.
   */
  private readonly standingLift: number;

  private readonly heldLift: number;

  private readonly fallenLift: number;

  constructor(id: string, atX: number, atY: number, atZ: number) {
    this.id = id;
    this.at.set(atX, atY, atZ);
    this.home.copy(this.at);
    this.root.position.copy(this.at);

    const shellMat = new THREE.MeshLambertMaterial({ color: 0x3a2f4d });
    const legMat = new THREE.MeshLambertMaterial({ color: 0x241d31 });
    /* Millimetres, like everything else she can walk up to: a beetle a few
     * times her own length, which at MM = 5 is a handful of world units. */
    const r = 2.6 / MM;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 12), shellMat);
    shell.scale.set(1, 0.72, 1.35);
    shell.position.y = r * 0.6;
    this.root.add(shell);
    const head = new THREE.Mesh(new THREE.SphereGeometry(r * 0.42, 10, 10), shellMat);
    head.position.set(0, r * 0.45, r * 1.45);
    this.root.add(head);
    for (let i = 0; i < 6; i += 1) {
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.06, r * 0.04, r, 6), legMat,
      );
      const side = i % 2 === 0 ? 1 : -1;
      leg.position.set(side * r * 0.88, r * 0.3, (Math.floor(i / 2) - 1) * r * 0.7);
      leg.rotation.z = side;
      this.root.add(leg);
    }

    /* Measure the poses the model actually uses instead of duplicating its
     * geometry as a clearance constant. The small walking and struggle
     * wobbles have different envelopes; the fallen pose is fixed. */
    this.standingLift = this.liftFor([-WALK_WOBBLE_Z, 0, WALK_WOBBLE_Z]);
    this.heldLift = this.liftFor([-HELD_WOBBLE_Z, 0, HELD_WOBBLE_Z]);
    this.fallenLift = this.liftFor([FALL_Z]);
    this.root.position.copy(this.at);
    this.root.position.y += this.standingLift;
    this.root.rotation.set(0, 0, 0);
  }

  /**
   * How far the rendered root must rise so none of its geometry crosses a
   * flat y=0 plane at the supplied z-rotations. Constructor-only; no bounds
   * work happens in the frame loop.
   *
   * VERTICES, NOT `Box3.setFromObject`. That was the first spelling of this
   * and it is wrong in a way that only shows up once something is TILTED:
   * it expands by each geometry's axis-aligned box CORNERS, so a rotated
   * sphere is measured as a rotated CUBE. Standing, where nothing is
   * turned, the two agree exactly. Fallen at 153° they do not — measured,
   * the box says 4.238 mm where the beetle's lowest actual vertex is at
   * 3.425 mm, and the difference is not rounding: it is 0.81 mm of lift on
   * a beetle 2.6 mm tall, which trades a carcass sunk in the dirt for one
   * hovering over it. The struggle pose over-lifts by 0.224 mm for the same
   * reason.
   *
   * Reading the position attribute costs a few hundred points once per
   * beetle per pose, which is nothing, and it is exact.
   */
  private liftFor(zAngles: readonly number[]): number {
    const savedPosition = this.root.position.clone();
    const savedRotation = this.root.rotation.clone();
    const v = new THREE.Vector3();
    let lift = 0;

    this.root.position.set(0, 0, 0);
    for (const z of zAngles) {
      /* Z ONLY, and `heading` is deliberately absent: the walk sets
       * `rotation.set(0, heading, wobble)`, and a turn about the vertical
       * axis cannot change any vertex's height. Euler order is XYZ, so the
       * z-tilt is applied first and the heading after it — which is why
       * this holds rather than merely being nearly true. */
      this.root.rotation.set(0, 0, z);
      this.root.updateMatrixWorld(true);
      this.root.traverse((n) => {
        const mesh = n as THREE.Mesh;
        const pos = mesh.geometry?.attributes?.position;
        if (!pos) return;
        for (let i = 0; i < pos.count; i += 1) {
          v.fromBufferAttribute(pos as THREE.BufferAttribute, i)
            .applyMatrix4(mesh.matrixWorld);
          if (-v.y > lift) lift = -v.y;
        }
      });
    }

    this.root.position.copy(savedPosition);
    this.root.rotation.copy(savedRotation);
    this.root.updateMatrixWorld(true);
    return Math.max(0, lift);
  }

  /** Put the rendered model on `at.y` without changing the gameplay anchor. */
  private placeGrounded(lift: number): void {
    this.root.position.copy(this.at);
    this.root.position.y += lift;
  }

  /** How close her jaws have to be, measured from its centre. */
  get radius(): number { return 3.4 / MM; }

  /**
   * WHAT IT WEIGHS, and what the colony gets for it.
   *
   * Forty-five milligrams is a small ground beetle and it is DESIGNED
   * rather than measured — beetles run from under a milligram to several
   * grams and the drawn one is a stylised primitive, so there is nothing
   * to look up. It is chosen against her carrying capacity (five times a
   * fourteen-milligram queen, see `islandCarry`): a beetle is most of a
   * load and not all of it, so the meter has somewhere left to go.
   *
   * The protein is 60% of the wet mass. Also designed, and on the generous
   * side of what an insect actually yields after chitin — the larvae are
   * not modelled yet, so this number stands in for a digestion that has no
   * code behind it. It should come down when they arrive.
   */
  readonly massMg = 45;

  readonly proteinMg = 27;

  /**
   * In her jaws. Distinct from `held` in the combat sense, which means
   * gripped and fighting: the scene drives `at` while this is true, and the
   * beetle must not argue with it by settling itself onto the ground.
   */
  carried = false;

  /**
   * One frame of pottering. `groundAt` keeps it on the terrain, which is
   * the only thing it shares with her movement code — it has no walker, no
   * legs and no surface following, because a beetle that could climb a
   * tree would need all three and there is nothing up there for it.
   */
  tick(dt: number, groundAt: (x: number, z: number) => number, held: boolean): void {
    if (this.carried) {
      /* Cargo. The scene has put it at her jaws and the ground has no say
       * — dropping the terrain clamp here is the whole reason this branch
       * exists, because otherwise a carried beetle snaps back down to the
       * dirt every frame while she walks off with it. No ground lift here:
       * `at` is now a jaw anchor rather than a terrain contact. */
      this.root.position.copy(this.at);
      this.root.rotation.z = FALL_Z;
      return;
    }
    if (!this.alive) {
      /* Down. `at` stays exactly on the terrain because reach tests read it;
       * the rendered root alone rises enough for the rotated shell to lie on
       * the surface instead of pivoting through it. */
      this.at.y = groundAt(this.at.x, this.at.z);
      this.root.rotation.z = FALL_Z;
      this.placeGrounded(this.fallenLift);
      return;
    }
    if (held) {
      /* Struggling: it shakes but does not travel. The wider wobble needs a
       * slightly larger visual clearance than ordinary walking. */
      this.wobble += dt * 26;
      this.root.rotation.z = Math.sin(this.wobble) * HELD_WOBBLE_Z;
      this.placeGrounded(this.heldLift);
      return;
    }

    this.turnIn -= dt;
    if (this.turnIn <= 0) {
      this.turnIn = 1.4 + (this.at.x * 37 % 1) * 2.2;
      /* Wanders, but is tethered: past its patch it turns for home rather
       * than walking off the edge of the streamed window. */
      const away = S_STEP.copy(this.at).sub(this.home);
      this.heading = away.length() > 40 / MM
        ? Math.atan2(-away.x, -away.z)
        : this.heading + (this.wobble % 1 - 0.5) * 2.4;
    }
    this.wobble += dt * 9;

    const speed = 1.6 / MM;
    this.at.x += Math.sin(this.heading) * speed * dt;
    this.at.z += Math.cos(this.heading) * speed * dt;
    this.at.y = groundAt(this.at.x, this.at.z);
    this.root.rotation.set(0, this.heading, Math.sin(this.wobble) * WALK_WOBBLE_Z);
    this.placeGrounded(this.standingLift);
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
