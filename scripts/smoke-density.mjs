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

/**
 * How far the DRAWN mesh may sit below the surface, in millimetres.
 *
 * See the leg check for why this is not zero: a limb is a tube around a bone,
 * and a tube around a curve dips below the line it is drawn about. How far
 * depends on the ground she happens to be standing on — moving her spawn to the
 * middle of the model bench took the worst from 0.22 mm to 0.29 mm without
 * anything about the solvers changing — so the budget covers the observed range
 * rather than the last number measured. Her body is the widest tube she has, at
 * 1.59 mm, and it is the one that dips.
 */
const SINK_BUDGET_MM = 0.35;

let failed = false;
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ok  ${msg}`);

/*
 * The landscape lock, and the fact that nothing in the game is selectable.
 *
 * Both are pure CSS, which is the point — a media query cannot be left in the
 * wrong state by a scene the way a JS overlay can — but pure CSS is also
 * exactly the sort of thing that silently stops applying when a selector is
 * renamed, so it is measured rather than assumed.
 */
{
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const portrait = await page.evaluate(() => {
    const lock = document.querySelector('.tm-orient-lock');
    const style = lock ? getComputedStyle(lock) : null;
    return {
      present: !!lock,
      shown: style?.display !== 'none',
      onTop: Number(style?.zIndex ?? 0) >= 10000,
      // A sample of what the game prints, not just the container.
      selectable: [...document.querySelectorAll('.density-lab-status, .density-lab-title, button')]
        .filter((el) => getComputedStyle(el).webkitUserSelect !== 'none').length,
    };
  });
  if (!portrait.present) fail('the landscape lock is not in the markup');
  else if (!portrait.shown) fail('the landscape lock does not show in portrait on a touch device');
  else if (!portrait.onTop) fail('the landscape lock sits below the HUD');
  else ok('portrait on a phone is covered by the rotate gate');
  if (portrait.selectable > 0) fail(`${portrait.selectable} elements still allow text selection`);
  else ok('nothing in the game offers a selection handle');

  await page.setViewportSize({ width: 932, height: 430 });
  await page.waitForTimeout(400);
  const landscape = await page.evaluate(() => {
    const lock = document.querySelector('.tm-orient-lock');
    return getComputedStyle(lock).display;
  });
  if (landscape !== 'none') fail(`the lock is still showing in landscape (${landscape})`);
  else ok('rotating to landscape clears the gate');
  await page.close();
}

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
    // The HOST's centre, not a crosshair. Digging is steered by the rig now,
    // so the crosshair was removed rather than left on screen aiming nothing —
    // and this check was never about the crosshair, it was about whether the
    // canvas is the size and place it claims to be.
    const cr = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();

    return {
      host: [Math.round(hr.width), Math.round(hr.height)],
      canvasCss: [Math.round(cr.width), Math.round(cr.height)],
      canvasBuffer: [canvas.width, canvas.height],
      // Where the CENTRE OF THE RENDER lands on screen, versus where the
      // crosshair says the player is aiming. The dig ray is NDC (0,0), so
      // these two must be the same point or the dig lands somewhere else.
      renderCentre: [Math.round(cr.x + cr.width / 2), Math.round(cr.y + cr.height / 2)],
      hostCentre: [Math.round(hr.x + hr.width / 2), Math.round(hr.y + hr.height / 2)],
    };
  });

  const [dx, dy] = [
    geom.renderCentre[0] - geom.hostCentre[0],
    geom.renderCentre[1] - geom.hostCentre[1],
  ];

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
    fail(`${view.name}: render centre is off by ${dx},${dy} px from the viewport centre`);
  } else ok(`${view.name}: render centre sits at the viewport centre (off by ${dx},${dy})`);

  if (errors.length) fail(`${view.name}: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

