/**
 * THE PIPES ROOM — `?scene=pipes`. Tunnels as PLUMBING.
 *
 * The field mock, made playable: a palette of pipe pieces (straight, 90°
 * bend, 180° bend, and T/Y/cross junction hubs), armed with one tap and
 * PLACED with a second, each piece snapping flush to the open end of the
 * network. Rotate-horizontal and rotate-vertical turn the ARMED piece in
 * 45° racks before it commits. Placement carves instantly — laying pipe
 * in real time — and the network's centerlines are rails, so the queen
 * (and one day every ant) knows exactly where she can travel: inside the
 * hollow cylinders, nowhere else.
 *
 * Everything structural is the rail room's proven machinery, reused not
 * re-invented: pieces are `DigPiece`s (pieceTrack), the tree is
 * `TrackBranch`es, the compile is `branchesToPlan`, the soil is a
 * DensityField block carved by `carvePlan`, and the ride reads
 * `railFromPlan`'s geometry. This room only changes the GRAMMAR of
 * building: arm → rotate → place, plumbing-style.
 *
 * One world unit is one millimetre.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';
import { carvePlan } from '../nest/nestCarve';
import { MIN_ENTRANCE_RADIUS_MM } from '../nest/nestPlan';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';
import {
  branchStartOf, branchesToPlan, buildRail, endStateOf, presetPieces,
  takenExitsOf, EXIT_DIRS, EXIT_SEED_PITCH_DEG,
  type ExitDir, type TrackBranch,
} from './pieceTrack';
import { clampPiece, type DigPiece } from './digPlan';

/* ------------------------------------------------------------------ room */

const SOIL = {
  x0: -60, x1: 60, z0: -30, z1: 90, floor: -70, top: 0,
} as const;
const FIELD_PAD = 3;
const FIELD_SKY = 12;
const FIELD_ORIGIN = {
  x: SOIL.x0 - FIELD_PAD, y: SOIL.floor - FIELD_PAD, z: SOIL.z0 - FIELD_PAD,
} as const;

const BORE_RADIUS_MM = 4;
const ROOM_RADIUS_MM = 12;
const PIPE_LEN_MM = 20;

const RIDE_MM = 1.3;
const RIDE_SPEED = 16;
const MODEL_SCALE = 5;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------- the pieces */

type PipeKind = 'straight' | 'bend90' | 'bend180' | 'tee' | 'wye' | 'cross';

const PALETTE: readonly { kind: PipeKind; label: string }[] = [
  { kind: 'straight', label: 'STRAIGHT' },
  { kind: 'bend90', label: '90°' },
  { kind: 'bend180', label: '180°' },
  { kind: 'tee', label: 'T' },
  { kind: 'wye', label: 'Y' },
  { kind: 'cross', label: '✚' },
];

const HUBS: ReadonlySet<PipeKind> = new Set(['tee', 'wye', 'cross']);

/** The rotate racks: what the two rotate buttons cycle through. */
const YAW_RACK = [0, 45, 90, -45, -90] as const;
const PITCH_RACK = [0, 45, 75, -45, -75] as const;

