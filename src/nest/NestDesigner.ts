/**
 * THE NEST DESIGNER: draw the nest, then dig it.
 *
 * You place mouths, junctions and chambers, drag tunnels between them, and the
 * soil is cut to match. The plan is the same `NestPlan` everything else reads —
 * the carver, the chevrons, the routing — so what you draw is what gets dug and
 * what the colony later walks along. There is no second description anywhere.
 *
 * Decisions that shape the whole thing:
 *
 * The preview is FREE and the build is EXPLICIT. Re-cutting the block means
 * evaluating a field over two and a half million cells and remeshing all of it,
 * which is fine once and hopeless per finger-move. So dragging updates the
 * drawing only — the tunnels and chambers you can see straight through the
 * ground — and DIG IT is when soil actually moves.
 *
 * The camera FLIES; it does not orbit. It began as a turntable around the
 * block's centre, and the report was that it felt like driving a car in the
 * air: every stick input was secretly about a pivot point the player never
 * chose and could not see. Now the joystick moves the camera through space
 * along its own look direction — aim down and push forward to descend, which
 * makes pitch the altitude control without any dedicated altitude control
 * existing — and a drag on the right half of the screen turns the view. The
 * same layout as playing her, on purpose: it is the control scheme the thumb
 * already knows from thirty seconds ago.
 *
 * Nothing here mutates a plan. Every edit goes through `nestEdit`, which returns
 * a new one, which is what makes undo a stack of plans rather than a stack of
 * inverse operations that have to be right for cases nobody thought of.
 */

import * as THREE from 'three';

import {
    addNode, cycleFlow, deleteEdge, deleteNode, linkNodes, moveNode,
    PlanHistory, RADIUS_LIMITS, resizeEdge, resizeNode, TUNNEL_LIMITS,
} from './nestEdit';
import { findNode, type NestPlan, type NodeKind } from './nestPlan';
import { buildNestView, NEST_COLOURS, type NestView } from './nestView';

export interface DesignerWorld {
    /** How many millimetres to a world unit. */
    mmPerUnit: number;
    /** Where the plan's origin sits in world space. */
    origin: THREE.Vector3;
    /** How big the block is, in millimetres per axis — the box a node may live in. */
    blockMm: { x: number; y: number; z: number };
    /**
     * The terrain's surface height (plan-local mm) under a plan-local XZ.
     * When provided, entrance nodes SNAP to it: placed above or below the
     * ground, a mouth finds the surface either way — a nest entrance
     * anywhere else is either floating or buried. The GRND chip toggles it.
     */
    groundMm?: (xMm: number, zMm: number) => number;
    /**
     * Where the ANT stands, plan-local mm. The founding piece of a nest —
     * no selection, nothing to hang off — lands HERE, not somewhere ahead
     * of a camera: the queen digs where the queen is.
     */
    antMm?: { x: number; y: number; z: number };
}

export interface DesignerHooks {
    /** Cut the block to this plan and keep it. */
    build(plan: NestPlan): void;
    /** Leave the designer and go back to walking her about. */
    close(): void;
}

/**
 * How fast the camera flies at full stick, in world units per second, per unit
 * of the block's longest span. Crossing the block takes about 1.4 seconds
 * whatever size it is — a fixed speed tuned on the 64 mm cube would feel like
 * wading through a 256 mm one.
 */
const FLY_SPAN_RATE = 0.7;
const FLY_SPEED_MIN = 9;

/** Radians of view turn per pixel of look drag. */
const LOOK_RATE = 0.005;

/** How far the stick knob travels, in pixels — full deflection is full speed. */
const STICK_PX = 48;

/** How much of the stick's centre is dead, as a fraction of its radius. */
const STICK_DEAD = 0.12;

/** How far a finger may travel and still count as a tap, in pixels. */
const TAP_SLOP = 9;

/**
 * How close a tap must land to a piece to select it, in SCREEN pixels.
 *
 * Selection used to raycast against the drawn markers, and the report was taps
 * that "don't always recognize". Of course they didn't: a junction is an
 * octahedron a couple of millimetres across, which at a normal viewing
 * distance is a target a few pixels wide — a dart board, not a button. Picking
 * now projects every node to the screen and takes the nearest within a
 * finger's radius, so the target is this many pixels however small or far away
 * the piece itself is drawn.
 */
const PICK_PX = 36;

/**
 * How far below the selected piece a new one lands, in millimetres.
 *
 * Twelve is a bit more than the widest default bore, so consecutive pieces
 * make a tunnel with a visible run between them rather than two chambers
 * overlapping into one blob — which is what a smaller drop looks like and
 * reads as PLACE having done nothing.
 */
const DROP_MM = 12;

/** One press of the move pad, in millimetres. */
const STEP_MM = 2;

/** The grid SNAP rounds to, in millimetres. */
const SNAP_MM = 2;

const UP = new THREE.Vector3(0, 1, 0);

