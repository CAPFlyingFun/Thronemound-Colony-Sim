/**
 * THE TRIPOD, PINNED WITHOUT A BROWSER OR A GLB.
 *
 * Reported from the device: "the Aphid and Fly aren't walking tri-pod style
 * for 6 legs and they are all moving forward and back."
 *
 * The cause was that `findLegs` asked each bone for its WORLD position and
 * then asked body questions of the answer. "Is this foot on the left?"
 * became "is this foot east of the world origin?", and the island sits
 * entirely at positive X — measured in the running game, `side` came back 1
 * for all six legs of both creatures. The front-to-back rank, also taken
 * from world Z, interleaved the mirrored pairs, so the phases fell out
 * 1,0,1,0,1,0 and the animal swam: three left legs against three right.
 *
 * So the test puts the creature WHERE THE BUG LIVED — far from the origin
 * and turned — because at the origin facing forward the broken code and the
 * correct code agree, and a test built there proves nothing at all.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findLegs } from '../src/scenes/Critter';

/**
 * Six legs in three mirrored pairs, plus two antennae held high so the
 * "lowest six" search has something to reject — the same shape the real
 * rigs have, without needing one.
 */
function rig(): { root: THREE.Object3D; seats: Map<THREE.Bone, string> } {
  const root = new THREE.Object3D();
  const hub = new THREE.Bone();
  root.add(hub);
  const seats = new Map<THREE.Bone, string>();
  const legAt = (x: number, z: number, name: string): void => {
    /* Two bones deep, so the walk up to the body joint has something to
     * walk — a one-bone leg would pass for the wrong reason. */
    const coxa = new THREE.Bone();
    coxa.position.set(x, 0, z);
    const foot = new THREE.Bone();
    foot.position.set(x * 0.4, -0.6, 0);
    coxa.add(foot);
    hub.add(coxa);
    seats.set(foot, name);
  };
  legAt(-1, -1.4, 'L-front');
  legAt(1, -1.4, 'R-front');
  legAt(-1.2, 0, 'L-middle');
  legAt(1.2, 0, 'R-middle');
  legAt(-0.9, 1.4, 'L-hind');
  legAt(0.9, 1.4, 'R-hind');
  /* Antennae: high and forward, and they must not be mistaken for legs. */
  for (const x of [-0.3, 0.3]) {
    const a = new THREE.Bone();
    a.position.set(x, 1.2, -1.8);
    const tip = new THREE.Bone();
    tip.position.set(x, 0.4, -0.5);
    a.add(tip);
    hub.add(a);
  }
  return { root, seats };
}

/** Name each found leg by where it sits in the body's own frame. */
function named(root: THREE.Object3D): { at: string; phase: number }[] {
  const legs = findLegs(root);
  const rank = ['front', 'middle', 'hind'];
  const label = (list: typeof legs): { at: string; phase: number }[] => list
    .slice()
    .sort((a, b) => a.seat.z - b.seat.z)
    .map((l, i) => ({ at: rank[i] ?? String(i), phase: l.phase }));
  return [
    ...label(legs.filter((l) => l.seat.x < 0)).map((q) => ({ ...q, at: `L-${q.at}` })),
    ...label(legs.filter((l) => l.seat.x >= 0)).map((q) => ({ ...q, at: `R-${q.at}` })),
  ];
}

describe('a six-legged creature walks an alternating tripod', () => {
  it('finds six legs and rejects the antennae', () => {
    const { root } = rig();
    expect(findLegs(root)).toHaveLength(6);
  });

  it('splits them into two tripods of front, middle and hind', () => {
    const { root } = rig();
    const legs = named(root);
    for (const phase of [0, 1]) {
      const half = legs.filter((l) => l.phase === phase);
      expect(half).toHaveLength(3);
      /* One of each rank in each half — the property that makes it a
       * tripod rather than two groups of legs-per-side. */
      expect(new Set(half.map((l) => l.at.slice(2)))).toEqual(
        new Set(['front', 'middle', 'hind']),
      );
    }
  });

  it('puts the two legs of every mirrored pair in opposite halves', () => {
    const { root } = rig();
    const legs = named(root);
    for (const at of ['front', 'middle', 'hind']) {
      const l = legs.find((q) => q.at === `L-${at}`)!;
      const r = legs.find((q) => q.at === `R-${at}`)!;
      expect(l.phase).not.toBe(r.phase);
    }
  });

  it('still does, standing far from the origin and facing anywhere', () => {
    /*
     * THE CASE THAT WAS BROKEN, and the reason this test exists at all.
     * At the origin facing forward, world axes and body axes agree and the
     * old code passed by luck. Out on the island it did not.
     */
    for (const heading of [0, 0.7, Math.PI / 2, 2.4, Math.PI, 4.5]) {
      const { root } = rig();
      root.position.set(2600, 14, 1900);
      root.rotation.y = heading;
      root.updateMatrixWorld(true);
      const legs = named(root);
      const halves = [0, 1].map((p) => legs.filter((l) => l.phase === p));
      expect(halves[0]).toHaveLength(3);
      expect(halves[1]).toHaveLength(3);
      for (const at of ['front', 'middle', 'hind']) {
        expect(legs.find((q) => q.at === `L-${at}`)!.phase)
          .not.toBe(legs.find((q) => q.at === `R-${at}`)!.phase);
      }
    }
  });
});
