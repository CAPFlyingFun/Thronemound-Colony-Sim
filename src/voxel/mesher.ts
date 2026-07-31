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
  /**
   * How full this cell is drawn, from 0 (exclusive) to 1. Optional; absent
   * means every cell is whole, which is what the world was before terrain
   * smoothing and what dug soil, glass and every test that does not care about
   * the surface still is.
   *
   * This is the ONLY thing the mesher knows about sub-voxel ground. It does not
   * know there is a height field, which is deliberate — the same hook draws a
   * half-height slab of anything, and the mesher cannot drift out of agreement
   * with a terrain module it has never heard of.
   */
  fill?(x: number, y: number, z: number): number;
  /**
   * Which way the ground faces at this cell, or null if it is not ground —
   * SHADING only.
   *
   * Optional, and it is the SAMPLER that decides which cells qualify rather
   * than the mesher inferring it from the fill. Those look like the same test
   * and are not: a column landing exactly on a voxel line has a full top cell
   * that is still surface, and dug soil can be part full without being surface
   * at all. Getting that boundary from the thing that owns the height field is
   * what keeps a cut face looking cut and a slope looking smooth.
   */
  slope?(x: number, y: number, z: number): readonly [number, number, number] | null;
  /**
   * World-Y height of the terrain surface at a lattice corner (cx, cz).
   * Optional; consulted ONLY for cells `slope` calls surface.
   *
   * This is what turns the staircase into ground. `fill` can only squash a
   * cell flat, so a slope was still a run of level treads — smaller steps, but
   * steps, and the silhouette showed it. Corners are SHARED: every surface
   * cell touching a lattice corner places its top vertex at this same height,
   * so neighbouring tops meet along their common edge exactly and the tread /
   * riser pair disappears into one continuous sheet.
   *
   * Clamped by the mesher to the cell's own [0,1] band, so the drawn surface
   * still cannot leave the cell that collision and the DDA raycast believe in.
   */
  cornerHeight?(cx: number, cz: number): number;
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
  /*
   * Fill is asked ONLY about cells that are already solid, and never by the
   * chamfer.
   *
   * That second half is the important one. Every convex-edge decision in this
   * file rests on both voxels sharing a vertex asking the same question of the
   * same pair of cells and therefore being unable to disagree — and "is my
   * neighbour shorter than me" is a question two neighbours ALWAYS answer
   * differently. Letting it near `openDir` would reopen the corner holes. So
   * fill moves vertices and decides one extra face, and touches nothing else.
   */
  const fillOf = world.fill
    ? (px: number, py: number, pz: number) => world.fill!(px, py, pz)
    : () => 1;

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

        /**
         * How tall this cell is drawn, and the one place it is applied.
         *
         * A pure scale in Y of everything this voxel emits — top face, the top
         * edges of its sides, its bevels and its corner triangles alike. The
         * shell stays the shell; it is just squashed. That is what lets the
         * chamfer code below stay untouched and still be watertight: an affine
         * map cannot open a hole in a surface that was already closed.
         *
         * Only ever a squash, never a stretch, so the drawn surface can only
         * recede INTO the cell — the same safety rule the dish and the chamfer
         * follow, and the reason collision can be brought along by shortening
         * the cell rather than by moving it.
         */
        const fy = fillOf(x, y, z);
        /*
         * Where this cell's top ACTUALLY sits, per lattice corner.
         *
         * Present only on surface cells of a sampler that offers corner
         * heights; everywhere else the cell keeps its flat fill line and the
         * mesher behaves exactly as before — which is what keeps every
         * existing caller and test byte-identical.
         *
         * Deliberately NOT clamped to the cell's own [0,1]. Every surface
         * cell touching a lattice corner reads the same field value there, so
         * unclamped tops tile into one continuous sheet even across columns
         * whose top CELLS differ — which is the whole point. Clamping was
         * tried first and it rebuilt the staircase exactly where it shows,
         * on slopes steep enough for a corner to leave its cell (~2% of
         * corners, all on the hill flank). Overshoot is safe: above the cell
         * the sheet rises into open air no other face claims, below it the
         * sheet sinks inside the solid cube underneath, and a cut face whose
         * strip inverts (top below its floor) turns inside-out and is culled
         * behind the sheet rather than drawn.
         */
        /*
         * The slope this cell sits on, or null if it is not surface.
         *
         * Computed once per voxel and used for the shading normal of every
         * outward face it has: the tread on top and the slivers of side wall
         * around it are all facets of one continuous surface, and giving them
         * one normal is what stops them reading as separate objects.
         */
        const slope = world.slope ? world.slope(x, y, z) : null;
        const ch = world.cornerHeight;
        let cf: readonly [number, number, number, number] | null = null;
        if (slope && ch) {
          const cfOf = (cx: number, cz: number) => ch(cx, cz) - y;
          cf = [cfOf(x, z), cfOf(x + 1, z), cfOf(x, z + 1), cfOf(x + 1, z + 1)];
        }
        /** Bilinear top height (as a fill) anywhere in the cell's plan. */
        const fillAt = (lx: number, lz: number): number => (cf
          ? (cf[0] * (1 - lx) + cf[1] * lx) * (1 - lz)
            + (cf[2] * (1 - lx) + cf[3] * lx) * lz
          : fy);
        /*
         * Per-vertex shading normal for the conforming sheet.
         *
         * The per-cell `slope` is one constant normal per cell, and the
         * triplanar projection weights in the material are a function of the
         * normal — so on the steep flank, where one cell's constant lands a
         * hair the other side of a blend threshold from its neighbour's, the
         * texture visibly changes projection at the cell border: crisp
         * smeared rectangles on an otherwise smooth hillside.
         *
         * The gradient here is taken at each lattice CORNER from the same
         * shared field the geometry uses — every cell touching a corner
         * computes the identical samples — then blended bilinearly, so the
         * shading normal is continuous across cell borders exactly like the
         * sheet itself.
         */
        let sheetNormal: ((lx: number, lz: number) => readonly [number, number, number]) | null = null;
        if (cf && ch) {
          const g = (cx: number, cz: number): readonly [number, number] => [
            (ch(cx + 1, cz) - ch(cx - 1, cz)) / 2,
            (ch(cx, cz + 1) - ch(cx, cz - 1)) / 2,
          ];
          const cg = [g(x, z), g(x + 1, z), g(x, z + 1), g(x + 1, z + 1)] as const;
          sheetNormal = (lx, lz) => {
            const gx = (cg[0][0] * (1 - lx) + cg[1][0] * lx) * (1 - lz)
              + (cg[2][0] * (1 - lx) + cg[3][0] * lx) * lz;
            const gz = (cg[0][1] * (1 - lx) + cg[1][1] * lx) * (1 - lz)
              + (cg[2][1] * (1 - lx) + cg[3][1] * lx) * lz;
            const len = Math.hypot(gx, 1, gz);
            return [-gx / len, 1 / len, -gz / len];
          };
        }
        /**
         * The one place vertical position is decided. `ly` scales between the
         * cell floor and its (possibly per-corner) top, so every face, bevel,
         * corner triangle and dish sample of this cell asks the same function
         * and cannot disagree — the same watertightness argument the old
         * uniform squash made, extended from an affine map to a bilinear one.
         */
        /*
         * Lattice height -> world height, with one wrinkle where the sheet
         * dips below the cell floor.
         *
         * With unclamped corners the sheet legitimately runs NEGATIVE near a
         * corner (the true surface passes through the cell underneath). A
         * plain `y + ly * fill` then DECREASES with ly, so any primitive
         * spanning two lattice heights at that plan point — side faces,
         * vertical-edge bevels — turns inside-out into a fin. Clamping just
         * those primitives at the floor (the previous fix) un-inverted them
         * but split them off the corner wedges and top bevels that still
         * followed the sheet, and the seam was an open slit you could shoot a
         * ray through.
         *
         * So the rule lives HERE, where every primitive gets the same answer
         * for the same lattice point: where the sheet is below the floor,
         * every lattice height collapses onto the sheet. Vertical primitives
         * degenerate to zero height exactly there (nothing to draw — the
         * surface is the sheet passing below), top primitives are unchanged
         * (ly = 1 always lands on the sheet), and any two primitives sharing
         * a lattice point still share a vertex, which is what watertight
         * means.
         */
        const liftAt = (lx: number, ly: number, lz: number) => {
          const f = fillAt(lx, lz);
          return y + (f < 0 ? f : ly * f);
        };

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
          if (isSolid(world.get(x + nx, y + ny, z + nz))) {
            /*
             * A solid neighbour normally hides this face completely. It does
             * not when the neighbour is SHORTER: the band between its top and
             * ours is open sky, and culling against it is what would show you
             * the inside of this cell — a black wedge along every join where
             * the ground drops.
             *
             * Only sideways. A solid cell above starts exactly at our top and
             * a solid cell below ends exactly at our bottom, whatever either is
             * filled to, so neither can leave a band.
             */
            const under = fillOf(x + nx, y + ny, z + nz);
            if (ny !== 0) continue;
            /*
             * When BOTH cells conform to shared corner heights, their tops
             * meet along this edge exactly — same lattice corners, same
             * heights, same clamp — so there is nothing for a band to cover,
             * and emitting one anyway would push a quad down inside the
             * neighbour's soil and flip every ray-parity probe through it.
             */
            const nbSlope = world.slope ? world.slope(x + nx, y, z + nz) : null;
            let floorFill = under;
            if (ch && nbSlope) {
              if (cf) continue;
              /*
               * WE are a cut face against a conforming neighbour: its drawn
               * top follows its corners, which can dip BELOW its column fill
               * on the downhill side — below even this cell's floor, since
               * corners are unclamped. The band has to reach the lowest
               * shared corner or the wall of our cell shows through the
               * wedge, so floorFill may legitimately go negative here.
               */
              for (const corner of face.corners) {
                if (corner[1] !== 1) continue;
                floorFill = Math.min(floorFill, ch(x + corner[0], z + corner[2]) - y);
              }
            }
            if (floorFill >= fy) continue;

            /*
             * Emitted plain: no chamfer inset, no dish, flat shading.
             *
             * Deliberately NOT run through the geometry below. Those insets are
             * decided from grid neighbours, which say this face does not exist,
             * so asking them where its corners go returns answers that do not
             * line up with the top face — a slit, exactly the kind this project
             * has already spent a session closing. A plain quad cannot leave
             * one. It can only overlap, and overlap here is hidden inside the
             * neighbour or a fraction of a millimetre of extra soil.
             */
            /*
             * Shaded as the SLOPE it stands for, not as the wall it is drawn
             * as — and that is not a nicety, it is the difference between smooth
             * ground and a black staircase.
             *
             * The band is how far the ground drops over one cell, so it is a
             * sub-millimetre sliver: 0.6 mm at the median. Give it the sideways
             * face normal and it lights like a wall, catching almost nothing
             * from a sun overhead. Harmless seen from above and ruinous from
             * where the ant actually stands — at 3.5 mm off the ground the
             * surface is so near edge-on that these slivers cover more screen
             * than the ground between them, and the first build of this drew
             * the plain as sand ruled with black gashes.
             *
             * Its normal is therefore the normal of the slope: down by `gap`
             * over one cell, in the face's own direction. On gentle ground that
             * is a couple of degrees off straight up, the band lights exactly
             * as the cells either side of it do, and the join disappears.
             */
            const gap = fy - floorFill;
            const slen = Math.hypot(gap, 1);
            // The field's own gradient where it is on offer, since then the
            // band and the treads either side share one normal exactly. The
            // fallback is this band's own drop over one cell, which is the same
            // quantity measured locally and keeps the mesher correct on its own.
            const bn = slope ?? [nx * gap / slen, 1 / slen, nz * gap / slen] as const;
            /*
             * Ground UVs too — world x and z, the convention the upward faces
             * use. Laying them the way a wall does would run one axis along the
             * band's own height, which is a fraction of a millimetre, and smear
             * a whole tile across it.
             */
            const raw: [number, number, number] = [1 - Math.abs(nx), 0, Math.abs(nx)];
            const btd = raw[0] * bn[0] + raw[2] * bn[2];
            const bt: [number, number, number] = [
              raw[0] - bn[0] * btd, -bn[1] * btd, raw[2] - bn[2] * btd,
            ];
            const btl = Math.hypot(bt[0], bt[1], bt[2]) || 1;
            const bandFirst = positions.length / 3;
            // Open ground, not a crease: bright, so it reads as the surface
            // carrying on rather than as a line drawn across it.
            const bandShade = AO_LEVELS[3]! * tint;
            /*
             * Down to the FLOOR of the cell, not down to the neighbour's fill
             * line — and this is the sky you could see through the hill.
             *
             * Starting the band where the neighbour stops sounds exact and is
             * wrong, because the neighbour's top is not flat: the chamfer cuts
             * it back along every convex edge it has, so near those edges its
             * real surface sits BELOW its fill line, by up to a chamfer of its
             * own height. The band began above that notch and the notch was
             * open to the sky — a slot on the low side of every step-up on the
             * hillside, which is exactly where they were reported.
             *
             * Following that notch exactly would mean this face asking about
             * another cell's convex edges — the coupling the chamfer design
             * exists to avoid, and the source of the corner holes before it.
             * But the notch has a floor: every chamfer cut is EDGE_CHAMFER of
             * the cell it belongs to, so the neighbour's surface can never fall
             * below that fraction of its own fill. Dropping the band to exactly
             * there covers the deepest notch the neighbour can have and asks
             * nothing about which edges it actually chamfered.
             *
             * The strip between there and the neighbour's fill line is buried
             * where the neighbour is whole and is the visible wall of the notch
             * where it is not, so it is right either way. Running the band all
             * the way to the cell floor would also close the hole, and was
             * tried: it puts a surface deep inside solid soil, which is
             * invisible but destroys the watertightness the tests rely on —
             * every parity probe through the hill flipped.
             */
            const notch = floorFill * (1 - EDGE_CHAMFER);
            /*
             * The band's top, per corner. `fillAt` (fy for a cell without
             * corners of its own) — except against a CONFORMING neighbour,
             * where the top is additionally capped at the shared corner
             * heights. A full interior cell whose column's surface sits one
             * cell up runs its flat top at fy while the neighbour's sheet
             * edge dips below it — the sheet crossing from the neighbour's
             * top into our surface cell above already seals that boundary,
             * and the uncapped band top was poking through it as a bright
             * smeared sliver on the flank. Capped, the band ends exactly on
             * the sheet edge and covers only what the sheet does not.
             */
            const bandTop = (lx: number, lz: number) => (
              ch && nbSlope
                ? Math.min(fillAt(lx, lz), ch(x + lx, z + lz) - y)
                : fillAt(lx, lz)
            );
            for (const corner of face.corners) {
              const wx = x + corner[0];
              const wy = y + (corner[1] === 1 ? bandTop(corner[0], corner[2]) : notch);
              const wz = z + corner[2];
              positions.push(wx, wy, wz);
              normals.push(bn[0], bn[1], bn[2]);
              layers.push(voxel);
              tangents.push(bt[0] / btl, bt[1] / btl, bt[2] / btl);
              uvs.push(wx / TILE_VOXELS, wz / TILE_VOXELS);
              colors.push(bandShade, bandShade, bandShade);
            }
            indices.push(
              bandFirst, bandFirst + 1, bandFirst + 2,
              bandFirst, bandFirst + 2, bandFirst + 3,
            );
            quadCount++;
            continue;
          }

          const [axisA, axisB] = tangentAxes(face.normal);
          const first = positions.length / 3;
          const ao: number[] = [];

          // Tangent points along axisA, which is exactly how UVs are laid out
          // below — so the normal map's +X lines up with the texture's +U.
          const tangent: [number, number, number] = [0, 0, 0];
          tangent[axisA] = 1;

          /*
           * A face of a part-full surface cell is a facet of the SLOPE.
           *
           * Which changes three things about it and none of them is geometry.
           * Its shading normal is the ground's, so the tread on top and the
           * sliver of side wall around it stop being lit as a terrace and a
           * retaining wall. Its uvs become the ground's — world x and z — since
           * a riser here is a fraction of a millimetre tall and laying a tile
           * along its height would smear one across it. And a sideways face
           * needs a HORIZONTAL tangent to go with a near-upright normal: the
           * usual one for a ±X face runs along Y, which is very nearly parallel
           * to it, and the shader's Gram-Schmidt step would be left normalising
           * something a hair away from a zero vector.
           */
          const facet = slope && ny >= 0 ? slope : null;
          if (facet && ny === 0) {
            tangent[0] = nx !== 0 ? 0 : 1;
            tangent[1] = 0;
            tangent[2] = nx !== 0 ? 1 : 0;
            const d = tangent[0] * facet[0] + tangent[2] * facet[2];
            tangent[0] -= facet[0] * d;
            tangent[1] = -facet[1] * d;
            tangent[2] -= facet[2] * d;
            const tl = Math.hypot(tangent[0], tangent[1], tangent[2]) || 1;
            tangent[0] /= tl; tangent[1] /= tl; tangent[2] /= tl;
          }

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
          /*
           * Open ground is never a cavity, however walled in the count says.
           *
           * The enclosure count is a good proxy for "am I inside a tunnel"
           * on a FLAT world and a bad one on a hillside: the air over a slope
           * has soil beneath it and soil on the two uphill sides, which is
           * three, which is a cavity as far as the count can tell. So the open
           * hill quietly started dishing its own surface — subdividing it and
           * bowing every face inward, with the analytic normals that go with a
           * curve, on faces that are not curved and are not in a tunnel.
           *
           * That is what the black slots across the hillside were. A dished
           * SIDE face has its normal free to swing in Y, and measured on the
           * flank it reached -0.52: pointing into the ground, lit by nothing,
           * so the step-ups read as gaps you could see through.
           *
           * The sampler already knows the answer — if it calls this cell part
           * of the terrain surface, the air on the other side is the sky.
           */
          const dish = enclosure >= CAVITY_ENCLOSURE && !slope ? CAVITY_DISH : 0;

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

            /*
             * A conforming cell's top is one continuous sheet with its
             * neighbours — the uphill column being a cell "taller" is not a
             * wall standing over this tread, it is the same surface carrying
             * on. Occupancy-based AO cannot tell the difference and paints a
             * dark crease along the uphill edge of every cell on the flank:
             * the staircase again, this time in light. The sheet is open
             * ground everywhere, so it takes the open-ground level.
             */
            ao.push(cf && ny === 1 ? 3 : aoLevel(sideA, sideB, diagonal));
          }

          if (dish === 0) {
            for (let ci = 0; ci < 4; ci++) {
              const drawn = inset[ci]!;
              const wx = x + drawn[0];
              // Where the sheet dips below the floor, liftAt itself collapses
              // every lattice height onto the sheet — side faces degenerate
              // there instead of inverting, and no per-face clamp is needed.
              const wy = liftAt(drawn[0], drawn[1], drawn[2]);
              const wz = z + drawn[2];
              positions.push(wx, wy, wz);
              if (sheetNormal && ny >= 0) {
                const sn = sheetNormal(drawn[0], drawn[2]);
                normals.push(sn[0], sn[1], sn[2]);
              } else if (facet) normals.push(facet[0], facet[1], facet[2]);
              else normals.push(nx, ny, nz);
              layers.push(voxel);
              tangents.push(tangent[0], tangent[1], tangent[2]);
              // World-space UVs: neighbouring voxels of one material read as a
              // single continuous surface, and one tile spans TILE_VOXELS.
              // Slope facets take the GROUND pair whichever way they face, so
              // the pattern runs across a riser instead of restarting on it.
              const w = [wx, wy, wz] as const;
              if (facet && ny === 0) uvs.push(wx / TILE_VOXELS, wz / TILE_VOXELS);
              else uvs.push(w[axisA]! / TILE_VOXELS, w[axisB]! / TILE_VOXELS);
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
                const dlx = lerp3(u, v, 0) - nx * back;
                const dly = lerp3(u, v, 1) - ny * back;
                const dlz = lerp3(u, v, 2) - nz * back;
                const wx = x + dlx;
                // liftAt handles below-floor sheets by itself; dished cells
                // are never conforming (dish requires !slope) so this is the
                // plain y + ly * fy path regardless.
                const wy = liftAt(dlx, dly, dlz);
                const wz = z + dlz;
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
                /*
                 * The rate the dish pulls back, in WORLD units.
                 *
                 * `liftAt` scales this cell's Y by its fill, so a dish of a given
                 * depth moves the surface by `dish * fy` along a Y-facing
                 * normal while these derivatives were written as though it
                 * moved by `dish`. Get that wrong and the shading follows a
                 * curve the geometry does not have — steeper than the truth by
                 * whatever the cell was squashed by. Cells that dish are whole
                 * today, so this is normally a multiply by one; it is here
                 * because "normally" is what stops being true later.
                 */
                const yScale = Math.abs(ny) > 0 ? fy : 1;
                const du = -dish * yScale * Math.PI
                  * Math.cos(Math.PI * u) * Math.sin(Math.PI * v);
                const dv = -dish * yScale * Math.PI
                  * Math.sin(Math.PI * u) * Math.cos(Math.PI * v);
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
            // Same rule as the top-face AO above: on a conforming cell the
            // "solid" diagonally uphill is the sheet itself, not a crease.
            const shade = AO_LEVELS[!cf && diag ? 2 : 3]! * tint;
            const [uAxis, vAxis] = tangentAxes(un[0] !== 0 && un[1] !== 0 && un[2] !== 0
              ? [1, 0, 0] : un);
            /*
             * The SHADING normal follows the squash; the geometric one above
             * does not.
             *
             * Everything `un` is used for otherwise — which diagonal to probe,
             * which way the winding came out, which axes are in plane — depends
             * only on the SIGNS of its components, and a positive scale in Y
             * leaves those alone. The lit direction does not: squash a bevel
             * and it turns to face further outward, by the inverse of the scale
             * on the axis that moved. Miss this and a shallow slab is lit as
             * though it were still a full cube.
             */
            /*
             * On the open surface, a bevel is ground too.
             *
             * Left to its own geometry a bevel on a VERTICAL convex edge comes
             * out horizontal — (-0.71, 0, -0.71) and the like — and the squash
             * above cannot help it, because scaling zero is zero. Point one of
             * those away from the sun and it is unlit: measured at -0.5 lambert
             * on the hill, which is black. Two hundred and twenty-seven of them
             * were scattered over the slope as little dark triangles.
             *
             * They are a millimetre and a half across and they are part of the
             * ground, so they light as the ground. Same rule as the faces they
             * sit between, which is what makes the whole cell read as one
             * surface rather than as a cube with its corners lit separately.
             */
            const sy = un[1] / fy;
            const slen = Math.hypot(un[0], sy, un[2]) || 1;
            const snx = slope ? slope[0] : un[0] / slen;
            const sny = slope ? slope[1] : sy / slen;
            const snz = slope ? slope[2] : un[2] / slen;
            const tan: [number, number, number] = [0, 0, 0];
            tan[uAxis] = 1;
            const tdot = tan[0] * snx + tan[1] * sny + tan[2] * snz;
            const tx = tan[0] - snx * tdot;
            const ty = tan[1] - sny * tdot;
            const tz = tan[2] - snz * tdot;
            const tlen = Math.hypot(tx, ty, tz) || 1;
            /*
             * Bevels on VERTICAL edges pinch at the floor exactly like the
             * side faces they sit between (see the face loop); everything
             * with any vertical reach — top-edge bevels, corner wedges —
             * follows the sheet unclamped so it stays attached to the top
             * face wherever that goes.
             */
            // No special case for vertical-edge bevels any more: liftAt
            // collapses below-floor sheets for every primitive alike, which
            // is exactly what keeps bevels, wedges and faces sharing vertices.
            const bevelLift = (p: readonly [number, number, number]) => (
              liftAt(p[0], p[1], p[2])
            );
            for (const p of pts) {
              positions.push(x + p[0], bevelLift(p), z + p[2]);
              // Bevels of a conforming cell are slivers of the sheet, so they
              // shade with the same continuous normal its faces use.
              if (sheetNormal) {
                const sn = sheetNormal(p[0], p[2]);
                normals.push(sn[0], sn[1], sn[2]);
              } else normals.push(snx, sny, snz);
              layers.push(voxel);
              tangents.push(tx / tlen, ty / tlen, tz / tlen);
              const w = [x + p[0], bevelLift(p), z + p[2]] as const;
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
