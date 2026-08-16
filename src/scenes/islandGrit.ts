/**
 * THE SPOIL — chips of soil thrown off the face while she chews.
 *
 * Lifted from nel370's PR #8, where it lives in the ant-mechanics sandbox
 * and is the best thing in the change: pooled instances, a step counter so
 * a held stroke sprays continuously rather than once, and a burst at
 * breakthrough. The idea and its shape are hers; what is different here is
 * the frame it works in.
 *
 * WHY THE ISLAND NEEDED IT. Digging is the whole verb of this game and it
 * had no feedback at all — the soil simply stopped existing. There is a
 * ghost showing where the stroke WILL land and nothing whatever saying it
 * landed. A dozen chips is the cheapest possible answer and it is the one
 * a player reads without being told.
 *
 * THE SANDBOX COULD THROW THEM UP; THIS CANNOT. That version spawns into a
 * cone about world +Y, which is right in a room where the floor is the
 * floor. Here she digs sideways down a bore and upside down under an
 * overhang, and a chip that always flies "up" would fly INTO the face half
 * the time. So the cone is built around the way the cut is FACING — spoil
 * comes back out of the hole, whichever way the hole points — and only
 * gravity is world-referenced, because gravity is.
 *
 * ONE DRAW CALL, and a fixed one: a single `InstancedMesh` at `GRIT_CAP`,
 * with dead chips packed out of the visible range rather than removed. A
 * particle system that allocates during a held dig would be spending the
 * frame budget of the thing it is decorating.
 *
 * NOT PHYSICS. Chips do not collide with the soil they came from — they
 * fade out well before they would land, and testing each against the
 * density field would cost more than the whole effect is worth.
 */
import * as THREE from 'three';

/** The most chips in the air at once. */
export const GRIT_CAP = 36;

/** How many a single completed scoop throws. */
export const GRIT_PER_BITE = 7;

/** Seconds a chip lives, before the spread below. */
export const GRIT_LIFE = 0.42;

/** World units a second squared — the scene's own gravity, restated. */
export const GRIT_GRAVITY = 9;

/** How fast a chip leaves the face, world units a second. */
export const GRIT_SPEED = 1.6;

/** How wide the spray is off the cut's facing, as a fraction of a radian. */
export const GRIT_CONE = 0.75;

/** A chip is about a third of a millimetre across. */
const GRIT_SIZE = 0.3 / 5;

/** Where dead chips are parked — far enough to be culled, cheap to write. */
const NOWHERE = 1e6;

interface Chip {
  readonly at: THREE.Vector3;
  readonly vel: THREE.Vector3;
  /** Seconds remaining. Zero or less is dead and free to reuse. */
  life: number;
  span: number;
  turn: number;
}

/**
 * How a chip moves over one step — the whole of the physics, pulled out so
 * it can be checked without a scene.
 *
 * Gravity, and a little drag so a chip slows as it tumbles rather than
 * flying flat. Returns the life left, which is what decides reuse.
 */
export function stepChip(chip: Chip, dt: number, gravity = GRIT_GRAVITY): number {
  if (chip.life <= 0) return 0;
  chip.life -= dt;
  if (chip.life <= 0) { chip.life = 0; return 0; }
  chip.vel.y -= gravity * dt;
  chip.vel.multiplyScalar(Math.max(0, 1 - 2.4 * dt));
  chip.at.addScaledVector(chip.vel, dt);
  return chip.life;
}

const SPRAY = new THREE.Vector3();
const SIDE = new THREE.Vector3();
const OVER = new THREE.Vector3();

export class Grit {
  readonly mesh: THREE.InstancedMesh;

  private readonly chips: Chip[] = [];

  private readonly dummy = new THREE.Object3D();

  constructor(
    private readonly rand: () => number = Math.random,
    /* Soil by default; the fireball's ember trail builds a second Grit in
     * ember orange — same pool, same one draw call, different colour. */
    color = 0x6b543a,
  ) {
    this.mesh = new THREE.InstancedMesh(
      /* A tetrahedron, not a sphere: at a third of a millimetre nobody
       * counts its faces, and four of them is the cheapest thing that
       * still reads as a CHIP rather than a bubble. */
      new THREE.TetrahedronGeometry(GRIT_SIZE, 0),
      /*
       * UNLIT ON PURPOSE. Underground there is no light — the sensed view
       * replaces lighting entirely — so a lit chip would be a black speck
       * exactly where this is most wanted. At this size shading is invisible
       * anyway, so a flat soil colour is the honest trade.
       */
      new THREE.MeshBasicMaterial({ color }),
      GRIT_CAP,
    );
    this.mesh.frustumCulled = false;
    this.mesh.count = GRIT_CAP;
    this.mesh.renderOrder = 8;
    for (let i = 0; i < GRIT_CAP; i += 1) {
      this.chips.push({
        at: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, span: 1, turn: 0,
      });
      this.park(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Throw a handful off a cut at `at`, facing `into` — the direction the
   * stroke was aimed. Spoil comes back OUT, so the spray is about `-into`.
   */
  burst(at: THREE.Vector3, into: THREE.Vector3, count = GRIT_PER_BITE): number {
    SPRAY.copy(into).normalize().multiplyScalar(-1);
    if (SPRAY.lengthSq() < 1e-9) SPRAY.set(0, 1, 0);
    /* Any two axes across the spray. `crossVectors` with world up fails on
     * a plumb aim, which is exactly the case a shaft is. */
    SIDE.set(SPRAY.y, SPRAY.z, SPRAY.x).cross(SPRAY);
    if (SIDE.lengthSq() < 1e-9) SIDE.set(1, 0, 0);
    SIDE.normalize();
    OVER.crossVectors(SPRAY, SIDE).normalize();

    let thrown = 0;
    for (let i = 0; i < this.chips.length && thrown < count; i += 1) {
      const chip = this.chips[i]!;
      if (chip.life > 0) continue;
      chip.at.copy(at);
      const spin = this.rand() * Math.PI * 2;
      const wide = this.rand() * GRIT_CONE;
      chip.vel.copy(SPRAY)
        .addScaledVector(SIDE, Math.cos(spin) * wide)
        .addScaledVector(OVER, Math.sin(spin) * wide)
        .normalize()
        .multiplyScalar(GRIT_SPEED * (0.55 + this.rand() * 0.8));
      chip.life = GRIT_LIFE * (0.7 + this.rand() * 0.6);
      chip.span = 0.6 + this.rand() * 0.9;
      chip.turn = (this.rand() - 0.5) * 14;
      thrown += 1;
    }
    return thrown;
  }

  /** One frame. Returns how many are still in the air. */
  tick(dt: number): number {
    if (dt <= 0) return this.live;
    let live = 0;
    for (let i = 0; i < this.chips.length; i += 1) {
      const chip = this.chips[i]!;
      const was = chip.life;
      if (stepChip(chip, dt) <= 0) {
        /* Only write the park matrix on the frame it DIES. A dead chip
         * that is already parked costs nothing to leave alone. */
        if (was > 0) this.park(i);
        continue;
      }
      live += 1;
      this.dummy.position.copy(chip.at);
      this.dummy.rotation.set(chip.turn * chip.life, chip.turn * chip.life * 0.7, 0);
      /* Shrinking as it dies, so it leaves rather than blinking out. */
      this.dummy.scale.setScalar(chip.span * Math.min(1, chip.life / (GRIT_LIFE * 0.5)));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.live = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    return live;
  }

  /** How many chips are in the air — for probes. */
  live = 0;

  private park(i: number): void {
    this.dummy.position.set(NOWHERE, NOWHERE, NOWHERE);
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