/** What one finger is currently doing. */
interface Finger {
    /** Where it went down, for the stick's origin and the tap test. */
    sx: number; sy: number;
    /** Where it is now. */
    x: number; y: number;
    travelled: number;
    role: 'stick' | 'look' | 'drag';
}

export class NestDesigner {
    private plan: NestPlan;

    private readonly history = new PlanHistory();

    private view: NestView | null = null;

    private readonly group = new THREE.Group();

    private readonly highlight: THREE.Mesh;

    /** What is selected: a node id, an edge id, or nothing. */
    private picked: { kind: 'node' | 'edge'; id: string } | null = null;

    /** Set while LINK is armed and waiting for the second node. */
    private linkingFrom: string | null = null;

    /** What ADD will place next. */
    private placing: NodeKind = 'junction';

    private open = false;

    private dirty = false;

    /** Entrances follow the terrain while this is on (the GRND chip). */
    private groundSnap = true;

    // The camera: a free point in space and a direction it looks.
    private readonly eye = new THREE.Vector3();

    private lookYaw = 0;

    private lookPitch = 0;

    /** Stick deflection, -1..1 each axis. x strafes, y flies along the look. */
    private readonly fly = { x: 0, y: 0 };

    private lastTick = 0;

    private readonly pointers = new Map<number, Finger>();

    private readonly raycaster = new THREE.Raycaster();

    private readonly panel = document.createElement('div');

    private readonly hint = document.createElement('div');

    private readonly stick = document.createElement('div');

    private readonly stickKnob = document.createElement('div');

    private readonly buttons = new Map<string, HTMLButtonElement>();

    private readonly help = document.createElement('div');

    /** Whether the instructions have been dismissed this session. */
    private helpSeen = false;

