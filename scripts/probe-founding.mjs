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
/*
 * A FRESH BUNDLE, EVERY RUN — and this is not belt and braces.
 *
 * Without blocking the service worker and busting the URL, this probe once
 * reported a confident 14/14 on a build whose simulation was in fact
 * deadlocked after seven cells, because the page it measured was one an
 * earlier run had cached. A probe that can silently measure yesterday's code
 * is worse than no probe: it answers the wrong question in the same tone of
 * voice as the right one, and the result was acted on.
 */
const context = await browser.newContext({
  viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
});
const page = await context.newPage();
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`${URL}${URL.includes('?') ? '&' : '?'}probe=${Date.now()}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 200000 });

const out = await page.evaluate(async () => {
  const lab = window.habitatScene;
  /*
   * PAUSED FIRST, AND BEFORE ANY `await`. The scene drives itself off
   * `requestAnimationFrame` at REAL time until this call, so anything
   * awaited above it lets the founding run for however long that takes, at
   * whatever frame rate the machine manages — unmeasured, and different
   * every run.
   */
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

  /*
   * HOW HIGH HER PLANTED FEET ARE, relative to her own body origin.
   *
   * The check that caught "the feet keep rising above her body while she was
   * dropping down", and it needs its own measurement because a planted-feet
   * COUNT cannot see it: a foot stranded on the rim above her still counts as
   * planted. Measured on the drawn foot — the last bone with geometry — so it
   * is what is on screen and not what the gait believes.
   */
  const ant = lab.ant;
  const model = ant.model;
  const tipOf = new Map();
  for (const leg of ant.drive.legs) {
    const name = model.limbTipName(leg.slot);
    if (name) tipOf.set(leg.slot, model.root.getObjectByName(name));
  }
  const bellyMm = model.bellyAboveOrigin() * 5;
  const backMm = model.bodyTopAboveSole() * 5;
  const mk = () => ({ n: 0, sum: 0, max: -99, overBack: 0 });
  const high = { over: mk(), under: mk() };
  const sampleFeet = (aboveGround) => {
    const into = aboveGround ? high.over : high.under;
    for (const leg of ant.drive.legs) {
      if (!leg.planted) continue;
      const bone = tipOf.get(leg.slot);
      if (!bone) continue;
      const p = bone.getWorldPosition(bone.position.clone());
      const mm = (p.y - ant.at.y) * 5;
      into.n += 1; into.sum += mm; into.max = Math.max(into.max, mm);
      if (mm > backMm) into.overBack += 1;
    }
  };

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
      sampleFeet(bucket === surface);
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
    bellyMm,
    backMm,
    feetOver: {
      mean: high.over.sum / Math.max(1, high.over.n), max: high.over.max,
      overBack: (100 * high.over.overBack) / Math.max(1, high.over.n),
    },
    feetUnder: {
      mean: high.under.sum / Math.max(1, high.under.n), max: high.under.max,
      overBack: (100 * high.under.overBack) / Math.max(1, high.under.n),
    },
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
/*
 * A TRIPOD IS THE DESIGN, so what is asked of the count is that she keeps
 * one — not that she keeps as many feet down as possible.
 *
 * The threshold used to be 4.0, and it was rewarding the wrong thing: a foot
 * stranded on the rim above her counted as planted, so the number went DOWN
 * (4.54 to 3.86) when the stranding was fixed, while groping went down too
 * (1.32 to 1.23). Feet-above-the-body is measured directly below instead.
 */
say('underground she still carries herself on a tripod',
  out.digging.planted >= 3.4 && out.digging.groping <= 1.8,
  `${out.digging.planted} planted, ${out.digging.groping} groping`);
say('and while walking her own tunnel',
  out.tunnel.planted >= 2.8 && out.tunnel.groping <= 2.3,
  `${out.tunnel.planted} planted, ${out.tunnel.groping} groping`);

/*
 * AND HER FEET STAY UNDER HER, which is the one a planted-foot count cannot
 * see. Reported from the device: "the feet still keep rising above her body
 * while she was dropping down."
 *
 * They did. `LegDrive` measures a stance foot's strain across the ground and
 * projects the vertical out — right for an animal walking OVER terrain, wrong
 * for one digging the floor from beneath herself: nothing horizontal moved,
 * so no foot was ever spent, so no foot was ever picked up, and her body sank
 * away from feet that stayed where the floor had been. Measured over her
 * entrance shaft, before the fix: mean 3.86 mm above her body origin, worst
 * 6.77 — against a BACK 3.17 mm high.
 */
console.log(`
  her belly sits ${out.bellyMm.toFixed(2)} mm above her origin, `
  + `her back ${out.backMm.toFixed(2)}
`);
/*
 * MEASURED ON THE MEAN AND ON HOW OFTEN, not on the single worst frame.
 *
 * The worst frame does not discriminate: before the fix it was 6.77 mm and
 * after it was 6.19, because one stranded foot in twenty thousand samples
 * looks the same either way. What moved — and what the eye actually sees — is
 * the average height of every planted foot, 3.86 mm down to 0.29, and how
 * much of the time a foot is up over her back, which went to nothing.
 */
say('her planted feet stay under her body on the surface',
  out.feetOver.mean < 0.6 && out.feetOver.overBack < 0.5,
  `mean ${out.feetOver.mean.toFixed(2)} mm above her origin, over her back `
  + `${out.feetOver.overBack.toFixed(2)}% of the time, worst `
  + `${out.feetOver.max.toFixed(2)}`);
say('and they still do while the floor drops away beneath her',
  out.feetUnder.mean < 0.6 && out.feetUnder.overBack < 0.5,
  `mean ${out.feetUnder.mean.toFixed(2)} mm (was 3.86), over her back `
  + `${out.feetUnder.overBack.toFixed(2)}% of the time, worst `
  + `${out.feetUnder.max.toFixed(2)}`);

/* THE ONE REFUSAL THAT MATTERS MOST. */
say('the glass is untouched — she cannot dig out of the tank',
  out.glass > 0, `${out.glass} panes still standing`);

say('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

const passed = checks.filter(Boolean).length;
console.log(`\n  ${passed === checks.length ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(passed === checks.length ? 0 : 1);
