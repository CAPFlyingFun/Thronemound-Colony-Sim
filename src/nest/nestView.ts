/**
 * THE NEST, drawn.
 *
 * The designer needs to see the plan on top of the soil that was carved from
 * it — the tunnels as tubes, the chambers as the rooms they will be, and
 * chevrons showing which way traffic may run. All of it is built from
 * `sampleEdge`, the same function the carver reads, so what is drawn is the
 * thing that was dug and not a second opinion about it.
 *
 * Built in the plan's millimetres. The caller scales and places the group,
 * which keeps the unit conversion in one place per consumer rather than
 * scattered through the geometry.
 */

import * as THREE from 'three';

import { sampleEdge, type EdgeSample, type NestEdge, type NestNode, type NestPlan } from './nestPlan';

export interface NestViewStyle {
    /** How far apart chevrons sit along a tunnel, in millimetres. */
    chevronEveryMm?: number;
    /** How long a chevron is, in millimetres. */
    chevronMm?: number;
    /** How finely tubes are built, in millimetres. */
    stepMm?: number;
    /** How many sides a tube has. Eight reads as round and costs nothing. */
    sides?: number;
}

const DEFAULTS: Required<NestViewStyle> = {
    chevronEveryMm: 8, chevronMm: 2.2, stepMm: 1, sides: 8,
};

/**
 * What each kind of thing looks like.
 *
 * Kept together and named, because the one job this layer has is telling four
 * things apart at a glance on a phone in sunlight.
 */
export const NEST_COLOURS = {
    tunnel: 0x4fc3f7,
    entrance: 0xffd54f,
    junction: 0x9ccc65,
    chamber: 0xff8a65,
    oneWay: 0xffd54f,
    twoWay: 0x81d4fa,
} as const;

/**
 * A frame that does not spin as it goes round a bend.
 *
 * Carrying the previous frame forward and only correcting it — a rotation-
 * minimising frame — rather than deriving one from world up at every sample.
 * Deriving it fresh flips through ninety degrees the moment a tunnel passes
 * vertical, which on a nest is the entrance shaft, i.e. always. That flip is
 * what turns a tube into a twisted ribbon.
 */
function frames(samples: readonly EdgeSample[]): { u: THREE.Vector3; v: THREE.Vector3 }[] {
    const out: { u: THREE.Vector3; v: THREE.Vector3 }[] = [];
    const first = new THREE.Vector3(samples[0]!.along.x, samples[0]!.along.y, samples[0]!.along.z);
    const seed = Math.abs(first.y) < 0.9
        ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    let u = new THREE.Vector3().crossVectors(first, seed).normalize();
    for (const s of samples) {
        const t = new THREE.Vector3(s.along.x, s.along.y, s.along.z).normalize();
        // Push the carried-over u back onto the plane at right angles to the
        // heading, which is the smallest correction that keeps it valid.
        u = u.clone().addScaledVector(t, -u.dot(t));
        if (u.lengthSq() < 1e-8) u = new THREE.Vector3().crossVectors(t, seed);
        u.normalize();
        out.push({ u: u.clone(), v: new THREE.Vector3().crossVectors(t, u).normalize() });
    }
    return out;
}

/** One tunnel as a tube that follows the bore's real width. */
export function tunnelGeometry(
    plan: NestPlan, edge: NestEdge, style: NestViewStyle = {},
): THREE.BufferGeometry | null {
    const { stepMm, sides } = { ...DEFAULTS, ...style };
    const samples = sampleEdge(plan, edge, stepMm);
    if (samples.length < 2) return null;
    const frame = frames(samples);
    const position: number[] = [];
    const normal: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < samples.length; i += 1) {
        const s = samples[i]!;
        const { u, v } = frame[i]!;
        for (let k = 0; k < sides; k += 1) {
            const a = (k / sides) * Math.PI * 2;
            const nx = u.x * Math.cos(a) + v.x * Math.sin(a);
            const ny = u.y * Math.cos(a) + v.y * Math.sin(a);
            const nz = u.z * Math.cos(a) + v.z * Math.sin(a);
            position.push(s.at.x + nx * s.radiusMm, s.at.y + ny * s.radiusMm, s.at.z + nz * s.radiusMm);
            normal.push(nx, ny, nz);
        }
    }
    for (let i = 0; i + 1 < samples.length; i += 1) {
        for (let k = 0; k < sides; k += 1) {
            const a = i * sides + k;
            const b = i * sides + ((k + 1) % sides);
            const c = a + sides;
            const d = b + sides;
            index.push(a, c, b, b, c, d);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geo.setIndex(index);
    return geo;
}

/**
 * Which way traffic may run, as cones along the tunnel.
 *
 * A two-way tunnel gets chevrons in BOTH directions rather than none. Drawing
 * nothing would make "traffic runs both ways" and "this edge has no flow set"
 * look identical, and the difference is the whole point of the arrows.
 */
export function chevrons(
    plan: NestPlan, edge: NestEdge, style: NestViewStyle = {},
): THREE.Object3D[] {
    const { chevronEveryMm, chevronMm, stepMm } = { ...DEFAULTS, ...style };
    const samples = sampleEdge(plan, edge, stepMm);
    if (samples.length < 2) return [];
    const total = samples[samples.length - 1]!.s;
    const ways: number[] = edge.flow === 'both' ? [1, -1] : [edge.flow === 'forward' ? 1 : -1];
    const colour = edge.flow === 'both' ? NEST_COLOURS.twoWay : NEST_COLOURS.oneWay;
    const out: THREE.Object3D[] = [];
    // Set in from both ends, so chevrons do not sit buried in a chamber wall.
    for (let s = chevronEveryMm; s < total - chevronEveryMm * 0.5; s += chevronEveryMm) {
        const at = samples.find(k => k.s >= s) ?? samples[samples.length - 1]!;
        for (const way of ways) {
            const cone = new THREE.Mesh(
                new THREE.ConeGeometry(chevronMm * 0.45, chevronMm, 6),
                new THREE.MeshBasicMaterial({
                    color: colour, transparent: true, opacity: 0.85, depthTest: false,
                }),
            );
            cone.position.set(at.at.x, at.at.y, at.at.z);
            // A cone points +Y in its own frame; aim that at the flow.
            const aim = new THREE.Vector3(at.along.x, at.along.y, at.along.z)
                .multiplyScalar(way).normalize();
            cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), aim);
            // Two-way arrows are drawn nose to nose rather than on top of each
            // other, or they read as one arrow with no direction at all.
            if (edge.flow === 'both') cone.position.addScaledVector(aim, chevronMm * 0.6);
            cone.renderOrder = 3;
            out.push(cone);
        }
    }
    return out;
}

