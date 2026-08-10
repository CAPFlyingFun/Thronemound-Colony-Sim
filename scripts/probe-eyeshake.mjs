/**
 * HOW MUCH DOES THE FIRST-PERSON LENS SHAKE, AND WITH WHAT?
 *
 * Reported after the lens was put on the head bone: it shakes with each
 * animation. It did, and for the obvious reason — her head is animated, so
 * reading the bone for ORIENTATION fed the gait straight into the view.
 * That mounting has since been pulled back to placement only, which is what
 * it was asked for; this stays as the instrument that measures the cost of
 * ever pointing the lens at an animated thing again.
 *
 * The number that matters is not how far the view moves, which is supposed
 * to move: it is how much of that movement REVERSES every frame. A camera
 * carried round onto a trunk sweeps one way; a camera shaking changes its
 * mind constantly. So this reports both — the mean per-frame swing, and the
 * mean second difference, which is near zero for a smooth sweep and as
 * large as the swing itself for a shake.
 *
 * Walking is the case; standing still is the control.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/probe-eyeshake.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 150000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 150000 },
);
await page.waitForTimeout(1200);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  s.firstPerson = true;
  const DEG = 180 / Math.PI;

  const sample = (walk, steps) => {
    s.input.walk = walk;
    s.stepForTest(0.023, 60);            // let the gait reach its stride
    const look = [];
    const roll = [];
    for (let i = 0; i < steps; i += 1) {
      s.stepForTest(0.023, 1);
      const f = { x: s.lookDir.x, y: s.lookDir.y, z: s.lookDir.z };
      look.push(f);
      /*
       * TRUE ROLL, which is not "how much camera.up moved". Up is forced to
       * move whenever FORWARD moves, so measuring it directly reports pitch
       * as roll. This is the angle of the lens's up about the view axis,
       * measured from world up squared to the same axis — the horizon's own
       * tilt, and the only part a player reads as rolling.
       */
      const wu = { x: 0, y: 1, z: 0 };
      const k = wu.x * f.x + wu.y * f.y + wu.z * f.z;
      const ref = { x: wu.x - f.x * k, y: wu.y - f.y * k, z: wu.z - f.z * k };
      const rl = Math.hypot(ref.x, ref.y, ref.z);
      /*
       * Near-vertical views have no meaningful roll reference — world up
       * projects to almost nothing and the angle spins on rounding noise,
       * which is where a spurious 40-degree "roll" peak came from. Skipped
       * rather than measured: within about seventeen degrees of straight up
       * or down there IS no horizon to be tilted.
       */
      if (rl < 0.3) { roll.push(null); continue; }
      ref.x /= rl; ref.y /= rl; ref.z /= rl;
      const u = s.camera.up;
      const cross = {
        x: ref.y * u.z - ref.z * u.y,
        y: ref.z * u.x - ref.x * u.z,
        z: ref.x * u.y - ref.y * u.x,
      };
      roll.push(Math.atan2(
        cross.x * f.x + cross.y * f.y + cross.z * f.z,
        ref.x * u.x + ref.y * u.y + ref.z * u.z,
      ) * DEG);
    }
    s.input.walk = 0;
    const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1,
      a.x * b.x + a.y * b.y + a.z * b.z))) * DEG;
    const swings = [];
    for (let i = 1; i < look.length; i += 1) swings.push(ang(look[i - 1], look[i]));
    const rolls = [];
    for (let i = 1; i < roll.length; i += 1) {
      if (roll[i] === null || roll[i - 1] === null) continue;
      let d = roll[i] - roll[i - 1];
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      rolls.push(Math.abs(d));
    }
    /*
     * The reversal term. A smooth sweep has a nearly constant per-frame
     * swing, so its second difference is small; a shake alternates, so its
     * second difference is as big as the swing. This is what the eye reads
     * as shaking rather than moving.
     */
    const jitter = [];
    for (let i = 1; i < swings.length; i += 1) jitter.push(Math.abs(swings[i] - swings[i - 1]));
    const mean = (a) => a.reduce((x, v) => x + v, 0) / Math.max(1, a.length);
    return {
      swing: mean(swings), swingPeak: Math.max(...swings),
      roll: mean(rolls), rollPeak: Math.max(...rolls),
      jitter: mean(jitter), jitterPeak: Math.max(...jitter),
    };
  };

  const still = sample(0, 200);
  const walking = sample(1, 300);
  return { still, walking };
});

const n = (v) => Number(v).toFixed(3);
for (const [name, r] of Object.entries(out)) {
  console.log(`${name.padEnd(8)} look ${n(r.swing)}°/frame (peak ${n(r.swingPeak)})  `
    + `roll ${n(r.roll)}°/frame (peak ${n(r.rollPeak)})  `
    + `reversal ${n(r.jitter)}° (peak ${n(r.jitterPeak)})`);
}

const fail = [];
/* Standing still she must be rock steady — the seat buzz is long fixed. */
if (out.still.swing > 0.05) fail.push(`the lens moves ${n(out.still.swing)}°/frame at rest`);
/*
 * Walking she SHOULD move — the head leads her round corners and over
 * crests, and killing that would be killing the thing the head mount was
 * for. What must be small is the reversal: movement that changes its mind
 * every frame is shake, not animation.
 */
if (out.walking.jitter > 0.30) {
  fail.push(`the walking lens reverses ${n(out.walking.jitter)}°/frame — that is the shake`);
}
if (out.walking.roll > 0.45) {
  fail.push(`the walking lens rolls ${n(out.walking.roll)}°/frame`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — the lens moves with her without shaking');
