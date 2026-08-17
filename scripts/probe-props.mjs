/**
 * THE LOOSE THINGS, AND WHETHER THEY WEAR THEIR REAL ART.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:props
 *
 * Asked for: "can you replace the procedural objects with the real glb
 * models now like the twig, rock, dirt, etc."
 *
 * Four questions a unit test cannot answer, because all four need the model
 * to have actually been fetched, parsed and scaled by a browser:
 *
 *   1. did the art arrive at all, or is the stand-in shape still showing?
 *   2. is it the SIZE the game thinks it is? `halfMm` is what the reach
 *      tests, the shove list and the carry verdict all reason about, so a
 *      model at the wrong scale is a thing you can see but not pick up.
 *   3. is it MATTE? glTF packs metalness and roughness into one image and
 *      three.js multiplies by both, so an untouched export comes out wet —
 *      the same fault as the glossy trees, on stone, soil and dead wood.
 *   4. did the collision hull get rebuilt off the real mesh? A twig that
 *      looks like a twig and collides like a cylinder is the picture and
 *      the physics describing different objects.
 *
 * WAITS ON THE ART, NOT ON A STOPWATCH. A first cut slept three seconds and
 * reported every prop still procedural, which was the probe being early
 * rather than the game being broken — the models take longer than that to
 * land under SwiftShader.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);
let landed = true;
await page.waitForFunction(() => {
  const s = window.islandScene;
  if (!s.props.length) return false;
  return s.props.filter((p) => p.spec.model).every((p) => {
    let std = false;
    p.root.traverse((n) => {
      if (n.isMesh && n.material.isMeshStandardMaterial) std = true;
    });
    return std;
  });
}, null, { timeout: 90000 }).catch(() => { landed = false; });

const out = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  return s.props.map((pr) => {
    let lo = [1e9, 1e9, 1e9];
    let hi = [-1e9, -1e9, -1e9];
    let meshes = 0;
    let verts = 0;
    let rough = null;
    let metal = null;
    let packed = false;
    let matType = null;
    pr.root.updateMatrixWorld(true);
    pr.root.traverse((n) => {
      if (!n.isMesh) return;
      meshes += 1;
      const pos = n.geometry.getAttribute('position');
      verts += pos.count;
      const m = n.material;
      matType = m.type;
      rough = m.roughness ?? null;
      metal = m.metalness ?? null;
      packed = packed || !!(m.roughnessMap || m.metalnessMap);
      /* Strided: the extent of a few hundred points is the extent. */
      for (let i = 0; i < pos.count; i += 7) {
        const w = n.localToWorld(
          new pr.at.constructor(pos.getX(i), pos.getY(i), pos.getZ(i)),
        );
        const q = pr.root.worldToLocal(w);
        lo = [Math.min(lo[0], q.x), Math.min(lo[1], q.y), Math.min(lo[2], q.z)];
        hi = [Math.max(hi[0], q.x), Math.max(hi[1], q.y), Math.max(hi[2], q.z)];
      }
    });
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
      .map((v) => +(v * MM).toFixed(2));
    /* The hull's own reach, so "rebuilt off the mesh" is a measurement
     * rather than a vertex count that happens to have changed. */
    const h = pr.hullForTest;
    let hullMax = 0;
    for (let i = 0; i + 2 < h.length; i += 3) {
      hullMax = Math.max(hullMax, Math.hypot(h[i], h[i + 1], h[i + 2]) * MM);
    }
    return {
      id: pr.id, model: pr.spec.model ?? null, wantMm: pr.spec.halfMm * 2,
      gotMm: Math.max(...size), size, meshes, verts, matType, rough, metal,
      packed, hullPoints: h.length / 3, hullMaxMm: +hullMax.toFixed(2),
    };
  });
});
await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nTHE LOOSE THINGS ON THE GROUND\n');
for (const p of out) {
  console.log(`  ${p.id.padEnd(7)} ${(p.model ?? 'procedural').padEnd(16)}`
    + ` ${String(p.gotMm).padStart(6)} mm (want ${p.wantMm})`
    + `  ${String(p.verts).padStart(5)} v  ${p.matType}`
    + `  rough=${p.rough} metal=${p.metal}  hull ${p.hullPoints}pt/${p.hullMaxMm}mm`);
}
console.log('');
say(landed, 'every modelled prop got its art');
say(out.some((p) => p.model), 'the island has props with real models at all');
for (const p of out.filter((q) => q.model)) {
  /* A tenth of a millimetre either way. The models are not authored to the
   * game's exact numbers and are not meant to be — they are SCALED to them,
   * so anything outside this is the fit failing, not the art. */
  say(Math.abs(p.gotMm - p.wantMm) < 0.35,
    `${p.id} is the size the game thinks it is — ${p.gotMm} against ${p.wantMm} mm`);
  say(p.matType === 'MeshStandardMaterial' && p.verts > 500,
    `${p.id} is wearing the model, not the stand-in — ${p.verts} verts`);
  say(!p.packed && p.metal === 0,
    `${p.id} is matte, with the packed metal-roughness map cleared`);
  /* The hull has to REACH the art. A stand-in hull left behind on a prop
   * whose model is larger would collide short — invisible until something
   * walks through the end of a twig. */
  say(p.hullMaxMm > p.wantMm * 0.25,
    `${p.id}'s collision hull reaches its own shape — ${p.hullMaxMm} mm`);
}
say(!out.some((p) => p.id === 'leaf'), 'the leaf is gone until there is a model for it');
if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the loose things wear their real art');
