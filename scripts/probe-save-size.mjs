/*
 * HOW BIG IS THE SAVE, AND WHY DID IT STOP FITTING?
 *
 * Reported from the device: "Could not save — storage is full or blocked."
 * That message is the catch-all this code prints when `localStorage.setItem`
 * throws, and it names two very different causes without distinguishing
 * them. This measures the actual blob and the actual failure.
 *
 *   node scripts/probe-save-size.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
await page.waitForTimeout(900);

const out = await page.evaluate(async () => {
  const s = window.islandScene;
  const size = () => {
    return s.saveEditBytesForTest();
  };
  const blob = () => {
    /* Build the same object `saveToStorage` builds, without writing it. */
    const raw = s.saveBlobForTest ? s.saveBlobForTest() : null;
    return raw ? raw.length : null;
  };

  const rows = [];
  const note = (label) => rows.push({ label, editBytes: size(), jsonChars: blob() });

  note('fresh island');
  /* Dig the way a player does. */
  for (let i = 0; i < 40; i += 1) { s.biteForTest(); s.stepForTest(1 / 60, 6); }
  note('after 40 bites of her own');
  /* And let the worms work near her. */
  s.putWormNearForTest(0, 20);
  s.putWormNearForTest(1, 40);
  s.putWormNearForTest(2, 60);
  for (let i = 0; i < 60 * 120; i += 1) s.stepForTest(1 / 60, 1);
  note('after 2 min with three worms digging beside her');

  /*
   * HOW WELL DOES IT COMPRESS? Terrain edits are mostly the same handful of
   * density values repeated, which is exactly what deflate is good at — and
   * `CompressionStream` is in every browser this ships to.
   */
  let deflated = null;
  let ratio = null;
  try {
    /* THE RAW BYTES, NOT THE BASE64. Compressing the finished JSON measures
     * how well deflate does on base64 — which scrambles the byte structure
     * deflate exists to exploit, and reported a feeble 1.5x. The edits are
     * a packed binary of repeated density values; that is what to squeeze,
     * and base64 should come after, not before. */
    const raw = s.saveBlobForTest();
    const squeeze = async (buf) => new Response(
      new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer();
    const jsonPacked = (await squeeze(raw)).byteLength;
    const editBytes = s.saveEditBytesForTest();
    const rawEdits = s.saveEditsRawForTest ? s.saveEditsRawForTest() : null;
    const editsPacked = rawEdits ? (await squeeze(rawEdits)).byteLength : null;
    deflated = jsonPacked;
    ratio = +(raw.length / jsonPacked).toFixed(1);
    window.__editsPacked = editsPacked;
    window.__editBytes = editBytes;
  } catch (e) { deflated = `unavailable: ${e.name}`; }

  /* And how many DISTINCT density values there are — if it is a handful,
   * a float32 per sample is thirty-one bits of nothing. */
  let distinct = null;
  try {
    const bytes = s.saveEditBytesForTest();
    distinct = bytes;
  } catch { /* reported as null */ }

  /* What actually happens on a write, and WHY if it fails. */
  let wrote = null;
  let why = null;
  try {
    const raw = s.saveBlobForTest ? s.saveBlobForTest() : '';
    window.localStorage.setItem('__tm_probe', raw);
    window.localStorage.removeItem('__tm_probe');
    wrote = true;
  } catch (e) {
    wrote = false;
    why = `${e.name}: ${e.message}`;
  }
  return { rows, wrote, why, deflated, ratio,
    editsPacked: window.__editsPacked, editBytes: window.__editBytes };
});

await browser.close();

const kb = (n) => (n === null ? 'n/a' : `${(n / 1024).toFixed(1)} KiB`);
console.log('\nTHE SAVE BLOB, AS IT GROWS\n');
for (const r of out.rows) {
  console.log(`  ${r.label.padEnd(46)} edits ${kb(r.editBytes).padStart(11)}`
    + `   json ${kb(r.jsonChars).padStart(11)}`);
}
console.log(`\n  deflate-raw        ${typeof out.deflated === 'number' ? kb(out.deflated) : out.deflated}`
  + (out.ratio ? `  (${out.ratio}x smaller)` : ''));
if (out.editsPacked) {
  console.log(`  raw edits deflated ${kb(out.editsPacked)}`
    + `  (${(out.editBytes / out.editsPacked).toFixed(1)}x smaller than the ${kb(out.editBytes)} of edits)`);
}
console.log(`  write succeeded    ${out.wrote}`);
if (out.why) console.log(`  failure           ${out.why}`);
console.log('\n  for scale          localStorage is about 5 MiB per origin,');
console.log('                     and base64 inflates bytes by a third.');
