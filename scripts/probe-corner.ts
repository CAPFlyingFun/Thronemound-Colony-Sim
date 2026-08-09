/**
 * THE SAME QUESTION, WITHOUT A BROWSER.
 *
 * The scene probe measures her in situ and is worth what it costs, but the
 * claim underneath it is pure geometry: a ray cast along her own up, from a
 * front foot's home, over the reach that foot actually has. Rebuilt here out
 * of the real `SurfaceWalker` and the real `TreeSolid` — flat soil, a trunk
 * standing in it, unioned exactly as the island unions them — so the answer
 * cannot be an artefact of the scene, the streaming, or the probe's own
 * bookkeeping.
 *
 *   npx vite-node scripts/probe-corner.ts
 */
import * as THREE from 'three';
import { SurfaceWalker } from '../src/world/surfaceWalk';
import { growTree, ringFactor, TreeSolid, type TreeSpec } from '../src/world/tree';
import { REACH_DOWN_MM, REACH_UP_MM } from '../src/anim/legDrive';
import { CORNER_DEG, CORNER_TUNING } from '../src/anim/cornerTurn';

const MM = 5;
const CELL = 0.2;

/* The island's landmark, to its own numbers. */
const SPEC: TreeSpec = { girth: 1000 / MM, height: 26000 / MM, seed: 4242 };
const BURIED = 100 / MM;

const { limbs } = growTree(SPEC);
/* Fattened to the drawn skin, as `makeSolid` does at the finest level. */
const trunk = new TreeSolid(limbs, new THREE.Vector3(0, -BURIED, 0), ringFactor(64));

/** Flat soil at y = 0, and the wood standing in it. A union of two solids. */
const solid = (x: number, y: number, z: number): boolean =>
  y < 0 || trunk.solidAt(x, y, z);
const density = (x: number, y: number, z: number): number =>
  Math.max(-y, trunk.densityAt(x, y, z));

const walker = new SurfaceWalker(density, {
  cell: CELL, ride: 1.3 / MM, gripLift: 3 / MM, gripReach: 9 / MM,
  align: 12, maxTiltRate: (240 * Math.PI) / 180, snap: 14, gravity: 9,
}, solid);

/** The bark's own radius at a height, marched rather than assumed. */
const barkRadius = (y: number): number => {
  for (let r = 0; r < 400; r += 0.01) if (!trunk.solidAt(r, y, 0)) return r;
  throw new Error('the trunk never ends');
};

/* Her frame: standing on flat soil, facing the trunk along -x. */
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(-1, 0, 0);

/**
 * The gait's own question, verbatim: `IslandScene.groundForLegs.nearest`.
 * Copied rather than imported because it is four lines of a private field,
 * and copying it is the point — this must be the SAME cast.
 */
const nearest = (
  at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number,
): THREE.Vector3 | null => walker.cast(
  at.clone().addScaledVector(up, rise), up.clone().negate(), rise + down,
);

const deg = (r: number): number => +((r * 180) / Math.PI).toFixed(1);
const tilt = (n: THREE.Vector3): number =>
  deg(Math.acos(THREE.MathUtils.clamp(n.dot(UP), -1, 1)));

/* Her measured front-leg geometry, from the drive's own tables and the rig
 * dump: home 3.80 mm ahead of centre, 0.31 mm above it. */
const FRONT_HOME_AHEAD = 3.796 / MM;
const FRONT_HOME_UP = 0.308 / MM;
const FRONT_DOWN = REACH_DOWN_MM.frontLeft! / MM;
const FRONT_SPREAD = 2.82 / MM;

const bark = barkRadius(0.3);
console.log(`\nTHE CORNER, HEADLESS — trunk radius ${(bark * MM).toFixed(1)} mm at ant height`);
console.log(`  front foot home: ${(FRONT_HOME_AHEAD * MM).toFixed(2)} mm ahead, `
  + `spare reach down ${(FRONT_DOWN * MM).toFixed(2)} mm, spread ${(FRONT_SPREAD * MM).toFixed(2)} mm`);
console.log(`  the cast the gait makes: from ${REACH_UP_MM} mm above the target, `
  + `down her up, for ${(REACH_UP_MM + FRONT_DOWN * MM).toFixed(2)} mm\n`);

console.log('   gap    front-foot target      VERTICAL cast (the gait\'s)        FORWARD cast');
console.log('   (mm)   x,y (mm from bark)     hit?   what   tilt   drop        hit?  dist  tilt');

