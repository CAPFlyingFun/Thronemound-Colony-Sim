import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  frustumWorstAt, lensBasis, lensClearance, settleLensBackstop,
  type CameraHost,
} from '../src/scenes/islandCamera';

/**
 * A WALL AT z = 0, air on the near side of it. Density is the signed
 * distance, positive inside, which is the sign convention the real field
 * uses.
 *
 * The wall is BESIDE the lens, not in front of it, because that is the
 * shape of the bug: looking along a bank with her ahead, the near plane's
 * corners spread sideways into ground the lens itself is clear of.
 */
const wall = (z: number) => z;

/**
 * The smallest host the two guards actually read. Everything else on
 * `CameraHost` is untouched by this path, so it is left off rather than
 * filled with plausible lies.
 */
function host(camAt: THREE.Vector3, density: (z: number) => number): CameraHost {
  const camera = new THREE.PerspectiveCamera(60, 932 / 430, 0.1, 16000);
  camera.position.copy(camAt);
  const at = new THREE.Vector3(-4, 0, 0);
  return {
    camera,
    at,
    up: new THREE.Vector3(0, 1, 0),
    eyeAt: null,
    lensWorstMm: -999,
    /* The guard walks out along the soil's own OUTWARD normal, which for
     * a wall filling +z is -z. */
    walker: {
      normalAt: (_p: THREE.Vector3, out: THREE.Vector3) => { out.set(0, 0, -1); },
    },
    soilDensityAt: (_x: number, _y: number, z: number) => density(z),
  } as unknown as CameraHost;
}

describe('the lens backstop', () => {
  /*
   * Reported: seeing through the terrain in third person. The backstop
   * opened with a POINT test — `soilDensityAt(p) <= 0` — which is exactly
   * the test `frustumWorstAt` exists because it is not enough.
   */
  it('acts when the lens is in air but a near-plane CORNER is in the soil', () => {
    const clear = lensClearance(host(new THREE.Vector3(), wall));
    /*
     * Park the lens a hair outside the wall — clear as a point, and much
     * closer than the picture reaches. The old early-out sent this frame
     * away untouched.
     */
    const start = -clear * 0.4;
    const h = host(new THREE.Vector3(0, 0, start), wall);

    const fwd = new THREE.Vector3();
    const up = new THREE.Vector3();
    lensBasis(h, fwd, up);
    expect(h.soilDensityAt(0, 0, start)).toBeLessThan(0);
    expect(frustumWorstAt(h, h.camera.position, fwd, up)).toBeGreaterThan(0);

    settleLensBackstop(h);

    /* Pushed out along the surface normal until nothing is in frame. */
    expect(h.camera.position.z).toBeLessThan(start);
    lensBasis(h, fwd, up);
    expect(frustumWorstAt(h, h.camera.position, fwd, up)).toBeLessThanOrEqual(0);
  });

  it('reports what the LENS is worst at, not what its target was', () => {
    /*
     * `lensWorstMm` is the number probe-lens grades, and it is written by
     * the guard. Every frame the backstop returned early it was left
     * holding the previous call's answer — which in the chase is a
     * measurement of the smoothed TARGET, not of where the lens ended up.
     * That is how the probe could read clean on a frame with dirt in it.
     */
    const h = host(new THREE.Vector3(0, 0, -40), wall);
    h.lensWorstMm = 12345;
    settleLensBackstop(h);
    expect(h.lensWorstMm).not.toBe(12345);
    expect(h.lensWorstMm).toBeLessThan(0);
  });

  it('leaves a lens in open air exactly where it is', () => {
    /* The correction is not free and must not fire on the 95% of frames
     * that are nowhere near soil — the guard's own cheap bound handles
     * those, and it must still hold now that the point test is gone. */
    const h = host(new THREE.Vector3(0, 0, -40), wall);
    settleLensBackstop(h);
    expect(h.camera.position.z).toBe(-40);
  });
});
