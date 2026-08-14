/**
 * THE CARRY FILL, CUT OUT OF JOSHUA'S SHEET.
 *
 *     npm run gen:meter-fill -- <path-to-sheet.png>
 *
 * The fill is drawn ART, not a CSS shape, and that is the point: five goes
 * at describing the channel with insets, radii and traced masks were each
 * off somewhere, because the channel is what is left over when a nine-sliced
 * photograph of a gold frame is drawn at 165 x 34 — a shape with a CONCAVE
 * left end, where the stone runs up against the medallion, and a rounded
 * right cap. Joshua drew the bar to match the sheet instead, which settles
 * it: the shape is now something to place, not something to derive.
 *
 * The sheet holds the frame and the bar as two separate blobs, at 4x the
 * source art (the frame band measures 1139 x 509 against frame-meter.webp's
 * 285 x 128). This finds the bar by looking for the one that is YELLOW,
 * crops it, and writes it out on its own.
 *
 * IT ALSO MEASURES THE CAPS, because the bar has to grow and shrink. A bar
 * that is scaled would stretch its round end into an oval as it filled; one
 * that is simply clipped would lose the end altogether at anything under
 * full. So it is nine-sliced horizontally — ends fixed, middle stretched —
 * and the two numbers printed here are where those ends stop.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sheet = process.argv[2];
if (!sheet) {
  console.error('usage: npm run gen:meter-fill -- <path-to-sheet.png>');
  process.exit(1);
}
const OUT = fileURLToPath(new URL('../public/ui/fill-meter.png', import.meta.url));

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage();

const out = await p.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, c.width, c.height);
  const w = im.width; const h = im.height;
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return { r: im.data[i], g: im.data[i + 1], b: im.data[i + 2], a: im.data[i + 3] };
  };
  /*
   * FIND THE BAR AS A BLOB, not as a colour. Testing for "yellow" catches
   * the frame as well — its gold is warm enough to pass any threshold loose
   * enough to catch the bar — and the answer came back as the whole sheet.
   *
   * The two live in separate horizontal BANDS with clear rows between, so
   * the bands are found first and then judged: the bar is flat colour, the
   * frame is a photograph, and the giveaway is how little the bar's pixels
   * vary from their own average.
   */
  const rowFilled = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (at(x, y).a > 30) n++;
    rowFilled.push(n);
  }
  const bands = []; let s = -1;
  for (let y = 0; y < h; y++) {
    if (rowFilled[y] > 0 && s < 0) s = y;
    else if (rowFilled[y] === 0 && s >= 0) { bands.push([s, y - 1]); s = -1; }
  }
  if (s >= 0) bands.push([s, h - 1]);
  if (!bands.length) throw new Error('the sheet appears to be empty');

  const scored = bands.map(([by0, by1]) => {
    let bx0 = w; let bx1 = -1; let n = 0;
    let sr = 0; let sg = 0; let sb = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = 0; x < w; x++) {
        const q = at(x, y);
        if (q.a < 120) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        n++; sr += q.r; sg += q.g; sb += q.b;
      }
    }
    const mr = sr / n; const mg = sg / n; const mb = sb / n;
    let dev = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = 0; x < w; x++) {
        const q = at(x, y);
        if (q.a < 120) continue;
        dev += Math.abs(q.r - mr) + Math.abs(q.g - mg) + Math.abs(q.b - mb);
      }
    }
    return { by0, by1, bx0, bx1, flatness: dev / n, warm: mr - mb };
  });
  /* Flattest band that is also warm — the drawn bar. */
  const bar = scored.filter((z) => z.warm > 40).sort((a2, b2) => a2.flatness - b2.flatness)[0];
  if (!bar) throw new Error('could not tell the bar from the frame');
  const x0 = bar.bx0; const y0 = bar.by0; const x1 = bar.bx1; const y1 = bar.by1;

  const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
  const oc = document.createElement('canvas');
  oc.width = bw; oc.height = bh;
  oc.getContext('2d').drawImage(c, x0, y0, bw, bh, 0, 0, bw, bh);

  /*
   * WHERE THE ENDS STOP. Per column, how tall is the bar? In the middle it
   * is the full height and unchanging; at each end it tapers — the concave
   * left where it meets the disc, the round right cap. The slice is the
   * first column from each side at which the height has settled and stays
   * settled, so neither end is ever caught in the stretched middle.
   */
  const ob = oc.getContext('2d').getImageData(0, 0, bw, bh);
  const colH = [];
  for (let x = 0; x < bw; x++) {
    let n = 0;
    for (let y = 0; y < bh; y++) if (ob.data[(y * bw + x) * 4 + 3] > 120) n++;
    colH.push(n);
  }
  const full = Math.max(...colH);
  const settle = (from, dir) => {
    const RUN = Math.max(6, Math.round(bw * 0.02));
    let run = 0;
    for (let i = from; i >= 0 && i < bw; i += dir) {
      if (colH[i] >= full - 1) {
        run++;
        if (run >= RUN) return Math.abs(i - from) - RUN + 1;
      } else run = 0;
    }
    return -1;
  };
  return {
    data: oc.toDataURL('image/png'),
    x0, y0, w: bw, h: bh, fullH: full,
    capLeft: settle(0, 1), capRight: settle(bw - 1, -1),
  };
}, readFileSync(sheet).toString('base64'));

writeFileSync(OUT, Buffer.from(out.data.split(',')[1], 'base64'));
console.log(`found the bar at (${out.x0}, ${out.y0}) in the sheet`);
console.log(`fill-meter.png  ${out.w} x ${out.h}   full height ${out.fullH}px`);
console.log(`caps            left ${out.capLeft}px, right ${out.capRight}px  <- border-image-slice 0 R 0 L`);
console.log(OUT);
await b.close();
