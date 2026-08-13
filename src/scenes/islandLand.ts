/**
 * THE ISLAND ITSELF — the ground she stands on, and the plants standing
 * on it with her.
 *
 * Two subjects that turn out to be one: the forest's stands are grown from
 * the same heightfield the island's mesh is built from, and every "how high
 * is the ground here" answer has to agree with both or her feet float. So
 * `footingAt` and `boreFrame` — the surface the legs actually reach for —
 * live here beside the thing that made the surface.
 *
 * A narrow seam by the standards of this split: eighteen members for three
 * hundred lines. See `islandCamera.ts` for why these are free functions
 * over a host interface.
 */
import * as THREE from 'three';
import type { SoilQuery } from './soilQuery';
import {
  SPECIES, burialMm, plantsIn, solidStand,
  type ForestSolid, type Species,
} from '../world/forest';
import {
  bakeTree, sidesAt, trunkProfile, type TreeSpec, type TrunkProfile,
} from '../world/tree';
import { MM } from '../world/worldScape';
import {
  BODY_FLOOR_MARGIN, BODY_HALF_TALL, N, SCRUB_REGROW_MM, SCRUB_WINDOW_MM,
  MESH_N, SECTIONS, SEC_VERTS, SPAN_MM, STAND_REACH_MM, STEP_MM,
  S_MAT, S_UP,
} from './islandTuning';

/** What the land and the forest may reach, and nothing else. */
export interface LandHost {
  readonly scene: THREE.Scene;
  readonly at: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly ground: SoilQuery;
  readonly stands: Map<string, THREE.InstancedMesh>;
  readonly standProfiles: Map<string, TrunkProfile>;
  readonly scrubAt: THREE.Vector3;
  heights: Int16Array | null;
  stand: ForestSolid | null;
  forestMaterial: THREE.MeshStandardMaterial | null;
  islandMaterial: THREE.MeshStandardMaterial | null;
  terrainVerts: number;
  terrainTris: number;

  /* --- the soil, asked the scene's way so the cache is shared --- */
  sample(col: number, row: number): number;
  renderedGroundAt(x: number, z: number): number;
  walkGroundAt(x: number, z: number): number;
  floorBelow(x: number, z: number, fromY: number): number | null;
  soilSolidAt(x: number, y: number, z: number): boolean;
}


/* -------------------------------------------------------- the forest */

/**
 * The ground, as the scatter needs to see it: how high and how level.
 *
 * Read off the DRAWN island rather than the streamed soil, because the
 * scatter covers the whole map and the soil window is a hundred and
 * ninety millimetres wide. A plant a metre out would otherwise have no
 * ground to stand on.
 */
export function forestGround(host: LandHost, xMm: number, zMm: number): { elevMm: number; flat: number } | null {
  if (!host.heights) return null;
  const x = xMm / MM;
  const z = zMm / MM;
  const elevMm = host.renderedGroundAt(x, z) * MM;
  if (elevMm <= 0) return null;
  const d = STEP_MM / MM;
  const dhx = (host.renderedGroundAt(x + d, z) - host.renderedGroundAt(x - d, z)) / (2 * d);
  const dhz = (host.renderedGroundAt(x, z + d) - host.renderedGroundAt(x, z - d)) / (2 * d);
  return { elevMm, flat: 1 / Math.hypot(dhx, 1, dhz) };
}

/**
 * Grow one tier and hand it to the GPU as a single instanced mesh.
 *
 * Every plant in a tier shares one baked geometry, which is what makes
 * three thousand bushes one draw call rather than three thousand. They
 * differ by their MATRIX — where, how big, which way round — and by
 * nothing else, so the tier's shape is one tree's shape at many sizes.
 * At a bush's size on screen that reads as variety; at a landmark's it
 * would not, which is why the landmarks are real trees and not instances.
 */
