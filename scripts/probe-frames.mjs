/**
 * WHERE DOES THE DECORATION END? — the frames' slice numbers, measured.
 *
 *     npm run probe:frames
 *
 * `border-image-slice` is in SOURCE pixels, and getting it wrong is the trap
 * that cost a release once already: the toast came out 384x80 against a
 * design of 220x42, because the slice and the border-width were given the
 * same number.
 *
 * A slice is not "how thick is the rim". It is WHERE THE PLAIN RUN STARTS —
 * the point past which the frame is the same all the way along, so stretching
 * it costs nothing. Before that point live the round caps, the carved ends and
 * the corner leaves, and any of those caught inside the stretched middle
 * smears. So:
 *
 *   1. Flood-fill the dark interior from the centre. A fill, not a threshold
 *      walk — every frame here has shadow OUTSIDE the gold and grain INSIDE
 *      the stone, and both fool a walk that stops at the first dark pixel.
 *   2. Per column, how far down does the interior start? Per row, how far in?
 *   3. The plain run is where those profiles go FLAT. Where they are still
 *      moving, the frame is still drawing something.
 *
 * It also holds the numbers the stylesheet is actually using, and says so
 * when they disagree — so a re-exported sheet that moves a rim by three
 * pixels is a line of output rather than a frame that quietly goes soft.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/*
 * WHAT THE STYLESHEET SAYS TODAY, as `slice: [T, R, B, L]` and where it is
 * used. The toast slices at 30/92 rather than at its own measured rim and
 * end — it was cut by eye before this probe existed, it looks right, and it
 * is recorded as-is rather than quietly retuned.
 */
const WIRED = {
  'frame-bar': { slice: [11, 37, 16, 37], where: '.tm-bar — the four vitals' },
  'frame-panel': { slice: [24, 27, 30, 28], where: '.tm-quest' },
  'frame-meter': { slice: [27, 29, 26, 115], where: '.tm-meter — carry' },
  'frame-toast': { slice: [30, 92, 30, 92], where: '.tm-toast (cut by eye)' },
};
const FRAMES = Object.keys(WIRED);

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage();

for (const name of FRAMES) {
  const data = readFileSync(new URL(`../public/ui/${name}.webp`, import.meta.url)).toString('base64');
  const out = await p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/webp;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data: px, width: w, height: h } = g.getImageData(0, 0, c.width, c.height);

    /* FULLY opaque, not just mostly. The drop shadow outside the gold is dark
     * AND soft, so `alpha > 200` lets the fill escape the frame entirely and
     * run around the outside — which is what made the meter report a 2px
     * bottom rim on a frame whose bottom rim is plainly not 2px. */
    const dark = (x, y) => {
      const i = (y * w + x) * 4;
      if (px[i + 3] < 252) return false;
      return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 78;
    };

    /* 1. FLOOD FILL the interior from the middle. */
    const mask = new Uint8Array(w * h);
    const cx = Math.floor(w / 2); const cy = Math.floor(h / 2);
    const stack = [[cx, cy]];
    mask[cy * w + cx] = 1;
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx; const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (mask[k] || !dark(nx, ny)) continue;
        mask[k] = 1; stack.push([nx, ny]);
      }
    }

    /* 2. EDGE PROFILES of the filled region. */
    const colTop = new Int32Array(w).fill(-1);
    const colBot = new Int32Array(w).fill(-1);
    const rowLeft = new Int32Array(h).fill(-1);
    const rowRight = new Int32Array(h).fill(-1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) if (mask[y * w + x]) { colTop[x] = y; break; }
      for (let y = h - 1; y >= 0; y--) if (mask[y * w + x]) { colBot[x] = h - 1 - y; break; }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { rowLeft[y] = x; break; }
      for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) { rowRight[y] = w - 1 - x; break; }
    }

    /* 3. WHERE THE PROFILE GOES FLAT. The plateau value is the thinnest the
     * rim ever gets (the middle of a straight run); the slice is the first
     * index from each end at which the profile has settled onto it and
     * STAYS there — a lone pixel that happens to hit the plateau inside an
     * ornament does not end the ornament. */
    const settle = (prof, from, dir) => {
      const seen = [...prof].filter((v) => v >= 0).sort((a, b) => a - b);
      if (!seen.length) return -1;
      /* The plateau is the run's own thickness, taken as the low quartile
       * rather than the minimum — one anti-aliased pixel a shade darker than
       * its neighbours is not a thinner rim. Tolerance of 2 for the same
       * reason: these are photographs of gold, not vector art. */
      const plateau = seen[Math.floor(seen.length * 0.25)];
      const n = prof.length; const RUN = 14; let run = 0;
      for (let i = from; i >= 0 && i < n; i += dir) {
        if (prof[i] >= 0 && Math.abs(prof[i] - plateau) <= 2) {
          run++;
          if (run >= RUN) return Math.abs(i - from) - RUN + 1;
        } else run = 0;
      }
      return -1;
    };
    const coarse = (prof) => {
      const step = Math.max(1, Math.round(prof.length / 24));
      const out = [];
      for (let i = 0; i < prof.length; i += step) out.push(prof[i]);
      return out.join(' ');
    };
    return {
      w, h,
      sliceLeft: settle(rowLeft, 0, 1) >= 0 ? settle(colTop, 0, 1) : -1,
      left: settle(colTop, 0, 1),
      right: settle(colTop, w - 1, -1),
      top: settle(rowLeft, 0, 1),
      bottom: settle(rowLeft, h - 1, -1),
      rimTop: Math.min(...[...colTop].filter((v) => v >= 0)),
      rimBottom: Math.min(...[...colBot].filter((v) => v >= 0)),
      rimLeft: Math.min(...[...rowLeft].filter((v) => v >= 0)),
      rimRight: Math.min(...[...rowRight].filter((v) => v >= 0)),
      interiorRows: [...rowLeft].filter((v) => v >= 0).length,
      interiorCols: [...colTop].filter((v) => v >= 0).length,
      profTop: coarse(colTop), profLeft: coarse(rowLeft),
    };
  }, data);

  const wired = WIRED[name];
  console.log(`\n${name}  ${out.w} x ${out.h}   ${wired.where}`);
  console.log(`  thinnest rim   : T ${out.rimTop}  B ${out.rimBottom}  L ${out.rimLeft}  R ${out.rimRight}`);
  console.log(`  decoration ends: T ${out.top}  R ${out.right}  B ${out.bottom}  L ${out.left}`);
  console.log(`  wired slice    : ${wired.slice.join(' ')}   (T R B L)`);

  /*
   * A slice may sit at the rim or at the decoration, and both are correct —
   * the bars slice top and bottom at the RIM so the fill lands on the stone,
   * and left and right at the CAP so the curve is not stretched. What is
   * never correct is a slice SHORTER than the decoration on an edge that
   * stretches, because that is the smear. Only those are called out.
   */
  const measured = [out.top, out.right, out.bottom, out.left];
  const rim = [out.rimTop, out.rimRight, out.rimBottom, out.rimLeft];
  const EDGE = ['top', 'right', 'bottom', 'left'];
  for (let i = 0; i < 4; i++) {
    const w = wired.slice[i];
    if (w < rim[i]) console.log(`  !! ${EDGE[i]} slice ${w} is inside the rim (${rim[i]}) — the frame will be cut`);
    else if (w < measured[i] && w > rim[i] + 2) {
      console.log(`  ?  ${EDGE[i]} slice ${w} is short of the decoration (${measured[i]})`);
    }
  }
  if (measured.some((v) => v < 0)) console.log('  ?  an edge never went flat — the frame may have no plain run');
}

await b.close();
