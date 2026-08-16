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
 * image buys less than it costs.
 *
 * It does NOT need to tile. Both wraps are mirrored, so every join is
 * continuous by construction whatever the edges do — which is the whole
 * reason to mirror rather than repeat. The cost is a line of symmetry per
 * tile, and on bark that vanishes into the grain; the alternative, blending
 * the edges into agreement, leaves a blurred stripe that does not.
 */
export const BARKS = [
  'bark-grey', 'bark-lichen', 'bark-craggy', 'bark-fissured', 'bark-mossy',
  'bark-ridged',
] as const;

export type BarkName = (typeof BARKS)[number];

/**
 * The barks that ship a normal and roughness map beside the colour, as
 * `<name>_normal.jpg` and `<name>_rough.jpg`.
 *
 * Listed rather than discovered, because discovery means requesting a file
 * that is usually absent and reading the 404 as an answer — five spurious
 * console errors on every load, and a slower first tree for nothing.
 *
 * A bark in here is wrapped with ordinary REPEAT, not the mirroring the flat
 * photographs get, and that is forced rather than chosen: mirroring a tile
 * reverses its U, and a tangent-space normal map read backwards has its X
 * inverted — so every second tile would light its ridges as grooves. A bark
 * with a normal map therefore has to tile honestly on its own edges. The
 * library sets do; a photograph of a tree does not, which is exactly why the
 * originals are mirrored.
 */
export const PBR_BARKS: ReadonlySet<string> = new Set<BarkName>(BARKS);

/**
 * The barks whose own edges genuinely meet, and which may therefore be
 * wrapped with ordinary REPEAT.
 *
 * Everything else is a photograph of a real tree, which does not tile, and
 * is mirrored so every join is continuous whatever the edges do. That is a
 * separate question from whether a bark has depth maps, and conflating the
 * two was a mistake: it left five of the six barks flat because they could
 * not be given the repeat wrap that `PBR_BARKS` used to imply.
 *
 * Mirroring a normal map is safe here, and that is a property of how the
 * tangent frame is built rather than luck. With no tangent attribute on the
 * geometry, three.js derives the frame from the UV's own screen-space
 * derivatives — and on a mirrored tile that derivative is negated too, so
 * the frame flips with the image and the map's X lands the right way round.
 * Verified on the trunk: ridges light as ridges in both parities.
 */
export const TILING_BARKS: ReadonlySet<string> = new Set<BarkName>(['bark-ridged']);

/**
 * The barks whose roughness map is worth loading at all — which, measured,
 * is none of them.
 *
 * Reported: "trees shouldn't be glossy." They were, and this is why.
 *
 * three.js MULTIPLIES: the shader's roughness is `material.roughness` times
 * the map's green channel, so a roughness map is a scaling factor and never
 * an override. Measured across the six shipped `_rough.jpg` files — mean
 * green, and the spread between the darkest and lightest texel:
 *
 *     bark-craggy    0.750   (0.714 - 0.816)   spread 0.10
 *     bark-fissured  0.764   (0.714 - 0.816)   spread 0.10
 *     bark-grey      0.773   (0.722 - 0.827)   spread 0.11
 *     bark-lichen    0.770   (0.729 - 0.820)   spread 0.09
 *     bark-mossy     0.756   (0.714 - 0.835)   spread 0.12
 *     bark-ridged    0.725   (0.306 - 0.996)   spread 0.69
 *
 * Five of the six are FLAT. They carried no detail worth having, and all
 * they did was quietly scale the material's 0.95 down to about 0.71 — glossy
 * bark, produced by a map that was added to stop bark looking like wallpaper.
 *
 * `bark-ridged` is the interesting one and it still goes. Its 0.69 spread is
 * real authored detail, but a mean of 0.725 means a ridged trunk would stay
 * glossier than the other five even after they were fixed, with its
 * smoothest patches down at 0.31 — wet-looking bark, which is the reported
 * defect. One bark's subtle variation does not outweigh that, and its normal
 * map carries the relief regardless. Keeping the set (empty) rather than
 * deleting the concept: if a bark ever ships a roughness map that is both
 * detailed AND rough on average, this is where it goes back in.
 *
 * Measured in the running game from the report's own viewpoint, looking up
 * the trunk — mean brightness of the trunk, of 255. One session, each state
 * set from the same starting point rather than stacked on the last, because
 * a first pass that stacked them reported a change twice its real size:
 *
 *     as it shipped (0.95 x a 0.75 map)    88.2
 *     flat 0.95, no map                    77.8
 *     flat 1.0, no map  <- what we do      76.8
 *     specular lobe killed outright        68.9
 *
 * Everything the sheen could ever have been worth is the 19.3 between the
 * first row and the last. Dropping the map alone takes 10.4 of it and going
 * on to a flat 1 takes 11.4 — a shade under sixty per cent — while leaving
 * bark with the small honest highlight a dielectric should have. See
 * `BARK_ROUGHNESS` for why 1 rather than the old 0.95.
 */
