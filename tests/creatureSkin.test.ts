/**
 * WHAT THE EXPORTER LEFT BEHIND, and what we do about it.
 *
 * Reported: "worms are too shiny." The cause is not the worm — it is what
 * glTF hands three.js, and every animal in the same format arrives with it.
 * See `creatureSkin` for the measurement.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  CHITIN_ROUGHNESS, CREATURE_ROUGHNESS, dressCreature,
} from '../src/scenes/creatureSkin';

/** A model as the glTF loader hands it over: 1s, and a packed ORM map. */
const asImported = (): THREE.Object3D => {
  const orm = new THREE.Texture();
  const mat = new THREE.MeshStandardMaterial({
    metalness: 1, roughness: 1, metalnessMap: orm, roughnessMap: orm,
  });
  const root = new THREE.Object3D();
  const skin = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  root.add(skin);
  return root;
};

const firstMaterial = (root: THREE.Object3D): THREE.MeshStandardMaterial => {
  let found: THREE.MeshStandardMaterial | undefined;
  root.traverse((n) => {
    const m = (n as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.isMeshStandardMaterial && !found) found = m;
  });
  if (!found) throw new Error('no material');
  return found;
};

describe('dressing a loaded creature', () => {
  it('takes BOTH maps, because glTF packs them in one image', () => {
    /*
     * The whole bug. three.js hangs the same packed texture off `roughnessMap`
     * and `metalnessMap` and MULTIPLIES each into its own scalar. Clearing one
     * and not the other leaves the multiply in place and the animal still
     * shines — measured on the earthworm's own texture, whose green channel
     * runs 0.000 to 0.459, so every part of it rendered between wet plastic
     * and glass.
     */
    const root = asImported();
    dressCreature(root);
    const m = firstMaterial(root);
    expect(m.roughnessMap).toBeNull();
    expect(m.metalnessMap).toBeNull();
  });

  it('leaves nothing metal, because nothing on this island is', () => {
    /*
     * The blue channel measures 0.005 today, so this changes almost nothing
     * NOW. It is set anyway: `metalness` is 1 times a map, and one future
     * model exported with a bright blue channel would silently turn chrome.
     */
    const root = asImported();
    dressCreature(root);
    expect(firstMaterial(root).metalness).toBe(0);
  });

  it('gives damp flesh a sheen but not a varnish', () => {
    const root = asImported();
    dressCreature(root);
    expect(firstMaterial(root).roughness).toBe(CREATURE_ROUGHNESS);
    /* An earthworm has to stay wet to breathe, so fully matte would be as
     * wrong as glass — but it must be well clear of the 0.28 it shipped at. */
    expect(CREATURE_ROUGHNESS).toBeGreaterThan(0.5);
    expect(CREATURE_ROUGHNESS).toBeLessThan(1);
    /* Chitin is harder and drier, so it keeps a little more shine. */
    expect(CHITIN_ROUGHNESS).toBeLessThan(CREATURE_ROUGHNESS);
  });

  it('reports how many materials it touched', () => {
    /* A pass that silently matched nothing is the failure worth catching:
     * it would leave every animal shiny and say nothing about it. */
    expect(dressCreature(asImported())).toBe(1);
    expect(dressCreature(new THREE.Object3D())).toBe(0);
  });

  it('does the same work once for a material shared between meshes', () => {
    /* `SkeletonUtils.clone` shares materials with the original, which is why
     * the template is dressed rather than each clone. */
    const shared = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 1 });
    const root = new THREE.Object3D();
    for (let i = 0; i < 4; i += 1) {
      root.add(new THREE.Mesh(new THREE.BufferGeometry(), shared));
    }
    expect(dressCreature(root)).toBe(1);
  });

  it('honours a roughness given for a different animal', () => {
    const root = asImported();
    dressCreature(root, CHITIN_ROUGHNESS);
    expect(firstMaterial(root).roughness).toBe(CHITIN_ROUGHNESS);
  });
});
