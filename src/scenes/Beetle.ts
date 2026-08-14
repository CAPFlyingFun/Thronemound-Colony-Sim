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

export class Beetle implements Quarry, Portable {
  readonly id: string;

  readonly root = new THREE.Group();

  alive = true;

  hp = 100;

  venomLoad = 0;

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
       * dirt every frame while she walks off with it. */
      this.root.position.copy(this.at);
      this.root.rotation.z = Math.PI * 0.85;
      return;
    }
    if (!this.alive) {
      /* Down. It stays where it fell — and it is now something she can
       * pick up, which is what `Portable` above is for. */
      this.root.rotation.z = Math.PI * 0.85;
      this.at.y = groundAt(this.at.x, this.at.z);
      this.root.position.copy(this.at);
      return;
    }
    if (held) {
      /* Struggling: it shakes but does not travel. */
      this.wobble += dt * 26;
      this.root.rotation.z = Math.sin(this.wobble) * 0.12;
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
    this.root.position.copy(this.at);
    this.root.rotation.set(0, this.heading, Math.sin(this.wobble) * 0.03);
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
