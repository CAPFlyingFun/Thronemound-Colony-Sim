/**
 * The dig geometry, read off the rig instead of chosen.
 *
 * The spec, as drawn on the queen's skeleton:
 *
 *   "Measure from antennas to bottom of jaw bone and double that for the
 *    digging distance. Also, make it a straight line from that bone straight
 *    down and at that projected point will be that dig radius which will vary
 *    per ant."
 *
 * So there are two numbers and both come from bones: a REACH, twice the
 * antenna-to-jaw span, and a RADIUS taken from dropping a straight line from
 * the jaw bone. This reports every candidate for each so the spec can be
 * pinned to actual millimetres rather than to my reading of a sentence —
 * antenna base and antenna tip both, and the mouth chain's first and last
 * bone both, because "antennas" and "jaw bone" each name two things on this
 * rig and the difference is not small.
 *
 * Everything is in her own frame: her up, not the world's, because she works
 * on walls and ceilings.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4460/Thronemound-Colony-Sim/?scene=block';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const lab = window.blockScene;
  const MM = 5;
  const V = Object.getPrototypeOf(lab.at).constructor;
  const rig = lab.queen.rig;

  // Rest pose, head up, so the numbers are the rig's and not the animation's.
  lab.queen.update(1 / 60, { speed: 0, turn: 0, digging: 0, carrying: 0 });
  lab.queen.root.updateMatrixWorld(true);

  const at = (name) => {
    const b = lab.queen.bones.get(name);
    if (!b) return null;
    const v = new V();
    b.getWorldPosition(v);
    return v;
  };
  const span = (a, b) => (a && b ? +(a.distanceTo(b) * MM).toFixed(3) : null);

  const antBase = at(rig.antennaLeft[0]);
  const antTip = at(rig.antennaLeft[rig.antennaLeft.length - 1]);
  const mouthFirst = at(rig.mouth[0]);
  const mouthLast = at(rig.mouth[rig.mouth.length - 1]);
  const jaw = new V();
  lab.queen.jawPosition(jaw);

  // The straight line down from the jaw, in HER frame, to the soil.
  const drop = (p) => {
    if (!p) return null;
    const hit = lab.cast(p.clone().addScaledVector(lab.up, 4 / MM), lab.up.clone().negate(), 20 / MM);
    return hit ? +(p.clone().sub(hit).dot(lab.up) * MM).toFixed(3) : null;
  };

  return {
    caste: rig.caste,
    hasMandibles: !!(rig.mandibleLeft && rig.mandibleRight),
    bones: {
      antennaBase: rig.antennaLeft[0],
      antennaTip: rig.antennaLeft[rig.antennaLeft.length - 1],
      mouthFirst: rig.mouth[0],
      mouthLast: rig.mouth[rig.mouth.length - 1],
    },
    spans: {
      'antenna base -> mouth last (the jaw)': span(antBase, mouthLast),
      'antenna base -> mouth first': span(antBase, mouthFirst),
      'antenna tip  -> mouth last (the jaw)': span(antTip, mouthLast),
      'antenna tip  -> mouth first': span(antTip, mouthFirst),
    },
    dropToSoilMm: {
      'from the jaw (mouth last)': drop(mouthLast),
      'from mouth first': drop(mouthFirst),
      'from antenna base': drop(antBase),
    },
    currentBiteMm: 1.75,
    bodyLengthMm: 9,
  };
});

console.log(JSON.stringify({ errors: errors.slice(0, 3) }));
console.log(`caste ${out.caste} — mandible bones: ${out.hasMandibles ? 'yes' : 'NO, auto-rig left them out'}`);
console.log('bones used:', JSON.stringify(out.bones));
console.log('\nantenna-to-jaw span, and DOUBLE it for the dig distance:');
for (const [k, v] of Object.entries(out.spans)) {
  console.log(`  ${k.padEnd(38)} ${String(v).padStart(7)} mm   ->  reach ${v === null ? '—' : (v * 2).toFixed(3)} mm`);
}
console.log('\nstraight down from the bone to the soil (her frame), at rest:');
for (const [k, v] of Object.entries(out.dropToSoilMm)) {
  console.log(`  ${k.padEnd(38)} ${String(v).padStart(7)} mm`);
}
console.log(`\nfor scale: she is ${out.bodyLengthMm} mm long, and today's hardcoded bite is ${out.currentBiteMm} mm across`);
await browser.close();
