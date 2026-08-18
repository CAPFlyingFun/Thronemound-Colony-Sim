/**
 * A COLONY THAT WAS ALREADY THERE — measured in the soil, not in the plan.
 *
 *     npx vite --port 5173                                    # then
 *     SMOKE_URL=http://127.0.0.1:5173/?scene=island npm run probe:colony
 *
 * `tests/colonyNest.test.ts` proves the template is a well-formed nest as
 * arithmetic. It cannot prove the thing that actually matters, because the
 * arithmetic never meets a voxel: once the plan has been sampled onto
 * millimetre cells and meshed, is the home still THERE — open where it
 * should be open, solid where it should be solid, and standable?
 *
 * That is this file's whole job, and it asks every question of the LIVE
 * field (`solidAtMm`) rather than of the plan it was carved from. Measuring
 * a dig against a second description of it is the bug `nestPlan.ts` opens
 * by warning about, and a probe is exactly where it would hide.
 *
 * The card's DONE WHEN, driven end to end:
 *   1. one call stamps a colony at a chosen world position;
 *   2. the mouth breaks the surface WIDE — she strides over a narrow hole;
 *   3. every starter tunnel is open along its centreline;
 *   4. the Queen is alive at the throne, on the floor, in air;
 *   5. the player hatches in the NURSERY — a different room — standing on
 *      real ground rather than falling through it;
 *   6. and it works somewhere else too, which is what makes it a template.
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
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.islandScene?.ready === true, null, { timeout: 200000 });
await page.waitForFunction(
  () => !document.querySelector('.tm-loading-root'), null, { timeout: 200000 },
);

const out = await page.evaluate(async () => {
  const s = window.islandScene;
  const MM = 5;
  const settle = async (frames = 90) => {
    for (let i = 0; i < frames; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  };

  /* Stamp it a little off the spawn, so "at a chosen world position" is
   * being tested rather than "where she happened to be". */
  const atMm = { x: s.at.x * MM + 240, z: s.at.z * MM - 180 };
  const stamped = await s.stampColonyForTest(atMm.x, atMm.z);
  /* The carve queues chunk rebuilds; drain them or every reading below is
   * of soil that has not been remeshed yet. */
  s.drainQueueForTest();
  await settle();

  const c = s.stampedColonyForTest();
  if (!c) return { stamped, colony: null };

  /* THE WAY IN. Read across the real soil a shade under the surface, the
   * same way `probe-nest` does — the opening a mouth makes is the thing she
   * has to find, and the plan's radius is not it. */
  const gate = c.entranceMm;
  let open = 0;
  for (let d = -24; d <= 24; d += 0.25) {
    if (s.solidAtMm(gate.x + d, gate.y - 0.5, gate.z) === false) open += 0.25;
  }
  let mouthDepth = 0;
  while (mouthDepth < 90 && s.solidAtMm(gate.x, gate.y - mouthDepth, gate.z) === false) {
    mouthDepth += 0.5;
  }

  /* EVERY STARTER TUNNEL, along its centreline. A room you cannot walk to
   * is scenery, and a tunnel blocked at one cell is a room you cannot walk
   * to. */
  const nodeAt = (id) => {
    const n = s.planForTest().find((p) => p.id === id);
    return n ?? null;
  };
  const runs = c.edges.map((e) => {
    const a = nodeAt(e.from);
    const b = nodeAt(e.to);
    if (!a || !b) return { id: e.id, samples: 0, blocked: 1, unknown: 0 };
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const steps = Math.max(2, Math.ceil(len));
    let blocked = 0;
    let unknown = 0;
    let samples = 0;
    /* Ends excluded: a centreline sample sitting exactly on a junction's
     * wall is a boundary reading, and the neighbouring run covers it. */
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const solid = s.solidAtMm(
        a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t,
      );
      samples += 1;
      if (solid === null) unknown += 1;
      else if (solid) blocked += 1;
    }
    return { id: e.id, samples, blocked, unknown };
  });

  /*
   * THE ROOMS: air in the middle, and a FLOOR under it.
   *
   * The floor and not a sidewall, and that is a lesson rather than a
   * preference. A first cut tested for soil 40 mm out to the side and two
   * rooms failed it — not because their walls were missing but because the
   * sample was past the streamed window's guaranteed reach, where the field
   * is deliberately cut to air at the rim (`CAP_PLANES`) and then stops
   * answering at all. A probe reading its own instrument's edge and calling
   * it a hole in the world is worse than no probe.
   *
   * Straight down from the centre is the same x and z as the room itself,
   * so it is in the window exactly when the room is — and "is there
   * something to stand on" is the question a room actually has to pass.
   */
  const rooms = c.rooms.map((r) => {
    let drop = 0;
    while (drop < 40 && s.solidAtMm(r.centreMm.x, r.centreMm.y - drop, r.centreMm.z) === false) {
      drop += 0.5;
    }
    return {
      id: r.id,
      inside: s.solidAtMm(r.centreMm.x, r.centreMm.y, r.centreMm.z) === false,
      /* Found a floor, and found it below the room rather than immediately:
       * zero would mean the centre itself is solid. */
      floorAt: drop,
      floored: drop > 1 && drop < 40,
    };
  });

  /* HER. Alive means on her own legs at the throne, not a statue at the
   * spawn — so the test is distance from the anchor, and that she is in
   * air rather than buried in the floor she is standing on. */
  const queen = s.queenAtForTest();
  const queenOff = queen
    ? Math.hypot(queen.x - c.queenAnchorMm.x, queen.z - c.queenAnchorMm.z)
    : Infinity;
  /* AND AT THE RIGHT DEPTH. The flat distance alone would pass a queen
   * standing on the lawn directly above her own throne room, which is
   * exactly the failure this probe caught the first time it ran. */
  const queenDrop = queen ? Math.abs(queen.y - c.queenAnchorMm.y) : Infinity;

  /* AND YOU. In the nursery, in air, with ground under you: `at.y` is her
   * ride height above a floor, so the soil a whole ride below her must be
   * solid or she is standing on nothing and about to fall. */
  const me = { x: s.at.x * MM, y: s.at.y * MM, z: s.at.z * MM };
  const hatchOff = Math.hypot(me.x - c.hatchMm.x, me.z - c.hatchMm.z);
  const nursery = c.rooms.find((r) => r.id === 'nursery');
  const throne = c.rooms.find((r) => r.id === 'throne');
  const inNursery = nursery
    ? Math.hypot(me.x - nursery.centreMm.x, me.z - nursery.centreMm.z)
    : Infinity;
  const inThrone = throne
    ? Math.hypot(me.x - throne.centreMm.x, me.z - throne.centreMm.z)
    : Infinity;
  /*
   * STANDING is air above and soil below, and the boundary between them is
   * where she is — not a gap under her.
   *
   * A first cut counted air downward from `at` and demanded some, which
   * read zero and looked like a fall. It was measuring the cell she is
   * standing ON: `at.y` sits within half a millimetre of the floor's
   * surface (the field is sampled every millimetre), so the sample at her
   * own height is soil by design and would be soil on a hillside too.
   */
  const headroom = s.solidAtMm(me.x, me.y + 1, me.z) === false;
  let standOn = null;
  for (let d = -1; d <= 12; d += 0.5) {
    if (s.solidAtMm(me.x, me.y - d, me.z) === true) { standOn = d; break; }
  }
  /* And she is INSIDE the colony rather than on top of it — the original
   * grade is the surface she would be standing on if the seat had fallen
   * back to the heightfield, which is the exact bug this probe found. */
  const belowGradeMm = s.walkGroundAtForTest(s.at.x, s.at.z) * MM - me.y;

  /* SOMEWHERE ELSE, which is the only claim that makes it a template. */
  const farMm = { x: s.at.x * MM - 900, z: s.at.z * MM + 700 };
  const again = await s.stampColonyForTest(farMm.x, farMm.z, Math.PI / 2);
  s.drainQueueForTest();
  await settle(30);
  const second = s.stampedColonyForTest();

  return {
    stamped,
    colony: {
      id: c.id,
      depthMm: c.depthMm,
      askedMm: atMm,
      gate,
      open,
      mouthDepth,
      runs,
      rooms,
      queen,
      queenOff,
      queenDrop,
      hatchMm: c.hatchMm,
      queenAnchorMm: c.queenAnchorMm,
      caste: s.playerCaste,
      me,
      hatchOff,
      inNursery,
      inThrone,
      standOn,
      headroom,
      belowGradeMm,
      again,
      secondMovedMm: second
        ? Math.hypot(second.entranceMm.x - c.entranceMm.x, second.entranceMm.z - c.entranceMm.z)
        : 0,
    },
  };
});

