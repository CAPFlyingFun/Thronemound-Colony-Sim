/**
 * THE METER'S CHANNEL, TRACED FROM THE FRAME ITSELF.
 *
 *     npm run gen:meter-mask
 *
 * Four attempts put the carry readout in the frame's channel by hand — an
 * inset here, an elliptical radius there — and every one was off by a pixel
 * somewhere. Reported, in order, as: too wide, no curve at the max, a black
 * border all round, and finally a close-up of the cap with daylight between
 * the stripes and the gold. They were all the same mistake. The channel is
 * not a rounded rectangle. It is the shape left over when a nine-sliced
 * photograph of a gold frame is drawn at 165 x 34, and no pair of radii
 * describes it.
 *
 * So it is not described. It is MEASURED: draw the frame at exactly the size
 * the HUD uses, find the stone, and write that region out as a mask. The
 * readout then wears the channel's own shape and cannot be a pixel out,
 * because the shape came from the pixels.
 *
 * TWO THINGS THE SCRIPT DOES THAT MATTER:
 *
 *  - It DILATES the mask by a pixel, so the readout runs slightly UNDER the
 *    gold rather than stopping at it. The rim is painted over the readout
 *    (see `.tm-meter-frame`), so the overshoot is hidden — and a hidden
 *    overshoot is the only way to guarantee no hairline gap survives at an
 *    anti-aliased edge.
 *  - It stops at the medallion. The disc is dark and opaque like the stone,
 *    but it is not channel; the left border tile is where it lives, so
 *    everything left of that tile is excluded outright.
 *
 * Re-run it if the meter's size or the frame art changes. Nothing else does.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* The meter as the HUD builds it — keep in step with `.tm-meter`. */
const W = 165;
const H = 34;
const BORDER = { top: 8, right: 8, bottom: 10, left: 34 };
const ART = { top: 7.44, right: 7.7, bottom: 9.56, left: 34 };
const SLICE = '28 29 36 128';
/* Traced at 8x and written out at 4x, which is how the rest of public/ui
 * is encoded. Tracing above the output size is the point: the extra detail
 * becomes a soft alpha edge on the way down instead of a stair-step. */
const SCALE = 8;
/* How far the mask reaches under the gold, in CSS px. */
const TUCK = 1;

const OUT = fileURLToPath(new URL('../public/ui/mask-meter.png', import.meta.url));

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 400, height: 120 }, deviceScaleFactor: SCALE });

const url = new URL('../public/ui/frame-meter.webp', import.meta.url);
const src = `data:image/webp;base64,${(await import('node:fs')).readFileSync(url).toString('base64')}`;

/*
 * Draw the frame at the shipped size, on nothing, and let PLAYWRIGHT
 * rasterise it. Going through an SVG foreignObject to do this in-page was
 * the obvious shortcut and it does not work — the frame is a data: URI
 * inside the markup and the round-trip refuses to decode it. A screenshot
 * is the same renderer with none of that.
 */
await p.setContent(`<style>html,body{margin:0;background:transparent}
  #frame{width:${W}px;height:${H}px;box-sizing:border-box;border-style:solid;
    border-width:${BORDER.top}px ${BORDER.right}px ${BORDER.bottom}px ${BORDER.left}px;
    border-image-source:url("${src}");border-image-slice:${SLICE} fill;
    border-image-width:${ART.top}px ${ART.right}px ${ART.bottom}px ${ART.left}px;
    border-image-repeat:stretch}</style><div id="frame"></div>`);
await p.waitForTimeout(400);
const shot = await p.locator('#frame').screenshot({ omitBackground: true });

