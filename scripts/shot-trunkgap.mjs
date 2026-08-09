/**
 * WHERE UP THE TRUNK DOES THE COLLISION STOP MATCHING THE BARK?
 *
 * The headless test in `tests/tree.test.ts` checks the near detail level
 * against the solid, and passes. The player is not looking at the near
 * level all the way up: `THREE.LOD` swaps on distance to the tree's ORIGIN,
 * and for a twenty-six metre object that is a very odd thing to key on —
 * climbing the trunk walks you AWAY from the origin without ever getting
 * further from the wood.
 *
 * So this measures in the LIVE scene, at heights all the way up, with
 * whatever level the LOD has actually chosen: march out from the axis to
 * the collision surface, raycast the drawn mesh along the same line, and
 * report the difference. Positive means she stands ABOVE the bark;
 * negative means the bark is drawn outside the wood she seats on, and she
 * sinks into it.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-trunkgap.mjs
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
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const rows = await page.evaluate(() => {
  const s = window.islandScene;
  const MM = 5;
  const tree = s.tree;
  const root = tree.root;
  const solid = tree.solid;
  const origin = root.position;

  /** Nearest forward hit on the LEVEL THE LOD HAS CHOSEN, along a ray. */
  const meshHit = (px, py, pz, dx, dy, dz, reach) => {
    const level = root.levels.find((l) => l.object.visible);
    if (!level) return null;
    let best = Infinity;
    const tri = new Array(9);
    const visit = (obj) => {
      if (obj.isMesh && obj.geometry?.attributes?.position) {
        const g = obj.geometry;
        const pos = g.attributes.position.array;
        const idx = g.index ? g.index.array : null;
        const n = idx ? idx.length : g.attributes.position.count;
        obj.updateMatrixWorld();
        const m = obj.matrixWorld.elements;
        const xf = (i, o) => {
          const x = pos[i * 3]; const y = pos[i * 3 + 1]; const z = pos[i * 3 + 2];
          tri[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          tri[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          tri[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        };
        for (let t = 0; t + 2 < n; t += 3) {
          xf(idx ? idx[t] : t, 0);
          xf(idx ? idx[t + 1] : t + 1, 3);
          xf(idx ? idx[t + 2] : t + 2, 6);
          const e1x = tri[3] - tri[0]; const e1y = tri[4] - tri[1]; const e1z = tri[5] - tri[2];
          const e2x = tri[6] - tri[0]; const e2y = tri[7] - tri[1]; const e2z = tri[8] - tri[2];
          const hx = dy * e2z - dz * e2y;
          const hy = dz * e2x - dx * e2z;
          const hz = dx * e2y - dy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          const sx = px - tri[0]; const sy = py - tri[1]; const sz = pz - tri[2];
          const u = (sx * hx + sy * hy + sz * hz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t0 = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t0 > 0.01 && t0 < best && t0 < reach) best = t0;
        }
      }
      for (const kid of obj.children) visit(kid);
    };
    visit(level.object);
    return Number.isFinite(best) ? best : null;
  };

  const HEIGHT = 5200;
  const out = [];
  for (const frac of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98]) {
    const y = origin.y + HEIGHT * frac;
    /* Stand the camera where SHE would be, so the LOD picks the level a
     * climber actually sees rather than the one the last frame left. */
    s.camera.position.set(origin.x, y, origin.z + 200);
    s.camera.updateMatrixWorld();
    /* The tree drives its own level now, off the distance to the WOOD. */
    tree.updateLevels(s.camera.position);
    const level = root.levels.findIndex((l) => l.object.visible);

    let worst = Infinity;
    let mean = 0;
    let n = 0;
    for (let k = 0; k < 12; k += 1) {
      const a = (k / 12) * Math.PI * 2 + 0.21;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      /* The collision skin along this ray, bisected off a 1 mm march. */
      let inside = 0;
      let skin = -1;
      for (let d = 0.2; d < 400; d += 0.2) {
        if (!solid.solidAt(origin.x + dx * d, y, origin.z + dz * d)) { skin = d; break; }
        inside = d;
      }
      if (skin < 0) continue;
      for (let i = 0; i < 20; i += 1) {
        const mid = (inside + skin) / 2;
        if (solid.solidAt(origin.x + dx * mid, y, origin.z + dz * mid)) inside = mid;
        else skin = mid;
      }
      const drawn = meshHit(origin.x, y, origin.z, dx, 0, dz, 400);
      if (drawn === null) continue;
      const gap = (skin - drawn) * MM;
      mean += gap; n += 1;
      if (gap < worst) worst = gap;
    }
    out.push({
      frac,
      heightMm: Math.round(HEIGHT * frac * MM),
      level,
      meanMm: n ? +(mean / n).toFixed(2) : null,
      worstMm: n ? +worst.toFixed(2) : null,
      samples: n,
    });
  }
  return out;
});

console.log('\nUP THE TRUNK — collision skin minus drawn bark, at each height');
console.log('  positive = she stands ON or above the bark; negative = she sinks INTO it');
for (const r of rows) {
  console.log(`  ${String(Math.round(r.frac * 100)).padStart(3)}% (${String(r.heightMm).padStart(6)} mm)`
    + `  LOD ${r.level}  mean ${String(r.meanMm).padStart(7)} mm  worst ${String(r.worstMm).padStart(7)} mm`
    + `  (${r.samples}/12 rays)`);
}
console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
