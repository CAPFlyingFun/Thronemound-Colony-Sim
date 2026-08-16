/*
 * ARE THE FLY AND THE APHID ACTUALLY IN THE GAME, AND ALIVE?
 *
 * Asked for: "I will want the fly, aphid and worm in the game", with the
 * aphid replacing the procedural ladybug. A unit test can prove the brain
 * decides correctly; only the running island can prove one was ever built,
 * dressed, seated on soil, and moved.
 *
 *   node scripts/probe-critters.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
await page.goto(process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island', {
  waitUntil: 'domcontentloaded',
});
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(() => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 });
/* The bodies are fetched off the critical path — wait for them rather than
 * assume they beat the first step. */
await page.waitForFunction(
  () => window.islandScene.crittersForTest().some((c) => c.ready),
  null, { timeout: 60000 },
).catch(() => { /* reported as undressed below */ });
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const s = window.islandScene;
  const born = s.crittersForTest();
  const from = born.map((c) => ({ x: c.x, z: c.z }));
  for (let i = 0; i < 60 * 30; i += 1) s.stepForTest(1 / 60, 1);
  const now = s.crittersForTest();
  const MM = 5;
  const movedMm = now.map((c, i) => Math.hypot(c.x - from[i].x, c.z - from[i].z) * MM);
  const bugs = s.bulkReportForTest().filter((b) => String(b.id).startsWith('bug-'));
  /* On the soil, not floating: compare each to the seat the game would give
   * it right now. */
  const offGroundMm = now.map((c) => Math.abs(c.y - s.walkGroundAtForTest(c.x, c.z)) * MM);
  return {
    total: born.length,
    byKind: born.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {}),
    dressed: now.filter((c) => c.ready).length,
    behaviours: [...new Set(now.map((c) => c.behaviour))],
    movedMaxMm: +Math.max(...movedMm).toFixed(1),
    movedMinMm: +Math.min(...movedMm).toFixed(1),
    onShoveList: bugs.length,
    worstOffGroundMm: +Math.max(...offGroundMm).toFixed(2),
    alive: now.filter((c) => c.health > 0).length,
    /*
     * CAN SHE ACTUALLY FIGHT ONE?
     *
     * Reported: "I am not able to attack the Aphid and Fly yet." Nothing
     * checked it, because the creatures probe asks whether they LIVE and
     * the combat probe only ever had a beetle to bite. The gap between
     * the two is exactly where this sat.
     *
     * The whole loop, through the real verbs: bite it, kill it, and pick
     * the corpse up — a creature you can attack but never carry home is
     * a dead end, which is why the last step is here too.
     */
    fight: (() => {
      const MM = 5;
      const i = now.findIndex((c) => c.ready && c.health > 0);
      if (i < 0) return { ok: false, why: 'nothing alive to fight' };
      const start = s.crittersForTest()[i];
      s.teleportMm(start.x * MM, start.z * MM);
      s.stepForTest(1 / 60, 8);
      const plate = document.querySelector('.tm-art-bite');
      const lit = !!plate && plate.getBoundingClientRect().width > 0
        && !plate.classList.contains('is-idle');
      s.useAbility('bite');
      s.stepForTest(1 / 60, 4);
      const gripped = s.combat.phase !== 'free';
      s.stepForTest(1 / 60, 180);
      const hurt = s.crittersForTest()[i].health < start.health;
      /* Finish it. It flees and breaks free, so this is a chase — bounded
       * so a failure is a report rather than a hang. */
      for (let n = 0; n < 40 && s.crittersForTest()[i].health > 0; n += 1) {
        const c = s.crittersForTest()[i];
        s.teleportMm(c.x * MM, c.z * MM);
        if (s.combat.phase === 'free') s.useAbility('bite');
        s.stepForTest(1 / 60, 70);
      }
      const dead = s.crittersForTest()[i];
      if (s.combat.phase !== 'free') s.useAbility('bite');
      s.stepForTest(1 / 60, 4);
      s.teleportMm(dead.x * MM, dead.z * MM);
      s.stepForTest(1 / 60, 6);
      s.useAbility('carry');
      s.stepForTest(1 / 60, 4);
      const carried = s.carry.carrying;
      if (carried) s.useAbility('carry');
      return {
        kind: start.kind, lit, gripped, hurt,
        killed: dead.health === 0, stopped: dead.behaviour === 'dead',
        carried,
        ok: lit && gripped && hurt && dead.health === 0
          && dead.behaviour === 'dead' && carried,
      };
    })(),
    /*
     * THE GAIT, AS A SEATING RATHER THAN AS MOTION.
     *
     * Reported from the device: "the Aphid and Fly aren't walking tri-pod
     * style for 6 legs and they are all moving forward and back". Nothing
     * here could see it — the existing checks ask whether the legs MOVE,
     * and they moved perfectly well in the wrong pattern.
     *
     * A six-legged insect walks an ALTERNATING TRIPOD: front-left,
     * hind-left and middle-right swing while the other three carry. So the
     * check is that each half holds exactly one front, one middle and one
     * hind, and that the two legs of any mirrored pair are in OPPOSITE
     * halves. Both statements fail together for the bug that was there —
     * left-three against right-three — and neither can be satisfied by a
     * gait that merely wiggles.
     */
    gait: ['aphid', 'housefly'].map((kind) => {
      const r = s.critterLegsForTest(kind);
      if (!r || r.legs !== 6) return { kind, ok: false, why: 'no six-legged one ready' };
      const rank = ['front', 'middle', 'hind'];
      const name = (seats) => seats
        .sort((a, b) => a.z - b.z)
        .map((q, i) => ({ ...q, at: rank[i] ?? String(i) }));
      const left = name(r.seats.filter((q) => q.x < 0));
      const right = name(r.seats.filter((q) => q.x >= 0));
      if (left.length !== 3 || right.length !== 3) {
        return { kind, ok: false, why: `${left.length} left / ${right.length} right` };
      }
      const half = (n) => [...left, ...right].filter((q) => q.phase === n);
      const spread = (n) => new Set(half(n).map((q) => q.at)).size === 3
        && half(n).length === 3;
      /* Each mirrored pair split across the two halves — the property that
       * makes it a TRIPOD rather than two legs-per-side groups. */
      const paired = rank.every((at) => {
        const l = left.find((q) => q.at === at);
        const rr = right.find((q) => q.at === at);
        return l && rr && l.phase !== rr.phase;
      });
      return {
        kind, ok: spread(0) && spread(1) && paired,
        tripodA: half(0).map((q) => `${q.x < 0 ? 'L' : 'R'}-${q.at}`).join(' '),
        tripodB: half(1).map((q) => `${q.x < 0 ? 'L' : 'R'}-${q.at}`).join(' '),
      };
    }),
  };
});

