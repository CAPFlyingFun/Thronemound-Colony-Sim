/**
 * THE CORNER, MEASURED BEFORE IT IS FIXED.
 *
 * The claim to settle is narrow and mechanical: when she is standing on flat
 * soil with a trunk in front of her, can the gait's ONE question about the
 * world — `Ground.nearest(at, up, down, rise)`, which casts along her own up
 * — ever return a point on the near-vertical bark? If it cannot, no amount
 * of scheduling will make a front foot grip, because there is nothing for a
 * scheduler to schedule.
 *
 * So every frame this records, per leg: planted / groping / swinging, the
 * anchor, the foot, its home in the world, its excursion against its own
 * spread, and — the part that matters — what `nearest()` answers for that
 * leg's SWING TARGET and what the surface normal is where it lands. Beside
 * it, for contrast only, a HORIZONTAL probe from the same origin toward the
 * tree: if that one finds bark at a reachable distance while the vertical
 * one is finding soil, the failure is the cast DIRECTION and nothing else.
 *
 * She is teleported to the foot of the tree rather than walked there. The
 * 700 mm approach is four minutes of soil streaming that measures nothing;
 * the corner is the last fifteen millimetres.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-corner.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1200);

const MM = 5;

/* ------------------------------------------------------------ the rig */

const plan = await page.evaluate(() => {
  const s = window.islandScene;
  const legs = s.drive?.legs ?? [];
  return {
    legRideMm: +(s.legRide * 5).toFixed(3),
    plan: s.queen.legPlan().map((l) => ({
      slot: l.slot,
      homeMm: l.home.map((v) => +(v * 5).toFixed(3)),
      reachMm: +(l.reach * 5).toFixed(3),
    })),
    drive: legs.map((l) => ({
      slot: l.slot,
      downMm: +(l.down * 5).toFixed(3),
      spreadMm: +(l.spread * 5).toFixed(3),
    })),
  };
});

console.log('\nHER LEGS, as the drive was built from them (mm)');
console.log('  slot         home x       y       z    reach   reach-down   spread');
for (const l of plan.plan) {
  const d = plan.drive.find((x) => x.slot === l.slot) ?? {};
  console.log(`  ${l.slot.padEnd(11)}`
    + `${String(l.homeMm[0]).padStart(8)}${String(l.homeMm[1]).padStart(8)}`
    + `${String(l.homeMm[2]).padStart(8)}${String(l.reachMm).padStart(9)}`
    + `${String(d.downMm ?? '?').padStart(13)}${String(d.spreadMm ?? '?').padStart(9)}`);
}
console.log(`  ride (body origin above contact): ${plan.legRideMm} mm`);

/* --------------------------------------------------- park her at the bark */

/**
 * Put her `gapMm` clear of the bark on the line from the tree toward her
 * start, facing the trunk, and let the walker settle her.
 */
const park = (gapMm) => page.evaluate((gap) => {
  const s = window.islandScene;
  const t = s.tree.root.position;
  /* Where the bark is, at her own height, on the line between them: march
   * out from the axis until the wood stops. Nothing here knows the tree's
   * radius, and the trunk both tapers and leans. */
  const y = s.at.y;
  const dx = s.at.x - t.x;
  const dz = s.at.z - t.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  /* Out to 1200 mm: the trunk is a metre THROUGH, so its radius is 100
   * world units and its flare more. A march that stops at 300 mm never
   * leaves the wood, reports a radius of nought, and parks her in the
   * middle of the tree — which is exactly what the first run of this
   * script did, and why it is worth saying how far it reaches. */
  let bark = -1;
  for (let r = 0; r < 240; r += 0.02) {
    if (!s.tree.solid.solidAt(t.x + ux * r, y, t.z + uz * r)) { bark = r; break; }
  }
  if (bark < 0) throw new Error('never found the outside of the trunk');
  const standMm = bark * 5 + gap;
  s.teleportMm((t.x + ux * (standMm / 5)) * 5, (t.z + uz * (standMm / 5)) * 5);
  s.setFacingForTest(Math.atan2(t.x - s.at.x, t.z - s.at.z));
  s.input.walk = 0; s.input.sprint = false; s.input.yaw = 0; s.input.strafe = 0;
  s.stepForTest(1 / 60, 40);
  return { barkRadiusMm: +(bark * 5).toFixed(2) };
}, gapMm);

