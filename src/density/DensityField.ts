export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface DensityFieldOptions {
  cellsX: number;
  cellsY: number;
  cellsZ: number;
  cellSize?: number;
}

export interface BrushResult {
  removedVolume: number;
  changedSamples: number;
  bounds: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/**
 * Compact scalar field for editable soil.
 *
 * Positive values are packed soil, negative values are air, and the visible
 * surface is the zero crossing. Coordinates are world units. Thronemound uses
 * one world unit per five millimetres.
 */
export class DensityField {
  readonly cellsX: number;
  readonly cellsY: number;
  readonly cellsZ: number;
  readonly samplesX: number;
  readonly samplesY: number;
  readonly samplesZ: number;
  readonly cellSize: number;
  readonly values: Float32Array;

  constructor(options: DensityFieldOptions) {
    const { cellsX, cellsY, cellsZ, cellSize = 1 } = options;
    if (![cellsX, cellsY, cellsZ].every((value) => Number.isInteger(value) && value > 0)) {
      throw new Error('DensityField cell dimensions must be positive integers');
    }
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error('DensityField cellSize must be positive');
    }

    this.cellsX = cellsX;
    this.cellsY = cellsY;
    this.cellsZ = cellsZ;
    this.samplesX = cellsX + 1;
    this.samplesY = cellsY + 1;
    this.samplesZ = cellsZ + 1;
    this.cellSize = cellSize;
    this.values = new Float32Array(this.samplesX * this.samplesY * this.samplesZ);
  }

  private index(x: number, y: number, z: number): number {
    return x + this.samplesX * (y + this.samplesY * z);
  }

  get(x: number, y: number, z: number): number {
    if (
      x < 0 || x >= this.samplesX ||
      y < 0 || y >= this.samplesY ||
      z < 0 || z >= this.samplesZ
    ) {
      return -Number.MAX_VALUE;
    }
    return this.values[this.index(x, y, z)] ?? -Number.MAX_VALUE;
  }

  set(x: number, y: number, z: number, density: number): void {
    if (
      x < 0 || x >= this.samplesX ||
      y < 0 || y >= this.samplesY ||
      z < 0 || z >= this.samplesZ
    ) {
      throw new RangeError(`Density sample out of bounds: ${x},${y},${z}`);
    }
    this.values[this.index(x, y, z)] = density;
  }

  fill(generator: (x: number, y: number, z: number) => number): void {
    for (let z = 0; z < this.samplesZ; z += 1) {
      for (let y = 0; y < this.samplesY; y += 1) {
        for (let x = 0; x < this.samplesX; x += 1) {
          this.set(
            x,
            y,
            z,
            generator(x * this.cellSize, y * this.cellSize, z * this.cellSize),
          );
        }
      }
    }
  }

  fillFromHeight(heightAt: (x: number, z: number) => number): void {
    this.fill((x, y, z) => heightAt(x, z) - y);
  }

  sample(x: number, y: number, z: number): number {
    const gx = x / this.cellSize;
    const gy = y / this.cellSize;
    const gz = z / this.cellSize;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);
    const tx = gx - x0;
    const ty = gy - y0;
    const tz = gz - z0;

    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const c000 = this.get(x0, y0, z0);
    const c100 = this.get(x0 + 1, y0, z0);
    const c010 = this.get(x0, y0 + 1, z0);
    const c110 = this.get(x0 + 1, y0 + 1, z0);
    const c001 = this.get(x0, y0, z0 + 1);
    const c101 = this.get(x0 + 1, y0, z0 + 1);
    const c011 = this.get(x0, y0 + 1, z0 + 1);
    const c111 = this.get(x0 + 1, y0 + 1, z0 + 1);

    const x00 = lerp(c000, c100, tx);
    const x10 = lerp(c010, c110, tx);
    const x01 = lerp(c001, c101, tx);
    const x11 = lerp(c011, c111, tx);
    const y0v = lerp(x00, x10, ty);
    const y1v = lerp(x01, x11, ty);
    return lerp(y0v, y1v, tz);
  }

  /**
   * Subtracts a spherical signed-distance brush from the packed soil.
   * Removed volume is estimated from occupancy change around the zero crossing,
   * so the loose pellet is scaled from the same operation that edits terrain.
   */
  subtractSphere(center: Vec3Like, radius: number): BrushResult {
    if (!Number.isFinite(radius) || radius <= 0) {
      throw new Error('Brush radius must be positive');
    }

    const padding = this.cellSize;
    const minX = clamp(Math.floor((center.x - radius - padding) / this.cellSize), 0, this.samplesX - 1);
    const minY = clamp(Math.floor((center.y - radius - padding) / this.cellSize), 0, this.samplesY - 1);
    const minZ = clamp(Math.floor((center.z - radius - padding) / this.cellSize), 0, this.samplesZ - 1);
    const maxX = clamp(Math.ceil((center.x + radius + padding) / this.cellSize), 0, this.samplesX - 1);
    const maxY = clamp(Math.ceil((center.y + radius + padding) / this.cellSize), 0, this.samplesY - 1);
    const maxZ = clamp(Math.ceil((center.z + radius + padding) / this.cellSize), 0, this.samplesZ - 1);

    let removedVolume = 0;
    let changedSamples = 0;
    const sampleVolume = this.cellSize ** 3;
    const transitionWidth = this.cellSize;
    const occupancy = (density: number): number =>
      clamp(0.5 + density / (2 * transitionWidth), 0, 1);

    for (let z = minZ; z <= maxZ; z += 1) {
      const wz = z * this.cellSize;
      for (let y = minY; y <= maxY; y += 1) {
        const wy = y * this.cellSize;
        for (let x = minX; x <= maxX; x += 1) {
          const wx = x * this.cellSize;
          const dx = wx - center.x;
          const dy = wy - center.y;
          const dz = wz - center.z;
          const brushOutsideDistance = Math.sqrt(dx * dx + dy * dy + dz * dz) - radius;
          const oldDensity = this.get(x, y, z);
          const newDensity = Math.min(oldDensity, brushOutsideDistance);
          if (newDensity >= oldDensity - 1e-7) continue;

          this.set(x, y, z, newDensity);
          changedSamples += 1;
          removedVolume += Math.max(0, occupancy(oldDensity) - occupancy(newDensity)) * sampleVolume;
        }
      }
    }

    return {
      removedVolume,
      changedSamples,
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
    };
  }
}
