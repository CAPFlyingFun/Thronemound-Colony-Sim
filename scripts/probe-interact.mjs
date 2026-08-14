/**
 * THE LOOSE THINGS, HANDLED — and the one she cannot move.
 *
 *     npx vite --port 5173                                   # then
 *     SMOKE_URL=http://127.0.0.1:5173/ npm run probe:interact
 *
 * The unit tests prove `carryVerdict` sorts a weight into carry, drag or
 * immobile. They cannot prove the island seeded anything to sort, that the
 * plate reaches it, that a leaf rides at her jaws, or — the one that would
 * be quietly wrong and invisible — that walking a pebble into the nest does
 * not silently feed it to the larvae.
 *
 * The stone is in the scatter to be REFUSED. It is the only way `immobile`
 * is ever seen before there is a second caste, and a probe that only tested
 * the things that work would not notice it had stopped being refused.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const p = await b.newPage({ viewport: { width: 932, height: 430 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 180000 });
await p.waitForFunction(
  () => document.querySelector('.tm-loading-root') === null, null, { timeout: 180000 },
);
await p.waitForTimeout(600);

const out = await p.evaluate(async () => {
  const s = window.islandScene;
  const log = [];
  const MM = 5;
  const go = (thing) => {
    s.teleportMm(thing.at.x * MM, thing.at.z * MM);
    s.stepForTest(1 / 60, 4);
  };
  const prop = (id) => s.props.find((q) => q.id === id);

  log.push(['the island seeded loose things', s.props.length >= 5]);
  const seed = prop('seed'); const pebble = prop('pebble'); const stone = prop('stone');
  if (!seed || !pebble || !stone) return { fail: 'the scatter is missing a kind' };

  /* 1. A SEED IS CARRIED, and barely slows her. */
  go(seed);
  s.useAbility('interact');
  log.push(['a seed goes up', s.carry.carrying === true]);
  log.push(['and is CARRIED, not dragged', s.carry.mode === 'carry']);
  const seedPace = s.carry.speedFactor;
  log.push(['it barely slows her', seedPace > 0.8]);
  s.stepForTest(1 / 60, 2);
  log.push(['the INTERACT plate lights', s.interactBtn?.classList.contains('is-grip') === true]);

  /* 2. IT RIDES AT HER JAWS. */
  const was = { x: seed.at.x, z: seed.at.z };
  s.input.walk = 1; s.stepForTest(1 / 60, 90); s.input.walk = 0;
  log.push(['it travels with her', Math.hypot(seed.at.x - was.x, seed.at.z - was.z) > 0.05]);

  /* 3. PUT IT DOWN and it stays a thing she can pick up again. */
  s.useAbility('interact');
  log.push(['put down', s.carry.carrying === false]);
  s.stepForTest(1 / 60, 3);
  log.push(['the plate goes dark', s.interactBtn?.classList.contains('is-grip') === false]);

  /* 4. A PEBBLE IS A DRAG — heavier than she can lift, light enough to haul. */
  go(pebble);
  s.useAbility('interact');
  log.push(['a pebble goes up', s.carry.carrying === true]);
  log.push(['and is DRAGGED', s.carry.mode === 'drag']);
  log.push(['dragging costs her the run', s.carry.tooLadenToRun === true]);
  /* Against the seed rather than a bare number. A 22mg pebble is only just
   * over the queen's 20mg carry limit, so it is a LIGHT drag — carryVerdict
   * gives 0.58, and an absolute "< 0.5" was my arithmetic being wrong about
   * the taper rather than the taper being wrong. What must hold is that
   * hauling is meaningfully slower than carrying. */
  log.push(['and a good deal of her stride', s.carry.speedFactor < seedPace * 0.75]);
  s.useAbility('interact');

  /* 5. THE STONE IS REFUSED. */
  go(stone);
  s.useAbility('interact');
  log.push(['the stone will not move', s.carry.carrying === false]);

  /* 6. A PROP IS NOT FOOD. Found the colony, walk in holding a pebble, and
   *    the larder must not move — otherwise carrying anything indoors
   *    silently destroys it. */
  s.questStage = 1; s.deepCarved = 1e9;
  s.stepForTest(1 / 60, 6);
  go(pebble);
  s.useAbility('interact');
  const held = s.carry.carrying;
  const before = s.stores.proteinMg;
  s.at.copy(s.workerAnchor);
  s.stepForTest(1 / 60, 10);
  log.push(['carried a pebble into the nest', held === true]);
  log.push(['the larder did not move', s.stores.proteinMg === before]);
  log.push(['and she still has it', s.carry.carrying === true]);

  return { log, props: s.props.map((q) => `${q.id}:${q.massMg}mg`).join(' ') };
});

if (out.fail) { console.log(`FAILED: ${out.fail}`); process.exit(1); }
let bad = 0;
for (const [what, ok] of out.log) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
}
console.log(`\nscatter: ${out.props}`);
console.log(`page errors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(bad === 0 && errs.length === 0
  ? '\nall green — she carries, drags, is refused, and a pebble is not dinner'
  : `\n${bad} step(s) failed`);
await b.close();
process.exit(bad === 0 && errs.length === 0 ? 0 : 1);
