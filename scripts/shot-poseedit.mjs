/**
 * IS THE EDITOR'S UI SANE, AND IS SHE IN THE MIDDLE OF IT?
 *
 * Reported from the device, with a screenshot: "the UI is way too big in the
 * editor, and the ant is not centered in the screen." Both are things a
 * screenshot shows instantly and a test never notices, so both are measured
 * here rather than judged by eye — and a picture is written out too, because
 * the eye is the final judge of a tool that exists to be looked at.
 *
 * WHERE SHE IS, measured properly: her drawn bones are projected into screen
 * space and the box round them is compared with the space the controls leave
 * free. "Centred" is not the middle of the canvas — the panel covers the
 * bottom of it — it is the middle of what you can actually see.
 *
 *   node scripts/shot-poseedit.mjs        # writes /tmp/poseedit.png
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const fail = [];
const errs = [];

/** Both the shapes a phone is actually held in, plus a desktop. */
const SIZES = [
  { name: 'phone landscape', width: 932, height: 430 },
  { name: 'phone portrait', width: 430, height: 932 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const size of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  page.on('pageerror', (e) => errs.push(`${size.name}: ${e.message}`));
  await page.goto(`${base}/?scene=poseedit`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.poseEditor?.ready, null, { timeout: 120000 })
    .catch(() => fail.push(`${size.name}: the editor never became ready`));
  /* Let the turntable settle and the panel finish laying out. */
  await page.waitForTimeout(1200);

  const seen = await page.evaluate(() => {
    const s = window.poseEditor;
    const h = window.innerHeight;
    const w = window.innerWidth;
    const panel = document.querySelector('.pose-panel')?.getBoundingClientRect();
    const readout = document.querySelector('.pose-readout')?.getBoundingClientRect();

    /* Project her bones to the screen and take the box round them. */
    const cam = s.camera;
    cam.updateMatrixWorld(true);
    const v = new (s.up?.constructor ?? Object)();
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    let n = 0;
    s.queen.root.traverse((o) => {
      if (!o.isBone) return;
      o.updateWorldMatrix(true, false);
      const e = o.matrixWorld.elements;
      const p = { x: e[12], y: e[13], z: e[14] };
      /* World -> clip, by hand, so this needs nothing but the camera. */
      const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const cw = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (cw <= 0) return;
      const cx = (m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / cw;
      const cy = (m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / cw;
      const sx = (cx * 0.5 + 0.5) * w;
      const sy = (0.5 - cy * 0.5) * h;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      n += 1;
    });
    void v;
    /*
     * THE CANVAS'S OWN SIZE, because everything else here measures the RENDER
     * and the render was never the problem. `setSize(w, h, false)` left the
     * canvas laid out at its drawing-buffer size — twice the viewport on a
     * 2x screen — so a correctly centred ant was displayed in the bottom-right
     * corner of the quarter that fitted. Every projection check said centred.
     * Only this catches it.
     */
    const canvas = document.querySelector('canvas');
    const cr = canvas?.getBoundingClientRect();
    return {
      w,
      h,
      canvasW: cr ? cr.width : 0,
      canvasH: cr ? cr.height : 0,
      panelH: panel ? panel.height : 0,
      readoutH: readout ? readout.height : 0,
      bones: n,
      box: { minX, minY, maxX, maxY },
    };
  });

  const chrome = (seen.panelH + seen.readoutH) / seen.h;
  const freeTop = seen.readoutH;
  const freeBottom = seen.h - seen.panelH;
  const cx = (seen.box.minX + seen.box.maxX) / 2;
  const cy = (seen.box.minY + seen.box.maxY) / 2;
  const wantY = (freeTop + freeBottom) / 2;
  const offX = (cx - seen.w / 2) / seen.w;
  const offY = (cy - wantY) / seen.h;
  const fills = (seen.box.maxY - seen.box.minY) / Math.max(1, freeBottom - freeTop);

  console.log(`${size.name.padEnd(16)} ${seen.w}x${seen.h}  `
    + `panel ${seen.panelH.toFixed(0)}px + readout ${seen.readoutH.toFixed(0)}px `
    + `= ${(chrome * 100).toFixed(0)}% of the screen`);
  console.log(`${''.padEnd(16)} she is ${(offX * 100).toFixed(1)}% off centre across, `
    + `${(offY * 100).toFixed(1)}% down, filling ${(fills * 100).toFixed(0)}% of the free height`
    + ` (${seen.bones} bones)`);

  if (!seen.bones) fail.push(`${size.name}: none of her bones project to the screen at all`);
  /* The canvas must be laid out at the size it is rendered for. */
  const overW = seen.canvasW / seen.w;
  const overH = seen.canvasH / seen.h;
  if (overW > 1.02 || overH > 1.02 || overW < 0.98 || overH < 0.98) {
    fail.push(`${size.name}: the canvas is laid out ${overW.toFixed(2)}x${overH.toFixed(2)} `
      + 'of the viewport — most of the render is off screen');
  }
  /* The controls are a tool, not the subject. A third of the screen is
   * already generous for fourteen handles, three sliders and a readout. */
  if (chrome > 0.42) {
    fail.push(`${size.name}: the controls take ${(chrome * 100).toFixed(0)}% of the screen`);
  }
  /* Centred in what is VISIBLE, not in the canvas the panel is covering. */
  if (Math.abs(offX) > 0.12) {
    fail.push(`${size.name}: she is ${(offX * 100).toFixed(0)}% off centre across`);
  }
  if (Math.abs(offY) > 0.15) {
    fail.push(`${size.name}: she sits ${(offY * 100).toFixed(0)}% off the middle of the free space`);
  }
  /* And she has to be worth looking at: neither a speck nor cropped. */
  if (fills < 0.2) fail.push(`${size.name}: she fills only ${(fills * 100).toFixed(0)}% — too far away`);
  if (fills > 1.05) fail.push(`${size.name}: she is ${(fills * 100).toFixed(0)}% — cropped`);

  await page.screenshot({ path: `/tmp/poseedit-${size.name.replace(/ /g, '-')}.png` });
  await page.close();
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — the controls are a strip and she is in the middle of the rest');
