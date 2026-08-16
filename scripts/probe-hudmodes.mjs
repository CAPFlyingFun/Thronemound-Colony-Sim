/**
 * WHAT EACH MODE SHOWS, AND HOW MUCH GLASS IS LEFT TO DRAG.
 *
 *     npx vite --port 5173                                     # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:hudmodes
 *
 * Two questions, and they are the same bug seen from two sides.
 *
 * The report was "ten action plates at once, in every situation". The unit
 * tests pin the TABLE — `tests/hudModes.test.ts` — but a table is a promise
 * about intent; it cannot see a control that was hidden by some other line
 * of code, or one that stayed on screen because nothing registered it.
 *
 * The second question is the one the table cannot answer at all: the camera
 * is driven by dragging the WORLD, so every plate is a hole in the control
 * surface. HIT-TESTED rather than measured off rectangles, because that is
 * the thing that actually decides — `pointer-events: none` boxes are all
 * over this HUD (the rail is air, the quest panel is a readout), and a
 * bounding box would count them as obstructions when a thumb passes clean
 * through. `elementFromPoint` asks the question the browser will answer
 * when a finger lands there.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';

const SIZES = [
  { w: 568, h: 320, what: 'smallest sane landscape' },
  { w: 667, h: 375, what: 'iPhone SE' },
  { w: 844, h: 390, what: 'iPhone 14' },
  { w: 932, h: 430, what: 'the design canvas' },
];

/* Every plate the cluster can hold, by the art class it wears. */
const PLATES = [
  'dig', 'scoop', 'view', 'dodge', 'bite', 'sting',
  'carry', 'drop', 'interact', 'sprint', 'ride', 'tilt',
];

/*
 * HOW MUCH FREE GLASS IS ENOUGH.
 *
 * A third of the screen, and it has to be ONE region rather than a third
 * scattered between buttons — a thumb needs somewhere to start a drag and
 * somewhere to finish it. Measured as the largest solid rectangle of
 * free sample points, which is a lower bound on the real free area and
 * therefore the honest thing to assert.
 */
const WANT_FREE = 0.33;

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

