/*
 * DOES EVERY SHIPPED MODEL ACTUALLY LOAD — in three.js, in a browser.
 *
 * `bake-models.mjs` cuts these by a factor of a hundred, and a bake that
 * quietly breaks a file is worse than no bake at all: the sizes look
 * wonderful right up until the thing is invisible on a phone. So each one
 * is loaded through the SAME GLTFLoader the game uses, and asked what it
 * turned out to be.
 *
 * It also prints the RAW BOUNDS, which is the first thing anyone wiring a
 * new model needs. Read them as a RATIO and not as millimetres: the game
 * fits every rig with a scale of its own (`BODY_FIT_SCALE`), so a queen
 * whose file measures 21.8 stands about 9 mm long in play. What the column
 * is good for is comparing a new model with a known one — and the news is
 * good, because the release is roughly self-consistent with life. The fly
 * arrives at 21.4 against the queen's 21.8, and a real housefly and a real
 * fire-ant queen really are about the same length.
 *
 * ONE NUMBER IS NOT A MEASUREMENT: every SKINNED model reports exactly 8.5
 * tall — the queen, the worker, the major, the fly, the aphid and the worm
 * alike. Six rigs do not share a height by chance. It is the auto-rigger
 * normalising into a fixed box, so the Y column says nothing about the
 * animal and must not be used to scale one.
 *
 *   node scripts/probe-models.mjs
 */
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/';
const MM = 5;

const models = readdirSync('public/models')
  .filter((f) => f.endsWith('.glb')).sort();

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });

const rows = await page.evaluate(async (names) => {
  const three = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import(
    '/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
  );
  /* THE SAME DECODER THE GAME SETS. The ant rigs are Meshopt-compressed,
   * so a loader without it reports them as broken — which is a fault in
   * the probe, not in the models, and cost a confusing minute the first
   * time this ran. See `QueenModel.load`. */
  const { MeshoptDecoder } = await import(
    '/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'
  );
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const out = [];
  for (const name of names) {
    try {
      const gltf = await loader.loadAsync(`/models/${name}`);
      let verts = 0; let meshes = 0; let skinned = 0; let textures = 0;
      const seen = new Set();
      gltf.scene.traverse((n) => {
        if (!n.isMesh && !n.isSkinnedMesh) return;
        meshes += 1;
        if (n.isSkinnedMesh) skinned += 1;
        verts += n.geometry?.attributes?.position?.count ?? 0;
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
          const t = n.material?.[slot];
          if (t?.image && !seen.has(t.image)) {
            seen.add(t.image);
            textures += 1;
          }
        }
      });
      const box = new three.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new three.Vector3());
      let bones = 0;
      gltf.scene.traverse((n) => { if (n.isBone) bones += 1; });
      out.push({
        name, ok: true, meshes, skinned, verts, textures, bones,
        clips: gltf.animations.length,
        size: [size.x, size.y, size.z],
      });
    } catch (e) {
      out.push({ name, ok: false, why: String(e).slice(0, 90) });
    }
  }
  return out;
}, models);

await browser.close();

console.log('\nEVERY SHIPPED MODEL, LOADED — three.js, real GLTFLoader\n');
console.log('  model             verts   meshes  skin  bones  clips  tex   raw bounds');
let bad = 0;
for (const r of rows) {
  if (!r.ok) { bad += 1; console.log(`  ${r.name.padEnd(17)} FAILED — ${r.why}`); continue; }
  /* Raw file units times MM — a RATIO to compare against a known rig, not
   * a real-world size. See the note at the top. */
  const mm = r.size.map((v) => (v * MM).toFixed(1)).join(' x ');
  console.log(
    `  ${r.name.padEnd(17)} ${String(r.verts).padStart(6)}`
    + ` ${String(r.meshes).padStart(7)} ${String(r.skinned).padStart(5)}`
    + ` ${String(r.bones).padStart(6)} ${String(r.clips).padStart(6)}`
    + ` ${String(r.textures).padStart(4)}   ${mm}`,
  );
}
if (errs.length) console.log('\npage errors:', errs.slice(0, 3).join(' | '));
console.log(`\n${models.length} model(s) checked`);

if (bad > 0) {
  console.log(`\nFAILED: ${bad} model(s) would not load`);
  process.exit(1);
}
console.log('\nall green — every model in public/models loads and has geometry');
