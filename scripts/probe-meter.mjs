/**
 * IS THE CARRY BAR A BAR, OR A COIN?
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:meter
 *
 * Reported from an iPhone: a light load drew a green coin beside the
 * medallion instead of a short bar. The percentage was right; the shape was
 * not — so nothing that reads a number could have caught it, and nothing
 * that reads the CSS could either.
 *
 * A first attempt at fixing this (PR #11) was tested by asserting that
 * certain strings appeared in a stylesheet. Those assertions passed on a
 * build whose full bar had lost its round cap and grown a black notch. That
 * is the whole argument for this file: the meter is a picture, so the test
 * has to look at the picture. `CLAUDE.md` says as much — "test the
 * device-visible symptom, not merely internal CSS values".
 *
 * So this renders the real HUD at the real design canvas, screenshots the
 * real meter, and COUNTS GREEN PIXELS. No image library: PNG is inflate plus
 * five filter rules, and the repo does not need a dependency to look at
 * fifty by two hundred pixels.
 */
import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';

/* ---------------------------------------------------- a very small PNG */

/** Decode an 8-bit RGB/RGBA PNG into { width, height, rgba }. */
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0; let height = 0; let colorType = 6; let depth = 8;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported png: depth ${depth}, colour type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, rgba: out, channels };
}

/**
 * The painted fill, measured. Green-dominant rather than an exact colour
 * match, because the bar is drawn through a soft-edged mask and its rim
 * pixels are blends.
 */
function greenBox(png) {
  const { width, height, rgba, channels } = png;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      const r = rgba[i]; const g = rgba[i + 1]; const b = rgba[i + 2];
      const a = channels === 4 ? rgba[i + 3] : 255;
      if (a > 40 && g > 90 && g > r + 25 && g > b + 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        n += 1;
      }
    }
  }
  if (!n) return { w: 0, h: 0, px: 0, fill: 0 };
  const w = maxX - minX + 1; const h = maxY - minY + 1;
  return { w, h, px: n, fill: n / (w * h) };
}

/* ------------------------------------------------------------ the run */

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);

const LOADS = [0.05, 0.1, 0.25, 0.5, 1];
const seen = [];
for (const level of LOADS) {
  /* Driven at the meter rather than by filling her jaws: what is under test
   * is the DRAWING of a level, and a real haul cannot hit 5% on demand. */
  await page.evaluate((v) => {
    const el = document.querySelector('.tm-meter-carry');
    el.classList.add('is-loaded');
    el.style.setProperty('--tm-level', String(v));
    el.style.setProperty('--tm-level-paint', '#5f9e33');
  }, level);
  /* Past the 0.2s width transition, with room for a throttled compositor. */
  await page.waitForTimeout(900);
  const clip = await page.evaluate(() => {
    const r = document.querySelector('.tm-meter-carry').getBoundingClientRect();
    return {
      x: Math.floor(r.x), y: Math.floor(r.y),
      width: Math.ceil(r.width), height: Math.ceil(r.height),
    };
  });
  seen.push({ level, ...greenBox(readPng(await page.screenshot({ clip }))) });
}

const checks = [];
const say = (name, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nTHE CARRY BAR, AS DRAWN\n');
console.log('   load    width   height   filled');
for (const s of seen) {
  console.log(`  ${String(Math.round(s.level * 100)).padStart(4)}%   ${String(s.w).padStart(5)}   `
    + `${String(s.h).padStart(6)}   ${s.fill.toFixed(2)}`);
}
console.log();

const low = seen[1];        // 10%
const full = seen[seen.length - 1];

/*
 * A COIN IS SHORT AND ROUND; A BAR IS LONGER THAN THE CAPS THAT END IT. The
 * two fixed caps are 2.7 and 7.33 CSS px, so anything at or under about ten
 * is cap and nothing else — which is exactly what the reported bug looked
 * like. Eighteen leaves real bar between them at a tenth of a load.
 */
say('a light load draws a BAR, not a coin', low.w >= 18,
  `10% is ${low.w}px wide`);
/* And it is a solid bar rather than a wedge with holes at its corners. */
say('and that bar fills its channel', low.fill >= 0.78, `${low.fill.toFixed(2)} filled`);

say('a full load reaches the end of the channel', full.w >= 128,
  `${full.w}px of 131.5`);
/*
 * The round cap and the tuck under the gold, in one number. A squared-off
 * end with a notch bitten out of it — the failure mode of the first attempt
 * at this fix — reads as a hole in the fill and drops this below 0.9.
 */
say('with its cap intact', full.fill >= 0.9, `${full.fill.toFixed(2)} filled`);

/* The channel is 17.2px tall and the fill must stay inside the gold. */
const tallest = Math.max(...seen.map((s) => s.h));
say('the fill never spills over the rim', tallest <= 19, `tallest ${tallest}px`);

let rises = true;
for (let i = 1; i < seen.length; i += 1) if (seen[i].w <= seen[i - 1].w) rises = false;
say('and it grows with the load', rises, seen.map((s) => s.w).join(' → '));

say('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = checks.filter(Boolean).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);
await browser.close();
process.exit(ok ? 0 : 1);
