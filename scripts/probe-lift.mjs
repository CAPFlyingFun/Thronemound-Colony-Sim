/**
 * HOW HIGH CAN SHE LIFT HER BODY WITH HER FEET WHERE THEY ARE?
 *
 * Asked from the device, about a proposed law: put a sphere round each of
 * the three body segments, and when one starts to clip terrain raise that
 * piece and "the legs will naturally stretch as far as it can". Before
 * building any of that, the question that decides whether it is a real tool
 * or a token gesture — keeping the feet planted and moving the body straight
 * up along her own up, how far can it actually go, and what clearance does
 * that buy?
 *
 * It is worth asking because the answer is bounded by the RIG, not by the
 * code. `REACH_DOWN_MM` is measured hip-to-sole on the real skeleton — the
 * spare a leg has past the pose it stands in — and it is about a millimetre
 * at the front and middle. Whether a millimetre is enough is exactly the
 * thing to know before writing a controller that spends it.
 *
 * MEASURED BY MOVING HER, not by trusting the table. The lift is applied to
 * the physics root and the frame is then stepped with dt = 0, which poses
 * and solves the legs without the walker easing her back down — the seat is
 * a lerp on dt, so a zero-length frame re-solves the body without re-seating
 * it. What is reported at each height is what her legs and her shells
 * actually did, and the height it stops at is where the SKELETON stops
 * reaching — the drawn foot leaving its anchor — rather than where a
 * constant said it would.
 *
 *   npm run probe:lift        # needs `vite preview` already running
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({
  viewport: { width: 900, height: 600 },
  serviceWorkers: 'block',
});
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island${process.env.Q ?? ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 200000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 200000 },
);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  const MM = 5;

  /* Stand her still and let the seat settle before anything is moved. */
  s.input.walk = 0;
  s.stepForTest(0.023, 120);

  /*
   * THE FOOT LEAVING ITS ANCHOR IS THE LIMIT, and it needs no constant to
   * be believed.
   *
   * Two calibrated measures were tried first and both read past their limit
   * while she stood comfortably still: root-to-foot over a hip-to-sole
   * maximum (two different origins, my error), and then hip-to-foot over
   * `straightReach`, which still read 1.046 at rest because the anchor is
   * the ground CONTACT and `reach` was measured to the last bone, a foot
   * clearance above it. Rather than chase that offset, this asks the
   * skeleton directly: the solver puts the drawn foot on the anchor while it
   * can reach, so the millimetres between drawn foot and anchor ARE the
   * shortfall, nought until the leg runs out and growing after.
   */
  const tipOf = {};
  for (const chain of s.queen.rig.legs) {
    const name = s.queen.limbTipName(chain.slot);
    tipOf[chain.slot] = name ? s.queen.bones.get(name) ?? null : null;
  }
  const legsOf = () => s.drive.legs.map((l) => {
    const tip = tipOf[l.slot];
    let shortMm = 0;
    if (tip) {
      tip.updateWorldMatrix(true, false);
      const e = tip.matrixWorld.elements;
      shortMm = Math.hypot(
        l.anchor.x - e[12], l.anchor.y - e[13], l.anchor.z - e[14],
      ) * MM;
    }
    return {
      slot: l.slot, planted: l.planted, groping: l.groping, shortMm,
    };
  });

  const base = { x: s.at.x, y: s.at.y, z: s.at.z };
  const up = { x: s.up.x, y: s.up.y, z: s.up.z };
  const start = {
    head: s.shellClearance('head') * MM,
    gaster: s.shellClearance('gaster') * MM,
    legs: legsOf(),
    downMm: s.drive.legs.map((l) => ({ slot: l.slot, mm: +(l.down * MM).toFixed(2) })),
    reachMm: s.drive.legs.map((l) => ({ slot: l.slot, mm: +(l.straightReach * MM).toFixed(2) })),
  };

  /* Walk the body straight up her own up, a tenth of a millimetre at a
   * time, re-solving at each height. dt = 0 poses without re-seating. */
  const rungs = [];
  for (let mm = 0; mm <= 4.0001; mm += 0.1) {
    const d = mm / MM;
    s.at.set(base.x + up.x * d, base.y + up.y * d, base.z + up.z * d);
    s.stepForTest(0, 1);
    const legs = legsOf();
    rungs.push({
      mm: +mm.toFixed(1),
      head: +(s.shellClearance('head') * MM).toFixed(3),
      gaster: +(s.shellClearance('gaster') * MM).toFixed(3),
      worstShort: +Math.max(...legs.map((l) => l.shortMm)).toFixed(3),
      planted: legs.filter((l) => l.planted).length,
      /* Which leg runs out first — the binding constraint by name. */
      binding: legs.reduce((a, b) => (b.shortMm > a.shortMm ? b : a)).slot,
    });
  }

  /* Put her back where she was, and let her re-settle honestly. */
  s.at.set(base.x, base.y, base.z);
  s.stepForTest(0.023, 60);

  return { start, rungs };
});

const n = (v, w = 7) => Number(v).toFixed(3).padStart(w);
console.log('THE RIG\'S OWN SPARE, per leg (hip-to-sole, measured on the skeleton)');
console.log('  ' + out.start.downMm.map((d) => `${d.slot} ${d.mm}`).join('   '));
console.log('\nSTANDING: head clear ' + out.start.head.toFixed(3)
  + ' mm, abdomen clear ' + out.start.gaster.toFixed(3) + ' mm');

console.log('\nLIFTING HER STRAIGHT UP, feet where they are\n');
/* A tenth of a millimetre of shortfall is the solver's own residual, not a
 * leg out of leg — it never lands exactly on the anchor. Past that she is
 * genuinely reaching and the foot is being left behind. */
const SLACK = 0.1;
console.log('  lift    head   abdomen   foot short   binding');
let lost = null;
for (const r of out.rungs) {
  if (Math.round(r.mm * 10) % 5 !== 0 && r.worstShort < SLACK) continue;
  console.log(`  ${n(r.mm, 4)} ${n(r.head)} ${n(r.gaster)}    ${n(r.worstShort, 6)}      `
    + `${r.binding}`);
  if (lost === null && r.worstShort >= SLACK) lost = r;
}

/*
 * The last height at which every leg is still within its measured reach.
 * `planted` is NOT part of this test: the frames here are stepped with
 * dt = 0 so the body re-solves without the drive re-deciding anything, which
 * means no foot is ever dropped however far she is lifted. The honest limit
 * is the geometry — a leg past its straight-leg maximum — not a flag that
 * cannot change.
 */
const top = out.rungs.filter((r) => r.worstShort < SLACK).pop();
if (top) {
  console.log(`\nSHE RUNS OUT OF LEG AT ${top.mm.toFixed(1)} mm of lift `
    + `(${top.binding} first), and that buys`);
  console.log(`  head    ${out.start.head.toFixed(2)} -> ${top.head.toFixed(2)} mm `
    + `(+${(top.head - out.start.head).toFixed(2)})`);
  console.log(`  abdomen ${out.start.gaster.toFixed(2)} -> ${top.gaster.toFixed(2)} mm `
    + `(+${(top.gaster - out.start.gaster).toFixed(2)})`);
} else {
  console.log('\nNo height was reachable with all six feet down — see the table.');
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