for (const gapMm of [14, 10, 8, 6, 5, 4, 3, 2, 1, 0.5]) {
  /* Her centre `gap` clear of the bark, her soles on the soil. Body origin
   * sits a hair BELOW the contact — the rig's own rest height. */
  const at = new THREE.Vector3(bark + gapMm / MM, -0.259 / MM, 0);
  const target = at.clone()
    .addScaledVector(FWD, FRONT_HOME_AHEAD)
    .addScaledVector(UP, FRONT_HOME_UP);
  const fromBarkMm = (target.x - bark) * MM;

  const vert = nearest(target, UP, FRONT_DOWN, REACH_UP_MM / MM);
  let vertCol = '  no      -       -      -   ';
  if (vert) {
    const n = walker.normalAt(vert, new THREE.Vector3());
    /* Wood or soil: step a hair INTO the surface along its own normal and
     * ask the trunk directly. */
    const inside = vert.clone().addScaledVector(n, -0.04);
    const wood = trunk.solidAt(inside.x, inside.y, inside.z);
    const drop = target.clone().sub(vert).dot(UP) * MM;
    vertCol = ` yes  ${(wood ? 'WOOD' : 'soil').padStart(5)}  ${String(tilt(n)).padStart(5)}  `
      + `${drop.toFixed(2).padStart(5)}`;
  }

  const fwdHit = walker.cast(target, FWD, 12 / MM);
  let fwdCol = '   no     -     -';
  if (fwdHit) {
    const n = walker.normalAt(fwdHit, new THREE.Vector3());
    fwdCol = `  yes ${(target.distanceTo(fwdHit) * MM).toFixed(2).padStart(5)} `
      + `${String(tilt(n)).padStart(5)}`;
  }

  console.log(`  ${gapMm.toFixed(1).padStart(5)}   `
    + `${fromBarkMm.toFixed(2).padStart(6)}, ${(target.y * MM).toFixed(2).padStart(5)}     `
    + `${vertCol}      ${fwdCol}`);
}

/*
 * And the seat: what the walker itself makes of her standing there. If her
 * up never leaves world vertical, nothing downstream can know a wall is
 * there either.
 */
console.log('\nWHAT THE WALKER MAKES OF HER, STANDING STILL AT THE FOOT');
console.log('   gap    her up tilt   seat normal tilt');
for (const gapMm of [10, 6, 4, 2, 1]) {
  const frame = {
    at: new THREE.Vector3(bark + gapMm / MM, -0.259 / MM, 0),
    up: UP.clone(),
    forward: FWD.clone(),
  };
  for (let i = 0; i < 120; i += 1) walker.settle(frame, 1 / 60);
  const under = walker.cast(
    frame.at.clone().addScaledVector(frame.up, 3 / MM),
    frame.up.clone().negate(), 12 / MM,
  );
  const seat = under ? tilt(walker.normalAt(under, new THREE.Vector3())) : NaN;
  console.log(`  ${gapMm.toFixed(1).padStart(5)}   ${String(tilt(frame.up)).padStart(10)}   `
    + `${String(seat).padStart(15)}`);
}
/*
 * THE TWO GATES, EVALUATED EXACTLY AS THE SCHEDULER EVALUATES THEM.
 *
 * On the island it answered "never armed" at both walk and run, and a
 * scheduler that declines is indistinguishable from one that is broken until
 * you can see WHICH gate said no. These are the same two questions in the
 * same order: is there a steep thing ahead (the brow fan), and can a front
 * foot touch it (the standoff cast, against that leg's own spread).
 */
console.log('\nWHY IT DID OR DID NOT ARM, GATE BY GATE');
console.log(`  enter >= ${CORNER_DEG.enter}deg, band <= ${CORNER_DEG.band}deg, `
  + `brow lift ${(CORNER_TUNING.browLift * MM).toFixed(1)} mm, `
  + `look-ahead ${(CORNER_TUNING.lookAhead * MM).toFixed(0)} mm`);
console.log('\n   gap    BROW: hit  tilt    FOOTHOLD: hit  dist  spread  off-target   arms?');

