/*
 * HOW BIG EACH CREATURE SHOULD BE DRAWN — solved against a real length.
 *
 * Joshua researched the target sizes; this works out the scale factor that
 * gets each model there. The arithmetic is trivial and the MEASUREMENT is
 * not, because the obvious number is wrong three separate ways:
 *
 * THE BOUNDING BOX IS NOT THE BODY. The earthworm is rigged in an S, so
 * its box is 55.5 x 44.4 while the animal is far longer than either —
 * scaling the box to 150 mm would give a worm less than half the length
 * asked for. Its length is the path ALONG ITS SPINE, which is what the
 * bone chain is.
 *
 * THE LONGEST CHAIN IS NOT ALWAYS THE SPINE. A fly's leg has more joints
 * than its body. The spine is picked out by staying near the median plane
 * — legs, wings and antennae splay off it in mirrored pairs, a backbone
 * does not.
 *
 * AND ONE AXIS IS NOT A MEASUREMENT AT ALL: every auto-rigged model here
 * reports exactly 8.5 tall, because the rigger normalises into a fixed
 * box. It is excluded from anything that picks a "longest" axis.
 *
 *   node scripts/probe-scale.mjs
 */
import { chromium } from 'playwright';

const MM = 5;

/**
 * What each animal actually is, in millimetres, and where the number came
 * from. Measured biology, not game tuning — so it is cited.
 */
const TARGET = {
  'housefly.glb': {
    mm: 6.5,
    note: 'Musca domestica body 4-8 mm, mean 6.35 (Animal Diversity Web)',
  },
  'aphid.glb': {
    mm: 2.5,
    note: 'garden aphids 1.5-4 mm; 2-4 is what players recognise (UMN, MSU Extension)',
  },
  'earthworm.glb': {
    mm: 150,
    note: 'Lumbricus terrestris commonly 120-250 mm (U. Maryland, Dimensions.com)',
  },
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/', {
  waitUntil: 'domcontentloaded',
});

const rows = await page.evaluate(async (names) => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import(
    '/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
  );
  const { MeshoptDecoder } = await import(
    '/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'
  );
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);

  const out = [];
  for (const name of names) {
    const gltf = await loader.loadAsync(`/models/${name}`);
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());

    /* Every maximal single-child bone run in the rig. */
    const bones = [];
    gltf.scene.traverse((n) => { if (n.isBone) bones.push(n); });
    const at = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    const chains = [];
    for (const b of bones) {
      const kids = b.children.filter((c) => c.isBone);
      /* Start a run only where one begins: no bone parent, or a branch. */
      const parentKids = b.parent?.isBone
        ? b.parent.children.filter((c) => c.isBone).length : 0;
      if (b.parent?.isBone && parentKids === 1) continue;
      if (kids.length !== 1) continue;
      const run = [b];
      let cur = b;
      while (cur.children.filter((c) => c.isBone).length === 1) {
        cur = cur.children.find((c) => c.isBone);
        run.push(cur);
      }
      if (run.length < 3) continue;
      let along = 0;
      let lateral = 0;
      for (let i = 0; i < run.length; i += 1) {
        if (i > 0) along += at(run[i]).distanceTo(at(run[i - 1]));
        /* How far off the median plane it sits. A spine hugs it; a leg
         * does not. `x` is the mirror axis for every rig here. */
        lateral += Math.abs(at(run[i]).x - mid.x);
      }
      chains.push({ n: run.length, along, lateral: lateral / run.length });
    }

    /*
     * THE SPINE: of the chains that stay near the median plane, the
     * longest. The threshold is a fraction of the model's own width, so
     * it does not care what units the file is in.
     */
    const near = chains.filter((c) => c.lateral < size.x * 0.12);
    const spine = (near.length ? near : chains)
      .sort((a, b) => b.along - a.along)[0] ?? null;

    out.push({
      name,
      /* Y is the auto-rigger's normalisation, never a measurement. */
      boxXZ: [size.x, size.z],
      spineLen: spine?.along ?? 0,
      spineBones: spine?.n ?? 0,
      chains: chains.length,
    });
  }
  return out;
}, Object.keys(TARGET));

await browser.close();

console.log('\nHOW BIG TO DRAW THEM — spine length, not bounding box\n');
console.log('  model            box x/z (raw)   spine   bones    is now      target      scale');
let bad = 0;
const solved = [];
for (const r of rows) {
  const t = TARGET[r.name];
  /* The model's own body length, in the millimetres the island counts in
   * before any fit scale is applied. */
  const nowMm = r.spineLen * MM;
  if (!(nowMm > 0)) { bad += 1; console.log(`  ${r.name.padEnd(16)} no spine chain found`); continue; }
  const scale = t.mm / nowMm;
  solved.push({ name: r.name, scale, nowMm, target: t.mm, note: t.note });
  const f = (v, d = 2) => v.toFixed(d);
  console.log(
    `  ${r.name.padEnd(16)} ${`${f(r.boxXZ[0] * MM, 1)}/${f(r.boxXZ[1] * MM, 1)}`.padStart(13)}`
    + ` ${String(r.spineBones).padStart(7)} ${String(r.chains).padStart(7)}`
    + ` ${`${f(nowMm, 1)} mm`.padStart(10)} ${`${f(t.mm, 1)} mm`.padStart(10)}`
    + ` ${f(scale, 4).padStart(10)}`,
  );
}

/* Full precision, because `creatureScale.ts` stores BOTH the model's own
 * length and the scale — and a rounded length times an unrounded scale
 * does not reproduce the target, which is the one thing its test checks. */
console.log('\n  exactly, for the table:\n');
for (const s of solved) {
  console.log(`  ${s.name.replace('.glb', '').padEnd(12)} modelMm: ${s.nowMm}  fit: ${s.target / s.nowMm}`);
}

console.log('\n  and what that makes them, beside a 9 mm queen:\n');
for (const s of solved) {
  console.log(`  ${s.name.replace('.glb', '').padEnd(12)} ${`${s.target} mm`.padStart(8)}`
    + `  =  ${(s.target / 9).toFixed(2)} queens    ${s.note}`);
}
if (errs.length) console.log('\npage errors:', errs.slice(0, 2).join(' | '));

if (bad > 0) { console.log(`\nFAILED: ${bad} model(s) had no spine to measure`); process.exit(1); }
console.log('\nall green — every creature has a measured body length and a scale');
