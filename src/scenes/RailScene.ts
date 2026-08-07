/**
 * THE MONORAIL ROOM — `?scene=rail`. The coaster-style tunnel builder,
 * now built FROM THE ANT.
 *
 * You are the queen at the working face. Hold DIG and the tube grows along
 * wherever you are looking, in the track's own exact 15° steps; release and
 * it stops. W/S ride her back and forth through what she has dug; V swaps
 * between her own eyes and a shot over her shoulder. The MODE chip toggles
 * what DIG means — TUBES grow the tunnel, ROOMS put a chamber at its end —
 * and a LONG PRESS on it opens the options (piece length, bore width, room
 * size, bank, smoothing, the preset shelf). A short press changes nothing
 * but the mode: everything else stays default, which is the point.
 *
 * The soil block carves live around all of it — the same `carvePlan`
 * machinery the island uses — so digging is watching the dirt come out.
 *
 * Units: ONE WORLD UNIT IS ONE MILLIMETRE here, unlike the 5 mm unit of the
 * soil rooms. The queen's model self-scales for a 5 mm world, so her root
 * wears a ×5 — uniform, which the world-space foot solver survives.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { RAIL_SMOOTH_MM, type TunnelRail } from './tunnelRail';
import { type DigPiece } from './digPlan';
import {
  PIECE_LENGTHS_MM, aimPiece, buildRail, endStateOf, pieceLabel, piecesToPlan,
  presetPieces, type PresetId,
} from './pieceTrack';
import { MIN_ENTRANCE_RADIUS_MM, validatePlan, type NestPlan } from '../nest/nestPlan';
import { carvePlan } from '../nest/nestCarve';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';

/** How fast she rides the tube, and how fast a held DIG grows it, mm/s.
 *  Growth is slower than walking — she is digging, not strolling. */
const WALK_SPEED = 12;
const GROW_RATE = 5;

/** The beam's radius and how often a sleeper is laid under it, in mm. */
const BEAM_RADIUS = 0.7;
const TIE_EVERY_MM = 3;

/** How finely the drawn beam samples the rail, in mm. */
const DRAW_STEP_MM = 0.5;

/** Where the track saves itself, so a refresh keeps the work. */
const SAVE_KEY = 'tcs-rail-pieces';

/** The mm-unit room's scale against the queen's 5 mm-unit model. */
const MODEL_SCALE = 5;

/** How long a press has to last before it is the OPTIONS press. */
const LONG_PRESS_MS = 450;

/** The bore widths the options offer — worker, queen, major tunnels. */
const BORE_RADII_MM = [3, 4, 5] as const;

/** The rooms the options offer. Eleven is the game's own queen chamber. */
const ROOM_RADII_MM = [6, 11] as const;
const ROOM_NAMES = ['STORE', 'QUEEN'] as const;

const ENTRANCE_RADIUS_MM = MIN_ENTRANCE_RADIUS_MM;

/** How far above the tunnel floor she rides — leg height, roughly. */
const RIDE_MM = 1.2;

/**
 * THE SOIL: a block of ground under the station, surface at y = 0. The
 * field reaches a few cells past the soil so surface nets closes its faces.
 */
const SOIL = {
  x0: -50, x1: 50, z0: -20, z1: 80, floor: -60, top: 0,
} as const;
const FIELD_PAD = 3;
const FIELD_ORIGIN = {
  x: SOIL.x0 - FIELD_PAD, y: SOIL.floor - FIELD_PAD, z: SOIL.z0 - FIELD_PAD,
} as const;
const FIELD_SKY = 12;

const DEG = Math.PI / 180;

