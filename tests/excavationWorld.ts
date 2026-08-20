/**
 * A dense little world for the dig-system tests — the whole of `Diggable` in
 * thirty lines, so a refusal can be checked without building a formicarium.
 *
 * It implements `dig` with the same two guards `VoxelWorld.dig` uses, because
 * those guards are part of what is under test: a fake that removed anything
 * asked of it would let a broken excavator pass.
 */
import { AIR, isSolid, materialOf, type VoxelId } from '../src/voxel/VoxelWorld';

export { AIR, CLAY, STONE, TOPSOIL } from '../src/voxel/VoxelWorld';

/** The habitat's glass: an id above the material table, so it has none. */
export const GLASS_ID = 5;

export class TinyWorld {
  private readonly cells: VoxelId[];

  constructor(
    private readonly sx: number,
    private readonly sy: number,
    private readonly sz: number,
    fill: VoxelId,
  ) {
    this.cells = new Array<VoxelId>(sx * sy * sz).fill(fill);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  private index(x: number, y: number, z: number): number {
    return (y * this.sz + z) * this.sx + x;
  }

  get(x: number, y: number, z: number): VoxelId {
    if (!this.inBounds(x, y, z)) return AIR;
    return this.cells[this.index(x, y, z)]!;
  }

  set(x: number, y: number, z: number, id: VoxelId): void {
    if (!this.inBounds(x, y, z)) return;
    this.cells[this.index(x, y, z)] = id;
  }

  private readonly fills = new Map<string, number>();

  fillOf(x: number, y: number, z: number): number {
    const found = this.fills.get(`${x},${y},${z}`);
    if (found !== undefined) return found;
    return isSolid(this.get(x, y, z)) ? 1 : 0;
  }

  setFill(x: number, y: number, z: number, fill: number): void {
    this.fills.set(`${x},${y},${z}`, fill);
  }

  clearFill(x: number, y: number, z: number): void {
    this.fills.delete(`${x},${y},${z}`);
  }

  dig(x: number, y: number, z: number): VoxelId {
    const existing = this.get(x, y, z);
    if (!isSolid(existing) || !materialOf(existing).diggable) return AIR;
    this.set(x, y, z, AIR);
    return existing;
  }
}
