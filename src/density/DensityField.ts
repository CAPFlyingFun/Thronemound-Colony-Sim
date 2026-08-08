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

/** The six face neighbours a smoothing pass averages over. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

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

  /**
   * THE SMOOTHING BRUSH — RollerCoaster Tycoon's, on a density field.
   *
   * A tunnel cut by overlapping brushes is not smooth: consecutive scoops
   * leave a scalloped ridge where their shells cross, and those ridges are
   * what a walker catches on. Averaging each sample with its six
   * neighbours rounds them off, because a signed field's ridges ARE local
   * extrema and a blur is exactly what removes those.
   *
   * Read from a SNAPSHOT rather than in place: blurring while you write
   * feeds each result into the next sample and sweeps the surface along
   * the scan direction instead of relaxing it evenly.
   *
   * `strength` is how far each sample moves toward its neighbourhood mean,
   * 0 doing nothing and 1 replacing the value outright. Anything much
   * above a half will eat a thin wall, so callers should stay well under.
   */
  smoothBox(
    bounds: BrushResult['bounds'], strength = 0.5, maxShift = Infinity,
  ): { changedSamples: number; bounds: BrushResult['bounds'] } {
    const minX = clamp(Math.floor(bounds.minX), 0, this.samplesX - 1);
    const minY = clamp(Math.floor(bounds.minY), 0, this.samplesY - 1);
    const minZ = clamp(Math.floor(bounds.minZ), 0, this.samplesZ - 1);
    const maxX = clamp(Math.ceil(bounds.maxX), 0, this.samplesX - 1);
    const maxY = clamp(Math.ceil(bounds.maxY), 0, this.samplesY - 1);
    const maxZ = clamp(Math.ceil(bounds.maxZ), 0, this.samplesZ - 1);
    const k = clamp(strength, 0, 1);
    if (k === 0) return { changedSamples: 0, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };

    const before = this.values.slice();
    const at = (x: number, y: number, z: number): number => {
      if (x < 0 || x >= this.samplesX || y < 0 || y >= this.samplesY
        || z < 0 || z >= this.samplesZ) return NaN;
      return before[this.index(x, y, z)] ?? NaN;
    };
    let changedSamples = 0;
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const here = at(x, y, z);
          if (!Number.isFinite(here)) continue;
          let sum = here;
          let n = 1;
          /* Edge samples average over the neighbours they HAVE. Treating a
           * missing one as zero would drag the window's rim toward the
           * surface and open a seam along it. */
          for (const [dx, dy, dz] of NEIGHBOURS) {
            const v = at(x + dx, y + dy, z + dz);
            if (Number.isFinite(v)) { sum += v; n += 1; }
          }
          /*
           * CAPPED, and that is what keeps a thin roof standing.
           *
           * A blur cannot tell the tunnel's air from the sky's. A sample
           * in a slab between the two averages with the OUTSIDE and goes
           * negative, so the roof thins, and near the surface it thinned
           * straight through — reported as the smoothing pulling the roof
           * down. A shallow ridge is a small correction and survives the
           * cap; a roof one sample thick is a huge one and is refused.
           */
          let next = here + (sum / n - here) * k;
          const shift = next - here;
          if (shift > maxShift) next = here + maxShift;
          else if (shift < -maxShift) next = here - maxShift;
          if (Math.abs(next - here) < 1e-7) continue;
          this.values[this.index(x, y, z)] = next;
          changedSamples += 1;
        }
      }
    }
    return { changedSamples, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
  }

  /**
   * Subtracts an ORIENTED ellipsoid brush — the island builder's egg scoop.
   *
   * A mouthful is not a ball: the spec is 9 mm across, 6 mm tall and only
   * 3 mm deep, lying with its wide face toward the ant. A sphere with any
   * one of those measurements gets the other two wrong by up to a factor
   * of three, which is the difference between a scoop and a crater.
   *
   * `along` is the dig direction (normalized inside); `rightHint` names the
   * scoop's width axis when `along` is vertical and the cross product has
   * nothing to say. Distance uses the standard first-order ellipsoid bound
   * k0·(k0−1)/k1 — exact on the surface, a touch soft far away, and far
   * away is exactly where a brush is not cutting.
   */
  subtractEllipsoid(
    center: Vec3Like, along: Vec3Like, semis: { deep: number; wide: number; tall: number },
    rightHint?: Vec3Like,
  ): BrushResult {
    const { deep, wide, tall } = semis;
    if (![deep, wide, tall].every((s) => Number.isFinite(s) && s > 0)) {
      throw new Error('Brush semi-axes must be positive');
    }

    // The scoop's frame: forward along the dig, right across the width,
    // up over the top. Vertical digs take the hint, or +X as a last resort.
    const fl = Math.hypot(along.x, along.y, along.z) || 1;
    const fx = along.x / fl;
    const fy = along.y / fl;
    const fz = along.z / fl;
    let rx = fz;
    let ry = 0;
    let rz = -fx;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) {
      rx = rightHint?.x ?? 1;
      ry = rightHint?.y ?? 0;
      rz = rightHint?.z ?? 0;
      const hl = Math.hypot(rx, ry, rz) || 1;
      rx /= hl; ry /= hl; rz /= hl;
    } else {
      rx /= rl; rz /= rl;
    }
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const reach = Math.max(deep, wide, tall);
    const padding = this.cellSize;
    const minX = clamp(Math.floor((center.x - reach - padding) / this.cellSize), 0, this.samplesX - 1);
    const minY = clamp(Math.floor((center.y - reach - padding) / this.cellSize), 0, this.samplesY - 1);
    const minZ = clamp(Math.floor((center.z - reach - padding) / this.cellSize), 0, this.samplesZ - 1);
    const maxX = clamp(Math.ceil((center.x + reach + padding) / this.cellSize), 0, this.samplesX - 1);
    const maxY = clamp(Math.ceil((center.y + reach + padding) / this.cellSize), 0, this.samplesY - 1);
    const maxZ = clamp(Math.ceil((center.z + reach + padding) / this.cellSize), 0, this.samplesZ - 1);

    let removedVolume = 0;
    let changedSamples = 0;
    const sampleVolume = this.cellSize ** 3;
    const transitionWidth = this.cellSize;
    const occupancy = (density: number): number =>
      clamp(0.5 + density / (2 * transitionWidth), 0, 1);

    for (let z = minZ; z <= maxZ; z += 1) {
      const wz = z * this.cellSize - center.z;
      for (let y = minY; y <= maxY; y += 1) {
        const wy = y * this.cellSize - center.y;
        for (let x = minX; x <= maxX; x += 1) {
          const wx = x * this.cellSize - center.x;
          // Into the scoop's frame…
          const pa = wx * fx + wy * fy + wz * fz;
          const pr = wx * rx + wy * ry + wz * rz;
          const pu = wx * ux + wy * uy + wz * uz;
          // …and the ellipsoid bound.
          const k0 = Math.hypot(pa / deep, pr / wide, pu / tall);
          const k1 = Math.hypot(pa / (deep * deep), pr / (wide * wide), pu / (tall * tall));
          const brushOutsideDistance = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(deep, wide, tall);
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
