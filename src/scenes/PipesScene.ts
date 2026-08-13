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

/** The rotate racks: 45° steps, and vertical means VERTICAL — the tube
 *  frame carries its heading through a 90° run now. */
const YAW_RACK = [0, 45, 90, -45, -90] as const;
const PITCH_RACK = [0, 45, 90, -45, -90] as const;

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

  /* -------------------------------------------------------- the crawler */

  private readonly queen = new QueenModel('queen');

  private queenReady = false;

  /** Where she stands, mm — free movement now; the pipes only CONTAIN. */
  private readonly antPos = new THREE.Vector3(0, 1.4, -14);

  private facing = 0;

  private walkInput = 0;

  private turnInput = 0;

  private fallV = 0;

  /** Her position projected onto the network — feeds the build anchor. */
  private rideBranch = 0;

  private rideS = 0;

  /* ------------------------------------------------------------- cameras */

  private firstPerson = false;

  private camYaw = -0.6;

  private camPitch = 0.5;

  private camDist = 90;

  private camPointer: number | null = null;

  /** First-person free look — the right-half drag sets BOTH, and the
   *  body keeps its own heading; the neck covers the difference. */
  private fpPitch = 0;

  private fpYaw = 0;

  /** A second right-half touch makes the drag a PINCH: zoom. */
  private pinchPointer: number | null = null;

  private pinchLast = 0;

  private readonly touchAt = new Map<number, { x: number; y: number }>();

  /** Hub room centres, refreshed with the markers — positional room
   *  detection, because "am I in the room" is a question about SPACE. */
  private hubCentres: { branch: number; x: number; y: number; z: number; r: number }[] = [];

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

  private roomBtn: HTMLButtonElement | null = null;

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
    this.invalidateRails();
    this.refreshRoomMarkers();
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

  /* ------------------------------------------------------------- rooms */

  /** What each hub IS, by branch index. Junction until assigned. */
  private readonly roomKind = new Map<number, string>();

  private roomMarkers: THREE.Group | null = null;

  private static readonly ROOM_KINDS = [
    'junction', 'nursery', 'storage', 'food', 'queen',
  ] as const;

  private static readonly ROOM_COLORS: Record<string, number> = {
    junction: 0xb8ad96, nursery: 0x7fc9e0, storage: 0xc9a24f,
    food: 0x8fc06a, queen: 0xc77fd6,
  };

  /** A ring at every hub, wearing its room's colour. */
  private refreshRoomMarkers(): void {
    if (this.roomMarkers) {
      this.scene.remove(this.roomMarkers);
      this.roomMarkers.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.roomMarkers = new THREE.Group();
    this.hubCentres = [];
    this.branches.forEach((branch, i) => {
      if (branch.roomMm === null || branch.pieces.length === 0) return;
      const start = branchStartOf(this.branches, i);
      const end = endStateOf(branch.pieces, { at: start.at, forward: start.forward });
      this.hubCentres.push({
        branch: i, x: end.x, y: end.y, z: end.z, r: branch.roomMm,
      });
      const kind = this.roomKind.get(i) ?? 'junction';
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(branch.roomMm + 1.5, 0.45, 8, 26),
        new THREE.MeshBasicMaterial({
          color: PipesScene.ROOM_COLORS[kind] ?? 0xb8ad96,
          transparent: true, opacity: 0.8, depthTest: false,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(end.x, end.y, end.z);
      ring.renderOrder = 6;
      this.roomMarkers!.add(ring);
    });
    this.scene.add(this.roomMarkers);
  }

  /**
   * WHERE SHE STANDS IS WHERE YOU BUILD. At a hub (either the end of its
   * own line, or the mouth of any line hanging off it) the palette grows
   * new branches out of that hub's exits; anywhere else it extends the
   * end of the line she is riding. Walking back to a junction to add an
   * arm is the whole grammar — no hidden "active branch" to lose.
   */
  private buildAnchor(): { hub: number } | { line: number } {
    const branch = this.branches[this.rideBranch];
    const rail = this.rideRail();
    /*
     * THE OPEN END WINS. Standing at the growing tip of her line always
     * extends that line — checked BEFORE the hub zone, because a young
     * arm out of a junction lies entirely inside the room's radius, and
     * the hub-first rule made every placement there spawn ANOTHER stub
     * inside the ball (the "10 lines, 15 pieces" screenshot) instead of
     * growing the arm out of it. Placement snaps her to the new tip, so
     * repeated placing walks the line outward naturally.
     */
    if (branch && rail && branch.roomMm === null
      && this.rideS > rail.lengthMm - 6) {
      return { line: this.rideBranch };
    }
    const zone = this.hubZone();
    if (zone >= 0) return { hub: zone };
    /* A line that ends in a room is CLOSED — its only open ends are the
     * hub's exits, so building anywhere on it builds from the hub. */
    if (branch && branch.roomMm !== null) return { hub: this.rideBranch };
    return { line: this.rideBranch };
  }

  /** The hub whose ROOM she is physically standing in, or -1 — measured
   *  against the room SPHERES themselves, not a rail projection, because
   *  free crawling stands wherever it likes inside a room. */
  private hubZone(): number {
    for (const h of this.hubCentres) {
      const d = Math.hypot(
        this.antPos.x - h.x, this.antPos.y - h.y, this.antPos.z - h.z,
      );
      if (d < h.r + 2.5) return h.branch;
    }
    return -1;
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
      /* TWO 10 mm runs, not one: the piece format caps a piece at 10 mm
       * and the junction ball is 12 mm — a single run placed from a hub
       * was born ENTIRELY INSIDE the room, invisible and unreachable.
       * The joint takes the yaw on the first, the second runs on. */
      return [
        clampPiece({ pitch, turn: yaw, roll: 0, length: PIPE_LEN_MM }),
        clampPiece({ pitch, turn: 0, roll: 0, length: PIPE_LEN_MM }),
      ];
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
          clampPiece({ pitch: last + 90 * sign, turn: 0, roll: 0, length: 8 }),
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
    const anchor = this.buildAnchor();
    this.active = 'hub' in anchor ? anchor.hub : anchor.line;
    this.armedKind = kind;
    this.armedYawIx = 0;
    this.armedPitchIx = 0;
    this.refreshChips();
    this.refreshGhost();
  }

  private place(): void {
    const kind = this.armedKind;
    if (!kind) return;
    const anchor = this.buildAnchor();
    this.active = 'hub' in anchor ? anchor.hub : anchor.line;
    const branch = this.branches[this.active]!;
    if (HUBS.has(kind)) {
      /* A junction hub: the line she is on ends in a room, and the
       * working end becomes one of its exits. T, Y and ✚ differ only in
       * how many exits you intend to spend — the room serves them all. */
      if (branch.pieces.length === 0 || branch.roomMm !== null) return;
      this.branches[this.active] = { ...branch, roomMm: ROOM_RADIUS_MM };
      this.workingExit = this.nextFreeExit();
    } else {
      const add = this.armedPieces();
      if (!add || add.length === 0) return;
      if ('hub' in anchor) {
        /* Building from a hub: the piece starts a CHILD branch out of
         * the working exit — come back any time for another arm. */
        this.branches.push({
          pieces: add,
          roomMm: null,
          parent: { branch: anchor.hub, exit: this.workingExit },
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
    this.unbury();
    this.refreshChips();
  }

  /** The hub she is standing at (room radius counts), or -1. */
  private hubHere(): number {
    return this.hubZone();
  }

  private cycleRoom(): void {
    const hub = this.hubHere();
    if (hub < 0) return;
    const kinds = PipesScene.ROOM_KINDS;
    const now = this.roomKind.get(hub) ?? 'junction';
    const next = kinds[(kinds.indexOf(now as typeof kinds[number]) + 1) % kinds.length]!;
    this.roomKind.set(hub, next);
    this.refreshRoomMarkers();
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
    this.unbury();
    this.refreshChips();
  }

  private nextFreeExit(): ExitDir {
    const anchor = this.buildAnchor();
    const hub = 'hub' in anchor ? anchor.hub : this.active;
    const taken = takenExitsOf(this.branches, hub);
    for (const dir of EXIT_DIRS) {
      if (!taken.has(dir)) return dir;
    }
    return 'forward';
  }

  private cycleExit(): void {
    const anchor = this.buildAnchor();
    if (!('hub' in anchor)) return;
    const hub = anchor.hub;
    this.active = hub;
    const taken = takenExitsOf(this.branches, hub);
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

  private railCache = new Map<number, ReturnType<typeof buildRail>>();

  private rideRail(index = this.rideBranch) {
    const branch = this.branches[index];
    if (!branch || branch.pieces.length === 0) return null;
    const hit = this.railCache.get(index);
    if (hit) return hit;
    const start = branchStartOf(this.branches, index);
    const rail = buildRail(branch.pieces, { at: start.at, forward: start.forward });
    this.railCache.set(index, rail);
    return rail;
  }

  private invalidateRails(): void { this.railCache.clear(); }

  /* ------------------------------------------------------ free crawling */

  /** Solid soil at a world point? The carved pipes are the only air. */
  private solidAt(x: number, y: number, z: number): boolean {
    if (!this.soilField) return false;
    return this.soilField.sample(
      x - FIELD_ORIGIN.x, y - FIELD_ORIGIN.y, z - FIELD_ORIGIN.z,
    ) > 0;
  }

  /** The first standable surface at or below `fromY`, or null.
   *
   *  A buried start may pop up only `maxPopMm` — enough to shrug off a
   *  ceiling graze or a thin heap, NEVER enough to tunnel through a
   *  pipe roof to daylight (the first cut popped unbounded, and
   *  crawling a tube ended on the lawn). The one-time unbounded unbury
   *  after a re-carve is `unbury()`'s job, not this one's. */
  private floorBelow(
    x: number, z: number, fromY: number, maxPopMm = 4,
  ): number | null {
    const solid = (y: number): boolean => this.solidAt(x, y, z);
    let y = fromY;
    if (solid(y)) {
      for (; y < fromY + maxPopMm; y += 0.5) {
        if (!solid(y)) break;
      }
      if (solid(y)) return null;
    }
    for (let d = y; d > fromY - 40; d -= 0.5) {
      if (solid(d - 0.5)) {
        let lo = d - 0.5;
        let hi = d;
        for (let i = 0; i < 4; i += 1) {
          const mid = (lo + hi) / 2;
          if (solid(mid)) lo = mid;
          else hi = mid;
        }
        return hi;
      }
    }
    return null;
  }

  /** Keep the build anchor fed: project her position onto the network. */
  private projectOntoNetwork(): void {
    let bestBranch = this.rideBranch;
    let bestS = this.rideS;
    let bestD = Infinity;
    this.branches.forEach((b, i) => {
      if (b.pieces.length === 0) return;
      const rail = this.rideRail(i);
      const hit = rail?.nearest(this.antPos);
      if (hit && hit.distMm < bestD) {
        bestD = hit.distMm;
        bestBranch = i;
        bestS = hit.s;
      }
    });
    this.rideBranch = bestBranch;
    this.rideS = bestS;
  }

  /* Smoothed presentation: the field is exact, the BODY is an animal. */
  private readonly smoothPos = new THREE.Vector3();

  private readonly smoothQuat = new THREE.Quaternion();

  private smoothSeeded = false;

  private bank = 0;

  private simulate(dt: number): void {
    /*
     * FREE MOVEMENT IN THE PIPES — the experiment this room now runs.
     * No rail: she walks wherever the carved air lets her. Floors are
     * read straight from the density field, one small step up is a
     * stair, a wall with headroom is climbed slowly (the island's own
     * wall-press rule), a hole ahead is walked into and gravity does
     * the rest — which is exactly how you enter the nest through the
     * mound's vent.
     */
    const WALK = 14;
    const TURN = 2.6;
    const STEP_UP = 2.2;
    const CLIMB = 9;
    const GRAV = 220;
    this.facing += this.turnInput * TURN * dt;
    const speed = this.walkInput * WALK;
    if (Math.abs(speed) > 0.05) {
      const dir = speed >= 0 ? 1 : -1;
      const nx = this.antPos.x + Math.sin(this.facing) * speed * dt;
      const nz = this.antPos.z + Math.cos(this.facing) * speed * dt;
      const ahead = this.floorBelow(nx, nz, this.antPos.y + STEP_UP);
      if (ahead !== null) {
        // A stair up, level ground, a slope down, or a hole to drop into
        // -- all walkable; the y follows below.
        this.antPos.x = nx;
        this.antPos.z = nz;
      } else if (dir > 0
        && !this.solidAt(this.antPos.x, this.antPos.y + 3, this.antPos.z)) {
        // Pressed against a wall with open air above: climb it slowly.
        this.antPos.y += CLIMB * dt;
      }
    }
    const floor = this.floorBelow(this.antPos.x, this.antPos.z, this.antPos.y + 0.6);
    if (floor !== null && this.antPos.y <= floor + RIDE_MM + 0.5) {
      this.fallV = 0;
      const want = floor + RIDE_MM;
      this.antPos.y += (want - this.antPos.y) * Math.min(1, dt * 12);
    } else {
      this.fallV = Math.min(80, this.fallV + GRAV * dt);
      this.antPos.y -= this.fallV * dt;
      if (floor !== null && this.antPos.y < floor + RIDE_MM) {
        this.antPos.y = floor + RIDE_MM;
        this.fallV = 0;
      }
    }

    /*
     * The safety net under all of it: her centre must be AIR. A frame
     * that ends inside soil (ceiling graze mid-climb, an edit under
     * her) restores the last provably-open position instead of letting
     * the walker escape through a roof or sink through a floor.
     */
    if (this.solidAt(this.antPos.x, this.antPos.y, this.antPos.z)) {
      this.embedFrames += 1;
      if (this.embedFrames >= 3 && this.haveSafe) {
        this.antPos.copy(this.lastSafe);
        this.fallV = 0;
        this.embedFrames = 0;
      }
    } else {
      this.embedFrames = 0;
      this.lastSafe.copy(this.antPos);
      this.haveSafe = true;
    }

    this.projectOntoNetwork();
    this.poseQueen(dt);
    this.updateReadout();
  }

  private readonly lastSafe = new THREE.Vector3();

  private haveSafe = false;

  private embedFrames = 0;

  /** One-time, unbounded: after a carve changes the ground she stands
   *  on (a mound heaped over her), seat her on the surface above. */
  private unbury(): void {
    if (!this.solidAt(this.antPos.x, this.antPos.y, this.antPos.z)) return;
    for (let y = this.antPos.y; y < this.antPos.y + 40; y += 0.5) {
      if (!this.solidAt(this.antPos.x, y, this.antPos.z)) {
        this.antPos.y = y + RIDE_MM * 0.5;
        this.fallV = 0;
        this.haveSafe = false;
        return;
      }
    }
  }

  private poseQueen(dt: number): void {
    const fwdFlat = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
    if (this.queenReady) {
      this.queen.root.visible = !this.firstPerson;
      /*
       * THE BODY BENDS. Pitch follows the floor she actually stands on
       * (probed fore and beside her, full-strength so a plunging elbow
       * pitches her nose-down into it), and the NECK covers the angle
       * between her body and the camera — look around in first person,
       * orbit in third, and she turns her head to meet it, gaster
       * counter-swinging, instead of riding stiff as a railcar.
       */
      const probe = 1.6;
      const hC = this.floorBelow(this.antPos.x, this.antPos.z, this.antPos.y + 1)
        ?? this.antPos.y - RIDE_MM;
      const hF = this.floorBelow(
        this.antPos.x + fwdFlat.x * probe, this.antPos.z + fwdFlat.z * probe,
        this.antPos.y + 2.2,
      ) ?? hC;
      const hR = this.floorBelow(
        this.antPos.x + fwdFlat.z * probe, this.antPos.z - fwdFlat.x * probe,
        this.antPos.y + 2.2,
      ) ?? hC;
      const clampG = (v: number): number => Math.max(-2.4, Math.min(2.4, v));
      const gradF = clampG((hF - hC) / probe);
      const gradR = clampG((hR - hC) / probe);
      const right2 = new THREE.Vector3(fwdFlat.z, 0, -fwdFlat.x);
      const up = new THREE.Vector3(0, 1, 0)
        .addScaledVector(fwdFlat, -gradF)
        .addScaledVector(right2, -gradR)
        .normalize();
      const fwd = fwdFlat.clone().addScaledVector(up, -fwdFlat.dot(up)).normalize();
      const wantBank = Math.max(-0.5, Math.min(0.5, this.turnInput * 0.3));
      this.bank += (wantBank - this.bank) * Math.min(1, dt * 5);
      const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
      const target = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(right, up, fwd),
      );
      target.premultiply(new THREE.Quaternion().setFromAxisAngle(fwd, -this.bank));
      if (!this.smoothSeeded) {
        this.smoothPos.copy(this.antPos);
        this.smoothQuat.copy(target);
        this.smoothSeeded = true;
      }
      this.smoothPos.lerp(this.antPos, Math.min(1, dt * 10));
      this.smoothQuat.slerp(target, Math.min(1, dt * 8));
      this.queen.root.position.copy(this.smoothPos);
      this.queen.root.position.y = this.smoothPos.y - RIDE_MM;
      this.queen.root.quaternion.copy(this.smoothQuat);
      /* The neck: where is the VIEW, relative to her body? */
      let neckYaw: number;
      let neckPitch: number | undefined;
      if (this.firstPerson) {
        neckYaw = this.fpYaw;
        neckPitch = this.fpPitch;
      } else {
        const camLook = this.camera.getWorldDirection(new THREE.Vector3());
        neckYaw = Math.atan2(camLook.x, camLook.z) - this.facing;
        while (neckYaw > Math.PI) neckYaw -= Math.PI * 2;
        while (neckYaw < -Math.PI) neckYaw += Math.PI * 2;
        neckPitch = undefined; // over the shoulder, her eyes stay hers
      }
      this.queen.update(dt, {
        speed: (Math.abs(this.walkInput) * 14) / MODEL_SCALE,
        turn: this.turnInput * 2.6,
        digging: 0,
        carrying: 0,
        headYaw: neckYaw,
        headPitch: neckPitch,
      });
      this.queen.solveFeet(
        (x, z) => this.floorBelow(x, z, this.antPos.y + 1.5)
          ?? this.antPos.y - RIDE_MM,
        FOOT_CLEARANCE_MM,
        RIDE_MM * 2,
      );
    }
    this.aimCamera(dt, this.smoothSeeded ? this.smoothPos : this.antPos, fwdFlat);
  }

  private aimCamera(dt: number, at: THREE.Vector3, fwd: THREE.Vector3): void {
    if (this.firstPerson) {
      const eye = at.clone().addScaledVector(fwd, 1.2).add(new THREE.Vector3(0, 0.9, 0));
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0);
      const yaw = this.facing + this.fpYaw;
      const p = this.fpPitch;
      this.camera.lookAt(
        eye.x + Math.sin(yaw) * Math.cos(p),
        eye.y + Math.sin(p),
        eye.z + Math.cos(yaw) * Math.cos(p),
      );
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
    this.roomBtn = this.chip('ROOM', right, () => this.cycleRoom());
    this.chip('UNDO', right, () => this.undo());
    this.chip('SOIL', right, () => {
      this.soilMode = this.soilMode === 'xray' ? 'solid'
        : this.soilMode === 'solid' ? 'off' : 'xray';
      this.applySoilMode();
    });
    this.chip('VIEW', right, () => { this.firstPerson = !this.firstPerson; });

    /* The nest as a SAVE: top-left, away from the build hand. */
    const files = document.createElement('div');
    files.style.cssText = 'position:absolute;top:max(14px, env(safe-area-inset-top));'
      + 'left:max(16px, env(safe-area-inset-left));display:flex;gap:8px;'
      + 'pointer-events:auto;';
    this.hud.appendChild(files);
    this.chip('SAVE', files, () => this.saveNest());
    this.chip('LOAD', files, () => this.loadNest());
    this.chip('NEW', files, () => this.newNest());

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
    const anchor = this.buildAnchor();
    const buildHub = 'hub' in anchor ? anchor.hub : -1;
    const hereHub = this.hubZone();
    if (this.exitBtn) {
      this.exitBtn.style.display = buildHub >= 0 ? '' : 'none';
      this.exitBtn.textContent = `EXIT ${this.workingExit.toUpperCase()}`;
    }
    if (this.roomBtn) {
      this.roomBtn.style.display = hereHub >= 0 ? '' : 'none';
      this.roomBtn.textContent = hereHub >= 0
        ? `ROOM ${(this.roomKind.get(hereHub) ?? 'junction').toUpperCase()}`
        : 'ROOM';
    }
  }

  private lastHub = -2;

  private updateReadout(): void {
    if (this.flashEl && this.flashUntil < performance.now()) {
      this.flashEl.style.display = 'none';
    }
    const hub = this.hubHere();
    if (hub !== this.lastHub) {
      this.lastHub = hub;
      this.refreshChips();
    }
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
        this.touchAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (!leftHalf && this.pinchPointer === null) {
        this.pinchPointer = e.pointerId;
        this.touchAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const a = this.touchAt.get(this.camPointer!);
        if (a) this.pinchLast = Math.hypot(e.clientX - a.x, e.clientY - a.y);
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPointer) {
        const dx = e.clientX - this.stickBase.x;
        const dy = e.clientY - this.stickBase.y;
        const len = Math.hypot(dx, dy);
        const cap = Math.min(1, len / RANGE);
        const nx = len > 1e-3 ? (dx / len) * cap : 0;
        const ny = len > 1e-3 ? (dy / len) * cap : 0;
        this.walkInput = -ny;
        this.turnInput = -nx;
        if (this.knobEl) {
          this.knobEl.style.transform = 'translate(-50%,-50%) '
            + `translate(${nx * RANGE}px, ${ny * RANGE}px)`;
        }
        return;
      }
      if (this.touchAt.has(e.pointerId)) {
        this.touchAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.camPointer !== null && this.pinchPointer !== null) {
        if (e.pointerId !== this.camPointer && e.pointerId !== this.pinchPointer) return;
        const a = this.touchAt.get(this.camPointer);
        const b = this.touchAt.get(this.pinchPointer);
        if (!a || !b) return;
        const now = Math.hypot(b.x - a.x, b.y - a.y);
        if (this.pinchLast > 1 && now > 1) {
          this.camDist = Math.min(180, Math.max(16, this.camDist * (this.pinchLast / now)));
        }
        this.pinchLast = now;
        return;
      }
      if (e.pointerId !== this.camPointer) return;
      if (this.firstPerson) {
        /* FREE LOOK: the drag turns her NECK and eyes, not her body —
         * the joystick owns the body. */
        this.fpYaw = Math.min(2.2, Math.max(-2.2, this.fpYaw - e.movementX * 0.005));
        this.fpPitch = Math.min(1.1, Math.max(-1.1, this.fpPitch - e.movementY * 0.004));
      } else {
        this.camYaw -= e.movementX * 0.006;
        this.camPitch = Math.min(1.4, Math.max(-0.4, this.camPitch + e.movementY * 0.005));
      }
    });
    const done = (e: PointerEvent): void => {
      if (e.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.walkInput = 0;
        this.turnInput = 0;
        if (this.stickEl) this.stickEl.style.display = 'none';
        if (this.knobEl) this.knobEl.style.transform = 'translate(-50%,-50%)';
      }
      if (e.pointerId === this.camPointer) this.camPointer = null;
      if (e.pointerId === this.pinchPointer) this.pinchPointer = null;
      this.touchAt.delete(e.pointerId);
      if (this.camPointer === null && this.pinchPointer !== null) {
        this.camPointer = this.pinchPointer;
        this.pinchPointer = null;
      }
    };
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
    el.addEventListener('lostpointercapture', done);
    /* The lockup insurance: releases can die off-canvas (browser UI,
     * notification pulls). WINDOW-level teardown means a lost finger can
     * never wedge the camera or the stick permanently. */
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
    window.addEventListener('blur', () => {
      this.stickPointer = null;
      this.camPointer = null;
      this.pinchPointer = null;
      this.walkInput = 0;
      this.turnInput = 0;
      this.touchAt.clear();
      if (this.stickEl) this.stickEl.style.display = 'none';
    });
    el.addEventListener('wheel', (e) => {
      this.camDist = Math.min(180, Math.max(20, this.camDist + e.deltaY * 0.06));
    }, { passive: true });
  }

  private bindKeys(): void {
    const keys = new Set<string>();
    const apply = (): void => {
      this.walkInput = (keys.has('w') ? 1 : 0) + (keys.has('s') ? -1 : 0);
      this.turnInput = (keys.has('a') ? 1 : 0) + (keys.has('d') ? -1 : 0);
    };
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'v') this.firstPerson = !this.firstPerson;
      if (key === 'z') this.undo();
      keys.add(key);
      apply();
    });
    window.addEventListener('keyup', (e) => {
      keys.delete(e.key.toLowerCase());
      apply();
    });
  }

  /* ------------------------------------------------------- save / load */

  private static readonly SAVE_KEY = 'thronemound-pipes-nest-v1';

  private saveNest(): void {
    try {
      localStorage.setItem(PipesScene.SAVE_KEY, JSON.stringify({
        branches: this.branches,
        rooms: [...this.roomKind.entries()],
      }));
      this.flash('nest saved');
    } catch {
      this.flash('save refused (storage)');
    }
  }

  private loadNest(): void {
    try {
      const raw = localStorage.getItem(PipesScene.SAVE_KEY);
      if (!raw) {
        this.flash('no saved nest yet');
        return;
      }
      const data = JSON.parse(raw) as {
        branches: TrackBranch[];
        rooms: [number, string][];
      };
      if (!Array.isArray(data.branches) || data.branches.length === 0) {
        this.flash('save was unreadable');
        return;
      }
      this.branches = data.branches;
      this.roomKind.clear();
      for (const [k, v] of data.rooms ?? []) this.roomKind.set(k, v);
      this.active = 0;
      this.armedKind = null;
      this.clearGhost();
      this.recarve();
      this.unbury();
      this.flash('nest loaded');
    } catch {
      this.flash('save was unreadable');
    }
  }

  private newNest(): void {
    this.branches = [{ pieces: [], roomMm: null, parent: null }];
    this.roomKind.clear();
    this.active = 0;
    this.armedKind = null;
    this.clearGhost();
    this.recarve();
    this.antPos.set(0, 1.4, -14);
    this.facing = 0;
    this.smoothSeeded = false;
    this.flash('fresh ground');
  }

  private flashUntil = 0;

  private flashEl: HTMLElement | null = null;

  private flash(text: string): void {
    if (!this.flashEl) {
      this.flashEl = document.createElement('div');
      this.flashEl.className = 'density-lab-status rail-status';
      this.flashEl.style.top = '58px';
      this.hud.appendChild(this.flashEl);
    }
    this.flashEl.textContent = text;
    this.flashEl.style.display = '';
    this.flashUntil = performance.now() + 2000;
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

  cycleRoomForTest(): void { this.cycleRoom(); }

  setWalkForTest(walk: number, turn: number): void {
    this.walkInput = walk;
    this.turnInput = turn;
  }

  teleportMm(x: number, y: number, z: number, facingDeg: number): void {
    this.antPos.set(x, y, z);
    this.facing = (facingDeg * Math.PI) / 180;
    this.smoothSeeded = false;
  }

  setOrbitForTest(yaw: number, pitch: number): void {
    this.camYaw = yaw;
    this.camPitch = pitch;
  }

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
      rideBranch: this.rideBranch,
      hubHere: this.hubHere(),
      roomHere: this.hubHere() >= 0
        ? (this.roomKind.get(this.hubHere()) ?? 'junction') : 'none',
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
