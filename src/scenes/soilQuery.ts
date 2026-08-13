/**
 * IS THERE SOIL HERE? — the island's one answer, and everything asks it.
 *
 * Pulled out of `IslandScene` whole. It is barely a hundred lines and it is
 * the most-called code in the game: the walker's casts, the leg solver's
 * footing, the shovel's reach, the bone guard's escape and the camera's lens
 * guard all bottom out here, hundreds of times a frame.
 *
 * It earns its own file for what is coming rather than for its size. The
 * chain is a FALLBACK: the streamed fine window answers if it has the column,
 * and the coarse heightfield answers if it does not — and "does not have it"
 * is currently indistinguishable from "is air", which is the open fault
 * behind the deep-tunnel readings (`probe-lens` calls that column
 * `unmapped`). Fixing it means giving these methods an explicit
 * solid/air/unavailable answer, and that is a surgery worth doing in a file
 * that contains only the query.
 *
 * The four sources are PUBLIC FIELDS the scene writes as they arrive — the
 * window is created after the heightfield loads, the tree is planted later
 * still. Getters would have been tidier and this is the hottest path in the
 * frame; a field read is what it replaced and a field read is what it stays.
 */

import {
  CAP_PLANES, CELLS_Y, CELL_SIZE, MM,
} from '../world/worldScape';
import { MESH_N, N, STEP_MM } from './islandTuning';
import type { IslandStream } from '../world/IslandStream';
import type { BuiltTree } from '../world/tree';
import type { ForestSolid } from '../world/forest';

export class SoilQuery {
  /** The coarse island heightfield — the fallback, and the only thing that
   *  answers outside the streamed window. */
  heights: Int16Array | null = null;

  /** The carved fine window, once it exists. Authoritative where it reaches. */
  stream: IslandStream | null = null;

  /** The landmark tree and the scrub, unioned on top of the ground. */
  tree: BuiltTree | null = null;

  stand: ForestSolid | null = null;

  /** Height in mm (= real metres) at a data-grid index, clamped to edges. */
  sampleOf(data: Int16Array, col: number, row: number): number {
    const c = Math.min(N - 1, Math.max(0, col));
    const rw = Math.min(N - 1, Math.max(0, row));
    return data[rw * N + c]! / 10;
  }

  sample(col: number, row: number): number {
    return this.sampleOf(this.heights!, col, row);
  }

  /**
   * The surface the GPU actually draws, in mm, over a chosen grid: locate
   * the quad on the MESH grid, pick the triangle the way the index buffer
   * splits it (a–c–b / b–c–d, diagonal along fx+fz=1), interpolate that
   * plane. BE's terrainSampling rule; the walker sank without it.
   */
  renderedOn(data: Int16Array, xMm: number, zMm: number): number {
    const stride = (N - 1) / (MESH_N - 1);
    const stepMm = STEP_MM * stride;
    const gx = Math.min(MESH_N - 1.001, Math.max(0, xMm / stepMm));
    const gz = Math.min(MESH_N - 1.001, Math.max(0, zMm / stepMm));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const ha = this.sampleOf(data, i * stride, j * stride);
    const hb = this.sampleOf(data, (i + 1) * stride, j * stride);
    const hc = this.sampleOf(data, i * stride, (j + 1) * stride);
    const hd = this.sampleOf(data, (i + 1) * stride, (j + 1) * stride);
    return fx + fz <= 1
      ? ha + (hb - ha) * fx + (hc - ha) * fz
      : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
  }

  renderedGroundAt(x: number, z: number): number {
    if (!this.heights) return 0;
    return this.renderedOn(this.heights, x * MM, z * MM) / MM;
  }

  /** Where the ant may stand: the drawn land, or wading depth at the shore. */
  walkGroundAt(x: number, z: number): number {
    return Math.max(this.renderedGroundAt(x, z), 0.5 / MM);
  }

  /**
   * The first floor BELOW a height at this column, or null when the soil
   * has none to offer (out of window, or solid wall from there down). A
   * column the depth band cannot reach — steep country where the surface
   * climbs past the band's ceiling — caps flat at the ceiling, and standing
   * there must mean the drawn island, not the cap.
   */
  floorBelow(x: number, z: number, fromY: number): number | null {
    const stream = this.stream;
    if (!stream) return null;
    const fine = stream.surfaceBelowY(x, z, fromY);
    if (fine === null) return null;
    const ceiling = stream.bandFloorWu + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
    if (fine >= ceiling - CELL_SIZE) return Math.max(fine, this.walkGroundAt(x, z));
    return fine;
  }

  /**
   * HOW SOLID A WORLD POINT IS — positive in the soil, negative in the air,
   * zero at the drawn surface. The one question the walker asks, and it must
   * have an answer EVERYWHERE.
   *
   * Inside the streamed window that is the live field, dug tunnels and all.
   * Outside it there is no field, and a walker that loses its footing at the
   * window's edge drops her out of the world — so out there the island's own
   * heightfield answers the identical question in the identical form. It is
   * not an approximation: the window is FILLED from `surface(x, z) - y`, so
   * the fallback is the same expression the field was built out of, and the
   * two stitch together with no seam to fall through.
   */
  groundDensityAt(x: number, y: number, z: number): number {
    const fine = this.stream?.densityAtWu(x, y, z);
    if (fine !== null && fine !== undefined) return fine;
    return this.walkGroundAt(x, z) - y;
  }

  /**
   * IS this point in soil — the same question, asked the cheap way.
   *
   * Nearly every probe in the frame wants a yes or no: the walker's casts,
   * the leg solver's footing, the shovel's reach, the bone guard's escape.
   * Interpolating eight lattice samples to answer one of those is seven
   * reads of waste, and it is asked hundreds of times a frame — measured at
   * 0.033 µs against 0.094 for the smooth read. Only the surface NORMAL
   * genuinely needs what lies between the samples, and that is six probes.
   */
  groundSolidAt(x: number, y: number, z: number): boolean {
    const fine = this.stream?.solidAtWu(x, y, z);
    if (fine !== null && fine !== undefined) return fine;
    return this.walkGroundAt(x, z) - y > 0;
  }

  /**
   * THE GROUND, AND THE WOOD STANDING IN IT.
   *
   * The walker takes exactly one question — how solid is this point — and
   * turns the answer into standing, climbing, cornering and falling. So the
   * tree does not need a collision system of its own; it needs to be part of
   * this answer. Unioned in, she bumps into the trunk, walks round it and
   * CLIMBS it, entirely through the code that already carries her up the
   * wall of a shaft: her up comes off this field's gradient, and the
   * gradient of a trunk points out of the trunk.
   *
   * A union is the larger of the two, because both are positive inside.
   */
  densityAt(x: number, y: number, z: number): number {
    let best = this.groundDensityAt(x, y, z);
    const landmark = this.tree?.solid?.densityAt(x, y, z);
    if (landmark !== undefined && landmark > best) best = landmark;
    const scrub = this.stand?.densityAt(x, y, z);
    if (scrub !== undefined && scrub > best) best = scrub;
    return best;
  }

  solidAt(x: number, y: number, z: number): boolean {
    if (this.groundSolidAt(x, y, z)) return true;
    if (this.tree?.solid?.solidAt(x, y, z) === true) return true;
    return this.stand?.solidAt(x, y, z) === true;
  }
}
