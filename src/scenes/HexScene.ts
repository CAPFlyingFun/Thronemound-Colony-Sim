/**
 * Hex-grid test room — an experiment, reachable only at `?scene=hex`.
 *
 * The question it exists to answer: does DIGGING a hex grid feel better than
 * digging a cube grid? So it is first-person and playable, with the same
 * controls, the same dig timing and the same soil colours as the cube room —
 * the grid is meant to be the only variable.
 *
 * Deliberately NOT built on DigScene. That scene's raycasting is a cubic DDA,
 * its collision is axis-separated AABBs, and its six-axis wall-walking rests on
 * "every surface is an axis-aligned cube face". A hex prism has eight faces and
 * its six sides are not axis-aligned, so none of that survives contact with it.
 * Rather than bend the parts that currently work, this carries its own small
 * controller.
 *
 * The chipping model is also deliberately different, because it is the other
 * half of the idea being tested: instead of breaking into 125 crumbs, ONE HEX
 * rounds off into ONE CLOD. If a single cell is already clod-sized, that is the
 * cheapest possible "dig a piece, carry the piece".
 *
 * If it wins, this is the sketch a port starts from. If it loses, deleting the
 * file costs nothing.
 */

import * as THREE from 'three';
import {
  HEX_AIR, HEX_HEIGHT, HEX_RADIUS, HexWorld, hexAt, hexCentre, hexCorners, meshHexWorld,
} from '../voxel/HexGrid';
import { voxelTint } from '../voxel/mesher';
import { DEFAULT_BANDS, DEFAULT_GAIT, approach, clampStickOrigin, speedForStick, stickVector } from '../voxel/locomotion';
import { DIG_START } from '../voxel/DigSession';

/**
 * ONE LARGE HEX, not a plain.
 *
 * The cube room is an open field cut off by the draw distance, which tells you
 * nothing about the grid you are standing on — and a hex field read exactly the
 * same way, because from eye level a tiling of any shape is just ground. So the
 * room is a hexagonal CHAMBER: a pit carved out of the plot, with six soil
 * walls rising around you. The grid announces itself before you have dug
 * anything, and there is something to stand against.
 *
 * The rim is deliberately thick. Thin enough to see daylight through and the
 * walls stop reading as soil and start reading as a fence.
 */
const ROOM_RADIUS = 11;
const CHAMBER_RADIUS = 6;
const CHAMBER_HEIGHT = 4;
const ROOM_DEPTH = 15;
const SURFACE = 0;
/** Top of the chamber floor — where she stands, and where digging starts. */
const FLOOR_Y = SURFACE - CHAMBER_HEIGHT;
const FLOOR_TOP = FLOOR_Y + HEX_HEIGHT / 2;

const EYE_HEIGHT = 0.7;
const BODY_RADIUS = 0.28;
const GRAVITY = 12;
const STEP_HEIGHT = 1.05;
const WALK_ACCEL = 14;
const WALK_DECEL = 22;
const KEY_MAGNITUDE = 0.7;
const STICK_RADIUS = 70;
const REACH = 2.4;

/** Hardness per layer, matching the cube world's ratios. */
const HARDNESS = [0, 1, 1.5, 1.25];
const SOIL = [0x000000, 0x9c8460, 0xa8735c, 0xc7b487];
const NAMES = ['', 'Topsoil', 'Clay', 'Sand'];

export class HexScene {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world = new HexWorld(ROOM_RADIUS, ROOM_DEPTH, SURFACE);

  private mesh: THREE.Mesh | null = null;
  private readonly material: THREE.MeshStandardMaterial;
  /** The cell being dug, drawn on its own so it can morph toward a clod. */
  private readonly targetMesh: THREE.Mesh;
  private readonly targetMaterial: THREE.MeshStandardMaterial;

  private readonly position = new THREE.Vector3(0, FLOOR_TOP + 0.4, 0);
  private velocityY = 0;
  private planarSpeed = 0;
  private grounded = false;
  private yaw = 0;
  private pitch = -0.25;

  private digging: { q: number; r: number; y: number } | null = null;
  private progress = 0;
  private dug = 0;

  private moveX = 0;
  private moveZ = 0;
  private stickMagnitude = 0;
  private keyboardDriving = false;
  private jumpQueued = false;

  private readonly hud: HTMLDivElement;
  private readonly actionButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly stick: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;

  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookDown = { x: 0, y: 0, at: 0 };
  private movePointer: number | null = null;
  private moveOrigin = { x: 0, y: 0 };

