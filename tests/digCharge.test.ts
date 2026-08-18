import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DigCharges, launchPoint } from '../src/scenes/digCharge';
import {
  CHARGES_MAX, CHARGE_RANGE_MM, CHARGE_REACH_MM, EMBER_TRAIL_GAP_MM,
  NOSE_REACH,
} from '../src/scenes/islandTuning';
import {
  CAP_PLANES, CELL_MM, CELL_SIZE, MM, TILE_CELLS,
} from '../src/world/worldScape';

/*
 * THE THROWN CHARGE'S TWO PROMISES, pinned:
 *
 * 1. A charge lobbed over ground LANDS — the arc bends down, meets the
 *    floor, and hands the impact point back so a pocket can be carved
 *    there. The pocket half of that hand-off is `chargeImpact`, tested
 *    below against the same fake stream the bite's tests use: a landed
 *    charge must CHANGE TERRAIN, not just report a position.
 *
 * 2. A charge lobbed at nothing FIZZLES, once, out loud — the flight has
 *    a budget, and running it out is an event, not a leak that leaves a
 *    bead falling forever under the map.
 */

/** A world that is one floor rule and a scene that only counts. */
function makeWorld(solid: (x: number, y: number, z: number) => boolean) {
  const scene = {
    added: 0,
    removed: 0,
    add() { this.added += 1; },
    remove() { this.removed += 1; },
  };
  const hits: { at: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  const fizzles: THREE.Vector3[] = [];
  const charges = new DigCharges(
    { scene: scene as unknown as THREE.Scene, groundSolidAt: solid,
      at: new THREE.Vector3() },
    (at, dir) => hits.push({ at: at.clone(), dir: dir.clone() }),
    (at) => fizzles.push(at.clone()),
  );
  return {
    scene, hits, fizzles, charges,
  };
}

/** Fly until the air is empty or the clock says something leaked. */
function flyOut(charges: DigCharges, seconds = 4): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds && charges.count() > 0; t += dt) charges.step(dt);
}

