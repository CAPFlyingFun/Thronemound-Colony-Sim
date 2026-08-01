/**
 * Where do edited samples go missing between digging and resuming?
 *
 * The smoke measured 89,224 samples at dig time and 70,059 after a save, a
 * reload and a RESUME. Serialize and restore are count-exact by construction,
 * so one of the steps between the two numbers is lying. This brackets each:
 * count in the store, count in the serialized bytes, count after two seconds
 * of wall-clock idling, count in the stored save, count after an in-place
 * restore.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4302/Thronemound-Colony-Sim/?map=densityterrainlab&nomenu=1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: 932, height: 430 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.labScene?.queenReady === true, null, { timeout: 60000 });

const res = await page.evaluate(async () => {
  const lab = window.labScene;
  lab.antPosition.set(24, 0, 26);
  lab.stepForTest(1 / 60, 120);
  while (lab.bore.pitch > -Math.PI / 2 + 1e-9) lab.bore.aim(-1);
  lab.input.dig = 1;
  lab.input.walk = 1;
  lab.stepForTest(1 / 60, 300);
  lab.input.dig = 0;
  lab.input.walk = 0;
  lab.stepForTest(1 / 60, 30);

  const count = (bytes) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const tiles = view.getUint32(at, true); at += 4;
    let total = 0;
    for (let t = 0; t < tiles; t += 1) {
      at += 2;
      const n = view.getUint32(at, true);
      at += 4 + n * 8;
      total += n;
    }
    return { tiles, total, trailing: bytes.byteLength - at };
  };

  const inStore = lab.stream.editedSamples;
  const serialized = count(lab.stream.serializeEdits());

  // Let the live rAF loop run for two real seconds with everything released.
  await new Promise((r) => setTimeout(r, 2000));
  const afterIdle = lab.stream.editedSamples;

  const okSave = lab.saveGame();
  const save = JSON.parse(localStorage.getItem('thronemound.lab.save'));
  const bin = atob(save.dug);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const inSave = count(bytes);

  // The ORIGINAL store's key sanity, before restore replaces it: encode as
  // u16 wraps mod 65536, so any local past 65535 collides with a small one.
  const storeBefore = [];
  for (const [key, tile] of lab.stream.edits) {
    let weird = 0;
    let max = -1;
    for (const local of tile.keys()) {
      if (!Number.isInteger(local) || local < 0 || local > 65535) weird += 1;
      if (local > max) max = local;
    }
    storeBefore.push({ key, size: tile.size, weird, max });
  }

  lab.stream.restoreEdits(bytes);
  const afterRestore = lab.stream.editedSamples;

  /*
   * Where restore loses entries: parse again by hand and log every (key,
   * local) already seen. Serialize reads Maps, so duplicates should be
   * impossible — unless the STORE's own keys are not what they claim.
   */
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const tiles = view.getUint32(at, true); at += 4;
  const dupes = [];
  let dupeCount = 0;
  const keys = [];
  for (let t = 0; t < tiles; t += 1) {
    const key = view.getUint16(at, true); at += 2;
    const n = view.getUint32(at, true); at += 4;
    keys.push({ key, n });
    const seen = new Map();
    for (let i = 0; i < n; i += 1) {
      const local = view.getUint32(at, true); at += 4;
      const value = view.getFloat32(at, true); at += 4;
      if (seen.has(local)) {
        dupeCount += 1;
        if (dupes.length < 8) {
          const lx = local % 65;
          const rest = (local - lx) / 65;
          const y = rest % 129;
          const lz = (rest - y) / 129;
          dupes.push({ key, local, lx, y, lz, first: seen.get(local), second: value });
        }
      } else seen.set(local, value);
    }
  }
  // And the store side: are the Map keys integers in range?
  const storeKeys = [];
  for (const [key, tile] of lab.stream.edits) {
    let weird = 0;
    let max = -1;
    for (const local of tile.keys()) {
      if (!Number.isInteger(local) || local < 0 || local > 65535) weird += 1;
      if (local > max) max = local;
    }
    storeKeys.push({ key, size: tile.size, weird, max });
  }

  return {
    inStore, serialized, afterIdle, okSave, dugChars: save.dug.length, inSave,
    afterRestore, dupeCount, dupes, keys, storeBefore, storeKeys,
  };
});

console.log(JSON.stringify(res, null, 2));
await browser.close();
