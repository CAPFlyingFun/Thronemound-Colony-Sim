/**
 * WHAT A LOADED CREATURE IS MADE OF, once the exporter has had its say.
 *
 * Reported: "worms are too shiny." They were, and the cause is not the worm
 * — it is what glTF hands three.js, and it will be the same for every animal
 * that arrives in the same format. So this is a pass over any creature GLB
 * rather than a fix to one of them.
 *
 * ## What glTF actually says
 *
 * A glTF material carries metalness and roughness in ONE packed texture:
 * green is roughness, blue is metalness. The loader therefore sets
 * `metalness = 1` and `roughness = 1` on the material and lets the map
 * supply the real numbers, because three.js MULTIPLIES the two. Those 1s are
 * not a claim that the worm is a mirror; they are the identity element.
 *
 * ## Measured, on the earthworm's own texture
 *
 *     blue  (metalness)  mean 0.005, max 0.208
 *     green (roughness)  mean 0.282, range 0.000 - 0.459
 *
 * The blue is honest: nothing here is metal. The green is the problem. It has
 * real authored variation — a 0.46 spread is not a flat map — but the WHOLE
 * RANGE is in the wrong place. Its roughest patch is 0.46 and its smoothest
 * is a perfect mirror, so every part of the animal renders somewhere between
 * wet plastic and glass. Against this island's single hard sun that reads
 * exactly as reported.
 *
 * ## Why the map goes rather than gets rescaled
 *
 * A multiply can only ever make a surface GLOSSIER, so there is no factor
 * that lifts a 0-to-0.46 range up to where flesh lives. Rescaling would mean
 * reading the texture back through a canvas and rewriting its green channel
 * per model — real work, a readback per creature, and it buys sheen variation
 * across an animal six millimetres thick being looked at by an ant nine
 * millimetres long. Nobody will ever see it. A flat, correct roughness will.
 *
 * `metalness` is forced to zero rather than left at 1-times-a-dark-map. It
 * measures as effectively zero today, but the multiply means one future model
 * exported with a bright blue channel would silently turn chrome, and there
 * is nothing metal on this island.
 */
import * as THREE from 'three';

/**
 * How rough a damp animal is.
 *
 * GAME TUNING informed by biology, not a measured figure. An earthworm is
 * genuinely moist — it breathes through its skin and has to stay wet, so it
 * SHOULD carry a little sheen and going fully matte would be as wrong in the
 * other direction. This is the value that reads as damp rather than varnished.
 */
export const CREATURE_ROUGHNESS = 0.72;

/**
 * Chitin — harder, drier and a touch glossier than a worm.
 *
 * Not used yet. Named so the next animal has somewhere obvious to go rather
 * than a magic number at its call site.
 */
export const CHITIN_ROUGHNESS = 0.55;

/**
 * AND THE LOOSE THINGS ON THE GROUND ARE MATTE — stone, soil and dead wood.
 *
 * Fully rough, the same as `BARK_ROUGHNESS`, and for the same reported
 * reason: "trees shouldn't be glossy". A chitinous insect has a real
 * sheen and gets one; a pebble, a clod of dirt and a dry twig have none at
 * all, and the exporter's packed metal-roughness map gives every one of
 * them a wet highlight until it is cleared.
 */
export const PROP_ROUGHNESS = 1;

/**
 * Put a loaded creature into this island's material language.
 *
 * Call it once on the LOADED TEMPLATE, before cloning: `SkeletonUtils.clone`
 * shares materials with the original, so dressing the template dresses every
 * clone and dressing each clone would do the same work many times over.
 *
 * Returns how many materials it touched, which is what a probe can check —
 * a pass that silently matched nothing is the failure mode worth catching.
 */
export function dressCreature(
  root: THREE.Object3D, roughness: number = CREATURE_ROUGHNESS,
): number {
  const done = new Set<THREE.Material>();
  root.traverse((n) => {
    const holder = n as THREE.Mesh;
    if (!holder.material) return;
    const list = Array.isArray(holder.material) ? holder.material : [holder.material];
    for (const mat of list) {
      const std = mat as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial || done.has(std)) continue;
      done.add(std);
      /* BOTH maps, because glTF packs them in one image and three.js hangs
       * that same texture off both slots. Leaving either behind leaves the
       * multiply in place and the animal still shines. */
      std.roughnessMap = null;
      std.metalnessMap = null;
      std.roughness = roughness;
      std.metalness = 0;
      std.needsUpdate = true;
    }
  });
  return done.size;
}
