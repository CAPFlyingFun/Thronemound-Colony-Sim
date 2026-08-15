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
import type { PropGround } from './islandProps';

/**
 * How far it will step down without thinking, and how far up it will look.
 *
 * A lip, a pebble or the side of a scuff is a step; the mouth of a shaft is
 * not. GAME TUNING — a real ladybug walks over far rougher ground than this
 * implies, but the thing being modelled is "does not stroll into a hole"
 * rather than beetle gait.
 */
const STEP_DOWN = 1.2 / MM;
const STEP_UP = 1.0 / MM;

/**
 * Where the spots sit — across, along, and how big, as fractions of the
 * shell's radius. Mirrored left and right, so this is half a ladybug.
 *
 * Four a side plus the pair at the shoulders reads as a harlequin without
 * counting; the species is famously variable, so an exact count would be
 * false precision either way.
 */
const SPOTS: [number, number, number][] = [
  [0.42, 0.52, 0.20],
  [0.60, -0.10, 0.17],
  [0.34, -0.62, 0.15],
];

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

  /** For tests: point it somewhere deliberately. */
  set headingForTest(radians: number) { this.heading = radians; }

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

    /*
     * A LADYBUG, because it already looked like one.
     *
     * "let's modify the shape of the beetle to be a ladybug as it looks more
     * like it right now" — and it did: a domed shell on six short legs is a
     * coccinellid whatever colour it is painted. So it stops pretending and
     * becomes one, which also gives the bestiary its first real species
     * instead of a placeholder shape.
     *
     * ORANGE, deliberately, and it is the one that bites. Reported from
     * life: "I had an orange ladybug bite me when I was outside. It actually
     * hurt some." That is almost certainly Harmonia axyridis, the harlequin
     * — the orange one that overwinters indoors, and the one with a genuine
     * habit of nipping people. Native red Coccinella rarely do. So the
     * colour is not decoration: it says which one this is, and the bite it
     * already has in `struggle` is the right behaviour for it.
     */
    const shellMat = new THREE.MeshLambertMaterial({ color: 0xd4622a });
    const spotMat = new THREE.MeshLambertMaterial({ color: 0x1a1216 });
    const legMat = new THREE.MeshLambertMaterial({ color: 0x241d31 });
    /* Millimetres, like everything else she can walk up to. A harlequin is
     * 5-8 mm long, which against a 9 mm queen is the right kind of fight:
     * not vermin, not a monster. */
    const r = 2.6 / MM;
    /* DOMED, not egg-shaped. A ladybug is a half-sphere with a flat
     * underside, which is why one sits so low and so round. */
    const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), shellMat);
    shell.scale.set(1.02, 0.66, 1.18);
    shell.position.y = r * 0.52;
    this.root.add(shell);
    /*
     * THE PRONOTUM — the black plate between shell and head, which is the
     * feature that actually says "ladybug" from above.
     *
     * Proud of the shell's front rather than tucked under it, because the
     * first cut put it at the dome's own height and the shell simply
     * swallowed it: rendered, there was no head at all.
     */
    const pronotum = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 12, 10), spotMat);
    pronotum.scale.set(1.05, 0.45, 0.62);
    pronotum.position.set(0, r * 0.62, r * 0.92);
    this.root.add(pronotum);
    const head = new THREE.Mesh(new THREE.SphereGeometry(r * 0.26, 10, 8), spotMat);
    head.scale.set(1, 0.8, 0.9);
    head.position.set(0, r * 0.5, r * 1.22);
    this.root.add(head);
    /*
     * NO SEAM DOWN THE ELYTRA, and it is worth saying why rather than
     * leaving the gap.
     *
     * A straight bar cannot follow a dome. Laid along the shell it sat
     * inside the curve at the middle and floated clear of it at both ends —
     * rendered, a black rod hanging off the back. Sinking it far enough to
     * bury the ends buries the whole thing. Doing it properly means a curved
     * strip or a texture, and the spots and pronotum already carry the read,
     * so it is left out rather than left wrong.
     */
    for (const [sx, sz, ss] of SPOTS) {
      for (const side of [-1, 1]) {
        const spot = new THREE.Mesh(
          new THREE.SphereGeometry(r * ss, 8, 6), spotMat,
        );
        spot.scale.set(1, 0.34, 1);
        /* Sat on the dome's own surface, so a spot never floats off the
         * shoulder of the shell. */
        const px = side * r * sx;
        const pz = r * sz;
        const t = Math.max(0, 1 - (px * px) / (r * r) - (pz * pz) / (r * r * 1.4));
        spot.position.set(px, r * 0.52 + r * 0.66 * Math.sqrt(t), pz);
        this.root.add(spot);
      }
    }
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
  /**
   * One frame.
   *
   * `ground` is asked for the floor UNDER a point rather than the height at
   * an (x, z) — the difference is the whole of a bug reported from the
   * device: "the ladybug just walked over the opening". The old callback
   * was `walkGroundAt`, the ORIGINAL surface heightfield, which knows
   * nothing about anything that has been dug. So it strolled across the
   * mouth of a shaft on terrain that is no longer there, at the height the
   * hill used to be.
   */
  tick(dt: number, ground: PropGround, held: boolean): void {
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
      this.at.y = this.floorAt(ground, this.at.x, this.at.z) ?? this.at.y;
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
    const nx = this.at.x + Math.sin(this.heading) * speed * dt;
    const nz = this.at.z + Math.cos(this.heading) * speed * dt;
    /*
     * IT LOOKS BEFORE IT STEPS, which is the other half of the same report.
     *
     * Taking the floor at the new spot and moving there regardless would
     * fix the HEIGHT and replace one wrong behaviour with another: instead
     * of strolling over the mouth of a shaft it would drop down it, and a
     * ladybug in the queen's chamber is a worse surprise than one on the
     * lawn. So the step is tested first, and an edge it cannot walk down is
     * a reason to turn rather than a reason to fall.
     *
     * `STEP_DOWN` is what it will step off without thinking — a lip, a
     * pebble, the side of a scuff. Anything deeper is a hole.
     */
    const ahead = this.floorAt(ground, nx, nz);
    if (ahead === null || this.at.y - ahead > STEP_DOWN) {
      /* Turn away and spend this frame doing it. Half a turn plus the
       * wobble's own drift, so two beetles at the same edge do not end up
       * marching in step. */
      this.heading += 2.2 + (this.wobble % 1) * 1.4;
      this.turnIn = 0.6;
    } else {
      this.at.x = nx;
      this.at.z = nz;
      this.at.y = ahead;
    }
    this.root.rotation.set(0, this.heading, Math.sin(this.wobble) * WALK_WOBBLE_Z);
    this.placeGrounded(this.standingLift);
  }

  /**
   * The floor under a spot, or null when there is none within reach.
   *
   * Searched from a little ABOVE its current height rather than from where
   * it stands, so a step up onto a lip is found as easily as a step down —
   * starting at its own feet would miss anything higher than they are.
   */
  private floorAt(ground: PropGround, x: number, z: number): number | null {
    const y = ground.floorUnder(x, this.at.y + STEP_UP, z);
    return Number.isFinite(y) ? y : null;
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
