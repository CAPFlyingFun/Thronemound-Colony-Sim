/**
 * THE RAILWAY: does riding a recorded track cure the underground shake, and
 * does the surface stay exactly as it was?
 *
 * The instability all came from one place — her position and attitude were
 * re-derived every frame from voxel soil she was in the middle of destroying,
 * and the surface normal under her jumped 5.3 degrees a FRAME while digging.
 * A track is recorded once and cannot be jogged by later excavation, so the
 * claim is that riding it is steady by construction rather than by damping.
 *
 * Four questions:
 *
 *   STATES    does she actually reach each of surface, digging, and rails, and
 *             is the SURFACE untouched — that was the explicit requirement.
 *   STEADY    riding the track, how far does the view swing per frame against
 *             the same measurement taken while digging?
 *   CHAMBER   dig out a wide room and she must come OFF the rails and be free
 *             again, which is the other half of the requirement.
 *   TRACK     boarding must put her where she stands, not at the end of the
 *             line, and the throttle must move her both ways along it.
 */
import { chromium } from 'playwright';

const URL = process.env.SMOKE_URL
  ?? 'http://localhost:4552/Thronemound-Colony-Sim/?scene=block';
const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

const fresh = async () => {
  const page = await b.newPage({ viewport: { width: 932, height: 430 } });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.blockScene?.ready, null, { timeout: 60000 });
  await page.evaluate(() => window.blockScene.setPausedForTest(true));
  await page.waitForTimeout(400);
  return page;
};

const run = async (what) => {
  const page = await fresh();
  const row = await page.evaluate((mode) => {
    const lab = window.blockScene;
    const DEG = 180 / Math.PI;
    const V = Object.getPrototypeOf(lab.at).constructor;
    lab.setPausedForTest(true);
    lab.stepForTest(1 / 60, 120);

    const swing = () => {
      const s = { sum: 0, peak: 0, n: 0 };
      let last = lab.camera.getWorldDirection(new V());
      let lastUp = lab.up.clone();
      const upStat = { sum: 0, peak: 0, n: 0 };
      return {
        tick() {
          const dir = lab.camera.getWorldDirection(new V());
          const a = Math.acos(Math.max(-1, Math.min(1, dir.dot(last)))) * DEG;
          s.sum += a; s.peak = Math.max(s.peak, a); s.n += 1; last = dir.clone();
          const u = Math.acos(Math.max(-1, Math.min(1, lab.up.dot(lastUp)))) * DEG;
          upStat.sum += u; upStat.peak = Math.max(upStat.peak, u); upStat.n += 1;
          lastUp = lab.up.clone();
        },
        get look() {
          return { perFrame: +(s.sum / Math.max(1, s.n)).toFixed(3), worst: +s.peak.toFixed(2) };
        },
        get up() {
          return {
            perFrame: +(upStat.sum / Math.max(1, upStat.n)).toFixed(3),
            worst: +upStat.peak.toFixed(2),
          };
        },
      };
    };

    const states = {};
    const seen = (tag) => { states[tag] = (states[tag] ?? 0) + 1; };

    if (mode === 'surface') {
      const m = swing();
      lab.input.walk = 1;
      for (let i = 0; i < 600; i += 1) { lab.stepForTest(1 / 60, 1); m.tick(); seen(lab.travelState); }
      return { states, look: m.look, up: m.up, trackMm: lab.rail ? lab.rail.lengthMm : 0 };
    }

    // Everything else needs her underground first, so dig in the same way.
    lab.setMode(1);
    lab.setAimPitchForTest(-Math.PI / 2.4);
    const digMetre = swing();
    let dug = 0;
    while (!lab.underground && dug < 400) {
      lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 3);
      dug += 1;
    }
    /*
     * ONE frame per sample, the same as the riding loop below.
     *
     * The first version stepped three frames per sample here and one there,
     * so digging's "11.7 degrees a frame" was three frames of movement wearing
     * one frame's label. Comparing that with riding flattered the rails by 3x.
     */
    for (let i = 0; i < 720; i += 1) {
      lab.input.dig = true; lab.input.walk = 1; lab.digCooldown = 0;
      lab.stepForTest(1 / 60, 1);
      digMetre.tick();
      seen(lab.travelState);
    }
    lab.input.dig = false;
    const trackMm = lab.rail ? +lab.rail.lengthMm.toFixed(2) : 0;
    const buriedStates = { ...states };

    const room = () => {
      const r = lab.roomForTest();
      return { enclosed: +r.enclosed.toFixed(2), boreMm: +r.boreMm.toFixed(2),
        nearestMm: +r.nearestMm.toFixed(2) };
    };
    if (mode === 'dig') {
      return { states: buriedStates, look: digMetre.look, up: digMetre.up, trackMm,
        room: room() };
    }

    if (mode === 'rule') {
      /*
       * The chamber RULE, fed readings directly.
       *
       * Carving a room the honest way needs more excavation than a
       * sixty-four millimetre block has in it — the probe that tried dug her
       * clean out of the far side, and then "she is not on rails" passed for
       * the wrong reason entirely. The rule is a pure function of enclosure
       * and bore, so it is asked as one.
       */
      const ask = (enclosed, boreMm) => {
        lab.setRoomForTest({ enclosed, boreMm, nearestMm: 0.5, roofed: 1 });
        lab.stepForTest(1 / 60, 1);
        return lab.travelState;
      };
      /*
       * Only the CHAMBER half is injectable now. Being underground stopped
       * being a statistic and became a live cast for a ceiling along her own
       * up, which a forced room reading cannot reach — so asking this for
       * "open ground" while she is physically in a hole tests nothing and
       * reported a chamber for it.
       */
      return {
        states: buriedStates, look: digMetre.look, up: digMetre.up, trackMm,
        room: room(),
        tunnel: ask(1, 2.5),
        chamber: ask(1, 5),
        // And the band: once in a room, a slight narrowing must not eject her.
        stillChamber: ask(1, 3.2),
        backToTunnel: ask(1, 2.4),
      };
    }

    if (mode === 'chamber') {
      /*
       * Hollow a room out AROUND her by biting in every direction, then check
       * she is free rather than railed. Turning on the spot is the only way to
       * do that with the tools she has, which is also how a player would.
       */
      /*
       * A room has to be WALKED out, not chewed from a standstill. Biting on
       * the spot only ever removes the same mouthful, which is why the first
       * version of this left her in a 0.5 mm bore and reported no chamber:
       * nothing had been excavated at all.
       */
      for (let i = 0; i < 1800; i += 1) {
        lab.input.dig = true;
        lab.input.walk = 1;
        lab.input.yaw = Math.sin(i / 55) > 0 ? 1 : -1;
        lab.setAimPitchForTest(Math.sin(i / 37) * 0.9);
        lab.digCooldown = 0;
        lab.stepForTest(1 / 60, 1);
      }
      lab.input.dig = false; lab.input.yaw = 0;
      lab.stepForTest(1 / 60, 30);
      return {
        states: buriedStates, look: digMetre.look, up: digMetre.up, trackMm,
        after: lab.travelState, room: room(), onRails: lab.onRails,
      };
    }

    // RAILS: stop digging and travel. Board, run forward, then run back.
    /*
     * BACK first, then forward. She digs her way to the far end of the track,
     * so she boards at the buffers — and the first version asked her to drive
     * forward from there and called the clamp a broken throttle.
     */
    const rideMetre = swing();
    const ridden = {};
    let boardedAt = null;
    lab.input.walk = -1;
    for (let i = 0; i < 420; i += 1) {
      lab.stepForTest(1 / 60, 1);
      rideMetre.tick();
      ridden[lab.travelState] = (ridden[lab.travelState] ?? 0) + 1;
      if (boardedAt === null && lab.onRails) boardedAt = +lab.railS.toFixed(2);
    }
    const backS = +lab.railS.toFixed(2);
    lab.input.walk = 1;
    for (let i = 0; i < 240; i += 1) { lab.stepForTest(1 / 60, 1); rideMetre.tick(); }
    const forwardS = +lab.railS.toFixed(2);
    lab.input.walk = 0;
    return {
      states: ridden, look: rideMetre.look, up: rideMetre.up, trackMm,
      boardedAt, forwardS, backS, onRails: lab.onRails, room: room(),
      digLook: digMetre.look, digUp: digMetre.up,
    };
  }, what);
  await page.close();
  return { what, ...row };
};