/* ------------------------------------------------------- the measurement */

/**
 * One frame's worth of everything, including the two probes per front leg.
 *
 * The VERTICAL probe is verbatim what the gait asks: `nearest(target, up,
 * leg.down, REACH_UP)`. The HORIZONTAL one is the same cast rotated onto her
 * forward, and exists only to say whether the bark was there to be found.
 */
const read = () => page.evaluate(() => {
  const s = window.islandScene;
  const t = s.tree.root.position;
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const REACH_UP = 2.5 / 5;

  const up = s.up;
  const fwd = s.fwd;
  const right = s.at.clone().crossVectors(up, fwd).normalize();
  const homeWorld = (leg) => s.at.clone()
    .addScaledVector(right, leg.home.x)
    .addScaledVector(up, leg.home.y)
    .addScaledVector(fwd, leg.home.z);

  /* Her gap to the bark, along the line to the axis, at her own height. */
  const dx = s.at.x - t.x;
  const dz = s.at.z - t.z;
  const len = Math.hypot(dx, dz) || 1;
  let bark = -1;
  for (let r = 0; r < 240; r += 0.02) {
    if (!s.tree.solid.solidAt(t.x + (dx / len) * r, s.at.y, t.z + (dz / len) * r)) {
      bark = r; break;
    }
  }
  const gapMm = bark < 0 ? NaN : +((len - bark) * 5).toFixed(2);

  const normalAt = (p) => {
    const n = p.clone();
    s.walker.normalAt(p, n);
    return n;
  };
  const angleTo = (n) => deg(Math.acos(Math.max(-1, Math.min(1, n.dot(up)))));

  const legs = (s.drive?.legs ?? []).map((leg) => {
    const home = homeWorld(leg);
    const ex = home.clone().sub(leg.anchor);
    ex.addScaledVector(up, -ex.dot(up));
    const row = {
      slot: leg.slot,
      state: leg.planted ? 'PLANT' : (leg.groping ? 'GROPE' : 'SWING'),
      excursionMm: +(ex.length() * 5).toFixed(2),
      spreadMm: +(leg.spread * 5).toFixed(2),
      atMm: [leg.at.x, leg.at.y, leg.at.z].map((v) => +(v * 5).toFixed(2)),
    };
    if (!leg.slot.startsWith('front')) return row;

    /* THE GAIT'S OWN QUESTION, verbatim, for this leg's stance target. */
    const target = home;
    const vert = s.groundForLegs.nearest(target, up, leg.down, REACH_UP);
    if (vert) {
      const n = normalAt(vert);
      row.vertHit = true;
      row.vertTiltDeg = angleTo(n);
      row.vertWood = s.tree.solid.solidAt(
        vert.x - n.x * 0.04, vert.y - n.y * 0.04, vert.z - n.z * 0.04,
      );
      row.vertDropMm = +(target.clone().sub(vert).dot(up) * 5).toFixed(2);
    } else {
      row.vertHit = false;
    }

    /* The SAME cast, aimed along her forward instead of down her up. */
    const horiz = s.walker.cast(target, fwd, 12 / 5);
    if (horiz) {
      const n = normalAt(horiz);
      row.horizHit = true;
      row.horizDistMm = +(target.distanceTo(horiz) * 5).toFixed(2);
      row.horizTiltDeg = angleTo(n);
      row.horizWood = s.tree.solid.solidAt(
        horiz.x - n.x * 0.04, horiz.y - n.y * 0.04, horiz.z - n.z * 0.04,
      );
    } else {
      row.horizHit = false;
    }
    return row;
  });

  const r = s.driveReport ?? {};
  const c = r.corner ?? {};
  return {
    gapMm,
    phase: c.phase ?? '-',
    onNew: c.onNew ?? -1,
    onOld: c.onOld ?? -1,
    turnDeg: c.turnDeg ?? -1,
    candMm: c.candidateMm ?? -1,
    swinging: c.swinging ?? '-',
    line: s.cornerLineForTest(),
    /* Sanity, so a bad park is visible rather than silently measured: how
     * high her centre sits over the island's own ground here. */
    aboveGroundMm: +((s.at.y - s.walkGroundAt(s.at.x, s.at.z)) * 5).toFixed(2),
    upTiltDeg: deg(Math.acos(Math.max(-1, Math.min(1, up.y)))),
    onWood: s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z),
    planted: r.planted ?? -1,
    groping: r.groping ?? -1,
    allowed: +(r.allowed ?? -1).toFixed(3),
    strain: +(r.strain ?? -1).toFixed(2),
    movedMm: +(r.movedMm ?? -1).toFixed(3),
    heldMm: +(r.heldBackMm ?? -1).toFixed(3),
    head: deg(s.spine.pose.head),
    thorax: deg(s.spine.pose.thorax),
    gaster: deg(s.spine.pose.gaster),
    legs,
  };
});

