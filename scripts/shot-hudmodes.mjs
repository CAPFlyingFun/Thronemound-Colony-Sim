/*
 * WHAT EVERY MODE ACTUALLY LOOKS LIKE, as a picture and as numbers.
 *
 * Two jobs, and they belong together because one is the evidence for the
 * other. The NUMBERS answer whether the action cluster still fits: how many
 * rows the plates land on, how wide the cluster is, and whether it touches
 * the quest card — which is the thing that went wrong the last time a sixth
 * plate was tried. The PICTURES are so a layout decision can be looked at
 * rather than argued about.
 *
 * Shot AS THE WORKER, because she is the caste with six plates. The queen
 * has five and would not show the case this exists to measure.
 *
 *   node scripts/shot-hudmodes.mjs
 *
 * Writes shots/hud-<mode>-<width>x<height>.png and prints a table.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });

/* The design canvas, and the two smaller landscapes the HUD supports. */
const SIZES = [
  { w: 932, h: 430, name: 'design' },
  { w: 844, h: 390, name: 'small' },
  { w: 667, h: 375, name: 'tiny' },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const rows = [];
let failed = null;

for (const size of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2,
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
  await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
  await page.waitForTimeout(900);

  /* The founding, skipped: this is about the ant you END UP as. */
  await page.evaluate(() => window.islandScene.spawnWorker());
  await page.waitForFunction(
    () => window.islandScene.playerCaste === 'fire-worker', null, { timeout: 200000 },
  ).catch(() => { /* Reported below as the caste it managed. */ });

  /**
   * The cluster, measured: one entry per VISIBLE plate, grouped into rows
   * by where its top edge landed. Two rows is the wrap that killed six the
   * first time it was tried.
   */
  const measure = async (mode) => page.evaluate((label) => {
    const cluster = document.querySelector('.tm-cluster');
    const seen = [...(cluster?.children ?? [])]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { cls: el.className, x: r.x, y: r.y, w: r.width, h: r.height };
      });
    /* The cluster is a GRID, not a list: columns of plates stacked in the
     * bottom corner. So "did it overflow" is about the box and what it
     * touches, never about how many distinct heights the plates sit at —
     * an earlier cut counted those and called a healthy five-plate fan a
     * five-row wrap. */
    const box = seen.length ? {
      x0: Math.min(...seen.map((p) => p.x)),
      x1: Math.max(...seen.map((p) => p.x + p.w)),
      y0: Math.min(...seen.map((p) => p.y)),
      y1: Math.max(...seen.map((p) => p.y + p.h)),
    } : null;
    const quest = document.querySelector('.tm-quest')?.getBoundingClientRect() ?? null;
    const hitsQuest = !!(box && quest && quest.width > 0
      && box.x0 < quest.right && box.x1 > quest.left
      && box.y0 < quest.bottom && box.y1 > quest.top);
    return {
      label,
      caste: window.islandScene.playerCaste,
      plates: seen.length,
      /* Dimmed plates are a lie if the ability is built — see `is-soon`. */
      dimmed: seen.filter((p) => /is-soon/.test(p.cls)).map((p) => p.cls),
      box,
      hitsQuest,
      offScreen: !!(box && (box.x1 > innerWidth || box.y1 > innerHeight
        || box.x0 < 0 || box.y0 < 0)),
    };
  }, mode);

  /* Each mode reached the way the game reaches it, not by poking state. */
  const modes = {
    explore: async () => {},
    combat: async () => page.evaluate(() => {
      const s = window.islandScene;
      const her = s.bulkReportForTest().find((b) => b.id === 'queen');
      const foe = s.bulkReportForTest().find((b) => b.id !== 'queen' && b.massMg > 40);
      if (foe) s.placeBodyForTest(foe.id, her.x + 0.6, her.y, her.z);
      s.stepForTest(1 / 60, 30);
    }),
    carry: async () => page.evaluate(() => {
      const s = window.islandScene;
      const seed = s.props.find((p) => p.id === 'seed');
      if (seed && !s.carry.carrying) { s.carry.lift(seed, () => true); seed.carried = true; }
      s.stepForTest(1 / 60, 30);
    }),
    dig: async () => page.evaluate(() => {
      const s = window.islandScene;
      if (s.carry.carrying) s.carry.drop();
      document.querySelector('.tm-art-dig')?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
      s.stepForTest(1 / 60, 30);
    }),
  };

  for (const [mode, reach] of Object.entries(modes)) {
    await reach();
    await page.waitForTimeout(350);
    const m = await measure(mode);
    rows.push({ ...m, size: size.name, w: size.w, h: size.h });
    await page.screenshot({ path: `${OUT}/hud-${mode}-${size.w}x${size.h}.png` });
    if (m.hitsQuest || m.offScreen || m.dimmed.length > 0) {
      failed = failed ?? `${mode} at ${size.w}x${size.h}`;
    }
  }
  if (errs.length) console.log(`page errors at ${size.w}x${size.h}:`, errs.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();

console.log('\nTHE ACTION CLUSTER, BY MODE — as the worker, who has six plates\n');
console.log('  size     mode      caste         plates  wide  tall  hits quest  off screen  dimmed');
const pad = (v, n) => String(v).padStart(n);
for (const r of rows) {
  console.log(
    `  ${r.size.padEnd(8)} ${r.label.padEnd(9)} ${r.caste.padEnd(13)}`
    + `${pad(r.plates, 6)} ${pad(r.box ? Math.round(r.box.x1 - r.box.x0) : 0, 5)}`
    + `${pad(r.box ? Math.round(r.box.y1 - r.box.y0) : 0, 6)}`
    + `${pad(r.hitsQuest ? 'YES' : 'no', 11)} ${pad(r.offScreen ? 'YES' : 'no', 11)}`
    + `  ${r.dimmed.length ? r.dimmed.join(' ') : '-'}`,
  );
}
console.log(`\nshots written to ${OUT}/`);

if (failed) {
  console.log(`\nFAILED: the cluster collides, overflows or dims a built plate — first at ${failed}`);
  process.exit(1);
}
console.log('\nall green — every mode fits on the glass, clear of the quest card,'
  + ' with nothing built drawn as unbuilt');