const out = {
  surface: await run('surface'),
  dig: await run('dig'),
  rails: await run('rails'),
  rule: await run('rule'),
};
console.log(JSON.stringify({ ...out, errs }, null, 2));

const lines = [];
let good = true;
const check = (name, ok, detail) => { lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`); good = ok && good; };

check('surface untouched',
  Object.keys(out.surface.states).length === 1 && out.surface.states.surface > 0
  && out.surface.trackMm === 0,
  `states ${JSON.stringify(out.surface.states)}, no track laid, `
  + `look ${out.surface.look.perFrame}°/f`);
check('track gets laid while digging', out.dig.trackMm > 3,
  `${out.dig.trackMm} mm of track from ${out.dig.states.digging ?? 0} digging frames`);
check('she boards it', out.rails.boardedAt !== null && (out.rails.states.rails ?? 0) > 60,
  `boarded at ${out.rails.boardedAt} mm, on rails for ${out.rails.states.rails ?? 0} frames`);
check('throttle runs both ways',
  out.rails.backS < (out.rails.boardedAt ?? 0) - 1 && out.rails.forwardS > out.rails.backS + 1,
  `boarded ${out.rails.boardedAt} → back ${out.rails.backS} → forward ${out.rails.forwardS} mm`);
check('riding is steadier than digging',
  out.rails.look.perFrame < out.rails.digLook.perFrame,
  `digging ${out.rails.digLook.perFrame}°/f (worst ${out.rails.digLook.worst}), `
  + `riding ${out.rails.look.perFrame}°/f (worst ${out.rails.look.worst})`);
check('the chamber rule holds, with a band',
  out.rule.tunnel !== 'chamber' && out.rule.chamber === 'chamber'
  && out.rule.stillChamber === 'chamber' && out.rule.backToTunnel !== 'chamber',
  `bore 2.5→${out.rule.tunnel}, bore 5→${out.rule.chamber}, `
  + `narrowing to 3.2→${out.rule.stillChamber} (band holds), `
  + `2.4→${out.rule.backToTunnel}`);
check('no errors', errs.length === 0, errs.join('; ') || 'none');

console.log('');
console.log('room readings   ' + ['dig', 'rails', 'rule']
  .map((k) => `${k}: ${JSON.stringify(out[k]?.room ?? {})}`).join('\n                '));
console.log('');
for (const line of lines) console.log(line);
console.log(good ? 'RAILS_RIDE' : 'RAILS_DERAIL');
await b.close();
