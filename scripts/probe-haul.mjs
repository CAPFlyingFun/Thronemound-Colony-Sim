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

  const beetle = s.quarry[0];
  if (!beetle) return { fail: 'no beetle on the island' };

  /* 1. LIVE BEETLE MUST REFUSE. The reach test offers it up on purpose so
   *    the HUD can say KILL IT FIRST rather than NOTHING TO CARRY. */
  s.teleportMm(beetle.at.x * 5, beetle.at.z * 5);
  s.stepForTest(1 / 60, 4);
  s.useAbility('carry');
  log.push(['live beetle refused', s.carry.carrying === false]);

  /* 2. FELL IT and lift it. */
  beetle.alive = false;
  beetle.hp = 0;
  s.stepForTest(1 / 60, 4);
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

  /* 3. THE RUN IS GONE while she is under it. */
  s.pace = 2;
  s.applyPace();
  s.stepForTest(1 / 60, 4);
  log.push(['too laden to run', s.carry.tooLadenToRun === true]);

  /* 4. IT FOLLOWS HER JAWS rather than staying on the ground. */
  const wasAt = { x: beetle.at.x, z: beetle.at.z };
  s.input.walk = 1;
  s.stepForTest(1 / 60, 90);
  s.input.walk = 0;
  const moved = Math.hypot(beetle.at.x - wasAt.x, beetle.at.z - wasAt.z);
  log.push(['the beetle travelled with her', moved > 0.05]);
  log.push(['it is flagged as cargo', beetle.carried === true]);

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
