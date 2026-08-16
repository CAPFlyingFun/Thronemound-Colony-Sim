/*
 * IS THE BRAIN ACTUALLY WIRED, AND DOES A WORM HAVE STATS AND A BODY?
 *
 * Asked for as "add ARK style creature stats and behaviors ... so everything
 * will benefit". A unit test proves the FSM decides correctly in isolation;
 * it cannot prove the island ever calls it. This does — in the running game,
 * on the real population.
 *
 *   node scripts/probe-brain.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
await page.waitForTimeout(900);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  const born = s.wormMindForTest(0);
  /* Let it live a while, so hunger and the think clock have run. */
  for (let i = 0; i < 60 * 30; i += 1) s.stepForTest(1 / 60, 1);
  const later = s.wormMindForTest(0);

  /* Stats are real: hurt one and see it register, then kill it. */
  const before = s.wormMindForTest(1).health;
  s.woundWormForTest(1, 10);
  const hurt = s.wormMindForTest(1).health;
  const killed = s.woundWormForTest(1, 9999);
  const dead = s.wormMindForTest(1);
  /* A corpse cannot be killed twice — whatever listens must not fire again. */
  const again = s.woundWormForTest(1, 10);

  /* Collision: a worm near her must appear on the shove list. */
  s.putWormNearForTest(2, 20);
  for (let i = 0; i < 10; i += 1) s.stepForTest(1 / 60, 1);
  const report = s.bulkReportForTest();

  return {
    worms: s.wormsForTest().length,
    bornBehaviour: born.behaviour, bornHealth: born.health,
    laterBehaviour: later.behaviour,
    hungerRose: later.hunger > born.hunger,
    woundFrom: before, woundTo: hurt, killed, deadBehaviour: dead.behaviour,
    killedTwice: again,
    bulkNames: report.filter((b) => String(b.id).startsWith('worm')).map((b) => b.id),
  };
});

await browser.close();
if (errs.length) console.log('page errors:', errs.slice(0, 3).join(' | '));

console.log('\nTHE CREATURE BRAIN, IN THE RUNNING GAME\n');
console.log(`  worms on the island   ${out.worms}`);
console.log(`  behaviour at birth    ${out.bornBehaviour}`);
console.log(`  behaviour 30 s later  ${out.laterBehaviour}`);
console.log(`  hunger actually rose  ${out.hungerRose}`);
console.log(`\n  stats are real:`);
console.log(`    health              ${out.woundFrom} -> ${out.woundTo} after a 10-point hit`);
console.log(`    killing blow        reported ${out.killed}, now "${out.deadBehaviour}"`);
console.log(`    killed twice        ${out.killedTwice} (must be false)`);
console.log(`\n  on the shove list     ${out.bulkNames.length} worm(s) near her`);

let bad = 0;
const say = (ok, what) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
console.log('');
say(out.worms > 0, `the island seeded ${out.worms} worms`);
say(out.laterBehaviour === 'wander', 'the brain settled it on wander, which for a worm is digging');
say(out.hungerRose, 'its clocks ran — hunger rose on its own');
say(out.woundTo === out.woundFrom - 10, 'a wound took exactly what it should');
say(out.killed === true && out.deadBehaviour === 'dead', 'a killing blow was reported and it is dead');
say(out.killedTwice === false, 'a corpse cannot be killed again');
say(out.bulkNames.length > 0, 'a worm beside her is on the shove list');

if (bad > 0) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the brain is wired, the stats are real, and worms collide');
