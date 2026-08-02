import { describe, expect, it } from 'vitest';
import { anyOf, bore, box, carve } from '../src/voxel/carve';

const solidEverywhere = () => 1;
/** The convention the whole field uses: positive means there is soil here. */
const isSolid = (f: (x: number, y: number, z: number) => number,
  x: number, y: number, z: number) => f(x, y, z) > 0;

describe('carved voids', () => {
  it('a box is positive inside and negative out', () => {
    const b = box([0, 0, 0], [10, 10, 10]);
    expect(b(5, 5, 5)).toBeGreaterThan(0);
    expect(b(-1, 5, 5)).toBeLessThan(0);
    expect(b(5, 5, 11)).toBeLessThan(0);
    // And it reads as a distance: the middle is five from the nearest face.
    expect(b(5, 5, 5)).toBeCloseTo(5, 6);
  });

  it('a bore is a round tunnel of the radius asked for, with ends', () => {
    const t = bore([0, 0, 0], [0, 0, 20], 5);
    expect(t(0, 0, 10)).toBeCloseTo(5, 6);
    // Four millimetres off the axis is still inside a five millimetre bore.
    expect(t(4, 0, 10)).toBeGreaterThan(0);
    expect(t(6, 0, 10)).toBeLessThan(0);
    // Past either end it stops, so a shaft has a bottom.
    expect(t(0, 0, 26)).toBeLessThan(0);
    expect(t(0, 0, -6)).toBeLessThan(0);
  });

  it('carving takes the void OUT of the solid', () => {
    const hollow = carve(solidEverywhere, box([0, 0, 0], [10, 10, 10]));
    expect(isSolid(hollow, 5, 5, 5)).toBe(false);
    expect(isSolid(hollow, 20, 20, 20)).toBe(true);
  });

  it('joins a shaft to a room, so one can be crawled into the other', () => {
    /*
     * The rig this exists for: a vertical bore ten millimetres across dropping
     * into a room. The join is what matters — the shaft has to reach INSIDE
     * the room, or a wafer of soil is left across the opening and she arrives
     * at a ceiling instead of a doorway.
     */
    const room = box([27, 4, 22], [37, 14, 42]);
    const shaft = bore([32, 66, 32], [32, 12, 32], 5);
    const world = carve(box([0, 0, 0], [64, 64, 64]), anyOf([room, shaft]));
    // Open all the way down the shaft.
    for (let y = 20; y < 64; y += 2) expect(isSolid(world, 32, y, 32)).toBe(false);
    // Open across the room.
    expect(isSolid(world, 32, 9, 25)).toBe(false);
    expect(isSolid(world, 32, 9, 40)).toBe(false);
    // And solid just outside both.
    expect(isSolid(world, 32, 9, 45)).toBe(true);
    expect(isSolid(world, 45, 30, 32)).toBe(true);
    // Nothing left across the join.
    for (let y = 10; y <= 16; y += 0.5) expect(isSolid(world, 32, y, 32)).toBe(false);
  });

  it('anyOf is the union, so voids merge rather than cancel', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    const b2 = box([8, 0, 0], [18, 10, 10]);
    const both = anyOf([a, b2]);
    expect(both(5, 5, 5)).toBeGreaterThan(0);
    expect(both(15, 5, 5)).toBeGreaterThan(0);
    expect(both(9, 5, 5)).toBeGreaterThan(0);
    expect(both(25, 5, 5)).toBeLessThan(0);
  });

  it('leaves the solid alone well away from the cut', () => {
    const base = box([0, 0, 0], [64, 64, 64]);
    const world = carve(base, bore([32, 66, 32], [32, 12, 32], 5));
    expect(world(10, 30, 10)).toBeCloseTo(base(10, 30, 10), 6);
  });
});
