/**
 * A TREE, AT AN ANT'S SCALE.
 *
 * Twenty-six metres of it, a metre through at the foot, standing beside a
 * nine-millimetre queen. The scale is the whole design problem: from where
 * she stands the trunk is a wall that runs out of sight, and the canopy is
 * weather. Nothing about this is a prop you glance at, so the bark has to
 * hold up at arm's length and the silhouette has to hold up from across the
 * island — which is exactly what a level-of-detail chain is for.
 *
 * The tree is built as a list of LIMBS — a line, a radius at each end — and
 * nothing else. The trunk is limbs stacked up a gently wandering line, a
 * branch is limbs walking away from a point on it, and a twig is the same
 * function one level down. Tessellation happens once per detail level and
 * merges into ONE buffer, so a whole tree is one draw call however many
 * limbs went into it. Changing detail is then just retessellating the same
 * limbs with fewer sides, which cannot change the tree's shape — the thing
 * that makes LOD pops obvious.
 *
 * Everything here is in WORLD UNITS. The caller converts; millimetres are
 * the scene's business.
 */

import * as THREE from 'three';

/**
 * The barks that ship with the game. One is picked per tree.
 *
 * There were four. Two of them — a pale ridged one and a warm brown one —
 * were stock photographs with the seller's watermark still on them, tiled
 * across the image at low opacity. They rendered: the mark went onto the
 * trunk with everything else, and at half a millimetre a texel it is
 * legible. Withdrawn, files and all.
 *
 * ADDING ONE: drop a square JPEG into `public/tree-tex/` and put its name
 * here. Nothing else needs to change — the scene picks from this list by
 * seed, and the mesh derives its tiling from the trunk's own girth. About
 * 1024 square is right; the wrap tiles it several times round, so a bigger
 * image buys less than it costs. It does not need to be seamless top to
 * bottom (the wrap is mirrored, which hides that join) but the LEFT and
 * RIGHT edges do meet, so a seamless-horizontal tile is worth having.
 */
export const BARKS = ['bark-grey', 'bark-lichen'] as const;

export type BarkName = (typeof BARKS)[number];

export interface TreeSpec {
  /** Trunk diameter at the ground, in world units. */
  girth: number;
  /** Ground to the highest twig, in world units. */
  height: number;
  /** Anything repeatable: the same seed is the same tree, always. */
  seed: number;
  /**
   * How much TRUNK one tile of bark covers, in world units — the same
   * number in both directions, so the grain is never stretched.
   *
   * The first cut wrapped one tile once around the whole trunk: at a metre
   * of girth that is 3.1 m of bark across a 1024-pixel image, which is
   * three millimetres a texel, viewed by something nine millimetres long.
   * Mush. Tiling it several times round costs nothing — the texture is
   * already loaded — and buys the resolution back in proportion.
   */
  barkTile?: number;
}

/** One tapered section of wood: a line with a radius at each end. */
export interface Limb {
  a: THREE.Vector3;
  b: THREE.Vector3;
  ra: number;
  rb: number;
  /** How far up the tree this limb starts, for the bark's v coordinate. */
  run: number;
  /** 0 for the trunk, 1 for a bough, 2 for a twig — drives which detail
   *  levels bother to draw it. */
  order: number;
}

/** A cluster of leaves: a centre and a radius. Drawn as cheap blobs. */
export interface Tuft {
  at: THREE.Vector3;
  r: number;
}

/**
 * Deterministic noise. `Math.random` would make every reload a different
 * tree, which is untestable and, for a landmark the player navigates by,
 * wrong.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Some unit vector that is not parallel to `v` — for building a basis. */
function anyPerp(v: THREE.Vector3, into: THREE.Vector3): THREE.Vector3 {
  into.set(v.z, v.x, v.y);
  into.addScaledVector(v, -into.dot(v));
  if (into.lengthSq() < 1e-9) into.set(1, 0, 0).addScaledVector(v, -v.x);
  return into.normalize();
}