export class RailScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private pieces: DigPiece[] = [];

  private rail: TunnelRail = buildRail([]);

  /* ------------------------------------------------------------- options */

  private autoBank = true;

  private smooth = false;

  private lengthIdx = 1; // 6 mm

  private boreIdx = 1; // 4 mm — a queen's tunnel

  private roomSizeIdx = 1; // the queen chamber

  private roomOn = false;

  /* ---------------------------------------------------------------- mode */

  private mode: 'tubes' | 'rooms' = 'tubes';

  private digHeld = false;

  /** Millimetres of tube owed by the held DIG, spent in piece quanta. */
  private growAccum = 0;

  /* ----------------------------------------------------------------- ant */

  private readonly queen = new QueenModel('queen');

  private queenReady = false;

  /** The stand-in box until (or unless) her model arrives. */
  private cart: THREE.Group | null = null;

  /** Where she is along the track, in mm of rail. */
  private antS = 0;

  /** -1, 0, 1 — W/S, or the on-screen hold buttons. */
  private walkInput = 0;

  /** Which way she faces along the rail: 1 toward the tip. */
  private facingDir: 1 | -1 = 1;

  /** Where she is LOOKING — the aim the tube grows along. Degrees. */
  private aimHeadingDeg = 0;

  private aimPitchDeg = 0;

  private firstPerson = false;

  /* --------------------------------------------------------------- world */

  private trackGroup = new THREE.Group();

  private readonly labelGroup = new THREE.Group();

  private labelsOn = true;

  private labelTexts: string[] = [];

  private soilField: DensityField | null = null;

  private soilMesh: THREE.Mesh | null = null;

  private soilMaterial: THREE.MeshLambertMaterial | null = null;

  private soilMode: 'xray' | 'solid' | 'off' = 'xray';

  private carveMs = 0;

  /* ------------------------------------------------------------- cameras */

  private camYaw = -0.7;

  private camPitch = 0.55;

  private camDist = 60;

  private readonly camTarget = new THREE.Vector3(0, 0, 0);

  private dragPointer: number | null = null;

  /* ----------------------------------------------------------------- HUD */

  private readonly hud: HTMLElement;

  private readout: HTMLElement | null = null;

  private modeBtn: HTMLButtonElement | null = null;

  private soilBtn: HTMLButtonElement | null = null;

  private tagsBtn: HTMLButtonElement | null = null;

  private panel: HTMLElement | null = null;

  private readonly crosshair = document.createElement('div');

  private longPressTimer: number | null = null;

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
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
    sun.position.set(120, 200, 80);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.9));

    this.buildGround();
    this.buildStation();
    this.scene.add(this.trackGroup);
    this.scene.add(this.labelGroup);
    this.buildSoil();
    this.buildCart();

    /* Her model, at the room's scale. Until it settles the cart stands in,
     * so the rig works offline and in a probe that outruns the fetch. */
    this.queen.root.scale.setScalar(MODEL_SCALE);
    this.scene.add(this.queen.root);
    this.queen.root.visible = false;
    void this.queen.load().then((ok) => {
      this.queenReady = ok;
      if (ok && this.cart) this.cart.visible = false;
    });

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.buildPanel();
    this.bindCamera();

    this.loadPieces();
    this.rebuildTrack();
    this.antS = this.rail.lengthMm;

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

  private buildCart(): void {
    const cart = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(3, 2, 5),
      new THREE.MeshLambertMaterial({ color: 0xd8563c }),
    );
    body.position.y = 1.2;
    cart.add(body);
    this.cart = cart;
    this.scene.add(cart);
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

  private static soilBase(x: number, y: number, z: number): number {
    return Math.min(
      SOIL.top - y, y - SOIL.floor,
      x - SOIL.x0, SOIL.x1 - x,
      z - SOIL.z0, SOIL.z1 - z,
    );
  }

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

  /* ------------------------------------------------------------ the track */

  private get sampleWindow(): number {
    return this.smooth ? RAIL_SMOOTH_MM : 0;
  }

  private get boreRadiusMm(): number { return BORE_RADII_MM[this.boreIdx]!; }

  private rebuildTrack(): void {
    for (const child of [...this.trackGroup.children]) {
      this.trackGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material instanceof THREE.Material) mesh.material.dispose();
    }
    this.rail = buildRail(this.pieces);
    const length = this.rail.lengthMm;
    this.antS = Math.min(this.antS, length);
    if (length <= 0) {
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

    // The sleepers, whose tilt is the bank made visible.
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

    const endFrame = this.rail.sample(length, this.sampleWindow)!;
    const buffer = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xd8b23c }),
    );
    buffer.position.set(endFrame.x, endFrame.y, endFrame.z);
    this.trackGroup.add(buffer);

    this.rebuildLabels();
    this.recarve();
    this.refreshReadout(true);
    this.savePieces();
  }

  /** The plan this track IS — one construction for carve, readout, probes. */
  private planOf(): NestPlan {
    return piecesToPlan(this.pieces, {
      originMm: { x: 0, y: 0, z: 0 },
      boreRadiusMm: this.boreRadiusMm,
      entranceRadiusMm: ENTRANCE_RADIUS_MM,
      ...(this.roomOn
        ? { endChamberMm: ROOM_RADII_MM[this.roomSizeIdx]! }
        : {}),
    });
  }

  /* ------------------------------------------------------------ the tags */

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
    sprite.scale.set(12, 3.5, 1);
    return sprite;
  }

  /* ------------------------------------------------------------ the edits */

  /** One quantum of held-DIG growth: a piece along the aim. */
  private growTube(): void {
    this.pieces.push(aimPiece(
      endStateOf(this.pieces).headingDeg,
      this.aimHeadingDeg, this.aimPitchDeg,
      { lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!, autoBank: this.autoBank },
    ));
    this.rebuildTrack();
    // She dug it, so she is AT it: ride her to the new face.
    this.antS = this.rail.lengthMm;
  }

  private addPreset(id: PresetId): void {
    this.pieces.push(...presetPieces(this.pieces, id, {
      lengthMm: PIECE_LENGTHS_MM[this.lengthIdx]!,
      autoBank: this.autoBank,
    }));
    this.rebuildTrack();
    this.antS = this.rail.lengthMm;
  }

  private toggleRoom(): void {
    this.roomOn = !this.roomOn;
    this.rebuildTrack();
  }

  private undo(): void {
    if (this.pieces.length === 0) return;
    this.pieces.pop();
    this.rebuildTrack();
  }

  private clear(): void {
    if (this.pieces.length === 0 && !this.roomOn) return;
    this.pieces = [];
    this.roomOn = false;
    this.antS = 0;
    this.rebuildTrack();
  }

  private savePieces(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: 3,
        pieces: this.pieces,
        roomOn: this.roomOn,
        roomSizeIdx: this.roomSizeIdx,
        boreIdx: this.boreIdx,
      }));
    } catch { /* private mode, quota — the rig runs on regardless */ }
  }

  private loadPieces(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as DigPiece[] | {
        v: number; pieces: DigPiece[]; roomOn?: boolean;
        roomSizeIdx?: number; boreIdx?: number; roomIdx?: number;
      };
      const pieces = Array.isArray(parsed) ? parsed : parsed.pieces;
      if (Array.isArray(pieces)) {
        this.pieces = pieces.filter((p) => Number.isFinite(p?.pitch)
          && Number.isFinite(p?.turn) && Number.isFinite(p?.roll)
          && Number.isFinite(p?.length) && p.length > 0);
      }
      if (!Array.isArray(parsed)) {
        if (typeof parsed.roomOn === 'boolean') this.roomOn = parsed.roomOn;
        // v2 stored roomIdx 0..2 (off/store/queen); translate it.
        if (Number.isInteger(parsed.roomIdx) && parsed.roomIdx! > 0) {
          this.roomOn = true;
          this.roomSizeIdx = parsed.roomIdx! - 1;
        }
        if (Number.isInteger(parsed.roomSizeIdx)) {
          this.roomSizeIdx = Math.min(ROOM_RADII_MM.length - 1,
            Math.max(0, parsed.roomSizeIdx!));
        }
        if (Number.isInteger(parsed.boreIdx)) {
          this.boreIdx = Math.min(BORE_RADII_MM.length - 1,
            Math.max(0, parsed.boreIdx!));
        }
      }
      // Point her aim along the track's end, so digging continues it.
      const end = endStateOf(this.pieces);
      this.aimHeadingDeg = end.headingDeg;
      this.aimPitchDeg = end.pitchDeg;
    } catch { /* a bad save is an empty track, not a broken room */ }
  }

  /* -------------------------------------------------------------- the HUD */

  private buildControls(): void {
    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    actions.style.flexFlow = 'row-reverse wrap-reverse';
    actions.style.justifyContent = 'flex-start';
    actions.style.alignItems = 'flex-end';
    actions.style.maxWidth = '340px';
    this.hud.appendChild(actions);

    /* DIG: hold to grow a tube along the aim; in ROOMS mode a tap toggles
     * the chamber at the tunnel's end. */
    const dig = document.createElement('button');
    dig.className = 'density-lab-button density-lab-dig';
    dig.textContent = 'DIG';
    dig.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dig.setPointerCapture(e.pointerId);
      if (this.mode === 'rooms') { this.toggleRoom(); return; }
      this.digHeld = true;
    });
    const stopDig = (): void => { this.digHeld = false; this.growAccum = 0; };
    dig.addEventListener('pointerup', stopDig);
    dig.addEventListener('pointercancel', stopDig);
    dig.addEventListener('lostpointercapture', stopDig);
    actions.appendChild(dig);

    /* Ride buttons for thumbs: hold to walk her along the tube. */
    const walk = (label: string, dir: 1 | -1): void => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-dig';
      button.style.width = '58px';
      button.style.height = '58px';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.setPointerCapture(e.pointerId);
        this.walkInput = dir;
      });
      const stop = (): void => { if (this.walkInput === dir) this.walkInput = 0; };
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('lostpointercapture', stop);
      actions.appendChild(button);
    };
    walk('▲', 1);
    walk('▼', -1);

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

    /* MODE: tap toggles what DIG means; HOLD opens the options panel. */
    this.modeBtn = (() => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-mode';
      button.textContent = 'TUBES';
      let longFired = false;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        longFired = false;
        this.longPressTimer = window.setTimeout(() => {
          longFired = true;
          this.togglePanel(true);
        }, LONG_PRESS_MS);
      });
      const up = (): void => {
        if (this.longPressTimer !== null) {
          window.clearTimeout(this.longPressTimer);
          this.longPressTimer = null;
        }
        if (!longFired) {
          this.mode = this.mode === 'tubes' ? 'rooms' : 'tubes';
          button.textContent = this.mode.toUpperCase();
        }
      };
      button.addEventListener('pointerup', up);
      button.addEventListener('pointercancel', () => {
        if (this.longPressTimer !== null) {
          window.clearTimeout(this.longPressTimer);
          this.longPressTimer = null;
        }
      });
      actions.appendChild(button);
      return button;
    })();

    chip('VIEW', () => { this.firstPerson = !this.firstPerson; });
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

    this.crosshair.className = 'density-lab-crosshair';
    this.crosshair.style.display = 'none';
    this.crosshair.style.pointerEvents = 'none';
    this.hud.appendChild(this.crosshair);

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === ' ') {
        e.preventDefault();
        if (!e.repeat) {
          if (this.mode === 'rooms') this.toggleRoom();
          else this.digHeld = true;
        }
        return;
      }
      if (key === 'w') this.walkInput = 1;
      if (key === 's') this.walkInput = -1;
      if (e.repeat) return;
      if (key === 'e') {
        this.mode = this.mode === 'tubes' ? 'rooms' : 'tubes';
        if (this.modeBtn) this.modeBtn.textContent = this.mode.toUpperCase();
      }
      if (key === 'o') this.togglePanel();
      if (key === 'v') this.firstPerson = !this.firstPerson;
      if (key === 'x') this.soilBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 't') this.tagsBtn?.dispatchEvent(new PointerEvent('pointerdown'));
      if (key === 'u') this.undo();
      if (key === 'c') this.clear();
    });
    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key === ' ') { this.digHeld = false; this.growAccum = 0; }
      if ((key === 'w' && this.walkInput === 1)
        || (key === 's' && this.walkInput === -1)) this.walkInput = 0;
    });
    window.addEventListener('blur', () => {
      this.digHeld = false;
      this.growAccum = 0;
      this.walkInput = 0;
    });
  }

  /**
   * THE OPTIONS — everything a long press earns. A short press never needs
   * any of this: length, width and room stay default, bank and smoothing
   * stay wherever they were, and the presets wait here.
   */
  private buildPanel(): void {
    const panel = document.createElement('div');
    panel.className = 'density-lab-settings';
    panel.style.display = 'none';
    panel.style.pointerEvents = 'auto';
    const title = document.createElement('div');
    title.className = 'density-lab-settings-title';
    title.textContent = 'OPTIONS';
    panel.appendChild(title);

    const row = (name: string, buttons: Array<{
      label: string; isOn: () => boolean; tap: () => void;
    }>): void => {
      const line = document.createElement('div');
      line.className = 'density-lab-settings-row';
      const label = document.createElement('span');
      label.className = 'density-lab-settings-name';
      label.textContent = name;
      line.appendChild(label);
      for (const b of buttons) {
        const button = document.createElement('button');
        button.className = 'density-lab-button density-lab-mode';
        const paint = (): void => {
          button.textContent = b.label;
          button.classList.toggle('is-latched', b.isOn());
        };
        paint();
        button.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          b.tap();
          for (const repaintable of Array.from(
            panel.querySelectorAll('button'),
          )) repaintable.dispatchEvent(new Event('repaint'));
        });
        button.addEventListener('repaint', paint);
        line.appendChild(button);
      }
      panel.appendChild(line);
    };

    row('LENGTH', PIECE_LENGTHS_MM.map((len, i) => ({
      label: `${len}`,
      isOn: () => this.lengthIdx === i,
      tap: () => { this.lengthIdx = i; },
    })));
    row('WIDTH', BORE_RADII_MM.map((r, i) => ({
      label: `${r}`,
      isOn: () => this.boreIdx === i,
      tap: () => { this.boreIdx = i; this.rebuildTrack(); },
    })));
    row('ROOM', ROOM_NAMES.map((name, i) => ({
      label: name,
      isOn: () => this.roomSizeIdx === i,
      tap: () => {
        this.roomSizeIdx = i;
        if (this.roomOn) this.rebuildTrack();
      },
    })));
    row('BANK', [{
      label: 'AUTO',
      isOn: () => this.autoBank,
      tap: () => { this.autoBank = !this.autoBank; },
    }]);
    row('SMOOTH', [{
      label: 'JOINTS',
      isOn: () => this.smooth,
      tap: () => { this.smooth = !this.smooth; this.rebuildTrack(); },
    }]);
    row('PRESETS', ([
      ['SHAFT', 'shaft'], ['SPIRAL◀', 'spiralLeft'],
      ['SPIRAL▶', 'spiralRight'], ['U-TURN', 'uturn'],
    ] as Array<[string, PresetId]>).map(([label, id]) => ({
      label,
      isOn: () => false,
      tap: () => this.addPreset(id),
    })));

    const close = document.createElement('button');
    close.className = 'density-lab-button density-lab-mode';
    close.textContent = 'DONE';
    close.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePanel(false);
    });
    panel.appendChild(close);

    this.hud.appendChild(panel);
    this.panel = panel;
  }

  private togglePanel(show?: boolean): void {
    if (!this.panel) return;
    const want = show ?? this.panel.style.display === 'none';
    this.panel.style.display = want ? '' : 'none';
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
      <b>monorail rig</b> · ${this.mode.toUpperCase()}
      · pieces ${this.pieces.length} · track ${end.lengthMm.toFixed(0)} mm
      · faults ${faults} · carve ${this.carveMs.toFixed(0)} ms<br>
      aim ${this.aimPitchDeg.toFixed(0)}° pitch · ${this.aimHeadingDeg.toFixed(0)}° heading
      · last ${last ? pieceLabel(last) : '—'}
      · bore ${this.boreRadiusMm} mm<br>
      ant ${this.antS.toFixed(1)} / ${end.lengthMm.toFixed(0)} mm
      · ends in ${this.roomOn
    ? `the ${ROOM_NAMES[this.roomSizeIdx]!} room` : 'a junction'}<br>
      hold DIG/space to dig · W/S ride · drag aims (1st person) or orbits
      · E mode · hold MODE for options · V view · X soil · T tags · U undo
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
      if (this.firstPerson) {
        /* In her eyes the drag IS the aim — one number for the view and
         * the dig, so they can never disagree (the island's hard rule). */
        this.aimHeadingDeg -= e.movementX * 0.25;
        this.aimPitchDeg = Math.min(85, Math.max(-85,
          this.aimPitchDeg - e.movementY * 0.25));
      } else {
        this.camYaw -= e.movementX * 0.005;
        this.camPitch = Math.min(1.45, Math.max(0.05,
          this.camPitch + e.movementY * 0.004));
      }
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId === this.dragPointer) this.dragPointer = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = Math.min(400, Math.max(15, this.camDist * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  /* -------------------------------------------------------------- the ant */

  private readonly antPos = new THREE.Vector3();

  private readonly antUp = new THREE.Vector3(0, 1, 0);

  private readonly antFwd = new THREE.Vector3(0, 0, 1);

  /** Put her on the tunnel floor at `antS`, facing the way she is going. */
  private poseAnt(dt: number): void {
    const length = this.rail.lengthMm;
    const walking = Math.abs(this.walkInput) > 0 ? WALK_SPEED : 0;
    if (length <= 0) {
      this.antPos.set(0, 0, 0);
      this.antUp.set(0, 1, 0);
      this.antFwd.set(
        Math.sin(this.aimHeadingDeg * DEG), 0, Math.cos(this.aimHeadingDeg * DEG),
      );
    } else {
      const f = this.rail.sample(this.antS, this.sampleWindow)!;
      const up = this.antUp.set(f.ux, f.uy, f.uz);
      if (this.walkInput !== 0) this.facingDir = this.walkInput > 0 ? 1 : -1;
      const fwd = this.antFwd.set(f.fx, f.fy, f.fz).multiplyScalar(this.facingDir);
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      // Down the banked floor by the bore's radius, less her leg height.
      const drop = Math.max(0, this.boreRadiusMm - RIDE_MM);
      this.antPos.set(f.x, f.y, f.z).addScaledVector(up, -drop);
    }

    const body = this.queenReady ? this.queen.root : this.cart;
    if (!body) return;
    body.visible = this.queenReady ? !this.firstPerson : true;
    if (this.cart && this.queenReady) this.cart.visible = false;
    const right = new THREE.Vector3().crossVectors(this.antUp, this.antFwd).normalize();
    const trueFwd = new THREE.Vector3().crossVectors(right, this.antUp).normalize();
    body.position.copy(this.antPos);
    body.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, this.antUp, trueFwd),
    );

    if (this.queenReady) {
      this.queen.update(dt, {
        speed: (walking / MODEL_SCALE),
        turn: 0,
        digging: this.digHeld ? 1 : 0,
        carrying: 0,
        headYaw: 0,
      });
      /*
       * Feet against the tunnel floor, approximated as the plane she is
       * standing on: elevation along her up of the floor point under her.
       * Locally exact on the floor line of the bore; the wall-gripping
       * version arrives with the dice rooms.
       */
      const floorElev = this.antPos.x * this.antUp.x
        + this.antPos.y * this.antUp.y + this.antPos.z * this.antUp.z;
      this.queen.solveFeet(
        () => 0,
        FOOT_CLEARANCE_MM,
        RIDE_MM * 2,
        undefined,
        {
          up: [this.antUp.x, this.antUp.y, this.antUp.z],
          surface: () => floorElev,
        },
      );
    }
  }

  /* ------------------------------------------------------------- cameras */

  private aimCamera(dt: number): void {
    this.crosshair.style.display = this.firstPerson ? '' : 'none';
    if (this.firstPerson) {
      const heading = this.aimHeadingDeg * DEG;
      const pitch = this.aimPitchDeg * DEG;
      const look = new THREE.Vector3(
        Math.sin(heading) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(heading) * Math.cos(pitch),
      );
      const eye = this.antPos.clone()
        .addScaledVector(this.antUp, 2.6)
        .addScaledVector(this.antFwd, 1.2);
      this.camera.position.copy(eye);
      this.camera.up.copy(this.antUp);
      this.camera.lookAt(eye.x + look.x, eye.y + look.y, eye.z + look.z);
      return;
    }
    this.camTarget.lerp(this.antPos, Math.min(1, dt * 6));
    const cp = Math.cos(this.camPitch);
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * this.camDist * cp,
      this.camTarget.y + Math.sin(this.camPitch) * this.camDist,
      this.camTarget.z + Math.cos(this.camYaw) * this.camDist * cp,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 1.5, this.camTarget.z);
  }

  /* ------------------------------------------------------------- the loop */

  private simulate(dt: number): void {
    // Keyboard aim, for the hand not on a mouse: arrows steer the look.
    // (Held keys write walkInput/digHeld directly; see buildControls.)

    if (this.digHeld && this.mode === 'tubes') {
      this.growAccum += GROW_RATE * dt;
      const quantum = PIECE_LENGTHS_MM[this.lengthIdx]!;
      while (this.growAccum >= quantum) {
        this.growAccum -= quantum;
        this.growTube();
      }
    }

    if (this.walkInput !== 0 && this.rail.lengthMm > 0) {
      this.antS = Math.min(this.rail.lengthMm,
        Math.max(0, this.antS + this.walkInput * WALK_SPEED * dt));
    }

    this.poseAnt(dt);
    this.refreshReadout();
    this.aimCamera(dt);
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setAimForTest(headingDeg: number, pitchDeg: number): void {
    this.aimHeadingDeg = headingDeg;
    this.aimPitchDeg = pitchDeg;
  }

  setDigForTest(held: boolean): void {
    this.digHeld = held;
    if (!held) this.growAccum = 0;
  }

  setModeForTest(mode: 'tubes' | 'rooms'): void {
    this.mode = mode;
    if (this.modeBtn) this.modeBtn.textContent = mode.toUpperCase();
  }

  setWalkForTest(dir: -1 | 0 | 1): void { this.walkInput = dir; }

  setViewForTest(first: boolean): void { this.firstPerson = first; }

  toggleRoomForTest(): void { this.toggleRoom(); }

  addPresetForTest(id: PresetId): void { this.addPreset(id); }

  undoForTest(): void { this.undo(); }

  clearForTest(): void { this.clear(); }

  setAutoBankForTest(on: boolean): void { this.autoBank = on; }

  setSmoothForTest(on: boolean): void {
    this.smooth = on;
    this.rebuildTrack();
  }

  piecesForTest(): DigPiece[] { return this.pieces.map((p) => ({ ...p })); }

  labelsForTest(): string[] { return [...this.labelTexts]; }

  labelSpritesForTest(): number { return this.labelGroup.children.length; }

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

  antForTest(): Record<string, number> {
    return {
      s: this.antS,
      x: this.antPos.x,
      y: this.antPos.y,
      z: this.antPos.z,
      queen: this.queenReady ? 1 : 0,
      firstPerson: this.firstPerson ? 1 : 0,
      camX: this.camera.position.x,
      camY: this.camera.position.y,
      camZ: this.camera.position.z,
    };
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
      cartS: this.antS,
      riding: 0,
      smooth: this.smooth ? 1 : 0,
      autoBank: this.autoBank ? 1 : 0,
      planNodes: plan.nodes.length,
      planEdges: plan.edges.length,
      planFaults: validatePlan(plan).length,
      carveMs: this.carveMs,
      labels: this.labelGroup.children.length,
      soilMode: this.soilMode === 'xray' ? 0 : this.soilMode === 'solid' ? 1 : 2,
      mode: this.mode === 'tubes' ? 0 : 1,
      roomOn: this.roomOn ? 1 : 0,
      roomMm: this.roomOn ? ROOM_RADII_MM[this.roomSizeIdx]! : 0,
      boreMm: this.boreRadiusMm,
      planChambers: plan.nodes.filter((n) => n.kind === 'chamber').length,
      aimHeadingDeg: this.aimHeadingDeg,
      aimPitchDeg: this.aimPitchDeg,
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
