/**
 * THE MINI DIG CHARGE — a shovel for the soil her jaws cannot reach.
 *
 * One subject: a small bright bead, lobbed down the aim line, that flies a
 * visible ballistic arc and either LANDS — handing the impact point back to
 * the scene so a pocket can be carved there — or runs out of throw and
 * fizzles, which the scene turns into the same "OUT OF REACH" note a dry
 * stroke earns. Nothing in here edits terrain; this file is only the
 * flight. The carve is `chargeImpact` in `islandDig.ts`, next to the bite
 * whose scoop it borrows, so the two tools cannot drift apart in what a
 * mouthful means.
 *
 * The world it needs is deliberately tiny — a scene to be visible in and
 * one solidity question — so a test can fly charges over a floor described
 * by a single function, the same way the bite's own tests do.
 */
import * as THREE from 'three';
import { CELL_SIZE, MM } from '../world/worldScape';
import {
  CHARGES_MAX, CHARGE_GRAVITY_MM, CHARGE_RADIUS_MM,
  CHARGE_RANGE_MM, CHARGE_REACH_MM, CHARGE_SPEED_MM,
  EMBER_TRAIL_GAP_MM, FIRE_CORE, FIRE_FLARE, NOSE_REACH,
} from './islandTuning';

/**
 * WHERE A LOB LEAVES FROM — inside the span the miss scan PROVED empty,
 * never beyond it.
 *
 * The first cut of this spawned a fixed nose-length ahead of the ray's
 * origin, on the argument that the throw only happens because everything
 * within reach sampled empty. But `clear` — the ray's own reach — is not
 * always a nose-length: in first person the reach is charged for the
 * eye's forward seat, so a full nose ahead of the LENS can sit a fraction
 * of a millimetre past what was actually scanned, and a charge born
 * inside unscanned soil detonates at her face instead of flying. So the
 * offset is capped inside the proven span, and the point is asked one
 * last solidity question anyway — belt after the braces — falling back
 * to the ray's origin, which is her own lens or centre and therefore air.
 */
export function launchPoint(
  origin: THREE.Vector3, aim: THREE.Vector3, clear: number,
  solidAt: (x: number, y: number, z: number) => boolean,
): THREE.Vector3 {
  const out = new THREE.Vector3().copy(origin)
    .addScaledVector(aim, Math.min(NOSE_REACH, clear * 0.8));
  return solidAt(out.x, out.y, out.z) ? out.copy(origin) : out;
}

/** What a flight needs to know, and nothing else. */
export interface ChargeWorld {
  readonly scene: THREE.Scene;
  groundSolidAt(x: number, y: number, z: number): boolean;
  /**
   * WHERE SHE IS — because the streamed soil is a window centred on her,
   * and a charge that leaves it lands somewhere the game cannot carve. See
   * the two-limit note in `step`.
   */
  readonly at: THREE.Vector3;
  /**
   * A spark shed off the flying bead — the fireball's trail. Optional
   * because the flight owes the tests nothing visual; the scene wires it
   * to the ember chips.
   */
  ember?(at: THREE.Vector3, along: THREE.Vector3): void;
}

interface Charge {
  live: boolean;
  at: THREE.Vector3;
  vel: THREE.Vector3;
  /** Path length flown so far — the throw's budget, not a timer. */
  gone: number;
  /** Path since the last shed spark — the trail's own little odometer. */
  sinceEmber: number;
  mesh: THREE.Mesh;
}

const S_DIR = new THREE.Vector3();
const S_CORE = new THREE.Color(FIRE_CORE);
const S_FLARE = new THREE.Color(FIRE_FLARE);

export class DigCharges {
  private readonly pool: Charge[] = [];

  constructor(
    private readonly world: ChargeWorld,
    private readonly onImpact: (at: THREE.Vector3, dir: THREE.Vector3) => void,
    private readonly onFizzle: (at: THREE.Vector3) => void,
  ) {}

  /**
   * Lob one from `origin` along `aim`. False when every slot is mid-air —
   * the pool is a cap, not a queue, because a press whose answer is
   * "later" reads as a press that did nothing.
   */
  lob(origin: THREE.Vector3, aim: THREE.Vector3): boolean {
    let slot = this.pool.find((c) => !c.live) ?? null;
    if (!slot) {
      if (this.pool.length >= CHARGES_MAX) return false;
      slot = {
        live: false,
        at: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        gone: 0,
        sinceEmber: 0,
        /* A small bright bead, unlit on purpose: down a tunnel there is no
         * light to catch, and a charge you cannot see is a fizzle you
         * cannot explain. It BURNS — flicker and trail in `step` — so the
         * base colour here is only the fire's cold start. */
        mesh: new THREE.Mesh(
          new THREE.SphereGeometry(CHARGE_RADIUS_MM / MM, 10, 8),
          new THREE.MeshBasicMaterial({ color: FIRE_CORE }),
        ),
      };
      this.world.scene.add(slot.mesh);
      this.pool.push(slot);
    }
    slot.live = true;
    slot.gone = 0;
    slot.sinceEmber = 0;
    slot.at.copy(origin);
    slot.vel.copy(aim).normalize().multiplyScalar(CHARGE_SPEED_MM / MM);
    slot.mesh.position.copy(slot.at);
    slot.mesh.visible = true;
    return true;
  }

