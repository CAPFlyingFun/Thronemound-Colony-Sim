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
  PIECE_LENGTHS_MM, appendPiece, buildRail, endStateOf, pieceLabel, piecesToPlan,
  presetPieces, type PieceKind, type PresetId,
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
 * every other room in the project.
 */
const ROOMS = [
  { label: 'ROOM OFF', radiusMm: null },
  { label: 'ROOM STORE', radiusMm: 6 },
  { label: 'ROOM QUEEN', radiusMm: 11 },
] as const;

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

  /** One tag per piece, floating over its midpoint: "+15°", "−45° L15°". */
  private readonly labelGroup = new THREE.Group();

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

  /** Which ROOMS entry the tunnel currently ends in. */
  private roomIdx = 0;

  private roomBtn: HTMLButtonElement | null = null;

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
    this.buildSoil();
    this.buildCart();

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindCamera();

    this.loadPieces();
    // The ROOM chip was built before the save was read; catch it up.
    if (this.roomBtn) this.roomBtn.textContent = ROOMS[this.roomIdx]!.label;
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
      this.rebuildLabels();
      this.recarve();
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
    this.rebuildLabels();
    this.recarve();
    this.frameCamera();
    this.refreshReadout(true);
    this.savePieces();
  }

  /** The plan this track IS — one construction, shared by the carve, the
   *  readout and the probes, so they cannot disagree about radii. */
  private planOf(): NestPlan {
    const room = ROOMS[this.roomIdx]!.radiusMm;
    return piecesToPlan(this.pieces, {
      originMm: { x: 0, y: 0, z: 0 },
      boreRadiusMm: BORE_RADIUS_MM,
      entranceRadiusMm: ENTRANCE_RADIUS_MM,
      ...(room !== null ? { endChamberMm: room } : {}),
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

  private add(kind: PieceKind): void {
    this.pieces.push(appendPiece(this.pieces, kind, {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    }));
    this.rebuildTrack();
  }

  /** A preset move: several pieces, one tap, one rebuild. */
  private addPreset(id: PresetId): void {
    this.pieces.push(...presetPieces(this.pieces, id, {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    }));
    this.rebuildTrack();
  }

  private setRoom(idx: number): void {
    this.roomIdx = ((idx % ROOMS.length) + ROOMS.length) % ROOMS.length;
    if (this.roomBtn) this.roomBtn.textContent = ROOMS[this.roomIdx]!.label;
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
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 2, pieces: this.pieces, roomIdx: this.roomIdx,
      }));
    } catch { /* private mode, quota — the rig runs on regardless */ }
  }

  private loadPieces(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as
        DigPiece[] | { v: number; pieces: DigPiece[]; roomIdx?: number };
      // v1 saved the bare array; v2 wraps it to carry the room. Both load.
      const pieces = Array.isArray(parsed) ? parsed : parsed.pieces;
      if (Array.isArray(pieces)) {
        this.pieces = pieces.filter((p) => Number.isFinite(p?.pitch)
          && Number.isFinite(p?.turn) && Number.isFinite(p?.roll)
          && Number.isFinite(p?.length) && p.length > 0);
      }
      if (!Array.isArray(parsed) && Number.isInteger(parsed.roomIdx)) {
        this.roomIdx = Math.min(ROOMS.length - 1, Math.max(0, parsed.roomIdx!));
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

    /* The PRESET shelf — whole moves, named for nest architecture. */
    const preset = (label: string, id: PresetId): void => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-mode';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.addPreset(id);
      });
      actions.appendChild(button);
    };
    preset('SHAFT', 'shaft');
    preset('SPIRAL◀', 'spiralLeft');
    preset('SPIRAL▶', 'spiralRight');
    preset('U-TURN', 'uturn');

    /* The Utilities panel, ant-sized: what the tunnel ENDS in. */
    this.roomBtn = (() => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-mode';
      button.textContent = ROOMS[this.roomIdx]!.label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setRoom(this.roomIdx + 1);
      });
      actions.appendChild(button);
      return button;
    })();

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
    this.soilBtn = chip('SOIL XRAY', (b) => {
      this.soilMode = this.soilMode === 'xray' ? 'solid'
        : this.soilMode === 'solid' ? 'off' : 'xray';
      b.textContent = `SOIL ${this.soilMode.toUpperCase()}`;
      this.applySoilMode();
    });
    this.tagsBtn = chip('TAGS ON', (b) => {
      this.labelsOn = !this.labelsOn;
      b.textContent = this.labelsOn ? 'TAGS ON' : 'TAGS OFF';
      this.rebuildLabels();
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
      if (key === 'x') this.soilBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 't') this.tagsBtn?.dispatchEvent(new PointerEvent('pointerdown'));
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
    const faults = validatePlan(this.planOf()).length;
    this.readout.innerHTML = `
      <b>monorail rig</b> · pieces ${this.pieces.length}
      · track ${end.lengthMm.toFixed(0)} mm · plan faults ${faults}
      · carve ${this.carveMs.toFixed(0)} ms<br>
      last ${last
    ? `pitch ${last.pitch}° · turn ${last.turn > 0 ? '+' : ''}${last.turn}°`
        + ` · bank ${last.roll > 0 ? '+' : ''}${last.roll}° · ${last.length} mm`
    : '—'}<br>
      end (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}) mm
      · heading ${end.headingDeg.toFixed(0)}° · grade ${end.pitchDeg.toFixed(0)}°<br>
      cart ${this.cartS.toFixed(1)} / ${end.lengthMm.toFixed(0)} mm
      · ends in ${ROOMS[this.roomIdx]!.radiusMm === null
    ? 'a junction' : `a ${ROOMS[this.roomIdx]!.radiusMm} mm room`}<br>
      space/─ straight · ▲▼ pitch ±15° · ◀▶ turn ±15° · L length · B bank
      · M smooth · R ride · X soil · T tags · U undo · C clear · drag orbits
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

  addPresetForTest(id: PresetId): void { this.addPreset(id); }

  setRoomForTest(idx: number): void { this.setRoom(idx); }

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
    const end = endStateOf(this.pieces);
    const plan = this.planOf();
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
      carveMs: this.carveMs,
      labels: this.labelGroup.children.length,
      soilMode: this.soilMode === 'xray' ? 0 : this.soilMode === 'solid' ? 1 : 2,
      roomIdx: this.roomIdx,
      roomMm: ROOMS[this.roomIdx]!.radiusMm ?? 0,
      planChambers: plan.nodes.filter((n) => n.kind === 'chamber').length,
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
