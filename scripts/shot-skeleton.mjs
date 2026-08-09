/**
 * THE SKELETON, NAMED AND PARENTED.
 *
 * The rig tables in `hexapod.ts` say which bone is which. They do NOT say
 * how the bones are PARENTED, and for the articulated spine that is the
 * question that decides everything: rotating a bone carries every one of
 * its descendants with it, so pitching "the thorax" might or might not
 * already have pitched the head, depending on which way round the chain
 * runs. Guessing that is how you get a body that folds in half.
 *
 * Dumps, for whichever caste is asked for:
 *   - every bone the rig map names, with its parent
 *   - the chain from each named bone up to the model root
 *   - its rest position along her own length, so the order is checkable
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-skeleton.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => {
  const s = window.islandScene;
  const q = s.queen;
  const rig = q.rig;
  q.root.updateMatrixWorld(true);

  /* Which rig group each named bone belongs to, so the dump reads as
   * anatomy rather than as a list of numbers. */
  const label = new Map();
  const tag = (names, what) => (names ?? []).forEach((n, i) => {
    label.set(n, `${what}[${i}]`);
  });
  tag(rig.body, 'body');
  tag(rig.thorax, 'thorax');
  tag(rig.mouth, 'mouth');
  tag(rig.gaster, 'gaster');
  tag(rig.mandibleLeft, 'mandL');
  tag(rig.mandibleRight, 'mandR');
  tag(rig.antennaLeft, 'antL');
  tag(rig.antennaRight, 'antR');
  for (const leg of rig.legs) tag(leg.bones, leg.slot);

  const rootInv = q.root.matrixWorld.clone().invert();
  const local = (bone) => {
    const m = bone.matrixWorld.clone().premultiply(rootInv);
    const e = m.elements;
    return { x: +e[12].toFixed(3), y: +e[13].toFixed(3), z: +e[14].toFixed(3) };
  };

  /* Only the SPINE groups — legs and antennae are settled and would bury
   * the thing being looked at. */
  const spine = [
    ...(rig.body ?? []), ...(rig.thorax ?? []),
    ...(rig.mouth ?? []), ...(rig.gaster ?? []),
  ];
  const rows = [];
  for (const name of spine) {
    const bone = q.bones.get(name);
    if (!bone) { rows.push({ name, missing: true }); continue; }
    /* The chain up to the root, so the hierarchy is visible directly. */
    const up = [];
    for (let n = bone.parent; n && up.length < 12; n = n.parent) {
      if (n === q.root) { up.push('<root>'); break; }
      up.push(label.get(n.name) ? `${n.name}=${label.get(n.name)}` : n.name);
    }
    rows.push({
      name,
      role: label.get(name),
      at: local(bone),
      parents: up,
      childBones: bone.children.filter((c) => c.isBone).map((c) => (
        label.get(c.name) ? `${c.name}=${label.get(c.name)}` : c.name
      )),
    });
  }
  return {
    caste: rig.caste,
    lengthUnits: rig.lengthUnits,
    missing: q.missing,
    rows,
  };
});

console.log(`\nSKELETON — ${dump.caste}, ${dump.lengthUnits} units long`);
if (dump.missing.length) console.log(`  MISSING from the file: ${dump.missing.join(', ')}`);
console.log('\n  bone        role         local x,y,z (root frame)      parent chain');
for (const r of dump.rows) {
  if (r.missing) { console.log(`  ${r.name}  NOT IN FILE`); continue; }
  const at = `${String(r.at.x).padStart(7)},${String(r.at.y).padStart(7)},${String(r.at.z).padStart(7)}`;
  console.log(`  ${r.name.padEnd(11)} ${String(r.role).padEnd(12)} ${at}   <- ${r.parents.slice(0, 4).join(' <- ')}`);
}
console.log('\n  CHILDREN (what a rotation on each bone would carry with it)');
for (const r of dump.rows) {
  if (r.missing) continue;
  console.log(`  ${r.name.padEnd(11)} ${String(r.role).padEnd(12)} -> ${r.childBones.join(', ') || '(none)'}`);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
