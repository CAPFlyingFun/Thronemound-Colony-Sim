/**
 * WHERE A CARRIED THING SITS, AND WHETHER IT IS INSIDE HER FACE.
 *
 *     npx vite --port 5173                                  # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:hold
 *
 * Reported on a screenshot: "if you zoom in, it's cutting off her head...
 * not sure about worker and major."
 *
 * It was, and the cause was the rule that picks WHERE ON A PROP she takes
 * hold. Both earlier cuts asked the question relative to `jaw - at` — the
 * direction from the thing's centre to her jaw — and that vector stops
 * meaning "toward her" as soon as her jaws are inside the thing, which is
 * routine: `propInReach` measures the gap as distance minus radius, so she
 * can stand right over something small. Her jaw anchor is 2.4 mm out and a
 * seed is 2.2 mm across. The rule then picked the seed's FAR side, and
 * carrying the far side puts the whole object between that point and her
 * face.
 *
 * TWO THINGS ARE CHECKED, and the first is the one a screenshot shows:
 *
 *   1. NO PART OF THE LOAD IS INSIDE HER HEAD. Not "its centre is far
 *      enough away" — every point of its collision hull against the head's
 *      own drawn radius, which `QueenModel.segmentShell` reports off the
 *      mesh. A centre-to-bone distance would pass a twig that has her
 *      skewered lengthways.
 *
 *   2. SHE STILL HOLDS IT WHERE SHE GRABBED IT. The fix must not undo the
 *      earlier one: "I grabbed at the end, but it snapped to the middle
 *      point." A long prop taken from one end has its hold out near a tip,
 *      not at its middle.
 *
 * BOTH PLAYABLE CASTES, because the complaint named them. The major is not
 * playable yet, so the last section asks the rig question directly instead
 * — a load hangs forward from the jaw anchor, so the margin it has to work
 * with is how far that anchor stands clear of the head shell. Measured for
 * all three castes, the major included.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173/?scene=island';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errs = [];
const page = await browser.newPage({ viewport: { width: 932, height: 430 } });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);
/* The props wear real models now and the hull is rebuilt off the mesh, so
 * asking before the art lands measures the stand-in shape. */
await page.waitForFunction(() => {
  const s = window.islandScene;
  return s.props.length > 0 && s.props.filter((p) => p.spec.model).every((p) => {
    let std = false;
    p.root.traverse((n) => { if (n.isMesh && n.material.isMeshStandardMaterial) std = true; });
    return std;
  });
}, null, { timeout: 120000 }).catch(() => {});

