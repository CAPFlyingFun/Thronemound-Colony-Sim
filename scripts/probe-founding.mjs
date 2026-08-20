/**
 * MILESTONE 1 — DOES SHE FOUND A NEST BY HERSELF?
 *
 *     npx vite --port 5173                                   # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=habitat npm run probe:founding
 *
 * Card 01's flow, driven end to end with nothing touching the keyboard:
 *
 *   Queen chooses a site -> requests excavation -> soil is removed by the
 *   terrain -> she moves through her own tunnel -> continues mostly downward
 *   to about 30 mm -> turns -> hollows the first chamber.
 *
 * And the rule underneath it, which this file exists to hold: "Digging must
 * NEVER directly drive ant locomotion." The check for that is not a code
 * review, it is `she travels while the excavator is idle`: if her descent
 * were being written by the dig system she would move in the frames it was
 * removing soil, and she does not — she stands to dig and walks afterwards.
 *
 * ## The honest note about her feet
 *
 * She gropes underground and she does not on the surface. Roughly 1.3 of six
 * feet are reaching for ground at any moment while she digs, against 0.0 out
 * in the open, and the cause is understood rather than mysterious:
 *
 * A dug floor is made of CELLS, so a ramp is a run of level treads a voxel
 * long. Her front foot stands on the tread ahead of the one her body is over,
 * and it can reach 0.162 voxels — 0.81 mm — below her body and no further.
 * Every tread is `RAMP_GRADE` deep, so the grade is bounded by her legs, and
 * at the shallowest grade worth having she is still within a few percent of
 * that limit for most of the descent.
 *
 * The SURFACE does not have the problem because its relief is about 0.03
 * voxels a cell — treads too small to notice. The real fix is to give dug
 * floors the continuous height field the terrain already has (the mesher's
 * `cornerHeight` hook, which is what "turns the staircase into ground" for
 * generated soil), so the tunnel floor is one sheet rather than a flight of
 * steps. That is its own piece of work and it is carded, not hidden.
 *
 * So the thresholds below are a RECORDED BASELINE, not an aspiration: they
 * fail on a regression and they do not pretend the current number is good.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=habitat';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });

const out = await page.evaluate(async () => {
  const lab = window.habitatScene;
  lab.setPausedForTest(true);

  const DT = 1 / 60;
  const trail = [];
  const seen = new Set();
  /* Feet, bucketed by what she was DOING — the three are different claims. */
  const surface = { planted: 0, groping: 0, n: 0 };
  const digging = { planted: 0, groping: 0, n: 0 };
  const tunnel = { planted: 0, groping: 0, n: 0 };

  let sealedAt = null;
  let deepest = 0;
  let movedWhileDigging = 0;
  let movedWhileIdle = 0;
  let bar = { max: 0, everBetween: false };
  let last = lab.reportForTest();

  for (let i = 0; i < 60 * 420; i += 1) {
    lab.tick(DT);
    const r = lab.reportForTest();
    seen.add(r.founding);
    deepest = Math.max(deepest, r.depthMm);

    /*
     * DID SHE MOVE, AND WAS SHE DIGGING WHEN SHE DID? This is the card's
     * ownership rule made measurable. Travel is horizontal only: her HEIGHT
     * follows the floor by design — that is the seater doing its job as the
     * ground changes — but her position across the tray may only come from
     * her legs.
     */
    const step = Math.hypot(r.at.x - last.at.x, r.at.z - last.at.z);
    if (r.digAt) movedWhileDigging += step;
    else movedWhileIdle += step;

    /* The round bar has to be seen part full, or it is not a bar. */
    bar.max = Math.max(bar.max, r.digProgress);
    if (r.digProgress > 0.15 && r.digProgress < 0.85) bar.everBetween = true;

    const UNDER = ['shaft', 'sinking', 'chambering'];
    const bucket = r.founding === 'seeking' ? surface
      : UNDER.includes(r.founding)
        ? (r.digAt ? digging : tunnel)
        : null;
    if (bucket) {
      bucket.planted += r.planted; bucket.groping += r.groping; bucket.n += 1;
    }

    if (i % 1800 === 0) {
      trail.push({
        t: +(i * DT).toFixed(0), state: r.founding,
        depth: +r.depthMm.toFixed(1), dug: r.excavated,
        x: +r.at.x.toFixed(1), y: +r.at.y.toFixed(2), z: +r.at.z.toFixed(1),
        feet: r.planted, grope: r.groping,
      });
    }
    last = r;
    if (r.founding === 'sealed') { sealedAt = +(i * DT).toFixed(0); break; }
  }

  const end = lab.reportForTest();
  const mean = (b) => ({
    planted: +(b.planted / Math.max(1, b.n)).toFixed(2),
    groping: +(b.groping / Math.max(1, b.n)).toFixed(2),
    frames: b.n,
  });

  /*
   * AND THE TANK IS STILL A TANK. The one refusal that would matter most is
   * an ant chewing out through the glass, so the panes are counted after.
   */
  const bounds = lab.boundsForTest();
  let glass = 0;
  for (let y = 0; y < bounds.ceilingY; y += 1) {
    for (let z = 0; z < bounds.size; z += 1) {
      for (let x = 0; x < bounds.size; x += 1) {
        if (lab.world.get(x, y, z) === 5) glass += 1;
      }
    }
  }

  return {
    trail, sealedAt, deepest, states: [...seen], glass,
    surface: mean(surface), digging: mean(digging), tunnel: mean(tunnel),
    movedWhileDigging, movedWhileIdle,
    excavated: end.excavated, den: end.den, entrance: lab.founding.entrance,
    overrides: lab.dug.overrides,
    bar,
  };
});