/** A node as the thing it is: a mouth, a meeting, or a room. */
export function nodeMarker(node: NestNode): THREE.Object3D {
    if (node.kind === 'chamber') {
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(node.radiusMm, 20, 14),
            new THREE.MeshBasicMaterial({
                color: NEST_COLOURS.chamber, wireframe: true,
                transparent: true, opacity: 0.5, depthTest: false,
            }),
        );
        mesh.position.set(node.x, node.y, node.z);
        mesh.renderOrder = 2;
        return mesh;
    }
    if (node.kind === 'entrance') {
        // A ring lying in the surface, which is what a mouth looks like from
        // above and reads at any camera angle.
        const mesh = new THREE.Mesh(
            new THREE.TorusGeometry(node.radiusMm, node.radiusMm * 0.12, 8, 28),
            new THREE.MeshBasicMaterial({
                color: NEST_COLOURS.entrance, transparent: true, opacity: 0.9, depthTest: false,
            }),
        );
        mesh.position.set(node.x, node.y, node.z);
        mesh.rotation.x = Math.PI / 2;
        mesh.renderOrder = 4;
        return mesh;
    }
    const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(Math.max(node.radiusMm * 0.6, 1.5)),
        new THREE.MeshBasicMaterial({
            color: NEST_COLOURS.junction, transparent: true, opacity: 0.85, depthTest: false,
        }),
    );
    mesh.position.set(node.x, node.y, node.z);
    mesh.renderOrder = 3;
    return mesh;
}

export interface NestView {
    root: THREE.Group;
    /** Which object belongs to which node, so a tap can find what it hit. */
    nodeAt: Map<THREE.Object3D, string>;
    /** Which object belongs to which tunnel. */
    edgeAt: Map<THREE.Object3D, string>;
    dispose(): void;
}

/**
 * The whole plan as one group, in millimetres.
 *
 * Everything is drawn with `depthTest: false` on purpose. The point of the
 * designer view is seeing the nest THROUGH the soil — the sonar look — so it
 * has to survive being behind sixty millimetres of dirt. Depth-sorting it
 * against the terrain would hide exactly the thing it exists to show.
 */
export function buildNestView(plan: NestPlan, style: NestViewStyle = {}): NestView {
    const root = new THREE.Group();
    const nodeAt = new Map<THREE.Object3D, string>();
    const edgeAt = new Map<THREE.Object3D, string>();
    const owned: { dispose(): void }[] = [];

    for (const edge of plan.edges) {
        const geo = tunnelGeometry(plan, edge, style);
        if (geo) {
            const mat = new THREE.MeshBasicMaterial({
                color: NEST_COLOURS.tunnel, transparent: true, opacity: 0.32,
                depthTest: false, side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.renderOrder = 1;
            root.add(mesh);
            edgeAt.set(mesh, edge.id);
            owned.push(geo, mat);
        }
        for (const chevron of chevrons(plan, edge, style)) {
            root.add(chevron);
            edgeAt.set(chevron, edge.id);
            const m = chevron as THREE.Mesh;
            owned.push(m.geometry, m.material as THREE.Material);
        }
    }
    for (const node of plan.nodes) {
        const marker = nodeMarker(node);
        root.add(marker);
        nodeAt.set(marker, node.id);
        const m = marker as THREE.Mesh;
        owned.push(m.geometry, m.material as THREE.Material);
    }

    return {
        root,
        nodeAt,
        edgeAt,
        dispose() {
            for (const thing of owned) thing.dispose();
            root.clear();
        },
    };
}
