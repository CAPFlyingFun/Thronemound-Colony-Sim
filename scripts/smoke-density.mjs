/**
 * Headless smoke test for the density terrain lab.
 *
 * Runs at a real phone's DEVICE PIXEL RATIO, which is the whole point of it
 * existing. The lab shipped with `renderer.setSize(w, h, false)` — the third
 * argument suppresses the canvas CSS size — and a canvas with no CSS size
 * displays at its attribute size in CSS pixels, which is the buffer, which is
 * viewport x pixel ratio. On a ratio-2 phone that is a canvas twice the
 * viewport pinned to the top left and clipped, so the middle of the render sat
 * half a screen down and right of the crosshair and digging landed in the
 * corner. Reported from play as "not happening at the crosshair but bottom
 * right", in both orientations, because the ratio does not change when you
 * rotate.
 *
 * It survived a headless check because that check ran at ratio 1, where the
 * bug is exactly invisible: attribute size and CSS size agree. So this runs
 * every ratio, and it asserts the geometry directly rather than by eye.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4173/Thronemound-Colony-Sim/?map=densityterrainlab';
const OUT = process.env.SMOKE_OUT ?? '/tmp/density-smoke';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ok  ${msg}`);

/** Portrait and landscape, at the pixel ratios phones actually report. */
const CASES = [
  { name: 'portrait  ratio 1', width: 430, height: 932, dpr: 1 },
  { name: 'portrait  ratio 2', width: 430, height: 932, dpr: 2 },
  { name: 'portrait  ratio 3', width: 430, height: 932, dpr: 3 },
  { name: 'landscape ratio 2', width: 932, height: 430, dpr: 2 },
];