const c = out.colony;
const checks = [];
const say = (name, ok, detail) => { checks.push({ name, ok }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

console.log('\nA COLONY THAT WAS ALREADY THERE\n');
if (!c) {
  console.log('  FAIL stampColony returned nothing — the faults are on the page console');
  await browser.close();
  process.exit(1);
}

console.log(`  stamped "${c.id}" at ${c.askedMm.x.toFixed(0)}, ${c.askedMm.z.toFixed(0)} mm`);
console.log(`  entrance ${c.gate.x.toFixed(0)}, ${c.gate.y.toFixed(1)}, ${c.gate.z.toFixed(0)} mm`);
console.log(`  the nest runs ${c.depthMm.toFixed(1)} mm below the surface\n`);

say('one call stamps a colony', out.stamped === true);
say('the mouth is placed where it was asked for',
  Math.hypot(c.gate.x - c.askedMm.x, c.gate.z - c.askedMm.z) < 0.5);

/* She strides over a 10 mm hole — measured, 2942 frames of 3000 spent on
 * top of one. The opening has to beat that comfortably. */
say('the way in is wide enough to find', c.open > 14,
  `${c.open.toFixed(2)} mm of opening`);
say('and it is a shaft, not a dish', c.mouthDepth > 12,
  `clear to ${c.mouthDepth.toFixed(1)} mm down`);

const badRuns = c.runs.filter((r) => r.blocked > 0 || r.unknown > 0 || r.samples < 2);
for (const r of c.runs) {
  const note = `${r.samples} samples, ${r.blocked} blocked, ${r.unknown} off-window`;
  console.log(`       ${r.id}: ${note}`);
}
say('every starter tunnel is open end to end', badRuns.length === 0,
  badRuns.length ? badRuns.map((r) => r.id).join(', ') : `${c.runs.length} runs`);

say('every room is open inside, with a floor under it',
  c.rooms.every((r) => r.inside && r.floored),
  c.rooms.map((r) => `${r.id} floor ${r.floorAt.toFixed(1)} mm down`).join(', '));

say('the Queen is at the throne, not at the spawn', c.queenOff < 6,
  c.queen ? `${c.queenOff.toFixed(2)} mm from her anchor` : 'no queen');
/* Her anchor sits a third of the way up the room; she stands on the floor
 * under it, so a few millimetres low is her actually standing there. What
 * this rules out is the failure it caught first time: a queen on the lawn,
 * eighty millimetres above her own ceiling. */
say('and she is DOWN there, not on the lawn above it', c.queenDrop < 10,
  `${Number.isFinite(c.queenDrop) ? c.queenDrop.toFixed(2) : '—'} mm off her anchor's depth`);
say('and the player is not her any more', c.caste === 'fire-worker', c.caste);

say('you hatch in the nursery', c.inNursery < 14 && c.inNursery < c.inThrone,
  `${c.inNursery.toFixed(1)} mm from the brood, ${c.inThrone.toFixed(1)} from the throne`);
say('you hatch at the right DEPTH, not on the surface above it',
  Math.abs(c.me.y - c.hatchMm.y) < 8,
  `${Math.abs(c.me.y - c.hatchMm.y).toFixed(2)} mm off the hatch point`);
say('with the ground under your feet and air over your head',
  c.headroom && c.standOn !== null && c.standOn <= 2,
  `air above, soil ${c.standOn === null ? 'never' : `${c.standOn.toFixed(1)} mm`} below`);
say('and you are INSIDE the colony, not standing on it', c.belowGradeMm > 40,
  `${c.belowGradeMm.toFixed(1)} mm below the original grade`);

say('the same template stamps somewhere else', c.again === true && c.secondMovedMm > 100,
  `second colony ${c.secondMovedMm.toFixed(0)} mm away`);

say('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

const passed = checks.filter((k) => k.ok).length;
const ok = passed === checks.length;
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${passed}/${checks.length}\n`);

await browser.close();
process.exit(ok ? 0 : 1);