const png = await p.evaluate(async ([cfg, shotB64]) => {
  const { SCALE, ART, BORDER, H, TUCK } = cfg;

  const img = new Image();
  img.src = `data:image/png;base64,${shotB64}`;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const im = g.getImageData(0, 0, c.width, c.height);
  const w = im.width; const h = im.height;

  /*
   * THE CHANNEL, FOUND BY FLOODING IT — not by thresholding a rectangle.
   *
   * The first version took every dark pixel right of the medallion's tile,
   * which squared off the left end: the channel does NOT begin with a
   * straight edge, it curves where the stone runs up against the disc. A
   * hard cut at the tile boundary threw that curve away. Flooding from a
   * seed in the middle of the run finds the channel's real outline instead,
   * and the medallion's own dark centre is a SEPARATE island — the ring of
   * gold around the disc keeps the two from touching — so it is excluded by
   * not being connected rather than by a number.
   *
   * The vertical bound stays as a backstop. Every frame in this set has a
   * dark lower lip outside its bottom rim, and if anti-aliasing ever opens
   * a one-pixel path through the rim the flood would escape into it — which
   * is the exact bug that hid the bottom rim for two releases.
   */
  const top = Math.round(ART.top * SCALE);
  const bot = Math.round((H - ART.bottom) * SCALE);
  const isStone = (x, y) => {
    const i = (y * w + x) * 4;
    if (im.data[i + 3] < 200) return false;
    return 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2] < 100;
  };
  const raw = new Uint8Array(w * h);
  const seed = [Math.round(w * 0.62), Math.round((top + bot) / 2)];
  if (!isStone(seed[0], seed[1])) throw new Error('seed is not on stone — has the meter changed size?');
  const stack = [seed];
  raw[seed[1] * w + seed[0]] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const ny = y + dy;
      if (nx < 0 || nx >= w || ny < top || ny >= bot) continue;
      const k = ny * w + nx;
      if (raw[k] || !isStone(nx, ny)) continue;
      raw[k] = 1; stack.push([nx, ny]);
    }
  }

  /*
   * TUCK IT UNDER THE GOLD — with a ROUND brush.
   *
   * The first version dilated with a square one, and a square brush is how
   * a traced curve turns back into the "long rectangle with no curves" this
   * was reported as: it pushes the corners out diagonally and flattens every
   * arc it touches. A disc of the same radius grows the outline evenly and
   * leaves the shape the shape it was.
   */
  const r = Math.round(TUCK * SCALE);
  const disc = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) disc.push([dx, dy]);
  }
  const grown = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!raw[y * w + x]) continue;
      for (const [dx, dy] of disc) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        grown[yy * w + xx] = 1;
      }
    }
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255;
    out[i * 4 + 3] = grown[i] ? 255 : 0;
  }
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  oc.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);

  /* Down to the 4x the rest of public/ui is encoded at. The downscale is
   * doing a second job: it turns the traced outline's stair-steps into a
   * soft alpha edge, so the readout's curve is smooth rather than jagged. */
  const fc = document.createElement('canvas');
  fc.width = Math.round(w / 2); fc.height = Math.round(h / 2);
  const fg = fc.getContext('2d');
  fg.imageSmoothingEnabled = true;
  fg.imageSmoothingQuality = 'high';
  fg.drawImage(oc, 0, 0, fc.width, fc.height);

  /* Where the channel starts and ends across the meter, as a fraction of
   * its width. The level is a gradient stop on the track's background, and
   * it has to run between these two — a stop at 0 would be under the
   * medallion, where nothing shows, so an almost-empty bar would read as
   * empty and the last stretch of a full one would have nowhere to go. */
  let filled = 0; let minX = w; let maxX = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grown[y * w + x]) continue;
      filled++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  return {
    data: fc.toDataURL('image/png'), w: fc.width, h: fc.height,
    filled: filled / (w * h),
    startPct: (100 * minX / w), endPct: (100 * (maxX + 1) / w),
  };
}, [{ W, H, BORDER, ART, SLICE, SCALE, TUCK }, shot.toString('base64')]);

writeFileSync(OUT, Buffer.from(png.data.split(',')[1], 'base64'));
console.log(`mask-meter.png  ${png.w} x ${png.h}  (${png.w / W}x of ${W} x ${H})`);
console.log(`channel covers  ${(100 * png.filled).toFixed(1)}% of the box`);
console.log(`channel runs   ${png.startPct.toFixed(1)}% to ${png.endPct.toFixed(1)}% across the meter`);
console.log(`  -> .tm-meter-track's gradient stop must run between those two`);
console.log(OUT);
await b.close();