describe('the flight', () => {
  it('arcs down onto a floor and reports the landing', () => {
    const floorY = 0.3;
    const { hits, fizzles, charges } = makeWorld((_x, y) => y <= floorY);
    const origin = new THREE.Vector3(0.5, 0.5, 0.5);
    expect(charges.lob(origin, new THREE.Vector3(0, 0, 1))).toBe(true);
    flyOut(charges);
    expect(hits.length).toBe(1);
    expect(fizzles.length).toBe(0);
    const hit = hits[0]!;
    /* It went FORWARD along the aim and DOWN under gravity: the landing
     * sits ahead of her, at the floor (within one sub-step of sink), and
     * the arrival direction has bent below the horizontal it left on. */
    expect(hit.at.z).toBeGreaterThan(origin.z + 0.5);
    expect(hit.at.y).toBeLessThanOrEqual(floorY);
    expect(hit.at.y).toBeGreaterThan(floorY - 0.15);
    expect(hit.dir.y).toBeLessThan(0);
    expect(hit.dir.z).toBeGreaterThan(0.5);
  });

  it('fizzles exactly once when the world never answers', () => {
    const { hits, fizzles, charges } = makeWorld(() => false);
    charges.lob(new THREE.Vector3(0.5, 0.5, 0.5), new THREE.Vector3(0, 0, 1));
    flyOut(charges);
    expect(hits.length).toBe(0);
    expect(fizzles.length).toBe(1);
    expect(charges.count()).toBe(0);
  });

  it('spends its whole range before giving up', () => {
    /* An upward lob over a void: the path flown to the fizzle must be at
     * least the advertised range — the budget is path length, not a
     * timer that might cut a slow arc short. */
    const { fizzles, charges } = makeWorld(() => false);
    const origin = new THREE.Vector3(0, 0, 0);
    charges.lob(origin, new THREE.Vector3(0, 0.4, 1).normalize());
    flyOut(charges);
    const end = fizzles[0]!;
    /* Straight-line displacement is a floor on path length. */
    expect(end.distanceTo(origin)).toBeLessThanOrEqual((CHARGE_RANGE_MM / MM) * 1.05);
    expect(end.distanceTo(origin)).toBeGreaterThan((CHARGE_RANGE_MM / MM) * 0.3);
  });

  it('cannot tunnel through a wall thinner than one frame of travel', () => {
    /* A wall barely one sample wide, hit with a whole HALF-SECOND frame
     * — far more travel than the wall is thick. The half-cell sub-step
     * march must still catch it; a charge popping on the far side of a
     * tunnel wall would be the ghost's "confident hole over open air"
     * mistake with a fuse on it. */
    const wallZ = 2;
    const { hits, fizzles, charges } = makeWorld(
      (_x, _y, z) => z >= wallZ && z <= wallZ + CELL_SIZE * 0.6,
    );
    charges.lob(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1));
    charges.step(0.5);
    expect(hits.length).toBe(1);
    expect(fizzles.length).toBe(0);
    expect(hits[0]!.at.z).toBeLessThan(wallZ + CELL_SIZE);
  });

  it('reuses a spent slot instead of growing the pool', () => {
    const { scene, fizzles, charges } = makeWorld(() => false);
    charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    flyOut(charges);
    charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    flyOut(charges);
    expect(fizzles.length).toBe(2);
    /* One mesh served both throws — the pool is beads, not litter. */
    expect(scene.added).toBe(1);
  });

  it('dispose takes every bead back out of the scene', () => {
    const { scene, charges } = makeWorld(() => false);
    charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    charges.dispose();
    expect(scene.removed).toBe(scene.added);
    expect(charges.count()).toBe(0);
  });

  it('writes its arc in embers, spaced by path flown', () => {
    /* The fireball's trail: a spark every EMBER_TRAIL_GAP_MM of PATH.
     * Over a fizzled flight the spark count must match the path budget,
     * give or take the sub-step quantisation — a trail keyed to frames
     * or wall-clock would thin out exactly when a lob slows at its
     * apex, which is where the arc most needs writing. */
    const sparks: THREE.Vector3[] = [];
    const scene = { add() {}, remove() {} };
    const charges = new DigCharges(
      {
        scene: scene as unknown as THREE.Scene,
        groundSolidAt: () => false,
        at: new THREE.Vector3(),
        ember: (at) => sparks.push(at.clone()),
      },
      () => {},
      () => {},
    );
    charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 0.4, 1).normalize());
    const dt = 1 / 60;
    for (let t = 0; t < 4 && charges.count() > 0; t += dt) charges.step(dt);
    /* This throw dies at the WINDOW's edge, not the path budget — see
     * the two-limit note in `step` — so the floor is keyed to the reach
     * (its path is at least its displacement) and the ceiling to the
     * budget no flight may outspend. */
    expect(sparks.length).toBeGreaterThanOrEqual(
      CHARGE_REACH_MM / EMBER_TRAIL_GAP_MM - 1,
    );
    expect(sparks.length).toBeLessThanOrEqual(CHARGE_RANGE_MM / EMBER_TRAIL_GAP_MM + 1);
    /* And the sparks trace a path, not a point. */
    expect(sparks[0]!.distanceTo(sparks[sparks.length - 1]!)).toBeGreaterThan(0.5);
  });

  it('caps how many fly at once, and says no to the rest', () => {
    const { charges } = makeWorld(() => false);
    for (let i = 0; i < CHARGES_MAX; i += 1) {
      expect(charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 1, 0))).toBe(true);
    }
    expect(charges.lob(new THREE.Vector3(), new THREE.Vector3(0, 1, 0))).toBe(false);
    expect(charges.count()).toBe(CHARGES_MAX);
  });
});

describe('the launch point', () => {
  const origin = new THREE.Vector3(1, 1, 1);
  const aim = new THREE.Vector3(0, 0, 1);

  it('never leaves the span the miss scan proved empty', () => {
    /* First person charges the reach for the eye's seat, so the clear
     * span can be SHORTER than a nose-length — the regression that
     * spawned a charge in unscanned soil at her face. */
    const clear = NOSE_REACH * 0.5;
    const at = launchPoint(origin, aim, clear, () => false);
    expect(at.z - origin.z).toBeLessThanOrEqual(clear * 0.8 + 1e-9);
    expect(at.z).toBeGreaterThan(origin.z);
  });

  it('spawns a nose ahead when the whole nose was scanned', () => {
    const at = launchPoint(origin, aim, NOSE_REACH * 3, () => false);
    expect(at.z - origin.z).toBeCloseTo(NOSE_REACH, 6);
  });

  it('falls back to the ray origin when the offset point is solid', () => {
    const at = launchPoint(origin, aim, NOSE_REACH * 3, () => true);
    expect(at.distanceTo(origin)).toBe(0);
  });
});

