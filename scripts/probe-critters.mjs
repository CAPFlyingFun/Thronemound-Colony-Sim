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
    /*
     * DO THEIR FEET TOUCH THE GROUND?
     *
     * Reported from the device: "some of the insects did not stay actually
     * on the ground mesh, but was like maybe doing the average of the
     * mesh." Measured before the fix, a housefly's six feet ran from 5.5 mm
     * BURIED to 5.8 mm in the AIR — a bigger error than the animal. The
     * body was seated correctly; the legs never asked where the soil was.
     *
     * SAMPLED OVER TIME, not from one frame. A creature wanders and its
     * gait cycles, so a single reading says where one foot was at one
     * instant — which is how three runs of identical code produced three
     * different answers while this was being fixed.
     *
     * The soil is asked the same question `plantFeet` asks: what is under
     * this foot, searched from the BODY's height. Searching from the foot's
     * own height is a different question once the foot is inside soil, and
     * getting that wrong reports buried feet that are not there.
     */
    footing: (() => {
      const V = s.at.constructor;
      const tally = {};
      for (let f = 0; f < 480; f += 1) {
        s.stepForTest(1 / 60, 1);
        if (f % 4) continue;
        for (const c of s.critters) {
          /*
           * THE LIVING, UNCARRIED ONES ONLY, and that is the question
           * rather than a convenience. A dead critter returns early from
           * `step`, so its legs keep the pose it died in — which is right,
           * an insect on its back does not stand up — and one in her jaws
           * is being carried, not standing at all. This probe kills and
           * hauls one a moment earlier, so both were in the sample and a
           * corpse's stray foot was being read as the walkers sinking.
           */
          if (!c.ready || !c.alive || c.carried || !c.legsForTest?.length) continue;
          c.root.updateMatrixWorld(true);
          const t = tally[c.kind.id] ??= { n: 0, sum: 0, high: 0, deep: 0, sunk: 0 };
          for (const leg of c.legsForTest) {
            const tip = leg.chain[leg.chain.length - 1];
            const w = new V();
            w.setFromMatrixPosition(tip.matrixWorld);
            const gap = (w.y - s.footingFrom(w.x, w.z, c.at.y)) * 5;
            t.n += 1;
            t.sum += Math.abs(gap);
            t.high = Math.max(t.high, gap);
            t.deep = Math.min(t.deep, gap);
            if (gap < -0.25) t.sunk += 1;
          }
        }
      }
      return Object.entries(tally).map(([kind, t]) => ({
        kind, samples: t.n,
        meanMm: +(t.sum / t.n).toFixed(3),
        highMm: +t.high.toFixed(2),
        deepMm: +t.deep.toFixed(2),
        sunkPct: +((100 * t.sunk) / t.n).toFixed(2),
      }));
    })(),

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
for (const f of out.footing) {
  console.log(`  ${f.kind.padEnd(9)} feet: mean ${f.meanMm} mm off the soil,`
    + ` highest ${f.highMm}, deepest ${f.deepMm}, sunk ${f.sunkPct}%`
    + `  (${f.samples} samples)`);
  /*
   * NOTHING SINKS — as a RATE, not as a single worst frame.
   *
   * The clearance in `plantFeet` holds every planted foot a hair above the
   * surface, so a foot meaningfully below it means the IK did not run or
   * could not reach. But the soil STREAMS: the window recentres as the
   * player moves, and for the frame it does, the ground under a foot can
   * move out from under an answer computed against the old field. Measured
   * undisturbed, 0.00% of aphid feet and 0.04% of housefly feet are past a
   * quarter of a millimetre under; measured in this probe, which drags the
   * window about by teleporting to hunt, the worst single sample reaches
   * -0.65 mm while the rate stays about the same.
   *
   * A single-frame streaming transient and "the feet do not touch the
   * ground" are different faults, and asserting on the worst sample cannot
   * tell them apart. The rate can. The deepest is still printed above, so a
   * real regression is visible to a reader either way.
   */
  say(f.sunkPct < 1, `the ${f.kind}'s feet keep out of the ground (${f.sunkPct}% sunk)`);
  /* AND NOTHING WAVES. A swinging foot is lifted deliberately and lands
   * around a tenth of the animal's height up; metres of air means the leg
   * was left wherever the bind pose splayed it, which is the bug. */
  say(f.highMm < 3.5, `the ${f.kind}'s feet stay near the ground while it walks`);
  say(f.meanMm < 1, `the ${f.kind} stands on the soil rather than near it`);
}
for (const g of out.gait) {
  say(g.ok, `the ${g.kind} walks an alternating tripod`
    + (g.ok ? ` — ${g.tripodA} / ${g.tripodB}` : ` — ${g.why ?? `${g.tripodA} / ${g.tripodB}`}`));
}
if (bad > 0) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — the fly and the aphid live on the island');
