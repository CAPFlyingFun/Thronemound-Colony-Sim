import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bite, biteCentre, type DigHost } from '../src/scenes/islandDig';
import {
  NOSE_REACH, JAW_PAST_NOSE, SCOOP_DEEP_MM, SCOOP_BALL_MM, SCOOP_WIDE_MM,
  SCOOP_TALL_MM, BODY_HALF_TALL, BORE_HUG_WIDE,
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
  } as unknown as DigHost;
  return { host, calls };
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
    const { host, calls } = makeHost(() => true);
    bite(host);
    expect(calls.miss).toBe(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(true);
    expect(calls.revealed).toBe(1);
  });

  it('still tells the miss on a seated stroke that cuts nothing (bark)', () => {
    /* Ground says solid (the tree is unioned in so she can climb it) but
     * the shovel's field has no wood in it: seated, subtracted, nothing
     * changed. That press failing belongs on the screen — and it is a
     * MISS, not a throw, because her jaws DID reach something. */
    const { host, calls } = makeHost(() => true, () => false);
    bite(host);
    expect(calls.miss).toBe(1);
    expect(calls.subtracted).toBeGreaterThan(0);
    expect((host as { biteTouched: boolean }).biteTouched).toBe(false);
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

/**
 * THE BRUSH IS A BALL, and it has to stay one.
 *
 * Asked directly: "what is the dig radius and is it a round shape? I was
 * thinking make it a 6x6x6mm ball/sphere." It was not round — it was an
 * ellipsoid 10 wide, 5 tall and 3 deep — and the shape mattered more than
 * it looked, because the brush is drawn in HER frame: the 3 mm depth axis
 * is the one pointing wherever she digs. Measured in the running game,
 * one stroke aimed straight down opened a saucer 2 mm deep. The ball opens
 * a 6 mm hole in every direction, which is three and a half times the soil
 * on the one heading the founding is built around.
 *
 * Pinned here rather than left to the constants because three separate
 * exports that must agree are three chances for one of them to be edited
 * alone — which is exactly how it stopped being round the first time.
 */
describe('the shovel is a ball', () => {
  it('is the same across every axis', () => {
    expect(SCOOP_WIDE_MM).toBe(SCOOP_BALL_MM);
    expect(SCOOP_TALL_MM).toBe(SCOOP_BALL_MM);
    expect(SCOOP_DEEP_MM).toBe(SCOOP_BALL_MM);
  });

  it('is the 6 mm across that was asked for', () => {
    expect(SCOOP_BALL_MM).toBe(6);
  });

  it('still clears her body in the passage it cuts', () => {
    /* A round tunnel is only worth having if she fits in it. Half the
     * brush against the half-extents she is fitted to — see `BODY_FIT`
     * and `BORE_HUG_WIDE` in `islandTuning`. */
    expect(SCOOP_BALL_MM / 2 / MM).toBeGreaterThan(BODY_HALF_TALL);
    expect(SCOOP_BALL_MM / 2 / MM).toBeGreaterThan(BORE_HUG_WIDE / 2);
  });
});