for (const gapMm of [10, 8, 7, 6.5, 6, 5.5, 5, 4.5, 4]) {
  const at = new THREE.Vector3(bark + gapMm / MM, -0.259 / MM, 0);
  const right = new THREE.Vector3().crossVectors(UP, FWD).normalize();
  const homeOf = (hx: number, hy: number, hz: number) => at.clone()
    .addScaledVector(right, hx / MM)
    .addScaledVector(UP, hy / MM)
    .addScaledVector(FWD, hz / MM);

  /* The brow: the mean of the leading row's homes, lifted one field cell. */
  const brow = homeOf(-1.796, 0.308, 3.796).add(homeOf(1.833, 0.308, 3.796))
    .multiplyScalar(0.5).addScaledVector(UP, CORNER_TUNING.browLift);
  let newUp: THREE.Vector3 | null = null;
  let browTilt = NaN;
  for (const lift of CORNER_TUNING.fan) {
    const dir = FWD.clone();
    if (lift !== 0) dir.applyAxisAngle(right, lift).normalize();
    if (solid(brow.x, brow.y, brow.z)) break;
    const hit = walker.cast(brow, dir, CORNER_TUNING.lookAhead);
    if (!hit) continue;
    const n = walker.normalAt(hit, new THREE.Vector3());
    const a = deg(Math.acos(THREE.MathUtils.clamp(n.dot(UP), -1, 1)));
    if (a < CORNER_DEG.enter) continue;
    newUp = n;
    browTilt = a;
    break;
  }

  let footCol = '        -      -       -          -';
  let arms = false;
  if (newUp) {
    /* And the foothold, for the better of the two front legs. */
    let bestDist = Infinity;
    let bestOff = NaN;
    for (const [hx, hy, hz, spreadMm] of [
      [-1.796, 0.308, 3.796, 2.817], [1.833, 0.308, 3.796, 2.824],
    ] as const) {
      const home = homeOf(hx, hy, hz);
      const spreadWu = spreadMm / MM;
      const origin = home.clone().addScaledVector(UP, CORNER_TUNING.browLift);
      if (solid(origin.x, origin.y, origin.z)) continue;
      const hit = walker.cast(
        origin, newUp.clone().negate(), spreadWu + CORNER_TUNING.browLift,
      );
      if (!hit) continue;
      const d = home.distanceTo(hit);
      if (d >= bestDist) continue;
      bestDist = d;
      const n = walker.normalAt(hit, new THREE.Vector3());
      bestOff = deg(Math.acos(THREE.MathUtils.clamp(n.dot(newUp), -1, 1)));
    }
    if (Number.isFinite(bestDist)) {
      const inReach = bestDist * MM <= 2.824;
      const inBand = bestOff <= CORNER_DEG.band;
      arms = inReach && inBand;
      footCol = `      yes ${(bestDist * MM).toFixed(2).padStart(5)}   2.82  `
        + `${String(bestOff).padStart(9)}`;
    }
  }
  console.log(`  ${gapMm.toFixed(1).padStart(5)}    `
    + `${(newUp ? 'yes' : ' no').padStart(8)} ${String(browTilt).padStart(5)}  `
    + `${footCol}   ${arms ? 'ARMS' : 'no'}`);
}

/*
 * HOW HIGH THE LOOK-AHEAD HAS TO START.
 *
 * A ray fired forward at sole height strikes the trunk exactly where the
 * floor's field meets the wall's, and the union's gradient there is the
 * BLEND of the two — 45 degrees, whatever the wall is really doing. That is
 * not the wall's normal, it is the corner's. Lifting the origin off the sole
 * plane walks the hit up the bark and out of the blend, and this says by how
 * much.
 */
console.log('\nHOW HIGH MUST THE LOOK-AHEAD START TO SEE THE WALL AS A WALL?');
console.log('  Forward ray from the front-foot home, raised off the sole plane.');
console.log('  Reported: the measured normal tilt off her up, in degrees.\n');
const RAISES = [0, 0.5, 1, 1.5, 2, 3, 4];
console.log(`   gap    ${RAISES.map((r) => `+${r.toFixed(1)}mm`.padStart(7)).join('')}`);
for (const gapMm of [10, 8, 7, 6, 5, 4]) {
  const at = new THREE.Vector3(bark + gapMm / MM, -0.259 / MM, 0);
  const cells = RAISES.map((raiseMm) => {
    const origin = at.clone()
      .addScaledVector(FWD, FRONT_HOME_AHEAD)
      .addScaledVector(UP, FRONT_HOME_UP + raiseMm / MM);
    const hit = walker.cast(origin, FWD, 12 / MM);
    if (!hit) return '      -';
    const n = walker.normalAt(hit, new THREE.Vector3());
    return String(tilt(n)).padStart(7);
  });
  console.log(`  ${gapMm.toFixed(1).padStart(5)}    ${cells.join('')}`);
}
console.log('');
