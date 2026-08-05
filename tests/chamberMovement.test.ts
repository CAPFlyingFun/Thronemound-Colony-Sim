import { describe, it, expect } from 'vitest';
import {
    CHAMBER_SAFE, chamberBox, chamberFloorY, chamberNorm, clampToChamber,
    FLOOR_SKIN, insideChamber, roamBoundaryDist,
} from '../src/scenes/ChamberMovement';
import { CHAMBER_SCALE, nodeBounds, nodeHollow } from '../src/nest/nestCarve';
import { type NestNode } from '../src/nest/nestPlan';

/** The store room the island's probes dig: a 10 mm chamber. */
const node: NestNode = { id: 'store', kind: 'chamber', x: 40, y: -60, z: 12, radiusMm: 10 };
const b = chamberBox(node.x, node.y, node.z, node.radiusMm);
const MARGIN = 2.5;

describe('the chamber box mirrors the carve', () => {
    it('uses the same oval radii nodeBounds does', () => {
        const nb = nodeBounds(node)!;
        expect(b.cx - b.rx).toBeCloseTo(nb.min[0]);
        expect(b.cy - b.ry).toBeCloseTo(nb.min[1]);
        expect(b.cz - b.rz).toBeCloseTo(nb.min[2]);
        expect(b.cx + b.rx).toBeCloseTo(nb.max[0]);
        expect(b.cy + b.ry).toBeCloseTo(nb.max[1]);
        expect(b.cz + b.rz).toBeCloseTo(nb.max[2]);
    });

    it('norm 1 is the carved shell itself', () => {
        const hollow = nodeHollow(node)!;
        // On-axis points at norm 1 sit exactly on the carve's zero crossing.
        expect(hollow(node.x + b.rx, node.y, node.z)).toBeCloseTo(0, 5);
        expect(hollow(node.x, node.y - b.ry, node.z)).toBeCloseTo(0, 5);
        expect(chamberNorm(b, node.x + b.rx, node.y, node.z)).toBeCloseTo(1);
        // And inside really is inside.
        expect(insideChamber(b, node.x + 3, node.y + 1, node.z - 2)).toBe(true);
        expect(insideChamber(b, node.x + b.rx + 0.1, node.y, node.z)).toBe(false);
    });

    it('flattens rooms the way CHAMBER_SCALE says', () => {
        expect(b.rx).toBeCloseTo(node.radiusMm * CHAMBER_SCALE.x);
        expect(b.ry).toBeCloseTo(node.radiusMm * CHAMBER_SCALE.y);
        expect(b.rz).toBeCloseTo(node.radiusMm * CHAMBER_SCALE.z);
    });
});

describe('containment', () => {
    it('leaves interior positions alone', () => {
        const p = clampToChamber(b, MARGIN, node.x + 1, node.z - 1);
        expect(p.x).toBe(node.x + 1);
        expect(p.z).toBe(node.z - 1);
    });

    it('clamps a runaway onto the roam ellipse, inside the safe zone', () => {
        const p = clampToChamber(b, MARGIN, node.x + 100, node.z);
        const dx = (p.x - node.x) / b.rx;
        // The roam boundary sits at safe-minus-margin — always strictly
        // inside CHAMBER_SAFE of the carved shell, wall never reachable.
        expect(dx).toBeLessThan(CHAMBER_SAFE);
        expect(dx).toBeCloseTo((b.rx * CHAMBER_SAFE - MARGIN) / b.rx);
    });

    it('slides along the wall on a diagonal push, symmetrically', () => {
        const p = clampToChamber(b, MARGIN, node.x + 50, node.z + 50);
        const q = clampToChamber(b, MARGIN, node.x - 50, node.z - 50);
        expect(p.x - node.x).toBeCloseTo(-(q.x - node.x));
        expect(p.z - node.z).toBeCloseTo(-(q.z - node.z));
        // Still a point ON the roam ellipse, not beyond it.
        const rx = b.rx * CHAMBER_SAFE - MARGIN;
        const rz = b.rz * CHAMBER_SAFE - MARGIN;
        const u = Math.hypot((p.x - node.x) / rx, (p.z - node.z) / rz);
        expect(u).toBeCloseTo(1);
    });

    it('a tiny room still leaves somewhere to stand', () => {
        const small = chamberBox(0, 0, 0, 2); // rx 2.8 — margin would swallow it
        const p = clampToChamber(small, MARGIN, 100, 0);
        expect(p.x).toBeGreaterThan(0); // clamped to the 20% floor, not zero
        expect(p.x).toBeLessThan(small.rx);
    });
});

describe('the roam boundary', () => {
    it('is where the clamp puts a runaway, any direction', () => {
        for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-2, 0.5]]) {
            const p = clampToChamber(b, MARGIN, node.x + dx! * 100, node.z + dz! * 100);
            const out = Math.hypot(p.x - node.x, p.z - node.z);
            expect(out).toBeCloseTo(roamBoundaryDist(b, MARGIN, dx!, dz!));
        }
    });

    it('is longer down the long axis of the room than across it', () => {
        expect(roamBoundaryDist(b, MARGIN, 1, 0))
            .toBeGreaterThan(roamBoundaryDist(b, MARGIN, 0, 1));
    });

    it('refuses a direction that is not one', () => {
        expect(roamBoundaryDist(b, MARGIN, 0, 0)).toBe(0);
    });
});

describe('the standing floor', () => {
    it('dips lowest at the centre, one skin above the carved shell', () => {
        const floor = chamberFloorY(b, node.x, node.z);
        expect(floor).toBeCloseTo(node.y - b.ry * FLOOR_SKIN);
        expect(floor).toBeGreaterThan(node.y - b.ry); // never through the shell
    });

    it('stays strictly inside the carve everywhere she can roam', () => {
        const hollow = nodeHollow(node)!;
        for (let a = 0; a < 12; a += 1) {
            const dir = (a / 12) * Math.PI * 2;
            const p = clampToChamber(
                b, MARGIN, node.x + Math.cos(dir) * 100, node.z + Math.sin(dir) * 100,
            );
            const y = chamberFloorY(b, p.x, p.z);
            // Positive = air inside the room — her feet are always in the void.
            expect(hollow(p.x, y, p.z)).toBeGreaterThan(0);
        }
    });

    it('rises toward the walls like a bowl', () => {
        const centre = chamberFloorY(b, node.x, node.z);
        const nearWall = chamberFloorY(b, node.x + b.rx * 0.7, node.z);
        expect(nearWall).toBeGreaterThan(centre);
    });
});
