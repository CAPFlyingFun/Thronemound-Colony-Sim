import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  bite, biteCentre, digJobTick, type DigHost,
} from '../src/scenes/islandDig';
import {
  NOSE_REACH, JAW_PAST_NOSE, BODY_HALF_TALL, BORE_HUG_WIDE, BORE_MIN_MM,
  BORE_WIDEN,
} from '../src/scenes/islandTuning';
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

/** A host over a world described by one solidity rule — and, when the two
 *  differ, a second rule for what the shovel can actually CUT (a tree is
 *  solid to the walker but not in the diggable field). */
function makeHost(
  solid: (x: number, y: number, z: number) => boolean,
  cuttable: (x: number, y: number, z: number) => boolean = solid,
) {
  const calls = {
    miss: 0, subtracted: 0, revealed: 0,
  };
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
        const hit = cuttable(at.x, at.y, at.z);
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
    /* The bore is a job now — see digJob.ts. A queen-sized shovel. */
    digJob: null,
    boreLength: () => 9 / MM,
    boreRadius: () => 2.25 / MM,
  } as unknown as DigHost;
  return { host, calls };
}

/** Press, then let the whole bore run — the shape most tests want. */
function pressAndEat(host: DigHost): void {
  bite(host);
  digJobTick(host, 60, true);
}

describe('the stroke that meets nothing', () => {
  it('tells the miss out loud, and does not throw anything', () => {
    /* Open air ahead AND below — the press her jaws cannot answer. For a
     * while this lobbed a fireball down the aim line; Joshua pulled fire
     * out of digging (v0.1.98 — it becomes the fire ant's combat
     * signature), so the press is back to the honest answer it had
     * before the charge existed: the OUT OF REACH note, and nothing cut
     * or pretending to be. */
    const { host, calls } = makeHost(() => false);
    bite(host);
    expect(calls.miss).toBe(1);
    expect(calls.subtracted).toBe(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(false);
    expect(calls.revealed).toBe(0);
  });

  it('stays quiet when soil actually came out', () => {
    /* A press starts the JOB — the cylinder eaten over seconds — so the
     * soil leaves as the beats land, not on the button. Run the whole
     * bore and the press was a success: no miss, chips flew. */
    const { host, calls } = makeHost(() => true);
    pressAndEat(host);
    expect(calls.miss).toBe(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(true);
    expect(calls.revealed).toBeGreaterThanOrEqual(1);
  });

  it('still tells the miss on a seated stroke that cuts nothing (bark)', () => {
    /* Ground says solid (the tree is unioned in so she can climb it) but
     * the shovel's field has no wood in it: seated, subtracted, nothing
     * changed. That press failing belongs on the screen — and it is a
     * MISS, not a throw, because her jaws DID reach something. */
    const { host, calls } = makeHost(() => true, () => false);
    pressAndEat(host);
    expect(calls.miss).toBe(1);
    expect(calls.subtracted).toBeGreaterThan(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(false);
  });

  it('a press mid-bore does nothing — the eating IS the cooldown', () => {
    const { host, calls } = makeHost(() => true);
    bite(host);
    const job = (host as { digJob: unknown }).digJob;
    expect(job).not.toBeNull();
    bite(host);
    expect((host as { digJob: unknown }).digJob).toBe(job);
    expect(calls.miss).toBe(0);
  });

  it('releasing the press abandons the rest, and what was cut stays', () => {
    const { host, calls } = makeHost(() => true);
    bite(host);
    const before = calls.subtracted;
    expect(before).toBeGreaterThan(0);
    digJobTick(host, 1, false);
    expect((host as { digJob: unknown }).digJob).toBeNull();
    digJobTick(host, 60, true);
    expect(calls.subtracted).toBe(before);
    /* And no miss: an abandoned mouthful is a choice, not a failure. */
    expect(calls.miss).toBe(0);
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

  it('biteCentre seats the face one bore radius past the first soil', () => {
    const wallZ = 0.5 + 2 / MM; // a face 2 mm out along the aim
    const { host } = makeHost((_x, _y, z) => z >= wallZ);
    const out = new THREE.Vector3();
    const aim = new THREE.Vector3(0, 0, 1);
    expect(biteCentre(host, aim, NOSE_REACH + JAW_PAST_NOSE, out)).toBe(true);
    expect(out.z).toBeGreaterThan(wallZ - 1e-6);
    expect(out.z).toBeLessThan(wallZ + host.boreRadius() * 2);
  });
});

/**
 * THE BORE FITS ITS DIGGER, BY CONSTRUCTION — the rule that replaced
 * "the shovel is a 6 mm ball".
 *
 * Joshua's blueprint made the cut a cylinder read off the ant's own body:
 * diameter = her standing height widened by `BORE_WIDEN`, floored at
 * `BORE_MIN_MM`. The widen is what buys the antenna sweep and the gait's
 * lift their headroom, and the floor is what keeps the smallest worker's
 * tunnel above the carve field's own resolution. Pinned so neither can
 * be edited into a bore an ant cannot walk.
 */
describe('the bore fits its digger', () => {
  it('is always wider than the ant is tall', () => {
    expect(BORE_WIDEN).toBeGreaterThanOrEqual(1.5);
    for (const heightMm of [1.1, 1.3, 3.0, 6.0]) {
      const diaMm = Math.max(BORE_MIN_MM, heightMm * BORE_WIDEN);
      expect(diaMm).toBeGreaterThan(heightMm);
    }
  });

  it('never goes below the floor a camera and the field can live with', () => {
    expect(BORE_MIN_MM).toBeGreaterThanOrEqual(4);
  });

  it('the queen-sized test bore still clears the fitted body extents', () => {
    expect(2.25 / MM).toBeGreaterThan(BODY_HALF_TALL);
    expect(2.25 / MM).toBeGreaterThan(BORE_HUG_WIDE / 2);
  });
});
