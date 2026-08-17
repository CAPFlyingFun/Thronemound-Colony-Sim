/**
 * THE HAUL, DRIVEN END TO END — fell it, lift it, carry it home, and watch
 * the larder move.
 *
 *     npm run probe:haul        (needs `npx vite --port 5173` running)
 *
 * A unit test proves `Carry` adds up; it cannot prove the plate is wired to
 * it, that the beetle follows her jaws, or that arriving at the nest hands
 * anything over. This drives the real scene through the whole trip and
 * reports each leg as a number.
 */
import { chromium } from 'playwright';

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 180000 });
await p.waitForFunction(() => document.querySelector('.tm-loading-root') === null, null, { timeout: 180000 });
/* The creatures are fetched off the critical path, and this probe now hunts
 * one — so wait for a body rather than for a stopwatch. */
await p.waitForFunction(
  () => window.islandScene.crittersForTest().some((c) => c.ready),
  null, { timeout: 90000 },
).catch(() => { /* reported as the probe's own failure below */ });
await p.waitForTimeout(600);

const out = await p.evaluate(async () => {
  const s = window.islandScene;
  const log = [];
  const meter = () => {
    const el = document.querySelector('.tm-meter-carry');
    return {
      level: el?.style.getPropertyValue('--tm-level') || '(unset)',
      loaded: el?.classList.contains('is-loaded') ?? false,
      soon: el?.classList.contains('is-soon') ?? false,
    };
  };
  const foodCell = () => document.querySelector('.tm-ci-food')
    ?.parentElement?.querySelector('b')?.textContent ?? '(none)';
  const plate = () => {
    const el = s.carryBtn;
    return el ? { carry: el.classList.contains('tm-art-carry'),
      drop: el.classList.contains('tm-art-drop'),
      label: el.getAttribute('aria-label') } : null;
  };

  /*
   * THE PREY IS A HOUSEFLY NOW, not the beetle.
   *
   * This probe has been dead since the beetle was pulled from the island
   * ("remove it as I will add a real GLB beetle later") — it opened with
   * `s.quarry[0]` and bailed out at the first line, taking the whole food
   * loop's only coverage with it. Nothing else checks that a kill turns
   * into protein in the larder.
   *
   * The fly is the biggest thing on the island that can be hunted, and
   * `Critter` satisfies both `Quarry` and `Portable` now, so every step
   * below is the same step against a different animal.
   */
  const preyOf = () => s.critters.find((c) => c.kind.id === 'housefly' && c.ready)
    ?? s.critters.find((c) => c.ready);
  const prey = preyOf();
  if (!prey) return { fail: 'no walking creature on the island' };

  /* 1. A LIVE ONE MUST REFUSE. The reach test offers it up on purpose so
   *    the HUD can say KILL IT FIRST rather than NOTHING TO CARRY. */
  s.teleportMm(prey.at.x * 5, prey.at.z * 5);
  s.stepForTest(1 / 60, 4);
  s.useAbility('carry');
  log.push(['a live one is refused', s.carry.carrying === false]);

  /* 2. FELL IT and lift it. Through the real jaws rather than by writing
   *    its health, so the fight is exercised too — it flees and breaks
   *    free, so this is a chase, bounded so a failure reports. */
  for (let n = 0; n < 60 && prey.alive; n += 1) {
    s.teleportMm(prey.at.x * 5, prey.at.z * 5);
    if (s.combat.phase === 'free') s.useAbility('bite');
    s.stepForTest(1 / 60, 70);
  }
  log.push(['she can kill it with her jaws', prey.alive === false]);
  if (s.combat.phase !== 'free') s.useAbility('bite');
  s.teleportMm(prey.at.x * 5, prey.at.z * 5);
  s.stepForTest(1 / 60, 6);
  const beforeStamina = s.vitals.stamina;
  s.useAbility('carry');
  const lifted = s.carry.carrying;
  log.push(['lifted once felled', lifted]);
  /* The HUD is written by `renderQuest`, which runs on a FRAME — reading
   * the meter in the same tick as the press asks it a question it has not
   * been given a chance to answer. */
  s.stepForTest(1 / 60, 2);
  log.push(['lifting cost stamina', s.vitals.stamina < beforeStamina]);
  const m1 = meter();
  log.push(['meter shows a load', m1.level !== '(unset)' && +m1.level > 0]);
  log.push(['meter is lit', m1.loaded === true]);
  log.push(['meter is no longer dimmed', m1.soon === false]);
  const pl = plate();
  log.push(['plate wears DROP while loaded', pl?.drop === true && pl?.carry === false]);

  /*
   * 3. THE RUN IS GONE UNDER A DRAG — and the fly is not one.
   *
   * `tooLadenToRun` is about DRAGGING, and a 9 mg housefly is well inside
   * a queen's 20 mg carry limit, so she can quite properly run with it.
   * The beetle used to serve both purposes at 45 mg; now the two questions
   * need two objects, which is more honest anyway — one asks about prey
   * and this one asks about weight.
   */
  s.pace = 2;
  s.applyPace();
  s.stepForTest(1 / 60, 4);
  log.push(['she can still run under something this light',
    s.carry.tooLadenToRun === false]);
  const wasHeld = s.carry.held;
  s.carry.drop();
  const pebble = s.props.find((q) => q.id === 'pebble');
  s.teleportMm(pebble.at.x * 5, pebble.at.z * 5);
  s.stepForTest(1 / 60, 6);
  s.useAbility('interact');
  s.stepForTest(1 / 60, 4);
  log.push(['a pebble is a drag, not a carry', s.carry.mode === 'drag']);
  log.push(['and a drag takes the run away', s.carry.tooLadenToRun === true]);
  s.useAbility('interact');
  s.stepForTest(1 / 60, 4);
  /* Back under the carcass for the haul home. */
  s.teleportMm(wasHeld.at.x * 5, wasHeld.at.z * 5);
  s.stepForTest(1 / 60, 6);
  s.useAbility('carry');
  s.stepForTest(1 / 60, 4);
  log.push(['picked the carcass back up', s.carry.carrying === true]);

  /* 4. IT FOLLOWS HER JAWS rather than staying on the ground. */
  const wasAt = { x: prey.at.x, z: prey.at.z };
  s.input.walk = 1;
  s.stepForTest(1 / 60, 90);
  s.input.walk = 0;
  const moved = Math.hypot(prey.at.x - wasAt.x, prey.at.z - wasAt.z);
  log.push(['the carcass travelled with her', moved > 0.05]);
  log.push(['it is flagged as cargo', prey.carried === true]);

  /* 5. NO COLONY, NO DELIVERY — there is nobody to hand it to yet. */
  const noColony = s.colony.length === 0;
  log.push(['no colony to deliver to yet', noColony]);
  log.push(['larder still empty', s.stores.proteinMg === 0]);

  /* 6. HATCH THE FIRST WORKER the way the founding does, then walk home. */
  s.questStage = 1;
  s.deepCarved = 1e9;
  s.stepForTest(1 / 60, 4);
  log.push(['a worker exists', s.colony.length > 0]);

  s.at.copy(s.workerAnchor);
  s.stepForTest(1 / 60, 8);
  log.push(['delivered on arrival', s.stores.proteinMg > 0]);
  log.push(['jaws are empty again', s.carry.carrying === false]);
  log.push(['FOOD cell reports it', foodCell() === String(Math.round(s.stores.proteinMg))]);
  const m2 = meter();
  log.push(['meter fell back to empty', +m2.level === 0]);
  const pl2 = plate();
  log.push(['plate is CARRY again', pl2?.carry === true && pl2?.drop === false]);
  log.push(['the run came back', s.carry.tooLadenToRun === false]);

  return {
    log,
    protein: s.stores.proteinMg,
    food: foodCell(),
    report: s.carry.report(),
  };
});

if (out.fail) {
  console.log(`FAILED: ${out.fail}`);
} else {
  let bad = 0;
  for (const [what, ok] of out.log) {
    if (!ok) bad += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  }
  console.log(`\nlarder: ${out.protein} mg protein · FOOD cell reads "${out.food}"`);
  console.log(`carry : ${JSON.stringify(out.report)}`);
  console.log(`page errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
  console.log(bad === 0 && errs.length === 0
    ? '\nall green — she fells it, lifts it, hauls it home, and the colony is fed'
    : `\n${bad} step(s) failed`);
}
await b.close();
process.exit(out.fail || (out.log ?? []).some(([, ok]) => !ok) || errs.length ? 1 : 0);