export interface TreeParts {
  limbs: Limb[];
  tufts: Tuft[];
}

/**
 * The tree's skeleton, before anything is drawn.
 *
 * Kept separate from the mesh so it can be checked without a renderer, and
 * so every detail level is a different tessellation of the SAME wood rather
 * than a different tree that happens to look similar.
 */
export function growTree(spec: TreeSpec): TreeParts {
  const rand = rng(spec.seed);
  const limbs: Limb[] = [];
  const tufts: Tuft[] = [];
  const baseR = spec.girth / 2;

  /*
   * THE TRUNK WANDERS. A perfectly straight cylinder reads as a pipe, and
   * at this scale you are standing against it — a lean of a few per cent of
   * the height over its length is what makes it wood. The wander is a slow
   * curve, not noise per segment, or it reads as a crumpled straw.
   */
  const RINGS = 22;
  const leanX = (rand() - 0.5) * spec.height * 0.05;
  const leanZ = (rand() - 0.5) * spec.height * 0.05;
  const twistPhase = rand() * Math.PI * 2;
  const axis: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= RINGS; i += 1) {
    const t = i / RINGS;
    /*
     * Taper: fast out of the flare at the foot, then slow. A linear taper
     * to a point makes a carrot; real trunks lose most of their girth in
     * the bottom fifth and then hold.
     */
    const flare = 1 + 0.28 * Math.exp(-t * 18);
    const hold = 0.16 + 0.84 * (1 - t) ** 1.35;
    radii.push(baseR * flare * hold);
    const bend = t * t;
    axis.push(new THREE.Vector3(
      leanX * bend + Math.sin(t * 3.1 + twistPhase) * baseR * 0.35,
      t * spec.height,
      leanZ * bend + Math.cos(t * 2.6 + twistPhase) * baseR * 0.35,
    ));
  }
  let run = 0;
  for (let i = 0; i < RINGS; i += 1) {
    limbs.push({
      a: axis[i]!, b: axis[i + 1]!, ra: radii[i]!, rb: radii[i + 1]!, run, order: 0,
    });
    run += axis[i]!.distanceTo(axis[i + 1]!);
  }

  /*
   * BOUGHS start above the clear trunk and climb in a spiral, each shorter
   * and steeper than the last, because that is what competition for light
   * produces. The spiral is golden-angled so no two sit above each other.
   */
  const BOUGHS = 11;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const grow = (
    from: THREE.Vector3, along: THREE.Vector3, len: number, r0: number,
    order: number, startRun: number, depth: number,
  ): void => {
    /* A bough is a longer, more curved thing than a twig, so it gets the
     * segments. This read `depth === 0`, which handed the five to the twigs
     * and left the boughs as three straight sticks. */
    const SEGS = depth > 0 ? 5 : 3;
    let here = from.clone();
    let r = r0;
    let along2 = along.clone().normalize();
    let along3 = along2.clone();
    let ran = startRun;
    for (let i = 0; i < SEGS; i += 1) {
      const t = (i + 1) / SEGS;
      /* Boughs SWEEP UP as they go out — the classic hardwood elbow. */
      along3 = along2.clone().addScaledVector(up, 0.55 * t * t).normalize();
      const step = len / SEGS;
      const next = here.clone().addScaledVector(along3, step);
      const rNext = r0 * (1 - t) ** 0.9 + r0 * 0.06;
      limbs.push({ a: here, b: next, ra: r, rb: rNext, run: ran, order });
      ran += step;
      here = next;
      r = rNext;
    }
    /*
     * THE END OF THE LINE CARRIES THE LEAVES; everything above it carries
     * twigs. This test was the wrong way round — `depth > 0` returned at
     * the FIRST call, which is the bough, so the recursion never ran and
     * the twig loop below was dead code. The tree was eleven bare sticks
     * with a blob on each end, which is what "looks weird" was looking at.
     */
    if (depth <= 0) {
      tufts.push({ at: here.clone(), r: len * 0.42 });
      return;
    }
    const TWIGS = 3;
    for (let k = 0; k < TWIGS; k += 1) {
      anyPerp(along3, side);
      const spin = (k / TWIGS) * Math.PI * 2 + rand() * 0.8;
      const out = side.clone().applyAxisAngle(along3, spin)
        .multiplyScalar(0.75).addScaledVector(along3, 0.65).normalize();
      grow(here, out, len * (0.42 + rand() * 0.18), r * 0.72, order + 1, ran, depth - 1);
    }
  };

  for (let i = 0; i < BOUGHS; i += 1) {
    const t = 0.42 + (i / (BOUGHS - 1)) * 0.54;
    const ring = Math.min(RINGS - 1, Math.floor(t * RINGS));
    const at = axis[ring]!;
    const trunkR = radii[ring]!;
    const spin = i * GOLDEN + twistPhase;
    dir.set(Math.cos(spin), 0.22 + rand() * 0.18, Math.sin(spin)).normalize();
    const len = spec.height * (0.20 - 0.11 * t) * (0.8 + rand() * 0.4);
    grow(
      at.clone().addScaledVector(dir, trunkR * 0.8),
      dir, len, trunkR * (0.42 - 0.12 * t), 1, t * spec.height, 1,
    );
  }
  /* A crown on the leader, so the top is foliage and not a cut-off pole. */
  tufts.push({ at: axis[RINGS]!.clone(), r: spec.height * 0.055 });

  return { limbs, tufts };
}

