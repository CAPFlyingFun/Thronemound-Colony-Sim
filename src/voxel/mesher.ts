/**
 * Face-culling chunk mesher with per-vertex ambient occlusion.
 *
 * Emits plain typed arrays rather than three.js geometry, so it can be tested
 * headlessly and so the renderer stays a thin adapter over it. Only faces that
 * border AIR are emitted — a fully buried chunk produces nothing at all, which
 * is what keeps a solid world essentially free to draw.
 */

import { AIR, CHUNK, isSolid, materialOf, type VoxelId } from './VoxelWorld';
import { TILE_VOXELS } from './tileTextures';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /**
   * Texture coordinates in WORLD space divided by TILE_VOXELS, so the pattern
   * flows continuously across neighbouring voxels of the same material instead
   * of restarting on every cube face.
   */
  uvs: Float32Array;
  /** Texture-array layer per vertex; equals the voxel id. */
  layers: Float32Array;
  /** Face tangent (the +U direction), for tangent-space normal mapping. */
  tangents: Float32Array;
  indices: Uint32Array;
  quadCount: number;
}

interface Sampler {
  get(x: number, y: number, z: number): VoxelId;
}

type Vec3 = readonly [number, number, number];

interface Face {
  readonly normal: Vec3;
  /** Unit-cube corners in counter-clockwise order seen from outside. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
}

export const FACES: readonly Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

/**
 * How far a CAVITY wall dishes back into the soil at its middle.
 *
 * Carried over from the hex room, which is the one thing that room did better
 * than this one: bow the middle of each exposed face away from the air and a
 * dug pocket reads as a rounded socket instead of six flat panels meeting at
 * hard creases.
 *
 * A cube's own geometry says 0.207 — the gap between a square cross-section's
 * half-width and its corner — which would take a one-voxel bore out to 1.41
 * voxels round. Far too much: the drawn wall would sit visibly behind where
 * collision stops you. This rounds the creases off without the cavity
 * ballooning, and at 0.6 mm the gap between drawn and solid is not noticeable.
 *
 * ALWAYS into the soil, never toward the air. Targeting is a DDA raycast and
 * collision is axis-separated AABBs, both against the true grid — geometry in
 * front of that plane is rock you can walk your face through.
 */
export const CAVITY_DISH = 0.16;
/** Subdivisions per axis on a dished face. Nine quads instead of one. */
export const DISH_CELLS = 3;
/**
 * Solid neighbours the AIR side needs before its wall is treated as a cavity.
 *
 * This is what keeps the open plain flat. The air above open ground has one
 * solid neighbour beneath it and nothing else, so it never qualifies; the air
 * inside a tunnel is walled on four or five sides and always does. It also
 * means only the faces you actually look at underground pay the subdivision —
 * dishing the whole world would multiply every visible quad by nine.
 */
export const CAVITY_ENCLOSURE = 3;

/**
 * How far a CONVEX edge is cut back, making cells read as octagons.
 *
 * Slice the corners off a square by this fraction of its width and the square
 * becomes a regular octagon: 1/(2+sqrt2) = 0.2929, which leaves the four
 * original sides and the four new diagonals exactly equal. Do it to all twelve
 * edges and eight corners of a cube and you get a rhombicuboctahedron — 6
 * squares, 12 bevels, 8 triangles — which reads as round from every direction
 * rather than only sideways. An octagon fills 90% of its circumscribed circle
 * against a hexagon's 83%, which is the whole reason to prefer eight sides.
 *
 * Cuts material AWAY, so the drawn surface only ever recedes into the soil, the
 * same safety rule dishing follows: never draw geometry in front of where the
 * DDA raycast and the AABB collision think the solid is.
 *
 * CONVEX edges only — outside corners, where two exposed faces of the SAME
 * voxel meet. A tunnel's interior creases are CONCAVE and formed by two
 * DIFFERENT voxels, so they are untouched by this and remain the dish's job.
 * That boundary is what keeps this watertight and per-voxel local.
 */
export const EDGE_CHAMFER = 0.2929;

/** Brightness multiplier per AO level, darkest (fully enclosed corner) first. */
const AO_LEVELS = [0.45, 0.62, 0.8, 1.0] as const;

/**
 * How dark something sitting in a hollow should be, from how walled in it is.
 *
 * Exported because LOOSE soil needs it too and had none: the terrain gets real
 * per-vertex AO here and the chip visual has its own burial term, but a pellet
 * lying in a tunnel was drawn at plain material brightness. It was the one
 * thing in the frame lit from nowhere, which is what made spoil look pasted on
 * rather than dropped.
 *
 * Bottoms out at the SAME value as the darkest AO level, so a pellet and the
 * wall behind it reach the floor together instead of one going darker.
 */
export function burialShade(solidNeighbours: number): number {
  const t = Math.max(0, Math.min(1, solidNeighbours / FACES.length));
  return 1 - t * (1 - AO_LEVELS[0]!);
}

/** FACES index for an axis and sign. Mirrors the table's +X,-X,+Y,-Y,+Z,-Z order. */
function faceIndex(axis: number, sign: number): number {
  return axis * 2 + (sign > 0 ? 0 : 1);
}

/** Cheap deterministic per-voxel jitter so soil reads as grain, not plastic. */
export function voxelTint(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  return 0.88 + (h % 1000) / 1000 * 0.24;
}

/**
 * Classic voxel AO: a vertex darkens with how many of the three neighbouring
 * voxels touching that corner are solid. Two opposite sides both solid is the
 * darkest case regardless of the corner.
 */
function aoLevel(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

/** Axis indices other than the face's own axis. */
/** Shared with the fracture mesh, so both lay UVs out the same way. */
export function tangentAxes(normal: Vec3): [number, number] {
  if (normal[0] !== 0) return [1, 2];
  if (normal[1] !== 0) return [0, 2];
  return [0, 1];
}

export function meshChunk(
  world: Sampler,
  chunkX: number,
  chunkY: number,
  chunkZ: number,
): MeshData | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const layers: number[] = [];
  const tangents: number[] = [];
  const indices: number[] = [];
  let quadCount = 0;

  const baseX = chunkX * CHUNK;
  const baseY = chunkY * CHUNK;
  const baseZ = chunkZ * CHUNK;

  const offset = [0, 0, 0];
  const sample = (px: number, py: number, pz: number) => isSolid(world.get(px, py, pz));

  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = baseX + lx;
        const y = baseY + ly;
        const z = baseZ + lz;
        const voxel = world.get(x, y, z);
        if (voxel === AIR) continue;

        // Per-voxel brightness jitter breaks up large same-material faces. The
        // base colour now comes from the texture array, so vertex colour
        // carries only shading (AO x jitter) and multiplies over the albedo.
        const tint = voxelTint(x, y, z);

        /*
         * Which of the six neighbours are air, computed once per voxel.
         *
         * The face loop needs it anyway, and the chamfer needs it for the four
         * IN-PLANE directions of every face — an edge is convex exactly when
         * the neighbour beyond it is air, because that is when the adjoining
         * face is also being drawn. Six samples replace up to twenty-four.
         */
        const open: boolean[] = [];
        for (const probe of FACES) {
          open.push(!sample(x + probe.normal[0], y + probe.normal[1], z + probe.normal[2]));
        }
        const openDir = (axis: number, sign: number) => open[faceIndex(axis, sign)]!;
        /*
         * How far a face pulls its corner in, decided at the LATTICE VERTEX.
         *
         * Two rules had to be thrown out before this one. Deciding per EDGE
         * tore holes: at a pit corner three top faces meet, the two bordering
         * the pit each pulled their corner in, the diagonal one did not, and
         * you saw sky through the wedge between them. Deciding per VERTEX with
         * "all three faces open" closed the holes but chamfered almost nothing
         * — a tunnel rim has only two faces open, so every rim stayed square.
         *
         * The question that actually works is whether the convex edge CONTINUES
         * past this vertex: does the next voxel along it have the same two faces
         * open? Both voxels sharing that vertex ask about the same pair of
         * voxels and the same pair of faces, so they cannot disagree, and a run
         * of rim gets cut along its length and tapers to nothing at its ends —
         * which is what a chamfered edge looks like.
         */
        const solidAt = (a: number, sa: number, b = -1, sb = 0, c = -1, sc = 0) => {
          const p = [x, y, z];
          p[a] = p[a]! + sa;
          if (b >= 0) p[b] = p[b]! + sb;
          if (c >= 0) p[c] = p[c]! + sc;
          return sample(p[0]!, p[1]!, p[2]!);
        };
        /** Does the neighbour past this vertex carry the same convex edge on? */
        const edgeRuns = (
          na: number, ns: number,
          f1a: number, f1s: number,
          f2a: number, f2s: number,
        ) => solidAt(na, ns)
          && !solidAt(na, ns, f1a, f1s)
          && !solidAt(na, ns, f2a, f2s);
        /**
         * The cut face (fa,fs) applies along `ta` at the corner (ta:sa, tb:sb).
         * Zero unless that edge is convex AND supported at this end — either by
         * a third open face (a convex corner, which the corner triangle closes)
         * or by the edge running on into the neighbour.
         */
        const cutAlong = (
          fa: number, fs: number,
          ta: number, sa: number,
          tb: number, sb: number,
        ) => {
          if (!openDir(ta, sa)) return 0;
          if (openDir(tb, sb) || edgeRuns(tb, sb, fa, fs, ta, sa)) return EDGE_CHAMFER;
          return 0;
        };

        for (const face of FACES) {
          const [nx, ny, nz] = face.normal;
          if (isSolid(world.get(x + nx, y + ny, z + nz))) continue;

          const [axisA, axisB] = tangentAxes(face.normal);
          const first = positions.length / 3;
          const ao: number[] = [];

          // Tangent points along axisA, which is exactly how UVs are laid out
          // below — so the normal map's +X lines up with the texture's +U.
          const tangent: [number, number, number] = [0, 0, 0];
          tangent[axisA] = 1;

          /*
           * Is the air on the other side a CAVITY, or open sky?
           *
           * Counted on the AIR voxel, not this one: a tunnel's air is walled on
           * most sides, open ground's air has only the floor under it. Cheap —
           * six samples, and only for faces that are actually emitted.
           */
          let enclosure = 0;
          for (const probe of FACES) {
            if (sample(
              x + nx + probe.normal[0],
              y + ny + probe.normal[1],
              z + nz + probe.normal[2],
            )) enclosure++;
          }
          const dish = enclosure >= CAVITY_ENCLOSURE ? CAVITY_DISH : 0;

          /*
           * A corner moves only if its cube VERTEX is cut, and then it moves in
           * BOTH in-plane axes at once. The bevels and corner triangles below
           * ask the same question of the same vertex, so the point this lands on
           * is byte-for-byte the point they start from — which is what makes the
           * surface watertight rather than a mesh full of slits and wedges.
           */
          const nAxis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
          const nSign = nx || ny || nz;
          const insetCorner = (corner: Vec3): [number, number, number] => {
            const p: [number, number, number] = [corner[0], corner[1], corner[2]];
            const ia = corner[axisA] === 1 ? 1 : -1;
            const ib = corner[axisB] === 1 ? 1 : -1;
            p[axisA] = p[axisA]! - ia * cutAlong(nAxis, nSign, axisA, ia, axisB, ib);
            p[axisB] = p[axisB]! - ib * cutAlong(nAxis, nSign, axisB, ib, axisA, ia);
            return p;
          };
          const inset = face.corners.map(insetCorner) as [
            [number, number, number], [number, number, number],
            [number, number, number], [number, number, number],
          ];

          /*
           * AO first, vertices second.
           *
           * A dished face never uses these four corner vertices — it pushes its
           * own subdivided grid and the corners are left orphaned in the buffer.
           * That was 4 dead vertices on every dished face, which is most of the
           * underground surface, and it also makes the buffer impossible to
           * reason about from outside. So compute the shading here and push
           * geometry only in the branch that actually draws it.
           */
          for (let ci = 0; ci < 4; ci++) {
            const corner = face.corners[ci]!;

            // Corner components are 0/1; map to -1/+1 offsets in the face plane.
            const da = corner[axisA] === 1 ? 1 : -1;
            const db = corner[axisB] === 1 ? 1 : -1;

            offset[0] = x + nx; offset[1] = y + ny; offset[2] = z + nz;
            const sideA = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisA] = p[axisA]! + da;
              return sample(p[0]!, p[1]!, p[2]!);
            })();
            const sideB = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisB] = p[axisB]! + db;
              return sample(p[0]!, p[1]!, p[2]!);
            })();
            const diagonal = (() => {
              const p = [offset[0]!, offset[1]!, offset[2]!];
              p[axisA] = p[axisA]! + da;
              p[axisB] = p[axisB]! + db;
              return sample(p[0]!, p[1]!, p[2]!);
            })();

            ao.push(aoLevel(sideA, sideB, diagonal));
          }

          if (dish === 0) {
            for (let ci = 0; ci < 4; ci++) {
              const drawn = inset[ci]!;
              const wx = x + drawn[0];
              const wy = y + drawn[1];
              const wz = z + drawn[2];
              positions.push(wx, wy, wz);
              normals.push(nx, ny, nz);
              layers.push(voxel);
              tangents.push(tangent[0], tangent[1], tangent[2]);
              // World-space UVs: neighbouring voxels of one material read as a
              // single continuous surface, and one tile spans TILE_VOXELS.
              const w = [wx, wy, wz] as const;
              uvs.push(w[axisA]! / TILE_VOXELS, w[axisB]! / TILE_VOXELS);
              const shade = AO_LEVELS[ao[ci]!]! * tint;
              colors.push(shade, shade, shade);
            }
          } else {
            /*
             * Subdivide and bow the middle in.
             *
             * The dish falls to zero along every edge of the INSET quad, so the
             * face still meets its own bevels vertex for vertex. Carrying it
             * into the edges would inset this face from its neighbours a second
             * time and open a hairline slit at every corner of every tunnel,
             * which you can see straight through.
             *
             * Interior samples are bilinear across the quad: position, UV and
             * AO alike, so the shading follows the geometry rather than being
             * recomputed per sample against neighbours that have not changed.
             */
            // The INSET corners, so a dished face and its bevels share edges.
            const c = inset;
            const lerp3 = (u: number, v: number, axis: number) => (
              (c[0][axis]! * (1 - u) + c[1][axis]! * u) * (1 - v)
              + (c[3][axis]! * (1 - u) + c[2][axis]! * u) * v
            );
            const aoAt = (u: number, v: number) => (
              (ao[0]! * (1 - u) + ao[1]! * u) * (1 - v)
              + (ao[3]! * (1 - u) + ao[2]! * u) * v
            );
            /*
             * The quad's own edge vectors, for the surface tangents below.
             * Taken from the corners rather than from the axis indices, because
             * some faces traverse their in-plane axes backwards and the sign
             * matters for the cross product.
             */
            const dU = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
            const dV = [c[3][0] - c[0][0], c[3][1] - c[0][1], c[3][2] - c[0][2]];
            const gridFirst = positions.length / 3;
            for (let iv = 0; iv <= DISH_CELLS; iv++) {
              for (let iu = 0; iu <= DISH_CELLS; iu++) {
                const u = iu / DISH_CELLS;
                const v = iv / DISH_CELLS;
                // Zero on every edge, full at the middle. Backwards along the
                // normal, so the wall recedes into the soil and never toward
                // the player.
                const back = dish * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
                const wx = x + lerp3(u, v, 0) - nx * back;
                const wy = y + lerp3(u, v, 1) - ny * back;
                const wz = z + lerp3(u, v, 2) - nz * back;
                positions.push(wx, wy, wz);

                /*
                 * Normals have to FOLLOW the dish, or none of it is visible.
                 *
                 * This is the bug that made the whole thing look like it had
                 * not been applied: every subdivided vertex kept the flat face
                 * normal, so the geometry curved while the shading stayed
                 * uniform — and a wall seen face-on is nothing BUT its shading.
                 * The silhouette bent, which you can only notice at a grazing
                 * angle, and the surface read exactly as square as before.
                 *
                 * Differentiating the displacement analytically: the surface is
                 * the flat quad minus n * dish * sin(pi u) * sin(pi v), so each
                 * tangent picks up a term along the normal.
                 */
                const du = -dish * Math.PI * Math.cos(Math.PI * u) * Math.sin(Math.PI * v);
                const dv = -dish * Math.PI * Math.sin(Math.PI * u) * Math.cos(Math.PI * v);
                const tu = [dU[0]! - nx * du, dU[1]! - ny * du, dU[2]! - nz * du];
                const tv = [dV[0]! - nx * dv, dV[1]! - ny * dv, dV[2]! - nz * dv];
                let cx2 = tu[1]! * tv[2]! - tu[2]! * tv[1]!;
                let cy2 = tu[2]! * tv[0]! - tu[0]! * tv[2]!;
                let cz2 = tu[0]! * tv[1]! - tu[1]! * tv[0]!;
                // Point it the same way the face does; corner winding decides
                // which way the cross product came out.
                if (cx2 * nx + cy2 * ny + cz2 * nz < 0) {
                  cx2 = -cx2; cy2 = -cy2; cz2 = -cz2;
                }
                const len = Math.hypot(cx2, cy2, cz2) || 1;
                const rx = cx2 / len;
                const ry = cy2 / len;
                const rz = cz2 / len;
                normals.push(rx, ry, rz);
                layers.push(voxel);
                /*
                 * Tangent re-orthogonalised against the DISHED normal.
                 *
                 * Tangent-space normal mapping assumes the tangent is
                 * perpendicular to the shading normal. Once the normal follows
                 * the curve, the flat face tangent no longer is, and every
                 * normal-mapped detail on a dished wall is lit off a skewed
                 * basis. One Gram-Schmidt step fixes it.
                 */
                const tdot = tangent[0] * rx + tangent[1] * ry + tangent[2] * rz;
                const ox = tangent[0] - rx * tdot;
                const oy = tangent[1] - ry * tdot;
                const oz = tangent[2] - rz * tdot;
                const olen = Math.hypot(ox, oy, oz) || 1;
                tangents.push(ox / olen, oy / olen, oz / olen);
                const w = [wx, wy, wz] as const;
                uvs.push(w[axisA]! / TILE_VOXELS, w[axisB]! / TILE_VOXELS);
                const shade = AO_LEVELS[Math.round(aoAt(u, v))]! * tint;
                colors.push(shade, shade, shade);
              }
            }
            const stride = DISH_CELLS + 1;
            for (let iv = 0; iv < DISH_CELLS; iv++) {
              for (let iu = 0; iu < DISH_CELLS; iu++) {
                const a = gridFirst + iv * stride + iu;
                indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride);
                quadCount++;
              }
            }
            continue;
          }

          // Flip the split so the darker corner pair shares the seam; without
          // this, AO gradients crease diagonally across the quad.
          const flip = ao[0]! + ao[2]! > ao[1]! + ao[3]!;
          if (flip) {
            indices.push(first + 1, first + 2, first + 3, first + 1, first + 3, first);
          } else {
            indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
          }
          quadCount++;
        }

        /*
         * The chamfer geometry: one bevel per convex EDGE, one triangle per
         * convex CORNER.
         *
         * A flat wall has a single exposed face, so no pair of faces is open
         * and none of this runs — flat surfaces cost exactly what they cost
         * before this existed. The price tracks how convoluted the surface is,
         * which is the right thing for it to track. A fully exposed voxel is
         * the worst case at 6 + 12 + 8 = 26 primitives.
         */
        if (EDGE_CHAMFER > 0) {
          const lo = EDGE_CHAMFER;
          const hi = 1 - EDGE_CHAMFER;
          /** Face-plane coordinate: the cube's own side. */
          const at = (sign: number) => (sign > 0 ? 1 : 0);
          /** Cut-back coordinate: one chamfer in from that side. */
          const back = (sign: number) => (sign > 0 ? hi : lo);

          /*
           * Emit with the winding that matches an outward normal.
           *
           * Determined from the cross product rather than asserted, because the
           * FACES table traverses some faces' in-plane axes backwards and
           * getting this wrong is the exact bug that made the hex room's walls
           * invisible from inside the room.
           */
          const emit = (pts: readonly [number, number, number][], n: Vec3) => {
            const base = positions.length / 3;
            const nlen = Math.hypot(n[0], n[1], n[2]) || 1;
            const un: Vec3 = [n[0] / nlen, n[1] / nlen, n[2] / nlen];
            // Chamfer faces sit on convex edges, so nothing local occludes
            // them — unless the voxel diagonally across is solid, which puts
            // the edge in a crease after all.
            const diag = sample(
              x + (un[0] > 0 ? 1 : un[0] < 0 ? -1 : 0),
              y + (un[1] > 0 ? 1 : un[1] < 0 ? -1 : 0),
              z + (un[2] > 0 ? 1 : un[2] < 0 ? -1 : 0),
            );
            const shade = AO_LEVELS[diag ? 2 : 3]! * tint;
            const [uAxis, vAxis] = tangentAxes(un[0] !== 0 && un[1] !== 0 && un[2] !== 0
              ? [1, 0, 0] : un);
            const tan: [number, number, number] = [0, 0, 0];
            tan[uAxis] = 1;
            const tdot = tan[0] * un[0] + tan[1] * un[1] + tan[2] * un[2];
            const tx = tan[0] - un[0] * tdot;
            const ty = tan[1] - un[1] * tdot;
            const tz = tan[2] - un[2] * tdot;
            const tlen = Math.hypot(tx, ty, tz) || 1;
            for (const p of pts) {
              positions.push(x + p[0], y + p[1], z + p[2]);
              normals.push(un[0], un[1], un[2]);
              layers.push(voxel);
              tangents.push(tx / tlen, ty / tlen, tz / tlen);
              const w = [x + p[0], y + p[1], z + p[2]] as const;
              uvs.push(w[uAxis]! / TILE_VOXELS, w[vAxis]! / TILE_VOXELS);
              colors.push(shade, shade, shade);
            }
            // Winding from the first triangle; flip the whole fan if it faces in.
            const e1 = [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1], pts[1]![2] - pts[0]![2]];
            const e2 = [pts[2]![0] - pts[0]![0], pts[2]![1] - pts[0]![1], pts[2]![2] - pts[0]![2]];
            const facing = (e1[1]! * e2[2]! - e1[2]! * e2[1]!) * un[0]
              + (e1[2]! * e2[0]! - e1[0]! * e2[2]!) * un[1]
              + (e1[0]! * e2[1]! - e1[1]! * e2[0]!) * un[2];
            for (let i = 1; i + 1 < pts.length; i++) {
              if (facing >= 0) indices.push(base, base + i, base + i + 1);
              else indices.push(base, base + i + 1, base + i);
            }
            quadCount++;
          };

          /*
           * One bevel per convex edge that has at least one cut end. af < ag
           * visits each perpendicular pair once, so no edge is emitted twice.
           *
           * Where the edge runs on into solid soil its end is NOT cut, and the
           * bevel has to taper to a point on the lattice rather than stop with a
           * square end — a square end leaves the two faces diverging from a
           * corner they no longer share, which is a wedge-shaped hole. Tapered,
           * the bevel is a triangle and both faces run into its far vertex.
           */
          for (let af = 0; af < 3; af++) {
            for (const sf of [1, -1] as const) {
              if (!openDir(af, sf)) continue;
              for (let ag = af + 1; ag < 3; ag++) {
                for (const sg of [1, -1] as const) {
                  if (!openDir(ag, sg)) continue;
                  const ac = 3 - af - ag;
                  // Both faces are open here, so the cut along ac is simply
                  // whether the ac face is open, and the cut ACROSS the edge is
                  // whether the edge is supported at that end.
                  const across = (sc: number) => (
                    openDir(ac, sc) || edgeRuns(ac, sc, af, sf, ag, sg) ? EDGE_CHAMFER : 0
                  );
                  const mLo = across(-1);
                  const mHi = across(1);
                  if (mLo === 0 && mHi === 0) continue;
                  const endAt = (sc: number) => (
                    sc > 0 ? 1 - (openDir(ac, sc) ? EDGE_CHAMFER : 0)
                      : (openDir(ac, sc) ? EDGE_CHAMFER : 0)
                  );
                  /** On face f's plane, cut back toward g by `m`. */
                  const onF = (sc: number, m: number) => {
                    const p: [number, number, number] = [0, 0, 0];
                    p[af] = at(sf); p[ag] = at(sg) - sg * m; p[ac] = endAt(sc);
                    return p;
                  };
                  /** On face g's plane, cut back toward f by `m`. */
                  const onG = (sc: number, m: number) => {
                    const p: [number, number, number] = [0, 0, 0];
                    p[af] = at(sf) - sf * m; p[ag] = at(sg); p[ac] = endAt(sc);
                    return p;
                  };
                  /** The untouched lattice vertex both faces still share. */
                  const corner = (sc: number) => {
                    const p: [number, number, number] = [0, 0, 0];
                    p[af] = at(sf); p[ag] = at(sg); p[ac] = endAt(sc);
                    return p;
                  };
                  const n: [number, number, number] = [0, 0, 0];
                  n[af] = sf;
                  n[ag] = sg;
                  if (mLo > 0 && mHi > 0) {
                    emit([onF(-1, mLo), onF(1, mHi), onG(1, mHi), onG(-1, mLo)], n);
                  } else if (mLo > 0) {
                    // The edge dies here: taper to the lattice vertex, or the
                    // two faces diverge from a corner they no longer share.
                    emit([onF(-1, mLo), corner(1), onG(-1, mLo)], n);
                  } else {
                    emit([onF(1, mHi), onG(1, mHi), corner(-1)], n);
                  }
                }
              }
            }
          }

          // One triangle per cut vertex, closing the three bevels that meet
          // there. Its corners are the bevels' own end points, exactly.
          for (const sx of [1, -1] as const) {
            for (const sy of [1, -1] as const) {
              for (const sz of [1, -1] as const) {
                if (!openDir(0, sx) || !openDir(1, sy) || !openDir(2, sz)) continue;
                emit(
                  [
                    [at(sx), back(sy), back(sz)],
                    [back(sx), at(sy), back(sz)],
                    [back(sx), back(sy), at(sz)],
                  ],
                  [sx, sy, sz],
                );
              }
            }
          }
        }
      }
    }
  }

  if (quadCount === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    layers: new Float32Array(layers),
    tangents: new Float32Array(tangents),
    indices: new Uint32Array(indices),
    quadCount,
  };
}