export function growStand(host: LandHost, species: Species, box: {
  x0: number; z0: number; x1: number; z1: number;
}): void {
  const plants = plantsIn(species, box, (x, z) => forestGround(host, x, z));
  let mesh = host.stands.get(species.name) ?? null;
  if (!mesh || mesh.count < plants.length || mesh.instanceMatrix.count < plants.length) {
    if (mesh) {
      host.scene.remove(mesh);
      mesh.dispose();
    }
    /*
     * A baked plant is one unit tall and one unit through, so the matrix
     * carries the whole of its size. Building it at the tier's MIDDLE
     * height keeps the taper and the branching honest for the sizes it
     * will actually be stretched to.
     */
    const mid = (species.minHeight + species.maxHeight) * 0.5 / MM;
    const spec: TreeSpec = {
      girth: mid * species.girthOfHeight,
      height: mid,
      seed: 0x5eed ^ species.name.length,
      rings: species.rings,
      boughs: species.boughs,
      twigs: species.twigs,
    };
    const geo = bakeTree(spec, species.detail);
    geo.scale(1 / mid, 1 / mid, 1 / mid);
    /* The SAME spec gives the collision its line, so the two can never be
     * describing different trees. */
    /* At the tier's OWN tessellation: a bush is baked with four sides and
     * is 41% wider at its corners than the stem it was grown from, so a
     * profile taken off the circle describes a plant she can stand
     * inside. */
    host.standProfiles.set(species.name, trunkProfile(spec, sidesAt(species.detail)));
    /* Room for growth, so an ordinary step does not rebuild the buffer. */
    const room = Math.max(16, Math.ceil(plants.length * 1.4));
    mesh = new THREE.InstancedMesh(geo, host.forestMaterial!, room);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    host.scene.add(mesh);
    host.stands.set(species.name, mesh);
  }
  const m = S_MAT;
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const at = new THREE.Vector3();
  for (let i = 0; i < plants.length; i += 1) {
    const p = plants[i]!;
    const h = p.heightMm / MM;
    at.set(p.xMm / MM, (p.groundMm - burialMm(p.heightMm)) / MM, p.zMm / MM);
    q.setFromAxisAngle(S_UP.set(0, 1, 0), p.spin);
    /*
     * UNIFORM. The bake is already the right shape — it was grown at the
     * tier's own girth-to-height ratio and then divided down to one unit
     * tall, so its width is that ratio and nothing more is owed. Putting
     * the ratio on again here multiplied it by itself and turned every
     * plant on the island into a needle a few millimetres through.
     */
    scale.setScalar(h);
    m.compose(at, q, scale);
    mesh.setMatrixAt(i, m);
  }
  mesh.count = plants.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
}

/**
 * Plant the island: the big tiers once, the small ones around her.
 *
 * The split is a measurement, not a preference. Landmarks and canopy come
 * to about a hundred and forty over the whole map and cost nothing to
 * hold; saplings and bushes run past three thousand, and three thousand
 * of anything is worth generating only where she can see it.
 */
export function growForest(host: LandHost, ): void {
  if (!host.forestMaterial) return;
  const span = SPAN_MM;
  for (const species of SPECIES) {
    if (species.spacing >= 3000) {
      growStand(host, species, { x0: 0, z0: 0, x1: span, z1: span });
    }
  }
  regrowScrub(host, true);
}

/** The small tiers, kept in a window that follows her. */
export function regrowScrub(host: LandHost, force = false): void {
  if (!host.forestMaterial) return;
  if (!force && host.scrubAt.distanceTo(host.at) * MM < SCRUB_REGROW_MM) return;
  host.scrubAt.copy(host.at);
  const cx = host.at.x * MM;
  const cz = host.at.z * MM;
  const r = SCRUB_WINDOW_MM;
  for (const species of SPECIES) {
    if (species.spacing >= 3000) continue;
    growStand(host, species, {
      x0: Math.max(0, cx - r), z0: Math.max(0, cz - r),
      x1: Math.min(SPAN_MM, cx + r), z1: Math.min(SPAN_MM, cz + r),
    });
  }
  /*
   * And the SOLID stand, on a much tighter radius. Drawing a plant she can
   * see and colliding with one she can reach are different questions with
   * very different budgets: the field is probed hundreds of times a frame,
   * so what it holds is only what she could walk into before the next
   * regrow.
   */
  host.stand = solidStand(
    { xMm: cx, zMm: cz }, STAND_REACH_MM, MM, (x, z) => forestGround(host, x, z),
    (species) => host.standProfiles.get(species.name) ?? null,
  );
  host.ground.stand = host.stand;
}

