/**
 * The carry room's arithmetic: the lattice, the face-culled mesh, the ray
 * that picks a block, and the column an ant stands on.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCK_MM, BlockGrid, meshChunk, raycastBlocks,
} from '../src/scenes/blockCarry';

describe('BlockGrid', () => {
  it('counts what it holds, and only real changes count', () => {
    const g = new BlockGrid({ x: 4, y: 4, z: 4 });
    expect(g.solid).toBe(0);
    expect(g.set(1, 1, 1, true)).toBe(true);
    expect(g.set(1, 1, 1, true)).toBe(false); // already solid
    expect(g.solid).toBe(1);
    expect(g.set(1, 1, 1, false)).toBe(true);
    expect(g.solid).toBe(0);
  });

  it('treats outside as air and refuses writes there', () => {
    const g = new BlockGrid({ x: 2, y: 2, z: 2 });
    expect(g.get(-1, 0, 0)).toBe(false);
    expect(g.set(5, 0, 0, true)).toBe(false);
    expect(g.solid).toBe(0);
  });

  it('fillAll fills, and columnTop reads the standable surface', () => {
    const g = new BlockGrid({ x: 3, y: 5, z: 3 });
    g.fillAll();
    expect(g.solid).toBe(45);
    expect(g.columnTop(1, 1)).toBe(5);
    g.set(1, 4, 1, false); // take the top block of the middle column
    expect(g.columnTop(1, 1)).toBe(4);
    for (let y = 0; y < 5; y += 1) g.set(2, y, 2, false);
    expect(g.columnTop(2, 2)).toBe(-1); // dug to nothing
  });
});

describe('meshChunk', () => {
  const whole = (g: BlockGrid) =>
    meshChunk(g, 0, 0, 0, g.size.x, g.size.y, g.size.z);

  it('one block is six faces', () => {
    const g = new BlockGrid({ x: 3, y: 3, z: 3 });
    g.set(1, 1, 1, true);
    const mesh = whole(g);
    expect(mesh.positions.length / 3).toBe(24); // 6 faces x 4 verts
    expect(mesh.indices.length / 3).toBe(12); // 6 faces x 2 tris
  });

  it('two touching blocks bury their shared faces', () => {
    const g = new BlockGrid({ x: 4, y: 3, z: 3 });
    g.set(1, 1, 1, true);
    g.set(2, 1, 1, true);
    const mesh = whole(g);
    expect(mesh.indices.length / 3).toBe(20); // 10 faces, not 12
  });

  it('a buried block draws nothing at all', () => {
    const g = new BlockGrid({ x: 3, y: 3, z: 3 });
    g.fillAll();
    const inner = meshChunk(g, 1, 1, 1, 2, 2, 2);
    expect(inner.indices.length).toBe(0);
  });

  it('speaks millimetres: a block spans BLOCK_MM', () => {
    const g = new BlockGrid({ x: 2, y: 2, z: 2 });
    g.set(0, 0, 0, true);
    const mesh = whole(g);
    let maxX = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, mesh.positions[i]!);
    }
    expect(maxX).toBe(BLOCK_MM);
  });
});

describe('raycastBlocks', () => {
  it('finds the first solid cell and the face it entered by', () => {
    const g = new BlockGrid({ x: 8, y: 8, z: 8 });
    g.set(5, 3, 3, true);
    const hit = raycastBlocks(g, 0.5, 3.5, 3.5, 1, 0, 0, 20);
    expect(hit).not.toBeNull();
    expect(hit!.cell).toEqual([5, 3, 3]);
    expect(hit!.normal).toEqual([-1, 0, 0]); // entered through the -X face
  });

  it('walks diagonals without skipping corners', () => {
    const g = new BlockGrid({ x: 8, y: 8, z: 8 });
    g.set(4, 4, 4, true);
    const hit = raycastBlocks(g, 0.5, 0.5, 0.5, 1, 1, 1, 20);
    expect(hit).not.toBeNull();
    expect(hit!.cell).toEqual([4, 4, 4]);
  });

  it('reports a buried origin as its own cell, faceless', () => {
    const g = new BlockGrid({ x: 4, y: 4, z: 4 });
    g.fillAll();
    const hit = raycastBlocks(g, 1.5, 1.5, 1.5, 0, 1, 0, 10);
    expect(hit!.cell).toEqual([1, 1, 1]);
    expect(hit!.normal).toEqual([0, 0, 0]);
    expect(hit!.dist).toBe(0);
  });

  it('gives up past its reach', () => {
    const g = new BlockGrid({ x: 32, y: 4, z: 4 });
    g.set(30, 1, 1, true);
    expect(raycastBlocks(g, 0.5, 1.5, 1.5, 1, 0, 0, 10)).toBeNull();
  });

  it('digging from above finds the top face', () => {
    const g = new BlockGrid({ x: 4, y: 4, z: 4 });
    g.fillAll();
    const hit = raycastBlocks(g, 1.5, 8, 1.5, 0, -1, 0, 10);
    expect(hit!.cell).toEqual([1, 3, 1]);
    expect(hit!.normal).toEqual([0, 1, 0]);
  });
});
