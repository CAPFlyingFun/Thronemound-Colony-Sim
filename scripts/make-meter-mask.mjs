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
/* 4x, matching how the rest of public/ui is encoded. */
const SCALE = 4;
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
   * THE CHANNEL. Inside the rim band vertically, right of the medallion's
   * tile horizontally, opaque, and dark — the stone. The gold fails the
   * darkness test, which is what makes the mask stop exactly where the rim
   * begins instead of at a number somebody typed.
   */
  const top = Math.round(ART.top * SCALE);
  const bot = Math.round((H - ART.bottom) * SCALE);
  const left = Math.round(BORDER.left * SCALE);
  const raw = new Uint8Array(w * h);
  for (let y = top; y < bot; y++) {
    for (let x = left; x < w; x++) {
      const i = (y * w + x) * 4;
      if (im.data[i + 3] < 200) continue;
      const lum = 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2];
      if (lum < 92) raw[y * w + x] = 1;
    }
  }

  /* TUCK IT UNDER THE GOLD. Dilate by a pixel so the readout never stops
   * short at an anti-aliased edge; the rim is painted on top and hides it. */
  const r = Math.round(TUCK * SCALE);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -r; dy <= r && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (raw[yy * w + xx]) { on = 1; break; }
        }
      }
      const k = (y * w + x) * 4;
      out[k] = 255; out[k + 1] = 255; out[k + 2] = 255; out[k + 3] = on ? 255 : 0;
    }
  }
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  oc.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  let filled = 0;
  for (let i = 0; i < w * h; i++) if (out[i * 4 + 3]) filled++;
  return { data: oc.toDataURL('image/png'), w, h, filled };
}, [{ W, H, BORDER, ART, SLICE, SCALE, TUCK }, shot.toString('base64')]);

writeFileSync(OUT, Buffer.from(png.data.split(',')[1], 'base64'));
console.log(`mask-meter.png  ${png.w} x ${png.h}  (${SCALE}x of ${W} x ${H})`);
console.log(`channel covers  ${(100 * png.filled / (png.w * png.h)).toFixed(1)}% of the box`);
console.log(OUT);
await b.close();
