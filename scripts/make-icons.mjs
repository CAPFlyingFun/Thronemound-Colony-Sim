/**
 * The app icon, drawn rather than screenshotted.
 *
 * An emoji would have been one line, and it would have baked whatever glyph
 * this container's font happened to have into a file shipped to phones. This
 * is a top-down queen in the game's own chitin colours on the manifest's own
 * background, so the icon on a home screen and the ant on the mound are
 * recognisably the same animal.
 *
 *     node scripts/make-icons.mjs
 *
 * Re-run only when the artwork changes; the PNGs are committed.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../public/icons/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const BACKDROP = '#182016';

/**
 * @param {number} scale how much of the frame the animal fills, 0..1. Maskable
 *   icons are cropped to a circle by the launcher, so the safe zone is the
 *   middle 80% and the ant has to sit inside it.
 */
const ant = (scale) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="glow" cx="50%" cy="38%" r="62%">
      <stop offset="0%" stop-color="#2b3a25"/>
      <stop offset="100%" stop-color="${BACKDROP}"/>
    </radialGradient>
    <linearGradient id="chitin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#c9642f"/>
      <stop offset="100%" stop-color="#8d3f1c"/>
    </linearGradient>
    <linearGradient id="gaster" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#7a3316"/>
      <stop offset="55%" stop-color="#4d1f0d"/>
      <stop offset="100%" stop-color="#301209"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#glow)"/>
  <g transform="translate(50 50) rotate(-9) scale(${scale}) translate(-50 -50)"
     stroke="#2a1108" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <!-- legs: three a side, each a femur out and a tarsus down to the soil -->
    <g fill="none" stroke-width="2.4">
      <path d="M43 41 L28 33 L18 38"/>
      <path d="M43 47 L26 47 L15 53"/>
      <path d="M43 53 L28 60 L19 69"/>
      <path d="M57 41 L72 33 L82 38"/>
      <path d="M57 47 L74 47 L85 53"/>
      <path d="M57 53 L72 60 L81 69"/>
    </g>
    <!-- antennae, elbowed the way a formicine's are -->
    <g fill="none" stroke-width="2.2">
      <path d="M45 25 L37 16 L30 13"/>
      <path d="M55 25 L63 16 L70 13"/>
    </g>
    <!-- gaster, thorax, head: back to front so each overlaps the last -->
    <ellipse cx="50" cy="71" rx="13" ry="16" fill="url(#gaster)"/>
    <path d="M39 66 Q50 70 61 66" fill="none" stroke="#933f1b" stroke-width="1.5" opacity="0.7"/>
    <path d="M38 74 Q50 79 62 74" fill="none" stroke="#933f1b" stroke-width="1.5" opacity="0.7"/>
    <circle cx="50" cy="55" r="3.4" fill="#6d2f13"/>
    <ellipse cx="50" cy="45" rx="8" ry="10.5" fill="url(#chitin)"/>
    <ellipse cx="50" cy="29" rx="9.5" ry="8.4" fill="url(#chitin)"/>
    <ellipse cx="44.5" cy="27" rx="2.1" ry="2.4" fill="#1b0c05" stroke="none"/>
    <ellipse cx="55.5" cy="27" rx="2.1" ry="2.4" fill="#1b0c05" stroke="none"/>
    <path d="M45 22 L41 17" stroke-width="2"/>
    <path d="M55 22 L59 17" stroke-width="2"/>
  </g>
</svg>`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

const jobs = [
  { file: 'icon-192.png', size: 192, scale: 0.92 },
  { file: 'icon-512.png', size: 512, scale: 0.92 },
  // Cropped to a circle by Android launchers, so the animal sits inside the
  // middle 80% and the background bleeds to every edge.
  { file: 'icon-maskable-512.png', size: 512, scale: 0.66 },
  // iOS rounds the corners itself and dislikes transparency, so this is the
  // same full-bleed square at the size Safari asks for.
  { file: 'apple-touch-icon.png', size: 180, scale: 0.9 },
];

for (const job of jobs) {
  const page = await browser.newPage({ viewport: { width: job.size, height: job.size } });
  await page.setContent(
    `<style>html,body{margin:0;background:${BACKDROP}}svg{display:block;width:${job.size}px;height:${job.size}px}</style>`
    + ant(job.scale),
  );
  await page.screenshot({ path: `${OUT}${job.file}`, omitBackground: false });
  await page.close();
  console.log(`wrote ${job.file} (${job.size}px)`);
}
await browser.close();
