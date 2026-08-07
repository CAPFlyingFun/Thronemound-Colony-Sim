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
import { PIECE_LIMITS, clampPiece, type DigPiece } from './digPlan';
import {
  EXIT_DIRS, PIECE_LENGTHS_MM, appendPiece, autoBankFor, branchStartOf,
  branchesToPlan, buildRail, endStateOf, entryExitOf, pieceLabel,
  presetPieces, takenExitsOf, type BranchStart, type ExitDir,
  type PieceKind, type PresetId,
} from './pieceTrack';
import { MIN_ENTRANCE_RADIUS_MM, validatePlan, type NestPlan } from '../nest/nestPlan';
import { carvePlan } from '../nest/nestCarve';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';

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

/** The bore every piece cuts, and the mouth at the station. The mouth takes
 *  the plan's own minimum — narrower and validatePlan calls it a door she
 *  walks past, which the readout would report as a permanent fault. */
const BORE_RADIUS_MM = 4;
const ENTRANCE_RADIUS_MM = MIN_ENTRANCE_RADIUS_MM;

/**
 * The rooms the ROOM button cycles: none, a store room, a queen chamber.
 * Eleven millimetres of radius is the game's own "generous queen chamber
 * is 22 mm across"; the store is a tunnel-and-a-half. Carved as the
 * standard ant-room ellipsoid by `nestCarve`, so the proportions match
 * every other room in the project. A room is also a HUB now — up to seven
 * connections — so the chip reads as "add a room here".
 */
const ROOMS = [
  { label: '+ ROOM', radiusMm: null },
  { label: 'ROOM ◦', radiusMm: 6 },
  { label: 'ROOM ⬤', radiusMm: 11 },
] as const;

/** A branch as the scene mutates it. Assignable to `TrackBranch`. */
interface LiveBranch {
  pieces: DigPiece[];
  roomMm: number | null;
  parent: { branch: number; exit: ExitDir } | null;
}

const freshBranch = (): LiveBranch => ({
  pieces: [], roomMm: null, parent: null,
});

/** Where each hub spoke sits on the ring, and what it says. Labels over
 *  positions: UP is on top and DOWN on the bottom because those two ARE
 *  spatial; the flat four just take the remaining corners. */
const HUB_SPOKES: readonly { exit: ExitDir; cls: string; label: string }[] = [
  { exit: 'up', cls: 'rh-n', label: 'UP' },
  { exit: 'down', cls: 'rh-s', label: 'DOWN' },
  { exit: 'left', cls: 'rh-w', label: 'LEFT' },
  { exit: 'right', cls: 'rh-e', label: 'RIGHT' },
  { exit: 'forward', cls: 'rh-ne', label: 'FWD' },
  { exit: 'back', cls: 'rh-nw', label: 'BACK' },
];

/**
 * THE SOIL: a block of ground under the station, surface at y = 0.
 *
 * The field reaches a few cells past the soil on every side so surface nets
 * closes the block's faces (the block room's own lesson: a field that is
 * still positive on its boundary sample has no crossing to draw). One
 * millimetre cells, matching the room's one-unit-is-one-millimetre rule, so
 * the carve and the field speak the same numbers.
 */
const SOIL = {
  x0: -50, x1: 50, z0: -20, z1: 80, floor: -60, top: 0,
} as const;
const FIELD_PAD = 3;
const FIELD_ORIGIN = {
  x: SOIL.x0 - FIELD_PAD, y: SOIL.floor - FIELD_PAD, z: SOIL.z0 - FIELD_PAD,
} as const;
/** Headroom above the surface, so the entrance mound has field to exist in. */
const FIELD_SKY = 12;

