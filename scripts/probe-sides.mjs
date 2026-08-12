/**
 * IS EVERY NAMED PART ON THE SIDE ITS NAME CLAIMS?
 *
 * Reported from the device: "each antenna and legs are correct as far as
 * placement, but reversed, meaning it says 'Left Antenna' is actually the
 * right antenna, 'Middle Left' is really Middle Right." Measured, that was
 * true of 28 out of 28 named left/right parts across all three castes — the
 * rig tables read "the sign of its X gives the side" and applied it the wrong
 * way round.
 *
 * A rename is easy to get backwards, so this measures rather than trusts, and
 * it does it TWICE by methods that share no assumption:
 *
 *   THE CAMERA. Stand in front of her and look back at her face. Someone
 *   facing you has their left hand on your right — that is what facing means,
 *   not a graphics convention — so whatever lands on the right of the image is
 *   on her left. No axis, no handedness rule, no cross product.
 *
 *   THE BIND POSE. Her head runs toward +Z and her feet sit at y ~= 0, so she
 *   faces +Z with +Y up, which puts her left at +X. Read off the skeleton's
 *   inverse bind matrices, which is where the rig tables came from in the
 *   first place. LIVE bone positions are no good for this: a walking colonist
 *   is displaced by the gait and the IK, and reading a side off those reads
 *   the animation instead of the animal. Measured live, the worker's two
 *   antenna roots both came out at x = -0.050 — the same side — which is what
 *   a pose looks like when it is mistaken for anatomy.
 *
 * The two must agree with each other AND with the names. If they ever stop,
 * the rig has been re-exported and the tables need re-deriving.
 *
 *   npm run probe:sides        # needs `vite preview` already running
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({
  viewport: { width: 900, height: 600 }, serviceWorkers: 'block',
});
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 200000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 200000 },
);
/* The other two castes only exist once the colony has arrived. */
await page.evaluate(() => { window.islandScene.spawnWorker(); });
await page.waitForFunction(
  () => (window.islandScene.colony ?? []).filter((c) => c.ready).length >= 2,
  null, { timeout: 120000 },
).catch(() => { /* Measured for whoever did load; reported below. */ });
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  s.setPausedForTest(true);
  s.stepForTest(0.0326, 20);
  const V = s.up.constructor;
  const M4 = s.queen.root.matrixWorld.constructor;

  /* --- the camera, on the queen, who is the one under the player's view --- */
  const cam = s.camera.clone();
  const centre = new V(s.at.x, s.at.y, s.at.z);
  cam.position.copy(centre).addScaledVector(s.fwd, 2).addScaledVector(s.up, 0.2);
  cam.up.copy(s.up);
  cam.lookAt(centre);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const onImage = (name) => {
    const bone = s.queen.bones.get(name);
    if (!bone) return null;
    bone.updateWorldMatrix(true, false);
    return new V().setFromMatrixPosition(bone.matrixWorld).project(cam).x;
  };

  /* --- the bind pose, on every model that is loaded --- */
  const models = [s.queen];
  for (const c of s.colony ?? []) if (c.ready) models.push(c.model);
  const read = (m) => {
    let skel = null;
    m.root.traverse((o) => { if (!skel && o.isSkinnedMesh) skel = o.skeleton; });
    if (!skel) return { caste: m.rig.caste, error: 'no skinned mesh' };
    const bindX = (name) => {
      const i = skel.bones.findIndex((bn) => bn.name === name);
      if (i < 0) return null;
      return new M4().copy(skel.boneInverses[i]).invert().elements[12];
    };
    const rig = m.rig;
    /* The TIP of each chain, not the root: a worker's antenna sockets both sit
     * within 0.003 of the midline and cannot tell the two sides apart. */
    const tip = (bones) => (bones && bones.length ? bindX(bones[bones.length - 1]) : null);
    const parts = [];
    const add = (name, bones) => {
      const x = tip(bones);
      if (x !== null) parts.push({ name, x, isLeft: name.endsWith('Left') });
    };
    add('antennaLeft', rig.antennaLeft);
    add('antennaRight', rig.antennaRight);
    add('mandibleLeft', rig.mandibleLeft);
    add('mandibleRight', rig.mandibleRight);
    for (const leg of rig.legs) add(leg.slot, leg.bones);
    const head = tip([rig.thorax[rig.thorax.length - 1]]);
    const gasterZ = (() => {
      const i = skel.bones.findIndex((bn) => bn.name === rig.gaster[0]);
      return i < 0 ? null : new M4().copy(skel.boneInverses[i]).invert().elements[14];
    })();
    const headZ = (() => {
      const i = skel.bones.findIndex((bn) => bn.name === rig.thorax[rig.thorax.length - 1]);
      return i < 0 ? null : new M4().copy(skel.boneInverses[i]).invert().elements[14];
    })();
    return {
      caste: rig.caste, parts, head,
      facesPlusZ: headZ !== null && gasterZ !== null ? headZ > gasterZ : null,
    };
  };

  const camera = {};
  for (const [name, bones] of [
    ['antennaLeft', s.queen.rig.antennaLeft],
    ['antennaRight', s.queen.rig.antennaRight],
    ...s.queen.rig.legs.map((l) => [l.slot, l.bones]),
  ]) camera[name] = onImage(bones[bones.length - 1]);

  return { camera, castes: models.map(read) };
});

const fail = [];
console.log('THE CAMERA — from in front of her, image right is HER LEFT\n');
console.log('part            image x   lands on   she calls it   named');
for (const [name, x] of Object.entries(out.camera)) {
  if (x === null) continue;
  const truly = x > 0 ? 'Left' : 'Right';
  const named = name.endsWith('Left') ? 'Left' : 'Right';
  const ok = truly === named;
  if (!ok) fail.push(`camera: ${name} is on her ${truly.toLowerCase()}`);
  console.log(`${name.padEnd(15)} ${x.toFixed(3).padStart(7)}   ${(x > 0 ? 'right' : 'left ')}      `
    + `${truly.padEnd(13)} ${named}${ok ? '' : '   <-- WRONG'}`);
}

console.log('\nTHE BIND POSE — she faces +Z, so her left is +X\n');
let measured = 0;
for (const c of out.castes) {
  if (c.error) { console.log(`${c.caste}: ${c.error}`); continue; }
  measured += 1;
  if (c.facesPlusZ === false) {
    fail.push(`${c.caste}: her head is NOT toward +Z — the whole convention has moved`);
  }
  const wrong = c.parts.filter((p) => (p.x > 0) !== p.isLeft);
  console.log(`${c.caste.padEnd(7)} ${String(c.parts.length).padStart(2)} named parts, `
    + `${wrong.length} on the wrong side`
    + (wrong.length ? `: ${wrong.map((w) => w.name).join(', ')}` : ''));
  for (const w of wrong) fail.push(`${c.caste}: ${w.name} sits at x=${w.x.toFixed(3)}`);
}
if (measured < 3) {
  console.log(`\n(only ${measured} of 3 castes were loaded — the colony had not arrived)`);
}

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
if (fail.length) {
  console.log(`\nFAILED: ${fail.join('; ')}`);
  process.exit(1);
}
console.log('\nall green — every left is her left, by two methods that share no assumption');