for (const size of SIZES) {
  const p = await b.newPage({
    viewport: { width: size.w, height: size.h },
    deviceScaleFactor: 2, hasTouch: true, isMobile: true,
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 180000 });
  await p.waitForFunction(
    () => document.querySelector('.tm-loading-root') === null, null, { timeout: 180000 },
  );
  await p.waitForTimeout(500);

  console.log(`\n${size.w}x${size.h}  — ${size.what}`);

  /*
   * EACH MODE, FORCED THROUGH THE REAL SIGNALS rather than by setting the
   * mode directly. Setting `hudMode` would prove the renderer works and
   * nothing about whether the game can ever reach that mode — which is the
   * half that strands a player.
   */
  const seen = await p.evaluate(async (plates) => {
    const s = window.islandScene;
    const settle = () => { s.stepForTest(1 / 60, 2); };
    const up = () => plates.filter((n) => {
      const el = document.querySelector(`.tm-art-${n}`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.style.display !== 'none';
    });

    const out = {};

    /*
     * DOES THE CLUSTER FIT, IN THIS MODE?
     *
     * `probe:hud` measures the corners — but it only ever measures the mode
     * the island happens to boot into, which is EXPLORE. A mode with one
     * more plate wraps to a second row, and the far end of the arc lands on
     * the quest card. That is exactly what happened to COMBAT, with six
     * plates, and neither probe saw it: the layout one checks was never in
     * the mode that broke.
     */
    const clash = () => {
      const c = document.querySelector('.tm-cluster')?.getBoundingClientRect();
      const q = document.querySelector('.tm-quest')?.getBoundingClientRect();
      if (!c || !q) return 0;
      const x = Math.min(c.right, q.right) - Math.max(c.left, q.left);
      const y = Math.min(c.bottom, q.bottom) - Math.max(c.top, q.top);
      return x > 0.5 && y > 0.5 ? Math.round(y) : 0;
    };
    /*
     * DO THE PLATES TOUCH EACH OTHER?
     *
     * Reported from the device as "the SCOOP button is just a little too
     * close to the DIG button", and measured at the design canvas it was
     * not close, it was ON it: the two touch boxes overlapped by 22 x 18
     * px. Nothing here saw it, because every check in this file measures
     * the cluster as ONE rectangle against the objective card — a bug
     * INSIDE that rectangle is invisible to all of them.
     *
     * The invariant asserted is the one `fanCluster` actually promises:
     * consecutive plates in the ZIGZAG never touch, because each stepped
     * plate clears the neighbour it steps past. Consecutive in the visual
     * sequence, which is what the eye and the thumb follow — the DOM order
     * is not it, so the sort mirrors `fanCluster`'s.
     *
     * Separated on EITHER axis is separated, so the clearance is the better
     * of the two — plates on opposite sides of the zigzag are allowed to
     * pass each other vertically, which is the whole saving of a diagonal.
     */
    const touching = () => {
      const els = [...document.querySelectorAll('.tm-cluster > *')]
        .filter((e) => e.style.display !== 'none'
          && e.getBoundingClientRect().width > 0)
        .map((el, i) => ({ el, order: Number(getComputedStyle(el).order) || 0, i }))
        .sort((a, b) => a.order - b.order || a.i - b.i);
      const name = (e) => [...e.classList].find((k) => k.startsWith('tm-art-'))
        ?? e.className;
      let worst = { gap: 1e9, pair: '' };
      for (let n = 0; n + 1 < els.length; n += 1) {
        const a = els[n].el.getBoundingClientRect();
        const c = els[n + 1].el.getBoundingClientRect();
        const gap = Math.max(
          Math.max(a.left, c.left) - Math.min(a.right, c.right),
          Math.max(a.top, c.top) - Math.min(a.bottom, c.bottom),
        );
        if (gap < worst.gap) {
          worst = {
            gap: Math.round(gap),
            pair: `${name(els[n].el)} / ${name(els[n + 1].el)}`,
          };
        }
      }
      return els.length > 1 ? worst : { gap: 0, pair: '(one plate)' };
    };
    /* EXPLORE — nothing armed, empty jaws, and the beetle walked away. */
    const parked = s.quarry.map((q) => q.at.clone());
    for (const q of s.quarry) q.at.set(9e3, 0, 9e3);
    s.digMode = false;
    if (s.carry.carrying) s.carry.drop();
    settle();
    out.explore = up();
    out.exploreFit = { clash: clash(), touch: touching() };

    /* CARRY — put something in her jaws through the real verb. */
    const seed = s.props.find((q) => q.id === 'seed');
    s.teleportMm(seed.at.x * 5, seed.at.z * 5);
    s.stepForTest(1 / 60, 4);
    s.useAbility('interact');
    settle();
    out.carrying = s.carry.carrying;
    out.carry = up();
    out.carryFit = { clash: clash(), touch: touching() };
    s.useAbility('interact');
    settle();

    /* COMBAT — walk the beetle back to her. */
    s.quarry.forEach((q, i) => q.at.copy(parked[i]));
    if (s.quarry[0]) {
      s.quarry[0].alive = true;
      s.quarry[0].at.copy(s.at);
    }
    settle();
    out.combat = up();
    out.combatFit = { clash: clash(), touch: touching() };
    out.combatMode = s.hudMode;
    /* IS THERE ANYTHING TO FIGHT? The beetle was pulled from the world at
     * Joshua's ask — "remove it as I will add a real GLB beetle later...
     * maybe don't remove completely, but keep in the insect brain
     * database" — so the island currently seeds no quarry at all. This
     * probe cannot manufacture one honestly, and an assertion that can
     * never pass is a red line nobody reads. Recorded so the check can say
     * WHY it is standing down rather than quietly relaxing. */
    out.hasQuarry = s.quarry.length > 0;

    /* DIG — and send the beetle away again so the fight does not win. */
    for (const q of s.quarry) q.at.set(9e3, 0, 9e3);
    settle();
    document.querySelector('.tm-art-dig')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    settle();
    out.dig = up();
    out.digFit = { clash: clash(), touch: touching() };
    out.digMode = s.hudMode;
    /*
     * THE ATTITUDE PANEL, read while the shovel is out. Four instruments —
     * pitch, roll, heading, depth — because the loop-de-loop report was a
     * player heading UP who believed she was heading down. The pitch swing
     * is exercised the way the bug happened: aim driven below level, then
     * above it, and the readout must change vocabulary (▼ to ▲), not just
     * flip a minus a thumb cannot see.
     */
    const gauges = () => Array.from(
      document.querySelectorAll('.tm-instruments .density-lab-aim-readout'),
    ).filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => el.textContent);
    /*
     * ON LEVEL FOOTING FIRST. The gauges are world-referenced — that is
     * their whole value — so an ant clinging to a 27°-rolled slope reads
     * a nose-down aim as ▲, and is RIGHT to: dug from there, that stroke
     * climbs. A sign test needs a level ant, and a teleport-in-place is
     * the documented way to one (it sets her down the right way up).
     */
    s.teleportMm(s.at.x * 5, s.at.z * 5);
    settle();
    /* Through `aimPitchForTest`, which writes the LOOK — on the island the
     * look is the aim; the bore rig's own dial is the lab scene's. */
    s.aimPitchForTest(-0.6);
    settle();
    out.gaugesDown = gauges();
    s.aimPitchForTest(0.6);
    settle();
    out.gaugesUp = gauges();
    s.aimPitchForTest(0);
    settle();
    document.querySelector('.tm-art-dig')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    settle();
    out.backToExplore = s.hudMode;

    /*
     * THE POSE RIGS, which are the ones that could strand somebody.
     *
     * TILT and RIDE moved into the DEV drawer, so `pose` is a mode with no
     * plate of its own on the playing screen. If arming it were reachable
     * and DISarming it were not, the stick would be stuck driving her body
     * with nothing on screen to say so. Both directions, through the real
     * buttons, wherever they now live.
     */
    s.toggleDev();
    const tilt = document.querySelector('.tm-art-tilt');
    out.tiltInDrawer = !!tilt && tilt.getBoundingClientRect().width > 0;
    if (tilt) {
      tilt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      tilt.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    }
    settle();
    out.posed = s.hudMode;
    if (tilt) {
      tilt.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      tilt.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    }
    settle();
    out.unposed = s.hudMode;
    s.toggleDev();
    settle();
    out.tiltOffHud = document.querySelector('.tm-art-tilt')
      ?.getBoundingClientRect().width === 0
      || document.querySelector('.tm-dev-panel')?.style.display === 'none';
    return out;
  }, PLATES);

  for (const mode of ['explore', 'carry', 'combat', 'dig']) {
    console.log(`    ${mode.padEnd(8)} ${seen[mode].length} plates: ${seen[mode].join(' ')}`);
  }
  say(seen.carrying === true, 'the carry mode was reached by actually lifting something');
  if (seen.hasQuarry) {
    say(seen.combatMode === 'combat',
      `a beetle at her feet is a fight (got ${seen.combatMode})`);
  } else {
    /* NOT a pass. The mode is unexercised and the line says so, so nobody
     * reads a green run as "combat still works". It goes back to a real
     * assertion the moment a creature with `damage` is seeded again. */
    console.log('  skip  combat is unexercised — the island seeds no quarry'
      + ' (beetle pulled pending a real GLB); the mode table is still'
      + ' covered by tests/hudModes.test.ts');
  }
  say(seen.digMode === 'dig', `DIG arms the dig mode (got ${seen.digMode})`);
  say(seen.backToExplore === 'explore',
    `and DIG is still there to disarm it (got ${seen.backToExplore})`);
  /* The trimmed row: the look IS the aim, so digging offers no VIEW. */
  say(!seen.dig.includes('view'), 'digging does not offer a VIEW plate');
  /* Pitch, roll, heading, depth — all four on the panel, and the pitch
   * arrow must actually turn over when the aim crosses level. */
  say(seen.gaugesDown.length === 4,
    `the dig panel shows four gauges (got ${seen.gaugesDown.join(' | ')})`);
  say(seen.gaugesDown[0]?.includes('\u25bc'),
    `aimed below level the pitch gauge points down (got ${seen.gaugesDown[0]})`);
  say(seen.gaugesUp[0]?.includes('\u25b2'),
    `aimed above level it points up (got ${seen.gaugesUp[0]})`);
  say(!!seen.gaugesDown[1] && seen.gaugesDown[1].length > 0,
    `the roll gauge reads something (got ${seen.gaugesDown[1]})`);
  /* THE REPORT, AS AN ASSERTION. Ten at once was the complaint. */
  for (const mode of ['explore', 'carry', 'combat', 'dig']) {
    say(seen[mode].length <= 6,
      `${mode} shows ${seen[mode].length} plates, not a carpet`);
  }
  say(!seen.explore.includes('sting') && !seen.explore.includes('bite'),
    'exploring does not offer a sting');
  say(!seen.dig.includes('bite'), 'digging does not offer a bite');
  /* THE ONE probe:hud STRUCTURALLY CANNOT SEE — it measures whichever mode
   * the island booted into, and that is always EXPLORE. */
  for (const mode of ['explore', 'carry', 'combat', 'dig']) {
    const fit = seen[`${mode}Fit`];
    /* The overlap alone. A first version also reported a row count, which
     * was wrong by construction: the arc gives every plate a different
     * bottom edge, so bucketing by it counted five plates as four rows. A
     * misleading number beside a true one is worse than no number. */
    say(fit.clash === 0,
      `${mode}'s plates clear the objective card`
      + (fit.clash ? ` — OVERLAP ${fit.clash}px` : ''));
    /* AND CLEAR EACH OTHER. The check above measures the cluster as one
     * box, so it cannot see two plates sitting on top of one another
     * inside it — which is exactly how the SCOOP-on-DIG overlap survived
     * every layout probe in the repo. */
    say(fit.touch.gap >= 0,
      `${mode}'s plates clear each other — tightest ${fit.touch.gap}px`
      + ` at ${fit.touch.pair}`);
  }
  say(seen.tiltInDrawer === true, 'the posture rigs are reachable in the DEV drawer');
  say(seen.posed === 'pose', `arming TILT poses her (got ${seen.posed})`);
  say(seen.unposed === 'explore', `and TILT disarms it again (got ${seen.unposed})`);
  say(seen.tiltOffHud === true, 'and neither rig is on the playing screen');

  /*
   * --- THE CAMERA'S SHARE OF THE GLASS ---
   *
   * Sample a grid, ask the browser what a finger would hit, and find the
   * largest solid rectangle of free cells. Done in EXPLORE, which is where
   * the player spends the game and where the drag matters most.
   */
  const pan = await p.evaluate(async (want) => {
    const s = window.islandScene;
    for (const q of s.quarry) q.at.set(9e3, 0, 9e3);
    s.digMode = false;
    if (s.carry.carrying) s.carry.drop();
    s.stepForTest(1 / 60, 3);
    await new Promise((r) => setTimeout(r, 150));

    const COLS = 48;
    const ROWS = 27;
    const W = window.innerWidth;
    const H = window.innerHeight;
    /** true = a finger here reaches the world, not a control. */
    const free = [];
    const blockers = new Set();
    for (let r = 0; r < ROWS; r += 1) {
      const row = [];
      for (let c = 0; c < COLS; c += 1) {
        const x = ((c + 0.5) / COLS) * W;
        const y = ((r + 0.5) / ROWS) * H;
        const el = document.elementFromPoint(x, y);
        /* The canvas, or anything that lets the event through to it. */
        const isWorld = !el || el.tagName === 'CANVAS'
          || el.classList.contains('density-lab-hud');
        if (!isWorld) blockers.add(el.className || el.tagName);
        row.push(isWorld);
      }
      free.push(row);
    }

    /* Largest all-free rectangle, by the standard histogram sweep. */
    let best = 0; let bestBox = null;
    const heights = new Array(COLS).fill(0);
    for (let r = 0; r < ROWS; r += 1) {
      for (let c = 0; c < COLS; c += 1) heights[c] = free[r][c] ? heights[c] + 1 : 0;
      const stack = [];
      for (let c = 0; c <= COLS; c += 1) {
        const h = c === COLS ? 0 : heights[c];
        let start = c;
        while (stack.length && stack[stack.length - 1].h >= h) {
          const top = stack.pop();
          const area = top.h * (c - top.c);
          if (area > best) {
            best = area;
            bestBox = { c: top.c, w: c - top.c, h: top.h, r: r - top.h + 1 };
          }
          start = top.c;
        }
        stack.push({ c: start, h });
      }
    }
    const freeCells = free.flat().filter(Boolean).length;
    return {
      share: +(best / (COLS * ROWS)).toFixed(3),
      loose: +(freeCells / (COLS * ROWS)).toFixed(3),
      box: bestBox && {
        x: Math.round((bestBox.c / COLS) * W), y: Math.round((bestBox.r / ROWS) * H),
        w: Math.round((bestBox.w / COLS) * W), h: Math.round((bestBox.h / ROWS) * H),
      },
      blockers: [...blockers].slice(0, 6),
      want,
    };
  }, WANT_FREE);

  console.log(`    camera-drag: largest clear block ${pan.box.w}x${pan.box.h}px`
    + ` at ${pan.box.x},${pan.box.y} — ${(pan.share * 100).toFixed(0)}% of the screen`
    + ` (${(pan.loose * 100).toFixed(0)}% free in total)`);
  say(pan.share >= WANT_FREE,
    `one clear block is ${(pan.share * 100).toFixed(0)}% of the glass (want ${WANT_FREE * 100}%)`);
  if (pan.share < WANT_FREE) console.log(`      blocked by: ${pan.blockers.join(' | ')}`);
  if (errs.length) { bad += 1; console.log(`  FAIL  page errors: ${errs.slice(0, 2).join(' | ')}`); }
  await p.close();
}

console.log(bad === 0
  ? '\nall green — every mode dresses down, and the world keeps its glass'
  : `\n${bad} check(s) failed`);
await b.close();
process.exit(bad === 0 ? 0 : 1);