export class RailScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  /**
   * THE TREE: branch 0 is the station line; every other branch hangs off a
   * parent's end room by one of its exits. The palette, the wheel, the
   * selection and the readout all speak about the ACTIVE branch — one
   * working end at a time, chosen by tapping a room hub or a piece.
   */
  private branches: LiveBranch[] = [freshBranch()];

  private active = 0;

  private branchRails: TunnelRail[] = [buildRail([])];

  /** The active branch's pieces — the list every editing hand works on. */
  private get pieces(): DigPiece[] {
    return this.branches[this.active]!.pieces;
  }

  /** The active branch's rail — ghost, wheel and selection all ride it. */
  private get rail(): TunnelRail {
    return this.branchRails[this.active] ?? buildRail([]);
  }

  /** The station line's rail, which is the one the cart shuttles. */
  private get mainRail(): TunnelRail {
    return this.branchRails[0]!;
  }

  private startOfActive(): BranchStart {
    return branchStartOf(this.branches, this.active);
  }

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

  /** One tag per piece, floating over its midpoint: "+15°", "−45° L15°". */
  private readonly labelGroup = new THREE.Group();

  /**
   * ARM-THEN-PLACE, the way the coaster editors do it: the first tap on a
   * palette chip ARMS the piece — the chip lights up and a translucent
   * ghost of exactly what it would add hangs off the end of the track —
   * and the second tap PLACES it. The chip stays armed after placing, so
   * a run of straights is tap-tap-tap, and tapping a different chip just
   * re-aims the ghost. Escape (or the ✕ chip) stands down.
   */
  private armed: { piece: PieceKind } | { preset: PresetId } | null = null;

  private armedBtn: HTMLButtonElement | null = null;

  /** The ghost of the armed piece, drawn but not yet real. */
  private readonly ghostGroup = new THREE.Group();

  /**
   * The SELECTED piece, for surgical removal: ◀ PIECE / PIECE ▶ walk the
   * highlight along the track and DESTROY takes out exactly that piece —
   * the rest of the line re-anchors behind it, because pieces are relative
   * and the whole rail recompiles from the list. −1 is nothing selected.
   */
  private selIdx = -1;

  private readonly selGroup = new THREE.Group();

  private cancelBtn: HTMLButtonElement | null = null;

  private destroyBtn: HTMLButtonElement | null = null;

  /**
   * THE WHEEL — the coaster editors' radial adjuster, hung on the working
   * end of the track. While a single piece is armed it tunes the GHOST
   * (pitch, turn, bank, length) before you commit; while a placed piece is
   * selected it re-shapes THAT piece in place and the line re-links. It is
   * a DOM ring projected onto the 3D end point every frame, so it rides
   * the track through every orbit of the camera.
   */
  private wheelEl: HTMLElement | null = null;

  private wheelCenter: HTMLButtonElement | null = null;

  private wheelMode: 'ghost' | 'sel' | null = null;

  private readonly wheelAnchor = new THREE.Vector3();

  /** The armed SINGLE piece, tweakable by the wheel before it is placed.
   *  Null while a preset is armed (presets place as authored). */
  private ghostPiece: DigPiece | null = null;

  private labelsOn = true;

  private labelTexts: string[] = [];

  /** The dirt, and the tunnel removed from it. */
  private soilField: DensityField | null = null;

  private soilMesh: THREE.Mesh | null = null;

  private soilMaterial: THREE.MeshLambertMaterial | null = null;

  /** XRAY shows the tunnel through the dirt; SOLID is the honest view. */
  private soilMode: 'xray' | 'solid' | 'off' = 'xray';

  private soilBtn: HTMLButtonElement | null = null;

  private tagsBtn: HTMLButtonElement | null = null;

  private roomBtn: HTMLButtonElement | null = null;

  /** Beam meshes by branch, for tap-to-select raycasts. */
  private beamMeshes: { mesh: THREE.Mesh; branch: number }[] = [];

  /** The room hub buttons, one per roomed branch, projected each frame. */
  private hubLayer: HTMLElement | null = null;

  private hubs: { root: HTMLElement; branch: number }[] = [];

  /** Which branch's hub ring is open, or -1. */
  private openHub = -1;

  /** Where a canvas press started, to tell a tap from an orbit. */
  private tapAt: { x: number; y: number; t: number } | null = null;

  /** Utility chips fold away behind the ⋯ chip until asked for. */
  private drawerChips: HTMLButtonElement[] = [];

  private drawerOpen = false;

  private moreBtn: HTMLButtonElement | null = null;

  /** The readout is a one-line strip until tapped open. */
  private readoutOpen = false;

  private carveMs = 0;

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
    this.scene.add(this.labelGroup);
    this.scene.add(this.ghostGroup);
    this.scene.add(this.selGroup);
    this.buildSoil();
    this.buildCart();

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindCamera();

    this.loadPieces();
    // The ROOM chip was built before the save was read; catch it up.
    this.updateRoomBtn();
    this.rebuildTrack();

    (window as unknown as { railScene?: unknown }).railScene = this;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.ready = true;
    this.animate();
  }

  /* ------------------------------------------------------------- the room */

  private buildGround(): void {
    // The grid is the wider world's floor; the SOIL BLOCK is the ground that
    // matters, and it is real carved geometry now, not a lawn.
    const grid = new THREE.GridHelper(240, 48, 0x7d8a96, 0xa8b6c2);
    grid.position.y = -0.02;
    this.scene.add(grid);
  }

  /** The station marker: a ring at the mouth, findable with the soil off. */
  private buildStation(): void {
    const mouth = new THREE.Mesh(
      new THREE.TorusGeometry(ENTRANCE_RADIUS_MM, 0.4, 10, 28),
      new THREE.MeshLambertMaterial({ color: 0x5a4632 }),
    );
    mouth.rotation.x = Math.PI / 2;
    mouth.position.y = 0.15;
    this.scene.add(mouth);
  }

  /* ------------------------------------------------------------- the soil */

  private buildSoil(): void {
    this.soilField = new DensityField({
      cellsX: (SOIL.x1 - SOIL.x0) + FIELD_PAD * 2,
      cellsY: (SOIL.top - SOIL.floor) + FIELD_PAD + FIELD_SKY,
      cellsZ: (SOIL.z1 - SOIL.z0) + FIELD_PAD * 2,
      cellSize: 1,
    });
    this.soilMaterial = new THREE.MeshLambertMaterial({ color: 0x8a6b48 });
  }

  /** The undug ground: a block of soil whose surface is y = 0. */
  private static soilBase(x: number, y: number, z: number): number {
    return Math.min(
      SOIL.top - y, y - SOIL.floor,
      x - SOIL.x0, SOIL.x1 - x,
      z - SOIL.z0, SOIL.z1 - z,
    );
  }

  /**
   * THE DIRT COMES OUT. The pieces compile to a NestPlan and `carvePlan`
   * does the rest — tunnels bored, the entrance mound heaped over the
   * station with a vent through it — exactly the machinery the island uses,
   * pointed at this room's little block. Run on every edit: this block is
   * ~0.9M samples against the block room's 4M, and the readout carries the
   * cost so a regression is a number rather than a feel.
   */
  private recarve(): void {
    const field = this.soilField;
    if (!field) return;
    const started = performance.now();
    const carved = carvePlan(RailScene.soilBase, this.planOf());
    field.fill((lx, ly, lz) => carved(
      FIELD_ORIGIN.x + lx, FIELD_ORIGIN.y + ly, FIELD_ORIGIN.z + lz,
    ));
    this.carveMs = performance.now() - started;
    this.rebuildSoilMesh();
  }

  private rebuildSoilMesh(): void {
    if (this.soilMesh) {
      this.scene.remove(this.soilMesh);
      this.soilMesh.geometry.dispose();
      this.soilMesh = null;
    }
    if (!this.soilField || !this.soilMaterial) return;
    const data = buildSurfaceNets(this.soilField, 0);
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.soilMaterial);
    mesh.position.set(FIELD_ORIGIN.x, FIELD_ORIGIN.y, FIELD_ORIGIN.z);
    this.scene.add(mesh);
    this.soilMesh = mesh;
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
    // The track end moved, so the armed ghost re-derives from the new end.
    this.ghostPiece = null;
    RailScene.emptyGroup(this.trackGroup);
    this.beamMeshes = [];

    this.branchRails = this.branches.map((branch, k) => {
      const start = branchStartOf(this.branches, k);
      return buildRail(branch.pieces, {
        at: start.at, forward: start.forward,
      });
    });

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    this.branches.forEach((branch, k) => {
      const rail = this.branchRails[k]!;
      const length = rail.lengthMm;
      if (length <= 0) return;

      // The beam: the same sweep the ghost and highlight use. The branch
      // being built is a shade brighter, so the working line reads at a
      // glance without a label.
      const beamGeometry = this.sweepTube(rail, 0, length, BEAM_RADIUS);
      if (beamGeometry) {
        const beam = new THREE.Mesh(beamGeometry, new THREE.MeshLambertMaterial({
          color: k === this.active ? 0x5fa8d8 : 0x4a90c2,
        }));
        this.trackGroup.add(beam);
        this.beamMeshes.push({ mesh: beam, branch: k });
      }

      // The sleepers: one oriented tie every few millimetres. The tie's tilt
      // is the BANK made visible.
      const tieCount = Math.max(1, Math.floor(length / TIE_EVERY_MM));
      const ties = new THREE.InstancedMesh(
        new THREE.BoxGeometry(3.4, 0.35, 0.9),
        new THREE.MeshLambertMaterial({ color: 0x6b5a44 }),
        tieCount,
      );
      const pose = new THREE.Matrix4();
      const basis = new THREE.Matrix4();
      const place = new THREE.Vector3();
      for (let i = 0; i < tieCount; i += 1) {
        const f = rail.sample((i + 0.5) * TIE_EVERY_MM, this.sampleWindow)!;
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

      // The end of the line: a room sphere if there is a room — the hub the
      // player taps to branch — or a buffer knob if there is not.
      const endFrame = rail.sample(length, this.sampleWindow)!;
      if (branch.roomMm !== null) {
        const room = new THREE.Mesh(
          new THREE.SphereGeometry(branch.roomMm, 18, 14),
          new THREE.MeshLambertMaterial({
            color: 0xd8a04c, transparent: true, opacity: 0.28, depthWrite: false,
          }),
        );
        room.position.set(endFrame.x, endFrame.y, endFrame.z);
        this.trackGroup.add(room);
      } else {
        const buffer = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 12, 10),
          new THREE.MeshLambertMaterial({ color: 0xd8b23c }),
        );
        buffer.position.set(endFrame.x, endFrame.y, endFrame.z);
        this.trackGroup.add(buffer);
      }
    });

    this.cartS = Math.min(this.cartS, this.mainRail.lengthMm);
    this.rebuildLabels();
    this.rebuildGhost();
    this.rebuildSelection();
    this.rebuildHubs();
    this.recarve();
    this.frameCamera();
    this.refreshReadout(true);
    this.savePieces();
  }

  /** The plan this track IS — one construction, shared by the carve, the
   *  readout and the probes, so they cannot disagree about radii. */
  private planOf(): NestPlan {
    return branchesToPlan(this.branches, {
      originMm: { x: 0, y: 0, z: 0 },
      boreRadiusMm: BORE_RADIUS_MM,
      entranceRadiusMm: ENTRANCE_RADIUS_MM,
    });
  }

  /* ------------------------------------------------------------ the tags */

  /**
   * One floating tag per piece — its exact pitch, and its yaw as a
   * handedness — hung over the piece's midpoint the way the coaster editors
   * tag their nodes. Rebuilt with the track; a sprite, so it faces the
   * camera from anywhere without owning any orientation of its own.
   */
  private rebuildLabels(): void {
    for (const child of [...this.labelGroup.children]) {
      this.labelGroup.remove(child);
      const sprite = child as THREE.Sprite;
      (sprite.material.map as THREE.Texture | null)?.dispose();
      sprite.material.dispose();
    }
    this.labelTexts = this.pieces.map(pieceLabel);
    if (!this.labelsOn) return;
    let s = 0;
    for (let i = 0; i < this.pieces.length; i += 1) {
      const piece = this.pieces[i]!;
      const frame = this.rail.sample(s + piece.length / 2, this.sampleWindow);
      s += piece.length;
      if (!frame) continue;
      const sprite = this.makeLabel(this.labelTexts[i]!);
      sprite.position.set(
        frame.x + frame.ux * 4, frame.y + frame.uy * 4, frame.z + frame.uz * 4,
      );
      this.labelGroup.add(sprite);
    }
  }

  private makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 56;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(20, 24, 20, 0.78)';
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 14);
    ctx.fill();
    ctx.font = '700 30px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffe9b8';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
    const map = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map, depthTest: false, transparent: true,
    }));
    sprite.renderOrder = 9;
    // 12 x 3.5 mm on a 9 mm ant's scale: readable at the framing distance,
    // small enough that a long track is a line of tags rather than a wall.
    sprite.scale.set(12, 3.5, 1);
    return sprite;
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

  /**
   * The piece a palette button means ON THE ACTIVE BRANCH. Same arithmetic
   * as ever, with one addition: a branch's FIRST piece leads with the grade
   * its exit implies — a branch hung off a room's DOWN exit starts plunging,
   * not level — and UP/DOWN step from that grade rather than from zero.
   */
  private nextPiece(kind: PieceKind): DigPiece {
    const opts = {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    };
    const piece = appendPiece(this.pieces, kind, opts);
    if (this.pieces.length === 0) {
      const seed = this.startOfActive().seedPitchDeg;
      const step = kind === 'up' ? PIECE_LIMITS.pitch.step
        : kind === 'down' ? -PIECE_LIMITS.pitch.step : 0;
      return clampPiece({ ...piece, pitch: seed + step });
    }
    return piece;
  }

  private add(kind: PieceKind): void {
    this.pieces.push(this.nextPiece(kind));
    this.rebuildTrack();
  }

  /** A preset move: several pieces, one tap, one rebuild. On an empty
   *  branch the preset honors the exit's grade — a shaft off an UP exit
   *  climbs, it does not tunnel back down through the room. */
  private addPreset(id: PresetId): void {
    this.pieces.push(...presetPieces(this.pieces, id, {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
      seedPitchDeg: this.startOfActive().seedPitchDeg,
    }));
    this.rebuildTrack();
  }

  /** Do any branches hang off this one's end room? */
  private hasChildren(index: number): boolean {
    return this.branches.some((b) => b.parent?.branch === index);
  }

  /** Cycle the ACTIVE branch's end room. A track has to exist to end in a
   *  room, and a room with branches hanging off it cannot be taken away. */
  private cycleRoom(): void {
    const branch = this.branches[this.active]!;
    if (branch.pieces.length === 0) return;
    const order: (number | null)[] = ROOMS.map((r) => r.radiusMm);
    let idx = (order.indexOf(branch.roomMm) + 1) % order.length;
    if (order[idx] === null && this.hasChildren(this.active)) {
      idx = (idx + 1) % order.length; // skip OFF — the hub is load-bearing
    }
    branch.roomMm = order[idx]!;
    this.updateRoomBtn();
    this.rebuildTrack();
  }

  private updateRoomBtn(): void {
    if (!this.roomBtn) return;
    const roomMm = this.branches[this.active]!.roomMm;
    this.roomBtn.textContent =
      ROOMS.find((r) => r.radiusMm === roomMm)?.label ?? '+ ROOM';
  }

  /** Make a branch the working one: everything editable points at it. */
  private activateBranch(index: number): void {
    if (index < 0 || index >= this.branches.length) return;
    if (this.armed) this.cancelArm();
    this.active = index;
    this.selIdx = -1;
    this.openHub = -1;
    this.updateRoomBtn();
    this.rebuildTrack(); // re-tints the working line, re-anchors the ghost
  }

  /** Remove an EMPTY branch and re-point every parent index past it. */
  private removeBranch(index: number): void {
    const parent = this.branches[index]!.parent?.branch ?? 0;
    this.branches.splice(index, 1);
    for (const b of this.branches) {
      if (b.parent && b.parent.branch > index) b.parent.branch -= 1;
    }
    this.active = parent > index ? parent - 1 : parent;
    this.updateRoomBtn();
  }

  private undo(): void {
    const branch = this.branches[this.active]!;
    if (branch.pieces.length === 0) {
      // Undoing an empty branch takes the branch itself back off its room.
      if (branch.parent) { this.removeBranch(this.active); this.rebuildTrack(); }
      return;
    }
    if (branch.pieces.length === 1 && this.hasChildren(this.active)) {
      return; // the room at the end still has branches to hold up
    }
    branch.pieces.pop();
    if (branch.pieces.length === 0) branch.roomMm = null;
    this.updateRoomBtn();
    this.rebuildTrack();
  }

  private clear(): void {
    this.branches = [freshBranch()];
    this.active = 0;
    this.openHub = -1;
    this.selIdx = -1;
    this.cartS = 0;
    this.cartDir = 1;
    this.updateRoomBtn();
    this.rebuildTrack();
  }

  /* ------------------------------------------------- arm, ghost, select */

  /** What the armed chip WOULD add, computed fresh off the current track
   *  end — so the ghost is always honest about length, bank and pitch. */
  private armedPieces(): DigPiece[] {
    if (!this.armed) return [];
    const opts = {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    };
    if ('piece' in this.armed) {
      if (!this.ghostPiece) {
        this.ghostPiece = this.nextPiece(this.armed.piece);
      }
      return [this.ghostPiece];
    }
    return presetPieces(this.pieces, this.armed.preset, {
      ...opts, seedPitchDeg: this.startOfActive().seedPitchDeg,
    });
  }

  /** First tap arms (chip lights, ghost appears); a tap on the ARMED chip
   *  places it and stays armed for the next one. */
  private armOrPlace(
    button: HTMLButtonElement,
    spec: { piece: PieceKind } | { preset: PresetId },
  ): void {
    if (this.armed && this.armedBtn === button) {
      // Place WHAT THE GHOST SHOWS — wheel tweaks and all.
      if ('piece' in spec && this.ghostPiece) this.placeGhost();
      else if ('piece' in spec) this.add(spec.piece);
      else this.addPreset(spec.preset);
      return; // rebuildTrack refreshed the ghost for the next placement
    }
    // Arming and selecting are two hands on the same track end — one at a
    // time, or the wheel cannot know which piece it is turning.
    if (this.selIdx >= 0) { this.selIdx = -1; this.rebuildSelection(); }
    this.armedBtn?.classList.remove('density-lab-armed');
    this.armed = spec;
    this.ghostPiece = null;
    this.armedBtn = button;
    button.classList.add('density-lab-armed');
    if (this.cancelBtn) this.cancelBtn.style.display = '';
    this.rebuildGhost();
    this.refreshReadout(true);
  }

  private cancelArm(): void {
    this.armedBtn?.classList.remove('density-lab-armed');
    this.armed = null;
    this.ghostPiece = null;
    this.armedBtn = null;
    if (this.cancelBtn) this.cancelBtn.style.display = 'none';
    this.rebuildGhost();
    this.refreshReadout(true);
  }

  /** Commit the ghost — wheel tweaks included — as the next real piece. */
  private placeGhost(): void {
    if (!this.ghostPiece) return;
    this.pieces.push(this.ghostPiece);
    this.rebuildTrack();
  }

  /**
   * One wheel tap: a single exact step of the field it names, routed to
   * whichever piece the wheel is riding — the armed ghost, or the selected
   * placed piece (which re-shapes in place; the line re-links behind it).
   * With BANK AUTO on, a turn or length change re-derives the bank, the
   * same arithmetic the palette uses.
   */
  private wheelTap(
    field: 'pitch' | 'turn' | 'roll' | 'length', dir: 1 | -1,
  ): void {
    const stepOne = (piece: DigPiece): DigPiece => {
      const stepped = {
        ...piece, [field]: piece[field] + PIECE_LIMITS[field].step * dir,
      };
      if (this.autoBank && (field === 'turn' || field === 'length')) {
        stepped.roll = autoBankFor(stepped.turn, stepped.length);
      }
      return clampPiece(stepped);
    };
    if (this.selIdx >= 0 && this.pieces[this.selIdx]) {
      this.pieces[this.selIdx] = stepOne(this.pieces[this.selIdx]!);
      this.rebuildTrack(); // keeps the selection; re-highlights the new shape
      return;
    }
    if (this.ghostPiece) {
      this.ghostPiece = stepOne(this.ghostPiece);
      this.rebuildGhost();
      this.refreshReadout(true);
    }
  }

  private static emptyGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material instanceof THREE.Material) mesh.material.dispose();
    }
  }

  /** A tube swept along `rail` between two arc lengths — the beam builder's
   *  sweep, reusable, so the ghost and the highlight are drawn by the same
   *  arithmetic as the track they annotate. */
  private sweepTube(
    rail: TunnelRail, s0: number, s1: number, radius: number,
  ): THREE.BufferGeometry | null {
    if (s1 - s0 <= 0.01) return null;
    const RING = 8;
    const steps = Math.max(2, Math.ceil((s1 - s0) / DRAW_STEP_MM) + 1);
    const positions = new Float32Array(steps * RING * 3);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    let at = 0;
    for (let i = 0; i < steps; i += 1) {
      const s = s0 + (i / (steps - 1)) * (s1 - s0);
      const f = rail.sample(Math.min(s, rail.lengthMm), this.sampleWindow)!;
      up.set(f.ux, f.uy, f.uz);
      right.set(
        f.uy * f.fz - f.uz * f.fy,
        f.uz * f.fx - f.ux * f.fz,
        f.ux * f.fy - f.uy * f.fx,
      );
      for (let k = 0; k < RING; k += 1) {
        const a = (k / RING) * Math.PI * 2;
        const c = Math.cos(a) * radius;
        const sn = Math.sin(a) * radius;
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
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** The armed piece, drawn as an amber ghost off the end of the track —
   *  visible through the soil, because a preview you cannot see is a trap. */
  private rebuildGhost(): void {
    RailScene.emptyGroup(this.ghostGroup);
    const ghost = this.armedPieces();
    if (ghost.length === 0) return;
    const start = this.startOfActive();
    const anchor = { at: start.at, forward: start.forward };
    const total = buildRail([...this.pieces, ...ghost], anchor);
    const from = buildRail(this.pieces, anchor).lengthMm;
    const geometry = this.sweepTube(total, from, total.lengthMm, BEAM_RADIUS * 1.15);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color: 0xe8b23c,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
    }));
    mesh.renderOrder = 10;
    this.ghostGroup.add(mesh);
    // A cap where the ghost ends, so the eye finds the landing point.
    const endFrame = total.sample(total.lengthMm, this.sampleWindow)!;
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 10, 8),
      new THREE.MeshLambertMaterial({
        color: 0xe8b23c, transparent: true, opacity: 0.7, depthTest: false,
      }),
    );
    cap.renderOrder = 10;
    cap.position.set(endFrame.x, endFrame.y, endFrame.z);
    this.ghostGroup.add(cap);
    // The wheel rides the ghost's landing point.
    this.wheelAnchor.set(endFrame.x, endFrame.y, endFrame.z);
  }

  /** Walk the selection along the track: ◀ starts from the LAST piece
   *  (the one you most likely regret), ▶ from the first. */
  private stepSelection(delta: 1 | -1): void {
    if (this.armed) this.cancelArm();
    const n = this.pieces.length;
    if (n === 0) { this.selIdx = -1; this.rebuildSelection(); return; }
    if (this.selIdx < 0) this.selIdx = delta > 0 ? 0 : n - 1;
    else this.selIdx = (((this.selIdx + delta) % n) + n) % n;
    this.rebuildSelection();
    this.refreshReadout(true);
  }

  private destroySelected(): void {
    if (this.selIdx < 0 || this.selIdx >= this.pieces.length) return;
    if (this.pieces.length === 1 && this.hasChildren(this.active)) {
      return; // the last piece holds up a room with branches on it
    }
    this.pieces.splice(this.selIdx, 1);
    if (this.pieces.length === 0) {
      this.branches[this.active]!.roomMm = null;
      this.updateRoomBtn();
    }
    if (this.selIdx >= this.pieces.length) this.selIdx = this.pieces.length - 1;
    this.rebuildTrack(); // clamps, redraws, and re-highlights
  }

  /** The red sleeve over the selected piece. Also clamps a selection the
   *  last edit orphaned, so it runs with every rebuild. */
  private rebuildSelection(): void {
    if (this.selIdx >= this.pieces.length) this.selIdx = this.pieces.length - 1;
    RailScene.emptyGroup(this.selGroup);
    if (this.destroyBtn) {
      this.destroyBtn.style.display = this.selIdx >= 0 ? '' : 'none';
    }
    if (this.selIdx < 0) return;
    let s0 = 0;
    for (let i = 0; i < this.selIdx; i += 1) s0 += this.pieces[i]!.length;
    const s1 = s0 + this.pieces[this.selIdx]!.length;
    const geometry = this.sweepTube(this.rail, s0, s1, BEAM_RADIUS * 1.7);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color: 0xd8563c,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    }));
    mesh.renderOrder = 11;
    this.selGroup.add(mesh);
  }

  private savePieces(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 3, branches: this.branches, active: this.active,
      }));
    } catch { /* private mode, quota — the rig runs on regardless */ }
  }

  private loadPieces(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as
        DigPiece[]
        | { v: 2; pieces: DigPiece[]; roomIdx?: number }
        | { v: 3; branches: LiveBranch[]; active?: number };
      const soundPieces = (list: unknown): DigPiece[] => (Array.isArray(list)
        ? list.filter((p: DigPiece) => Number.isFinite(p?.pitch)
          && Number.isFinite(p?.turn) && Number.isFinite(p?.roll)
          && Number.isFinite(p?.length) && p.length > 0)
        : []);
      if (!Array.isArray(parsed) && parsed.v === 3
        && Array.isArray(parsed.branches)) {
        // Clamp every piece to the format's own limits, and only accept
        // room radii the game can actually make — a save is a claim, not
        // a fact, and the tree invariants get re-proven branch by branch.
        const roomRadii: (number | null)[] = ROOMS.map((r) => r.radiusMm);
        const raw = parsed.branches.map((b): LiveBranch => ({
          pieces: soundPieces(b?.pieces).map((p) => clampPiece(p)),
          roomMm: typeof b?.roomMm === 'number' && roomRadii.includes(b.roomMm)
            ? b.roomMm : null,
          parent: b?.parent && Number.isInteger(b.parent.branch)
            && b.parent.branch >= 0 && EXIT_DIRS.includes(b.parent.exit)
            ? { branch: b.parent.branch, exit: b.parent.exit } : null,
        }));
        // Keep a branch only if its whole ancestry holds: the first is the
        // root, a parent comes earlier AND survived AND has a roomed track
        // to hang from, and no two children share an exit. Dropping a bad
        // branch drops its descendants with it.
        const kept: LiveBranch[] = [];
        const newIndex = new Map<number, number>();
        raw.forEach((b, i) => {
          if (i === 0) {
            if (b.parent) return; // a rooted tree or nothing
            newIndex.set(0, kept.length);
            kept.push(b);
            return;
          }
          if (!b.parent || b.parent.branch >= i) return;
          const parentAt = newIndex.get(b.parent.branch);
          const parent = parentAt !== undefined ? kept[parentAt] : undefined;
          if (!parent || parent.roomMm === null
            || parent.pieces.length === 0) return;
          const exitTaken = kept.some((other) => other.parent
            && newIndex.get(b.parent!.branch) === other.parent.branch
            && other.parent.exit === b.parent!.exit);
          if (exitTaken) return;
          newIndex.set(i, kept.length);
          kept.push({ ...b, parent: { branch: parentAt!, exit: b.parent.exit } });
        });
        if (kept.length > 0) {
          this.branches = kept;
          const active = Number.isInteger(parsed.active)
            ? newIndex.get(parsed.active!) : undefined;
          this.active = active ?? 0;
        }
        return;
      }
      // v1 saved the bare array; v2 wrapped it to carry the room. Both
      // become the station line of a one-branch tree.
      const pieces = soundPieces(Array.isArray(parsed) ? parsed
        : parsed.v === 2 ? parsed.pieces : []);
      const roomIdx = !Array.isArray(parsed) && parsed.v === 2
        && Number.isInteger(parsed.roomIdx)
        ? Math.min(ROOMS.length - 1, Math.max(0, parsed.roomIdx!)) : 0;
      this.branches = [{
        pieces,
        roomMm: pieces.length > 0 ? ROOMS[roomIdx]!.radiusMm : null,
        parent: null,
      }];
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
        this.armOrPlace(button, { piece: kind });
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
      inDrawer = false,
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
      if (inDrawer) {
        button.style.display = 'none';
        this.drawerChips.push(button);
      }
      return button;
    };

    /*
     * THE SHELF, decluttered: what shows by default is what a first-time
     * player needs — the five pieces, the room, undo — and everything else
     * lives behind the ⋯ chip. A control a novice cannot misread beats a
     * control an expert can reach one tap sooner.
     */
    this.roomBtn = chip(ROOMS[0]!.label, () => this.cycleRoom());
    chip('UNDO', () => this.undo());
    this.moreBtn = chip('⋯', (b) => {
      this.drawerOpen = !this.drawerOpen;
      b.classList.toggle('is-latched', this.drawerOpen);
      for (const c of this.drawerChips) {
        c.style.display = this.drawerOpen ? '' : 'none';
      }
    });

    /* The drawer: presets first (they build), then the toggles. */
    const preset = (label: string, id: PresetId): void => {
      const button = chip(label, (b) => {
        this.armOrPlace(b, { preset: id });
      }, true);
      void button;
    };
    preset('SHAFT', 'shaft');
    preset('SPIRAL◀', 'spiralLeft');
    preset('SPIRAL▶', 'spiralRight');
    preset('U-TURN', 'uturn');
    this.lenBtn = chip(`LEN ${PIECE_LENGTHS_MM[this.lengthIdx]}`, (b) => {
      this.lengthIdx = (this.lengthIdx + 1) % PIECE_LENGTHS_MM.length;
      b.textContent = `LEN ${PIECE_LENGTHS_MM[this.lengthIdx]}`;
      this.ghostPiece = null; // re-derive: the ghost wears the new default
      this.rebuildGhost();
    }, true);
    this.bankBtn = chip('BANK AUTO', (b) => {
      this.autoBank = !this.autoBank;
      b.textContent = this.autoBank ? 'BANK AUTO' : 'BANK OFF';
      this.ghostPiece = null;
      this.rebuildGhost();
    }, true);
    this.smoothBtn = chip('SMOOTH OFF', (b) => {
      this.smooth = !this.smooth;
      b.textContent = this.smooth ? 'SMOOTH ON' : 'SMOOTH OFF';
      this.rebuildTrack();
    }, true);
    this.rideBtn = chip('RIDE ON', (b) => {
      this.riding = !this.riding;
      b.textContent = this.riding ? 'RIDE ON' : 'RIDE OFF';
    }, true);
    this.soilBtn = chip('SOIL XRAY', (b) => {
      this.soilMode = this.soilMode === 'xray' ? 'solid'
        : this.soilMode === 'solid' ? 'off' : 'xray';
      b.textContent = `SOIL ${this.soilMode.toUpperCase()}`;
      this.applySoilMode();
    }, true);
    this.tagsBtn = chip('TAGS ON', (b) => {
      this.labelsOn = !this.labelsOn;
      b.textContent = this.labelsOn ? 'TAGS ON' : 'TAGS OFF';
      this.rebuildLabels();
    }, true);
    chip('CLEAR', () => this.clear(), true);

    /* Standing down: shown only while a chip is armed. */
    this.cancelBtn = chip('✕', () => this.cancelArm());
    this.cancelBtn.style.display = 'none';

    /* Removal: tap a piece on the track to select it, then DESTROY. */
    this.destroyBtn = chip('DESTROY', () => this.destroySelected());
    this.destroyBtn.classList.add('density-lab-danger');
    this.destroyBtn.style.display = 'none';

    this.buildWheel();

    /* The hub layer: room buttons live here, projected every frame. */
    this.hubLayer = document.createElement('div');
    this.hubLayer.className = 'rail-hub-layer';
    this.hud.appendChild(this.hubLayer);

    this.readout = document.createElement('div');
    this.readout.className = 'density-lab-status rail-status';
    this.readout.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.readoutOpen = !this.readoutOpen;
      this.readout?.classList.toggle('is-open', this.readoutOpen);
      this.refreshReadout(true);
    });
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
      if (key === 'escape') this.cancelArm();
      if (key === '[') this.stepSelection(-1);
      if (key === ']') this.stepSelection(1);
      if (key === 'delete' || key === 'backspace') this.destroySelected();
      if (key === 'x') this.soilBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 't') this.tagsBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'b') this.bankBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'm') this.smoothBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'r') this.rideBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'l') this.lenBtn?.dispatchEvent(new PointerEvent('pointerdown'));
    });
  }

  /**
   * The radial adjuster itself: eight spokes and a hub. Compass layout —
   * pitch up top, pitch down bottom, turn on the sides, bank on the upper
   * diagonals, length on the lower — so the hand learns positions, not
   * labels. The hub commits (ghost) or dismisses (selection).
   */
  private buildWheel(): void {
    const wheel = document.createElement('div');
    wheel.className = 'rail-wheel';
    wheel.style.display = 'none';
    const spoke = (
      cls: string, label: string, onTap: () => void,
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.className = `rail-wheel-btn ${cls}`;
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onTap();
      });
      wheel.appendChild(button);
      return button;
    };
    spoke('rw-n', '▲', () => this.wheelTap('pitch', 1));
    spoke('rw-s', '▼', () => this.wheelTap('pitch', -1));
    spoke('rw-w', '◀', () => this.wheelTap('turn', 1));
    spoke('rw-e', '▶', () => this.wheelTap('turn', -1));
    spoke('rw-nw', 'B−', () => this.wheelTap('roll', -1));
    spoke('rw-ne', 'B+', () => this.wheelTap('roll', 1));
    spoke('rw-sw', 'L−', () => this.wheelTap('length', -1));
    spoke('rw-se', 'L+', () => this.wheelTap('length', 1));
    this.wheelCenter = spoke('rw-c', '✓', () => {
      if (this.wheelMode === 'ghost') this.placeGhost();
      else if (this.wheelMode === 'sel') {
        this.selIdx = -1;
        this.rebuildSelection();
        this.refreshReadout(true);
      }
    });
    this.hud.appendChild(wheel);
    this.wheelEl = wheel;
  }

  /** Pin the wheel to the working end, every frame, through every orbit. */
  private updateWheel(): void {
    const wheel = this.wheelEl;
    if (!wheel) return;
    let mode: 'ghost' | 'sel' | null = null;
    if (this.selIdx >= 0 && this.pieces[this.selIdx]) {
      let s1 = 0;
      for (let i = 0; i <= this.selIdx; i += 1) s1 += this.pieces[i]!.length;
      const f = this.rail.sample(Math.min(s1, this.rail.lengthMm), this.sampleWindow);
      if (f) { this.wheelAnchor.set(f.x, f.y, f.z); mode = 'sel'; }
    } else if (this.armed && this.ghostPiece
      && this.ghostGroup.children.length > 0) {
      // Only when the ghost actually drew — a wheel on a stale anchor
      // would be adjusting a piece that is not where it points.
      mode = 'ghost';
    }
    if (!mode) {
      wheel.style.display = 'none';
      this.wheelMode = null;
      return;
    }
    const v = this.wheelAnchor.clone().project(this.camera);
    if (v.z > 1) { wheel.style.display = 'none'; return; }
    wheel.style.display = '';
    wheel.style.left = `${(v.x * 0.5 + 0.5) * (this.host.clientWidth || 1)}px`;
    wheel.style.top = `${(-v.y * 0.5 + 0.5) * (this.host.clientHeight || 1)}px`;
    if (mode !== this.wheelMode) {
      this.wheelMode = mode;
      if (this.wheelCenter) {
        this.wheelCenter.textContent = mode === 'ghost' ? '✓' : '✕';
        this.wheelCenter.title = mode === 'ghost'
          ? 'place this piece' : 'done with this piece';
      }
    }
  }

  /* ------------------------------------------------------------ the hubs */

  /**
   * One button per room, floating on the room itself. Tap it and the six
   * exits fan out around it: spent ones show WHERE the existing tunnels go
   * (and tapping one switches to building that branch); free ones start a
   * new branch that way. No instructions — the room IS the menu.
   */
  private rebuildHubs(): void {
    const layer = this.hubLayer;
    if (!layer) return;
    layer.replaceChildren();
    this.hubs = [];
    if (this.openHub >= 0 && (this.openHub >= this.branches.length
      || this.branches[this.openHub]!.roomMm === null)) {
      this.openHub = -1;
    }
    this.branches.forEach((branch, k) => {
      if (branch.roomMm === null || branch.pieces.length === 0) return;
      const root = document.createElement('div');
      root.className = 'rail-hub';
      const center = document.createElement('button');
      center.className = 'rail-hub-c';
      center.textContent = '⌂';
      center.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openHub = this.openHub === k ? -1 : k;
        this.rebuildHubs();
      });
      root.appendChild(center);
      if (this.openHub === k) {
        root.classList.add('is-open');
        const taken = takenExitsOf(this.branches, k);
        const entry = (() => {
          const start = branchStartOf(this.branches, k);
          const end = endStateOf(branch.pieces, {
            at: start.at, forward: start.forward,
          });
          return entryExitOf(end.pitchDeg);
        })();
        for (const { exit, cls, label } of HUB_SPOKES) {
          const child = this.branches.findIndex(
            (b) => b.parent?.branch === k && b.parent.exit === exit,
          );
          const button = document.createElement('button');
          button.className = `rail-hub-btn ${cls}`;
          button.textContent = label;
          if (exit === entry && child < 0) {
            // The way you came in: not an exit, just the truth.
            button.classList.add('is-entry');
            button.disabled = true;
          } else if (child >= 0) {
            button.classList.add('is-taken');
            if (child === this.active) button.classList.add('is-active');
          }
          button.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (child >= 0) this.activateBranch(child);
            else this.branchOut(k, exit);
          });
          root.appendChild(button);
        }
      }
      layer.appendChild(root);
      this.hubs.push({ root, branch: k });
    });
  }

  /** Start a NEW branch off a room's free exit, and make it the one being
   *  built — the next piece tapped grows out of that room, that way. */
  private branchOut(fromBranch: number, exit: ExitDir): void {
    this.branches.push({
      pieces: [], roomMm: null, parent: { branch: fromBranch, exit },
    });
    this.openHub = -1;
    this.activateBranch(this.branches.length - 1);
  }

  /** Pin every hub button onto its room, every frame, through every orbit. */
  private updateHubs(): void {
    if (this.hubs.length === 0) return;
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    for (const hub of this.hubs) {
      const rail = this.branchRails[hub.branch];
      if (!rail || rail.lengthMm <= 0) { hub.root.style.display = 'none'; continue; }
      const f = rail.sample(rail.lengthMm, this.sampleWindow);
      if (!f) { hub.root.style.display = 'none'; continue; }
      const v = new THREE.Vector3(f.x, f.y, f.z).project(this.camera);
      if (v.z > 1) { hub.root.style.display = 'none'; continue; }
      hub.root.style.display = '';
      hub.root.style.left = `${(v.x * 0.5 + 0.5) * w}px`;
      hub.root.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
    }
  }

  /**
   * A tap on the track picks the piece under the finger — any branch. Not
   * a raycast: the beam is barely wider than the rail, and a fingertip is
   * twenty pixels across. Every branch's rail is walked in SCREEN space
   * instead, and the nearest sampled millimetre within a finger's radius
   * wins — which is the tolerance a phone actually needs.
   */
  private tapTrack(clientX: number, clientY: number): void {
    if (this.armed) return; // aiming has its own working end
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const w = rect.width || 1;
    const h = rect.height || 1;
    const FINGER_PX = 26;
    let best: { branch: number; s: number; distPx: number } | null = null;
    const v = new THREE.Vector3();
    this.branchRails.forEach((rail, branch) => {
      const length = rail.lengthMm;
      if (length <= 0) return;
      for (let s = 0; s <= length; s += 1.5) {
        const f = rail.sample(Math.min(s, length), this.sampleWindow);
        if (!f) continue;
        v.set(f.x, f.y, f.z).project(this.camera);
        if (v.z > 1) continue;
        const dx = (v.x * 0.5 + 0.5) * w - px;
        const dy = (-v.y * 0.5 + 0.5) * h - py;
        const dist = Math.hypot(dx, dy);
        if (dist < FINGER_PX && (!best || dist < best.distPx)) {
          best = { branch, s: Math.min(s, length), distPx: dist };
        }
      }
    });
    if (!best) {
      if (this.selIdx >= 0) {
        this.selIdx = -1;
        this.rebuildSelection();
        this.refreshReadout(true);
      }
      return;
    }
    const { branch, s: hitS } = best as { branch: number; s: number };
    if (branch !== this.active) this.activateBranch(branch);
    let s = 0;
    let idx = this.pieces.length - 1;
    for (let i = 0; i < this.pieces.length; i += 1) {
      s += this.pieces[i]!.length;
      if (hitS <= s + 1e-6) { idx = i; break; }
    }
    this.selIdx = idx;
    this.rebuildSelection();
    this.refreshReadout(true);
  }

  /**
   * The readout, shrunk to a strip: one line of the numbers that matter,
   * and a tap opens the full engineering panel for whoever wants it. The
   * strip does keep the ARMED/selected line — that is state the player is
   * IN, not detail they asked for.
   */
  private refreshReadout(force = false): void {
    if (!this.readout) return;
    const now = performance.now();
    if (!force && now - this.readoutAt < 150) return;
    this.readoutAt = now;
    const start = this.startOfActive();
    const anchor = { at: start.at, forward: start.forward };
    const end = endStateOf(this.pieces, anchor);
    const totalPieces = this.branches
      .reduce((n, b) => n + b.pieces.length, 0);
    const branchName = this.active === 0
      ? 'main line' : `branch ${this.active}`;
    const stateLabel = this.armed
      ? ('piece' in this.armed
        ? `AIMING ${this.armed.piece.toUpperCase()}${this.ghostPiece
          ? ` · ${this.ghostPiece.pitch}° / ${this.ghostPiece.turn}°`
            + ` / ${this.ghostPiece.length} mm`
          : ''}`
        : `AIMING ${this.armed.preset.toUpperCase()} — tap again to place`)
      : this.selIdx >= 0 && this.pieces[this.selIdx]
        ? `piece #${this.selIdx + 1} ${pieceLabel(this.pieces[this.selIdx]!)}`
        : '';
    const mini = `<b>${totalPieces}</b> pieces · ${end.lengthMm.toFixed(0)} mm
      · ${branchName}${this.branches.length > 1
  ? ` of ${this.branches.length}` : ''}
      ${this.readoutOpen ? '▾' : '▸'}${stateLabel
  ? `<br>${stateLabel}` : ''}`;
    if (!this.readoutOpen) {
      this.readout.innerHTML = mini;
      return;
    }
    const last = this.pieces[this.pieces.length - 1];
    const faults = validatePlan(this.planOf()).length;
    const room = this.branches[this.active]!.roomMm;
    this.readout.innerHTML = `${mini}<br>
      plan faults ${faults} · carve ${this.carveMs.toFixed(0)} ms<br>
      last ${last
    ? `pitch ${last.pitch}° · turn ${last.turn > 0 ? '+' : ''}${last.turn}°`
        + ` · bank ${last.roll > 0 ? '+' : ''}${last.roll}° · ${last.length} mm`
    : '—'}<br>
      end (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}) mm
      · heading ${end.headingDeg.toFixed(0)}° · grade ${end.pitchDeg.toFixed(0)}°<br>
      cart ${this.cartS.toFixed(1)} mm ·
      ${branchName} ends in ${room === null ? 'a buffer' : `a ${room} mm room`}<br>
      space/─ straight · ▲▼ pitch · ◀▶ turn · [ ] select · del destroys
      · U undo · esc stands down · drag orbits
    `;
  }

  /* ------------------------------------------------------------ the orbit */

  private bindCamera(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
      if (this.dragPointer === null) {
        this.dragPointer = e.pointerId;
        this.tapAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragPointer) return;
      this.camYaw -= e.movementX * 0.005;
      this.camPitch = Math.min(1.45, Math.max(0.05, this.camPitch + e.movementY * 0.004));
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== this.dragPointer) return;
      this.dragPointer = null;
      // A press that never travelled is a TAP — the select gesture. The
      // orbit keeps the drag; the tap picks the piece under the finger.
      const tap = this.tapAt;
      this.tapAt = null;
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 7
        && performance.now() - tap.t < 450) {
        this.tapTrack(e.clientX, e.clientY);
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', (e) => {
      if (e.pointerId === this.dragPointer) this.dragPointer = null;
      this.tapAt = null;
    });
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
    const length = this.mainRail.lengthMm;
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
      const f = this.mainRail.sample(this.cartS, this.sampleWindow);
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

  addPresetForTest(id: PresetId): void { this.addPreset(id); }

  setRoomForTest(radiusMm: number | null): void {
    const branch = this.branches[this.active]!;
    if (branch.pieces.length === 0) return;
    if (radiusMm === null && this.hasChildren(this.active)) return;
    branch.roomMm = radiusMm;
    this.updateRoomBtn();
    this.rebuildTrack();
  }

  cycleRoomForTest(): void { this.cycleRoom(); }

  branchOutForTest(exit: ExitDir): void {
    // From the ACTIVE branch's room, the way the hub buttons would.
    this.branchOut(this.active, exit);
  }

  activateBranchForTest(index: number): void { this.activateBranch(index); }

  branchesForTest(): {
    pieces: number; roomMm: number | null;
    parent: { branch: number; exit: ExitDir } | null;
  }[] {
    return this.branches.map((b) => ({
      pieces: b.pieces.length,
      roomMm: b.roomMm,
      parent: b.parent ? { ...b.parent } : null,
    }));
  }

  takenExitsForTest(branch: number): ExitDir[] {
    return [...takenExitsOf(this.branches, branch)];
  }

  openHubForTest(branch: number): void {
    this.openHub = branch;
    this.rebuildHubs();
  }

  hubButtonsForTest(): { label: string; taken: boolean; entry: boolean }[] {
    const open = this.hubs.find((h) => h.branch === this.openHub);
    if (!open) return [];
    return [...open.root.querySelectorAll<HTMLButtonElement>('.rail-hub-btn')]
      .map((b) => ({
        label: b.textContent ?? '',
        taken: b.classList.contains('is-taken'),
        entry: b.classList.contains('is-entry'),
      }));
  }

  tapTrackForTest(clientX: number, clientY: number): void {
    this.tapTrack(clientX, clientY);
  }

  undoForTest(): void { this.undo(); }

  clearForTest(): void { this.clear(); }

  armForTest(kind: PieceKind): void {
    const buttons = this.hud.querySelectorAll<HTMLButtonElement>('button');
    const label = { straight: '─', up: '▲', down: '▼', left: '◀', right: '▶' }[kind];
    for (const b of buttons) {
      if (b.textContent === label) { this.armOrPlace(b, { piece: kind }); return; }
    }
  }

  cancelArmForTest(): void { this.cancelArm(); }

  wheelTapForTest(
    field: 'pitch' | 'turn' | 'roll' | 'length', dir: 1 | -1,
  ): void { this.wheelTap(field, dir); }

  placeGhostForTest(): void { this.placeGhost(); }

  ghostPieceForTest(): DigPiece | null {
    return this.ghostPiece ? { ...this.ghostPiece } : null;
  }

  stepSelectionForTest(delta: 1 | -1): void { this.stepSelection(delta); }

  destroySelectedForTest(): void { this.destroySelected(); }

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

  labelsForTest(): string[] { return [...this.labelTexts]; }

  labelSpritesForTest(): number { return this.labelGroup.children.length; }

  /** Is there soil at this millimetre position? Off the carved field. */
  solidAtMm(x: number, y: number, z: number): boolean | null {
    const field = this.soilField;
    if (!field) return null;
    const cx = Math.round(x - FIELD_ORIGIN.x);
    const cy = Math.round(y - FIELD_ORIGIN.y);
    const cz = Math.round(z - FIELD_ORIGIN.z);
    if (cx < 0 || cx > field.cellsX || cy < 0 || cy > field.cellsY
      || cz < 0 || cz > field.cellsZ) return null;
    return field.get(cx, cy, cz) > 0;
  }

  statsForTest(): Record<string, number> {
    const start = this.startOfActive();
    const end = endStateOf(this.pieces, {
      at: start.at, forward: start.forward,
    });
    const plan = this.planOf();
    return {
      pieces: this.pieces.length,
      totalPieces: this.branches.reduce((n, b) => n + b.pieces.length, 0),
      branches: this.branches.length,
      activeBranch: this.active,
      hubs: this.hubs.length,
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
      carveMs: this.carveMs,
      labels: this.labelGroup.children.length,
      soilMode: this.soilMode === 'xray' ? 0 : this.soilMode === 'solid' ? 1 : 2,
      roomMm: this.branches[this.active]!.roomMm ?? 0,
      planChambers: plan.nodes.filter((n) => n.kind === 'chamber').length,
      armed: this.armed ? 1 : 0,
      ghostMeshes: this.ghostGroup.children.length,
      selIdx: this.selIdx,
      selMeshes: this.selGroup.children.length,
      ghostPitch: this.ghostPiece?.pitch ?? 0,
      ghostTurn: this.ghostPiece?.turn ?? 0,
      ghostRoll: this.ghostPiece?.roll ?? 0,
      ghostLen: this.ghostPiece?.length ?? 0,
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
    this.updateWheel();
    this.updateHubs();
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