    constructor(
        private readonly scene: THREE.Scene,
        private readonly camera: THREE.PerspectiveCamera,
        private readonly canvas: HTMLElement,
        private readonly hud: HTMLElement,
        private readonly world: DesignerWorld,
        private readonly hooks: DesignerHooks,
        startFrom: NestPlan,
    ) {
        this.plan = startFrom;
        this.group.scale.setScalar(1 / world.mmPerUnit);
        this.group.position.copy(world.origin);
        this.group.visible = false;
        this.scene.add(this.group);

        /*
         * The selection halo. A ring rather than a recolour, because the four
         * node kinds are already told apart by colour and a fifth "selected"
         * colour would be one more thing to learn — and on a phone, in sun, a
         * hue change is the first thing to become invisible.
         */
        this.highlight = new THREE.Mesh(
            new THREE.TorusGeometry(1, 0.09, 8, 32),
            new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false,
            }),
        );
        this.highlight.renderOrder = 6;
        this.highlight.visible = false;
        this.group.add(this.highlight);

        /*
         * Start where the old turntable used to sit — above and off a corner,
         * looking down at the block — so the first frame of the fly camera is
         * the framing people already know, not a new one to orient in.
         */
        const mmU = world.mmPerUnit;
        const centre = new THREE.Vector3(
            world.origin.x + world.blockMm.x / 2 / mmU,
            world.origin.y + world.blockMm.y / 2 / mmU,
            world.origin.z + world.blockMm.z / 2 / mmU,
        );
        const out = new THREE.Vector3(
            Math.cos(0.75) * Math.sin(0.6), Math.sin(0.75), Math.cos(0.75) * Math.cos(0.6),
        );
        // 1.56 spans back is the framing the 64 cube was tuned to (20 units on
        // a 12.8-unit block); keeping the RATIO keeps it on every size.
        this.eye.copy(centre).addScaledVector(out, 1.56 * this.longestSpan());
        this.lookYaw = Math.atan2(-out.x, -out.z);
        this.lookPitch = Math.asin(-out.y);

        this.buildPanel();
        this.buildStick();
        this.buildHelp();
        this.redraw();
    }

    get isOpen(): boolean { return this.open; }

    /** Whether anything has changed since the last BUILD. */
    get hasUnbuilt(): boolean { return this.dirty; }

    show(plan: NestPlan): void {
        this.plan = plan;
        this.open = true;
        this.group.visible = true;
        this.panel.style.display = '';
        this.hint.style.display = '';
        this.lastTick = 0;
        /*
         * Start on the entrance, selected. It is the only piece a new nest has
         * and everything hangs off it, so selecting it is the difference
         * between PLACE being the obvious first move and PLACE being a button
         * that drops a loose node somewhere off screen.
         */
        const mouth = this.plan.nodes.find(n => n.kind === 'entrance') ?? this.plan.nodes[0];
        if (mouth && !this.picked) this.picked = { kind: 'node', id: mouth.id };
        /* A nest with no entrance yet (the founding dig) presets PLACE to
         * the MOUTH — the piece every nest must start with. */
        if (!this.plan.nodes.some(n => n.kind === 'entrance')) this.placing = 'entrance';
        // Instructions on the first open only. Shown every time it would be a
        // panel to dismiss before you could do anything.
        if (!this.helpSeen) this.showHelp(true);
        this.redraw();
        this.refreshPanel();
    }

    hide(): void {
        this.open = false;
        this.help.style.display = 'none';
        this.group.visible = false;
        this.panel.style.display = 'none';
        this.hint.style.display = 'none';
        this.pointers.clear();
        this.dropStick();
    }

    dispose(): void {
        this.view?.dispose();
        this.highlight.geometry.dispose();
        (this.highlight.material as THREE.Material).dispose();
        this.scene.remove(this.group);
        this.panel.remove();
        this.hint.remove();
        this.stick.remove();
        this.help.remove();
    }

    private longestSpan(): number {
        const b = this.world.blockMm;
        return Math.max(b.x, b.y, b.z) / this.world.mmPerUnit;
    }

    private flySpeed(): number {
        return Math.max(FLY_SPEED_MIN, FLY_SPAN_RATE * this.longestSpan());
    }

    /** The direction the camera looks, unit length. */
    private lookVector(): THREE.Vector3 {
        const cp = Math.cos(this.lookPitch);
        return new THREE.Vector3(
            cp * Math.sin(this.lookYaw), Math.sin(this.lookPitch), cp * Math.cos(this.lookYaw),
        );
    }

    /** Drive the camera. The scene hands the frame over while this is open. */
    update(): void {
        if (!this.open) return;
        const now = performance.now();
        const dt = this.lastTick ? Math.min(0.05, (now - this.lastTick) / 1000) : 1 / 60;
        this.lastTick = now;

        /*
         * The horizon is LEVEL in here, always.
         *
         * `lookAt` does not choose an up — it keeps whatever `camera.up`
         * already holds, and while playing her the follow rig eases that
         * vector onto the SURFACE SHE IS STANDING ON, which on the flank of
         * the anthill is nowhere near vertical. Opening the designer after
         * she has been on a slope therefore inherited a tilted up, and every
         * turn of the view read as the camera ROLLING. Reported as exactly
         * that. One assignment, every frame, because the rig will tilt it
         * again the moment the designer closes and reopens.
         */
        this.camera.up.set(0, 1, 0);
        const look = this.lookVector();
        if (this.fly.x !== 0 || this.fly.y !== 0) {
            /*
             * Forward is the LOOK direction, vertical component included —
             * that is what makes pitch the altitude control. Strafe is the
             * camera's screen-right, which is horizontal by construction
             * (cross of the look with world up), so sidestepping never
             * changes height by an amount nobody asked for.
             */
            const right = new THREE.Vector3().crossVectors(look, UP).normalize();
            const speed = this.flySpeed();
            this.eye.addScaledVector(look, this.fly.y * speed * dt);
            this.eye.addScaledVector(right, this.fly.x * speed * dt);
            this.boundEye();
        }
        this.camera.position.copy(this.eye);
        this.camera.lookAt(
            this.eye.x + look.x, this.eye.y + look.y, this.eye.z + look.z,
        );
    }

    /**
     * Keep the camera near the block.
     *
     * A free camera's failure mode is being lost in empty sky with no landmark
     * in any direction. The box is generous — well outside the soil — but it
     * exists, so flying away from the work always runs out before the block
     * has shrunk to a speck.
     */
    private boundEye(): void {
        const mmU = this.world.mmPerUnit;
        const o = this.world.origin;
        const b = this.world.blockMm;
        this.eye.x = THREE.MathUtils.clamp(this.eye.x, o.x - 8, o.x + b.x / mmU + 8);
        this.eye.y = THREE.MathUtils.clamp(this.eye.y, o.y - 3, o.y + b.y / mmU + 14);
        this.eye.z = THREE.MathUtils.clamp(this.eye.z, o.z - 3, o.z + b.z / mmU + 8);
    }

    // ---------------------------------------------------------------- gestures

    handlePointerDown(event: PointerEvent): void {
        /*
         * What a finger is FOR is decided when it lands, in this order:
         *
         *   on the selected node        -> dragging that node
         *   left half, no stick yet     -> the fly stick
         *   anywhere else               -> turning the view (two of these
         *                                  together become a pinch dolly)
         *
         * A drag starts on the SELECTED node and nowhere else. Dragging
         * whatever happens to be under the finger means every attempt to look
         * past a tunnel grabs it instead, and on a phone the tunnels cover
         * most of the screen. Tap to choose, then drag — two deliberate acts,
         * and the second cannot be an accident.
         */
        const hit = this.pick(event);
        let role: Finger['role'];
        if (hit && this.picked && hit.kind === 'node'
            && this.picked.kind === 'node' && hit.id === this.picked.id) {
            role = 'drag';
        } else if (this.stickId() === null && event.clientX < window.innerWidth * 0.5) {
            role = 'stick';
            this.showStick(event.clientX, event.clientY);
        } else {
            role = 'look';
        }
        this.pointers.set(event.pointerId, {
            sx: event.clientX, sy: event.clientY,
            x: event.clientX, y: event.clientY,
            travelled: 0, role,
        });
    }

    handlePointerMove(event: PointerEvent): void {
        const finger = this.pointers.get(event.pointerId);
        if (!finger) return;
        const dx = event.clientX - finger.x;
        const dy = event.clientY - finger.y;
        finger.x = event.clientX;
        finger.y = event.clientY;
        finger.travelled += Math.hypot(dx, dy);

        if (finger.role === 'drag' && this.picked?.kind === 'node') {
            this.dragNode(event);
            return;
        }
        if (finger.role === 'stick') {
            const ox = THREE.MathUtils.clamp(finger.x - finger.sx, -STICK_PX, STICK_PX);
            const oy = THREE.MathUtils.clamp(finger.y - finger.sy, -STICK_PX, STICK_PX);
            const dead = (v: number): number => (Math.abs(v) < STICK_DEAD ? 0 : v);
            this.fly.x = dead(ox / STICK_PX);
            // Pushing the stick UP is negative screen-y and means forward.
            this.fly.y = dead(-oy / STICK_PX);
            this.stickKnob.style.transform = `translate(${ox}px, ${oy}px)`;
            return;
        }
        /*
         * TWO fingers SLIDE the view — up, down, left, right in the screen's
         * own plane, never forward or back. Forward already belongs to the
         * joystick, and an offset that cannot creep toward or away from the
         * work is what makes it an offset rather than a second fly control.
         *
         * The world follows the fingers, map-style: drag both right and the
         * block goes right, which means the camera goes left. Scaled so the
         * soil under the fingers tracks them 1:1 — pixels are converted to
         * world units at the block's distance, not by a magic rate that would
         * feel dead up close and wild far away.
         *
         * Each finger carries half the motion, so two fingers moving together
         * add up to exactly one pan and a single finger twitching adds half.
         */
        if (this.lookCount() === 2) {
            const look = this.lookVector();
            const right = new THREE.Vector3().crossVectors(look, UP).normalize();
            const screenUp = new THREE.Vector3().crossVectors(right, look).normalize();
            const rect = this.canvas.getBoundingClientRect();
            const dist = Math.max(4, this.eye.distanceTo(this.blockCentre()));
            const perPx = (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / rect.height;
            this.eye.addScaledVector(right, -dx * 0.5 * perPx);
            this.eye.addScaledVector(screenUp, dy * 0.5 * perPx);
            this.boundEye();
            return;
        }
        this.lookYaw -= dx * LOOK_RATE;
        // Stopped just short of straight up and straight down, where the look
        // vector meets world up and the camera's frame becomes undefined.
        this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy * LOOK_RATE, -1.45, 1.45);
    }

    handlePointerUp(event: PointerEvent): void {
        const finger = this.pointers.get(event.pointerId);
        this.pointers.delete(event.pointerId);
        if (!finger) return;
        if (finger.role === 'stick') {
            this.fly.x = 0;
            this.fly.y = 0;
            this.dropStick();
        }
        if (finger.role === 'drag') {
            // The next drag is its own undo step, not a continuation of this one.
            this.coalescing = false;
        }
        // A tap is a press that went nowhere. Anything else was a gesture, and
        // must not also select something on the way up.
        if (finger.travelled <= TAP_SLOP && finger.role !== 'drag') this.tap(event);
    }

    private stickId(): number | null {
        for (const [id, finger] of this.pointers) if (finger.role === 'stick') return id;
        return null;
    }

    private lookCount(): number {
        let n = 0;
        for (const finger of this.pointers.values()) if (finger.role === 'look') n += 1;
        return n;
    }

    private blockCentre(): THREE.Vector3 {
        const mmU = this.world.mmPerUnit;
        return new THREE.Vector3(
            this.world.origin.x + this.world.blockMm.x / 2 / mmU,
            this.world.origin.y + this.world.blockMm.y / 2 / mmU,
            this.world.origin.z + this.world.blockMm.z / 2 / mmU,
        );
    }

    private showStick(x: number, y: number): void {
        this.stick.style.left = `${x}px`;
        this.stick.style.top = `${y}px`;
        this.stick.style.display = '';
        this.stickKnob.style.transform = 'translate(0px, 0px)';
    }

    private dropStick(): void {
        this.stick.style.display = 'none';
        this.fly.x = 0;
        this.fly.y = 0;
    }

    /**
     * Move the selected node in the horizontal plane it already sits in.
     *
     * Height is on its own buttons rather than folded into the drag. One
     * finger cannot say three numbers, and the usual trick — depth from how
     * far up the screen you are — makes every sideways move also change the
     * height by an amount nobody asked for or can predict.
     */
    private dragNode(event: PointerEvent): void {
        if (!this.picked) return;
        const node = findNode(this.plan, this.picked.id);
        if (!node) return;
        const plane = new THREE.Plane(
            new THREE.Vector3(0, 1, 0),
            -(this.world.origin.y + node.y / this.world.mmPerUnit),
        );
        const at = new THREE.Vector3();
        this.raycaster.setFromCamera(this.ndc(event), this.camera);
        if (!this.raycaster.ray.intersectPlane(plane, at)) return;
        const mm = this.world.mmPerUnit;
        const nx = this.inBlock((at.x - this.world.origin.x) * mm, 'x');
        const nz = this.inBlock((at.z - this.world.origin.z) * mm, 'z');
        this.edit(moveNode(this.plan, node.id, {
            x: nx,
            // A dragged MOUTH rides the terrain under the finger.
            y: this.groundedY(node.kind, nx, nz, node.y),
            z: nz,
        }), { coalesce: true });
    }

    private inBlock(v: number, axis: 'x' | 'y' | 'z'): number {
        return THREE.MathUtils.clamp(v, 0, this.world.blockMm[axis]);
    }

    /** An entrance's Y is the ground under its XZ — above or below, it
     *  finds the surface — unless the toggle is off or there is no terrain
     *  to ask (the block room's designer has none). */
    private groundedY(kind: string, x: number, z: number, fallbackY: number): number {
        if (kind !== 'entrance' || !this.groundSnap || !this.world.groundMm) return fallbackY;
        return this.inBlock(this.world.groundMm(x, z), 'y');
    }

    private ndc(event: PointerEvent): THREE.Vector2 {
        const rect = this.canvas.getBoundingClientRect();
        return new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
    }

    private pick(event: PointerEvent): { kind: 'node' | 'edge'; id: string } | null {
        if (!this.view) return null;
        /*
         * Nodes are picked in SCREEN space: project each one and take the
         * nearest within a finger's radius. Raycasting against the markers is
         * what made taps unreliable — a junction is drawn a couple of
         * millimetres wide, which from any distance is a few pixels, and a few
         * pixels is not a touch target. This also makes both ENDS of a tunnel
         * tappable by name, since the ends of a tunnel are nodes.
         */
        const rect = this.canvas.getBoundingClientRect();
        const mm = this.world.mmPerUnit;
        const at = new THREE.Vector3();
        let bestNode: string | null = null;
        let bestPx = PICK_PX;
        for (const node of this.plan.nodes) {
            at.set(
                this.world.origin.x + node.x / mm,
                this.world.origin.y + node.y / mm,
                this.world.origin.z + node.z / mm,
            ).project(this.camera);
            if (at.z > 1) continue;   // behind the camera
            const sx = (at.x * 0.5 + 0.5) * rect.width + rect.left;
            const sy = (-at.y * 0.5 + 0.5) * rect.height + rect.top;
            const px = Math.hypot(sx - event.clientX, sy - event.clientY);
            if (px < bestPx) { bestPx = px; bestNode = node.id; }
        }
        if (bestNode) return { kind: 'node', id: bestNode };

        // Tunnels are big enough to raycast honestly.
        this.raycaster.setFromCamera(this.ndc(event), this.camera);
        const hits = this.raycaster.intersectObjects(this.view.root.children, false);
        for (const hit of hits) {
            const edge = this.view.edgeAt.get(hit.object);
            if (edge) return { kind: 'edge', id: edge };
        }
        return null;
    }

    private tap(event: PointerEvent): void {
        const hit = this.pick(event);
        if (this.linkingFrom && hit?.kind === 'node') {
            this.edit(linkNodes(this.plan, this.linkingFrom, hit.id));
            this.linkingFrom = null;
            this.picked = hit;
            this.refreshPanel();
            return;
        }
        this.linkingFrom = null;
        this.picked = hit;
        this.refreshPanel();
        this.placeHighlight();
    }

    // ------------------------------------------------------------------- edits

    /**
     * Take a new plan, remembering where we were.
     *
     * `coalesce` is for a drag: a finger moving across the screen produces a
     * plan a frame, and recording each would make undo mean "go back one
     * sixtieth of a second" — forty presses to get back to where the node
     * started. One entry per gesture is what a person means by a step.
     */
    private edit(next: NestPlan, opts: { coalesce?: boolean } = {}): void {
        if (!opts.coalesce || !this.coalescing) {
            this.history.remember(this.plan);
        }
        this.coalescing = opts.coalesce === true;
        this.plan = next;
        this.dirty = true;
        this.redraw();
        this.refreshPanel();
    }

    private coalescing = false;

    private redraw(): void {
        this.view?.dispose();
        if (this.view) this.group.remove(this.view.root);
        this.view = buildNestView(this.plan);
        this.group.add(this.view.root);
        this.placeHighlight();
    }

    private placeHighlight(): void {
        const node = this.picked?.kind === 'node' ? findNode(this.plan, this.picked.id) : null;
        this.highlight.visible = node !== null;
        if (!node) return;
        const ring = Math.max(node.radiusMm * 1.35, 3);
        this.highlight.scale.setScalar(ring);
        this.highlight.position.set(node.x, node.y, node.z);
        // Laid flat, so it reads as a footprint on the ground rather than a
        // hoop the node happens to be inside.
        this.highlight.rotation.set(Math.PI / 2, 0, 0);
    }

    private nudge(step: number): void {
        if (!this.picked) return;
        if (this.picked.kind === 'node') {
            const node = findNode(this.plan, this.picked.id);
            if (!node) return;
            const limit = RADIUS_LIMITS[node.kind];
            this.edit(resizeNode(this.plan, node.id,
                THREE.MathUtils.clamp(node.radiusMm + step, limit.min, limit.max)));
            return;
        }
        const edge = this.plan.edges.find(e => e.id === this.picked!.id);
        if (!edge) return;
        this.edit(resizeEdge(this.plan, edge.id,
            THREE.MathUtils.clamp(edge.radiusMm + step, TUNNEL_LIMITS.min, TUNNEL_LIMITS.max)));
    }

    /**
     * Step the selected node through world space from the move pad.
     *
     * `sx` is screens-right, `sz` is screens-away, `sy` is up — but the
     * horizontal two are snapped to whichever WORLD axis the camera most
     * faces, so a press moves the piece in a clean world direction that
     * happens to agree with the thumb: "away" is away from you, and it is
     * also exactly +x or +z, never a diagonal that drifts off grid.
     *
     * This is the pad the drag cannot replace: a drag is quick and
     * approximate, the pad is one axis at a time in even steps — and it
     * covers all six directions where the old buttons covered only up and
     * down.
     */
    private step(sx: number, sy: number, sz: number): void {
        if (this.picked?.kind !== 'node') return;
        const node = findNode(this.plan, this.picked.id);
        if (!node) return;
        const fx = Math.sin(this.lookYaw);
        const fz = Math.cos(this.lookYaw);
        const forward = Math.abs(fx) > Math.abs(fz)
            ? { x: Math.sign(fx), z: 0 } : { x: 0, z: Math.sign(fz) };
        // Screen-right for that forward, from the same cross product the
        // camera itself uses: right = look x up.
        const right = { x: -forward.z, z: forward.x };
        const grounded = node.kind === 'entrance' && this.groundSnap && !!this.world.groundMm;
        if (grounded && sy !== 0) {
            // Height is not yours while the mouth follows the ground.
            this.hint.textContent = 'GRND is on — the mouth follows the terrain. Tap GRND to place its height by hand.';
            return;
        }
        const nx = this.inBlock(node.x + (forward.x * sz + right.x * sx) * STEP_MM, 'x');
        const nz = this.inBlock(node.z + (forward.z * sz + right.z * sx) * STEP_MM, 'z');
        this.edit(moveNode(this.plan, node.id, {
            x: nx,
            y: this.groundedY(node.kind, nx, nz, this.inBlock(node.y + sy * STEP_MM, 'y')),
            z: nz,
        }));
    }

    /** Put the selected node on the grid, so pieces line up on purpose. */
    private snap(): void {
        if (this.picked?.kind !== 'node') return;
        const node = findNode(this.plan, this.picked.id);
        if (!node) return;
        const grid = (v: number): number => Math.round(v / SNAP_MM) * SNAP_MM;
        const gx = this.inBlock(grid(node.x), 'x');
        const gz = this.inBlock(grid(node.z), 'z');
        this.edit(moveNode(this.plan, node.id, {
            x: gx,
            y: this.groundedY(node.kind, gx, gz, this.inBlock(grid(node.y), 'y')),
            z: gz,
        }));
    }

    private place(): void {
        /*
         * A NEW PIECE HANGS OFF THE SELECTED ONE, AND JOINS TO IT.
         *
         * The first version dropped a loose node at whatever the camera was
         * looking at, and left joining it as a separate LINK press. Two things
         * were wrong with that. A nest is a chain — you are almost always
         * adding to the end of what you just made — so the common case cost
         * three actions instead of one. And a loose unconnected node carves
         * nothing, so pressing PLACE on a fresh Station appeared to do nothing
         * at all: the reason for not knowing what to do.
         *
         * With nothing selected it falls back to the entrance rather than to a
         * loose drop — the Station always exists, and hanging off it keeps the
         * plan one connected thing whatever was or was not tapped first.
         */
        const from = (this.picked?.kind === 'node' ? findNode(this.plan, this.picked.id) : null)
            ?? this.plan.nodes.find(n => n.kind === 'entrance')
            ?? null;
        let at: { x: number; y: number; z: number };
        if (from) {
            at = { x: from.x, y: this.inBlock(from.y - DROP_MM, 'y'), z: from.z };
        } else if (this.world.antMm) {
            // No selection and no entrance: the FOUNDING piece. It lands at
            // the ant herself — the queen digs where the queen is — and the
            // ground snap then puts a mouth's height on the surface there.
            at = {
                x: this.inBlock(this.world.antMm.x, 'x'),
                y: this.inBlock(this.world.antMm.y, 'y'),
                z: this.inBlock(this.world.antMm.z, 'z'),
            };
        } else {
            // No ant to stand in for us (the block room): drop it a little
            // way ahead of the camera, somewhere the player is looking.
            const mm = this.world.mmPerUnit;
            const ahead = this.eye.clone().addScaledVector(this.lookVector(), 10);
            at = {
                x: this.inBlock((ahead.x - this.world.origin.x) * mm, 'x'),
                y: this.inBlock((ahead.y - this.world.origin.y) * mm, 'y'),
                z: this.inBlock((ahead.z - this.world.origin.z) * mm, 'z'),
            };
        }
        at.y = this.groundedY(this.placing, at.x, at.z, at.y);
        const made = addNode(this.plan, this.placing, at);
        this.edit(from ? linkNodes(made.plan, from.id, made.id) : made.plan);
        this.picked = { kind: 'node', id: made.id };
        this.placeHighlight();
        this.refreshPanel();
    }

    // -------------------------------------------------------------------- HUD

    private buildPanel(): void {
        this.hint.className = 'nest-designer-hint';
        this.hint.style.display = 'none';
        this.hud.appendChild(this.hint);

        this.panel.className = 'nest-designer';
        this.panel.style.display = 'none';

        const kinds = document.createElement('div');
        kinds.className = 'nest-designer-row';
        const kindList: Array<[NodeKind, string]> = [
            ['entrance', 'MOUTH'], ['junction', 'NODE'], ['chamber', 'ROOM'],
        ];
        for (const [kind, label] of kindList) {
            const button = this.chip(label, () => {
                this.placing = kind;
                this.refreshPanel();
            });
            this.buttons.set(`kind:${kind}`, button);
            kinds.appendChild(button);
        }
        kinds.appendChild(this.chip('+ PLACE', () => this.place(), 'is-go'));
        this.panel.appendChild(kinds);

        const acts = document.createElement('div');
        acts.className = 'nest-designer-row';
        acts.appendChild(this.named('link', this.chip('LINK', () => {
            if (this.picked?.kind !== 'node') return;
            this.linkingFrom = this.linkingFrom ? null : this.picked.id;
            this.refreshPanel();
        })));
        acts.appendChild(this.named('flow', this.chip('FLOW', () => {
            if (this.picked?.kind === 'edge') this.edit(cycleFlow(this.plan, this.picked.id));
        })));
        acts.appendChild(this.chip('−', () => this.nudge(-1)));
        acts.appendChild(this.chip('+', () => this.nudge(1)));
        acts.appendChild(this.chip('DEL', () => {
            if (!this.picked) return;
            this.edit(this.picked.kind === 'node'
                ? deleteNode(this.plan, this.picked.id)
                : deleteEdge(this.plan, this.picked.id));
            this.picked = null;
            this.placeHighlight();
        }, 'is-warn'));
        this.panel.appendChild(acts);

        /*
         * The move pad: all six world directions for the selected piece, where
         * there used to be an up/down pair and nothing else — reported as
         * exactly that. Arrows step horizontally (snapped to world axes, laid
         * out to agree with the camera), UP and DN are height, SNAP puts the
         * piece on the grid.
         */
        const pad = document.createElement('div');
        pad.className = 'nest-designer-row';
        pad.appendChild(this.chip('◀', () => this.step(-1, 0, 0)));
        pad.appendChild(this.chip('▶', () => this.step(1, 0, 0)));
        pad.appendChild(this.chip('▲', () => this.step(0, 0, 1)));
        pad.appendChild(this.chip('▼', () => this.step(0, 0, -1)));
        pad.appendChild(this.chip('UP', () => this.step(0, 1, 0)));
        pad.appendChild(this.chip('DN', () => this.step(0, -1, 0)));
        pad.appendChild(this.chip('SNAP', () => this.snap()));
        if (this.world.groundMm) {
            pad.appendChild(this.named('grnd', this.chip('GRND', () => {
                this.groundSnap = !this.groundSnap;
                this.refreshPanel();
            })));
        }
        this.panel.appendChild(pad);

        const done = document.createElement('div');
        done.className = 'nest-designer-row';
        done.appendChild(this.named('undo', this.chip('UNDO', () => {
            const back = this.history.undo(this.plan);
            if (!back) return;
            this.plan = back;
            this.dirty = true;
            this.picked = null;
            this.redraw();
            this.refreshPanel();
        })));
        done.appendChild(this.chip('DIG IT', () => {
            this.hooks.build(this.plan);
            this.dirty = false;
            this.refreshPanel();
        }, 'is-go'));
        done.appendChild(this.named('help', this.chip('?', () => this.showHelp(
            this.help.style.display === 'none',
        ))));
        done.appendChild(this.chip('DONE', () => this.hooks.close()));
        this.panel.appendChild(done);

        this.hud.appendChild(this.panel);
        this.refreshPanel();
    }

    private buildStick(): void {
        this.stick.className = 'nest-stick';
        this.stick.style.display = 'none';
        this.stickKnob.className = 'nest-stick-knob';
        this.stick.appendChild(this.stickKnob);
        this.hud.appendChild(this.stick);
    }

    /**
     * Short instructions, because the panel alone does not say what to do first.
     *
     * Six lines and no more. A designer that needs a manual has a control
     * problem, and the fix for most of this was making PLACE chain and the
     * camera fly rather than writing longer text — this is what is left over
     * once the flow is right.
     */
    private buildHelp(): void {
        this.help.className = 'nest-help';
        this.help.style.display = 'none';
        const lines = [
            ['🕹️', 'Fly with the <b>joystick</b> (left side). You move where you look — '
                + 'aim down and push forward to descend.'],
            ['👀', '<b>Drag the right side</b> to look around. <b>Two fingers</b> slide the view up, down and sideways.'],
            ['➕', '<b>PLACE</b> hangs a new piece under the selected one and joins it. '
                + 'Start from the <b>Station</b> and press it a few times.'],
            ['👆', '<b>Tap</b> a piece to select it. <b>Drag</b> moves it; <b>▲▼◀▶ UP DN</b> '
                + 'step it through the world; <b>− +</b> resize; <b>SNAP</b> puts it on the grid.'],
            ['🔗', '<b>LINK</b> joins two pieces. <b>FLOW</b> sets one-way arrows on a tunnel.'],
            ['⛏️', '<b>DIG IT</b> cuts the soil to your plan. <b>DONE</b> goes back to the ant.'],
        ];
        const title = document.createElement('div');
        title.className = 'nest-help-title';
        title.textContent = 'BUILD A NEST';
        this.help.appendChild(title);
        for (const [icon, text] of lines) {
            const row = document.createElement('div');
            row.className = 'nest-help-row';
            const badge = document.createElement('span');
            badge.textContent = icon!;
            row.appendChild(badge);
            const body = document.createElement('p');
            body.innerHTML = text!;
            row.appendChild(body);
            this.help.appendChild(row);
        }
        const go = document.createElement('button');
        go.className = 'nest-designer-chip is-go';
        go.textContent = 'GOT IT';
        go.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.showHelp(false);
        });
        this.help.appendChild(go);
        this.hud.appendChild(this.help);
    }

    private showHelp(on: boolean): void {
        this.help.style.display = on ? '' : 'none';
        this.panel.style.display = on ? 'none' : '';
        if (!on) this.helpSeen = true;
        this.buttons.get('help')?.classList.toggle('is-on', on);
    }

    private named(key: string, button: HTMLButtonElement): HTMLButtonElement {
        this.buttons.set(key, button);
        return button;
    }

    private chip(label: string, act: () => void, extra = ''): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = `nest-designer-chip ${extra}`.trim();
        button.textContent = label;
        button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            act();
        });
        return button;
    }

    private refreshPanel(): void {
        for (const kind of ['entrance', 'junction', 'chamber']) {
            this.buttons.get(`kind:${kind}`)?.classList.toggle('is-on', this.placing === kind);
        }
        this.buttons.get('link')?.classList.toggle('is-on', this.linkingFrom !== null);
        this.buttons.get('grnd')?.classList.toggle('is-on', this.groundSnap);
        this.buttons.get('undo')?.toggleAttribute('disabled', !this.history.canUndo);

        if (this.linkingFrom) {
            this.hint.textContent = 'tap another node to join it';
            return;
        }
        if (!this.picked) {
            this.hint.textContent = 'joystick flies · one finger looks · two fingers slide · tap to select';
            return;
        }
        if (this.picked.kind === 'node') {
            const node = findNode(this.plan, this.picked.id);
            this.hint.textContent = node
                ? `${node.id} · ${node.kind} · ${node.radiusMm.toFixed(0)} mm `
                    + `· ${node.y.toFixed(0)} mm up · drag or ▲▼◀▶ to move`
                : '';
            return;
        }
        const edge = this.plan.edges.find(e => e.id === this.picked!.id);
        const arrow = edge?.flow === 'both' ? '↔' : edge?.flow === 'forward' ? '→' : '←';
        this.hint.textContent = edge
            ? `${edge.id} · ${edge.radiusMm.toFixed(0)} mm · ${arrow} ${edge.flow}`
            : '';
    }

    /** The plan as it stands, built or not. */
    current(): NestPlan { return this.plan; }

    /** Select something without having to know where it is on screen. For probes. */
    selectForTest(kind: 'node' | 'edge', id: string): void {
        this.picked = { kind, id };
        this.placeHighlight();
        this.refreshPanel();
    }

    /** Join the selection to `toId`, the way tapping LINK and then a node does. */
    linkForTest(toId: string): void {
        if (this.picked?.kind !== 'node') return;
        this.edit(linkNodes(this.plan, this.picked.id, toId));
    }
}

export { NEST_COLOURS };