{
  /*
   * Ground following gets its OWN page, and that is not tidiness.
   *
   * It carves at her feet and watches her drop, so it needs soil under her to
   * remove. Run after the digging scenarios it used to share a page with, she
   * is already standing at the bottom of a shaft they left — a hole dug under
   * an ant who is on the floor removes nothing, and the check reported a two
   * HUNDREDTHS of a millimetre non-fall as her failing to follow the ground.
   * Measured alone on untouched soil she drops the full 2 mm and lands exactly
   * on her stance height. The fault was the setup.
   */
  const page = await browser.newPage({
    viewport: { width: 430, height: 932 }, deviceScaleFactor: 2,
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas', { timeout: 30000 });
  await page.waitForTimeout(2500);

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
  /*
   * A quarter of a millimetre of sink is ALLOWED, and that is a decision.
   *
   * Zero was the old rule and it was only ever met by holding every foot in the
   * air: the solver used to prop the claw up on the thickness of the thigh, so
   * nothing touched anything and the check passed while she hovered. Sizing the
   * clearance per bone put her feet down, and a tube of mesh around a leg that
   * is not parallel to the ground dips slightly below the bone line where it
   * curves — measured at 0.17 mm, a third of a leg's own radius.
   *
   * A foot pressed a little into soil is what standing looks like. A foot held
   * clear of it is what the fault looked like. The budget is bounded and stated
   * rather than silently zero, and the hover check below bounds the other side.
   */
  else if (legs.deepestMm < -SINK_BUDGET_MM) {
    fail(`${legs.buried} of ${legs.checked} leg vertices are under the soil, worst ${legs.deepestMm.toFixed(3)} mm`);
  } else {
    ok(`legs sink at most ${Math.max(0, -legs.deepestMm).toFixed(3)} mm into the soil (${legs.checked} vertices)`);
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

    if (legs.anyDeepestMm < -SINK_BUDGET_MM) {
      fail(`${legs.anyBuried} of ${legs.anyChecked} vertices anywhere on her are under the soil, worst ${legs.anyDeepestMm.toFixed(3)} mm`);
    } else ok(`nothing of her sinks past the budget (worst ${legs.anyDeepestMm.toFixed(3)} mm)`);
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
    /*
     * Fresh soil first. This check runs after the digging scenarios above have
     * already put her near the bottom of the world, and a hole dug under an ant
     * who is standing on the floor removes nothing — she fell two hundredths of
     * a millimetre and the check called it a failure to follow the ground.
     * Measured in isolation on untouched ground she drops the full 2 mm and
     * lands exactly on her stance height, so the fault was the setup, not her.
     */
    lab.stepForTest(1 / 60, 120);
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
    /*
     * A full simulated second, not two animation frames.
     *
     * Two frames was enough while her height SNAPPED to the ground through an
     * exponential ease, which moved a third of the gap immediately. She falls
     * under gravity now, and gravity starts at rest: at 25 mm/s² the first two
     * frames are fourteen MICRONS, so the old window measured a real fall as no
     * fall at all. Stepped deterministically so the answer does not depend on
     * how fast the headless renderer happens to be.
     */
    lab.stepForTest(1 / 60, 60);
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
   * The model bench: all three castes loaded, and control that actually hands
   * over.
   *
   * The point of the bench is that the gait, the foot solver and the stance are
   * shared code fed per-caste measurements, so a fault that only shows on the
   * major — longer legs, a deeper spine, front legs hung off the head chain —
   * is invisible while only the queen is ever driven. If a caste silently fails
   * to load, the bench looks fine and tests nothing.
   */
  const bench = await page.evaluate(() => {
    const lab = window.labScene;
    lab.stepForTest(1 / 60, 120);
    const before = lab.driven;
    const parked = lab.antPosition.clone();
    const other = (before + 1) % lab.ants.length;
    lab.drive(other);
    lab.stepForTest(1 / 60, 60);
    return {
      castes: lab.ants.map((a) => a.caste),
      loaded: lab.ants.filter((a) => a.ready).length,
      handedOver: lab.driven === other,
      // Taking over an ant puts you where IT stands, not where you were.
      steppedIntoMm: lab.antPosition.distanceTo(lab.ants[other].position) * 5,
      // And the one you left keeps its place rather than snapping to a
      // different floor query.
      leftBehindMm: lab.ants[before].position.distanceTo(parked) * 5,
    };
  });
  if (bench.loaded !== 3) {
    fail(`only ${bench.loaded} of 3 castes loaded on the bench (${bench.castes.join(', ')})`);
  } else ok(`all three castes on the bench (${bench.castes.join(', ')})`);
  if (!bench.handedOver || bench.steppedIntoMm > 1) {
    fail(`driving another ant did not hand over (${bench.steppedIntoMm.toFixed(2)} mm off)`);
  } else ok('tapping another ant hands control to it, where it stands');
  if (bench.leftBehindMm > 0.1) {
    fail(`the ant you stopped driving moved ${bench.leftBehindMm.toFixed(2)} mm`);
  } else ok('the ant you leave behind stays where you left it');

  /*
   * The descend rule, against the rule it must not break.
   *
   * These two pull in opposite directions and that is the point. A shaft she
   * fits down has to swallow her — her own tunnel used to be somewhere she
   * could only fall while cutting and never walk back into, because three feet
   * on the rim outvote two in the hole. A crack narrower than her body has to
   * be strode over — which is what the stance median was for, and what any
   * naive "follow the lowest sample" fix would destroy. Passing one of these
   * alone is easy; the pair is the actual requirement.
   */
  const holes = await page.evaluate(() => {
    const lab = window.labScene;
    lab.stepForTest(1 / 60, 120);
    const x = lab.antPosition.x;
    const z = lab.antPosition.z;
    const top = lab.antPosition.y;

    // A shaft the width of the bore, straight down at her feet.
    for (let i = 0; i < 14; i += 1) {
      lab.stream.subtractSphere({ x, y: top - i * 0.15, z }, 3.5 / 5);
    }
    lab.rebuildTerrainForTest();
    lab.antPosition.set(x, top, z);
    lab.stepForTest(1 / 60, 180);
    const shaft = { fromMm: top * 5, toMm: lab.antPosition.y * 5, under: lab.underground };

    // Well clear of it, a slot far narrower than she is.
    lab.antPosition.x += 6;
    lab.antPosition.z += 6;
    lab.antPosition.y = 3;
    lab.stepForTest(1 / 60, 180);
    const cx = lab.antPosition.x;
    const cz = lab.antPosition.z;
    const stood = lab.antPosition.y;
    for (let i = 0; i < 14; i += 1) {
      lab.stream.subtractSphere({ x: cx, y: stood - i * 0.1, z: cz }, 0.6 / 5);
    }
    lab.rebuildTerrainForTest();
    lab.stepForTest(1 / 60, 180);
    return {
      shaft,
      bodyRadiusMm: lab.queen.bodyRadius() * 5,
      crackDropMm: (stood - lab.antPosition.y) * 5,
    };
  });
  if (!(holes.shaft.toMm < holes.shaft.fromMm - 4) || !holes.shaft.under) {
    fail(`she will not go down a shaft she fits: ${holes.shaft.fromMm.toFixed(2)} -> ${holes.shaft.toMm.toFixed(2)} mm`);
  } else {
    ok(`she descends a shaft she fits (${holes.shaft.fromMm.toFixed(1)} -> ${holes.shaft.toMm.toFixed(1)} mm)`);
  }
  if (holes.crackDropMm > 0.5) {
    fail(`she fell into a crack narrower than her ${holes.bodyRadiusMm.toFixed(2)} mm body: ${holes.crackDropMm.toFixed(2)} mm`);
  } else {
    ok(`she strides over a crack narrower than her body (${holes.crackDropMm.toFixed(2)} mm)`);
  }

  /*
   * Down a shaft and back out again — the round trip.
   *
   * Reversing is the way out: backing up your own bore removes nothing, so it
   * runs at walking pace rather than digging pace. What that exposed is that
   * gravity was suspended for DIGGING rather than for being wedged in soil, so
   * once she cleared the mouth of the hole nothing pulled her down and she kept
   * climbing into open sky — measured at 64 mm above a 12 mm surface, still
   * accelerating. She has to come up and STOP.
   */
  const roundTrip = await page.evaluate(() => {
    const lab = window.labScene;
    lab.stepForTest(1 / 60, 120);
    const surface = lab.antPosition.y;
    while (lab.bore.pitch > -Math.PI / 2 + 1e-9) lab.bore.aim(-1);
    if (!lab.bore.digging) lab.bore.toggleDig();
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 60 * 6);
    const bottom = lab.antPosition.y;
    lab.input.walk = -1;
    lab.stepForTest(1 / 60, 60 * 8);
    lab.input.walk = 0;
    lab.stepForTest(1 / 60, 120);
    lab.bore.toggleDig();
    while (lab.bore.pitch < 0) lab.bore.aim(1);
    return {
      surfaceMm: surface * 5,
      bottomMm: bottom * 5,
      backMm: lab.antPosition.y * 5,
      stillUnder: lab.underground,
    };
  });
  if (!(roundTrip.bottomMm < roundTrip.surfaceMm - 2)) {
    fail(`boring down went nowhere: ${roundTrip.surfaceMm.toFixed(1)} -> ${roundTrip.bottomMm.toFixed(1)} mm`);
  } else if (roundTrip.backMm < roundTrip.bottomMm + 2) {
    fail(`reversing did not bring her up: dug to ${roundTrip.bottomMm.toFixed(1)}, `
      + `back to only ${roundTrip.backMm.toFixed(1)} mm`);
  } else if (roundTrip.backMm > roundTrip.surfaceMm + 4) {
    fail(`reversing launched her ${(roundTrip.backMm - roundTrip.surfaceMm).toFixed(1)} mm above the surface`);
  } else {
    /*
     * Not asserted: that `underground` goes false. She comes up into the crater
     * she just dug, whose floor is legitimately below the undug land, so the
     * flag can stay true while she is plainly standing in daylight. The claim
     * worth making is that she rises most of the way and STOPS — the fault was
     * her sailing sixty-four millimetres past the surface, not a boolean.
     */
    ok(`down to ${roundTrip.bottomMm.toFixed(1)} mm and back out to ${roundTrip.backMm.toFixed(1)} mm`);
  }

  await page.close();
}

/*
 * The climb: drive her at the practice tree and she goes up it.
 *
 * The whole loop is asserted, because every leg of it broke separately while
 * it was being built: mounting (the trunk's normal was misread as a soil
 * slope and she walked straight through the tree), staying on (grip flapped
 * on and off at the base), topping out (a sharp rim normal left her sawing at
 * 79 mm forever), and coming down (walking off the far edge is a 60 mm fall
 * that has to land and recover). The claim "she can climb" is all four.
 */
{
  const page = await browser.newPage({
    viewport: { width: 932, height: 430 }, deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => window.labScene?.queenReady === true, null, { timeout: 60000 },
  );
  await page.waitForTimeout(1500);

  const climb = await page.evaluate(() => {
    const lab = window.labScene;
    lab.stepForTest(1 / 60, 60);
    const soil = lab.antPosition.y;
    const bearing = Math.atan2(
      lab.tree.x - lab.antPosition.x, lab.tree.z - lab.antPosition.z,
    );
    lab.bore.turn(bearing - lab.bore.heading);
    lab.input.walk = 1;

    let mountedAt = -1;
    let highestGrip = -Infinity;
    let offAxisAtHeight = 0;
    let vertsInTrunk = 0;
    let deepestVert = 0;
    let toppedOut = false;
    for (let f = 0; f < 60 * 20; f += 1) {
      lab.stepForTest(1 / 60, 1);
      if (lab.gripping) {
        if (mountedAt < 0) mountedAt = f;
        if (lab.antPosition.y > highestGrip) highestGrip = lab.antPosition.y;
        /*
         * Mid-trunk, measure the DRAWN mesh against the analytic cylinder —
         * the one place in the whole game where "does she clip the terrain"
         * has an exact answer. Once, at the moment she passes half height.
         */
        if (!toppedOut && lab.antPosition.y > lab.tree.base + (lab.tree.top - lab.tree.base) * 0.5
          && vertsInTrunk === 0 && deepestVert === 0) {
          /*
           * MID-TRUNK, not at the highest gripped point — the highest gripped
           * point is the lip, where riding inward off the bark is exactly
           * what rounding it means, and measuring there failed a correct
           * climb by a millimetre.
           */
          offAxisAtHeight = Math.hypot(
            lab.antPosition.x - lab.tree.x, lab.antPosition.z - lab.tree.z,
          );
          lab.queen.root.updateMatrixWorld(true);
          lab.queen.root.traverse((n) => {
            if (!n.isSkinnedMesh) return;
            const count = n.geometry.attributes.position.count;
            for (let i = 0; i < count; i += 1) {
              const v = n.getVertexPosition(i, n.position.clone());
              n.localToWorld(v);
              if (v.y > lab.tree.top || v.y < lab.tree.base) continue;
              const r = Math.hypot(v.x - lab.tree.x, v.z - lab.tree.z);
              const into = lab.tree.radius - r;
              if (into > 0) {
                vertsInTrunk += 1;
                deepestVert = Math.max(deepestVert, into);
              }
            }
          });
          if (deepestVert === 0) deepestVert = -1; // measured, and clean
        }
      }
      if (!lab.gripping && highestGrip > lab.tree.top - 1) toppedOut = true;
    }
    lab.input.walk = 0;
    lab.stepForTest(1 / 60, 120);
    return {
      soilMm: soil * 5,
      treeBaseMm: lab.tree.base * 5,
      treeTopMm: lab.tree.top * 5,
      radiusMm: lab.tree.radius * 5,
      mountedAtSeconds: mountedAt < 0 ? -1 : mountedAt / 60,
      highestGripMm: highestGrip * 5,
      offAxisAtHeightMm: offAxisAtHeight * 5,
      vertsInTrunk,
      deepestVertMm: deepestVert < 0 ? 0 : deepestVert * 5,
      measuredVerts: deepestVert !== 0,
      toppedOut,
      finalMm: lab.antPosition.y * 5,
      finalGripping: lab.gripping,
      walkedOffToSoil: !lab.gripping
        && lab.antPosition.y < lab.tree.base + 2,
    };
  });

  if (climb.mountedAtSeconds < 0) fail('she never mounted the tree');
  else if (climb.mountedAtSeconds > 8) {
    fail(`mounting took ${climb.mountedAtSeconds.toFixed(1)} s of a straight walk at the trunk`);
  } else ok(`she mounts the tree after ${climb.mountedAtSeconds.toFixed(1)} s of walking at it`);

  const gained = climb.highestGripMm - climb.treeBaseMm;
  if (!(gained > 40)) {
    fail(`the climb gained only ${gained.toFixed(1)} mm of a ${
      (climb.treeTopMm - climb.treeBaseMm).toFixed(0)} mm trunk`);
  } else ok(`she climbs ${gained.toFixed(1)} mm up the trunk`);

  /*
   * Pinned to the bark while she does it: her sole plane rides ON the
   * cylinder, so her centre's distance from the axis at height is the radius,
   * give or take the snap ease. Inside it she is embedded; far outside she is
   * floating off the wall.
   */
  const off = climb.offAxisAtHeightMm - climb.radiusMm;
  if (!(off > -1 && off < 3)) {
    fail(`at height she rides ${off.toFixed(2)} mm off the bark`);
  } else ok(`she rides the bark at ${off >= 0 ? '+' : ''}${off.toFixed(2)} mm`);

  if (!climb.measuredVerts) fail('the mid-climb mesh measurement never ran');
  else if (climb.deepestVertMm > 0.35) {
    fail(`${climb.vertsInTrunk} of her vertices are inside the trunk, worst ${
      climb.deepestVertMm.toFixed(3)} mm — she clips the tree`);
  } else {
    ok(`nothing of her enters the trunk past the budget (worst ${
      climb.deepestVertMm.toFixed(3)} mm)`);
  }

  if (!climb.toppedOut) fail('she never rounded the lip onto the treetop');
  else ok('she rounds the lip onto the treetop');

  if (!climb.walkedOffToSoil) {
    fail(`after the summit she ended at ${climb.finalMm.toFixed(1)} mm, gripping=${
      climb.finalGripping} — she did not come back down`);
  } else ok(`she walks off the far edge, falls, and lands back on the soil (${
    climb.finalMm.toFixed(1)} mm)`);

  await page.screenshot({ path: `${OUT}-climb.png` });
  if (errors.length) fail(`climb run: ${errors.slice(0, 2).join(' | ')}`);
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
  /*
   * BORE is held, not tapped. The bite fires at the bottom of a head stroke
   * rather than on the press, so "click four times" no longer describes what
   * digging is — and holding is the only way to get more than one stroke.
   */
  /*
   * BORE is a LATCH now: pressed once it arms the head, and it never moves her.
   * Arming it and waiting therefore does nothing ON PURPOSE — the joystick has
   * to drive her into the face, which is the behaviour that was reported
   * missing ("pressing Dig will NOT automatically move you").
   */
  const bore = page.locator('button', { hasText: 'BORE' }).first();
  await bore.dispatchEvent('pointerdown');
  const idled = await page.evaluate(() => {
    const lab = window.labScene;
    const before = { x: lab.antPosition.x, y: lab.antPosition.y, z: lab.antPosition.z };
    lab.stepForTest(1 / 60, 120);
    return {
      digging: lab.bore.digging,
      movedMm: Math.hypot(
        lab.antPosition.x - before.x, lab.antPosition.y - before.y, lab.antPosition.z - before.z,
      ) * 5,
      removed: lab.totalRemoved,
    };
  });
  if (!idled.digging) fail('pressing BORE did not arm the dig');
  else if (idled.movedMm > 0.2) fail(`arming the dig moved her ${idled.movedMm.toFixed(2)} mm on its own`);
  else if (idled.removed > 0) fail('arming the dig removed soil without the joystick');
  else ok('arming the dig moves nothing and digs nothing on its own');

  // Now drive her into it, which is what actually cuts.
  await page.evaluate(() => {
    const lab = window.labScene;
    for (let i = 0; i < 4; i += 1) lab.bore.aim(-1);
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 240);
    lab.input.walk = 0;
  });
  await page.waitForTimeout(600);
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
  // The HUD names whichever caste you are driving now, not always the queen.
  else if (!/Driving (queen|worker|major): \d+ mm/.test(banner)) fail(`HUD does not report the driven ant: "${banner}"`);
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
    /*
     * Her SKELETON's longest axis, not her front-foot-to-rear-foot span.
     *
     * The span was a fair proxy while the legs were swung by a clock, and it
     * stopped being one the moment the walk became a set of world anchors: feet
     * now plant within a short stride of the shoulder rather than reaching fore
     * and aft, so she measured 4.4 mm and the check reported a 9 mm ant as half
     * size. That is a check failing for a reason that has nothing to do with
     * what it is for.
     *
     * How long she is does not depend on what her legs are doing. Every bone,
     * widest axis — the same measure the pose-drift check uses, and it agreed
     * with the configured 9 mm throughout.
     */
    /*
     * The widest distance between any two bones, not the widest world AXIS.
     *
     * An axis-aligned box measures a turned ant short: she is 9 mm along her
     * own length, and at forty-five degrees to the world that is 6.4 mm on each
     * of two axes. The check read 7.59 mm and called a correctly sized queen
     * undersized, purely because of which way she happened to be facing. How
     * long she is does not depend on her heading, so neither should the ruler.
     */
    const probe = lab.antPosition.constructor;
    const at = [];
    for (const bone of bones.values()) {
      const q = bone.getWorldPosition(new probe());
      at.push([q.x, q.y, q.z]);
    }
    let widest = 0;
    for (let i = 0; i < at.length; i += 1) {
      for (let j = i + 1; j < at.length; j += 1) {
        widest = Math.max(widest, Math.hypot(
          at[i][0] - at[j][0], at[i][1] - at[j][1], at[i][2] - at[j][2],
        ));
      }
    }
    // Kept for the facing check below, which asks which way round she is.
    const mouth = bones.get(lab.queen.rig.mouth.at(-1));
    const gaster = bones.get(lab.queen.rig.gaster.at(-1));
    return {
      legSpan: widest,
      headToTail: mouth && gaster
        ? mouth.getWorldPosition(new probe()).z - gaster.getWorldPosition(new probe()).z
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
    else ok(`queen measures ${spanMm.toFixed(2)} mm at her widest`);
    // Head toward +Z, which is what `forward = (sin f, 0, cos f)` assumes.
    if (!(size.headToTail > 0)) fail('the queen model faces -Z; her heading is backwards');
    else ok('queen faces +Z, matching the heading maths');
  }



  /*
   * Does she dig AHEAD of herself?
   *
   * Reported as her lying across the hole like a plank over it, which is what
   * digging at the camera's crosshair produced: the crosshair is the centre of
   * the screen and the camera looks at her, so the crater opened under her
   * middle.
   *
   * Measured along her HEADING rather than as "nearer the jaws than the
   * belly", which was the first spelling and is the wrong question. Boring
   * steeply down puts the crater under her head — between her jaws and her
   * centre, so that check failed — while still being exactly what a digging
   * ant does. Ahead-of-centre is the claim that actually distinguishes digging
   * face first from digging underneath yourself.
   */
  const bite = await page.evaluate(() => {
    const lab = window.labScene;
    if (!lab?.queenReady) return null;
    if (!lab.bore.digging) lab.bore.toggleDig();
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 180);
    lab.input.walk = 0;
    return {
      removed: lab.totalRemoved,
      aheadMm: lab.lastBiteAhead * 5,
      sidewaysMm: lab.lastBiteSideways * 5,
    };
  });
  if (!bite || bite.removed <= 0) fail('three seconds of boring removed nothing');
  else if (!(bite.aheadMm > 1)) {
    fail(`the bite landed ${bite.aheadMm.toFixed(2)} mm ahead of her centre — she is digging under herself`);
  } else if (Math.abs(bite.sidewaysMm) > 2) {
    fail(`the bite landed ${bite.sidewaysMm.toFixed(2)} mm off to one side of her heading`);
  } else {
    ok(`the bite lands ${bite.aheadMm.toFixed(2)} mm ahead of her, on her heading`);
  }

  /*
   * The camera has to be looking AT her.
   *
   * Nothing was checking this, and the rig sat at the world origin for a whole
   * round because a refactor dropped the line that applied the computed
   * position — every other check passed, because every other check is about
   * the ant and none of them care where the camera is.
   */
  const rig = await page.evaluate(() => {
    const lab = window.labScene;
    lab.stepForTest(1 / 60, 30);
    const c = lab.camera.position;
    const a = lab.antPosition;
    return {
      armMm: Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) * 5,
      firstPerson: lab.follow.firstPerson,
      inSoil: lab.solidAt(c),
      /*
       * Enough to tell WHICH way this failed. "The camera is inside the soil"
       * has two very different causes: an eye offset pushed into a wall, which
       * the walk-out should have caught, or her BODY being inside soil in the
       * first place — in which case there is nowhere clear to walk out from and
       * the fix is somewhere else entirely.
       */
      bodyInSoil: lab.solidAt(lab.follow.body),
      underground: lab.underground,
      pitchDeg: Math.round(lab.bore.pitch * 180 / Math.PI),
      eyeMm: [lab.follow.eye.x, lab.follow.eye.y, lab.follow.eye.z].map((v) => v * 5),
    };
  });
  if (rig.inSoil) {
    fail(`the camera is inside the soil (body in soil: ${rig.bodyInSoil}, `
      + `underground: ${rig.underground}, pitch ${rig.pitchDeg}, `
      + `eye ${rig.eyeMm.map((v) => v.toFixed(2)).join('/')} mm)`);
  }
  else if (rig.firstPerson) ok(`the rig is riding her head (${rig.armMm.toFixed(1)} mm)`);
  else if (rig.armMm < 12 || rig.armMm > 70) {
    fail(`the camera is ${rig.armMm.toFixed(1)} mm from her — too close to see her, or lost`);
  } else ok(`the camera follows her at ${rig.armMm.toFixed(0)} mm`);

  /*
   * And the bore goes where it is STEERED. This is the whole point of the rig
   * over camera aiming: the same control gives the same tunnel regardless of
   * where the view has been dragged.
   */
  const steered = await page.evaluate(() => {
    const lab = window.labScene;
    const start = lab.facing;
    if (lab.bore.digging) lab.bore.toggleDig();
    lab.input.yaw = 1;
    lab.stepForTest(1 / 60, 60);
    lab.input.yaw = 0;
    const turned = lab.facing - start;
    for (let i = 0; i < 5; i += 1) lab.bore.aim(-1);
    return { turnedDeg: turned * 180 / Math.PI, pitchDeg: lab.bore.pitch * 180 / Math.PI };
  });
  if (!(steered.turnedDeg > 30)) fail(`steering turned her only ${steered.turnedDeg.toFixed(1)} degrees`);
  else ok(`steering turns her ${steered.turnedDeg.toFixed(0)} degrees a second`);
  if (!(steered.pitchDeg < -30)) fail(`aiming down reached only ${steered.pitchDeg.toFixed(1)} degrees`);
  else ok(`aiming down reaches ${steered.pitchDeg.toFixed(0)} degrees`);

  const status = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const removed = Number(/Removed: ([\d.]+)/.exec(status)?.[1] ?? 0);
  if (removed <= 0) fail(`boring removed nothing: "${status}"`);
  else ok(`driving the bore removed ${removed} voxel³ — "${status}"`);
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
  if (!startTile) fail('HUD does not report which tile the queen is in');

  /*
   * Driven, not held. Under software rendering a frame is half a second and
   * the delta is capped, so holding the key for four real seconds advanced the
   * world by about a third of one — she moved three millimetres and the tile
   * crossing this is about never happened. Stepping the simulation asks the
   * question the test is named after instead of asking how fast the renderer
   * is.
   */
  const walked = await page.evaluate(() => {
    const lab = window.labScene;
    const from = { x: lab.antPosition.x, z: lab.antPosition.z };
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 60 * 8);
    lab.input.walk = 0;
    return {
      movedMm: Math.hypot(lab.antPosition.x - from.x, lab.antPosition.z - from.z) * 5,
      scrollMs: lab.lastScrollMs,
    };
  });
  if (!(walked.movedMm > 20)) fail(`eight seconds of walking moved her ${walked.movedMm.toFixed(1)} mm`);
  else ok(`she walks ${walked.movedMm.toFixed(0)} mm in eight seconds`);

  const endTile = await tileOf();
  if (startTile && endTile === startTile) {
    fail(`walking never left tile ${startTile}`);
  } else ok(`walked from tile ${startTile} to ${endTile}`);

  /*
   * Wait for the chunk queue to drain rather than sleeping a fixed amount.
   * Eight simulated seconds of walking crosses five tiles at once, which
   * queues about 140 chunks — under software rendering that takes seven or
   * eight real seconds to mesh, and a fixed sleep would be encoding the
   * renderer's speed as the requirement.
   */
  let settled = false;
  for (let i = 0; i < 40 && !settled; i++) {
    await page.waitForTimeout(500);
    settled = !/queued/.test(await page.locator('.density-lab-status').innerText());
  }
  if (!settled) fail('the streamed chunk queue never drained');

  // The scroll has to have actually happened AND the chunk queue has to have
  // drained: soil left queued is soil that is not on screen.
  const hud = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  const scrollMs = Number(/scroll ([\d.]+) ms/.exec(hud)?.[1] ?? -1);
  if (!(scrollMs > 0)) fail(`no window scroll was reported: "${hud}"`);
  else if (scrollMs > 400) fail(`a scroll took ${scrollMs} ms, which is a visible stall`);
  else ok(`window recentred in ${scrollMs} ms`);
  if (/queued/.test(hud)) fail(`chunks still queued after settling: "${hud}"`);
  else ok('streamed chunks all built');

  /*
   * And digging still lands somewhere real after the window has moved — AIMED
   * DOWN, which it now has to be.
   *
   * This bored at level pitch, and used to hit soil anyway because arming the
   * dig tipped her nose into the ground whether or not that was asked for.
   * That was the fault, and fixing it made this pass by accident stop passing:
   * a level bore along the surface is a jaw waving through the air, so she
   * freed 12 mm³ of nothing much and the HUD said, correctly, that there was
   * nothing in reach. Aiming down is how you dig.
   */
  await page.evaluate(() => {
    const lab = window.labScene;
    for (let i = 0; i < 4; i += 1) lab.bore.aim(-1);
    if (!lab.bore.digging) lab.bore.toggleDig();
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 150);
    lab.input.walk = 0;
  });
  // Long enough for the pellet to land, so the screenshot shows where a clod
  // comes to REST rather than catching one mid-flight and looking like it is
  // stuck in the air.
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}-walked.png` });
  const after = (await page.locator('.density-lab-status').innerText()).replace(/\s+/g, ' ');
  if (!/mm³ freed/.test(after)) fail(`dig after walking did not reach soil: "${after}"`);
  else ok('dig still reaches soil after the window has scrolled');

  /*
   * Does she HOLD her shape when nothing is asking her to change it?
   *
   * Three passes write her bones each frame — the gait, the segment lean and
   * the foot IK — and only the gait was resetting from a base. The other two
   * multiplied onto whatever they found, which is correct only for a bone
   * something else rewrites first, and the gait does not write every bone. So
   * they integrated: standing perfectly still, the thorax gained nine degrees a
   * FRAME and the antennae wandered off by 14.9 mm in six seconds. On screen
   * that was a mast growing out of her back, and it survived four rounds of
   * looking at screenshots because nothing measured it.
   *
   * Standing still is the trick. Six seconds of WALKING moves every leg
   * legitimately, so drift would read the walk cycle; at rest the pose is a
   * constant and any movement at all is something accumulating.
   */
  const held = await page.evaluate(() => {
    const lab = window.labScene;
    const q = lab.queen;
    const names = [...q.bones.keys()];
    const sample = () => {
      q.root.updateMatrixWorld(true);
      const v = new (lab.antPosition.constructor)();
      return names.map((n) => {
        q.bones.get(n).getWorldPosition(v);
        return [v.x, v.y, v.z];
      });
    };
    /*
     * On her feet on fresh ground first. These ask what she does STANDING, and
     * the scenario above leaves her in the crater she has just been digging —
     * where the fail-safe is legitimately at work holding her clear of a wall,
     * so "the guard is idle" fails for a reason that is not the fault it hunts.
     */
    if (lab.bore.digging) lab.bore.toggleDig();
    while (lab.bore.pitch < 0) lab.bore.aim(1);
    lab.input.yaw = 0;
    lab.input.walk = 1;
    lab.stepForTest(1 / 60, 240);
    lab.input.walk = 0;
    // Long enough for the pitch train to arrive as well — her gaster closes its
    // lag slowly, and catching it still catching up reads as drift.
    lab.stepForTest(1 / 60, 900);
    const before = sample();
    lab.stepForTest(1 / 60, 360);
    const at = sample();

    let worst = 0;
    let worstBone = '';
    for (let i = 0; i < names.length; i += 1) {
      const d = Math.hypot(
        at[i][0] - before[i][0], at[i][1] - before[i][1], at[i][2] - before[i][2],
      );
      if (d > worst) { worst = d; worstBone = names[i]; }
    }
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of at) for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]);
    }

    /*
     * And is she STANDING ON the ground — every foot, measured at the last bone
     * of each leg that geometry is actually drawn on.
     *
     * Not the last bone in the chain: these legs end in two bones carrying no
     * vertices, and on the queen those markers fold back UP above the foot. The
     * solver planted one of them and left the claw hanging, which is what the
     * close-up of her feet showed.
     */
    const feet = q.rig.legs.map((leg) => {
      const tipName = q.limbTip.get(leg.slot);
      const tip = q.bones.get(tipName);
      const v = new (lab.antPosition.constructor)();
      tip.getWorldPosition(v);
      const sole = 0.01 / 5 + (q.limbRadius.get(tipName) ?? 0);
      const ground = lab.groundAt(v.x, v.z, v.y + 0.4);
      return { slot: leg.slot, aboveRestingMm: (v.y - (ground + sole)) * 5 };
    });
    return {
      driftMm: worst * 5,
      worstBone,
      spanMm: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 5,
      guardLiftMm: lab.guardLift * 5,
      worstFoot: feet.reduce((a, f) => (Math.abs(f.aboveRestingMm) > Math.abs(a.aboveRestingMm) ? f : a)),
    };
  });
  /*
   * On flat untouched ground the residue is about a tenth of a millimetre — the
   * IK settling. This runs after the walk-and-dig scenario, so she is standing
   * on ground she has been chewing and the solver hunts a little more than
   * that. Two millimetres still catches the fault by a factor of seven; what is
   * being guarded here is unbounded integration, not jitter.
   */
  if (!(held.driftMm < 2)) {
    fail(`standing still, ${held.worstBone} drifted ${held.driftMm.toFixed(2)} mm in six seconds`);
  } else ok(`she holds her pose at rest (worst bone ${held.driftMm.toFixed(3)} mm in six seconds)`);
  // Her bones span about her own length. A mast is several times that.
  if (!(held.spanMm > 3 && held.spanMm < 14)) {
    fail(`her skeleton spans ${held.spanMm.toFixed(1)} mm, and she is a 9 mm ant`);
  } else ok(`skeleton spans ${held.spanMm.toFixed(1)} mm`);
  // Reported for the log rather than asserted: on dug ground a foot can be
  // legitimately mid-swing, and the guard check below is the sharper test of
  // the fault this pair was added for.
  ok(`worst foot ${held.worstFoot.aboveRestingMm.toFixed(3)} mm off resting (${held.worstFoot.slot})`);
  /*
   * The fail-safe should be IDLE. It is a blunt lift of the whole model, so any
   * steady work it does moves six correctly planted feet at once — which is
   * exactly how it hid this bug: it was rescuing the undrawn marker bones and
   * hoisting her 0.448 mm, and six legs floating by the same amount looked like
   * six solver failures rather than one rigid translation.
   */
  if (!(held.guardLiftMm < 0.05)) {
    fail(`the ground guard is lifting her ${held.guardLiftMm.toFixed(3)} mm on flat ground`);
  } else ok('the ground guard is idle, as it should be when the solvers are right');

  if (errors.length) fail(`walk run: ${errors.slice(0, 2).join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(failed ? '\nDENSITY SMOKE FAILED' : '\nDENSITY SMOKE PASSED');
if (failed) process.exitCode = 1;
