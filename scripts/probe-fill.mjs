/**
 * DOES THE GAME FILL THE SCREEN? Measured at real device viewports.
 *
 * Written after a portrait PWA showed a band of page background along the
 * bottom edge. The band's colour is the tell: the page painted `#182016` (the
 * island build's olive) where the scene behind it paints `0x1a1d22`, so any
 * strip the canvas did not cover announced itself.
 *
 * Two separate things are checked, because they fail separately. GEOMETRY —
 * the canvas covers the viewport edge to edge — is the actual fix. COLOUR —
 * the page behind it matches the scene — is what stops a residual inset from
 * reading as a stripe rather than as more of the same dark.
 *
 * A caveat this file should carry honestly: iOS's standalone-PWA viewport is
 * not reproducible in Chromium, which is where this runs. The geometry checks
 * here would have passed on the broken build. What they pin is that the
 * layout is right everywhere it CAN be measured, and the colour check is what
 * pins the symptom Joshua actually saw.
 */
import { chromium } from 'playwright';
import { pressPlay } from './lib/pressPlay.mjs';

const PORT = process.env.PORT ?? '5177';
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

/* Portrait and landscape, at sizes real phones report. */
const SIZES = [
  { label: 'portrait phone', width: 402, height: 874 },
  { label: 'landscape phone', width: 932, height: 430 },
  { label: 'small landscape', width: 740, height: 360 },
];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

/* The scene's own background, so page and canvas can be compared rather than
 * both asserted against a colour written down twice. */
let sceneBg = null;

for (const size of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 3, hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
  /*
   * THROUGH THE DOOR FIRST. `reveal()` is what sizes the renderer now, and
   * measuring before it is measuring a canvas no player ever sees. Then long
   * enough for the settling window to have run its course.
   */
  await pressPlay(page);
  await page.waitForTimeout(2600);

  const r = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const box = canvas.getBoundingClientRect();
    const hex = (css) => {
      const m = css.match(/\d+/g);
      return m ? `#${m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('')}` : css;
    };
    const scene = window.habitatScene.sceneBackgroundForTest?.() ?? null;
    const sized = window.habitatScene.sizedForTest?.() ?? null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      canvas: {
        top: +box.top.toFixed(1), left: +box.left.toFixed(1),
        right: +box.right.toFixed(1), bottom: +box.bottom.toFixed(1),
      },
      pageBg: hex(getComputedStyle(document.documentElement).backgroundColor),
      bodyBg: hex(getComputedStyle(document.body).backgroundColor),
      sceneBg: scene,
      sized,
    };
  });
  sceneBg = r.sceneBg;

  const gapBottom = r.viewport.h - r.canvas.bottom;
  const gapRight = r.viewport.w - r.canvas.right;
  console.log(`  ${size.label} ${size.width}x${size.height}: ${JSON.stringify(r)}`);
  check(`${size.label}: no error`, errors.length === 0, errors.join(' | ') || 'none');
  check(`${size.label}: canvas reaches the bottom edge`, Math.abs(gapBottom) < 1,
    `${gapBottom.toFixed(1)} px short`);
  check(`${size.label}: canvas reaches the right edge`, Math.abs(gapRight) < 1,
    `${gapRight.toFixed(1)} px short`);
  /* The renderer's own idea of its size must be the viewport's, not merely
   * whatever the canvas element's CSS box happens to report. */
  check(`${size.label}: renderer sized to the viewport`,
    r.sized !== null && r.sized.w === r.viewport.w && r.sized.h === r.viewport.h,
    `renderer ${r.sized?.w}x${r.sized?.h}, viewport ${r.viewport.w}x${r.viewport.h}`);
  check(`${size.label}: canvas starts at the top-left`,
    Math.abs(r.canvas.top) < 1 && Math.abs(r.canvas.left) < 1,
    `top ${r.canvas.top}, left ${r.canvas.left}`);
  /*
   * THE ONE THAT WOULD HAVE CAUGHT IT. The page behind a full-bleed canvas
   * must be the canvas's own colour, so an inset the browser imposes cannot
   * paint itself a different shade.
   */
  check(`${size.label}: page matches the scene behind it`,
    r.pageBg === r.sceneBg && r.bodyBg === r.sceneBg,
    `page ${r.pageBg}, body ${r.bodyBg}, scene ${r.sceneBg}`);

  /*
   * AND IT MUST FOLLOW A VIEWPORT THAT CHANGES AFTER LOAD.
   *
   * This is the fault as it was actually described: opened in portrait the
   * game came up short, and rotating to landscape and back put it right for
   * good. The rotation was not a fix, it was the first event that forced a
   * second look at a size read once and never re-read. So the thing to pin
   * is that the canvas tracks the viewport whenever it moves, not only at
   * the one moment the scene was built.
   */
  await page.setViewportSize({ width: size.height, height: size.width });
  await page.waitForTimeout(900);
  const rotated = await page.evaluate(() => {
    const box = document.querySelector('canvas').getBoundingClientRect();
    return {
      w: window.innerWidth, h: window.innerHeight,
      right: +box.right.toFixed(1), bottom: +box.bottom.toFixed(1),
    };
  });
  check(`${size.label}: follows a rotation`,
    Math.abs(rotated.w - rotated.right) < 1 && Math.abs(rotated.h - rotated.bottom) < 1,
    `${rotated.w}x${rotated.h} viewport, canvas ends at ${rotated.right}x${rotated.bottom}`);

  await ctx.close();
}

