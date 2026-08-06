/**
 * THE MONORAIL ROOM — `?scene=rail`. The smallest room that can prove the
 * coaster-style tunnel builder.
 *
 * You start with a STATION and append track pieces relative to the end of the
 * last one — straight, up, down, left, right — in exact angle steps, with
 * auto-banking and joint smoothing, and a cart rides the result. No soil, no
 * digging, no ant: the point of this rig is the TRACK. The pieces compile to
 * an ordinary `NestPlan` (see `pieceTrack.piecesToPlan`), so everything this
 * room proves — append semantics, banking, smoothing, riding — carries
 * straight into the carved, jaws-executed version without translation.
 *
 * Deliberately NOT in the island or the density lab: their own rule. A
 * feature is tested in the smallest room that can be wrong about it, and the
 * only things this room can be wrong about are the track and the ride.
 *
 * Units: ONE WORLD UNIT IS ONE MILLIMETRE here, unlike the 5 mm unit of the
 * soil rooms. The piece format speaks millimetres, `TunnelRail` is
 * unit-agnostic, and a rig whose readouts are the same numbers as its
 * geometry has one less conversion to be wrong in. The compile to plan-space
 * millimetres is therefore the identity.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { RAIL_SMOOTH_MM, type TunnelRail } from './tunnelRail';
import { type DigPiece } from './digPlan';
import {
  PIECE_LENGTHS_MM, appendPiece, buildRail, endStateOf, piecesToPlan,
  type PieceKind,
} from './pieceTrack';
import { validatePlan } from '../nest/nestPlan';

/** How fast the cart shuttles, in mm/s. A monorail, not a coaster drop. */
const CART_SPEED = 12;

/** Seconds the cart waits at each buffer before shuttling back. */
const CART_DWELL = 0.7;

/** The beam's radius and how often a sleeper is laid under it, in mm. */
const BEAM_RADIUS = 0.7;
const TIE_EVERY_MM = 3;

/** How finely the drawn beam samples the rail, in mm. */
const DRAW_STEP_MM = 0.5;

/** Where the track saves itself, so a refresh keeps the work. */
const SAVE_KEY = 'tcs-rail-pieces';

