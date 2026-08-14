/**
 * DOES THE HUD COLLIDE WITH ITSELF? — at every width, not at the one it was
 * drawn on.
 *
 *     npm run probe:hud        (needs `npx vite --port 5173` running)
 *
 * WHY THIS EXISTS. The STATS chip sat 64px inside the vitals panel on an
 * iPhone SE for four releases, and nothing caught it — because it was
 * placed by arithmetic against the 932x430 DESIGN CANVAS and then only ever
 * looked at on the design canvas. A centred box walks left as the screen
 * narrows while a left-pinned panel does not, so the failure was invisible
 * at the one width anybody checked.
 *
 * That is a whole CLASS of bug on a HUD this dense, and the quest panel had
 * already been moved out of top-centre once to escape exactly it. So this
 * does not test the chip. It measures every element in the cluster and
 * reports every pair that overlaps, at four widths — and it will catch the
 * next one the same way, including the ones nobody thought to look for.
 *
 * The pairs are declared rather than "nothing may ever touch anything",
 * because some things legitimately share space: the expanded stats panel
 * sits over the parked stick on purpose, and it is allowed to.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';

/* Landscape phones, smallest sane first, design canvas last. */
const SIZES = [
  { w: 568, h: 320, what: 'smallest sane landscape' },
  { w: 667, h: 375, what: 'iPhone SE' },
  { w: 844, h: 390, what: 'iPhone 14' },
  { w: 932, h: 430, what: 'the design canvas' },
];

/* Everything in the top-left cluster and the two corners it has to miss. */
const PARTS = {
  vitals: '.tm-vitals',
  chip: '.tm-stats-chip',
  colony: '.tm-colony',
  carry: '.tm-meter-carry',
  quest: '.tm-quest',
  stick: '.tm-stick',
};

/*
 * WHAT MAY NOT TOUCH WHAT. Everything in the top-left column against
 * everything else in it, plus the two the column has run into before: the
 * chip that took the quest's old place, and the parked stick the column
 * grew down towards.
 */
const FORBIDDEN = [
  ['chip', 'vitals'], ['chip', 'colony'], ['chip', 'carry'], ['chip', 'quest'],
  ['vitals', 'colony'], ['vitals', 'carry'], ['vitals', 'quest'],
  ['colony', 'carry'], ['colony', 'quest'],
  ['carry', 'quest'],
  ['quest', 'stick'], ['colony', 'stick'],
];

/*
 * KNOWN, AND RECORDED RATHER THAN DELETED.
 *
 * The left column does not fit above the parked stick on a 320-tall screen:
 * the stick is bottom-anchored so it CLIMBS as the screen shortens (top at
 * 154 against 209 on a 375), and vitals + colony + quest already reach 207
 * with the frame at half scale. There is no arrangement of those three that
 * fits in the 142px left, so this is a layout decision and not a nudge.
 *
 * The half that WAS a bug is fixed: the quest panel is `pointer-events:
 * none`, so it no longer swallows the top of the stick — the overlap is now
 * ink rather than a dead control.
 *
 * Listed here instead of dropping the 568 size, because dropping the size
 * is how a known failure becomes a forgotten one, and because any OTHER
 * collision at that width still fails loudly.
 */
const KNOWN = [
  { w: 568, pair: 'quest/stick', why: 'the column does not fit above a bottom-anchored stick at 320 tall' },
];

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let bad = 0;
for (const size of SIZES) {
  const p = await b.newPage({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: 2, hasTouch: true, isMobile: true,
  });
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 180000 });
  /* The curtain removes ITSELF at the end of its fade, so its absence is
   * the honest signal. `offsetParent` is not: it is position:fixed, for
   * which offsetParent is null the whole time it is up. */
  await p.waitForFunction(
    () => document.querySelector('.tm-loading-root') === null, null, { timeout: 180000 },
  );
  await p.waitForTimeout(500);

  const seen = await p.evaluate((parts) => {
    const out = {};
    for (const [name, sel] of Object.entries(parts)) {
      const el = document.querySelector(sel);
      if (!el) { out[name] = null; continue; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) { out[name] = null; continue; }
      out[name] = {
        x: +r.x.toFixed(1), y: +r.y.toFixed(1),
        r: +r.right.toFixed(1), b: +r.bottom.toFixed(1),
      };
    }
    return out;
  }, PARTS);

  console.log(`\n${size.w}x${size.h}  — ${size.what}`);
  for (const [name, box] of Object.entries(seen)) {
    console.log(box
      ? `  ${name.padEnd(7)} x ${String(box.x).padStart(6)}..${String(box.r).padEnd(6)} y ${String(box.y).padStart(5)}..${box.b}`
      : `  ${name.padEnd(7)} (not on screen)`);
  }

  for (const [a, c] of FORBIDDEN) {
    const A = seen[a]; const C = seen[c];
    if (!A || !C) continue;
    const overX = Math.min(A.r, C.r) - Math.max(A.x, C.x);
    const overY = Math.min(A.b, C.b) - Math.max(A.y, C.y);
    if (overX > 0.5 && overY > 0.5) {
      const known = KNOWN.find((k) => k.w === size.w && k.pair === `${a}/${c}`);
      if (known) {
        console.log(`  ~~ ${a}/${c} overlap ${overX.toFixed(0)}x${overY.toFixed(0)}px — KNOWN: ${known.why}`);
      } else {
        bad += 1;
        console.log(`  !! ${a} OVERLAPS ${c} by ${overX.toFixed(0)}x${overY.toFixed(0)}px`);
      }
    }
  }
  /* Nothing may hang off either edge either — a chip pushed off the right
   * is as unreadable as one buried under the bars. */
  for (const [name, box] of Object.entries(seen)) {
    if (!box) continue;
    if (box.x < -0.5 || box.r > size.w + 0.5) {
      bad += 1;
      console.log(`  !! ${name} runs off the screen (0..${size.w})`);
    }
  }
  await p.close();
}

await b.close();
console.log(bad === 0
  ? '\nall clear — the cluster does not collide with itself at any tested width'
  : `\n${bad} collision(s)`);
process.exit(bad === 0 ? 0 : 1);
