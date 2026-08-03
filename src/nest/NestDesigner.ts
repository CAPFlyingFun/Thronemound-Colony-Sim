/**
 * THE NEST DESIGNER: draw the nest, then dig it.
 *
 * You place mouths, junctions and chambers, drag tunnels between them, and the
 * soil is cut to match. The plan is the same `NestPlan` everything else reads —
 * the carver, the chevrons, the routing — so what you draw is what gets dug and
 * what the colony later walks along. There is no second description anywhere.
 *
 * Two decisions shape the whole thing.
 *
 * The preview is FREE and the build is EXPLICIT. Re-cutting the block means
 * evaluating a field over two and a half million cells and remeshing all of it,
 * which is fine once and hopeless per finger-move. So dragging updates the
 * drawing only — the tunnels and chambers you can see straight through the
 * ground — and BUILD is when soil actually moves. That is also just a better
 * way round: you lay out a whole nest and commit it, rather than watching the
 * terrain thrash while you decide.
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
    /** How big the block is, in millimetres — the box a node may live in. */
    blockMm: number;
}

export interface DesignerHooks {
    /** Cut the block to this plan and keep it. */
    build(plan: NestPlan): void;
    /** Leave the designer and go back to walking her about. */
    close(): void;
}

/** How far the camera may sit from what it is looking at, in world units. */
const RANGE = { min: 4, max: 90 };

const ORBIT_RATE = 0.006;
const PINCH_RATE = 0.9;
/** How far a finger may travel and still count as a tap, in pixels. */
const TAP_SLOP = 9;

/**
 * How far below the selected piece a new one lands, in millimetres.
 *
 * Twelve is a bit more than the widest default bore, so consecutive pieces
 * make a tunnel with a visible run between them rather than two chambers
 * overlapping into one blob — which is what a smaller drop looks like and
 * reads as PLACE having done nothing.
 */