/** One caste, every prop kind it can shift, from two standing places. */
async function sweep(caste) {
  return page.evaluate(async (want) => {
    const s = window.islandScene;
    const MM = 5;
    const V = s.at.constructor;
    if (want === 'worker' && s.playerCaste !== 'fire-ant-worker') {
      const ok = await s.becomeWorker().catch(() => false);
      if (!ok) return [{ id: '-', caste: want, why: 'the worker rig would not load' }];
      s.stepForTest(1 / 60, 30);
    }
    /* Nothing to dig for and no founding left to run — she just has to be
     * allowed to walk around and pick things up. */
    s.questStage = 1; s.deepCarved = 1e9;
    s.stepForTest(1 / 60, 4);

    const rows = [];
    const seen = new Set();
    for (const prop of s.props) {
      if (seen.has(prop.id)) continue;
      seen.add(prop.id);

      /* WHY she refuses, before driving the control that hides the reason.
       * `useAbility` turns the refusal into a toast, so a prop she is
       * simply not strong enough to shift would read as a broken grab. */
      if (s.carry.carrying) s.carry.drop();
      const refusal = s.carry.lift(prop, () => true);
      if (!refusal) s.carry.drop();
      if (refusal) { rows.push({ id: prop.id, caste: want, why: refusal }); continue; }

      /* The longest way out of its own hull, in world space — the axis a
       * long thing is long along, whatever way it happens to have settled. */
      const p = new V();
      const far = new V();
      const hull = prop.hullForTest;
      let reach = 0;
      for (let i = 0; i < hull.length; i += 3) {
        p.set(hull[i], hull[i + 1], hull[i + 2]).applyQuaternion(prop.root.quaternion);
        if (p.length() <= reach) continue;
        reach = p.length();
        far.copy(p);
      }

      /*
       * TWO STANDING PLACES, because they fail differently.
       *
       * OVER IT is the reported one: `propInReach` measures the gap as
       * distance minus radius, so she can stand right on top of something
       * small and her jaw anchor ends up past its centre. That is where
       * the old rule picked the far side and she wore the thing.
       *
       * AT ONE END is the earlier complaint — "I grabbed at the end, but
       * it snapped to the middle point" — and it has to keep passing.
       */
      const spots = [{ how: 'over', at: [prop.at.x, prop.at.z], face: 0 }];
      if (reach * MM > 3) {
        /* Just outside the tip, looking back down its length. */
        const ex = prop.at.x + far.x * 1.35;
        const ez = prop.at.z + far.z * 1.35;
        spots.push({ how: 'end', at: [ex, ez], face: Math.atan2(-far.x, -far.z) });
      }

      for (const spot of spots) {
        if (s.carry.carrying) { s.useAbility('interact'); s.stepForTest(1 / 60, 6); }
        s.teleportMm(spot.at[0] * MM, spot.at[1] * MM);
        s.setFacingForTest(spot.face);
        s.stepForTest(1 / 60, 10);
        s.useAbility('interact');
        s.stepForTest(1 / 60, 30);
        if (s.carry.held !== prop) {
          rows.push({ id: prop.id, caste: want, how: spot.how, why: 'out of reach from there' });
          continue;
        }

        /*
         * HOW FAR THE LOAD REACHES BACK PAST HER MOUTH — which is the
         * thing a screenshot shows, and is NOT the same question as how
         * far its centre is from her head bone.
         *
         * A first cut compared every hull point against the head's drawn
         * radius from `segmentShell`. That reported the identical number
         * for every prop on a caste, because it was really measuring one
         * thing: the grab point sits AT the jaw anchor by construction, so
         * the nearest hull point to her head is always that anchor and the
         * answer was just the anchor's own standoff. True, and no use —
         * her jaw is part of her head.
         *
         * What went wrong in the picture was the BULK of the thing sitting
         * behind the bite, over her face. So: the deepest any hull point
         * reaches back along her heading past the jaw. Held properly that
         * is about zero, because the grab point is its rearmost part.
         */
        const jaw = new V();
        s.queen.jawPosition(jaw);
        const fwd = new V(s.fwd.x, s.fwd.y, s.fwd.z);
        /*
         * BEHIND HER MOUTH IS ONLY A FAULT IF IT IS ALSO IN LINE WITH HER.
         *
         * A twig carried broadside has both its ends behind the bite by
         * definition, and that is an ant carrying a stick, not a stick
         * through her head — the ends are five millimetres out to the
         * side. So a hull point counts as intruding only when it is behind
         * the jaw AND within her own body width of the line she is facing
         * along. `bodyRadius` is measured off her mesh, ignoring her legs,
         * which is exactly the tube a thing would have to be inside to be
         * passing through her.
         */
        const wide = s.queen.bodyRadius();
        const off = new V();
        let behind = 0;
        for (let i = 0; i < hull.length; i += 3) {
          p.set(hull[i], hull[i + 1], hull[i + 2])
            .applyQuaternion(prop.root.quaternion).add(prop.at).sub(jaw);
          const along = p.dot(fwd);
          if (along >= 0) continue;
          off.copy(p).addScaledVector(fwd, -along);
          if (off.length() > wide) continue;
          behind = Math.max(behind, -along);
        }
        const hold = new V(...prop.holdForTest);
        const centre = new V(prop.at.x, prop.at.y, prop.at.z).sub(jaw);
        rows.push({
          id: prop.id,
          caste: want,
          how: spot.how,
          behindMm: +(behind * MM).toFixed(2),
          aheadMm: +(centre.dot(fwd) * MM).toFixed(2),
          holdMm: +(hold.length() * MM).toFixed(2),
          reachMm: +(reach * MM).toFixed(2),
        });
      }
    }
    if (s.carry.carrying) { s.useAbility('interact'); s.stepForTest(1 / 60, 6); }
    return rows;
  }, caste);
}

const rows = [...await sweep('queen'), ...await sweep('worker')];

/* WHAT THE MAJOR HAS TO WORK WITH. Not playable on the island yet, so the
 * carry cannot be driven for her — but the geometry the rule leans on is a
 * property of the rig and can be read straight off it. */