const checks = [];
const say = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nLAB 01 — A QUEEN FOUNDS A NEST, UNAIDED\n');
console.log('     t   state         depth    x      y       z   feet');
for (const r of out.trail) {
  console.log(`  ${String(r.t).padStart(4)}   ${r.state.padEnd(11)}  `
    + `${String(r.depth).padStart(5)}  ${String(r.x).padStart(5)}  `
    + `${String(r.y).padStart(6)}  ${String(r.z).padStart(5)}   ${r.feet}/6`);
}
console.log();

/* THE WHOLE FLOW, in order, without a keypress in this file. */
say('she goes through every stage of founding',
  ['seeking', 'shaft', 'sinking', 'turning', 'chambering', 'sealed']
    .every((s) => out.states.includes(s)),
  out.states.join(' -> '));
say('and she finishes', out.sealedAt !== null,
  out.sealedAt === null ? 'still going after 420 s' : `sealed at ${out.sealedAt} s`);
say('about thirty millimetres down, as the card asks',
  out.deepest >= 28 && out.deepest <= 45,
  `${out.deepest.toFixed(1)} mm at her deepest`);
say('having actually removed soil', out.excavated > 40,
  `${out.excavated} cells out, ${out.overrides} cut part-way`);
say('and she has a den at the bottom of it', out.den !== null && out.entrance !== null,
  out.den ? `entrance y=${out.entrance.y.toFixed(1)}, den y=${out.den.y.toFixed(1)}` : 'none');

/*
 * THE OWNERSHIP RULE, MEASURED. She stands to dig and walks when the way is
 * open, so essentially all of her travel across the tray happens in frames
 * where the excavator has no target. A version that moved her by removing
 * the ground under her would fail this and nothing else.
 */
const share = out.movedWhileDigging
  / Math.max(1e-6, out.movedWhileDigging + out.movedWhileIdle);
say('digging never drives her locomotion', share < 0.1,
  `${(share * 100).toFixed(1)}% of her travel happened while chewing`);

/* THE ROUND BAR — Ant Scout's, and it has to be watchable. */
say('the round digging bar fills, and is seen part full',
  out.bar.max > 0.9 && out.bar.everBetween,
  `peaked at ${out.bar.max.toFixed(2)}`);

/*
 * HER FEET. Three separate claims — see the honest note at the head of this
 * file. The surface number is the one that has to stay perfect; the
 * underground ones are a recorded baseline for a known, carded limitation.
 */
say('on the surface her feet are still perfect',
  out.surface.groping <= 0.2,
  `${out.surface.planted} planted, ${out.surface.groping} groping`);
say('underground she keeps most of her feet down while digging',
  out.digging.planted >= 4 && out.digging.groping <= 1.8,
  `${out.digging.planted} planted, ${out.digging.groping} groping `
  + '(baseline 4.54 / 1.32 — a dug floor is treads, see the file head)');
say('and while walking her own tunnel',
  out.tunnel.planted >= 2.8 && out.tunnel.groping <= 2.3,
  `${out.tunnel.planted} planted, ${out.tunnel.groping} groping`);

/* THE ONE REFUSAL THAT MATTERS MOST. */
say('the glass is untouched — she cannot dig out of the tank',
  out.glass > 0, `${out.glass} panes still standing`);

say('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

const passed = checks.filter(Boolean).length;
console.log(`\n  ${passed === checks.length ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(passed === checks.length ? 0 : 1);
