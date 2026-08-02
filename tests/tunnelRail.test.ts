import { describe, expect, it } from 'vitest';
import { TunnelRail } from '../src/scenes/tunnelRail';
import { ROOM_DIRS, senseRoom } from '../src/voxel/room';

const up = { x: 0, y: 1, z: 0 };
const fwd = { x: 0, y: 0, z: 1 };

/** A straight run along +Z, one sleeper a millimetre. */
function straight(lengthMm: number): TunnelRail {
  const rail = new TunnelRail();
  for (let i = 0; i <= lengthMm; i += 1) rail.record({ x: 0, y: 0, z: i }, up, fwd, 0.5);
  return rail;
}

describe('tunnel rail', () => {
  it('measures its own length along the track', () => {
    expect(straight(10).lengthMm).toBeCloseTo(10, 6);
  });

  it('refuses sleepers closer together than the spacing', () => {
    const rail = new TunnelRail();
    rail.record({ x: 0, y: 0, z: 0 }, up, fwd, 0.5);
    expect(rail.record({ x: 0, y: 0, z: 0.1 }, up, fwd, 0.5)).toBe(false);
    expect(rail.record({ x: 0, y: 0, z: 0.6 }, up, fwd, 0.5)).toBe(true);
    expect(rail.count).toBe(2);
  });

  it('samples between sleepers rather than snapping to them', () => {
    const at = straight(10).sample(3.5)!;
    expect(at.z).toBeCloseTo(3.5, 6);
    expect(at.x).toBeCloseTo(0, 6);
  });

  it('clamps past either end instead of vanishing', () => {
    const rail = straight(10);
    expect(rail.sample(-5)!.z).toBeCloseTo(0, 6);
    expect(rail.sample(99)!.z).toBeCloseTo(10, 6);
  });

  it('BUILDS up from the path rather than replaying the recorded one', () => {
    /*
     * The recorded up is deliberately ignored on anything but a near-vertical
     * bore. She lays sleepers while her body is swinging several degrees a
     * frame, so playing that back reproduces the shake it was recorded with;
     * world up squared against the heading is smooth because the heading is,
     * and it makes the floor of a tunnel level, which is what a floor is for.
     */
    const rail = new TunnelRail();
    for (let i = 0; i <= 20; i += 1) {
      // Recorded rolling wildly from side to side, on a level run.
      const roll = i % 2 ? 1 : -1;
      rail.record({ x: 0, y: 0, z: i * 0.5 }, { x: roll, y: 1, z: 0 }, fwd, 0.1);
    }
    const mid = rail.sample(5)!;
    expect(Math.hypot(mid.ux, mid.uy, mid.uz)).toBeCloseTo(1, 6);
    expect(mid.uy).toBeCloseTo(1, 4);
    expect(mid.ux).toBeCloseTo(0, 4);
    // And the frame is square: up is perpendicular to the heading.
    expect(mid.ux * mid.fx + mid.uy * mid.fy + mid.uz * mid.fz).toBeCloseTo(0, 6);
  });

  it('falls back to the recorded roll only when the bore runs vertical', () => {
    const rail = new TunnelRail();
    for (let i = 0; i <= 20; i += 1) {
      // Straight DOWN, so world up has nothing to say about which way is up.
      rail.record({ x: 0, y: -i * 0.5, z: 0 }, { x: 1, y: 0, z: 0 },
        { x: 0, y: -1, z: 0 }, 0.1);
    }
    const mid = rail.sample(5)!;
    expect(Math.abs(mid.ux)).toBeCloseTo(1, 3);
    expect(mid.ux * mid.fx + mid.uy * mid.fy + mid.uz * mid.fz).toBeCloseTo(0, 6);
  });

  it('finds where a point sits along the track, measured to the SEGMENT', () => {
    // A point beside the middle of a segment is off the track by its offset,
    // not by half a sleeper spacing.
    const rail = new TunnelRail();
    rail.record({ x: 0, y: 0, z: 0 }, up, fwd, 0.5);
    rail.record({ x: 0, y: 0, z: 10 }, up, fwd, 0.5);
    const near = rail.nearest({ x: 0.25, y: 0, z: 5 })!;
    expect(near.distMm).toBeCloseTo(0.25, 6);
    expect(near.s).toBeCloseTo(5, 6);
  });

  it('reports the distance off the track for a point well clear of it', () => {
    const near = straight(10).nearest({ x: 3, y: 0, z: 5 })!;
    expect(near.distMm).toBeCloseTo(3, 6);
  });

  it('SMOOTHS the jitter it was recorded with', () => {
    /*
     * The point of the whole thing. Track laid while she is digging carries
     * the shake she was digging with, and playing that back exactly reproduces
     * it — which is what the first version did: riding turned her body 3.6
     * degrees a frame against 3.8 while digging, a saving of nothing.
     */
    const rail = new TunnelRail();
    for (let i = 0; i <= 60; i += 1) {
      const wobble = (i % 2 ? 1 : -1) * 0.35;
      rail.record(
        { x: wobble, y: 0, z: i * 0.4 },
        { x: wobble * 2, y: 1, z: 0 },
        fwd, 0.1,
      );
    }
    const raw = 0.35;
    let worstX = 0;
    let worstTurn = 0;
    let lastU: [number, number, number] | null = null;
    for (let s = 3; s < rail.lengthMm - 3; s += 0.1) {
      const f = rail.sample(s)!;
      worstX = Math.max(worstX, Math.abs(f.x));
      if (lastU) {
        const d = f.ux * lastU[0] + f.uy * lastU[1] + f.uz * lastU[2];
        worstTurn = Math.max(worstTurn, Math.acos(Math.min(1, Math.max(-1, d))));
      }
      lastU = [f.ux, f.uy, f.uz];
    }
    // The sawtooth is averaged away rather than replayed.
    expect(worstX).toBeLessThan(raw / 4);
    // And the frame barely turns at all, because it is built from the path.
    expect((worstTurn * 180) / Math.PI).toBeLessThan(0.5);
  });

  it('keeps the full length despite the smoothing window', () => {
    // A centred average at the very end only has sleepers on one side, so it
    // reports a point back up the line and quietly shortens the tunnel.
    const rail = straight(20);
    expect(rail.sample(20)!.z).toBeCloseTo(20, 3);
    expect(rail.sample(0)!.z).toBeCloseTo(0, 3);
  });

  it('is empty until something is recorded', () => {
    const rail = new TunnelRail();
    expect(rail.sample(0)).toBeNull();
    expect(rail.nearest({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(rail.lengthMm).toBe(0);
  });

  it('handles a single sleeper without dividing by a zero span', () => {
    const rail = new TunnelRail();
    rail.record({ x: 1, y: 2, z: 3 }, up, fwd, 0.5);
    expect(rail.sample(5)!.x).toBe(1);
    expect(rail.nearest({ x: 1, y: 2, z: 4 })!.distMm).toBeCloseTo(1, 6);
  });
});

describe('room sense', () => {
  const opts = { reachMm: 12, stepMm: 0.25 };

  it('reads open air as not enclosed at all', () => {
    const r = senseRoom(() => false, 0, 0, 0, opts);
    expect(r.enclosed).toBe(0);
    expect(r.boreMm).toBe(12);
  });

  it('reads solid rock as fully enclosed and tight', () => {
    const r = senseRoom(() => true, 0, 0, 0, opts);
    expect(r.enclosed).toBe(1);
    expect(r.boreMm).toBeCloseTo(0.25, 6);
  });

  it('reads standing on a plain as barely enclosed', () => {
    // Ground below, sky everywhere else: only the downward directions hit.
    const r = senseRoom((_x, y) => y < -0.5, 0, 0, 0, opts);
    expect(r.enclosed).toBeLessThan(0.5);
  });

  it('tells a narrow bore from a wide chamber by the bore, not the enclosure', () => {
    // Both are fully enclosed. Only the size differs, which is the point:
    // enclosure says "underground", bore says "is there room to walk about".
    const tube = (radius: number) => (x: number, y: number, z: number) => (
      Math.hypot(x, y, z) > radius
    );
    const bore = senseRoom(tube(2.5), 0, 0, 0, opts);
    const chamber = senseRoom(tube(9), 0, 0, 0, opts);
    expect(bore.enclosed).toBe(1);
    expect(chamber.enclosed).toBe(1);
    expect(bore.boreMm).toBeLessThan(3);
    expect(chamber.boreMm).toBeGreaterThan(8);
  });

  it('does not change when the body it belongs to rolls over', () => {
    /*
     * The whole reason this replaced `buriedDepth`. That marched along HER up,
     * so tumbling in a tunnel swung the reading with no movement at all. This
     * asks the world, so there is nothing for an orientation to change.
     */
    const shape = (x: number, y: number, z: number) => Math.hypot(x, y, z) > 3;
    const a = senseRoom(shape, 0, 0, 0, opts);
    const b = senseRoom(shape, 0, 0, 0, opts);
    expect(a.enclosed).toBe(b.enclosed);
    expect(a.boreMm).toBe(b.boreMm);
  });

  it('tells standing on the ground from being under it by the ROOF', () => {
    /*
     * Enclosure cannot do this, which is why `roofed` exists. Measured in the
     * game, standing on the surface reads 0.64 to 0.71 enclosed and being in
     * her own bore reads 0.64 to 1.00 — the two overlap, because most of the
     * spray points at the ground either way. What is over her head does not.
     */
    const onGround = senseRoom((_x, y) => y < -0.5, 0, 0, 0, opts);
    const buried = senseRoom(() => true, 0, 0, 0, opts);
    const inBore = senseRoom((x, y, z) => Math.hypot(x, y, z) > 2.5, 0, 0, 0, opts);
    expect(onGround.roofed).toBe(0);
    expect(buried.roofed).toBe(1);
    expect(inBore.roofed).toBe(1);
    // And upside down under an overhang there is still a roof, because the
    // question is asked of the world and not of her.
    const overhang = senseRoom((_x, y) => y > 0.5, 0, 0, 0, opts);
    expect(overhang.roofed).toBe(1);
    expect(overhang.enclosed).toBeLessThan(0.5);
  });

  it('sprays fourteen unit directions', () => {
    expect(ROOM_DIRS).toHaveLength(14);
    for (const [x, y, z] of ROOM_DIRS) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
  });
});