/*
 * THE DISAGREEMENT, STAGED — because Chromium will not stage it for us.
 *
 * The portrait gap came from `visualViewport.height` reporting less than the
 * page while `#app` reported the whole screen, and the sizing code taking the
 * SMALLER of the two. Chromium keeps them equal, so the fault is invisible
 * here unless it is put there on purpose: this shadows `window.visualViewport`
 * with one that under-reports by the height of an iPhone's home indicator, and
 * asserts the canvas still reaches the bottom edge.
 *
 * It is a stand-in, not the real iOS viewport, and it proves one specific
 * thing: that a short reading from one instrument can no longer shorten the
 * canvas. That is the mechanism that was broken.
 */
{
  const ctx = await browser.newContext({
    viewport: { width: 402, height: 874 }, deviceScaleFactor: 3,
    hasTouch: true, isMobile: true, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  /* Installed before any app code runs, so the scene never sees the real one. */
  await page.addInitScript(() => {
    const real = window.visualViewport;
    const LIES_BY = 34;               // an iPhone's home-indicator band
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      get: () => (real === null ? null : {
        get width() { return real.width; },
        get height() { return real.height - LIES_BY; },
        get offsetTop() { return real.offsetTop; },
        get scale() { return real.scale; },
        addEventListener: real.addEventListener.bind(real),
        removeEventListener: real.removeEventListener.bind(real),
      }),
    });
  });
  await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
  await pressPlay(page);
  await page.waitForTimeout(2600);
  const r = await page.evaluate(() => {
    const box = document.querySelector('canvas').getBoundingClientRect();
    return {
      h: window.innerHeight, bottom: +box.bottom.toFixed(1),
      vv: window.visualViewport?.height ?? null,
      sized: window.habitatScene.sizedForTest?.() ?? null,
    };
  });
  console.log(`  under-reporting visualViewport: ${JSON.stringify(r)}`);
  check('a short visualViewport cannot shorten the canvas',
    Math.abs(r.h - r.bottom) < 1,
    `visualViewport said ${r.vv}, viewport is ${r.h}, canvas ends at ${r.bottom}`);
  await ctx.close();
}

/* The manifest is part of how the PWA lays itself out, so it is checked here
 * rather than trusted. A landscape lock outlived the rotate gate that v0.3.7
 * deleted, which left the installed app declaring an orientation the game no
 * longer requires. */
const ctx = await browser.newContext({ serviceWorkers: 'block' });
const page = await ctx.newPage();
/* Navigated first: a fetch from `about:blank` is cross-origin and fails, which
 * looks exactly like a missing manifest. */
await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const res = await fetch(link.href);
  return res.ok ? res.json() : null;
}).catch(() => null);
await ctx.close();

if (manifest) {
  /*
   * STANDALONE, NOT FULLSCREEN — and this one was measured on the device
   * rather than reasoned about.
   *
   * With `display: fullscreen` the readout on an iPhone 15 Plus said:
   *
   *     mode    standalone no   fullscreen YES
   *     screen  430 x 932        window 374 x 759
   *     zoom    1.150            GAP vs screen  bot 173
   *
   * The screen reports its full size, so the device's own Display Zoom is
   * not involved. WebKit took the fullscreen path, shrank the web viewport
   * to 374 x 759 and scaled it by 1.150 — and 759 x 1.150 is 872.85 device
   * points of content on a 932-point screen, leaving 59.15 uncovered, which
   * is exactly the `t59px` status-bar inset it budgeted at the top and then
   * did not use. The band along the bottom was the status bar's height,
   * stranded.
   *
   * WebKit has open bugs about manifest fullscreen on iOS. The comparison
   * apps that behave — Ant Scout, StormTracker — have the same
   * `viewport-fit=cover` and `black-translucent` and ask for `standalone`.
   * That was the one shell setting where TCS differed.
   */
  check('manifest asks for standalone, not fullscreen',
    manifest.display === 'standalone'
      && Array.isArray(manifest.display_override)
      && manifest.display_override.every((m) => m === 'standalone'),
    `display "${manifest.display}", override ${JSON.stringify(manifest.display_override)}`);
  check('manifest does not lock an orientation', manifest.orientation === 'any',
    `orientation "${manifest.orientation}"`);
  check('manifest colours match the scene',
    manifest.background_color === sceneBg && manifest.theme_color === sceneBg,
    `background ${manifest.background_color}, theme ${manifest.theme_color}, scene ${sceneBg}`);
} else {
  check('manifest readable', false, 'could not fetch manifest.webmanifest');
}

await browser.close();
const bad = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - bad.length}/${checks.length} checks passed`);
if (bad.length > 0) process.exit(1);
