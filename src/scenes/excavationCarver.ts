import type { ExcavationPath, Vec3 } from './excavationPath';

export interface CarveSample {
  kind: 'sphere';
  branchId: string;
  center: Vec3;
  radiusMm: number;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/**
 * Convert a centerline into overlapping spherical subtraction samples.
 *
 * The DensityField integration layer can translate millimetres into its own
 * world units. Keeping this module in physical units makes volume accounting
 * and manual/preset paths agree before rendering concerns enter the picture.
 */
export function samplesForPath(path: ExcavationPath, radiusMm: number, spacingMm = radiusMm * 0.5): CarveSample[] {
  if (radiusMm <= 0) throw new Error('Excavation radius must be positive');
  if (spacingMm <= 0) throw new Error('Excavation sample spacing must be positive');

  const out: CarveSample[] = [];
  for (const branch of path.branches) {
    if (branch.points.length === 1) {
      out.push({ kind: 'sphere', branchId: branch.id, center: { ...branch.points[0]!.position }, radiusMm });
      continue;
    }
    for (let i = 1; i < branch.points.length; i += 1) {
      const a = branch.points[i - 1]!.position;
      const b = branch.points[i]!.position;
      const len = distance(a, b);
      const steps = Math.max(1, Math.ceil(len / spacingMm));
      for (let step = 0; step <= steps; step += 1) {
        if (i > 1 && step === 0) continue;
        out.push({
          kind: 'sphere',
          branchId: branch.id,
          center: lerp(a, b, step / steps),
          radiusMm,
        });
      }
    }
  }

  for (const connector of path.connectors) {
    out.push({
      kind: 'sphere',
      branchId: `connector:${connector.kind}`,
      center: { ...connector.center },
      radiusMm: connector.radiusMm,
    });
  }
  return out;
}

export function centerlineLengthMm(path: ExcavationPath): number {
  let total = 0;
  for (const branch of path.branches) {
    for (let i = 1; i < branch.points.length; i += 1) {
      total += distance(branch.points[i - 1]!.position, branch.points[i]!.position);
    }
  }
  return total;
}

/**
 * Tube-only estimate. Chambers are intentionally excluded because their
 * overlapping connection with the tube must be measured by the DensityField
 * when exact spoil accounting is required.
 */
export function estimateTubeVolumeMm3(path: ExcavationPath, radiusMm: number): number {
  if (radiusMm <= 0) throw new Error('Excavation radius must be positive');
  return Math.PI * radiusMm * radiusMm * centerlineLengthMm(path);
}