const step = (frames, sprint) => page.evaluate(([n, run]) => {
  const s = window.islandScene;
  s.input.walk = 1; s.input.sprint = run;
  s.stepForTest(1 / 60, n);
}, [frames, sprint]);

const stop = () => page.evaluate(() => {
  const s = window.islandScene;
  s.input.walk = 0; s.input.sprint = false;
});

const front = (r, slot) => r.legs.find((l) => l.slot === slot) ?? {};

const line = (tag, r) => {
  const fl = front(r, 'frontLeft');
  const fr = front(r, 'frontRight');
  const v = (l) => (l.vertHit ? `${String(l.vertTiltDeg).padStart(5)}${l.vertWood ? 'W' : 'S'}` : ' none ');
  const h = (l) => (l.horizHit
    ? `${String(l.horizDistMm).padStart(6)}@${String(l.horizTiltDeg).padStart(5)}${l.horizWood ? 'W' : 'S'}`
    : '   none      ');
  console.log(`  ${String(tag).padStart(5)} ${String(r.gapMm).padStart(7)} `
    + `${String(r.aboveGroundMm).padStart(6)} `
    + `${String(r.upTiltDeg).padStart(6)} ${String(r.planted).padStart(3)}`
    + `${String(r.groping).padStart(3)} ${String(r.allowed).padStart(6)}`
    + `${String(r.strain).padStart(7)} ${String(r.movedMm).padStart(7)}`
    + ` | ${fl.state} ${v(fl)} ${h(fl)} | ${fr.state} ${v(fr)} ${h(fr)}`);
};

/* ------------------------------------------ the corner, frame by frame */

console.log('\n\nTHE CORNER ITSELF — every frame the scheduler is awake');
console.log('  gap is her centre to the bark; up is her own up off world up;');
console.log('  turn is how far the two surfaces disagree; cand is the tracked');
console.log('  candidate. Then the per-foot line: surface ownership / state.\n');
/**
 * Stepped and logged INSIDE the page, because a per-frame round trip over
 * the CDP socket is the whole cost of this probe: six hundred of them is
 * five minutes of waiting to watch an ant walk nine millimetres.
 */
const cornerRun = (frames, sprint) => page.evaluate(([n, run]) => {
  const s = window.islandScene;
  const t = s.tree.root.position;
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const log = [];
  let was = '';
  s.input.walk = 1; s.input.sprint = run;
  for (let f = 0; f < n; f += 1) {
    s.stepForTest(1 / 60, 1);
    const c = s.driveReport?.corner;
    if (!c) continue;
    const line = s.cornerLineForTest();
    /* Her CENTRE inside the wood is not a failure and must not stop the
     * trace: this rig rests its soles 0.26 mm BELOW its own origin, so an
     * ant properly seated on bark has her origin a hair inside it. Breaking
     * on this cut the log off at exactly the frame the climb began. */
    const inWood = s.tree.solid.solidAt(s.at.x, s.at.y, s.at.z);
    if (line !== was || f === n - 1) {
      was = line;
      const dx = s.at.x - t.x;
      const dz = s.at.z - t.z;
      const len = Math.hypot(dx, dz) || 1;
      let bark = -1;
      for (let r = 0; r < 240; r += 0.05) {
        if (!s.tree.solid.solidAt(
          t.x + (dx / len) * r, s.at.y, t.z + (dz / len) * r,
        )) { bark = r; break; }
      }
      log.push({
        f,
        gap: +((len - bark) * 5).toFixed(2),
        up: deg(Math.acos(Math.max(-1, Math.min(1, s.up.y)))),
        head: deg(s.spine.pose.head),
        gaster: deg(s.spine.pose.gaster),
        inWood,
        line,
      });
    }
  }
  s.input.walk = 0; s.input.sprint = false;
  return log;
}, [frames, sprint]);

