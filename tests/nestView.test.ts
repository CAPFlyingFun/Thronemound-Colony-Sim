import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildNestView, chevrons, nodeMarker, tunnelGeometry } from '../src/nest/nestView';
import { emptyPlan, sampleEdge, type NestPlan } from '../src/nest/nestPlan';
import { demoNest } from '../src/nest/demoNest';

function shaftPlan(): NestPlan {
    return {
        nodes: [
            { id: 'mouth', kind: 'entrance', x: 0, y: 64, z: 0, radiusMm: 9 },
            { id: 'room', kind: 'chamber', x: 0, y: 20, z: 0, radiusMm: 10 },
        ],
        edges: [{ id: 'shaft', from: 'mouth', to: 'room', radiusMm: 5, flow: 'both' }],
    };
}

describe('a tunnel as a tube', () => {
    it('is a closed ring at every step, and joined between them', () => {
        const plan = shaftPlan();
        const geo = tunnelGeometry(plan, plan.edges[0]!, { stepMm: 2, sides: 8 })!;
        const verts = geo.getAttribute('position').count;
        expect(verts % 8).toBe(0);
        const rings = verts / 8;
        expect(rings).toBeGreaterThan(4);
        // Two triangles per side per gap between rings.
        expect(geo.getIndex()!.count).toBe((rings - 1) * 8 * 6);
    });

    it('has unit normals pointing away from the centreline', () => {
        const plan = shaftPlan();
        const geo = tunnelGeometry(plan, plan.edges[0]!, { stepMm: 2 })!;
        const n = geo.getAttribute('normal');
        for (let i = 0; i < n.count; i += 1) {
            expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
        }
    });

    it('does not twist as it goes round a bend', () => {
        // A frame derived fresh from world up flips through ninety degrees the
        // moment a tunnel passes vertical — which on a nest is the entrance
        // shaft, i.e. always. The tell is a big jump between neighbouring
        // rings' first vertices.
        const plan = shaftPlan();
        plan.edges[0]!.bow = { x: 40, y: 30, z: 0 };
        const samples = sampleEdge(plan, plan.edges[0]!, 1);
        const geo = tunnelGeometry(plan, plan.edges[0]!, { stepMm: 1, sides: 8 })!;
        const p = geo.getAttribute('position');
        const rings = p.count / 8;
        let seam = 0;
        for (let r = 1; r < rings; r += 1) {
            const a = new THREE.Vector3().fromBufferAttribute(p, (r - 1) * 8);
            const b = new THREE.Vector3().fromBufferAttribute(p, r * 8);
            seam = Math.max(seam, a.distanceTo(b));
        }
        // The bar has to be relative, not a round number: a seam that simply
        // follows the centreline moves as far as the centreline does, and how
        // far that is depends on the sampling. Measured, a frame derived fresh
        // from world up throws the seam 7.17 mm where the centreline moved
        // 2.93; this one moves 0.15 mm more than the centreline.
        let centre = 0;
        for (let i = 1; i < samples.length; i += 1) {
            centre = Math.max(centre, samples[i]!.s - samples[i - 1]!.s);
        }
        expect(seam).toBeLessThan(centre + 0.5);
    });

    it('follows the flare, so the tube is wider where the bore is', () => {
        const plan = shaftPlan();
        const geo = tunnelGeometry(plan, plan.edges[0]!, { stepMm: 1, sides: 8 })!;
        const p = geo.getAttribute('position');
        const rings = p.count / 8;
        const spread = (ring: number) => {
            let far = 0;
            for (let k = 0; k < 8; k += 1) {
                const v = new THREE.Vector3().fromBufferAttribute(p, ring * 8 + k);
                far = Math.max(far, Math.hypot(v.x, v.z));
            }
            return far;
        };
        expect(spread(rings - 1)).toBeGreaterThan(spread(Math.floor(rings / 2)) + 3);
    });

    it('declines an edge whose ends do not exist', () => {
        expect(tunnelGeometry(shaftPlan(), {
            id: 'x', from: 'mouth', to: 'ghost', radiusMm: 5, flow: 'both',
        })).toBeNull();
    });
});

