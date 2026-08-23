/**
 * PHASE 0 — WHAT THE QUEEN ACTUALLY DOES TO THE SOIL, AND IT TO HER.
 *
 * This probe changes nothing. It exists so that the ten fixes queued behind
 * it are aimed at measured faults rather than at a screenshot, and so that
 * each of them has a number it has to move.
 *
 * It reads the running build's own internals rather than a reporting layer
 * built for it. TypeScript's `private` is a compile-time courtesy and the
 * fields are all there at runtime, so `drive.legs`, `dig.job` and the rig's
 * bone map are read directly. That is deliberate: a hook written for a probe
 * can drift from the thing it claims to describe, and the whole point of this
 * pass is that several systems have been quietly describing themselves
 * wrongly.
 *
 * PENETRATION IS A DISTANCE, NOT A FLAG. The field is `min()` of a set of
 * plane and capsule distances, so its value at a point is a distance in world
 * units — conservative near an edge, where the true distance to the surface
 * is larger than the smallest term, never smaller. So a depth reported here
 * can UNDER-state how deep she is and cannot over-state it.
 */
import { chromium } from 'playwright';
import { pressPlay } from './lib/pressPlay.mjs';

const PORT = process.env.PORT ?? '5177';
const RUNS = Number(process.env.RUNS ?? 3);
const SECONDS = Number(process.env.SECONDS ?? 120);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

