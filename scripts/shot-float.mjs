/**
 * IS SHE TOUCHING IT?
 *
 * Not "is the collision surface where the bark is" — that is settled in
 * `tests/tree.test.ts` — but the thing the screenshot actually shows: how
 * far her drawn CLAWS are from the drawn BARK, measured by raycasting the
 * real meshes in the real scene along her own up.
 *
 * Measured on the ground first, as a control, and then on the trunk. If the
 * ground reads zero and the trunk reads millimetres, the fault is the tree;
 * if both read the same, the fault is the rig's seating.
 *
 *   SMOKE_URL=http://127.0.0.1:4173/ node scripts/shot-float.mjs
 */
import { chromium } from 'playwright';

const base = (process.env.SMOKE_URL ?? 'http://127.0.0.1:4173/').replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?scene=island`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready, null, { timeout: 90000 });
await page.waitForFunction(
  () => window.islandScene.loadingStateForTest().player === 1, null, { timeout: 90000 },
);
await page.waitForFunction(() => window.islandScene.tree?.solid != null, null, { timeout: 60000 });
await page.waitForTimeout(1500);

/* three is not on window, so the ray work is done with plain maths against
 * the geometry buffers instead — slower, but it needs nothing exported. */
const probe = async (label) => page.evaluate((tag) => {
  const s = window.islandScene;
  const MM = 5;

  /** Every drawn triangle within `reach` of a point, in world space. */
  const nearestSurface = (px, py, pz, dx, dy, dz, reach) => {
    let best = Infinity;
    let what = 'nothing';
    const tri = new Array(9);
    const visit = (obj) => {
      if (!obj.visible) return;
      /* Not her own body. A ray out of a claw meets her leg, her gaster and
       * the underside of her thorax long before it meets any ground, and the
       * first cut of this let those win: every foot read the same ~-29 mm
       * against a mesh that turned out to be part of the ant. */
      if (obj === s.queen.root) return;
      if (obj.isLOD) {
        const lv = obj.levels[obj.getCurrentLevel()];
        if (lv) visit(lv.object);
        return;
      }
      if (obj.isMesh && obj.geometry?.attributes?.position) {
        const g = obj.geometry;
        const pos = g.attributes.position.array;
        const idx = g.index ? g.index.array : null;
        const n = idx ? idx.length : g.attributes.position.count;
        obj.updateMatrixWorld();
        /*
         * AN INSTANCED MESH IS NOT AT ITS matrixWorld.
         *
         * The forest is instanced, and the first cut of this probe read only
         * `obj.matrixWorld` — which for an InstancedMesh is the identity the
         * scene put it at, not where any PLANT is. Every scattered trunk was
         * therefore invisible to it, and it reported "no surface found under
         * any claw" while she was standing on one. Walk the instance
         * matrices, and only the instances near the foot.
         */
        const mats = [];
        if (obj.isInstancedMesh) {
          const arr = obj.instanceMatrix.array;
          for (let k = 0; k < obj.count; k += 1) {
            const e = arr.slice(k * 16, k * 16 + 16);
            if (Math.hypot(e[12] - px, e[14] - pz) > reach + 200) continue;
            mats.push(e);
          }
        } else mats.push(obj.matrixWorld.elements);
        for (const m of mats) {
        const xf = (i, out, o) => {
          const x = pos[i * 3];
          const y = pos[i * 3 + 1];
          const z = pos[i * 3 + 2];
          out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        };
        for (let t = 0; t + 2 < n; t += 3) {
          const a = idx ? idx[t] : t;
          const b = idx ? idx[t + 1] : t + 1;
          const c = idx ? idx[t + 2] : t + 2;
          xf(a, tri, 0); xf(b, tri, 3); xf(c, tri, 6);
          /*
           * NO PROXIMITY REJECT.
           *
           * The first cut skipped any triangle with no VERTEX within reach of
           * the claw. A trunk at twenty sides and twenty-two rings has
           * triangles 157 mm across and 1,200 mm tall, so a claw resting flat
           * on the bark is nowhere near a corner of the face it is standing
           * on — the reject threw away precisely the triangle being looked
           * for, and the probe reported "no drawn surface" for a foot that
           * was touching one. The ray's own `t` bound is the only reject
           * that is safe here.
           */
          // Moller-Trumbore, both faces.
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
          /*
           * NEAREST along the line, forward or back — ranked by |t|, not by
           * t. A claw a fraction INSIDE the bark is the good outcome and has
           * a small negative t; ranking by t alone made the most negative
           * hit win, and rejecting negatives outright reported "nothing
           * found" for a foot that was touching. Sign is kept in the answer,
           * so proud bark reads negative and hovering reads positive.
           */
          if (Math.abs(t0) <= reach && Math.abs(t0) < Math.abs(best)) {
            best = t0;
            what = obj.isInstancedMesh ? `forest:${obj.count}` : (obj.name || obj.type);
          }
        }
        }
      }
      for (const kid of obj.children) visit(kid);
    };
    visit(s.scene);
    return { d: best, what };
  };

  /* Her claws: the last bone of each planted limb. */
  const feet = [];
  for (const leg of s.queen.rig?.legs ?? []) {
    const tipName = s.queen.limbTip.get(leg.slot);
    const bone = s.queen.bones.get(tipName ?? leg.bones[leg.bones.length - 1]);
    if (!bone) continue;
    const p = { x: 0, y: 0, z: 0 };
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    p.x = e[12]; p.y = e[13]; p.z = e[14];
    feet.push({ slot: leg.slot, ...p });
  }

  const up = { x: s.up.x, y: s.up.y, z: s.up.z };

  /*
   * THE LOWEST POINT OF HER DRAWN BODY, which is the only thing a player can
   * actually see hovering. A bone is a line inside a tube; the tube's
   * underside is what meets the bark, and the guard that keeps her out of
   * the soil moves the WHOLE model rigidly, so the gap the eye reads is not
   * necessarily the gap at any one claw.
   */
  const skinLow = (() => {
    let lowest = Infinity;
    const v = { x: 0, y: 0, z: 0 };
    const walk = (obj) => {
      if (obj.isSkinnedMesh || obj.isMesh) {
        const g = obj.geometry;
        const pos = g?.attributes?.position;
        if (pos) {
          obj.updateMatrixWorld();
          for (let i = 0; i < pos.count; i += 1) {
            v.x = pos.getX(i); v.y = pos.getY(i); v.z = pos.getZ(i);
            /* BIND POSE, not the posed one — these vertices are moved by the
             * skeleton and this ignores it, so the number is a bound on how
             * low her body reaches and not the live silhouette. The claw
             * bones above are the authoritative measurement; this is here to
             * catch the case where the whole model has been lifted clear. */
            const m = obj.matrixWorld.elements;
            const wx = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
            const wy = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
            const wz = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
            const e = (wx - s.at.x) * up.x + (wy - s.at.y) * up.y + (wz - s.at.z) * up.z;
            if (e < lowest) lowest = e;
          }
        }
      }
      for (const kid of obj.children) walk(kid);
    };
    walk(s.queen.root);
    return lowest;
  })();

  const gaps = feet.map((f) => {
    const hit = nearestSurface(f.x, f.y, f.z, -up.x, -up.y, -up.z, 6);
    /*
     * The same question asked of the COLLISION rather than the picture. Two
     * different faults look identical from the claw: the drawn bark being
     * inside the wood, and the leg never reaching the wood at all. Only
     * asking both tells them apart.
     */
    let solidMm = null;
    for (let d = 0; d < 8; d += 0.01) {
      if (s.soilSolidAt(f.x - up.x * d, f.y - up.y * d, f.z - up.z * d)) {
        solidMm = d * MM; break;
      }
    }
    return {
      slot: f.slot,
      gapMm: Number.isFinite(hit.d) ? hit.d * MM : null,
      solidMm,
      what: hit.what,
    };
  });
  const found = gaps.filter((g) => g.gapMm !== null).map((g) => g.gapMm);
  return {
    tag,
    upY: +s.up.y.toFixed(2),
    feet: gaps,
    meanMm: found.length ? found.reduce((a, b) => a + b, 0) / found.length : null,
    minMm: found.length ? Math.min(...found) : null,
    maxMm: found.length ? Math.max(...found) : null,
    missed: gaps.length - found.length,
    skinLowMm: skinLow * MM,
    seatToSolidMm: (() => {
      for (let d = 0; d < 8; d += 0.005) {
        if (s.soilSolidAt(s.at.x - up.x * d, s.at.y - up.y * d, s.at.z - up.z * d)) return d * MM;
      }
      return null;
    })(),
    /*
     * WHAT IS SHE ACTUALLY ON? Each source of solidity, asked separately at
     * her own centre and a hair below it — because "she is climbing
     * something" and "the thing she is climbing is drawn" are two claims and
     * the second one is the one that failed.
     */
    on: (() => {
      const below = (f, n) => {
        for (let d = 0; d < 4; d += 0.02) {
          if (f(s.at.x - up.x * d, s.at.y - up.y * d, s.at.z - up.z * d)) {
            return `${n}@${(d * MM).toFixed(1)}mm`;
          }
        }
        return null;
      };
      const hits = [
        below((x, y, z) => s.tree?.solid?.solidAt(x, y, z), 'landmark'),
        below((x, y, z) => s.stand?.solidAt(x, y, z), 'forest'),
        below((x, y, z) => s.soilSolidAt(x, y, z), 'soil'),
      ].filter(Boolean);
      return hits.length ? hits.join(' ') : 'NOTHING solid below her';
    })(),
    nearestInstanceMm: (() => {
      let best = Infinity;
      let who = '';
      for (const [name, mesh] of s.stands ?? []) {
        const arr = mesh.instanceMatrix.array;
        for (let k = 0; k < mesh.count; k += 1) {
          const d = Math.hypot(arr[k * 16 + 12] - s.at.x, arr[k * 16 + 14] - s.at.z);
          if (d < best) { best = d; who = name; }
        }
      }
      return Number.isFinite(best) ? `${who} ${(best * MM).toFixed(0)}mm away` : 'none';
    })(),
  };
}, label);

const say = (r) => {
  console.log(`\n${r.tag}  (her up.y ${r.upY}, ${r.onWood ? 'in the wood' : 'not in wood'})`);
  console.log(`  solid below her: ${r.on}`);
  console.log(`  nearest scattered plant: ${r.nearestInstanceMm}`);
  if (r.meanMm === null) console.log('  no DRAWN surface found under any claw');
  else {
    console.log(`  claw -> drawn surface: mean ${r.meanMm.toFixed(2)} mm, `
      + `min ${r.minMm.toFixed(2)}, max ${r.maxMm.toFixed(2)}  (${r.missed} feet found nothing)`);
    console.log('  ' + r.feet.map((f) => `${f.slot}:${f.gapMm === null ? '—' : f.gapMm.toFixed(2)}[${f.what}]`).join('  '));
  }
  console.log(`  her ORIGIN sits ${r.seatToSolidMm === null ? '—' : r.seatToSolidMm.toFixed(2)} mm above the collision; `
    + `her lowest drawn vertex is ${r.skinLowMm.toFixed(2)} mm from it (negative = below her origin)`);
  const solid = r.feet.map((f) => f.solidMm).filter((v) => v !== null);
  console.log(`  claw -> COLLISION surface: `
    + (solid.length
      ? `mean ${(solid.reduce((a, b) => a + b, 0) / solid.length).toFixed(2)} mm  [`
        + r.feet.map((f) => f.solidMm === null ? '—' : f.solidMm.toFixed(2)).join(' ') + ']'
      : 'none found'));
};

say(await probe('CONTROL — standing on the island'));

/*
 * Walk her at the trunk on SIMULATED time. Software GL renders about a frame
 * a second, so fourteen seconds of wall clock is a quarter-second of walking
 * — the first run of this probe reported "ON THE TRUNK" with her up still
 * dead level, which is a measurement of the lawn.
 */
const climb = await page.evaluate(() => {
  const s = window.islandScene;
  const p = s.tree.root.position;
  s.setFacingForTest(Math.atan2(p.x - s.at.x, p.z - s.at.z));
  s.input.walk = 1; s.input.sprint = true;
  const track = [];
  for (let i = 0; i < 60; i += 1) {
    s.stepForTest(1 / 60, 30);
    track.push({ upY: +s.up.y.toFixed(2), yMm: +(s.at.y * 5).toFixed(0) });
  }
  s.input.walk = 0; s.input.sprint = false;
  s.stepForTest(1 / 60, 10);
  return { leastUpY: Math.min(...track.map((t) => t.upY)), last: track.slice(-3) };
});
console.log(`\nclimbing: her up tipped to ${climb.leastUpY} (0 = on a wall), `
  + `last samples ${JSON.stringify(climb.last)}`);
say(await probe('ON THE TRUNK'));
await page.evaluate(() => { window.islandScene.aimPitchForTest(-1.4); });
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/float-trunk.png', timeout: 90000 });

console.log(`\npage errors: ${errs.length ? errs.join(' | ') : 'none'}`);
await browser.close();