  private lastTime = 0;
  private hudCounter = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 400);
    this.scene.background = new THREE.Color(0xb9c7d4);
    this.scene.fog = new THREE.Fog(0xb9c7d4, 26, 90);

    this.scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x4a3a26, 1.35));
    const sun = new THREE.DirectionalLight(0xfff2d0, 1.3);
    sun.position.set(20, 40, 15);
    this.scene.add(sun);
    // Tunnels go dark fast down here, same as the cube room.
    const lamp = new THREE.PointLight(0xffd9a0, 1.5, 22, 1.4);
    this.camera.add(lamp);
    this.scene.add(this.camera);

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0, flatShading: true,
    });
    this.targetMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.97, metalness: 0, flatShading: true, color: 0x9c8460,
    });
    this.targetMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.targetMaterial);
    this.targetMesh.frustumCulled = false;
    this.targetMesh.visible = false;
    this.scene.add(this.targetMesh);

    this.hud = document.createElement('div');
    this.hud.className = 'dig-hud';
    this.actionButton = document.createElement('button');
    this.jumpButton = document.createElement('button');
    this.stick = document.createElement('div');
    this.stickKnob = document.createElement('div');
    this.buildOverlay();

    this.carveChamber();
    this.rebuild();
    this.bindInput();
    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));
    this.renderer.setAnimationLoop(this.tick);
  }

  /* -------------------------------------------------------------- world */

  private solidAt(x: number, y: number, z: number): boolean {
    const cell = hexAt(x, y, z);
    return this.world.get(cell.q, cell.r, cell.y) !== HEX_AIR;
  }

  /**
   * Hollow the chamber out of the plot, leaving a thick hexagonal rim.
   *
   * Done by digging rather than by teaching the generator about chambers: `dig`
   * is already the one way a cell becomes air, so the room starts in a state
   * the rest of the scene can reach by playing, and there is no second notion
   * of emptiness to keep in step with the first.
   */
  private carveChamber(): void {
    for (let y = SURFACE; y > FLOOR_Y; y--) {
      for (let q = -CHAMBER_RADIUS; q <= CHAMBER_RADIUS; q++) {
        for (let r = -CHAMBER_RADIUS; r <= CHAMBER_RADIUS; r++) {
          const distance = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
          if (distance <= CHAMBER_RADIUS) this.world.dig(q, r, y);
        }
      }
    }
  }

  /**
   * Rebuild the room mesh, optionally hiding the cell being worked.
   *
   * Same trick the cube scene uses: the world stays the single source of truth
   * and the mask is render-only, so the morphing prism can be drawn in the
   * cell's place without anything else believing it is gone.
   */
  private rebuild(): void {
    const hidden = this.digging;
    const view: HexWorld = hidden
      ? ({
        get: (q: number, r: number, y: number) => (
          q === hidden.q && r === hidden.r && y === hidden.y ? HEX_AIR : this.world.get(q, r, y)
        ),
        all: () => this.world.all(),
      } as unknown as HexWorld)
      : this.world;

    const data = meshHexWorld(view, (q, r, y) => voxelTint(q, y, r));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    const rgb = new Float32Array(data.positions.length);
    for (let i = 0; i < data.positions.length; i += 3) {
      const depth = SURFACE - Math.round(data.positions[i + 1]! / HEX_HEIGHT);
      const colour = new THREE.Color(SOIL[layerOf(depth)]!);
      const shade = data.colors[i]!;
      rgb[i] = colour.r * shade;
      rgb[i + 1] = colour.g * shade;
      rgb[i + 2] = colour.b * shade;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();

    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
    } else {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.scene.add(this.mesh);
    }
  }

  /* --------------------------------------------------------- the digging */

  /**
   * The cell the crosshair is on, by marching the view ray.
   *
   * A short fixed-step march rather than three's mesh raycast. The cube world
   * uses an Amanatides & Woo DDA, which is specifically a cubic-grid walk and
   * does not apply here; a proper hex traversal is only worth writing if this
   * experiment wins. Forty-odd samples of a Map lookup costs nothing and — the
   * real reason — it asks the GRID what is solid rather than asking the mesh,
   * so it cannot disagree with collision about where the walls are.
   */
  private target(): { q: number; r: number; y: number } | null {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const step = 0.05;
    for (let t = step; t <= REACH; t += step) {
      const x = this.camera.position.x + dir.x * t;
      const y = this.camera.position.y + dir.y * t;
      const z = this.camera.position.z + dir.z * t;
      const cell = hexAt(x, y, z);
      if (!Number.isFinite(cell.q) || !Number.isFinite(cell.r)) continue;
      if (this.world.get(cell.q, cell.r, cell.y) !== HEX_AIR) return cell;
    }
    return null;
  }

  private toggleDig(): void {
    if (this.digging) {
      this.digging = null;
      this.progress = 0;
      this.targetMesh.visible = false;
      this.rebuild();
      return;
    }
    const cell = this.target();
    if (!cell) return;
    this.digging = cell;
    this.progress = 0;
    this.rebuild();
  }

  private tickDig(dt: number): void {
    const cell = this.digging;
    if (!cell) return;
    const value = this.world.get(cell.q, cell.r, cell.y);
    if (value === HEX_AIR) {
      this.digging = null;
      this.targetMesh.visible = false;
      return;
    }
    this.progress += dt / (DIG_START * (HARDNESS[value] ?? 1));

    if (this.progress >= 1) {
      this.world.dig(cell.q, cell.r, cell.y);
      this.digging = null;
      this.progress = 0;
      this.dug++;
      this.targetMesh.visible = false;
      this.rebuild();
      return;
    }
    this.paintTarget(cell, this.progress, value);
  }

  /**
   * Draw the cell being worked as a prism that rounds off into a clod.
   *
   * This is the idea under test: one hex IS one clod, so digging need not break
   * it into crumbs at all — the cell loosens and rounds until it is the lump you
   * would carry away. Compare against the cube room, where the same job takes
   * 125 pieces to read as anything at all.
   */
  private paintTarget(cell: { q: number; r: number; y: number }, progress: number, value: number): void {
    const centre = hexCentre(cell.q, cell.r, cell.y);
    const corners = hexCorners();
    const half = HEX_HEIGHT / 2;

    // Prism vertices: bottom ring 0..5, top ring 6..11.
    const verts: number[][] = [];
    for (const sign of [-1, 1]) {
      for (const c of corners) verts.push([c.x, sign * half, c.z]);
    }

    // Ice to egg: lerp every vertex toward a ball as the dig proceeds, and
    // shrink slightly so the loosened lump sits inside the socket it came from.
    const round = Math.min(1, progress * 1.15);
    const shrink = 1 - progress * 0.22;
    const ball = HEX_RADIUS * 0.72;
    const shaped = verts.map(([x, y, z]) => {
      const len = Math.hypot(x!, y!, z!) || 1;
      return [
        (x! + ((x! / len) * ball - x!) * round) * shrink,
        (y! + ((y! / len) * ball - y!) * round) * shrink,
        (z! + ((z! / len) * ball - z!) * round) * shrink,
      ];
    });

    // Wound outward, same handedness the room mesh uses. Normals below are
    // derived FROM the winding, so getting this backwards lights the lump from
    // the inside as well as culling the side you are looking at.
    const faces: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      faces.push([i, j + 6, j], [i, i + 6, j + 6]); // sides
    }
    for (let i = 1; i < 5; i++) faces.push([6, 7 + i, 6 + i]); // cap
    for (let i = 1; i < 5; i++) faces.push([0, i, i + 1]);     // floor

    // Flat shaded, so the facets read as broken soil rather than a smooth pebble.
    const positions = new Float32Array(faces.length * 9);
    const normals = new Float32Array(faces.length * 9);
    faces.forEach((f, k) => {
      const [a, b, c] = f as [number, number, number];
      const va = shaped[a]!; const vb = shaped[b]!; const vc = shaped[c]!;
      const ux = vb[0]! - va[0]!; const uy = vb[1]! - va[1]!; const uz = vb[2]! - va[2]!;
      const wx = vc[0]! - va[0]!; const wy = vc[1]! - va[1]!; const wz = vc[2]! - va[2]!;
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      [va, vb, vc].forEach((v, i) => {
        const o = k * 9 + i * 3;
        positions[o] = v[0]!; positions[o + 1] = v[1]!; positions[o + 2] = v[2]!;
        normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz;
      });
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    this.targetMesh.geometry.dispose();
    this.targetMesh.geometry = geometry;
    this.targetMesh.position.set(centre.x, centre.y, centre.z);
    this.targetMaterial.color.set(SOIL[value] ?? SOIL[1]!);
    this.targetMesh.visible = true;
  }

  /* ------------------------------------------------------------ movement */

  private updatePlayer(dt: number): void {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3()
      .addScaledVector(forward, -this.moveZ)
      .addScaledVector(right, this.moveX);
    const magnitude = this.keyboardDriving ? KEY_MAGNITUDE : Math.min(1, this.stickMagnitude);
    const moving = wish.lengthSq() > 1e-6;
    if (moving) wish.normalize();

    // The experiment scene has no gait buttons, so it simply walks.
    const targetSpeed = moving ? speedForStick(magnitude, DEFAULT_GAIT, DEFAULT_BANDS) : 0;
    this.planarSpeed = approach(this.planarSpeed, targetSpeed, WALK_ACCEL, WALK_DECEL, dt);

    if (this.jumpQueued && this.grounded) {
      this.velocityY = Math.sqrt(2 * GRAVITY * 1.4);
      this.grounded = false;
    }
    this.jumpQueued = false;

    const step = wish.multiplyScalar(this.planarSpeed * dt);
    for (const axis of ['x', 'z'] as const) {
      if (step[axis] === 0) continue;
      const next = this.position.clone();
      next[axis] += step[axis];
      if (!this.bodyBlocked(next)) {
        this.position.copy(next);
        continue;
      }
      // Step up, so a one-cell rise is walkable without jumping.
      const lifted = next.clone();
      lifted.y += STEP_HEIGHT;
      if (!this.bodyBlocked(lifted)) this.position.copy(lifted);
    }

    this.velocityY -= GRAVITY * dt;
    this.grounded = false;
    const vertical = this.position.clone();
    vertical.y += this.velocityY * dt;
    if (this.bodyBlocked(vertical)) {
      if (this.velocityY < 0) this.grounded = true;
      this.velocityY = 0;
    } else {
      this.position.copy(vertical);
    }

    // Dug through the floor of the room: put her back on top rather than
    // falling forever, which is the sort of thing a sandbox should just handle.
    if (this.position.y < SURFACE - ROOM_DEPTH - 4) {
      this.position.set(0, SURFACE + 1.5, 0);
      this.velocityY = 0;
    }

    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  /** Sample the body's footprint against the grid. */
  private bodyBlocked(at: THREE.Vector3): boolean {
    const ring: [number, number][] = [
      [0, 0], [BODY_RADIUS, 0], [-BODY_RADIUS, 0], [0, BODY_RADIUS], [0, -BODY_RADIUS],
    ];
    // Samples run from just ABOVE the feet upward: `position` is the contact
    // point, so anything at or below it is the floor she is standing on, not an
    // obstruction. Sampling below her sinks her into the ground instead.
    for (const [ox, oz] of ring) {
      for (const oy of [0.08, EYE_HEIGHT * 0.55]) {
        if (this.solidAt(at.x + ox, at.y + oy, at.z + oz)) return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- HUD */

  private buildOverlay(): void {
    this.hud.innerHTML = `
      <div class="dig-readout" id="hex-readout"></div>
      <div class="dig-crosshair"></div>
      <div class="dig-controls"></div>
      <div class="dig-hint">Left half: walk &nbsp;·&nbsp; Right half: look &nbsp;·&nbsp; Tap soil to dig it</div>
    `;
    const controls = this.hud.querySelector('.dig-controls')!;
    this.actionButton.className = 'dig-btn dig-action';
    this.actionButton.textContent = '⛏ DIG';
    this.jumpButton.className = 'dig-btn dig-jump';
    this.jumpButton.textContent = '↑ JUMP';
    controls.appendChild(this.jumpButton);
    controls.appendChild(this.actionButton);

    this.stick.className = 'dig-stick';
    this.stickKnob.className = 'dig-stick-knob';
    this.stick.appendChild(this.stickKnob);
    this.hud.appendChild(this.stick);
    this.host.appendChild(this.hud);
  }

  private updateHud(): void {
    const readout = this.hud.querySelector('#hex-readout');
    if (!readout) return;
    const cell = this.digging ?? this.target();
    const value = cell ? this.world.get(cell.q, cell.r, cell.y) : HEX_AIR;
    const name = value === HEX_AIR ? '—' : NAMES[value] ?? '?';
    const bar = this.progress > 0
      ? ` ${'▮'.repeat(Math.round(this.progress * 8)).padEnd(8, '▯')}`
      : '';
    readout.innerHTML = `
      <b>Hex room</b> &nbsp; <b>Dug</b> ${this.dug} &nbsp; <b>Depth</b> ${Math.max(0, Math.round(FLOOR_TOP - this.position.y))}<br>
      <span class="dim">v${__APP_VERSION__} · ${__BUILD_TIME__} · experiment · Target: ${name}${bar}</span>
    `;
    const label = this.digging ? '✕ CANCEL' : '⛏ DIG';
    if (this.actionButton.textContent !== label) this.actionButton.textContent = label;
    this.actionButton.classList.toggle('is-cancel', this.digging !== null);
  }

  private showStick(visible: boolean): void {
    this.stick.classList.toggle('is-live', visible);
    if (visible) {
      this.stick.style.left = `${this.moveOrigin.x}px`;
      this.stick.style.top = `${this.moveOrigin.y}px`;
      this.stickKnob.style.transform =
        `translate(${this.moveX * STICK_RADIUS}px, ${this.moveZ * STICK_RADIUS}px)`;
    }
  }

  /* -------------------------------------------------------------- input */

  private bindInput(): void {
    const canvas = this.renderer.domElement;

    const actionDown = (e: Event) => { e.preventDefault(); this.toggleDig(); };
    const jumpDown = (e: Event) => { e.preventDefault(); this.jumpQueued = true; };
    this.actionButton.addEventListener('pointerdown', actionDown);
    this.jumpButton.addEventListener('pointerdown', jumpDown);
    this.cleanups.push(() => {
      this.actionButton.removeEventListener('pointerdown', actionDown);
      this.jumpButton.removeEventListener('pointerdown', jumpDown);
    });

    const down = (e: PointerEvent) => {
      if (e.cancelable) e.preventDefault();
      const zone = canvas.clientWidth * 0.42;
      if (e.clientX < zone && this.movePointer === null) {
        this.movePointer = e.pointerId;
        this.moveOrigin = clampStickOrigin(e.clientX, e.clientY, {
          minX: STICK_RADIUS + 8,
          maxX: Math.max(STICK_RADIUS + 8, zone - STICK_RADIUS - 8),
          minY: canvas.clientHeight * 0.42,
          maxY: canvas.clientHeight - STICK_RADIUS - 12,
        });
        this.showStick(true);
      } else if (this.lookPointer === null) {
        this.lookPointer = e.pointerId;
        this.lookLast = { x: e.clientX, y: e.clientY };
        this.lookDown = { x: e.clientX, y: e.clientY, at: performance.now() };
      }
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) {
        this.yaw -= (e.clientX - this.lookLast.x) * 0.0045;
        this.pitch = THREE.MathUtils.clamp(
          this.pitch - (e.clientY - this.lookLast.y) * 0.0045, -1.5, 1.5,
        );
        this.lookLast = { x: e.clientX, y: e.clientY };
      } else if (e.pointerId === this.movePointer) {
        const v = stickVector(e.clientX - this.moveOrigin.x, e.clientY - this.moveOrigin.y, STICK_RADIUS);
        this.moveX = v.x;
        this.moveZ = v.y;
        this.stickMagnitude = v.magnitude;
        this.keyboardDriving = false;
        this.showStick(true);
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.lookPointer) {
        this.lookPointer = null;
        // A press that went nowhere is a tap: dig whatever it is on.
        const travel = Math.hypot(e.clientX - this.lookDown.x, e.clientY - this.lookDown.y);
        if (travel <= 10 && performance.now() - this.lookDown.at <= 250) this.toggleDig();
      }
      if (e.pointerId === this.movePointer) {
        this.movePointer = null;
        this.moveX = 0;
        this.moveZ = 0;
        this.stickMagnitude = 0;
        this.showStick(false);
      }
    };

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    const contextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', contextMenu);

    const keyDown = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': this.moveZ = -1; this.keyboardDriving = true; break;
        case 'KeyS': case 'ArrowDown': this.moveZ = 1; this.keyboardDriving = true; break;
        case 'KeyA': case 'ArrowLeft': this.moveX = -1; this.keyboardDriving = true; break;
        case 'KeyD': case 'ArrowRight': this.moveX = 1; this.keyboardDriving = true; break;
        case 'Space': this.jumpQueued = true; e.preventDefault(); break;
        case 'KeyF': this.toggleDig(); e.preventDefault(); break;
      }
    };
    const keyUp = (e: KeyboardEvent) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': case 'KeyS': case 'ArrowDown': this.moveZ = 0; break;
        case 'KeyA': case 'ArrowLeft': case 'KeyD': case 'ArrowRight': this.moveX = 0; break;
      }
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);

    this.cleanups.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('contextmenu', contextMenu);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    });
  }

  private resize(): void {
    const width = this.host.clientWidth || window.innerWidth;
    const height = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.hud.classList.toggle('is-short', height < 560);
  }

  private readonly tick = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = this.lastTime === 0 ? 0.016 : Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.updatePlayer(dt);
    this.tickDig(dt);
    if (++this.hudCounter % 6 === 0) this.updateHud();
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    for (const fn of this.cleanups) fn();
    this.mesh?.geometry.dispose();
    this.material.dispose();
    this.targetMesh.geometry.dispose();
    this.targetMaterial.dispose();
    this.renderer.dispose();
    this.hud.remove();
    this.renderer.domElement.remove();
  }
}

function layerOf(depth: number): number {
  return depth < 2 ? 1 : depth < 8 ? 2 : 3;
}
