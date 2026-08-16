import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Smolders } from '../src/scenes/digBurn';
import {
  BURN_STEP_FRAC, BURN_TICKS, BURN_TICK_S, CHARGES_MAX, SCOOP_DEEP_MM,
} from '../src/scenes/islandTuning';
import { MM } from '../src/world/worldScape';

/*
 * THE SMOULDER'S TWO PROMISES, pinned:
 *
 * 1. A landed fireball keeps eating — exactly `BURN_TICKS` more carves,
 *    one beat apart, each a step further along the line of flight — and
 *    then the fire is OUT, not idling in the pool forever.
 *
 * 2. Fire without fuel goes out EARLY. The tick that carves nothing
 *    (bark, air, the window's edge) is the last one; no further carves
 *    are asked for, quietly — the fizzle note belongs to the flight.
 */

function makeFire(fuel: (at: THREE.Vector3) => number) {
  const scene = {
    added: 0,
    removed: 0,
    add() { this.added += 1; },
    remove() { this.removed += 1; },
  };
  const ticks: THREE.Vector3[] = [];
  const embers: THREE.Vector3[] = [];
  const fires = new Smolders(
    scene as unknown as THREE.Scene,
    (at) => { ticks.push(at.clone()); return fuel(at); },
    (at) => { embers.push(at.clone()); },
  );
  return {
    scene, ticks, embers, fires,
  };
}

/** Burn until every fire is out or the clock says one is stuck alight. */
function burnOut(fires: Smolders, seconds = BURN_TICK_S * (BURN_TICKS + 2)): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds && fires.count() > 0; t += dt) fires.step(dt);
}

describe('the smoulder', () => {
  it('takes its ticks a beat apart, each a step deeper, then goes out', () => {
    const { ticks, embers, fires } = makeFire(() => 40);
    const mouth = new THREE.Vector3(1, 2, 3);
    const dir = new THREE.Vector3(0, 0, 1);
    expect(fires.start(mouth, dir)).toBe(true);
    expect(fires.count()).toBe(1);

    /* Nothing burns before the first beat lands. */
    fires.step(BURN_TICK_S * 0.9);
    expect(ticks.length).toBe(0);

    burnOut(fires);
    expect(ticks.length).toBe(BURN_TICKS);
    expect(fires.count()).toBe(0);

    /* Each tick a step further IN along the flight line, none at the
     * mouth itself — the landing pop already cut there. */
    const step = (SCOOP_DEEP_MM * BURN_STEP_FRAC) / MM;
    for (let i = 0; i < ticks.length; i += 1) {
      expect(ticks[i]!.z).toBeCloseTo(mouth.z + step * (i + 1), 5);
      expect(ticks[i]!.x).toBeCloseTo(mouth.x, 5);
    }
    /* And every tick that took soil puffed embers off the mouth. */
    expect(embers.length).toBe(BURN_TICKS);
    expect(embers[0]!.z).toBeCloseTo(mouth.z, 5);
  });

  it('goes out early, and quietly, the moment a tick meets no fuel', () => {
    /* Two mouthfuls of soil and then bark all the way down. */
    let fuel = 2;
    const { ticks, embers, fires } = makeFire(() => {
      fuel -= 1;
      return fuel >= 0 ? 25 : 0;
    });
    fires.start(new THREE.Vector3(), new THREE.Vector3(1, 0, 0));
    burnOut(fires);
    /* The dry tick is ASKED (that is how the fire learns) but it is the
     * last, and it throws no embers over nothing. */
    expect(ticks.length).toBe(3);
    expect(embers.length).toBe(2);
    expect(fires.count()).toBe(0);
  });

  it('caps the pool, reuses slots, and skips rather than queues', () => {
    const { scene, fires } = makeFire(() => 10);
    const dir = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < CHARGES_MAX; i += 1) {
      expect(fires.start(new THREE.Vector3(i, 0, 0), dir)).toBe(true);
    }
    /* Every slot alight: the next landing pops but does not smoulder. */
    expect(fires.start(new THREE.Vector3(9, 0, 0), dir)).toBe(false);
    expect(scene.added).toBe(CHARGES_MAX);

    burnOut(fires);
    expect(fires.count()).toBe(0);
    /* A fresh fire reuses a dead slot — no new glow joins the scene. */
    expect(fires.start(new THREE.Vector3(), dir)).toBe(true);
    expect(scene.added).toBe(CHARGES_MAX);
  });

  it('dispose removes every glow, alight or not', () => {
    const { scene, fires } = makeFire(() => 10);
    fires.start(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    fires.start(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0));
    fires.dispose();
    expect(scene.removed).toBe(2);
    expect(fires.count()).toBe(0);
  });
});
