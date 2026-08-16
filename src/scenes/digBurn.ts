/**
 * THE SMOULDER — what a landed fireball keeps doing after the pop.
 *
 * One subject: a small fire that sits where a charge landed and keeps
 * eating, a scoop-tick at a time, each tick a beat later and one step
 * further along the line of flight than the last — so the fireball's
 * whole hole is a short burnt bore, not a single pocket. Nothing in here
 * edits terrain; like the flight, this file only keeps time and asks the
 * scene to carve. The scene answers with how much soil the tick actually
 * took, and ZERO puts the fire out early: bark, open air and the streamed
 * window's edge are not errors here, they are just where the fuel ends.
 *
 * The glow bead is the player's receipt. A cut that keeps happening at a
 * distance, seconds after the press, would read as terrain glitching if
 * nothing marked the spot — so a flickering ember sits at the MOUTH of
 * the burn (the impact point, not the advancing centre, which is buried
 * inside its own hole within a tick) and leaves when the fire does.
 */
import * as THREE from 'three';
import { MM } from '../world/worldScape';
import {
  BURN_EMBERS, BURN_STEP_FRAC, BURN_TICKS, BURN_TICK_S,
  CHARGES_MAX, CHARGE_RADIUS_MM, FIRE_CORE, FIRE_FLARE, SCOOP_DEEP_MM,
} from './islandTuning';

interface Burn {
  live: boolean;
  /** Where the fire shows — the impact mouth, fixed for the burn's life. */
  readonly mouth: THREE.Vector3;
  /** Where the NEXT tick cuts — walks inward along `dir` as it burns. */
  readonly at: THREE.Vector3;
  readonly dir: THREE.Vector3;
  ticksLeft: number;
  timer: number;
  /** Seconds alight — the glow flicker's own clock. */
  age: number;
  glow: THREE.Mesh;
}

const S_CORE = new THREE.Color(FIRE_CORE);
const S_FLARE = new THREE.Color(FIRE_FLARE);

export class Smolders {
  private readonly pool: Burn[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    /** Carve one tick at `at` along `dir`; answer with samples taken. */
    private readonly onTick: (at: THREE.Vector3, dir: THREE.Vector3) => number,
    /** An ember puff off the mouth, if the scene has chips to spare. */
    private readonly onEmber?: (at: THREE.Vector3, along: THREE.Vector3) => void,
  ) {}

  /**
   * Light one at `mouth`, burning along `dir`. As with the flight's pool
   * this is a cap, not a queue — but unlike a press, a landing that finds
   * every slot busy simply skips the smoulder: the pop already happened,
   * so the charge was never silent.
   */
  start(mouth: THREE.Vector3, dir: THREE.Vector3, glow = true): boolean {
    let slot = this.pool.find((b) => !b.live) ?? null;
    if (!slot) {
      if (this.pool.length >= CHARGES_MAX) return false;
      slot = {
        live: false,
        mouth: new THREE.Vector3(),
        at: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        ticksLeft: 0,
        timer: 0,
        age: 0,
        /* Unlit like everything at this scale — an ember down a tunnel
         * has no light to catch but its own. */
        glow: new THREE.Mesh(
          new THREE.SphereGeometry(CHARGE_RADIUS_MM / MM, 10, 8),
          new THREE.MeshBasicMaterial({ color: FIRE_FLARE }),
        ),
      };
      this.scene.add(slot.glow);
      this.pool.push(slot);
    }
    slot.live = true;
    slot.mouth.copy(mouth);
    /* The landing pop already cut at the mouth; the first tick starts a
     * step past it, and each later tick a step past that. */
    slot.at.copy(mouth);
    slot.dir.copy(dir).normalize();
    slot.ticksLeft = BURN_TICKS;
    slot.timer = BURN_TICK_S;
    slot.age = 0;
    slot.glow.position.copy(mouth);
    /*
     * A burn can start AT HER NOSE — a steep lob onto the ground right in
     * front of her lands within a step or two — and an ember bead
     * centimetres from the first-person lens is not a fire, it is a
     * blindfold. The scene decides whether the glow is worth showing;
     * the burn itself is the same either way, and the ember puffs still
     * mark the spot.
     */
    slot.glow.visible = glow;
    return true;
  }

  /** How many fires are alight — a probe's window. */
  count(): number {
    return this.pool.reduce((n, b) => n + (b.live ? 1 : 0), 0);
  }

  step(dt: number): void {
    for (const b of this.pool) {
      if (!b.live) continue;
      b.age += dt;
      b.timer -= dt;
      /* One tick per frame at most: a hitch long enough to owe two would
       * carve them in the same instant, and the beat IS the effect. */
      if (b.timer <= 0) {
        b.timer += BURN_TICK_S;
        b.at.addScaledVector(b.dir, (SCOOP_DEEP_MM * BURN_STEP_FRAC) / MM);
        const took = this.onTick(b.at, b.dir);
        b.ticksLeft -= 1;
        if (took > 0) this.onEmber?.(b.mouth, b.dir);
        /* Out of fuel or out of ticks — either way, out. Quietly: the
         * fizzle note belongs to a charge that DID nothing, and this one
         * already popped. */
        if (took === 0 || b.ticksLeft <= 0) {
          b.live = false;
          b.glow.visible = false;
          continue;
        }
      }
      /* The glow breathes on its own clock — same two-sine firelight as
       * the flying bead, sized so the flicker reads at a distance. */
      if (b.glow.visible) {
        const flare = 0.5 + 0.25 * Math.sin(b.age * 21) + 0.25 * Math.sin(b.age * 55);
        b.glow.scale.setScalar(0.8 + 0.4 * flare);
        (b.glow.material as THREE.MeshBasicMaterial).color
          .lerpColors(S_FLARE, S_CORE, flare);
      }
    }
  }

  dispose(): void {
    for (const b of this.pool) {
      this.scene.remove(b.glow);
      b.glow.geometry.dispose();
      (b.glow.material as THREE.Material).dispose();
    }
    this.pool.length = 0;
  }
}