/**
 * Step until the corner reaches a named milestone, then stop. Returns how
 * many frames it took, or -1 if it never got there.
 */
const runUntil = (want, frames, sprint) => page.evaluate(([w, n, run]) => {
  const s = window.islandScene;
  s.input.walk = 1; s.input.sprint = run;
  /* `normal` is where a corner ENDS and also where it has not started, so
   * waiting for it means nothing until one has actually run. */
  let armed = false;
  for (let f = 0; f < n; f += 1) {
    s.stepForTest(1 / 60, 1);
    const c = s.driveReport?.corner;
    if (!c) continue;
    if (c.phase !== 'normal') armed = true;
    const hit = w.phase ? (armed && c.phase === w.phase) : c.onNew >= w.onNew;
    if (hit) { s.input.walk = 0; s.input.sprint = false; return f; }
  }
  s.input.walk = 0; s.input.sprint = false;
  return -1;
}, [want, frames, sprint]);

/** Side-on and from behind, close enough to read the legs. */
const shoot = async (name) => {
  for (const [view, alongRight] of [['side', true], ['back', false]]) {
    await page.evaluate((right) => {
      const s = window.islandScene;
      const cam = s.camera;
      const u = s.up;
      const f = s.fwd;
      const r = {
        x: u.y * f.z - u.z * f.y,
        y: u.z * f.x - u.x * f.z,
        z: u.x * f.y - u.y * f.x,
      };
      const arm = right ? r : { x: -f.x, y: -f.y, z: -f.z };
      /* Sixty millimetres out, not twenty-three. The subject is a NINE
       * millimetre ant against a metre-thick trunk, and an arm short enough
       * to fill the frame with her leaves the thing she is climbing entirely
       * outside it — which is most of what these shots are for. */
      cam.position.set(
        s.at.x + arm.x * 12 + u.x * 3,
        s.at.y + arm.y * 12 + u.y * 3,
        s.at.z + arm.z * 12 + u.z * 3,
      );
      cam.up.set(u.x, u.y, u.z);
      cam.lookAt(s.at.x, s.at.y, s.at.z);
      cam.updateMatrixWorld();
      s.paused = true;
      s.renderer.render(s.scene, cam);
    }, alongRight);
    await page.screenshot({ path: `/tmp/corner-${name}-${view}.png`, timeout: 90000 });
    await page.evaluate(() => { window.islandScene.paused = false; });
  }
};

console.log('\n\nTHE FIVE MOMENTS, IN PROFILE AND FROM BEHIND');
await park(13);
const STAGES = [
  ['approach', { onNew: 0 }],
  ['firstgrip', { onNew: 1 }],
  ['two-four', { onNew: 2 }],
  ['four-two', { onNew: 4 }],
  ['climbing', { phase: 'normal' }],
];
await shoot(STAGES[0][0]);
console.log(`  ${STAGES[0][0].padEnd(10)} shot at the approach`);
for (const [name, want] of STAGES.slice(1)) {
  /* `normal` is only the END of a corner if one has started, so the climb
   * shot waits for the settle to have gone past first. */
  const at = await runUntil(want, 900, false);
  await shoot(name);
  console.log(`  ${name.padEnd(10)} ${at < 0 ? 'NEVER REACHED' : `after ${at} more frames`}`);
}

for (const run of [false, true]) {
  await park(13);
  console.log(`  --- ${run ? 'RUN' : 'WALK'} ---`);
  const log = await cornerRun(run ? 500 : 900, run);
  for (const r of log) {
    console.log(`  f${String(r.f).padStart(3)} gap=${String(r.gap).padStart(6)} `
      + `up=${String(r.up).padStart(5)} hd=${String(r.head).padStart(5)} `
      + `ga=${String(r.gaster).padStart(5)}${r.inWood ? ' seated' : '       '}  ${r.line}`);
  }
  const armed = log.find((r) => !r.line.startsWith('normal'));
  console.log(armed
    ? `  armed at frame ${armed.f}, gap ${armed.gap} mm`
    : '  NEVER ARMED');
  await stop();
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