/** How many limbs and leaves a detail level bothers with. */
interface Detail {
  /** Sides around a limb. */
  sides: number;
  /** The highest limb order drawn: 0 trunk only, 1 boughs, 2 twigs. */
  order: number;
  /** Draw the leaves at all, and at what tessellation. */
  leaf: number;
}

const DETAILS: readonly Detail[] = [
  { sides: 20, order: 2, leaf: 2 },
  { sides: 10, order: 1, leaf: 1 },
  { sides: 6, order: 0, leaf: 0 },
];

/**
 * Skin the limbs at one detail level, into one geometry.
 *
 * Each limb is a tube with its own ring at either end rather than a shared
 * spine, which costs a few vertices and buys the thing that matters: a
 * branch can leave the trunk at any angle without the trunk's rings having
 * to know about it.
 */
function skin(
  limbs: readonly Limb[], d: Detail, barkTile: number, around: number,
): THREE.BufferGeometry {
  const used = limbs.filter((l) => l.order <= d.order);
  const rings = used.length * 2;
  const verts = rings * (d.sides + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const idx = new Uint32Array(used.length * d.sides * 6);

  const axis = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  let p = 0;
  let t = 0;
  let n = 0;
  let f = 0;
  for (const limb of used) {
    axis.copy(limb.b).sub(limb.a);
    const len = axis.length() || 1e-6;
    axis.divideScalar(len);
    anyPerp(axis, u);
    v.crossVectors(axis, u);
    const ring0 = n;
    for (let end = 0; end < 2; end += 1) {
      const centre = end === 0 ? limb.a : limb.b;
      const r = end === 0 ? limb.ra : limb.rb;
      const vCoord = (limb.run + end * len) / barkTile;
      for (let s = 0; s <= d.sides; s += 1) {
        const ang = (s / d.sides) * Math.PI * 2;
        const cx = Math.cos(ang);
        const sz = Math.sin(ang);
        const nx = u.x * cx + v.x * sz;
        const ny = u.y * cx + v.y * sz;
        const nz = u.z * cx + v.z * sz;
        pos[p] = centre.x + nx * r;
        pos[p + 1] = centre.y + ny * r;
        pos[p + 2] = centre.z + nz * r;
        nrm[p] = nx; nrm[p + 1] = ny; nrm[p + 2] = nz;
        p += 3;
        /* `around` whole tiles of bark per lap, so the seam still closes —
         * a fractional repeat would leave a visible join running the height
         * of the tree. */
        uv[t] = (s / d.sides) * around;
        uv[t + 1] = vCoord;
        t += 2;
        n += 1;
      }
    }
    const stride = d.sides + 1;
    for (let s = 0; s < d.sides; s += 1) {
      const a0 = ring0 + s;
      const a1 = ring0 + s + 1;
      const b0 = ring0 + stride + s;
      const b1 = ring0 + stride + s + 1;
      /*
       * WOUND OUTWARD. This was `(a0, b0, a1)` and `(a1, b0, b1)`, which is
       * the mirror of it — every one of the seven thousand triangles faced
       * INTO the tree. The terrain's material is double-sided so nothing
       * else in the scene had ever noticed a backwards winding; the tree's
       * is not, so its near wall was culled and what you saw through the
       * gap was the inside of the far wall. A solid trunk that reads as a
       * hollow funnel you are standing inside.
       *
       * Around the limb is +v and along it is +axis, and `cross(v, axis)`
       * is the outward normal by construction — so a triangle that steps
       * AROUND first and ALONG second faces out.
       */
      idx[f] = a0; idx[f + 1] = a1; idx[f + 2] = b0;
      idx[f + 3] = a1; idx[f + 4] = b1; idx[f + 5] = b0;
      f += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** The leaves, as one merged blob mesh — no alpha, no sorting, no cost. */
function skinLeaves(tufts: readonly Tuft[], detail: number): THREE.BufferGeometry | null {
  if (detail <= 0 || tufts.length === 0) return null;
  /*
   * Merged by hand rather than through the example utils, which keeps this
   * module's dependencies to `three` itself — and merged UNINDEXED, because
   * that is what a polyhedron actually is. `IcosahedronGeometry` carries no
   * index at all, so a merge that assumed one read `null.count` and took the
   * whole tree down with it.
   */
  const parts: THREE.BufferGeometry[] = [];
  let vTotal = 0;
  for (const tuft of tufts) {
    const blob = new THREE.IcosahedronGeometry(tuft.r, detail >= 2 ? 1 : 0)
      .toNonIndexed();
    blob.translate(tuft.at.x, tuft.at.y, tuft.at.z);
    vTotal += blob.getAttribute('position').count;
    parts.push(blob);
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  let at = 0;
  for (const g of parts) {
    const gp = g.getAttribute('position').array as Float32Array;
    const gn = g.getAttribute('normal').array as Float32Array;
    pos.set(gp, at);
    nrm.set(gn, at);
    at += gp.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();
  return out;
}

/** Triangles in a geometry, indexed or not. */
function triCount(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  return (idx ? idx.count : g.getAttribute('position').count) / 3;
}


/* ------------------------------------------------------- the solid tree */

/**
 * THE TREE AS SOMETHING YOU CANNOT WALK THROUGH.
 *
 * The scene already has a walker that takes one question — how solid is this
 * point — and turns the answer into standing, climbing, cornering and
 * falling. So a tree does not need a collision system of its own; it needs
 * to be part of that answer. Union the wood into the soil's field and she
 * bumps into the trunk, walks round it, and climbs it, all through the code
 * that already carries her up a shaft wall. Her up comes off the field's
 * gradient, and the gradient of a cylinder points out of the cylinder.
 *
 * Distances are exact, not approximate: the drawn trunk and the solid trunk
 * are the SAME limbs, so there is no gap to fall into and no invisible wall
 * standing off the bark.
 */
export class TreeSolid {
  /** The whole tree's box, for the reject that most probes take. */
  private readonly minX: number;

  private readonly maxX: number;

  private readonly minY: number;

  private readonly maxY: number;

  private readonly minZ: number;

  private readonly maxZ: number;

  /**
   * Limbs bucketed by height.
   *
   * This is asked hundreds of times a frame by the walker's casts, and a
   * loop over every limb in the tree would be the most expensive thing in
   * the frame by a wide margin. Standing at the foot, the only wood within
   * reach is the two or three trunk sections beside her — so the probe pays
   * for those and nothing else.
   */
  private readonly slabs: Limb[][];

  private readonly slabH: number;

  constructor(limbs: readonly Limb[], origin: THREE.Vector3) {
    /*
     * Twigs and leaves are NOT solid. A twig is thinner than she is and a
     * leaf is not a surface an ant stands on in any sense this game models;
     * making them solid means getting wedged in the canopy. Trunk and
     * boughs are the tree you can climb.
     */
    const solid = limbs.filter((l) => l.order <= 1).map((l) => ({
      ...l,
      a: l.a.clone().add(origin),
      b: l.b.clone().add(origin),
    }));
    let x0 = Infinity; let x1 = -Infinity;
    let y0 = Infinity; let y1 = -Infinity;
    let z0 = Infinity; let z1 = -Infinity;
    for (const l of solid) {
      const r = Math.max(l.ra, l.rb);
      x0 = Math.min(x0, l.a.x - r, l.b.x - r); x1 = Math.max(x1, l.a.x + r, l.b.x + r);
      y0 = Math.min(y0, l.a.y - r, l.b.y - r); y1 = Math.max(y1, l.a.y + r, l.b.y + r);
      z0 = Math.min(z0, l.a.z - r, l.b.z - r); z1 = Math.max(z1, l.a.z + r, l.b.z + r);
    }
    this.minX = x0; this.maxX = x1;
    this.minY = y0; this.maxY = y1;
    this.minZ = z0; this.maxZ = z1;

    const SLABS = 64;
    this.slabH = Math.max(1e-6, (y1 - y0) / SLABS);
    this.slabs = Array.from({ length: SLABS }, () => [] as Limb[]);
    for (const l of solid) {
      const r = Math.max(l.ra, l.rb);
      const lo = Math.max(0, Math.floor((Math.min(l.a.y, l.b.y) - r - y0) / this.slabH));
      const hi = Math.min(SLABS - 1, Math.floor((Math.max(l.a.y, l.b.y) + r - y0) / this.slabH));
      for (let i = lo; i <= hi; i += 1) this.slabs[i]!.push(l);
    }
  }

  /**
   * How far inside the wood a point is: positive in, negative out, in world
   * units, and a true distance either way so the gradient is a unit normal.
   *
   * The per-limb form is the exact round cone — a cone with a sphere welded
   * on each end — which is precisely what a tapered limb with rounded joints
   * is. A cheap capsule approximation would leave the collision standing a
   * few millimetres off the drawn bark, and at this scale that is a visible
   * gap she hovers in.
   */
  densityAt(x: number, y: number, z: number): number {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY
      || z < this.minZ || z > this.maxZ) return -Infinity;
    const slab = this.slabs[Math.min(
      this.slabs.length - 1, Math.max(0, Math.floor((y - this.minY) / this.slabH)),
    )]!;
    let best = -Infinity;
    for (let i = 0; i < slab.length; i += 1) {
      const l = slab[i]!;
      const inside = -roundCone(x, y, z, l.a, l.b, l.ra, l.rb);
      if (inside > best) best = inside;
    }
    return best;
  }

  solidAt(x: number, y: number, z: number): boolean {
    return this.densityAt(x, y, z) > 0;
  }
}

/**
 * Signed distance to a round cone: negative inside, positive outside.
 *
 * Inigo Quilez's closed form, transcribed. The three cases are the two end
 * caps and the side; which one applies is decided by comparing where the
 * point projects against the slope of the cone's own silhouette, which is
 * what the `a2` and `k` terms are.
 */
function roundCone(
  px: number, py: number, pz: number,
  a: THREE.Vector3, b: THREE.Vector3, r1: number, r2: number,
): number {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-12) return Math.hypot(px - a.x, py - a.y, pz - a.z) - r1;
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - a.x;
  const pay = py - a.y;
  const paz = pz - a.z;
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const xx = pax * l2 - bax * yy;
  const xy = pay * l2 - bay * yy;
  const xz = paz * l2 - baz * yy;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
}

export interface BuiltTree {
  root: THREE.LOD;
  /** The wood, as something the walker's field can be unioned with. Set by
   *  the scene once the tree has been placed, because it is built in world
   *  space and the tree does not know where it stands until then. */
  solid: TreeSolid | null;
  /** Build the solid form now that the tree has a position in the world. */
  makeSolid(origin: THREE.Vector3): TreeSolid;
  /** Triangles at each detail level, for the stats chip. */
  triangles: number[];
  bark: BarkName;
  dispose(): void;
}

/**
 * Build the tree, at every detail level, ready to add to a scene.
 *
 * The LOD swaps on distance to the tree's ORIGIN, which for a
 * five-thousand-unit-tall object is a coarse thing to key on — standing at
 * the foot you are zero from the origin and a mile from the crown. That is
 * the right way round, though: what you can see in detail is what is next
 * to you, and what is next to you at the foot of a tree is the trunk.
 */
export function buildTree(
  spec: TreeSpec, bark: THREE.Texture, barkName: BarkName,
): BuiltTree {
  /*
   * A tile of bark is half the trunk's own girth square. On a metre-thick
   * trunk that is 500 mm of bark to a 1024-pixel image — half a millimetre
   * a texel, which holds up with an ant's face against it.
   */
  const barkTile = spec.barkTile ?? spec.girth * 0.5;
  /*
   * How many whole tiles go round the trunk. Taken at the FOOT, where she
   * spends her time and where the texels have to be smallest; the taper
   * stretches the grain gently as it climbs, which is what bark does. A
   * whole number, or the wrap leaves a seam up the whole tree.
   */
  const around = Math.max(1, Math.round((Math.PI * spec.girth) / barkTile));
  const parts = growTree(spec);
  const root = new THREE.LOD();
  const triangles: number[] = [];
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  const woodMat = new THREE.MeshStandardMaterial({
    map: bark, roughness: 0.95, metalness: 0,
    /*
     * NO FOG ON THE TREE. The island's fog starts at 1,200 units, which is
     * tuned for a fifty-six kilometre landscape and is six metres in a
     * tree's terms — so the crown of a twenty-six metre trunk standing
     * right beside her would fade into haze while its foot was crisp. The
     * two scales cannot share one fog curve, and a landmark that dissolves
     * upward is the more wrong of the two.
     */
    fog: false,
  });
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0x3f5c2a, roughness: 1, metalness: 0, flatShading: true, fog: false,
  });
  owned.push(woodMat, leafMat);

  DETAILS.forEach((d, level) => {
    const group = new THREE.Group();
    const wood = skin(parts.limbs, d, barkTile, around);
    owned.push(wood);
    group.add(new THREE.Mesh(wood, woodMat));
    let tris = triCount(wood);
    const leaves = skinLeaves(parts.tufts, d.leaf);
    if (leaves) {
      owned.push(leaves);
      group.add(new THREE.Mesh(leaves, leafMat));
      tris += triCount(leaves);
    }
    triangles.push(tris);
    /* The near level is free, then the swaps are spaced by the tree's own
     * height — a distance the tree itself defines rather than a constant
     * that would be wrong for a different one. */
    root.addLevel(group, level === 0 ? 0 : spec.height * level * 0.9);
  });

  const built: BuiltTree = {
    root,
    triangles,
    bark: barkName,
    solid: null,
    makeSolid(origin: THREE.Vector3): TreeSolid {
      built.solid = new TreeSolid(parts.limbs, origin);
      return built.solid;
    },
    dispose(): void {
      for (const o of owned) o.dispose();
    },
  };
  return built;
}
