/*
 * DOES A LOBBED CHARGE DIG A HOLE THAT SURVIVES A RELOAD?
 *
 * `CHARGE_RANGE_MM` is 150, and the carvable world is a 192 mm window
 * CENTRED on her — about 96 mm in any direction, less a rim that
 * `TerrainStream.remember()` deliberately refuses to record. That skip was
 * justified by "the rim is at least sixteen millimetres from any bite",
 * which is true only while digging is jaw-range. A thrown charge is the
 * thing that reaches it.
 *
 * So this asks the only question that matters: was the pocket SAVED?
 *
 *   node scripts/probe-chargesave.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
await page.waitForTimeout(900);

const out = await page.evaluate(async () => {
  const s = window.islandScene;
  const MM = 5;
  /* Her position comes off the shove list, which already publishes it —
   * no new hook needed just to ask where she is standing. */
  const her = () => s.bulkReportForTest().find((b) => b.id === 'queen');

  const shots = [];
  /* Several pitches, so at least one lands long. Each is measured on its
   * own: how far it flew, whether the field there is real, and whether the
   * edit count actually moved. */
  for (const pitch of [0.25, 0.5, 0.9]) {
    s.aimPitchForTest(pitch);
    s.stepForTest(1 / 60, 30);
    const editsBefore = s.saveEditBytesForTest();
    s.lobForTest();
    let steps = 0;
    while (s.chargesForTest() > 0 && steps < 900) { s.stepForTest(1 / 60, 1); steps += 1; }
    const editsAfter = s.saveEditBytesForTest();
    shots.push({ pitch, grewBytes: editsAfter - editsBefore });
    /* Let the cooldown clear before the next throw. */
    s.stepForTest(1 / 60, 90);
  }

  /*
   * WHERE DOES THE CARVABLE WORLD ACTUALLY END? Walk straight out from her
   * and find the first distance the fine field stops answering. That is the
   * real ceiling on any ranged dig, and it is what `CHARGE_RANGE_MM` has to
   * respect — a charge past it does not "miss", it lands somewhere the game
   * cannot cut.
   */
  const at = her();
  let edgeMm = null;
  for (let d = 1; d <= 300; d += 1) {
    const q = s.lensQueryForTest(at.x + d / MM, at.y, at.z);
    if (q.fine === 'unavailable') { edgeMm = d; break; }
  }

  /* And the whole-world question: save it, wipe the live edits, restore,
   * and see whether the same number of bytes comes back. */
  const beforeSave = s.saveEditBytesForTest();
  const wrote = await s.saveToStorage();
  const roundTrip = await s.saveRoundTripForTest();

  return { shots, beforeSave, wrote, roundTrip, edgeMm,
    windowMm: 192, rangeMm: s.chargeRangeForTest?.() ?? null };
});

await browser.close();
if (errs.length) console.log('page errors:', errs.slice(0, 2).join(' | '));

console.log('\nA LOBBED CHARGE, AND WHETHER ITS HOLE IS SAVED\n');
console.log(`  charge range       ${out.rangeMm} mm`);
console.log(`  carvable window    ${out.windowMm} mm across, centred on her (~96 mm each way)\n`);
for (const sh of out.shots) {
  console.log(`  pitch ${String(sh.pitch).padEnd(5)} edits grew by ${String(sh.grewBytes).padStart(8)} bytes`
    + (sh.grewBytes > 0 ? '' : '   <- CARVED NOTHING'));
}
console.log(`\n  fine field ends at ${out.edgeMm === null ? '>300' : out.edgeMm} mm from her`
  + `  <- the real ceiling on any ranged dig`);
console.log(`\n  edit bytes total   ${out.beforeSave}`);
console.log(`  saved              ${out.wrote}`);
console.log(`  read back intact   ${out.roundTrip}`);