/** One seeded run of the real default route, measured. */
async function measure() {
  const ctx = await browser.newContext({
    viewport: { width: 932, height: 430 }, serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?cb=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.habitatScene?.ready === true, null, { timeout: 240000 });
  /*
   * THE CLOCK IS TAKEN BEFORE THE DOOR IS OPENED, not after.
   *
   * `reveal()` starts the live loop, and every frame it runs before the
   * probe pauses is simulation nobody counted. Pausing first makes the run
   * exactly the frames this file ticks — see the note on `reveal`.
   */
  await page.evaluate(() => window.habitatScene.setPausedForTest(true));
  await pressPlay(page);

  const out = await page.evaluate(async ({ seconds }) => {
    const MM = 5;                       /* one world unit */
    const lab = window.habitatScene;
    lab.setPausedForTest(true);
    /* How much simulated time the LIVE loop got before the probe took the
     * clock. Anything but zero is a determinism leak, so it is reported. */
    const elapsedAtPause = lab.elapsed;
    lab.setDiggingForTest(true);

    const ant = lab.ant;
    const model = ant.model;
    const drive = ant.drive;
    const field = lab.field;
    const rig = model.rig;

    /* --------------------------------------------------- her actual anatomy */

    /*
     * THE CORE BODY, TAKEN OFF THE SKIN.
     *
     * Every skinned vertex is bucketed by the bone it is most weighted to,
     * and the buckets are grouped into head / thorax / gaster by the rig
     * table. No invented capsule: these are the points the player sees.
     */
    const SEGMENT_OF = new Map();
    const put = (names, seg) => (names ?? []).forEach((n) => SEGMENT_OF.set(n, seg));
    put([rig.thorax[0]], 'head');
    put(rig.mouth, 'head');
    put(rig.thorax.slice(1), 'thorax');
    put(rig.body, 'thorax');
    put(rig.gaster, 'gaster');

    let skinned = null;
    model.root.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
    if (!skinned) return { fatal: 'no skinned mesh' };

    const boneNameAt = (i) => {
      const sk = skinned.geometry.attributes.skinIndex;
      const sw = skinned.geometry.attributes.skinWeight;
      let best = -1; let bestW = -1;
      for (let c = 0; c < 4; c += 1) {
        const w = sw.getComponent(i, c);
        if (w > bestW) { bestW = w; best = sk.getComponent(i, c); }
      }
      return skinned.skeleton.bones[best]?.name ?? null;
    };

    const buckets = { head: [], thorax: [], gaster: [] };
    const count = skinned.geometry.attributes.position.count;
    for (let i = 0; i < count; i += 1) {
      const seg = SEGMENT_OF.get(boneNameAt(i));
      if (seg) buckets[seg].push(i);
    }

    /*
     * A DETERMINISTIC SUBSAMPLE of each segment's skin, evenly strided. The
     * whole mesh transformed every frame is too slow under SwiftShader, and
     * an even stride over the buffer is reproducible where a random pick is
     * not.
     */
    const SHELL = 28;
    const shell = {};
    for (const seg of ['head', 'thorax', 'gaster']) {
      const all = buckets[seg];
      const stride = Math.max(1, Math.floor(all.length / SHELL));
      shell[seg] = [];
      for (let k = 0; k < all.length && shell[seg].length < SHELL; k += stride) {
        shell[seg].push(all[k]);
      }
    }

    /* three is already on the page through the model; borrow its class
     * rather than importing a second copy of it. */
    const Vec = model.root.position.constructor;
    const scratch = new Vec();

    const worldVertex = (i, into) => {
      into.fromBufferAttribute(skinned.geometry.attributes.position, i);
      skinned.applyBoneTransform(i, into);
      return into.applyMatrix4(skinned.matrixWorld);
    };

    /* Her measured extents, once, in the settled stance. */
    model.root.updateMatrixWorld(true);
    const extents = {};
    for (const seg of ['head', 'thorax', 'gaster']) {
      let minx = 1e9; let maxx = -1e9; let miny = 1e9; let maxy = -1e9;
      let minz = 1e9; let maxz = -1e9;
      const right = new Vec().crossVectors(ant.up, ant.forward).normalize();
      for (const i of buckets[seg]) {
        worldVertex(i, scratch).sub(ant.at);
        const a = scratch.dot(right); const b = scratch.dot(ant.up);
        const c = scratch.dot(ant.forward);
        minx = Math.min(minx, a); maxx = Math.max(maxx, a);
        miny = Math.min(miny, b); maxy = Math.max(maxy, b);
        minz = Math.min(minz, c); maxz = Math.max(maxz, c);
      }
      extents[seg] = {
        widthMm: +((maxx - minx) * MM).toFixed(2),
        heightMm: +((maxy - miny) * MM).toFixed(2),
        lengthMm: +((maxz - minz) * MM).toFixed(2),
        verts: buckets[seg].length,
      };
    }

    /* ------------------------------------------------------------ the legs */

    /* The bone a leg is actually DRAWN down to, from the model's own map. */
    const tipBone = (slot) => {
      const limb = rig.legs.find((l) => l.slot === slot);
      if (!limb) return null;
      const tip = model.limbTip?.get(slot) ?? limb.bones[limb.bones.length - 1];
      return model.bones?.get(tip) ?? null;
    };

    /* ----------------------------------------------------------- the tally */

    const worst = {
      head: 0, thorax: 0, gaster: 0,
      walking: 0, digging: 0, descending: 0,
    };
    const framesInside = { head: 0, thorax: 0, gaster: 0 };
    const TOL = 0.01 / MM;              /* 0.01 mm, in world units */
    let sampled = 0;
    const byPhase = {
      head: { walking: 0, facing: 0, closing: 0, digging: 0 },
      thorax: { walking: 0, facing: 0, closing: 0, digging: 0 },
      gaster: { walking: 0, facing: 0, closing: 0, digging: 0 },
    };

    const legTally = {};
    for (const l of rig.legs) {
      legTally[l.slot] = {
        planted: 0, swinging: 0, groping: 0,
        targetInSolidMm: 0, drawnInSolidMm: 0,
        worstTargetGapMm: 0,
        aboveBackFrames: 0, worstAboveBackMm: 0,
        anchorWhileGroping: 0,
      };
    }

    /* Dig bookkeeping — every job's start, end and tangent. */
    const jobs = [];
    let lastJob = null;
    let arms = lab.digReportForTest().arms;
    let reArms = 0;
    const phases = {};
    let travelled = 0;
    /*
     * DID THE BRAIN ASK FOR SOMETHING THE WORLD WOULD REFUSE?
     *
     * Phase 11's measurement. `BodyShell` guarantees she cannot ENTER soil;
     * it says nothing about how often she tries. An ant that walks into a
     * wall until a timer expires is safe and looks like a Roomba, and this
     * is the number that tells the two apart.
     */
    let blockedAsks = 0;
    let walkAsks = 0;
    const STEP_AHEAD = 0.4;
    const prev = ant.at.clone();
    let lastY = ant.at.y;

    const frames = Math.round(seconds * 60);
    const SAMPLE_EVERY = 4;             /* the skin transform is the cost */

    for (let f = 0; f < frames; f += 1) {
      lab.tick(1 / 60);
      const d = lab.digReportForTest();
      phases[d.phase] = (phases[d.phase] ?? 0) + 1;
      travelled += ant.at.distanceTo(prev);
      const descending = ant.at.y < lastY - 1e-6;
      lastY = ant.at.y;
      prev.copy(ant.at);

      if (d.arms > arms) { reArms += d.arms - arms; arms = d.arms; }

      const want = lab.intentForTest();
      /*
       * ONLY WHILE SHE IS WALKING ON GROUND. On the rail there is no column
       * to stand in and no heading to steer — the tunnel carries her — so
       * asking `standAt` about a point inside a tube reads "solid" and means
       * nothing. Counting those frames put the figure at 46.7 % during a
       * descent in which she never once asked for anything illegal.
       */
      if (!ant.rail && (want.walk ?? 0) > 0.05) {
        walkAsks += 1;
        const h = ant.heading;
        const nx = ant.at.x + Math.sin(h) * STEP_AHEAD;
        const nz = ant.at.z + Math.cos(h) * STEP_AHEAD;
        if (lab.dig.world.standAt(nx, nz, h, ant.at.y + 0.4) === null) blockedAsks += 1;
      }

      /*
       * A TRACK IS BORN the frame `dig.track` becomes an object, and the
       * seams that used to be measured between bores no longer exist: the
       * centreline is one curve. What is worth watching now is how much of
       * the planned nest she has actually excavated.
       */
      const track = lab.dig.track ?? null;
      if (track && track !== lastJob) {
        jobs.push({ frame: f, plannedMm: +track.plannedMm.toFixed(2) });
      }
      lastJob = track;

      /* ---- core body against the field, as a depth */
      if (f % SAMPLE_EVERY === 0) {
        sampled += 1;
        model.root.updateMatrixWorld(true);
        for (const seg of ['head', 'thorax', 'gaster']) {
          let deep = 0;
          for (const i of shell[seg]) {
            worldVertex(i, scratch);
            const v = field.sample(scratch.x, scratch.y, scratch.z);
            if (v > deep) deep = v;
          }
          if (deep > TOL) framesInside[seg] += 1;
          if (deep > worst[seg]) worst[seg] = deep;
          if (deep > worst.digging && d.phase === 'digging') worst.digging = deep;
          if (deep > worst.walking && d.phase === 'walking') worst.walking = deep;
          if (descending && deep > worst.descending) worst.descending = deep;
          /*
           * PER SEGMENT PER PHASE, because the two readings mean different
           * things and the aggregate hides it. Her head is inside solid soil
           * while she DIGS by construction — the work face is solid, that is
           * what makes it a work face — so a head figure taken over the whole
           * run cannot be held to an acceptance criterion. The same segment
           * measured while WALKING has no such excuse.
           */
          if (deep > byPhase[seg][d.phase]) byPhase[seg][d.phase] = deep;
        }

        /* ---- legs */
        const back = ant.at.clone().addScaledVector(ant.up, model.bodyTopAboveSole?.() ?? 0);
        for (const leg of drive.legs) {
          const t = legTally[leg.slot];
          if (!t) continue;
          if (leg.planted) t.planted += 1;
          else if (leg.groping) t.groping += 1;
          else t.swinging += 1;

          const tv = field.sample(leg.at.x, leg.at.y, leg.at.z);
          if (tv > t.targetInSolidMm) t.targetInSolidMm = tv;

          const bone = tipBone(leg.slot);
          if (bone) {
            bone.getWorldPosition(scratch);
            const dv = field.sample(scratch.x, scratch.y, scratch.z);
            if (dv > t.drawnInSolidMm) t.drawnInSolidMm = dv;
            const gap = scratch.distanceTo(leg.at);
            if (gap > t.worstTargetGapMm) t.worstTargetGapMm = gap;
            /*
             * THE SKY LEG IS A DRAWN FACT, NOT A REQUESTED ONE — and the
             * first cut of this probe measured the wrong one.
             *
             * It asked whether the GAIT's target (`leg.at`) rose above her
             * back and got zero on all six legs, which reads as "no sky
             * legs" and is false. The gait does not send feet upward; the
             * IK does, when its one-directional escape lifts a target that
             * `surfaceUnder` says is buried. So the height that matters is
             * the DRAWN bone's, and it is measured in every state, not only
             * while groping.
             */
            const above = scratch.clone().sub(back).dot(ant.up);
            if (above > 0) {
              t.aboveBackFrames += 1;
              if (above > t.worstAboveBackMm) t.worstAboveBackMm = above;
            }
          }

          /* An anchor is what the IK is handed. See `anchorFor`. */
          if (leg.groping && drive.anchorFor(leg.slot) !== null) {
            t.anchorWhileGroping += 1;
          }
        }
      }
    }

    /*
     * NO SEAMS TO MEASURE ANY MORE.
     *
     * The old digger cut independent bores, so the gap and the tangent break
     * between consecutive ones were the thing to watch — 1.14 to 1.35 bore
     * radii of discontinuity, which is the beading Joshua reported. On a
     * track there are no consecutive bores: there is one centreline, carved
     * forward. Continuity is not a measurement, it is the definition, so the
     * checks that used to guard it are gone rather than left green forever
     * on a property nothing can break.
     *
     * What replaces them is progress along the plan.
     */
    const track = lab.dig.track ?? null;

    /* deepest excavation, the same sweep probe:dig uses */
    const grade = lab.gradeForTest();
    let deepestMm = 0;
    for (let x = 1.5; x < lab.boundsForTest().size - 1.5; x += 0.4) {
      for (let z = 1.5; z < lab.boundsForTest().size - 1.5; z += 0.4) {
        const top = lab.surfaceAt(x, z, grade + 3);
        if (top !== null) deepestMm = Math.max(deepestMm, (grade - top) * MM);
      }
    }

    const mm = (v) => +(v * MM).toFixed(3);
    const legOut = {};
    for (const [slot, t] of Object.entries(legTally)) {
      const n = t.planted + t.swinging + t.groping;
      legOut[slot] = {
        plantedPct: +(100 * t.planted / n).toFixed(1),
        swingPct: +(100 * t.swinging / n).toFixed(1),
        gropePct: +(100 * t.groping / n).toFixed(1),
        targetInSolidMm: mm(t.targetInSolidMm),
        drawnInSolidMm: mm(t.drawnInSolidMm),
        worstTargetGapMm: mm(t.worstTargetGapMm),
        drawnAboveBackPct: +(100 * t.aboveBackFrames / n).toFixed(1),
        worstDrawnAboveBackMm: mm(t.worstAboveBackMm),
        anchoredWhileGropingPct: +(100 * t.anchorWhileGroping / Math.max(1, t.groping)).toFixed(1),
      };
    }

    return {
      elapsedAtPause: +elapsedAtPause.toFixed(3),
      extents,
      shell: ant.shell ? {
        headRadiusMm: +(ant.shell.radiusOf('head') * MM).toFixed(2),
        thoraxRadiusMm: +(ant.shell.radiusOf('thorax') * MM).toFixed(2),
        gasterRadiusMm: +(ant.shell.radiusOf('gaster') * MM).toFixed(2),
        samplesPerTest: ant.shell.sampleCount,
      } : null,
      body: {
        headPenMm: mm(worst.head),
        thoraxPenMm: mm(worst.thorax),
        gasterPenMm: mm(worst.gaster),
        insidePct: {
          head: +(100 * framesInside.head / sampled).toFixed(1),
          thorax: +(100 * framesInside.thorax / sampled).toFixed(1),
          gaster: +(100 * framesInside.gaster / sampled).toFixed(1),
        },
        worstWalkingMm: mm(worst.walking),
        worstDiggingMm: mm(worst.digging),
        worstDescendingMm: mm(worst.descending),
        byPhase: Object.fromEntries(Object.entries(byPhase).map(([seg, ph]) => [
          seg, Object.fromEntries(Object.entries(ph).map(([k, v]) => [k, mm(v)])),
        ])),
      },
      legs: legOut,
      dig: {
        arms, reArms, jobs: jobs.length, phases,
        walkAsks,
        blockedAskPct: walkAsks === 0 ? 0 : +(100 * blockedAsks / walkAsks).toFixed(1),
        travelledMm: +(travelled * MM).toFixed(0),
        deepestMm: +deepestMm.toFixed(1),
        plannedMm: track ? +track.plannedMm.toFixed(1) : null,
        dugMm: track ? +track.dugMm.toFixed(1) : null,
        dugPct: track && track.plannedMm > 0
          ? +(100 * track.dugMm / track.plannedMm).toFixed(1) : null,
        pieces: track ? track.pieces.length : null,
        dropPitch: track ? track.pieces[0].pitch : null,
        dropLenMm: track ? track.pieces[0].length : null,
      },
    };
  }, { seconds: SECONDS });

  await ctx.close();
  return { ...out, pageErrors: errors };
}

const runs = [];
for (let i = 0; i < RUNS; i += 1) {
  process.stdout.write(`  run ${i + 1}/${RUNS} ... `);
  const r = await measure();
  runs.push(r);
  console.log('done');
  console.log(JSON.stringify(r, null, 2));
}
await browser.close();

/* ------------------------------------------------------------- the summary */

const span = (pick) => {
  const v = runs.map(pick).filter((n) => typeof n === 'number');
  if (!v.length) return 'n/a';
  const lo = Math.min(...v); const hi = Math.max(...v);
  return lo === hi ? `${lo}` : `${lo} - ${hi}`;
};

console.log('\n  ================= PHASE 0 BASELINE =================\n');
console.log(`  runs: ${RUNS} x ${SECONDS} s, same seed`);
console.log(`  live frames before the probe took the clock: ${span((r) => r.elapsedAtPause)} s\n`);
console.log('  CORE BODY, measured off her skin');
for (const seg of ['head', 'thorax', 'gaster']) {
  const e = runs[0].extents[seg];
  console.log(`    ${seg.padEnd(7)} ${e.widthMm} mm wide  ${e.heightMm} mm tall  ${e.lengthMm} mm long  (${e.verts} verts)`);
}
const sh = runs[0].shell;
console.log(sh
  ? `\n  COLLISION SHELL — head r ${sh.headRadiusMm} mm, thorax r ${sh.thoraxRadiusMm} mm, gaster r ${sh.gasterRadiusMm} mm, ${sh.samplesPerTest} field samples per clearance test`
  : '\n  COLLISION SHELL — none measured');
console.log('\n  CORE BODY INSIDE SOLID SOIL, depth in mm');
console.log(`    head    worst ${span((r) => r.body.headPenMm)}   frames inside ${span((r) => r.body.insidePct.head)} %`);
console.log(`    thorax  worst ${span((r) => r.body.thoraxPenMm)}   frames inside ${span((r) => r.body.insidePct.thorax)} %`);
console.log(`    gaster  worst ${span((r) => r.body.gasterPenMm)}   frames inside ${span((r) => r.body.insidePct.gaster)} %`);
console.log(`    any segment — walking ${span((r) => r.body.worstWalkingMm)}, digging ${span((r) => r.body.worstDiggingMm)}, descending ${span((r) => r.body.worstDescendingMm)}`);
console.log('    per segment per phase, worst mm:');
for (const seg of ['head', 'thorax', 'gaster']) {
  const ph = ['walking', 'facing', 'closing', 'digging']
    .map((k) => `${k} ${span((r) => r.body.byPhase[seg][k])}`).join('  |  ');
  console.log(`      ${seg.padEnd(7)} ${ph}`);
}
console.log('\n  LEGS');
for (const slot of Object.keys(runs[0].legs)) {
  const g = span((r) => r.legs[slot].gropePct);
  const sky = span((r) => r.legs[slot].worstDrawnAboveBackMm);
  const anch = span((r) => r.legs[slot].anchoredWhileGropingPct);
  const tgt = span((r) => r.legs[slot].targetInSolidMm);
  const drawn = span((r) => r.legs[slot].drawnInSolidMm);
  console.log(`    ${slot.padEnd(10)} groping ${String(g).padEnd(13)} % | target in solid ${String(tgt).padEnd(14)} mm | drawn in solid ${String(drawn).padEnd(14)} mm | above her back ${String(sky).padEnd(14)} mm | handed to IK as anchor while groping ${anch} %`);
}
console.log('\n  DIGGING');
console.log(`    sites armed        ${span((r) => r.dig.arms)}`);
console.log(`    re-arms            ${span((r) => r.dig.reArms)}`);
console.log(`    tracks laid        ${span((r) => r.dig.jobs)}`);
console.log(`    planned nest       ${span((r) => r.dig.plannedMm)} mm over ${span((r) => r.dig.pieces)} pieces`);
console.log(`    ...excavated       ${span((r) => r.dig.dugMm)} mm  (${span((r) => r.dig.dugPct)} %)`);
console.log(`    deepest excavation ${span((r) => r.dig.deepestMm)} mm`);
console.log(`    travelled          ${span((r) => r.dig.travelledMm)} mm`);
console.log(`    walk asks on foot  ${span((r) => r.dig.walkAsks)} frames`);
console.log(`    ...into solid      ${span((r) => r.dig.blockedAskPct)} % of them`);
console.log('');
