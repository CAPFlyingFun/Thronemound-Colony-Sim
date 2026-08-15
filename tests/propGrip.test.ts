import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { Prop, PROP_SPECS, type PropGround } from '../src/scenes/islandProps';

/**
 * A CARRIED THING KEEPS THE ANGLE IT WAS PICKED UP AT, in HER frame.
 *
 * Reported: "whatever angle you carry it at first and grab, is stays that
 * way and follows relative to the ant so the twig doesn't stay a fix angle
 * in world space... as it looks weird with it rotating through the ant".
 *
 * The old `tick` wrote position and nothing else, so a carried twig kept
 * the world rotation it was scattered with — walk her in a circle and the
 * twig swings through her head, because it is not turning at all and she
 * is turning under it.
 */
const twig = (): Prop => new Prop('twig', PROP_SPECS.twig!, 0, 0, 0);

/** A floor at y = 0, so the resting half of `tick` is not under test. */
const flat: PropGround = { floorUnder: () => 0 };

const yaw = (deg: number): THREE.Quaternion => new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);

describe('the grip a carried thing was taken with', () => {
  it('turns WITH her, so the angle between them never changes', () => {
    const p = twig();
    const her = yaw(0);
    p.carried = true;
    p.takeGrip(her);
    p.tick(flat, 1 / 60, her);
    const first = p.root.quaternion.clone();

    /* She turns a quarter circle. The twig must turn with her — so its
     * angle RELATIVE to her is unchanged, while its world angle is not. */
    const turned = yaw(90);
    p.tick(flat, 1 / 60, turned);

    const relBefore = her.clone().invert().multiply(first);
    const relAfter = turned.clone().invert().multiply(p.root.quaternion);
    expect(relAfter.angleTo(relBefore)).toBeCloseTo(0, 6);
    expect(p.root.quaternion.angleTo(first)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('remembers the angle it was actually grabbed at', () => {
    /* Two props taken at different facings must be carried differently —
     * the grip is captured, not chosen. */
    const a = twig();
    const b = twig();
    a.carried = true;
    b.carried = true;
    a.takeGrip(yaw(0));
    b.takeGrip(yaw(60));
    expect(a.grip.angleTo(b.grip)).toBeGreaterThan(0.5);
  });

  it('does not touch rotation once it is put down', () => {
    /* On the ground it keeps whatever angle it landed at; only a carried
     * thing is driven by her. */
    const p = twig();
    p.carried = true;
    p.takeGrip(yaw(0));
    p.tick(flat, 1 / 60, yaw(45));
    const held = p.root.quaternion.clone();
    p.carried = false;
    p.tick(flat, 1 / 60, yaw(180));
    expect(p.root.quaternion.angleTo(held)).toBeCloseTo(0, 6);
  });
});

describe('a loose thing rests on the soil that is there now', () => {
  it('falls to a floor that has moved down, rather than snapping', () => {
    const p = twig();
    p.carried = false;
    p.at.set(0, 5, 0);
    const deep: PropGround = { floorUnder: () => 0 };
    p.tick(deep, 1 / 60);
    /* One frame is a fall, not a teleport. */
    expect(p.at.y).toBeGreaterThan(0.5);
    for (let i = 0; i < 600; i += 1) p.tick(deep, 1 / 60);
    /* Settled ON the floor, bedded by its own rest offset — not through it
     * and not hovering. A twig's is a fraction of its radius. */
    expect(p.at.y).toBeGreaterThan(0);
    expect(p.at.y).toBeLessThan(0.2);
    /* And the mesh went with it, which is the half a player sees. */
    expect(p.root.position.y).toBeCloseTo(p.at.y, 6);
  });

  it('is left where it is when there is no floor within reach', () => {
    /* `floorUnder` reports -Infinity over a void. It must keep falling
     * rather than being handed a made-up floor. */
    const p = twig();
    p.carried = false;
    p.at.set(0, 5, 0);
    const void_: PropGround = { floorUnder: () => -Infinity };
    for (let i = 0; i < 10; i += 1) p.tick(void_, 1 / 60);
    expect(p.at.y).toBeLessThan(5);
    expect(Number.isFinite(p.at.y)).toBe(true);
  });
});
