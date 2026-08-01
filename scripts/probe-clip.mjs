/**
 * Where does she go under the soil, over a WHOLE RUN?
 *
 * The smoke test asks this question once, standing still at spawn, and the
 * answer there is comfortably inside budget. That is exactly where it is
 * inside budget: this probe walks her, and walking is four times worse.
 *
 *     phase   worst clip           against a 0.35 mm budget
 *     rest    head   -0.287 mm     inside
 *     walk    leg    -0.670 mm     rear-right tibia, Bone_040
 *     walk    head   -0.452 mm     Bone_046
 *     walk    gaster -0.317 mm     Bone_005
 *
 * Two mechanisms, both known and neither fixed yet:
 *
 *   - The ground guard probes the BONE LINE, on purpose — probing the mesh
 *     underside makes it read her own gaster's 1.5 mm radius as depth and haul
 *     her out of a burrow she is standing in. So a head whose bone is clear
 *     and whose MESH is half a millimetre under is invisible to it. Measured
 *     over a 240-frame walk the guard returned exactly zero lift throughout.
 *   - The leg solver does check every joint it owns against the soil, but only
 *     AT the joints, and only for three joints up from the foot.
 *
 * Sampling the bones along their length rather than at their ends was tried
 * and changed nothing — the clip is not between two clear joints, so that was
 * the wrong mechanism. Reverted rather than shipped.
 *
 * UNDERGROUND IS NOT MEASURED HERE, and that is deliberate. "Below the height
 * probe" and "inside solid soil" are the same question above ground and
 * different questions in a tunnel, where the floor is below her and the roof
 * above; asking the first one in a burrow returns nonsense (-4.2 mm on every
 * part of her at once, which is her depth, not her clipping). That needs the
 * density field, not a height query.
 *
 *     npm run probe:clip          # needs `vite preview` already running
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4173/Thronemound-Colony-Sim/?map=densityterrainlab&nomenu=1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.labScene?.queenReady === true, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const lab = window.labScene;
  const rig = lab.queen.rig;

  // Every bone she has, labelled by the part a player would name it.
  const group = new Map();
  const tag = (names, label) => { for (const n of names ?? []) group.set(n, label); };
  tag(rig.body, 'body');
  tag(rig.thorax, 'thorax');
  tag(rig.mouth, 'head');
  tag(rig.mandibleLeft, 'head');
  tag(rig.mandibleRight, 'head');
  tag(rig.antennaLeft, 'antenna');
  tag(rig.antennaRight, 'antenna');
  tag(rig.gaster, 'gaster');
  for (const leg of rig.legs) tag(leg.bones, 'leg');
  const where = new Map();
  for (const leg of rig.legs) {
    leg.bones.forEach((n, i) => where.set(n, `${leg.slot}[${i}/${leg.bones.length - 1}]`));
  }

  /*
   * The DRAWN vertices, not the skeleton. A skeleton is a set of lines and a
   * leg is a tube around them; the version of this check that measured bones
   * passed while five thousand rendered vertices were under the surface, which
   * is the thing you actually see. Dominant bone per vertex is fixed for the
   * life of the mesh, so it is resolved once here rather than every sample.
   */
  const meshes = [];
  lab.queen.root.traverse((n) => {
    if (!n.isSkinnedMesh) return;
    const si = n.geometry.attributes.skinIndex;
    const sw = n.geometry.attributes.skinWeight;
    const owner = new Array(si.count);
    for (let i = 0; i < si.count; i += 1) {
      let best = 0;
      let bestWeight = -1;
      for (let k = 0; k < 4; k += 1) {
        const w = sw.getComponent(i, k);
        if (w > bestWeight) { bestWeight = w; best = si.getComponent(i, k); }
      }
      const bone = n.skeleton.bones[best];
      owner[i] = bone ? { part: group.get(bone.name) ?? 'other', bone: bone.name } : null;
    }
    meshes.push({ mesh: n, owner });
  });

  const worst = {};
  const buried = {};
  const sample = (phase) => {
    lab.queen.root.updateMatrixWorld(true);
    for (const { mesh, owner } of meshes) {
      const count = mesh.geometry.attributes.position.count;
      for (let i = 0; i < count; i += 1) {
        const own = owner[i];
        if (!own) continue;
        const v = mesh.getVertexPosition(i, mesh.position.clone());
        mesh.localToWorld(v);
        const gap = v.y - lab.groundAt(v.x, v.z, v.y + 0.4);
        if (gap >= 0) continue;
        const key = `${phase}/${own.part}`;
        buried[key] = (buried[key] ?? 0) + 1;
        if (gap < (worst[key]?.gap ?? 0)) {
          worst[key] = { gap, bone: own.bone, at: where.get(own.bone) ?? '-' };
        }
      }
    }
  };

  sample('rest');
  lab.input.walk = 1;
  for (let f = 0; f < 240; f += 1) {
    lab.stepForTest(1 / 60, 1);
    if (f % 4 === 0) sample('walk');
  }
  lab.input.walk = 0;

  return Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, {
    mm: +(v.gap * 5).toFixed(3), bone: v.bone, at: v.at, vertices: buried[k],
  }]));
});

const BUDGET_MM = 0.35;
let over = 0;
for (const key of Object.keys(report).sort()) {
  const row = report[key];
  const flag = row.mm < -BUDGET_MM ? 'OVER' : '  ok';
  if (row.mm < -BUDGET_MM) over += 1;
  console.log(
    `${flag}  ${key.padEnd(16)} ${String(row.mm).padStart(8)} mm  `
    + `${row.at.padEnd(20)} ${row.bone}  (${row.vertices} vertices)`,
  );
}
console.log(over ? `\n${over} body part(s) past the ${BUDGET_MM} mm budget` : '\nall parts within budget');
await browser.close();
