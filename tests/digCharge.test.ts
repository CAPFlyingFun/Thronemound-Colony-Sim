import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DigCharges } from '../src/scenes/digCharge';
import { chargeImpact, type DigHost } from '../src/scenes/islandDig';
import {
  CHARGES_MAX, CHARGE_RANGE_MM, SCOOP_DEEP_MM,
} from '../src/scenes/islandTuning';
import { MM } from '../src/world/worldScape';

/*
 * THE THROWN CHARGE'S TWO PROMISES, pinned:
 *
 * 1. A charge lobbed over ground LANDS — the arc bends down, meets the
 *    floor, and hands the impact point back so a pocket can be carved
 *    there. The pocket half of that hand-off is `chargeImpact`, tested
 *    below against the same fake stream the bite's tests use: a landed
 *    charge must CHANGE TERRAIN, not just report a position.
 *
 * 2. A charge lobbed at nothing FIZZLES, once, out loud — the flight has
 *    a budget, and running it out is an event, not a leak that leaves a
 *    bead falling forever under the map.
 */

/** A world that is one floor rule and a scene that only counts. */
function makeWorld(solid: (x: number, y: number, z: number) => boolean) {
  const scene = {
    added: 0,
    removed: 0,
    add() { this.added += 1; },
    remove() { this.removed += 1; },
  };
  const hits: { at: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  const fizzles: THREE.Vector3[] = [];
  const charges = new DigCharges(
    { scene: scene as unknown as THREE.Scene, groundSolidAt: solid },
    (at, dir) => hits.push({ at: at.clone(), dir: dir.clone() }),
    (at) => fizzles.push(at.clone()),
  );
  return {
    scene, hits, fizzles, charges,
  };
}

/** Fly until the air is empty or the clock says something leaked. */
function flyOut(charges: DigCharges, seconds = 4): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds && charges.count() > 0; t += dt) charges.step(dt);
}

describe('the flight', () => {
  it('arcs down onto a floor and reports the landing', () => {
    const floorY = 0.3;
    const { hits, fizzles, charges } = makeWorld((_x, y) => y <= floorY);
    const origin = new THREE.Vector3(0.5, 0.5, 0.5);
    expect(charges.lob(origin, new THREE.Vector3(0, 0, 1))).toBe(true);
    flyOut(charges);
    expect(hits.length).toBe(1);
    expect(fizzles.length).toBe(0);
    const hit = hits[0]!;
    /* It went FORWARD along the aim and DOWN under gravity: the landing
     * sits ahead of her, at the floor (within one sub-step of sink), and
     * the arrival direction has bent below the horizontal it left on. */
    expect(hit.at.z).toBeGreaterThan(origin.z + 0.5);
    expect(hit.at.y).toBeLessThanOrEqual(floorY);
    expect(hit.at.y).toBeGreaterThan(floorY - 0.15);
    expect(hit.dir.y).toBeLessThan(0);
    expect(hit.dir.z).toBeGreaterThan(0.5);
  });

  it('fizzles exactly once when the world never answers', () => {
    const { hits, fizzles, charges } = makeWorld(() => false);
    charges.lob(new THREE.Vector3(0.5, 0.5, 0.5), new THREE.Vector3(0, 0, 1));
    flyOut(charges);
    expect(hits.length).toBe(0);
    expect(fizzles.length).toBe(1);
    expect(charges.count()).toBe(0);
  });

  it('spends its whole range before giving up', () => {
    /* An upward lob over a void: the path flown to the fizzle must be at
     * least the advertised range — the budget is path length, not a
     * timer that might cut a slow arc short. */
    const { fizzles, charges } = makeWorld(() => false);
    const origin = new THREE.Vector3(0, 0, 0);
    charges.lob(origin, new THREE.Vector3(0, 0.4, 1).normalize());
    flyOut(charges);
    const end = fizzles[0]!;
    /* Straight-line displacement is a floor on path length. */
    expect(end.distanceTo(origin)).toBeLessThanOrEqual((CHARGE_RANGE_MM / MM) * 1.05);
    expect(end.distanceTo(origin)).toBeGreaterThan((CHARGE_RANGE_MM / MM) * 0.3);
  });

  it('caps how many fly at once, and says no to the rest', () => {
    const { charges } = makeWorld(() => false);
    for (let i = 0; i < CHARGES_MAX; i += 1) {
      expect(charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 1, 0))).toBe(true);
    }
    expect(charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 1, 0))).toBe(false);
    expect(charges.count()).toBe(CHARGES_MAX);
  });
});

describe('the landing', () => {
  /** The bite tests' fake host, trimmed to what a landed charge touches. */
  function makeHost(cuttable: boolean) {
    const calls = { subtracted: 0, revealed: 0 };
    const host = {
      grit: null,
      queue: [] as { cx: number; cy: number; cz: number }[],
      queued: new Set<string>(),
      deepCarved: 0,
      stream: {
        subtractEllipsoid: () => {
          calls.subtracted += 1;
          return {
            changedSamples: cuttable ? 12 : 0,
            bounds: {
              minX: 10, minY: 10, minZ: 10, maxX: 12, maxY: 12, maxZ: 12,
            },
          };
        },
        boxAround: () => ({
          minX: 10, minY: 10, minZ: 10, maxX: 12, maxY: 12, maxZ: 12,
        }),
        smoothBox: () => null,
      },
      key: (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`,
      meshChunk: () => {},
      reveal: () => { calls.revealed += 1; },
      depthMm: () => 0,
    } as unknown as DigHost;
    return { host, calls };
  }

  it('a landed charge changes terrain and draws it now', () => {
    const { host, calls } = makeHost(true);
    const touched = chargeImpact(
      host, new THREE.Vector3(1, 0.3, 3), new THREE.Vector3(0, -0.5, 1).normalize(),
    );
    expect(touched).toBeGreaterThan(0);
    expect(calls.subtracted).toBeGreaterThan(0);
    /* Drawn synchronously, like the bite — a remote hole that lags the
     * queue would read as terrain glitching at a distance. */
    expect(calls.revealed).toBe(1);
  });

  it('seats the pocket past the surface it struck, like the bite does', () => {
    const hit = new THREE.Vector3(2, 1, 2);
    const dir = new THREE.Vector3(0, 0, 1);
    let seenAt: THREE.Vector3 | null = null;
    const { host } = makeHost(true);
    const stream = (host as unknown as {
      stream: { subtractEllipsoid: (at: THREE.Vector3) => unknown };
    }).stream;
    const inner = stream.subtractEllipsoid.bind(stream);
    stream.subtractEllipsoid = (at: THREE.Vector3) => {
      if (!seenAt) seenAt = at.clone();
      return inner(at);
    };
    chargeImpact(host, hit, dir);
    expect(seenAt!.z).toBeCloseTo(hit.z + SCOOP_DEEP_MM / 2 / MM, 5);
  });

  it('reports a landing that cut nothing, so the scene can say so', () => {
    const { host } = makeHost(false);
    const touched = chargeImpact(
      host, new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 0, 1),
    );
    expect(touched).toBe(0);
  });
});