describe('chevrons', () => {
    it('points a one-way tunnel one way only', () => {
        const plan = shaftPlan();
        plan.edges[0]!.flow = 'forward';
        const cones = chevrons(plan, plan.edges[0]!, { chevronEveryMm: 8 });
        expect(cones.length).toBeGreaterThan(2);
        const down = new THREE.Vector3(0, 1, 0).applyQuaternion(cones[0]!.quaternion);
        // 'forward' runs from the mouth at y=64 to the room at y=20.
        expect(down.y).toBeLessThan(-0.9);
        for (const cone of cones) {
            const aim = new THREE.Vector3(0, 1, 0).applyQuaternion(cone.quaternion);
            expect(aim.y).toBeLessThan(-0.9);
        }
    });

    it('points a backward tunnel the other way', () => {
        const plan = shaftPlan();
        plan.edges[0]!.flow = 'backward';
        const aim = new THREE.Vector3(0, 1, 0)
            .applyQuaternion(chevrons(plan, plan.edges[0]!)[0]!.quaternion);
        expect(aim.y).toBeGreaterThan(0.9);
    });

    it('draws a two-way tunnel with arrows BOTH ways, not with none', () => {
        // Drawing nothing would make "runs both ways" and "no flow set" look
        // identical, which is the one thing the arrows exist to distinguish.
        const plan = shaftPlan();
        const cones = chevrons(plan, plan.edges[0]!, { chevronEveryMm: 8 });
        const ups = cones.filter(c =>
            new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion).y > 0).length;
        expect(ups).toBeGreaterThan(0);
        expect(cones.length - ups).toBe(ups);
    });

    it('sets them in from the ends so they are not buried in a wall', () => {
        const plan = shaftPlan();
        plan.edges[0]!.flow = 'forward';
        for (const cone of chevrons(plan, plan.edges[0]!, { chevronEveryMm: 8 })) {
            expect(cone.position.y).toBeLessThan(64 - 2);
            expect(cone.position.y).toBeGreaterThan(20 + 2);
        }
    });

    it('has none on a tunnel too short to fit one', () => {
        const plan: NestPlan = {
            nodes: [
                { id: 'a', kind: 'junction', x: 0, y: 0, z: 0, radiusMm: 4 },
                { id: 'b', kind: 'junction', x: 3, y: 0, z: 0, radiusMm: 4 },
            ],
            edges: [{ id: 'stub', from: 'a', to: 'b', radiusMm: 4, flow: 'forward' }],
        };
        expect(chevrons(plan, plan.edges[0]!, { chevronEveryMm: 8 })).toEqual([]);
    });
});

describe('node markers', () => {
    it('gives each kind its own shape and sits it where the node is', () => {
        const plan = demoNest();
        const kinds = plan.nodes.map(n => (nodeMarker(n) as THREE.Mesh).geometry.type);
        expect(kinds).toContain('TorusGeometry');       // the entrance
        expect(kinds).toContain('OctahedronGeometry');  // the junction
        expect(kinds).toContain('SphereGeometry');      // the chambers
        for (const n of plan.nodes) {
            expect(nodeMarker(n).position.toArray()).toEqual([n.x, n.y, n.z]);
        }
    });

    it('sizes a chamber to the room it will be', () => {
        const room = demoNest().nodes.find(n => n.id === 'royal')!;
        const geo = (nodeMarker(room) as THREE.Mesh).geometry as THREE.SphereGeometry;
        expect(geo.parameters.radius).toBe(room.radiusMm);
    });
});

describe('the whole plan drawn', () => {
    it('draws through the soil, which is the point of the sonar view', () => {
        const view = buildNestView(demoNest());
        view.root.traverse(o => {
            const m = (o as THREE.Mesh).material as THREE.Material | undefined;
            if (m && 'depthTest' in m) expect(m.depthTest).toBe(false);
        });
        view.dispose();
    });

    it('knows which object belongs to which node and tunnel, so a tap can hit it', () => {
        const plan = demoNest();
        const view = buildNestView(plan);
        expect(new Set(view.nodeAt.values())).toEqual(new Set(plan.nodes.map(n => n.id)));
        expect(new Set(view.edgeAt.values())).toEqual(new Set(plan.edges.map(e => e.id)));
        view.dispose();
    });

    it('draws nothing for a plan with nothing in it', () => {
        const view = buildNestView(emptyPlan());
        expect(view.root.children).toHaveLength(0);
        view.dispose();
    });

    it('lets go of everything it made', () => {
        const view = buildNestView(demoNest());
        expect(view.root.children.length).toBeGreaterThan(0);
        view.dispose();
        expect(view.root.children).toHaveLength(0);
    });
});