export class PipesScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  /* ---------------------------------------------------------- the network */

  /** Branch 0 is the mainline down from the entrance. */
  private branches: TrackBranch[] = [
    { pieces: [], roomMm: null, parent: null },
  ];

  /** The branch whose open end new pieces snap to. */
  private active = 0;

  /** When the active branch ends in a hub, which exit builds next. */
  private workingExit: ExitDir = 'forward';

  /* ------------------------------------------------------------ the armed */

  private armedKind: PipeKind | null = null;

  private armedYawIx = 0;

  private armedPitchIx = 0;

  private ghost: THREE.Object3D | null = null;

  /* -------------------------------------------------------------- the soil */

  private soilField: DensityField | null = null;

  private soilMesh: THREE.Mesh | null = null;

  private soilMaterial: THREE.MeshLambertMaterial | null = null;

  private soilMode: 'xray' | 'solid' | 'off' = 'xray';

  private carveMs = 0;

  /* -------------------------------------------------------------- the ride */

  private readonly queen = new QueenModel('queen');

  private queenReady = false;

  private rideBranch = 0;

  private rideS = 0;

  private rideInput = 0;

  /* ------------------------------------------------------------- cameras */

  private firstPerson = false;

  private camYaw = -0.6;

  private camPitch = 0.5;

  private camDist = 90;

  private camPointer: number | null = null;

  private stickPointer: number | null = null;

  private stickBase = { x: 0, y: 0 };

  private stickEl: HTMLElement | null = null;

  private knobEl: HTMLElement | null = null;

  /* ----------------------------------------------------------------- HUD */

  private readonly hud: HTMLElement;

  private readonly chips = new Map<PipeKind, HTMLButtonElement>();

  private rotHBtn: HTMLButtonElement | null = null;

  private rotVBtn: HTMLButtonElement | null = null;

  private exitBtn: HTMLButtonElement | null = null;

  private readout: HTMLElement | null = null;

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xbfd6e8);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 2000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(140, 220, 90);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.85));

    const grid = new THREE.GridHelper(260, 52, 0x7d8a96, 0xa8b6c2);
    grid.position.y = -0.02;
    this.scene.add(grid);
    const mouth = new THREE.Mesh(
      new THREE.TorusGeometry(MIN_ENTRANCE_RADIUS_MM, 0.4, 10, 28),
      new THREE.MeshLambertMaterial({ color: 0x5a4632 }),
    );
    mouth.rotation.x = Math.PI / 2;
    mouth.position.y = 0.15;
    this.scene.add(mouth);

    this.soilField = new DensityField({
      cellsX: (SOIL.x1 - SOIL.x0) + FIELD_PAD * 2,
      cellsY: (SOIL.top - SOIL.floor) + FIELD_PAD + FIELD_SKY,
      cellsZ: (SOIL.z1 - SOIL.z0) + FIELD_PAD * 2,
      cellSize: 1,
    });
    this.soilMaterial = new THREE.MeshLambertMaterial({ color: 0x8a6b48 });

    this.queen.root.scale.setScalar(MODEL_SCALE);
    this.queen.root.visible = false;
    this.scene.add(this.queen.root);
    void this.queen.load().then((ok) => { this.queenReady = ok; });

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindPointers();
    this.bindKeys();

    this.recarve();

    (window as unknown as { pipesScene?: unknown }).pipesScene = this;
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.ready = true;
    this.animate();
  }

  /* ------------------------------------------------------------ geometry */

  /** The undug ground: a block of soil whose surface is y = 0. */
  private static soilBase(x: number, y: number, z: number): number {
    return Math.min(
      SOIL.top - y, y - SOIL.floor,
      x - SOIL.x0, SOIL.x1 - x,
      z - SOIL.z0, SOIL.z1 - z,
    );
  }

  private planOf(branches = this.branches) {
    return branchesToPlan(branches, {
      originMm: { x: 0, y: 0, z: 0 },
      boreRadiusMm: BORE_RADIUS_MM,
      entranceRadiusMm: MIN_ENTRANCE_RADIUS_MM,
    });
  }

  private recarve(): void {
    const field = this.soilField;
    if (!field) return;
    const started = performance.now();
    const carved = carvePlan(PipesScene.soilBase, this.planOf());
    field.fill((lx, ly, lz) => carved(
      FIELD_ORIGIN.x + lx, FIELD_ORIGIN.y + ly, FIELD_ORIGIN.z + lz,
    ));
    this.carveMs = performance.now() - started;
    if (this.soilMesh) {
      this.scene.remove(this.soilMesh);
      this.soilMesh.geometry.dispose();
      this.soilMesh = null;
    }
    const data = buildSurfaceNets(field, 0);
    if (data.indices.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, this.soilMaterial!);
      mesh.position.set(FIELD_ORIGIN.x, FIELD_ORIGIN.y, FIELD_ORIGIN.z);
      this.scene.add(mesh);
      this.soilMesh = mesh;
    }
    this.applySoilMode();
  }

  private applySoilMode(): void {
    if (!this.soilMesh || !this.soilMaterial) return;
    this.soilMesh.visible = this.soilMode !== 'off';
    const xray = this.soilMode === 'xray';
    this.soilMaterial.transparent = xray;
    this.soilMaterial.opacity = xray ? 0.45 : 1;
    this.soilMaterial.depthWrite = !xray;
    this.soilMaterial.needsUpdate = true;
  }

  /* --------------------------------------------------- arming and placing */

  /**
   * What the armed piece would ADD, given the rotate racks. Linear kinds
   * return the DigPieces to append; hubs return null (they end the branch
   * with a room instead).
   */
  private armedPieces(): DigPiece[] | null {
    if (!this.armedKind || HUBS.has(this.armedKind)) return null;
    const yaw = YAW_RACK[this.armedYawIx]!;
    const pitch = PITCH_RACK[this.armedPitchIx]!;
    const branch = this.branches[this.active]!;
    if (this.armedKind === 'straight') {
      /* One run in the armed direction: the joint takes the yaw, the run
       * takes the pitch, ends snap by construction. */
      return [clampPiece({ pitch, turn: yaw, roll: 0, length: PIPE_LEN_MM })];
    }
    if (this.armedKind === 'bend90') {
      /* A quarter bend: yaw rack picks the plane (left/right when yawed,
       * up/down when pitched), swept as two 45s so the carve is round. */
      if (this.armedPitchIx !== 0) {
        const sign = pitch > 0 ? 1 : -1;
        const last = branch.pieces.length
          ? branch.pieces[branch.pieces.length - 1]!.pitch : 0;
        return [
          clampPiece({ pitch: last + 45 * sign, turn: 0, roll: 0, length: 8 }),
          clampPiece({ pitch: last + 75 * sign, turn: 0, roll: 0, length: 8 }),
        ];
      }
      const sign = yaw >= 0 ? 1 : -1;
      return [
        clampPiece({ pitch: 0, turn: 45 * sign, roll: 0, length: 8 }),
        clampPiece({ pitch: 0, turn: 45 * sign, roll: 0, length: 8 }),
      ];
    }
    /* 180: the rail room's own u-turn preset, handed the current grade. */
    const last = branch.pieces.length
      ? branch.pieces[branch.pieces.length - 1]!.pitch : 0;
    return presetPieces(branch.pieces, 'uturn', {
      lengthMm: 8, autoBank: false, seedPitchDeg: last,
    }).map((p) => clampPiece({ ...p, turn: p.turn * (yaw < 0 ? -1 : 1) }));
  }

  private arm(kind: PipeKind): void {
    if (this.armedKind === kind) {
      this.place();
      return;
    }
    this.armedKind = kind;
    this.armedYawIx = 0;
    this.armedPitchIx = 0;
    this.refreshChips();
    this.refreshGhost();
  }

  private place(): void {
    const kind = this.armedKind;
    if (!kind) return;
    const branch = this.branches[this.active]!;
    if (HUBS.has(kind)) {
      /* A junction hub: the branch ends in a room, and the working end
       * becomes one of its exits. T, Y and ✚ differ only in how many
       * exits you intend to spend — the room serves them all. */
      if (branch.pieces.length === 0) return;
      this.branches[this.active] = { ...branch, roomMm: ROOM_RADIUS_MM };
      this.workingExit = this.nextFreeExit();
    } else {
      const add = this.armedPieces();
      if (!add || add.length === 0) return;
      if (branch.roomMm !== null) {
        /* Building on from a hub: the piece starts a CHILD branch out of
         * the working exit. */
        this.branches.push({
          pieces: add,
          roomMm: null,
          parent: { branch: this.active, exit: this.workingExit },
        });
        this.active = this.branches.length - 1;
      } else {
        this.branches[this.active] = {
          ...branch, pieces: [...branch.pieces, ...add],
        };
      }
    }
    this.armedKind = null;
    this.clearGhost();
    this.recarve();
    this.snapRideToEnd();
    this.refreshChips();
  }

  private undo(): void {
    const branch = this.branches[this.active]!;
    if (branch.roomMm !== null) {
      this.branches[this.active] = { ...branch, roomMm: null };
    } else if (branch.pieces.length > 0) {
      this.branches[this.active] = {
        ...branch, pieces: branch.pieces.slice(0, -1),
      };
      if (this.branches[this.active]!.pieces.length === 0 && branch.parent) {
        this.branches.splice(this.active, 1);
        this.active = Math.min(this.active, this.branches.length - 1);
        // Splicing renumbers branches; drop any children of the removed
        // one and remap parents. Simplest safe rule for the rig: only
        // the LAST branch is ever removed, so parents keep their index.
      }
    }
    this.armedKind = null;
    this.clearGhost();
    this.recarve();
    this.snapRideToEnd();
    this.refreshChips();
  }

  private nextFreeExit(): ExitDir {
    const taken = takenExitsOf(this.branches, this.active);
    for (const dir of EXIT_DIRS) {
      if (!taken.has(dir)) return dir;
    }
    return 'forward';
  }

  private cycleExit(): void {
    const taken = takenExitsOf(this.branches, this.active);
    const free = EXIT_DIRS.filter((d) => !taken.has(d));
    if (free.length === 0) return;
    const at = free.indexOf(this.workingExit);
    this.workingExit = free[(at + 1) % free.length]!;
    this.refreshGhost();
    this.refreshChips();
  }

  /* --------------------------------------------------------------- ghost */

  private clearGhost(): void {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
      this.ghost = null;
    }
  }

  /** The armed piece, shown snapped to the open end before it commits. */
  private refreshGhost(): void {
    this.clearGhost();
    if (!this.armedKind) return;
    const material = new THREE.MeshLambertMaterial({
      color: 0xe9c36f, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const branch = this.branches[this.active]!;
    if (HUBS.has(this.armedKind)) {
      if (branch.pieces.length === 0) return;
      const start = branchStartOf(this.branches, this.active);
      const end = endStateOf(branch.pieces, {
        at: start.at, forward: start.forward,
      });
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(ROOM_RADIUS_MM, 18, 14), material,
      );
      ball.position.set(end.x, end.y, end.z);
      this.ghost = ball;
      this.scene.add(ball);
      return;
    }
    const add = this.armedPieces();
    if (!add) return;
    /* Where does the new pipe run? Build the rail of just the ADDITION,
     * starting from the open end (or the hub's working exit). */
    let startAt: { at: THREE.Vector3; forward: THREE.Vector3 };
    if (branch.roomMm !== null) {
      const probe: TrackBranch[] = [...this.branches, {
        pieces: add, roomMm: null,
        parent: { branch: this.active, exit: this.workingExit },
      }];
      const s = branchStartOf(probe, probe.length - 1);
      startAt = {
        at: new THREE.Vector3(s.at.x, s.at.y, s.at.z),
        forward: new THREE.Vector3(s.forward.x, s.forward.y, s.forward.z),
      };
    } else {
      const s = branchStartOf(this.branches, this.active);
      const end = endStateOf(branch.pieces, { at: s.at, forward: s.forward });
      const h = end.headingDeg * DEG;
      const g = end.pitchDeg * DEG;
      startAt = {
        at: new THREE.Vector3(end.x, end.y, end.z),
        forward: new THREE.Vector3(
          Math.sin(h) * Math.cos(g), Math.sin(g), Math.cos(h) * Math.cos(g),
        ),
      };
    }
    const rail = buildRail(add, {
      at: { x: startAt.at.x, y: startAt.at.y, z: startAt.at.z },
      forward: { x: startAt.forward.x, y: startAt.forward.y, z: startAt.forward.z },
    });
    const points: THREE.Vector3[] = [];
    for (let s = 0; s <= rail.lengthMm; s += 2) {
      const f = rail.sample(s, 0);
      if (f) points.push(new THREE.Vector3(f.x, f.y, f.z));
    }
    if (points.length < 2) return;
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(points), Math.max(4, points.length),
        BORE_RADIUS_MM, 10, false,
      ),
      material,
    );
    this.ghost = tube;
    this.scene.add(tube);
  }

  /* ---------------------------------------------------------------- ride */

  private rideRail() {
    const branch = this.branches[this.rideBranch];
    if (!branch || branch.pieces.length === 0) return null;
    const start = branchStartOf(this.branches, this.rideBranch);
    return buildRail(branch.pieces, { at: start.at, forward: start.forward });
  }

  private snapRideToEnd(): void {
    this.rideBranch = this.active;
    const rail = this.rideRail();
    this.rideS = rail ? rail.lengthMm : 0;
  }

  private simulate(dt: number): void {
    const rail = this.rideRail();
    if (rail) {
      this.rideS = Math.max(
        0, Math.min(rail.lengthMm, this.rideS + this.rideInput * RIDE_SPEED * dt),
      );
      const f = rail.sample(this.rideS, 0);
      if (f && this.queenReady) {
        this.queen.root.visible = !this.firstPerson;
        const fwd = new THREE.Vector3(f.fx, f.fy, f.fz).normalize();
        const up = new THREE.Vector3(f.ux, f.uy, f.uz).normalize();
        /* She stands on the pipe's FLOOR, not its axis. */
        const drop = BORE_RADIUS_MM - RIDE_MM;
        const at = new THREE.Vector3(f.x, f.y, f.z).addScaledVector(up, -drop);
        this.queen.root.position.copy(at);
        const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
        this.queen.root.quaternion.setFromRotationMatrix(
          new THREE.Matrix4().makeBasis(right, up, fwd),
        );
        this.queen.update(dt, {
          speed: (Math.abs(this.rideInput) * RIDE_SPEED) / MODEL_SCALE,
          turn: 0,
          digging: 0,
          carrying: 0,
          headYaw: 0,
        });
        this.queen.solveFeet(
          () => at.y - RIDE_MM, FOOT_CLEARANCE_MM, RIDE_MM * 2,
        );
        this.aimCamera(dt, at, fwd);
      }
    } else if (this.queenReady) {
      this.queen.root.visible = false;
      this.aimCamera(dt, new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, 1));
    }
    this.updateReadout();
  }

  private aimCamera(dt: number, at: THREE.Vector3, fwd: THREE.Vector3): void {
    if (this.firstPerson) {
      const eye = at.clone().addScaledVector(fwd, 1.2).add(new THREE.Vector3(0, 1.4, 0));
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(eye.clone().add(fwd));
      return;
    }
    const cp = Math.cos(this.camPitch);
    const desired = new THREE.Vector3(
      at.x + Math.sin(this.camYaw) * this.camDist * cp,
      at.y + Math.sin(this.camPitch) * this.camDist,
      at.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    this.camera.position.lerp(desired, Math.min(1, dt * 7));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(at.x, at.y, at.z);
  }

  /* ----------------------------------------------------------------- HUD */

  private chip(
    label: string, parent: HTMLElement, onTap: () => void,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'density-lab-button density-lab-mode';
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onTap();
    });
    parent.appendChild(b);
    return b;
  }

  private buildControls(): void {
    /* The palette, bottom centre — arm with one tap, place with another. */
    const palette = document.createElement('div');
    palette.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);'
      + 'bottom:max(14px, env(safe-area-inset-bottom));display:flex;gap:8px;'
      + 'pointer-events:auto;flex-wrap:wrap;justify-content:center;'
      + 'max-width:70vw;';
    this.hud.appendChild(palette);
    for (const p of PALETTE) {
      this.chips.set(p.kind, this.chip(p.label, palette, () => this.arm(p.kind)));
    }

    /* The rotates and the rest, right column. */
    const right = document.createElement('div');
    right.className = 'density-lab-actions';
    right.style.gap = '8px';
    this.hud.appendChild(right);
    this.rotHBtn = this.chip('ROT ↔ 0°', right, () => {
      this.armedYawIx = (this.armedYawIx + 1) % YAW_RACK.length;
      this.refreshGhost();
      this.refreshChips();
    });
    this.rotVBtn = this.chip('ROT ↕ 0°', right, () => {
      this.armedPitchIx = (this.armedPitchIx + 1) % PITCH_RACK.length;
      this.refreshGhost();
      this.refreshChips();
    });
    this.exitBtn = this.chip('EXIT →', right, () => this.cycleExit());
    this.chip('UNDO', right, () => this.undo());
    this.chip('SOIL', right, () => {
      this.soilMode = this.soilMode === 'xray' ? 'solid'
        : this.soilMode === 'solid' ? 'off' : 'xray';
      this.applySoilMode();
    });
    this.chip('VIEW', right, () => { this.firstPerson = !this.firstPerson; });

    /* The joystick, left half — riding the network. */
    const stick = document.createElement('div');
    stick.style.cssText = 'position:absolute;width:104px;height:104px;'
      + 'border-radius:50%;border:2px solid rgba(255,248,230,0.7);'
      + 'background:rgba(60,50,36,0.25);display:none;pointer-events:none;'
      + 'transform:translate(-50%,-50%);';
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:46px;'
      + 'height:46px;border-radius:50%;background:rgba(233,195,111,0.95);'
      + 'transform:translate(-50%,-50%);';
    stick.appendChild(knob);
    this.hud.appendChild(stick);
    this.stickEl = stick;
    this.knobEl = knob;

    this.readout = document.createElement('div');
    this.readout.className = 'density-lab-status rail-status';
    this.hud.appendChild(this.readout);
  }

  private refreshChips(): void {
    for (const [kind, b] of this.chips) {
      b.classList.toggle('is-grip', this.armedKind === kind);
    }
    if (this.rotHBtn) {
      this.rotHBtn.textContent = `ROT ↔ ${YAW_RACK[this.armedYawIx]}°`;
    }
    if (this.rotVBtn) {
      this.rotVBtn.textContent = `ROT ↕ ${PITCH_RACK[this.armedPitchIx]}°`;
    }
    if (this.exitBtn) {
      const hub = this.branches[this.active]!.roomMm !== null;
      this.exitBtn.style.display = hub ? '' : 'none';
      this.exitBtn.textContent = `EXIT ${this.workingExit.toUpperCase()}`;
    }
  }

  private updateReadout(): void {
    if (!this.readout) return;
    const pieces = this.branches.reduce((n, b) => n + b.pieces.length, 0);
    const hubs = this.branches.filter((b) => b.roomMm !== null).length;
    const text = `<b>pipes</b> · ${pieces} pieces · ${hubs} hubs · `
      + `${this.branches.length} lines · carve ${this.carveMs.toFixed(0)}ms`
      + `${this.armedKind ? ` · armed: ${this.armedKind}` : ''}`;
    if (this.readout.innerHTML !== text) this.readout.innerHTML = text;
  }

  /* -------------------------------------------------------------- inputs */

  private bindPointers(): void {
    const el = this.renderer.domElement;
    const RANGE = 46;
    el.addEventListener('pointerdown', (e) => {
      const leftHalf = e.clientX < window.innerWidth / 2;
      if (leftHalf && this.stickPointer === null) {
        this.stickPointer = e.pointerId;
        this.stickBase = { x: e.clientX, y: e.clientY };
        if (this.stickEl) {
          this.stickEl.style.left = `${e.clientX}px`;
          this.stickEl.style.top = `${e.clientY}px`;
          this.stickEl.style.display = '';
        }
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (!leftHalf && this.camPointer === null) {
        this.camPointer = e.pointerId;
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) {
        const dy = e.clientY - this.stickBase.y;
        const cap = Math.max(-1, Math.min(1, -dy / RANGE));
        this.rideInput = cap;
        if (this.knobEl) {
          this.knobEl.style.transform = 'translate(-50%,-50%) '
            + `translate(0px, ${-cap * RANGE}px)`;
        }
        return;
      }
      if (e.pointerId !== this.camPointer) return;
      this.camYaw -= e.movementX * 0.006;
      this.camPitch = Math.min(1.4, Math.max(-0.4, this.camPitch + e.movementY * 0.005));
    });
    const done = (e: PointerEvent): void => {
      if (e.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.rideInput = 0;
        if (this.stickEl) this.stickEl.style.display = 'none';
        if (this.knobEl) this.knobEl.style.transform = 'translate(-50%,-50%)';
      }
      if (e.pointerId === this.camPointer) this.camPointer = null;
    };
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
    el.addEventListener('wheel', (e) => {
      this.camDist = Math.min(180, Math.max(20, this.camDist + e.deltaY * 0.06));
    }, { passive: true });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'w') this.rideInput = 1;
      if (key === 's') this.rideInput = -1;
      if (key === 'v') this.firstPerson = !this.firstPerson;
      if (key === 'z') this.undo();
    });
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'w' || key === 's') this.rideInput = 0;
    });
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  armForTest(kind: PipeKind): void { this.arm(kind); }

  rotateForTest(axis: 'h' | 'v'): void {
    if (axis === 'h') this.armedYawIx = (this.armedYawIx + 1) % YAW_RACK.length;
    else this.armedPitchIx = (this.armedPitchIx + 1) % PITCH_RACK.length;
    this.refreshGhost();
  }

  placeForTest(): void { this.place(); }

  undoForTest(): void { this.undo(); }

  cycleExitForTest(): void { this.cycleExit(); }

  setRideForTest(dir: -1 | 0 | 1): void { this.rideInput = dir; }

  solidAtMm(x: number, y: number, z: number): boolean | null {
    if (!this.soilField) return null;
    return this.soilField.sample(
      x - FIELD_ORIGIN.x, y - FIELD_ORIGIN.y, z - FIELD_ORIGIN.z,
    ) > 0;
  }

  statsForTest(): Record<string, number | string> {
    const rail = this.rideRail();
    return {
      pieces: this.branches.reduce((n, b) => n + b.pieces.length, 0),
      branches: this.branches.length,
      hubs: this.branches.filter((b) => b.roomMm !== null).length,
      active: this.active,
      armed: this.armedKind ?? 'none',
      yawDeg: YAW_RACK[this.armedYawIx]!,
      pitchDeg: PITCH_RACK[this.armedPitchIx]!,
      workingExit: this.workingExit,
      ghost: this.ghost ? 1 : 0,
      carveMs: +this.carveMs.toFixed(0),
      rideS: +this.rideS.toFixed(1),
      railLen: rail ? +rail.lengthMm.toFixed(1) : 0,
      queen: this.queenReady ? 1 : 0,
      queenX: +this.queen.root.position.x.toFixed(1),
      queenY: +this.queen.root.position.y.toFixed(1),
      queenZ: +this.queen.root.position.z.toFixed(1),
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.queen.dispose();
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private onResize = (): void => {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };
}