for (const view of CASES) {
  const page = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: view.dpr,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const geom = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const host = document.querySelector('.density-lab-host') ?? document.getElementById('app');
    const cross = document.querySelector('.density-lab-crosshair');
    const cr = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const xr = cross?.getBoundingClientRect();
    return {
      host: [Math.round(hr.width), Math.round(hr.height)],
      canvasCss: [Math.round(cr.width), Math.round(cr.height)],
      canvasBuffer: [canvas.width, canvas.height],
      // Where the CENTRE OF THE RENDER lands on screen, versus where the
      // crosshair says the player is aiming. The dig ray is NDC (0,0), so
      // these two must be the same point or the dig lands somewhere else.
      renderCentre: [Math.round(cr.x + cr.width / 2), Math.round(cr.y + cr.height / 2)],
      crosshair: xr ? [Math.round(xr.x + xr.width / 2), Math.round(xr.y + xr.height / 2)] : null,
    };
  });

  const [dx, dy] = geom.crosshair
    ? [geom.renderCentre[0] - geom.crosshair[0], geom.renderCentre[1] - geom.crosshair[1]]
    : [NaN, NaN];

  // The canvas must OCCUPY the host, not overflow it. Two pixels of slack for
  // sub-pixel layout rounding; the failure this guards was 430 and 932 out.
  const fits = Math.abs(geom.canvasCss[0] - geom.host[0]) <= 2
    && Math.abs(geom.canvasCss[1] - geom.host[1]) <= 2;
  if (!fits) fail(`${view.name}: canvas ${geom.canvasCss} does not fill host ${geom.host}`);
  else ok(`${view.name}: canvas fills the host (${geom.canvasCss})`);

  // And the buffer should still be the ratio-scaled size, capped at 2 — losing
  // the fix by dropping setPixelRatio would pass the test above and look soft.
  const cap = Math.min(view.dpr, 2);
  const sharp = geom.canvasBuffer[0] >= geom.host[0] * cap - 2;
  if (!sharp) fail(`${view.name}: buffer ${geom.canvasBuffer} is below ratio ${cap}`);
  else ok(`${view.name}: buffer is ratio-${cap} sharp (${geom.canvasBuffer})`);

  if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
    fail(`${view.name}: aim is off by ${dx},${dy} px — dig will not land at the crosshair`);
  } else ok(`${view.name}: render centre sits under the crosshair (off by ${dx},${dy})`);

  if (errors.length) fail(`${view.name}: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

/* Digging actually works, and reports soil. Once is enough — the geometry
 * above is what varies by viewport, not the arithmetic. */
{
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}-before.png` });
  for (let i = 0; i < 4; i++) {
    await page.locator('button', { hasText: 'DIG' }).first().click({ force: true });
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: `${OUT}-after.png` });
  /*
   * The queen has to have actually arrived. `QueenModel.load` resolves FALSE
   * on failure rather than throwing, which is right — a missing model must not
   * take the scene down — but it means a 404 on the 1.4 MB glb looks exactly
   * like a working build with an invisible player, and nothing in the console
   * says otherwise.
   */
  const banner = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  if (/failed to load|loading/.test(banner)) fail(`queen model did not load: "${banner}"`);
  else if (!/Queen: \d+ mm/.test(banner)) fail(`HUD does not report the queen: "${banner}"`);
  else ok(`queen loaded and scaled (${/Queen: [^·<]*/.exec(banner)?.[0].trim()})`);

  /*
   * How big she actually is, measured off the loaded model rather than off the
   * constant that was meant to set it. `rigScale` divides a caste length in
   * millimetres by the model's own measured length, so a re-export with
   * different proportions changes her size while every number in the source
   * stays exactly the same — and at ant scale nobody can eyeball 20% out.
   */
  const size = await page.evaluate(() => {
    const lab = window.labScene;
    if (!lab?.queenReady) return null;
    const bones = lab.queen.bones;
    const feet = lab.queen.rig.legs.map((l) => {
      const b = bones.get(l.bones[l.bones.length - 1]);
      return b ? b.getWorldPosition(b.position.clone()).z : null;
    }).filter((v) => v !== null);
    const mouth = bones.get(lab.queen.rig.mouth.at(-1));
    const gaster = bones.get(lab.queen.rig.gaster.at(-1));
    return {
      legSpan: Math.max(...feet) - Math.min(...feet),
      headToTail: mouth && gaster
        ? mouth.getWorldPosition(mouth.position.clone()).z
          - gaster.getWorldPosition(gaster.position.clone()).z
        : 0,
    };
  });
  if (!size) fail('could not measure the queen');
  else {
    const WORLD_UNIT_MM = 5;
    const spanMm = size.legSpan * WORLD_UNIT_MM;
    // Within a tenth of the 9 mm she is configured at. Her legs reach a little
    // past her body, so this is a fair proxy for overall length.
    if (Math.abs(spanMm - 9) > 0.9) fail(`queen measures ${spanMm.toFixed(2)} mm, not 9 mm`);
    else ok(`queen measures ${spanMm.toFixed(2)} mm front foot to rear foot`);
    // Head toward +Z, which is what `forward = (sin f, 0, cos f)` assumes.
    if (!(size.headToTail > 0)) fail('the queen model faces -Z; her heading is backwards');
    else ok('queen faces +Z, matching the heading maths');
  }

  /*
   * Does she follow the mesh after it changes UNDER her?
   *
   * Reported from play as "the ball doesn't automatically adjust to the new
   * mesh", and the cause was that the ground height was only re-read inside
   * the movement branch — so standing still over a hole you had just made left
   * you at the height the soil used to be. Digging at the crosshair cannot
   * test it, because the crosshair is not necessarily under her; this carves
   * at her own feet and watches her drop, which is the actual claim.
   */
  const drop = await page.evaluate(async () => {
    const lab = window.labScene;
    if (!lab) return null;
    const before = lab.antPosition.y;
    /*
     * Wider than she is. Her body rides on her stance, so a hole narrower than
     * her footprint is one she straddles rather than falls into — which is
     * correct, and which makes a narrow hole the wrong instrument for asking
     * whether she follows the ground down.
     */
    const r = lab.stream.field.cellSize * 40;
    for (let i = 0; i < 6; i += 1) {
      lab.stream.subtractSphere(
        { x: lab.antPosition.x, y: before + r - i * 0.1, z: lab.antPosition.z }, r,
      );
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { before, after: lab.antPosition.y };
  });
  if (!drop) fail('could not reach the scene to test ground following');
  else if (!(drop.after < drop.before - 0.05)) {
    fail(`she did not drop into a hole dug under her: ${drop.before} -> ${drop.after}`);
  } else {
    const mm = (drop.before - drop.after) * 5;
    ok(`she drops ${mm.toFixed(2)} mm when the soil under her is removed`);
  }

  /*
   * The DRAWN legs against the soil, not the skeleton.
   *
   * The first version of this check measured foot BONES, found all six sitting
   * a hundredth of a millimetre above the ground exactly as designed, and
   * passed — while 5,875 of her 80,754 rendered vertices were under the
   * surface, the worst by 0.4 mm, which is what you actually see. A skeleton
   * is a set of lines; a leg is a tube drawn around them, and the joint above
   * the foot was a quarter-millimetre under with the tube's radius below that
   * again. Measuring the thing that is displayed is the only version of this
   * question that means anything.
   */
  const legs = await page.evaluate(() => {
    const lab = window.labScene;
    if (!lab?.queenReady) return null;
    lab.queen.root.updateMatrixWorld(true);
    const legBones = new Set(lab.queen.rig.legs.flatMap((l) => l.bones));
    const antennaBones = new Set([
      ...lab.queen.rig.antennaLeft, ...lab.queen.rig.antennaRight,
    ]);
    let antennaChecked = 0, antennaBuried = 0, antennaDeepest = 0;
    let anyChecked = 0, anyBuried = 0, anyDeepest = 0;
    let checked = 0;
    let buried = 0;
    let deepest = 0;
    let touching = 0;
    let closest = Infinity;
    lab.queen.root.traverse((n) => {
      if (!n.isSkinnedMesh) return;
      const position = n.geometry.attributes.position;
      const skinIndex = n.geometry.attributes.skinIndex;
      const skinWeight = n.geometry.attributes.skinWeight;
      for (let i = 0; i < position.count; i++) {
        let best = 0, bestWeight = -1;
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(i, k);
          if (w > bestWeight) { bestWeight = w; best = skinIndex.getComponent(i, k); }
        }
        const bone = n.skeleton.bones[best];
        if (!bone) continue;
        const v = n.getVertexPosition(i, n.position.clone());
        n.localToWorld(v);
        const gap = v.y - lab.groundAt(v.x, v.z, v.y + 0.4);

        // Everything she is made of, then the two parts with their own solver.
        anyChecked++;
        if (gap < 0) { anyBuried++; anyDeepest = Math.min(anyDeepest, gap); }
        if (antennaBones.has(bone.name)) {
          antennaChecked++;
          if (gap < 0) { antennaBuried++; antennaDeepest = Math.min(antennaDeepest, gap); }
        }
        if (!legBones.has(bone.name)) continue;
        checked++;
        if (gap < 0) { buried++; deepest = Math.min(deepest, gap); }
        if (gap >= 0) { closest = Math.min(closest, gap); if (gap * 5 < 0.25) touching++; }
      }
    });
    return {
      checked, buried, deepestMm: deepest * 5, touching, closestMm: closest * 5,
      antennaChecked, antennaBuried, antennaDeepestMm: antennaDeepest * 5,
      anyChecked, anyBuried, anyDeepestMm: anyDeepest * 5,
    };
  });
  if (!legs || legs.checked < 1000) fail(`could not measure the drawn legs (${legs?.checked})`);
  else if (legs.buried > 0) {
    fail(`${legs.buried} of ${legs.checked} leg vertices are under the soil, worst ${legs.deepestMm.toFixed(3)} mm`);
  } else {
    ok(`no part of a drawn leg is under the soil (${legs.checked} vertices)`);
    /*
     * And she must not HOVER. Six legs held clear of the ground pass the check
     * above while looking like she is floating, so this bounds the gap from
     * the other side.
     *
     * It is a hover budget, not a contact test, and the difference matters:
     * her legs are tubes about half a millimetre thick and the solver aims the
     * bone at the ground plus that radius, so the drawn surface only touches
     * where the tube happens to be tangent. Measured at 0.38 mm at the
     * closest, of which 0.16 is the fail-safe lift. Six tenths of a millimetre
     * is under a fifteenth of her body length — closer than you can see, and
     * far enough from the 0.4 mm she used to be BURIED to be a real bound.
     */
    if (legs.closestMm > 0.6) fail(`she is hovering: closest leg vertex ${legs.closestMm.toFixed(3)} mm above the soil`);
    else ok(`her legs rest on the surface (closest ${legs.closestMm.toFixed(3)} mm, ${legs.touching} within 0.25 mm)`);
  }

  /*
   * The antennae, and then EVERYTHING.
   *
   * The legs were checked and fixed and the antennae went on clipping, because
   * a check written for legs is a check about legs — nothing was looking at
   * the rest of her at all. The whole-body count is the one that cannot be
   * outflanked by the next part nobody thought of.
   */
  if (legs) {
    if (legs.antennaChecked < 100) fail(`could not find her antennae (${legs.antennaChecked} vertices)`);
    else if (legs.antennaBuried > 0) {
      fail(`${legs.antennaBuried} antenna vertices are under the soil, worst ${legs.antennaDeepestMm.toFixed(3)} mm`);
    } else ok(`her antennae are clear of the soil (${legs.antennaChecked} vertices)`);

    if (legs.anyBuried > 0) {
      fail(`${legs.anyBuried} of ${legs.anyChecked} vertices anywhere on her are under the soil, worst ${legs.anyDeepestMm.toFixed(3)} mm`);
    } else ok(`no part of her is under the soil at all (${legs.anyChecked} vertices)`);
  }

  /*
   * Does she dig with her FACE?
   *
   * Reported as her lying across the hole like a plank over it, which is what
   * digging at the camera's crosshair produces: the crosshair is the centre of
   * the screen, the camera looks at her, so the crater opens under her middle.
   * The bite has to start at her mouthparts instead. Measured as a comparison
   * rather than a threshold, because the right number depends on her size and
   * the answer either way is unambiguous: the crater is nearer her jaws than
   * her belly, or the change did not happen.
   */
  const bite = await page.evaluate(() => {
    const lab = window.labScene;
    if (!lab?.queenReady) return null;
    const jaws = new (lab.antPosition.constructor)();
    if (!lab.queen.jawPosition(jaws)) return null;
    return {
      toJaws: lab.lastBite.distanceTo(jaws),
      toBelly: lab.lastBite.distanceTo(lab.antPosition),
    };
  });
  if (!bite) fail('could not locate the last bite');
  else if (!(bite.toJaws < bite.toBelly)) {
    const mm = (v) => (v * 5).toFixed(2);
    fail(`the bite landed under her body: ${mm(bite.toJaws)} mm from the jaws, ${mm(bite.toBelly)} mm from the centre`);
  } else {
    ok(`bite lands at her jaws (${(bite.toJaws * 5).toFixed(2)} mm) not her centre (${(bite.toBelly * 5).toFixed(2)} mm)`);
  }

  /*
   * Can she get down a shaft and STAY down it, with the view still working?
   *
   * Reported as the ant digging down but snapping back to the top terrain, and
   * it was one query answering the wrong question for three callers at once:
   * ground height was "the topmost soil at this x and z", which inside a
   * burrow is the RIM over her head. The stance thought she was buried, the
   * fail-safe agreed with it, and it lifted her three millimetres out of her
   * own hole — measured at `guard 2.954 mm` on the reported build.
   *
   * So this digs a shaft wider than she is, lets the easing settle, and checks
   * both halves: that she went down, and that nothing hauled her back up.
   */
  const shaft = await page.evaluate(async () => {
    const lab = window.labScene;
    if (!lab) return null;
    const before = lab.antPosition.y;
    // Wider than her stance so she can get into it, but a burrow rather than
    // a quarry — a crater big enough to swallow the camera tests something
    // else, and did: the first version buried the view and rendered sky.
    const r = lab.stream.field.cellSize * 18;
    for (let i = 0; i < 10; i += 1) {
      lab.stream.subtractSphere(
        { x: lab.antPosition.x, y: before + r - i * 0.22, z: lab.antPosition.z }, r,
      );
    }
    /*
     * Called WITHOUT optional chaining, deliberately. It was written `?.()`
     * and the method did not exist — a silent no-op that left every shaft
     * check looking at a stale mesh while the numbers, which read the field
     * rather than the geometry, went on passing. A defensive call that hides a
     * missing function is not defensive.
     */
    lab.rebuildTerrainForTest();
    // Long enough for an eased descent to finish; it is not instant by design.
    await new Promise((done) => setTimeout(done, 1500));
    const cam = lab.camera.position;
    return {
      before, after: lab.antPosition.y, guard: lab.guardLift,
      cameraBuried: lab.solidAt(cam),
    };
  });
  await page.screenshot({ path: `${OUT}-shaft.png` });
  if (!shaft) fail('could not reach the scene to test the shaft');
  else {
    const dropMm = (shaft.before - shaft.after) * 5;
    const guardMm = shaft.guard * 5;
    if (dropMm < 2) fail(`she would not go down the shaft: dropped only ${dropMm.toFixed(2)} mm`);
    else ok(`she descends into a shaft and stays (${dropMm.toFixed(2)} mm down)`);
    // The fail-safe must be idle down there. If it is lifting, it is lifting
    // her out, which is exactly the reported bug wearing a different hat.
    if (guardMm > 0.5) fail(`the fail-safe is hauling her out of the shaft by ${guardMm.toFixed(3)} mm`);
    else ok(`the fail-safe is quiet in the shaft (${guardMm.toFixed(3)} mm)`);
    // And the camera must not have followed her into the dirt.
    if (shaft.cameraBuried) fail('the camera ended up inside the soil, so the view renders as sky');
    else ok('the camera stayed above the soil while she went down');
  }

  const status = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const removed = Number(/Removed: ([\d.]+)/.exec(status)?.[1] ?? 0);
  if (removed <= 0) fail(`digging removed nothing: "${status}"`);
  else ok(`four scoops removed ${removed} voxel³ — "${status}"`);
  if (errors.length) fail(`dig run: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

/*
 * Walking across a tile line, in a real browser.
 *
 * The stream's arithmetic is proved in `tests/terrainStream.test.ts`, which is
 * where it belongs — but that runs the class, not the scene, and everything
 * that can go wrong BETWEEN them is invisible from there: a pad button that
 * never fires, a chunk queue that starves, a mesh left at the window origin it
 * was built against three scrolls ago. So this holds the forward key down long
 * enough to cross a 16 mm tile at 12 mm/s and reads the HUD, which reports the
 * tile the scout is standing in.
 */
{
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);

  const tileOf = async () => {
    const text = await page.locator('.density-lab-status').innerText();
    const m = /Tile (-?\d+),(-?\d+)/.exec(text.replace(/\s+/g, ' '));
    return m ? `${m[1]},${m[2]}` : null;
  };
  const startTile = await tileOf();
  if (!startTile) fail('HUD does not report which tile the scout is in');

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');

  /*
   * Wait for the chunk queue to drain rather than sleeping a fixed amount.
   *
   * This runs on swiftshader, where frames are several times slower than a
   * phone's, so the per-frame build budget buys several times less wall-clock
   * work. A fixed sleep would encode the software renderer's frame rate as if
   * it were the requirement. What matters is that the queue empties at all —
   * and within a few seconds, hence the bound.
   */
  let settled = false;
  for (let i = 0; i < 20 && !settled; i++) {
    await page.waitForTimeout(400);
    settled = !/queued/.test(await page.locator('.density-lab-status').innerText());
  }
  if (!settled) fail('the streamed chunk queue never drained');

  const endTile = await tileOf();
  if (startTile && endTile === startTile) {
    fail(`walking for four seconds never left tile ${startTile}`);
  } else ok(`walked from tile ${startTile} to ${endTile}`);

  // The scroll has to have actually happened AND the chunk queue has to have
  // drained: soil left queued is soil that is not on screen.
  const hud = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const scrollMs = Number(/scroll ([\d.]+) ms/.exec(hud)?.[1] ?? -1);
  if (!(scrollMs > 0)) fail(`no window scroll was reported: "${hud}"`);
  else if (scrollMs > 400) fail(`a scroll took ${scrollMs} ms, which is a visible stall`);
  else ok(`window recentred in ${scrollMs} ms`);
  if (/queued/.test(hud)) fail(`chunks still queued after settling: "${hud}"`);
  else ok('streamed chunks all built');

  // And digging still lands somewhere real after the window has moved.
  await page.locator('button', { hasText: 'DIG' }).first().click({ force: true });
  // Long enough for the pellet to land, so the screenshot shows where a clod
  // comes to REST rather than catching one mid-flight and looking like it is
  // stuck in the air.
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}-walked.png` });
  const after = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  if (!/mm³ freed/.test(after)) fail(`dig after walking did not reach soil: "${after}"`);
  else ok('dig still reaches soil after the window has scrolled');
  if (errors.length) fail(`walk run: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(failed ? '\nDENSITY SMOKE FAILED' : '\nDENSITY SMOKE PASSED');
if (failed) process.exitCode = 1;