  /** How many are mid-air — a probe's window into the flight. */
  count(): number {
    return this.pool.reduce((n, c) => n + (c.live ? 1 : 0), 0);
  }

  step(dt: number): void {
    for (const c of this.pool) {
      if (!c.live) continue;
      /*
       * Marched in sub-steps no longer than half a cell, for the same
       * reason `biteCentre` samples at that pitch: a charge moving most
       * of a unit per frame would tunnel straight through a wall one
       * sample wide and pop on the far side of it.
       */
      const speed = c.vel.length();
      const n = Math.max(1, Math.ceil((speed * dt) / (CELL_SIZE * 0.5)));
      const sub = dt / n;
      for (let i = 0; i < n; i += 1) {
        /* Gravity is the WORLD's, not hers — a lob from a wall still
         * falls at the floor, which is what makes the arc legible. */
        c.vel.y -= (CHARGE_GRAVITY_MM / MM) * sub;
        c.at.addScaledVector(c.vel, sub);
        const flown = c.vel.length() * sub;
        c.gone += flown;
        /* THE TRAIL — a spark every few millimetres of PATH, so a slow
         * lob and a flat one shed at the same spacing and the arc is
         * written in embers behind the bead. */
        c.sinceEmber += flown;
        if (c.sinceEmber >= EMBER_TRAIL_GAP_MM / MM) {
          c.sinceEmber = 0;
          this.world.ember?.(c.at, c.vel);
        }
        if (this.world.groundSolidAt(c.at.x, c.at.y, c.at.z)) {
          c.live = false;
          c.mesh.visible = false;
          this.onImpact(c.at, S_DIR.copy(c.vel).normalize());
          break;
        }
        /*
         * TWO LIMITS, AND THEY ARE DIFFERENT QUESTIONS.
         *
         * `gone` is PATH LENGTH — how much throw is left in it. `CHARGE_
         * REACH_MM` is how far from her the game can still carve, which is
         * the streamed window's own edge and nothing to do with the arc.
         *
         * Conflating them cost a version each way. A path budget alone let
         * a charge fly to 150 mm when the world ends at 64, and two throws
         * in three carved nothing. Cutting the path budget to fit the
         * window then killed the lobs instead: an arc's path is LONGER
         * than its reach, so a steep throw that would have landed well
         * inside the window ran out of budget in mid-air.
         *
         * So the path budget is generous enough for a full lob, and the
         * hard stop is the one that actually matters — leaving the soil
         * the game can cut.
         */
        if (c.gone > CHARGE_RANGE_MM / MM
          || Math.hypot(c.at.x - this.world.at.x, c.at.z - this.world.at.z)
            > CHARGE_REACH_MM / MM) {
          /* Out of throw with nothing met: open air, open sky, a drop
           * deeper than the arc, or ground the streamer has not built.
           * The scene says so out loud. */
          c.live = false;
          c.mesh.visible = false;
          this.onFizzle(c.at);
          break;
        }
      }
      if (c.live) {
        c.mesh.position.copy(c.at);
        /*
         * THE FLICKER — keyed off path flown, not the wall clock, so a
         * probe stepping the sim by hand sees the same fire a player
         * does. Two incommensurate sine frequencies beat against each
         * other, which is as close to firelight as one line gets; the
         * bead swells a sixth and leans from core yellow towards flare
         * red as it flares.
         */
        const w = c.gone * MM;
        const flare = 0.5 + 0.25 * Math.sin(w * 5.1) + 0.25 * Math.sin(w * 13.7);
        c.mesh.scale.setScalar(1 + 0.17 * flare);
        (c.mesh.material as THREE.MeshBasicMaterial).color
          .lerpColors(S_CORE, S_FLARE, flare * 0.8);
      }
    }
  }

  dispose(): void {
    for (const c of this.pool) {
      this.world.scene.remove(c.mesh);
      c.mesh.geometry.dispose();
      (c.mesh.material as THREE.Material).dispose();
    }
    this.pool.length = 0;
  }
}