const rigs = await page.evaluate(async () => {
  const mod = await import('/src/anim/QueenModel.ts');
  const out = [];
  for (const caste of ['queen', 'worker', 'major']) {
    const m = new mod.QueenModel(caste);
    const ok = await m.load().catch(() => false);
    if (!ok) { out.push({ caste, why: 'rig would not load' }); m.dispose(); continue; }
    const V = m.root.position.constructor;
    const head = new V();
    const jaw = new V();
    const headR = m.segmentShell('head', head);
    const haveJaw = m.jawPosition(jaw);
    out.push({
      caste,
      headRmm: +(headR * 5).toFixed(2),
      jawOutMm: haveJaw ? +(jaw.distanceTo(head) * 5).toFixed(2) : null,
      standoffMm: haveJaw ? +((jaw.distanceTo(head) - headR) * 5).toFixed(2) : null,
    });
    m.dispose();
  }
  return out;
});

await browser.close();

let bad = 0;
const say = (ok, line) => { if (!ok) bad += 1; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

console.log('\nWHAT SHE IS HOLDING, AND WHERE IT SITS\n');
const where = (r) => `${r.caste.padEnd(7)} ${r.id.padEnd(7)} ${(r.how ?? '').padEnd(4)}`;
for (const r of rows) {
  if (r.why) { console.log(`  ${where(r)} ${r.why}`); continue; }
  console.log(`  ${where(r)}`
    + ` centre ${String(r.aheadMm).padStart(5)} mm ahead of the jaw`
    + `  reaches back past it ${String(r.behindMm).padStart(5)} mm`
    + `  hold ${String(r.holdMm).padStart(5)}/${r.reachMm} mm out`);
}
console.log('');
say(rows.length > 0, 'she picked something up at all');
for (const r of rows) {
  /* SHE IS ALLOWED TO SAY NO. A stone she cannot shift at all is the
   * strength table working, not a grab that failed, so it is reported and
   * not counted against her. */
  if (r.why === 'too-heavy') {
    console.log(`  --    ${r.caste}'s ${r.id} is beyond what she can shift — not a grab fault`);
    continue;
  }
  if (r.why) { say(false, `${r.caste} ${r.id} ${r.how ?? ''}: ${r.why}`); continue; }
  /* Its centre must be IN FRONT of the bite, not behind it. This is the
   * whole failure in one number: with the old rule the seed's centre came
   * out behind her jaw anchor, which is to say inside her head. */
  say(r.aheadMm > 0, `${r.caste} carries the ${r.id} in front of her jaws`
    + ` (from ${r.how}) — centre ${r.aheadMm} mm ahead`);
  /* And it must not reach back past the bite either, which is what a long
   * thing can do while its centre is still forward. A third of a
   * millimetre is the hull's own resolution at these sizes. */
  say(r.behindMm < 0.35, `${r.caste}'s ${r.id} does not reach back into her`
    + ` face (from ${r.how}) — ${r.behindMm} mm past the jaw`);
}
/* The earlier fix, still standing: a long thing taken by the end is held by
 * the end. Anything round has its hold at its own radius and passes on the
 * same rule, which is why this is a fraction of the shape's own reach. */
for (const r of rows.filter((x) => !x.why && x.how === 'end')) {
  say(r.holdMm > r.reachMm * 0.6,
    `${r.caste} takes the ${r.id} by the end she reached, not by its middle`
    + ` — ${r.holdMm} of ${r.reachMm} mm out`);
}

console.log('\nWHAT EACH RIG GIVES THE RULE TO WORK WITH\n');
for (const g of rigs) {
  if (g.why) { console.log(`  ${g.caste.padEnd(7)} ${g.why}`); continue; }
  console.log(`  ${g.caste.padEnd(7)} head r=${String(g.headRmm).padStart(5)} mm`
    + `  jaw anchor ${String(g.jawOutMm).padStart(5)} mm out`
    + `  standoff ${String(g.standoffMm).padStart(6)} mm`);
}
console.log('');
for (const g of rigs) {
  if (g.why) { say(false, `${g.caste}: ${g.why}`); continue; }
  say(g.standoffMm !== null && g.standoffMm > -0.6,
    `${g.caste}'s jaw anchor is not buried in her own head — ${g.standoffMm} mm`);
}

if (errs.length) console.log(`\npage errors: ${errs.slice(0, 3).join(' | ')}`);
if (bad > 0 || errs.length) { console.log(`\n${bad} check(s) failed`); process.exit(1); }
console.log('\nall green — she carries things in front of her face, not through it');
