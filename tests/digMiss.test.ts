import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bite, biteCentre, type DigHost } from '../src/scenes/islandDig';
import { NOSE_REACH, JAW_PAST_NOSE, SCOOP_DEEP_MM } from '../src/scenes/islandTuning';
import { MM } from '../src/world/worldScape';

/*
 * THE MISS IS TOLD, NOT SWALLOWED — the regression this file pins.
 *
 * "Sometimes pressing dig doesn't dig" was two facts stacked: the range is
 * real (her jaws only reach so far), and a stroke that removed nothing said
 * nothing. The first is physics and stays. The second is the bug: bite()
 * must call the host's biteMiss() on every stroke that changes no soil, and
 * must NOT call it on a stroke that does.
 */

/** A host over a world described by one solidity rule. */
function makeHost(solid: (x: number, y: number, z: number) => boolean) {
  const calls = { miss: 0, subtracted: 0, revealed: 0 };
  const host = {
    grit: null,
    camera: new THREE.PerspectiveCamera(60, 2, 0.001, 10),
    queen: { jawPosition: () => false },
    at: new THREE.Vector3(0.5, 0.5, 0.5),
    up: new THREE.Vector3(0, 1, 0),
    fwd: new THREE.Vector3(0, 0, 1),
    lookDir: new THREE.Vector3(0, 0, 1),
    queue: [] as { cx: number; cy: number; cz: number }[],
    queued: new Set<string>(),
    ready: true,
    queenReady: false,
    firstPerson: false,
    digMode: true,
    biteTouched: false,
    aimPitch: 0,
    brushMm: 6,
    deepCarved: 0,
    stream: {
      subtractEllipsoid: (at: THREE.Vector3) => {
        calls.subtracted += 1;
        const hit = solid(at.x, at.y, at.z);
        return {
          changedSamples: hit ? 12 : 0,
          bounds: {
            minX: 10, minY: 10, minZ: 10, maxX: 12, maxY: 12, maxZ: 12,
          },
        };
      },
      boxAround: () => ({ minX: 10, minY: 10, minZ: 10, maxX: 12, maxY: 12, maxZ: 12 }),
      smoothBox: () => null,
    },
    key: (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`,
    enqueue: () => {},
    meshChunk: () => {},
    reveal: () => { calls.revealed += 1; },
    depthMm: () => 0,
    soilSolidAt: solid,
    groundSolidAt: solid,
    biteMiss: () => { calls.miss += 1; },
  } as unknown as DigHost;
  return { host, calls };
}

describe('the stroke that meets nothing', () => {
  it('tells the host it missed, exactly once per stroke', () => {
    const { host, calls } = makeHost(() => false);
    bite(host);
    expect(calls.miss).toBe(1);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(false);
    /* And it never pretended to draw a cut it did not make. */
    expect(calls.revealed).toBe(0);
  });

  it('stays quiet when soil actually came out', () => {
    const { host, calls } = makeHost(() => true);
    bite(host);
    expect(calls.miss).toBe(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(true);
    expect(calls.revealed).toBe(1);
  });

  it('biteCentre reports open air over a drop as a genuine miss', () => {
    const { host } = makeHost(() => false);
    const out = new THREE.Vector3();
    const aim = new THREE.Vector3(0, 0, 1);
    const reach = NOSE_REACH + JAW_PAST_NOSE;
    expect(biteCentre(host, aim, reach, out)).toBe(false);
    /* Left at arm's length so the ghost still shows where. */
    expect(out.z).toBeCloseTo(host.at.z + reach, 5);
  });

  it('biteCentre seats the scoop half a depth past the first soil it meets', () => {
    const wallZ = 0.5 + 2 / MM; // a face 2 mm out along the aim
    const { host } = makeHost((_x, _y, z) => z >= wallZ);
    const out = new THREE.Vector3();
    const aim = new THREE.Vector3(0, 0, 1);
    expect(biteCentre(host, aim, NOSE_REACH + JAW_PAST_NOSE, out)).toBe(true);
    expect(out.z).toBeGreaterThan(wallZ - 1e-6);
    expect(out.z).toBeLessThan(wallZ + SCOOP_DEEP_MM / MM);
  });
});