export class RailScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private pieces: DigPiece[] = [];

  private rail: TunnelRail = buildRail([]);

  private autoBank = true;

  /**
   * Joint smoothing, as a VIEW of the same track rather than a different
   * track. A planned rail is exact, so its own `smoothMm` is zero; the
   * SMOOTH toggle re-samples it through the 9 mm window instead, which
   * rounds every piece joint the way a coaster builder's smoothing does —
   * and the cart rides whichever version is shown, so what you see is what
   * it rides.
   */
  private smooth = false;

  private lengthIdx = 1; // 6 mm

  private riding = true;

  private cartS = 0;

  private cartDir: 1 | -1 = 1;

  private cartDwell = 0;

  private cart: THREE.Group | null = null;

  private trackGroup = new THREE.Group();

  private camYaw = -0.7;

  private camPitch = 0.55;

  private camDist = 90;

  private readonly camTarget = new THREE.Vector3(0, 0, 12);

  private dragPointer: number | null = null;

  private readonly hud: HTMLElement;

  private readout: HTMLElement | null = null;

  private lenBtn: HTMLButtonElement | null = null;

  private bankBtn: HTMLButtonElement | null = null;

  private smoothBtn: HTMLButtonElement | null = null;

  private rideBtn: HTMLButtonElement | null = null;

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  private readoutAt = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xbfd6e8);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 2000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
    sun.position.set(120, 200, 80);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.9));

    this.buildGround();
    this.buildStation();
    this.scene.add(this.trackGroup);
    this.buildCart();

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindCamera();

    this.loadPieces();
    this.rebuildTrack();

    (window as unknown as { railScene?: unknown }).railScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.ready = true;
    this.animate();
  }

  /* ------------------------------------------------------------- the room */

  private buildGround(): void {
    const grid = new THREE.GridHelper(240, 48, 0x7d8a96, 0xa8b6c2);
    grid.position.y = -0.02;
    this.scene.add(grid);
    /*
     * TRANSLUCENT, because these tracks are TUNNELS: nearly everything this
     * room builds dives below the surface, and an opaque lawn hid the whole
     * of the first descending test track. The grid stays fully drawn, so the
     * surface still reads as a surface; the track reads through it the way
     * the island's sonar view reads through the hill.
     */
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshLambertMaterial({
        color: 0x8da06f, transparent: true, opacity: 0.38,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.05;
    this.scene.add(plane);
  }

  /** The station: the entrance mouth the track grows out of. */
  private buildStation(): void {
    const station = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 7, 1.2, 24),
      new THREE.MeshLambertMaterial({ color: 0xb08a5a }),
    );
    pad.position.y = -0.6;
    station.add(pad);
    const mouth = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.5, 10, 24),
      new THREE.MeshLambertMaterial({ color: 0x5a4632 }),
    );
    mouth.rotation.x = Math.PI / 2;
    mouth.position.y = 0.15;
    station.add(mouth);
    this.scene.add(station);
  }

  private buildCart(): void {
    const cart = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3, 2, 5),
      new THREE.MeshLambertMaterial({ color: 0xd8563c }),
    );
    body.position.y = 1.6;
    cart.add(body);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.6, 4),
      new THREE.MeshLambertMaterial({ color: 0xf0e6d2 }),
    );
    roof.position.y = 2.9;
    cart.add(roof);
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.2, 4.4),
      new THREE.MeshLambertMaterial({ color: 0x704a30 }),
    );
    skirt.position.y = 0.5;
    cart.add(skirt);
    this.cart = cart;
    this.scene.add(cart);
  }

  /* ------------------------------------------------------------ the track */

  private get sampleWindow(): number {
    return this.smooth ? RAIL_SMOOTH_MM : 0;
  }

  /**
   * Rebuild the drawn track from the rail. Wholesale, on every edit — this
   * room's tracks are tens of pieces, not thousands, and a rebuild is a few
   * thousand vertices. The island designer's obligation to defer its redraws
   * (it rebuilds a whole nest per pointer-move) does not transfer to a rig
   * whose edits are button taps.
   */
  private rebuildTrack(): void {
    for (const child of [...this.trackGroup.children]) {
      this.trackGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material instanceof THREE.Material) mesh.material.dispose();
    }
    this.rail = buildRail(this.pieces);
    const length = this.rail.lengthMm;
    if (length <= 0) {
      this.cartS = 0;
      this.refreshReadout(true);
      this.savePieces();
      return;
    }

    // The beam: a tube swept along the sampled frames.
    const RING = 8;
    const steps = Math.max(2, Math.ceil(length / DRAW_STEP_MM) + 1);
    const positions = new Float32Array(steps * RING * 3);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    let at = 0;
    for (let i = 0; i < steps; i += 1) {
      const s = (i / (steps - 1)) * length;
      const f = this.rail.sample(s, this.sampleWindow)!;
      up.set(f.ux, f.uy, f.uz);
      right.set(
        f.uy * f.fz - f.uz * f.fy,
        f.uz * f.fx - f.ux * f.fz,
        f.ux * f.fy - f.uy * f.fx,
      );
      for (let k = 0; k < RING; k += 1) {
        const a = (k / RING) * Math.PI * 2;
        const c = Math.cos(a) * BEAM_RADIUS;
        const sn = Math.sin(a) * BEAM_RADIUS;
        positions[at] = f.x + right.x * c + up.x * sn;
        positions[at + 1] = f.y + right.y * c + up.y * sn;
        positions[at + 2] = f.z + right.z * c + up.z * sn;
        at += 3;
      }
    }
    const index: number[] = [];
    for (let i = 0; i + 1 < steps; i += 1) {
      for (let k = 0; k < RING; k += 1) {
        const a = i * RING + k;
        const b = i * RING + ((k + 1) % RING);
        const c = a + RING;
        const d = b + RING;
        index.push(a, c, b, b, c, d);
      }
    }
    const beamGeometry = new THREE.BufferGeometry();
    beamGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    beamGeometry.setIndex(index);
    beamGeometry.computeVertexNormals();
    const beam = new THREE.Mesh(
      beamGeometry,
      new THREE.MeshLambertMaterial({ color: 0x4a90c2 }),
    );
    this.trackGroup.add(beam);

    // The sleepers: one oriented tie every few millimetres. The tie's tilt is
    // the BANK made visible, which is most of why a monorail has them here.
    const tieCount = Math.max(1, Math.floor(length / TIE_EVERY_MM));
    const ties = new THREE.InstancedMesh(
      new THREE.BoxGeometry(3.4, 0.35, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x6b5a44 }),
      tieCount,
    );
    const pose = new THREE.Matrix4();
    const basis = new THREE.Matrix4();
    const fwd = new THREE.Vector3();
    const place = new THREE.Vector3();
    for (let i = 0; i < tieCount; i += 1) {
      const f = this.rail.sample((i + 0.5) * TIE_EVERY_MM, this.sampleWindow)!;
      up.set(f.ux, f.uy, f.uz);
      fwd.set(f.fx, f.fy, f.fz);
      right.crossVectors(up, fwd).normalize();
      basis.makeBasis(right, up, fwd);
      place.set(f.x - up.x * 0.85, f.y - up.y * 0.85, f.z - up.z * 0.85);
      pose.copy(basis).setPosition(place);
      ties.setMatrixAt(i, pose);
    }
    ties.instanceMatrix.needsUpdate = true;
    this.trackGroup.add(ties);

    // The buffers: where the line ends, so the eye finds it before the cart.
    const endFrame = this.rail.sample(length, this.sampleWindow)!;
    const buffer = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xd8b23c }),
    );
    buffer.position.set(endFrame.x, endFrame.y, endFrame.z);
    this.trackGroup.add(buffer);

    this.cartS = Math.min(this.cartS, length);
    this.frameCamera();
    this.refreshReadout(true);
    this.savePieces();
  }

  /** Keep the whole track in shot as it grows, without stealing the orbit. */
  private frameCamera(): void {
    const box = new THREE.Box3().setFromObject(this.trackGroup);
    if (box.isEmpty()) {
      this.camTarget.set(0, 0, 12);
      return;
    }
    box.getCenter(this.camTarget);
    const size = box.getSize(new THREE.Vector3()).length();
    this.camDist = Math.max(60, Math.min(400, size * 1.4 + 40));
  }

  /* ------------------------------------------------------------ the edits */

  private add(kind: PieceKind): void {
    this.pieces.push(appendPiece(this.pieces, kind, {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    }));
    this.rebuildTrack();
  }

  private undo(): void {
    if (this.pieces.length === 0) return;
    this.pieces.pop();
    this.rebuildTrack();
  }

  private clear(): void {
    if (this.pieces.length === 0) return;
    this.pieces = [];
    this.cartS = 0;
    this.cartDir = 1;
    this.rebuildTrack();
  }

  private savePieces(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.pieces));
    } catch { /* private mode, quota — the rig runs on regardless */ }
  }

  private loadPieces(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DigPiece[];
      if (Array.isArray(parsed)) {
        this.pieces = parsed.filter((p) => Number.isFinite(p?.pitch)
          && Number.isFinite(p?.turn) && Number.isFinite(p?.roll)
          && Number.isFinite(p?.length) && p.length > 0);
      }
    } catch { /* a bad save is an empty track, not a broken room */ }
  }

  /* -------------------------------------------------------------- the HUD */

  private buildControls(): void {
    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    /* Eleven buttons in the lab's single column overflow a landscape phone
     * (430 px tall against ~800 of buttons) — the palette wraps into rows
     * from the corner instead. */
    actions.style.flexFlow = 'row-reverse wrap-reverse';
    actions.style.justifyContent = 'flex-start';
    actions.style.alignItems = 'flex-end';
    actions.style.maxWidth = '340px';
    this.hud.appendChild(actions);

    const piece = (label: string, kind: PieceKind): void => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-dig';
      // The lab's 94 px thumb pad is one button; five of them are a palette,
      // and a palette earns its keep by fitting on a phone in a row.
      button.style.width = '58px';
      button.style.height = '58px';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.add(kind);
      });
      actions.appendChild(button);
    };
    piece('─', 'straight');
    piece('▲', 'up');
    piece('▼', 'down');
    piece('◀', 'left');
    piece('▶', 'right');

    const chip = (
      label: string, onTap: (button: HTMLButtonElement) => void,
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-mode';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onTap(button);
      });
      actions.appendChild(button);
      return button;
    };
    this.lenBtn = chip(`LEN ${PIECE_LENGTHS_MM[this.lengthIdx]}`, (b) => {
      this.lengthIdx = (this.lengthIdx + 1) % PIECE_LENGTHS_MM.length;
      b.textContent = `LEN ${PIECE_LENGTHS_MM[this.lengthIdx]}`;
    });
    this.bankBtn = chip('BANK AUTO', (b) => {
      this.autoBank = !this.autoBank;
      b.textContent = this.autoBank ? 'BANK AUTO' : 'BANK OFF';
    });
    this.smoothBtn = chip('SMOOTH OFF', (b) => {
      this.smooth = !this.smooth;
      b.textContent = this.smooth ? 'SMOOTH ON' : 'SMOOTH OFF';
      this.rebuildTrack();
    });
    this.rideBtn = chip('RIDE ON', (b) => {
      this.riding = !this.riding;
      b.textContent = this.riding ? 'RIDE ON' : 'RIDE OFF';
    });
    chip('UNDO', () => this.undo());
    chip('CLEAR', () => this.clear());

    this.readout = document.createElement('div');
    this.readout.className = 'density-lab-status';
    this.hud.appendChild(this.readout);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === ' ') { e.preventDefault(); this.add('straight'); }
      if (key === 'arrowup' || key === 'w') this.add('up');
      if (key === 'arrowdown' || key === 's') this.add('down');
      if (key === 'arrowleft' || key === 'a') this.add('left');
      if (key === 'arrowright' || key === 'd') this.add('right');
      if (key === 'u') this.undo();
      if (key === 'c') this.clear();
      if (key === 'b') this.bankBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'm') this.smoothBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'r') this.rideBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'l') this.lenBtn?.dispatchEvent(new PointerEvent('pointerdown'));
    });
  }

  private refreshReadout(force = false): void {
    if (!this.readout) return;
    const now = performance.now();
    if (!force && now - this.readoutAt < 150) return;
    this.readoutAt = now;
    const last = this.pieces[this.pieces.length - 1];
    const end = endStateOf(this.pieces);
    const faults = validatePlan(piecesToPlan(this.pieces, {
      originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 8,
    })).length;
    this.readout.innerHTML = `
      <b>monorail rig</b> · pieces ${this.pieces.length}
      · track ${end.lengthMm.toFixed(0)} mm · plan faults ${faults}<br>
      last ${last
    ? `pitch ${last.pitch}° · turn ${last.turn > 0 ? '+' : ''}${last.turn}°`
        + ` · bank ${last.roll > 0 ? '+' : ''}${last.roll}° · ${last.length} mm`
    : '—'}<br>
      end (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}) mm
      · heading ${end.headingDeg.toFixed(0)}° · grade ${end.pitchDeg.toFixed(0)}°<br>
      cart ${this.cartS.toFixed(1)} / ${end.lengthMm.toFixed(0)} mm<br>
      space/─ straight · ▲▼ pitch ±15° · ◀▶ turn ±15° · L length · B bank
      · M smooth · R ride · U undo · C clear · drag orbits
    `;
  }

  /* ------------------------------------------------------------ the orbit */

  private bindCamera(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (this.dragPointer === null) this.dragPointer = e.pointerId;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragPointer) return;
      this.camYaw -= e.movementX * 0.005;
      this.camPitch = Math.min(1.45, Math.max(0.05, this.camPitch + e.movementY * 0.004));
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId === this.dragPointer) this.dragPointer = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = Math.min(500, Math.max(25, this.camDist * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  private aimCamera(): void {
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * this.camDist * cp,
      this.camTarget.y + Math.sin(this.camPitch) * this.camDist,
      this.camTarget.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camTarget);
  }

  /* ------------------------------------------------------------- the ride */

  private simulate(dt: number): void {
    const length = this.rail.lengthMm;
    if (this.cart) this.cart.visible = length > 0;
    if (this.riding && length > 0) {
      if (this.cartDwell > 0) {
        this.cartDwell -= dt;
      } else {
        this.cartS += CART_SPEED * this.cartDir * dt;
        if (this.cartS >= length) {
          this.cartS = length;
          this.cartDir = -1;
          this.cartDwell = CART_DWELL;
        } else if (this.cartS <= 0) {
          this.cartS = 0;
          this.cartDir = 1;
          this.cartDwell = CART_DWELL;
        }
      }
    }
    if (this.cart && length > 0) {
      const f = this.rail.sample(this.cartS, this.sampleWindow);
      if (f) {
        const up = new THREE.Vector3(f.ux, f.uy, f.uz);
        const fwd = new THREE.Vector3(f.fx, f.fy, f.fz)
          .multiplyScalar(this.cartDir);
        const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
        fwd.crossVectors(right, up).normalize();
        this.cart.position.set(f.x, f.y, f.z);
        this.cart.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(right, up, fwd),
        );
      }
    }
    this.refreshReadout();
    this.aimCamera();
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  addPieceForTest(kind: PieceKind): void { this.add(kind); }

  undoForTest(): void { this.undo(); }

  clearForTest(): void { this.clear(); }

  setAutoBankForTest(on: boolean): void {
    this.autoBank = on;
    if (this.bankBtn) this.bankBtn.textContent = on ? 'BANK AUTO' : 'BANK OFF';
  }

  setSmoothForTest(on: boolean): void {
    this.smooth = on;
    if (this.smoothBtn) this.smoothBtn.textContent = on ? 'SMOOTH ON' : 'SMOOTH OFF';
    this.rebuildTrack();
  }

  setRidingForTest(on: boolean): void {
    this.riding = on;
    if (this.rideBtn) this.rideBtn.textContent = on ? 'RIDE ON' : 'RIDE OFF';
  }

  piecesForTest(): DigPiece[] {
    return this.pieces.map((p) => ({ ...p }));
  }

  statsForTest(): Record<string, number> {
    const end = endStateOf(this.pieces);
    const plan = piecesToPlan(this.pieces, {
      originMm: { x: 0, y: 0, z: 0 }, boreRadiusMm: 4, entranceRadiusMm: 8,
    });
    return {
      pieces: this.pieces.length,
      lengthMm: end.lengthMm,
      endX: end.x,
      endY: end.y,
      endZ: end.z,
      endHeadingDeg: end.headingDeg,
      endPitchDeg: end.pitchDeg,
      cartS: this.cartS,
      riding: this.riding ? 1 : 0,
      smooth: this.smooth ? 1 : 0,
      autoBank: this.autoBank ? 1 : 0,
      planNodes: plan.nodes.length,
      planEdges: plan.edges.length,
      planFaults: validatePlan(plan).length,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  /* --------------------------------------------------------------- loop */

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
