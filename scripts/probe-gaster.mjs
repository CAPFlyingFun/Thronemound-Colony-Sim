/**
 * DOES HER ABDOMEN KEEP ITS RIDE HEIGHT?
 *
 * Reported from the device: "the abdomen still clips... can it try and stay
 * the normal idle height that it's above the ground? Like if it defaults to
 * 0.6 mm, it will float between 0.3 and 0.9 to not be so rigid."
 *
 * That is a ride height with a dead-band, and it is a different control law
 * from the one the gaster has. What it has is a PROXIMITY BIAS: nought at
 * 1.2 mm, ramping to the full nudge at 0.1 mm, and it only ever pushes the
 * tail AWAY. Nothing ever asks it to come back down, and nothing holds a
 * height — so on ground that falls away behind her the tail is free to sit
 * whereever the terrain pitch put it, and on ground that rises the bias is
 * a late shove rather than a held clearance.
 *
 * Before writing a band, this measures the thing the band would be made of:
 * what her abdomen's clearance ACTUALLY is, idle and moving, and how often
 * and how far it goes under. The number the request assumes — a 0.6 mm
 * default — is a guess from watching her, and the whole point of measuring
 * is that the band has to be built around the real one.
 *
 * Clearance here is the same quantity the spine consumes: the drawn shell's
 * distance to solid along her own down, in MILLIMETRES, negative when the
 * shell is already inside. Infinity — nothing within reach — is counted
 * separately rather than averaged in, because it is not a large clearance,
 * it is no reading at all.
 *
 *   npm run probe:gaster        # needs `vite preview` already running
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

  const watch = (steps) => {
    const seen = [];
    let none = 0;
    for (let i = 0; i < steps; i += 1) {
      s.stepForTest(0.023, 1);
      const c = s.shellClearance('gaster');
      if (!Number.isFinite(c)) { none += 1; continue; }
      seen.push(c * MM);
    }
    if (!seen.length) return { frames: steps, none, empty: true };
    const sorted = [...seen].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      frames: steps,
      none,
      mean: seen.reduce((a, b) => a + b, 0) / seen.length,
      min: sorted[0],
      p10: at(0.1),
      median: at(0.5),
      p90: at(0.9),
      max: sorted[sorted.length - 1],
      /* The two that say whether it is clipping, and how often. */
      underFrac: seen.filter((v) => v < 0).length / seen.length,
      lowFrac: seen.filter((v) => v < 0.3).length / seen.length,
    };
  };

  s.input.walk = 0;
  const standing = watch(150);
  s.input.walk = 1;
  const walking = watch(400);
  /* Turning hard drags the tail across ground it did not choose. */
  s.input.yaw = 1;
  const turning = watch(250);
  s.input.yaw = 0;
  s.input.walk = 0;
  s.stepForTest(0.023, 40);

  s.aimPitchForTest(-1.0);
  s.input.dig = true;
  s.stepForTest(0.023, 130);
  s.input.dig = false;
  const afterDig = watch(200);

  /* And the climb, where the tail sweeps the floor she is leaving — the
   * case the tail's own fold term was written for. */
  s.input.walk = 1;
  const climbing = watch(600);
  s.input.walk = 0;

  return { standing, walking, turning, afterDig, climbing };
});

const n = (v, w = 6) => (v === undefined ? '  --  ' : Number(v).toFixed(2).padStart(w));
const pc = (v) => `${(v * 100).toFixed(0)}%`;
console.log('her abdomen\'s clearance to solid, in millimetres\n');
console.log('              min    p10  median    p90     max    mean   under 0.3   clipping');
for (const [what, r] of Object.entries(out)) {
  if (r.empty) { console.log(`${what.padEnd(10)}  (no reading on any of ${r.frames} frames)`); continue; }
  console.log(`${what.padEnd(10)}${n(r.min)} ${n(r.p10)} ${n(r.median)} ${n(r.p90)} `
    + `${n(r.max)} ${n(r.mean)}     ${pc(r.lowFrac).padStart(4)}       ${pc(r.underFrac).padStart(4)}`
    + (r.none ? `   (no reading on ${r.none}/${r.frames})` : ''));
}

const fail = [];
/* The measurement has to WORK before the band built on it means anything:
 * standing on soil there is always something below her tail. */
if (out.standing.empty || out.standing.none > out.standing.frames * 0.2) {
  fail.push('no clearance reading under her abdomen while standing on the ground');
}
/*
 * A RATCHET, NOT A PASS MARK — and the difference is worth being plain about.
 *
 * The abdomen still clips while WALKING: 2% of frames, worst 0.53 mm in, with
 * the ride band in place (it was 0.70 mm without). The band did what it was
 * asked to — she holds her height and floats rather than sitting rigid, and
 * standing, turning and post-dig never go under at all — but it did not clear
 * the walking case, and a threshold set loose enough to call that a pass
 * would be a probe congratulating itself.
 *
 * So this is set just above where it stands. It cannot say "fixed"; it can
 * say "no worse", which is the honest job for it until the remaining cause is
 * dealt with. That cause is most likely RATE rather than authority — the
 * gaster chases at 5.5/s, a 180 ms time constant, and at walking pace the
 * ground under her tail changes faster than that.
 */
const CLIP_BUDGET = 0.03;
for (const [what, r] of Object.entries(out)) {
  if (r.empty) continue;
  if (r.underFrac > CLIP_BUDGET) {
    fail.push(`${what}: her abdomen is inside the ground on ${pc(r.underFrac)} of frames `
      + `(worst ${n(r.min).trim()} mm) — past the ${pc(CLIP_BUDGET)} this stands at`);
  }
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nno worse than it stands — see the note on CLIP_BUDGET; walking still clips');