export const DETAILED_ROUGH_BARKS: ReadonlySet<string> = new Set<BarkName>();

/**
 * How rough bark is: as rough as a dielectric gets.
 *
 * The old 0.95 was not measured against anything — and against the numbers
 * above it leaves half the sheen in place. Bark is one of the least glossy
 * surfaces in the natural world: dry, fibrous, deeply pitted, with no
 * smooth microfacet population to speak of. There is no reading of it that
 * wants a specular lobe, and the scene has no environment map, so this
 * number is doing nothing but sizing the sun's own highlight.
 */
export const BARK_ROUGHNESS = 1;

export interface TreeSpec {
  /** Trunk diameter at the ground, in world units. */
  girth: number;
  /** Ground to the highest twig, in world units. */
  height: number;
  /** Anything repeatable: the same seed is the same tree, always. */
  seed: number;
  /**
   * How many sections the trunk is built from, and how many boughs it
   * carries.
   *
   * A twenty-six metre tree wants twenty-two rings to bend convincingly. A
   * knee-high bush does not, and giving it them is how a thousand bushes
   * became a million triangles — measured, before these existed. Default to
   * the big tree's numbers, so nothing that does not ask changes.
   */
  rings?: number;
  boughs?: number;
  /** Whether boughs carry twigs. Off, a bough simply ends in its leaves. */
  twigs?: boolean;
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
  /**
   * The radius the trunk tapers down TO at the leader's tip, in world units
   * — an absolute size, not a fraction of the base.
   *
   * The taper used to hold at 16% of the base, which on the landmark left a
   * tip 80 mm across: a pole with the end sawn off. A trunk that ends at a
   * fixed small circle reads as a tree from any girth, and the number is
   * the same one the collision profile is built from, so what you can climb
   * is exactly what you can see.
   */
  tipRadius?: number;
}

/**
 * Default tip: a five-millimetre circle — 1 world unit across, about half
 * the length of the ant looking at it. Clamped against the base below, so a
 * knee-high bush cannot end up wider at the top than at the foot.
 */
export const TIP_RADIUS = 0.5;

/**
 * How much wider the DRAWN ring is than the limb's radius, at `sides`.
 *
 * The mesh is a polygon and the limb is a circle. Putting the vertices on
 * the circle sinks every flat inside it; putting them at `r / cos(pi/n)`
 * makes the flats tangent to it instead, which is what stopped her
 * hovering. The collision has to know the same number or it describes a
 * thinner tree than the one on screen — and she stands on the collision.
 */
export function ringFactor(sides: number): number {
  return 1 / Math.cos(Math.PI / Math.max(3, sides));
}

