/**
 * WHERE DOES THE FRAME END AND THE STONE BEGIN? — the slice numbers.
 *
 *     npm run probe:frames
 *
 * `border-image-slice` is in SOURCE pixels, and getting it wrong is the trap
 * that cost a release once already: the toast came out 384x80 against a
 * design of 220x42, because the slice and the border-width were given the
 * same number.
 *
 * A slice is where the PLAIN RUN starts — past which the frame repeats, so
 * stretching it costs nothing. Before it live the round caps, the carved ends
 * and the corner leaves, and any of those caught in the stretched middle
 * smears.
 *
 * HOW IT IS MEASURED, and why not the obvious way. The first version of this
 * probe flood-filled the dark interior from the centre. That is wrong, and it
 * was wrong in a way that looked completely plausible: every frame in this
 * set has a DARK LOWER LIP outside its bottom rim, and the fill ran straight
 * through the rim's anti-aliased edge into it. It reported the meter's
 * interior as ending 10px lower than it does, so the bottom slice came out
 * 26 where it should be 36, and the bottom rim rendered as half a pixel of
 * brown where there is 5px of gold in the art. Reported as "should see the
 * gold frame at the bottom and I don't".
 *
 * So the gold is found instead, which is unambiguous: walk in from each edge,
 * skip the transparent margin, cross the BRIGHT band, and the interior starts
 * where that band ends. The frame's own rim is the landmark, not the dark.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

/*
 * WHAT THE STYLESHEET SAYS TODAY, as `slice: [T, R, B, L]`. The toast is cut
 * by eye rather than to these numbers — it was done before this probe
 * existed, it looks right, and it is recorded as-is rather than retuned.
 */
const WIRED = {
  'frame-bar': { slice: [11, 37, 16, 37], where: '.tm-bar — the four vitals' },
  'frame-panel': { slice: [24, 27, 30, 28], where: '.tm-quest' },
  'frame-meter': { slice: [28, 29, 36, 128], where: '.tm-meter — carry' },
  'frame-toast': { slice: [30, 92, 30, 92], where: '.tm-toast (cut by eye)' },
};

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage();

for (const [name, wired] of Object.entries(WIRED)) {
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

    const at = (x, y) => {
      const i = (y * w + x) * 4;
      return {
        a: px[i + 3],
        lum: 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2],
      };
    };
    const solid = (x, y) => at(x, y).a > 200;
    const gold = (x, y) => { const q = at(x, y); return q.a > 200 && q.lum > 90; };

    /*
     * Walk in along one axis: skip the transparent margin, cross the bright
     * rim, and report the inset of the first stone pixel after it. Returns
     * -1 if the line never crosses a rim into stone, which is what a corner
     * ornament or the end of a cap looks like.
     */
    const insetOf = (make, n) => {
      let seenGold = false;
      for (let i = 0; i < n; i++) {
        const [x, y] = make(i);
        if (!solid(x, y)) { if (seenGold) return -1; continue; }
        if (gold(x, y)) { seenGold = true; continue; }
        if (seenGold) return i;
      }
      return -1;
    };

    const cx = Math.floor(w / 2); const cy = Math.floor(h / 2);
    const colTop = (x) => insetOf((i) => [x, i], h);
    const colBot = (x) => insetOf((i) => [x, h - 1 - i], h);
    const rowLeft = (y) => insetOf((i) => [i, y], w);
    const rowRight = (y) => insetOf((i) => [w - 1 - i, y], w);

    /*
     * The plain run: where the interior's edge stops moving. Scanned from
     * each side, requiring a settled stretch so a single pixel that happens
     * to match inside an ornament does not end the ornament early.
     */
    const settle = (prof, from, dir) => {
      const seen = [...prof].filter((v) => v >= 0).sort((a, b2) => a - b2);
      if (!seen.length) return -1;
      const plateau = seen[Math.floor(seen.length * 0.5)];
      const n = prof.length; const RUN = 14; let run = 0;
      for (let i = from; i >= 0 && i < n; i += dir) {
        if (prof[i] >= 0 && Math.abs(prof[i] - plateau) <= 2) {
          run++;
          if (run >= RUN) return Math.abs(i - from) - RUN + 1;
        } else run = 0;
      }
      return -1;
    };
    const colTopProf = []; const rowLeftProf = [];
    for (let x = 0; x < w; x++) colTopProf.push(colTop(x));
    for (let y = 0; y < h; y++) rowLeftProf.push(rowLeft(y));

    return {
      w, h,
      /* Measured on the centre lines, which for every frame here run down
       * and along the plain part. */
      rim: { top: colTop(cx), bottom: colBot(cx), left: rowLeft(cy), right: rowRight(cy) },
      decoration: {
        left: settle(colTopProf, 0, 1),
        right: settle(colTopProf, w - 1, -1),
        top: settle(rowLeftProf, 0, 1),
        bottom: settle(rowLeftProf, h - 1, -1),
      },
    };
  }, data);

  console.log(`\n${name}  ${out.w} x ${out.h}   ${wired.where}`);
  console.log(`  stone starts at : T ${out.rim.top}  R ${out.rim.right}  B ${out.rim.bottom}  L ${out.rim.left}`);
  console.log(`  decoration ends : T ${out.decoration.top}  R ${out.decoration.right}  B ${out.decoration.bottom}  L ${out.decoration.left}`);
  console.log(`  wired slice     : ${wired.slice.join(' ')}   (T R B L)`);

  /*
   * A slice may sit at the rim or out at the decoration and both are right —
   * the bars slice top and bottom at the RIM so the fill lands on the stone,
   * and left and right at the CAP so the curve is not stretched. What is
   * never right is a slice INSIDE the rim, because then the stretched middle
   * is painted over the frame's own gold and the rim goes thin or vanishes.
   */
  const rim = [out.rim.top, out.rim.right, out.rim.bottom, out.rim.left];
  const EDGE = ['top', 'right', 'bottom', 'left'];
  let clean = true;
  for (let i = 0; i < 4; i++) {
    const wv = wired.slice[i]; const rv = rim[i];
    if (rv >= 0 && wv < rv - 1) {
      console.log(`  !! ${EDGE[i]} slice ${wv} is INSIDE the rim (stone starts at ${rv}) — that much gold is painted over`);
      clean = false;
    }
  }
  if (clean) console.log('  ok — every slice is at or outside the rim');
}

await b.close();
