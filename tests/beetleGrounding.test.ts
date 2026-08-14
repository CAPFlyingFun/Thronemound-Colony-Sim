import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Beetle } from '../src/scenes/Beetle';

const bottomOf = (beetle: Beetle): number => {
  beetle.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(beetle.root).min.y;
};

describe('procedural beetle grounding', () => {
  it('keeps the living beetle entirely above the terrain plane', () => {
    const ground = 3;
    const beetle = new Beetle('grounded', 0, ground, 0);

    beetle.tick(1 / 60, () => ground, false);

    expect(bottomOf(beetle)).toBeGreaterThanOrEqual(ground - 1e-5);
  });

  it('lifts the fallen pose instead of rotating it through the ground', () => {
    const ground = 3;
    const beetle = new Beetle('fallen', 0, ground, 0);
    beetle.alive = false;

    beetle.tick(1 / 60, () => ground, false);

    expect(bottomOf(beetle)).toBeGreaterThanOrEqual(ground - 1e-5);
  });
});