/* ------------------------------------------------------------ the land */



/** Bilinear ground height in WORLD units at a world-unit position. */
export function groundHeightAt(host: LandHost, x: number, z: number): number {
  if (!host.heights) return 0;
  const gx = Math.min(N - 1.001, Math.max(0, (x * MM) / STEP_MM));
  const gz = Math.min(N - 1.001, Math.max(0, (z * MM) / STEP_MM));
  const c = Math.floor(gx);
  const rw = Math.floor(gz);
  const fx = gx - c;
  const fz = gz - rw;
  const h = host.sample(c, rw) * (1 - fx) * (1 - fz)
    + host.sample(c + 1, rw) * fx * (1 - fz)
    + host.sample(c, rw + 1) * (1 - fx) * fz
    + host.sample(c + 1, rw + 1) * fx * fz;
  return h / MM;
}





/** Underfoot at HER height: tunnel floors are real, roofs above are not. */
export function footingAt(host: LandHost, x: number, z: number): number {
  return host.floorBelow(x, z, host.at.y + 0.4) ?? host.walkGroundAt(x, z);
}

/**
 * Underfoot at THE FOOT'S OWN height, which is a different question and
 * the one the solver actually asks.
 *
 * Passing her body's height for all six feet asks about HER, not about
 * them — the solver's own note warns of exactly this: a foot pressed
 * against the wall of a shaft is inside soil, so the query climbs out of
 * it, and climbing out from her body's height in a column that is solid
 * all the way up lands on the rim overhead. The island had been throwing
 * the third argument away and handing every foot her own elevation,
 * which is why her legs reached for the surface while she was down a
 * hole.
 */
export function footingFrom(host: LandHost, x: number, z: number, y: number): number {
  return host.floorBelow(x, z, y + 0.4) ?? host.walkGroundAt(x, z);
}






/**
 * HER FRAME IN A BURROW — which way is up for her, and where the surface
 * under a point is measured ALONG that up.
 *
 * On open ground up is world vertical and a foot falls to a height. In a
 * tunnel neither is true: she is inside a tube, her up is whatever her
 * body is pressed against, and the surface under a foot may be a wall or
 * a ceiling. The solver has always been able to take this frame; the
 * island simply never gave it one, so her legs went on solving against a
 * floor that was not underneath her.
 *
 * The up is now HERS — the one the walker maintains off the soil's own
 * gradient — rather than one inferred from where she is pointed. Those two
 * agree in a level drift and disagree everywhere interesting: standing on
 * a wall while looking along it, the aim says up is sideways-ish and the
 * body says up is off the wall, and only the body is right.
 */
export function boreFrame(host: LandHost, ): {
  up: readonly [number, number, number];
  surface: (x: number, y: number, z: number) => number;
} {
  const up = host.up;
  const REACH = BODY_HALF_TALL * 2 + BODY_FLOOR_MARGIN;
  /*
   * COARSE, THEN REFINED. The solver asks this once per joint per CCD
   * iteration — hundreds of times a frame — so a flat fourteen-step march
   * was the single most-called loop in the game. Seven strides to bracket
   * the surface and three bisections to place it inside them is the same
   * answer to a third of a stride, for half the probes.
   */
  const COARSE = 7;
  const REFINE = 3;
  return {
    up: [up.x, up.y, up.z] as const,
    surface: (x: number, y: number, z: number): number => {
      const elevOf = (t: number) =>
        (x - up.x * t) * up.x + (y - up.y * t) * up.y + (z - up.z * t) * up.z;
      /* Feel DOWN her own up until the soil starts, and report where it
       * started. Nothing found means open tube — she keeps her stance. */
      let lo = 0;
      let hit = -1;
      for (let i = 0; i <= COARSE; i += 1) {
        const t = (i / COARSE) * REACH;
        if (host.soilSolidAt(x - up.x * t, y - up.y * t, z - up.z * t)) { hit = t; break; }
        lo = t;
      }
      if (hit < 0) return elevOf(REACH);
      for (let i = 0; i < REFINE; i += 1) {
        const mid = (lo + hit) * 0.5;
        if (host.soilSolidAt(x - up.x * mid, y - up.y * mid, z - up.z * mid)) hit = mid;
        else lo = mid;
      }
      return elevOf(hit);
    },
  };
}