/** Sides on the finest wood — the tessellation she is ever close to. */
export const NEAR_SIDES = 64;

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
  /* Never wider at the tip than half the foot — a bush whose whole stem is
   * thinner than the default tip would otherwise flare upwards. */
  const tipR = Math.min(spec.tipRadius ?? TIP_RADIUS, baseR * 0.5);

  /*
   * THE TRUNK WANDERS. A perfectly straight cylinder reads as a pipe, and
   * at this scale you are standing against it — a lean of a few per cent of
   * the height over its length is what makes it wood. The wander is a slow
   * curve, not noise per segment, or it reads as a crumpled straw.
   */
  const RINGS = Math.max(3, spec.rings ?? 22);
  const leanX = (rand() - 0.5) * spec.height * 0.05;
  const leanZ = (rand() - 0.5) * spec.height * 0.05;
  const twistPhase = rand() * Math.PI * 2;
  const axis: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= RINGS; i += 1) {
    const t = i / RINGS;
    /*
     * Taper: widest at the foot, thinning fast out of the flare and then
     * slowly, and landing on a FIXED small circle at the leader's tip
     * rather than on a fraction of the base. A linear taper to a point
     * makes a carrot; real trunks lose most of their girth low down and
     * then hold, which is what the exponent buys.
     */
    const flare = 1 + 0.28 * Math.exp(-t * 18);
    const shape = (1 - t) ** 1.35;
    radii.push(tipR + (baseR * flare - tipR) * shape);
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
  const BOUGHS = Math.max(1, spec.boughs ?? 11);
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const withTwigs = spec.twigs ?? true;
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
    if (depth <= 0 || !withTwigs) {
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

/** Sides used at a detail level — so a caller can match its collision to
 *  the tessellation it actually baked. */
export function sidesAt(level: number): number {
  return DETAILS[Math.min(DETAILS.length - 1, Math.max(0, level))]!.sides;
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

/*
 * SIDES ARE A CLEARANCE BUDGET, not just a silhouette.
 *
 * The collision is the circle the drawn polygon is inscribed in, so she is
 * never under the bark — and is over it by the facet's sagitta,
 * `r (1/cos(pi/n) - 1)`. At the landmark's widest, 573 mm of radius, twenty
 * sides left 7 mm of air under her feet; sixty-four leaves 0.7, which is a
 * fourteenth of her own body and invisible. The near level is the only one
 * she is ever close enough to stand on, so it is the only one that pays.
 */
const DETAILS: readonly Detail[] = [
  { sides: 64, order: 2, leaf: 2 },
  { sides: 12, order: 1, leaf: 1 },
  { sides: 6, order: 0, leaf: 0 },
  /* Scrub grade: eight sides to a stem and the coarsest possible leaf. Four
   * was enough for the silhouette, but a four-sided stem stands 41% proud of
   * its own collision and she climbs these too. */
  { sides: 8, order: 1, leaf: 0 },
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

  /*
   * CHAINS, NOT LIMBS — the trunk is ONE tube.
   *
   * Every limb used to be skinned as its own closed-ended tube. Consecutive
   * sections of the same trunk therefore met as two separate rings facing
   * slightly different ways, which opens a wedge on the outside of every
   * bend: you could see into the tree, and from inside it read as a second
   * trunk crossing the first. Overrunning the ends papered over it.
   *
   * A run of limbs where each one's far end IS the next one's near end is a
   * chain, and a chain is skinned as a single continuous tube with ONE ring
   * at each joint, shared by the sections either side. Shared rings cannot
   * disagree, so there is no seam left to hide — not a smaller one, none.
   * The trunk is one chain; so is each bough and each twig.
   */
  const chains: Limb[][] = [];
  let run: Limb[] = [];
  for (const limb of used) {
    if (run.length > 0 && run[run.length - 1]!.b === limb.a) run.push(limb);
    else {
      if (run.length > 0) chains.push(run);
      run = [limb];
    }
  }
  if (run.length > 0) chains.push(run);

  /*
   * THE DRAWN TUBE CIRCUMSCRIBES THE COLLISION, IT DOES NOT INSCRIBE IT.
   *
   * The solid is the exact round cone over the limb's radius — a circle.
   * The mesh is a polygon, and putting its VERTICES on that circle leaves
   * every flat between them sunk inside it by `r(1 - cos(pi/sides))`. She
   * stands on the circle, so she stands that far off the picture: 6 mm on
   * the landmark's twenty-sided trunk, and 29% of the stem on a four-sided
   * bush. That is the hovering — collision and mesh agreed about the AXIS
   * after the last pass, and still disagreed about the skin.
   *
   * Pushing the ring out by the circumradius factor makes the flats
   * TANGENT to the collision circle instead: the bark she is standing on is
   * the bark that is drawn, and what error is left is a fraction of a
   * millimetre of contact at the facet corners, which reads as nothing.
   */
  const fatten = 1 / Math.cos(Math.PI / d.sides);

  let rings = 0;
  let spans = 0;
  for (const chain of chains) { rings += chain.length + 1; spans += chain.length; }
  const stride = d.sides + 1;
  const pos = new Float32Array(rings * stride * 3);
  const nrm = new Float32Array(rings * stride * 3);
  const uv = new Float32Array(rings * stride * 2);
  const idx = new Uint32Array(spans * d.sides * 6);

  const tangent = new THREE.Vector3();
  const tin = new THREE.Vector3();
  const tout = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  let p = 0;
  let t = 0;
  let n = 0;
  let f = 0;

  for (const chain of chains) {
    const last = chain.length;
    const pts: THREE.Vector3[] = [chain[0]!.a.clone()];
    const rad: number[] = [chain[0]!.ra];
    const along: number[] = [chain[0]!.run];
    let walked = chain[0]!.run;
    for (const limb of chain) {
      walked += limb.a.distanceTo(limb.b);
      pts.push(limb.b.clone());
      rad.push(limb.rb);
      along.push(walked);
    }
    /*
     * The two ENDS still overrun, and only the ends: a bough's first ring
     * has to start inside the trunk it grows from or the join shows, and a
     * trunk's first ring may as well start under the soil. Nothing between
     * them needs it any more.
     *
     * AN OVERRUN EXTENDS THE CONE; IT DOES NOT STRETCH IT.
     *
     * Moving the end ring and keeping its radius spreads the section's whole
     * taper over a longer run, so between that ring and the next one the
     * drawn tube sits INSIDE the cone the collision is built from — and the
     * lowest section of the trunk is exactly where she steps onto the tree.
     * Measured on the landmark, 705 mm up: the wood she stood on was 13.0 mm
     * outside the bark she could see, against a body 9 mm long. That is the
     * hovering. Carrying the radius along the same slope keeps the ruled
     * surface on the cone, which is what makes the two agree everywhere and
     * not merely at the rings.
     */
    const widen: number[] = new Array(rad.length).fill(1);
    const footSpan = pts[0]!.distanceTo(pts[1]!);
    const back = Math.min(rad[0]! * 0.9, footSpan * 0.4);
    tout.copy(pts[1]!).sub(pts[0]!).normalize();
    pts[0]!.addScaledVector(tout, -back);
    if (footSpan > 1e-9) {
      rad[0] = Math.max(1e-4, rad[0]! - ((rad[1]! - rad[0]!) / footSpan) * back);
    }
    const tipSpan = pts[last]!.distanceTo(pts[last - 1]!);
    const fwd = Math.min(rad[last]! * 0.6, tipSpan * 0.4);
    tin.copy(pts[last]!).sub(pts[last - 1]!).normalize();
    pts[last]!.addScaledVector(tin, fwd);
    if (tipSpan > 1e-9) {
      rad[last] = Math.max(1e-4, rad[last]! + ((rad[last]! - rad[last - 1]!) / tipSpan) * fwd);
    }

    /*
     * A ROUND CONE IS FATTER THAN ITS OWN RADII.
     *
     * The solid is a cone with a SPHERE welded on each end, and its side is
     * the common tangent to those two spheres — not the line between the rim
     * points. Work the tangency out and the surface is the linear
     * interpolation of `r / cos a`, where `sin a` is the taper per unit
     * length. So a ring drawn at plain `r` is inside the wood by
     * `r (1/cos a - 1)`: three millimetres at the landmark's foot, where the
     * flare makes the taper steepest and where she steps onto the tree.
     *
     * Scaling both ends of a section by `1 / cos a` puts the ruled surface
     * EXACTLY on the cone's side, not near it. A joint takes the fatter of
     * the two sections meeting there, so neither side of it can float.
     */
    for (let i = 0; i < rad.length - 1; i += 1) {
      const span = pts[i]!.distanceTo(pts[i + 1]!);
      if (span < 1e-9) continue;
      /*
       * CLAMPED, because the construction runs away at the ends.
       *
       * `1/cos a` is only the tangent surface while the two spheres are far
       * enough apart to have a common tangent at all. A twig's last section
       * loses nearly its whole radius over its own length — `sin a` goes to
       * one, the cone degenerates into the larger sphere, and the factor
       * goes to infinity. Unclamped it reached 22, which put drawn vertices
       * 194 mm outside the wood they belong to. Past this angle the sphere
       * cap is the surface anyway and the flare buys nothing.
       */
      const sinA = Math.min(0.55, Math.abs(rad[i]! - rad[i + 1]!) / span);
      const wide = 1 / Math.sqrt(1 - sinA * sinA);
      if (wide > widen[i]!) widen[i] = wide;
      if (wide > widen[i + 1]!) widen[i + 1] = wide;
    }
    for (let i = 0; i < rad.length; i += 1) rad[i]! *= widen[i]!;

    prev.copy(pts[1]!).sub(pts[0]!).normalize();
    anyPerp(prev, u);
    const ring0 = n;
    for (let i = 0; i <= last; i += 1) {
      if (i > 0) tin.copy(pts[i]!).sub(pts[i - 1]!).normalize();
      else tin.copy(prev);
      if (i < last) tout.copy(pts[i + 1]!).sub(pts[i]!).normalize();
      else tout.copy(tin);
      /* The ring stands square to the BISECTOR of the two sections meeting
       * at it — the mitre a real joint makes — so neither side pinches. */
      tangent.copy(tin).add(tout);
      if (tangent.lengthSq() < 1e-12) tangent.copy(tin);
      tangent.normalize();
      /* Carry the frame along rather than rebuilding it: `anyPerp` of a
       * slightly different axis is a slightly different starting angle, and
       * a ring that starts somewhere else twists the bark at every joint. */
      turn.setFromUnitVectors(prev, tangent);
      u.applyQuaternion(turn);
      u.addScaledVector(tangent, -u.dot(tangent)).normalize();
      v.crossVectors(tangent, u);
      prev.copy(tangent);

      const centre = pts[i]!;
      const r = rad[i]! * fatten;
      const vCoord = along[i]! / barkTile;
      for (let sIdx = 0; sIdx <= d.sides; sIdx += 1) {
        const ang = (sIdx / d.sides) * Math.PI * 2;
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
        uv[t] = (sIdx / d.sides) * around;
        uv[t + 1] = vCoord;
        t += 2;
        n += 1;
      }
    }
    for (let i = 0; i < last; i += 1) {
      const base = ring0 + i * stride;
      for (let sIdx = 0; sIdx < d.sides; sIdx += 1) {
        const a0 = base + sIdx;
        const a1 = base + sIdx + 1;
        const b0 = base + stride + sIdx;
        const b1 = base + stride + sIdx + 1;
        /* Around first, along second — that is the winding that faces out;
         * see `tests/tree.test.ts`, which counts any that do not. */
        idx[f] = a0; idx[f + 1] = a1; idx[f + 2] = b0;
        idx[f + 3] = a1; idx[f + 4] = b1; idx[f + 5] = b0;
        f += 6;
      }
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
  const subdiv = detail >= 3 ? 1 : 0;
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
    const blob = new THREE.IcosahedronGeometry(tuft.r, subdiv).toNonIndexed();
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

  /**
   * @param fatten Multiplies every limb's radius, so the solid can be the
   *   surface that is actually DRAWN rather than the circle inside it. She
   *   seats on this; anything the mesh puts outside it, she stands under.
   */
  constructor(limbs: readonly Limb[], origin: THREE.Vector3, fatten = 1) {
    /*
     * TWIGS ARE SOLID TOO — leaves are not.
     *
     * They were left out on the reasoning that a twig is thinner than she
     * is. Measured, it is not: the outermost limb on a twenty-six metre
     * tree comes out at 9.1 mm through, against an ant 9 mm long — as wide
     * across as she is long, which is a person on a two-metre beam. That is
     * a branch, and leaving it out is why the far and upper branches
     * refused her. The leaves stay open air, which is where the
     * getting-wedged worry actually applied.
     */
    const solid = limbs.filter((l) => l.order <= 2).map((l) => ({
      ...l,
      a: l.a.clone().add(origin),
      b: l.b.clone().add(origin),
      ra: l.ra * fatten,
      rb: l.rb * fatten,
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


/**
 * ONE TREE AS ONE GEOMETRY, ready to be stamped out thousands of times.
 *
 * The LOD chain above is for the handful of trees she can walk up to. A
 * hillside of them is a different problem: what matters is the DRAW CALL,
 * and an instanced mesh only gets one geometry. So this bakes a whole tree
 * — wood and leaves together — into a single buffer, with the leaves marked
 * by vertex colour rather than by a second material.
 *
 * Unindexed, because the leaves are and merging one of each is more code
 * than the vertices are worth at these sizes.
 */
export function bakeTree(
  spec: TreeSpec, level: number,
): THREE.BufferGeometry {
  const parts = growTree(spec);
  const d = DETAILS[Math.min(DETAILS.length - 1, Math.max(0, level))]!;
  const barkTile = spec.barkTile ?? spec.girth * 0.5;
  const around = Math.max(1, Math.round((Math.PI * spec.girth) / barkTile));
  const wood = skin(parts.limbs, d, barkTile, around).toNonIndexed();
  /* `leaf: 0` means the COARSEST blob, not "no leaves" — an instanced bush
   * is mostly foliage, and a bush with no leaves is a twig. */
  const leaves = skinLeaves(parts.tufts, d.leaf + 1);

  const woodCount = wood.getAttribute('position').count;
  const leafCount = leaves ? leaves.getAttribute('position').count : 0;
  const total = woodCount + leafCount;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);

  pos.set(wood.getAttribute('position').array as Float32Array, 0);
  nrm.set(wood.getAttribute('normal').array as Float32Array, 0);
  uv.set(wood.getAttribute('uv').array as Float32Array, 0);
  col.fill(1, 0, woodCount * 3);

  if (leaves) {
    pos.set(leaves.getAttribute('position').array as Float32Array, woodCount * 3);
    nrm.set(leaves.getAttribute('normal').array as Float32Array, woodCount * 3);
    /* Leaves take a green tint and a UV that lands somewhere quiet in the
     * bark — they are lit by their own colour, and at these sizes the map
     * under them is texture, not detail. */
    for (let i = 0; i < leafCount; i += 1) {
      uv[(woodCount + i) * 2] = 0.5;
      uv[(woodCount + i) * 2 + 1] = 0.5;
      col[(woodCount + i) * 3] = 0.30;
      col[(woodCount + i) * 3 + 1] = 0.52;
      col[(woodCount + i) * 3 + 2] = 0.20;
    }
    leaves.dispose();
  }
  wood.dispose();

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}


/**
 * THE TRUNK'S OWN LINE, scaled to one unit tall.
 *
 * An instanced stand shares ONE baked shape, stretched and spun per plant —
 * so the thing it can be collided against is that same shape, in the same
 * unit space. Anything else is a guess, and the guess that was there (a
 * straight vertical cone from base radius to a fraction of it) measured up
 * to 33 per cent FATTER than the drawn wood at mid-height, and modelled
 * none of the lean. She stood on the invisible one and floated over the
 * visible one, which is exactly how it was reported.
 */
export interface TrunkProfile {
  /** Axis points up the trunk, in unit-height space. */
  pts: { x: number; y: number; z: number }[];
  /** The radius at each point, in the same space. */
  r: number[];
}

export function trunkProfile(spec: TreeSpec, sides = NEAR_SIDES): TrunkProfile {
  const { limbs } = growTree(spec);
  const trunk = limbs.filter((l) => l.order === 0);
  const k = 1 / spec.height;
  /* The DRAWN ring, not the limb — see `ringFactor`. A scattered plant is
   * baked at its tier's own tessellation, and a four-sided bush is 41%
   * wider at its corners than the stem it is built from. */
  const f = ringFactor(sides) * k;
  const pts = [{ x: trunk[0]!.a.x * k, y: trunk[0]!.a.y * k, z: trunk[0]!.a.z * k }];
  const r = [trunk[0]!.ra * f];
  for (const l of trunk) {
    pts.push({ x: l.b.x * k, y: l.b.y * k, z: l.b.z * k });
    r.push(l.rb * f);
  }
  return { pts, r };
}

/**
 * How far from the WOOD each detail level takes over, in world units.
 *
 * Absolute distances rather than fractions of the tree's height, because
 * the question is no longer "how big is this tree" but "how close is her
 * face to it". Level 0 covers everything within 1.5 m of any part of it,
 * which is every case in which she can be standing on it.
 */
const SWAP_AT = [0, 300, 1200, 4000] as const;

export interface BuiltTree {
  root: THREE.LOD;
  /** Choose the detail level from the distance to the tree's own capsule
   *  rather than to its origin. Call once a frame. */
  updateLevels(cameraWorld: THREE.Vector3): void;
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
/**
 * The extra maps a bark may ship, when it is a photographed PBR set rather
 * than a flat photograph. Both optional: the five original barks have neither
 * and must keep working untouched.
 */
export interface BarkMaps {
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
}

export function buildTree(
  spec: TreeSpec, bark: THREE.Texture, barkName: BarkName, maps: BarkMaps = {},
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
    map: bark,
    /*
     * A NORMAL MAP IS THE DEPTH, and the roughness map is what stops it
     * reading as printed-on. Both are optional so the five flat barks are
     * unchanged; where a set supplies them, the flat 0.95 roughness gives way
     * to the measured one, because a uniform roughness is what makes bark
     * look like wallpaper under a moving sun.
     */
    ...(maps.normalMap ? { normalMap: maps.normalMap } : {}),
    ...(maps.roughnessMap ? { roughnessMap: maps.roughnessMap } : {}),
    /*
     * BARK IS NOT SHINY — see `BARK_ROUGHNESS`, and `DETAILED_ROUGH_BARKS`
     * for the measurement that got us here. A roughness map, if one is ever
     * kept again, MULTIPLIES this rather than replacing it.
     */
    roughness: BARK_ROUGHNESS,
    metalness: 0,
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
    /*
     * The thresholds are on the distance to the WOOD, not to the origin —
     * see `updateLevels`. `THREE.LOD` cannot compute that itself, so this
     * registers the levels for their geometry and their disposal and the
     * distances here are never consulted.
     */
    root.addLevel(group, level === 0 ? 0 : SWAP_AT[Math.min(level, SWAP_AT.length - 1)]!);
  });
  /* Driven by hand, every frame, from the distance to the trunk. */
  root.autoUpdate = false;

  /* The tree's own extent, for the distance that actually matters. */
  let crown = 0;
  for (const l of parts.limbs) {
    crown = Math.max(crown, Math.hypot(l.b.x, l.b.z) + l.rb, Math.hypot(l.a.x, l.a.z) + l.ra);
  }
  for (const t of parts.tufts) crown = Math.max(crown, Math.hypot(t.at.x, t.at.z) + t.r);
  const topY = spec.height;

  const built: BuiltTree = {
    root,
    triangles,
    bark: barkName,
    solid: null,
    /**
     * PICK THE LEVEL FROM HOW FAR THE CAMERA IS FROM THE WOOD.
     *
     * `THREE.LOD` measures to the object's ORIGIN, which for a twenty-six
     * metre tree you can climb is the wrong question: at the crown you are
     * twenty-six metres from the origin and nought from the bark. So the
     * first swap fired at 23.4 m — ninety per cent of the way up, exactly
     * where the trunk was reported to start cutting into her — and dropped
     * the wood from 64 sides to 12 while the collision stayed at 64. Worse,
     * level 1 draws no twigs at all and `TreeSolid` collides them, so the
     * crown had climbable branches that were not there to see.
     *
     * The honest distance is to the tree's own capsule: its axis from foot
     * to crown, widened by how far the branches reach. Standing on any part
     * of it that is nought, whatever the height.
     */
    updateLevels(cameraWorld: THREE.Vector3): void {
      const dx = cameraWorld.x - root.position.x;
      const dz = cameraWorld.z - root.position.z;
      const dy = cameraWorld.y - root.position.y;
      /* Distance to the axis SEGMENT, then out to the branch tips. */
      const along = Math.min(topY, Math.max(0, dy));
      const near = Math.max(0, Math.hypot(dx, dz, dy - along) - crown);
      let level = 0;
      while (level + 1 < root.levels.length && near > SWAP_AT[level + 1]!) level += 1;
      for (let i = 0; i < root.levels.length; i += 1) {
        root.levels[i]!.object.visible = i === level;
      }
    },
    makeSolid(origin: THREE.Vector3): TreeSolid {
      /* At the finest level, because that is the one she can walk up to. */
      built.solid = new TreeSolid(parts.limbs, origin, ringFactor(DETAILS[0]!.sides));
      return built.solid;
    },
    dispose(): void {
      for (const o of owned) o.dispose();
    },
  };
  return built;
}
