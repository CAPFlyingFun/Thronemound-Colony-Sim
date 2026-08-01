/** Two portraits of the front door: the home menu and its settings page. */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4303/Thronemound-Colony-Sim/?map=densityterrainlab';
const OUT = process.env.SHOT_OUT ?? '/tmp/menu';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: 932, height: 430 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.labScene?.queenReady === true, null, { timeout: 60000 });
// A moment for the attract-mode ants to settle onto their feet behind it.
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}-home.png` });

await page.evaluate(() => {
  [...document.querySelectorAll('.lab-menu__button')]
    .find((b) => b.textContent === 'SETTINGS')?.click();
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}-settings.png` });

await browser.close();
console.log(`${OUT}-home.png and ${OUT}-settings.png`);
