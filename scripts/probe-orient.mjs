/**
 * IS THE LANDSCAPE GATE WHERE IT BELONGS?
 *
 * The colony sim plays in either orientation and must NEVER show "ROTATE YOUR
 * DEVICE" — it was telling the player to fix a problem the game does not have.
 * The frozen island still shows it, because its HUD was laid out and measured
 * at a 932 x 430 landscape canvas and it is not going to learn portrait.
 *
 * Driven in a REAL portrait phone context — touch, mobile, 402 x 874 — because
 * the gate is `(orientation: portrait) and (pointer: coarse)` and a desktop
 * window narrowed to phone width matches neither.
 *
 *   npx vite --port 5177 &
 *   SMOKE_URL=http://127.0.0.1:5177/ node scripts/probe-orient.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const check = async (route, label) => {
  // A real touch phone in PORTRAIT — the case the gate fires on.
  const ctx = await browser.newContext({
    viewport: { width: 402, height: 874 }, deviceScaleFactor: 3,
    hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${route}${route.includes('?') ? '&' : '?'}cb=${Date.now()}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    const el = document.querySelector('.tm-orient-lock');
    const cs = el ? getComputedStyle(el) : null;
    return {
      display: cs ? cs.display : 'missing',
      covers: el ? el.getBoundingClientRect().height > 200 : false,
      attr: document.documentElement.hasAttribute('data-orient-lock'),
      pointer: matchMedia('(pointer: coarse)').matches,
      portrait: matchMedia('(orientation: portrait)').matches,
    };
  });
  console.log(`  ${label.padEnd(28)} lock=${r.display.padEnd(7)} covers=${String(r.covers).padEnd(5)}`
    + ` attr=${String(r.attr).padEnd(5)} coarse=${r.pointer} portrait=${r.portrait}`);
  await ctx.close();
  return r;
};
console.log('\nPORTRAIT PHONE (402x874, touch):\n');
const habitat = await check('', 'default (colony sim)');
const island  = await check('?scene=menu', 'the frozen island (?scene=menu)');
console.log();
const ok = habitat.display === 'none' && !habitat.covers
  && island.display === 'flex' && island.covers;
console.log(ok ? '  PASS — gate is gone from the game, kept on the island\n'
                : '  FAIL\n');
await browser.close();
process.exit(ok ? 0 : 1);