const DROP_MM = 12;

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

    // The camera, as a turntable: where it looks, and where it sits relative.
    private readonly focus = new THREE.Vector3();

    private yaw = 0.6;

    private pitch = 0.75;

    /*
     * Close enough that the block fills the frame. Thirty-four put a
     * sixty-four-millimetre block — under thirteen world units across — in the
     * middle third of the screen with sky all round it, which is a lot of
     * nothing to look at on a phone.
     */
    private range = 20;

    private readonly pointers = new Map<number, { x: number; y: number }>();

    private gesture: 'none' | 'orbit' | 'pinch' | 'drag' = 'none';

    private travelled = 0;

    private pinchGap = 0;

    private readonly raycaster = new THREE.Raycaster();

    private readonly panel = document.createElement('div');

    private readonly hint = document.createElement('div');

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

        this.focus.set(
            world.origin.x + (world.blockMm / 2) / world.mmPerUnit,
            world.origin.y + (world.blockMm / 2) / world.mmPerUnit,
            world.origin.z + (world.blockMm / 2) / world.mmPerUnit,
        );

        this.buildPanel();
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
        /*
         * Start on the entrance, selected. It is the only piece a new nest has
         * and everything hangs off it, so selecting it is the difference
         * between PLACE being the obvious first move and PLACE being a button
         * that drops a loose node somewhere off screen.
         */
        const mouth = this.plan.nodes.find(n => n.kind === 'entrance') ?? this.plan.nodes[0];
        if (mouth && !this.picked) this.picked = { kind: 'node', id: mouth.id };
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
        this.gesture = 'none';
    }

    dispose(): void {
        this.view?.dispose();
        this.highlight.geometry.dispose();
        (this.highlight.material as THREE.Material).dispose();
        this.scene.remove(this.group);
        this.panel.remove();
        this.hint.remove();
        this.help.remove();
    }

    /** Drive the camera. The scene hands the frame over while this is open. */
    update(): void {
        if (!this.open) return;
        const cp = Math.cos(this.pitch);
        this.camera.position.set(
            this.focus.x + this.range * cp * Math.sin(this.yaw),
            this.focus.y + this.range * Math.sin(this.pitch),
            this.focus.z + this.range * cp * Math.cos(this.yaw),
        );
        this.camera.lookAt(this.focus);
    }

    // ---------------------------------------------------------------- gestures

    handlePointerDown(event: PointerEvent): void {
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.travelled = 0;
        if (this.pointers.size === 2) {
            this.gesture = 'pinch';
            this.pinchGap = this.spread();
            return;
        }
        /*
         * A drag starts on the SELECTED node and nowhere else.
         *
         * Dragging whatever happens to be under the finger means every attempt
         * to orbit past a tunnel grabs it instead, and on a phone the tunnels
         * cover most of the screen. Tap to choose, then drag — two deliberate
         * acts, and the second cannot be an accident.
         */
        const hit = this.pick(event);
        this.gesture = (hit && this.picked && hit.kind === 'node'
            && hit.id === this.picked.id && this.picked.kind === 'node') ? 'drag' : 'orbit';
    }

    handlePointerMove(event: PointerEvent): void {
        const was = this.pointers.get(event.pointerId);
        if (!was) return;
        const dx = event.clientX - was.x;
        const dy = event.clientY - was.y;
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.travelled += Math.hypot(dx, dy);

        if (this.gesture === 'pinch') {
            const gap = this.spread();
            if (this.pinchGap > 1 && gap > 1) {
                this.range = THREE.MathUtils.clamp(
                    this.range * (1 + (this.pinchGap - gap) / this.pinchGap * PINCH_RATE),
                    RANGE.min, RANGE.max,
                );
            }
            this.pinchGap = gap;
            return;
        }
        if (this.gesture === 'drag' && this.picked?.kind === 'node') {
            this.dragNode(event);
            return;
        }
        this.yaw -= dx * ORBIT_RATE;
        // Stopped short of straight up and straight down, where a turntable
        // camera's own frame becomes undefined and the view snaps sideways.
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * ORBIT_RATE, -1.45, 1.45);
    }

    handlePointerUp(event: PointerEvent): void {
        const wasDragging = this.gesture === 'drag';
        this.pointers.delete(event.pointerId);
        if (this.pointers.size < 2 && this.gesture === 'pinch') this.gesture = 'none';
        if (this.pointers.size > 0) return;
        // A tap is a press that went nowhere. Anything else was a gesture, and
        // must not also select something on the way up.
        if (this.travelled <= TAP_SLOP && !wasDragging) this.tap(event);
        this.gesture = 'none';
    }

    private spread(): number {
        const [a, b] = [...this.pointers.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }

    /**
     * Move the selected node in the horizontal plane it already sits in.
     *
     * Height is on its own pair of buttons rather than folded into the drag.
     * One finger cannot say three numbers, and the usual trick — depth from how
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
        this.edit(moveNode(this.plan, node.id, {
            x: this.inBlock((at.x - this.world.origin.x) * mm),
            y: node.y,
            z: this.inBlock((at.z - this.world.origin.z) * mm),
        }), { coalesce: true });
    }

    private inBlock(v: number): number {
        return THREE.MathUtils.clamp(v, 0, this.world.blockMm);
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
        this.raycaster.setFromCamera(this.ndc(event), this.camera);
        const hits = this.raycaster.intersectObjects(this.view.root.children, false);
        /*
         * Nodes win over tunnels at the same spot, whichever is nearer. A node
         * always sits INSIDE the tunnels that meet it, so by distance the
         * tunnel wall is always in front — and a junction would be unselectable
         * for exactly as long as anyone cared to try.
         */
        for (const hit of hits) {
            const node = this.view.nodeAt.get(hit.object);
            if (node) return { kind: 'node', id: node };
        }
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
        if (!opts.coalesce || this.gesture !== 'drag' || !this.coalescing) {
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

    private raise(step: number): void {
        if (this.picked?.kind !== 'node') return;
        const node = findNode(this.plan, this.picked.id);
        if (!node) return;
        this.edit(moveNode(this.plan, node.id, {
            x: node.x, y: this.inBlock(node.y + step), z: node.z,
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
         * So it drops the new piece a short way BELOW whatever is selected,
         * joins the two, and moves the selection onto the new one. Press it
         * four times and you have a shaft four pieces deep. Drag any of them
         * afterwards to put it where you actually want it.
         */
        const from = this.picked?.kind === 'node' ? findNode(this.plan, this.picked.id) : null;
        const at = from
            ? { x: from.x, y: this.inBlock(from.y - DROP_MM), z: from.z }
            : {
                x: this.inBlock((this.focus.x - this.world.origin.x) * this.world.mmPerUnit),
                y: this.inBlock((this.focus.y - this.world.origin.y) * this.world.mmPerUnit),
                z: this.inBlock((this.focus.z - this.world.origin.z) * this.world.mmPerUnit),
            };
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
        acts.appendChild(this.chip('↓', () => this.raise(-2)));
        acts.appendChild(this.chip('↑', () => this.raise(2)));
        acts.appendChild(this.chip('DEL', () => {
            if (!this.picked) return;
            this.edit(this.picked.kind === 'node'
                ? deleteNode(this.plan, this.picked.id)
                : deleteEdge(this.plan, this.picked.id));
            this.picked = null;
            this.placeHighlight();
        }, 'is-warn'));
        this.panel.appendChild(acts);

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

    /**
     * Short instructions, because the panel alone does not say what to do first.
     *
     * Five lines and no more. A designer that needs a manual has a control
     * problem, and the fix for most of this was making PLACE chain rather than
     * writing longer text — this is what is left over once the flow is right.
     */
    private buildHelp(): void {
        this.help.className = 'nest-help';
        this.help.style.display = 'none';
        const lines = [
            ['🏠', 'The <b>Station</b> is your way in. Everything hangs off it.'],
            ['➕', '<b>PLACE</b> adds a piece below the selected one and joins it. Press it again to keep going down.'],
            ['👆', 'Tap a piece to select it, then <b>drag</b> to move it. <b>↑ ↓</b> raise and lower, <b>− +</b> resize.'],
            ['🔗', '<b>LINK</b> joins two pieces that are not joined. <b>FLOW</b> sets one-way arrows.'],
            ['⛏️', '<b>DIG IT</b> cuts the soil to your plan. <b>DONE</b> goes back to walking her about.'],
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
        this.buttons.get('undo')?.toggleAttribute('disabled', !this.history.canUndo);

        if (this.linkingFrom) {
            this.hint.textContent = 'tap another node to join it';
            return;
        }
        if (!this.picked) {
            this.hint.textContent = 'drag to orbit · pinch to zoom · tap to select';
            return;
        }
        if (this.picked.kind === 'node') {
            const node = findNode(this.plan, this.picked.id);
            this.hint.textContent = node
                ? `${node.id} · ${node.kind} · ${node.radiusMm.toFixed(0)} mm `
                    + `· ${node.y.toFixed(0)} mm up · drag to move`
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