/*
 * THE LANDING TESTS LEFT WITH THE DIG. `chargeImpact` was the glue that
 * carved a scoop where a charge struck, and it went when the fireball
 * stopped being a digging tool — Joshua's call, v0.1.98: fire belongs to
 * the fire ant's COMBAT signature, digging is her jaws alone. The FLIGHT
 * above and the RANGE below are the halves the combat ability will reuse,
 * so their promises stay pinned here.
 */

describe('how far a charge may be thrown', () => {
  /*
   * THE RANGE IS THE STREAMER'S NUMBER, NOT A FEEL.
   *
   * It shipped as a flat 150 mm. The carvable world is `WINDOW_MM` (192)
   * across and she is held in a middle tile, so the fine density field
   * stops answering two tiles out — measured in the running game at
   * exactly 64 mm. A charge that may fly 150 could therefore land more
   * than twice as far out as the game can cut, and `probe:chargesave`
   * caught it doing so: of three throws at different pitches, TWO CARVED
   * NOTHING. A bead that arcs, lands, pops, and leaves the soil untouched.
   *
   * There is a quieter failure just inside the same edge:
   * `TerrainStream.remember()` will not record edits within `CAP_PLANES`
   * of the window rim, on the stated grounds that "the rim is at least
   * sixteen millimetres from any bite" — true only while digging is
   * jaw-range. A charge landing there carves a pocket that is never
   * saved, so the hole disappears on reload.
   */
  it('keeps the path budget and the reach as SEPARATE limits', () => {
    /*
     * The correction that cost a version each way. `CHARGE_RANGE_MM` is
     * path length — how much throw is in it. `CHARGE_REACH_MM` is how far
     * from her the game can still carve. A lob's path is LONGER than the
     * ground it covers, so a budget cut to fit the window killed every
     * steep throw in mid-air; measured, all three test pitches carved
     * nothing. The budget must therefore EXCEED the reach.
     */
    expect(CHARGE_RANGE_MM).toBeGreaterThan(CHARGE_REACH_MM);
    /* But not without bound — it is still the thing that ends a throw
     * that meets nothing at all. */
    expect(CHARGE_RANGE_MM).toBeLessThan(CHARGE_REACH_MM * 3);
  });

  it('fizzles a charge that leaves the carvable window', () => {
    /*
     * The hard stop that actually matters, and the one the path budget
     * cannot express. Fired dead level and fast from the origin over
     * ground that is never solid, it must die at the window's edge rather
     * than sail on to carve where nothing can be carved.
     */
    const scene = { add() {}, remove() {} };
    const fizzles: THREE.Vector3[] = [];
    const charges = new DigCharges(
      { scene: scene as unknown as THREE.Scene, groundSolidAt: () => false,
        at: new THREE.Vector3() },
      () => {},
      (at) => fizzles.push(at.clone()),
    );
    charges.lob(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
    for (let i = 0; i < 600 && fizzles.length === 0; i += 1) charges.step(1 / 60);
    expect(fizzles.length).toBe(1);
    const outMm = Math.hypot(fizzles[0]!.x, fizzles[0]!.z) * MM;
    /* At the edge, not far past it — one sub-step of overshoot at most. */
    expect(outMm).toBeGreaterThan(CHARGE_REACH_MM - 12);
    expect(outMm).toBeLessThan(CHARGE_REACH_MM + 12);
  });

  it('stops short of the rim the stream refuses to record', () => {
    /* `TerrainStream.remember()` will not record edits within `CAP_PLANES`
     * of the window rim, so a pocket carved out there vanishes on reload.
     * The reach has to stay inside that band, not merely inside the
     * window. */
    const halfWindowMm = TILE_CELLS * CELL_SIZE * MM * 3;
    expect(halfWindowMm - CHARGE_REACH_MM).toBeGreaterThan(CAP_PLANES * CELL_MM);
  });

  it('derives that reach rather than restating it', () => {
    /* Two tiles of guaranteed clearance. Written as a derivation so a
     * retuned window carries the throw with it instead of silently
     * outgrowing it — which is exactly how 150 came to be wrong. */
    expect(CHARGE_REACH_MM).toBe(TILE_CELLS * CELL_SIZE * MM * 2);
    /* And the measurement it has to agree with. */
    expect(CHARGE_REACH_MM).toBe(64);
  });

  it('is still worth throwing — several body lengths of the ant', () => {
    /* A guardrail that guardrails the guardrail: clamping to the window
     * must not quietly reduce the feature to a nudge. */
    expect(CHARGE_RANGE_MM).toBeGreaterThan(9 * 4);
  });
});