/** All sixty-four sections, built once, never touched again. */
export function buildIsland(host: LandHost, ): void {
  for (let sz = 0; sz < SECTIONS; sz += 1) {
    for (let sx = 0; sx < SECTIONS; sx += 1) {
      host.scene.add(buildSection(host, sx, sz));
    }
  }
}

export function buildSection(host: LandHost, sx: number, sz: number): THREE.Mesh {
  const positions = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
  const normals = new Float32Array(SEC_VERTS * SEC_VERTS * 3);
  const elev = new Float32Array(SEC_VERTS * SEC_VERTS);
  const groundNy = new Float32Array(SEC_VERTS * SEC_VERTS);
  const stride = (N - 1) / (MESH_N - 1);
  let at = 0;
  for (let j = 0; j < SEC_VERTS; j += 1) {
    for (let i = 0; i < SEC_VERTS; i += 1) {
      const g = (sx * (SEC_VERTS - 1) + i) * stride;
      const gz = (sz * (SEC_VERTS - 1) + j) * stride;
      const h = host.sample(g, gz);
      positions[at] = (g * STEP_MM) / MM;
      positions[at + 1] = h / MM;
      positions[at + 2] = (gz * STEP_MM) / MM;
      /* Central differences on the DATA grid: both sides of a section
       * border compute from the same samples, so shading cannot seam. */
      const dx = (host.sample(g + stride, gz) - host.sample(g - stride, gz))
        / (2 * STEP_MM * stride);
      const dz = (host.sample(g, gz + stride) - host.sample(g, gz - stride))
        / (2 * STEP_MM * stride);
      const inv = 1 / Math.hypot(dx, 1, dz);
      normals[at] = -dx * inv;
      normals[at + 1] = inv;
      normals[at + 2] = -dz * inv;
      /* The BAND slope is measured at stride 1, whatever this section's
       * LOD stride is. Banding off the mesh normal made the rock/sand
       * split move with the LOD rings — the same hillside wore
       * different ground on each side of a detail boundary, and never
       * quite agreed with the soil window's fine-grid slopes either. */
      const dx1 = (host.sample(g + 1, gz) - host.sample(g - 1, gz))
        / (2 * STEP_MM);
      const dz1 = (host.sample(g, gz + 1) - host.sample(g, gz - 1))
        / (2 * STEP_MM);
      groundNy[at / 3] = 1 / Math.hypot(dx1, 1, dz1);
      elev[at / 3] = h; // mm IS real metres at 1:1000 — the biome bands read it raw
      at += 3;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < SEC_VERTS - 1; j += 1) {
    for (let i = 0; i < SEC_VERTS - 1; i += 1) {
      const a = j * SEC_VERTS + i;
      const b = a + 1;
      const c = a + SEC_VERTS;
      const d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('aElev', new THREE.BufferAttribute(elev, 1));
  geometry.setAttribute('aGroundNy', new THREE.BufferAttribute(groundNy, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, host.islandMaterial!);
  mesh.matrixAutoUpdate = false;
  host.terrainVerts += SEC_VERTS * SEC_VERTS;
  host.terrainTris += (SEC_VERTS - 1) * (SEC_VERTS - 1) * 2;
  return mesh;
}

