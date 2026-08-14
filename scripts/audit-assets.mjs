/**
 * ARE THE HUD PICTURES BIG ENOUGH FOR THE PHONE THEY ARE DRAWN ON?
 *
 *     npm run audit:assets
 *
 * The iPhone 15 Plus is 1290 x 2796 physical pixels at devicePixelRatio 3,
 * which is 430 x 932 LOGICAL — so the design canvas has been the right one
 * all along. What changes at 3x is not the layout, it is the RASTER: a
 * plate drawn at 84 logical px needs 252 real pixels behind it, and an
 * image with 192 gets upscaled by a third and goes soft.
 *
 * CSS and text look after themselves. Bitmaps do not, and nothing in the
 * build warns you — an under-resolved plate renders perfectly happily and
 * just looks slightly wrong on the one device that matters.
 *
 * So: read every `background-image` in the stylesheet, find the
 * `background-size` that goes with it, and compare the file's real pixels
 * against what 3x asks for. Static — no browser, no device — because the
 * question is arithmetic, not behaviour.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../src/scenes/DensityTerrainLabScene.css', import.meta.url));
const PUB = fileURLToPath(new URL('../public', import.meta.url));

/** The density the target device actually has. */
const DPR = 3;

/** Intrinsic pixels of a WebP or PNG, without decoding it. */
function sizeOf(file) {
  const d = readFileSync(file);
  if (d.slice(0, 4).toString('ascii') === 'RIFF') {
    const tag = d.slice(12, 16).toString('ascii');
    if (tag === 'VP8X') {
      return {
        w: d.readUIntLE(24, 3) + 1,
        h: d.readUIntLE(27, 3) + 1,
      };
    }
    if (tag === 'VP8L') {
      const bits = d.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (tag === 'VP8 ') {
      return { w: d.readUInt16LE(26) & 0x3fff, h: d.readUInt16LE(28) & 0x3fff };
    }
  }
  if (d.slice(1, 4).toString('ascii') === 'PNG') {
    return { w: d.readUInt32BE(16), h: d.readUInt32BE(20) };
  }
  return null;
}

/*
 * Walk the stylesheet rule by rule. A rule matters if it names a
 * `background-image` from /ui and gives a `background-size` in px — those
 * two together are "this picture, drawn this big".
 */
const css = readFileSync(CSS, 'utf8');
const rules = css.split('}');
const found = [];
for (const rule of rules) {
  const img = rule.match(/background-image:\s*url\(['"]([^'"]+)['"]\)/)
    ?? rule.match(/background:\s*url\(['"]([^'"]+)['"]\)/);
  if (!img || !img[1].startsWith('/ui/')) continue;
  const size = rule.match(/background-size:\s*([\d.]+)px\s+([\d.]+)px/)
    /* The shorthand form: `url(...) center / 62px 62px no-repeat`. */
    ?? rule.match(/\/\s*([\d.]+)px\s+([\d.]+)px/);
  if (!size) continue;
  const sel = rule.slice(0, rule.indexOf('{')).trim().split('\n').pop().trim();
  found.push({
    sel, url: img[1], cssW: Number(size[1]), cssH: Number(size[2]),
  });
}

console.log(`Raster HUD assets against devicePixelRatio ${DPR}\n`);
console.log('asset                 file px     drawn    needs@3x   headroom');

let short = 0;
const seen = new Set();
for (const f of found.sort((a, b) => a.url.localeCompare(b.url))) {
  const key = `${f.url}@${f.cssW}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const file = `${PUB}${f.url}`;
  if (!existsSync(file)) {
    console.log(`  ${f.url.padEnd(22)} MISSING`);
    short += 1;
    continue;
  }
  const px = sizeOf(file);
  if (!px) { console.log(`  ${f.url.padEnd(22)} unreadable`); continue; }
  const need = Math.round(f.cssW * DPR);
  const ratio = px.w / need;
  const flag = ratio >= 1 ? 'ok' : `SOFT x${ratio.toFixed(2)}`;
  if (ratio < 1) short += 1;
  console.log(
    `  ${f.url.replace('/ui/', '').padEnd(20)} ${String(px.w).padStart(4)}x${String(px.h).padEnd(4)}`
    + ` ${String(f.cssW).padStart(6)}px ${String(need).padStart(7)}px`
    + `   ${flag}`,
  );
}

console.log(short === 0
  ? '\nall assets carry enough pixels for a 3x screen'
  : `\n${short} asset(s) will be upscaled on a 3x screen`);
process.exit(0);