await browser.close();
if (errs.length) console.log('page errors:', errs.slice(0, 2).join(' | '));

console.log('\nTHE ISLAND\'S OTHER ANIMALS\n');
console.log(`  spawned            ${out.total}  ${JSON.stringify(out.byKind)}`);
console.log(`  drawn (dressed)    ${out.dressed}`);
console.log(`  alive              ${out.alive}`);
console.log(`  brains doing       ${out.behaviours.join(', ')}`);
console.log(`  moved in 30 s      ${out.movedMinMm} to ${out.movedMaxMm} mm`);
console.log(`  on the shove list  ${out.onShoveList}`);
console.log(`  worst float        ${out.worstOffGroundMm} mm off the seat`);

let bad = 0;
const say = (ok, what) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
console.log('');
say(out.total > 0, `the island seeded ${out.total} walking creatures`);
say(Object.keys(out.byKind).length === 2, 'both an aphid and a housefly are present');
say(out.dressed === out.total, 'every one of them got a body');
say(out.movedMaxMm > 1, 'at least one actually walked somewhere');
say(out.onShoveList === out.total, 'all of them collide');
say(out.worstOffGroundMm < 2, 'none of them is floating off its seat');
const f = out.fight;
say(f.lit === true, `BITE lights with an ${f.kind ?? 'insect'} in reach`);
say(f.gripped === true, 'and pressing it takes hold');
say(f.hurt === true, 'the bite actually costs it health');
say(f.killed === true, 'it can be killed');
say(f.stopped === true, 'and the corpse stops walking about');
say(f.carried === true, 'a felled one can be carried home');
for (const g of out.gait) {
  say(g.ok, `the ${g.kind} walks an alternating tripod`
    + (g.ok ? ` — ${g.tripodA} / ${g.tripodB}` : ` — ${g.why ?? `${g.tripodA} / ${g.tripodB}`}`));
}
if (bad > 0) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the fly and the aphid live on the island');
