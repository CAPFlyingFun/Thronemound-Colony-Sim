/**
 * THE ANT MECHANICS SANDBOX — `?scene=sandbox`.
 *
 * A flat-and-bumpy test field for the thing the next phase of the game
 * hangs on: an ant that interacts with the world through its HEAD and
 * MANDIBLES instead of an inventory. Worker and major, seeds, crumbs,
 * twigs at lazy angles, a leaf, rocks too heavy to lift, and a beetle
 * that holds still to be bitten.
 *
 * The interaction grammar, straight from the design brief:
 *
 *   walk → approach → head aims (yaw/pitch within neck limits, the BODY
 *   turning to cover what the neck cannot) → jaws open → close on a grab
 *   point chosen for the object's shape → spring back → carry, or drag
 *   what is too heavy to lift, or refuse what one ant cannot move.
 *
 * The same aim-and-clamp drives BITE against the beetle — grabbing and
 * fighting are one skill with two intentions, which is the plan for
 * combat later. All the judgement calls live in `mandibleReach.ts` where
 * a test can hold them still; this file is the puppetry.
 *
 * One world unit is one millimetre.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { QueenModel } from '../anim/QueenModel';
import { FOOT_CLEARANCE_MM } from '../anim/legDrive';
import {
  carryVerdict, grabPointFor, headAimFor, HEAD_LIMITS,
  type GrabbableSpec, type GrabPoint, type SandboxCaste,
} from './mandibleReach';

const WALK_SPEED = 12;
const TURN_RATE = 2.4;
const RIDE_MM = 1.2;
const MODEL_SCALE = 5;
const DEG = Math.PI / 180;

/** How far away a thing can be and still offer itself as the target. */
const TARGET_RANGE_MM = 26;

/** Jaws close when the head anchor is this near the grab point. */
const CLOSE_MM = 3.2;

/** Seconds for the clamp, and for the spring back to carrying pose. */
const CLAMP_S = 0.3;
const SPRING_S = 0.5;

/** A bite's worth, per caste. */
const BITE_DAMAGE: Record<SandboxCaste, number> = { worker: 12, major: 30 };

type Phase = 'roam' | 'approach' | 'align' | 'clamp' | 'hold';

interface Prop {
  spec: GrabbableSpec;
  mesh: THREE.Object3D;
  /** Bugs have hit points; everything else has none. */
  hp: number;
  alive: boolean;
}

export class SandboxScene {
  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  /* ------------------------------------------------------------- the ant */

  private readonly ants: Record<SandboxCaste, QueenModel> = {
    worker: new QueenModel('worker'),
    major: new QueenModel('major'),
  };

  private readonly antReady: Record<SandboxCaste, boolean> = {
    worker: false, major: false,
  };

  private caste: SandboxCaste = 'worker';

  private readonly antPos = new THREE.Vector3(0, RIDE_MM, -20);

  private facing = 0;

  private walkInput = 0;

  private turnInput = 0;

  /* ------------------------------------------------------- the invisible */

  private phase: Phase = 'roam';

  /** What the jaws are working toward or holding. */
  private engaged: Prop | null = null;

  private grabPoint: GrabPoint | null = null;

  /** 0..1 through the clamp, then through the spring-back. */
  private phaseT = 0;

  /** Carrying or dragging, per the verdict at clamp time. */
  private hauling: 'carry' | 'drag' | null = null;

  private haulFactor = 1;

  /** Smoothed head pose handed to the gait. */
  private headYaw = 0;

  private headPitch = 0;

  private jawSpread = 0;

  /** Intent for the beetle: true bites, false grabs. */
  private biting = false;

  private biteCooldown = 0;

  /* --------------------------------------------------------------- props */

  private readonly props: Prop[] = [];

  private target: Prop | null = null;

  private readonly targetRing: THREE.Mesh;

  private bugBar: HTMLElement | null = null;

  /* ------------------------------------------------------------- cameras */

  private firstPerson = false;

  private camYaw = -0.5;

  private camPitch = 0.42;

  private camDist = 60;

  private dragPointer: number | null = null;

  /* ----------------------------------------------------------------- HUD */

  private readonly hud: HTMLElement;

  private actBtn: HTMLButtonElement | null = null;

  private casteBtn: HTMLButtonElement | null = null;

  private viewBtn: HTMLButtonElement | null = null;

  private readout: HTMLElement | null = null;

  private toastEl: HTMLElement | null = null;

  private toastUntil = 0;

  private paused = false;

  private previous = performance.now();

  private frame = 0;

  private readonly scratch = new THREE.Vector3();

  private readonly jawScratch = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.host = host;
    host.classList.add('density-lab-host');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xc4dcec);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.9);
    sun.position.set(140, 220, 80);
    this.scene.add(sun, new THREE.AmbientLight(0xd2decc, 0.85));

    this.buildGround();
    this.spawnProps();

    for (const caste of ['worker', 'major'] as const) {
      const ant = this.ants[caste];
      ant.root.scale.setScalar(MODEL_SCALE);
      ant.root.visible = false;
      this.scene.add(ant.root);
      void ant.load().then((ok) => { this.antReady[caste] = ok; });
    }

    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(1.6, 2.1, 28),
      new THREE.MeshBasicMaterial({
        color: 0x51e07a, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
      }),
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.scene.add(this.targetRing);

    this.hud = document.createElement('div');
    this.hud.className = 'density-lab-hud';
    host.appendChild(this.hud);
    this.buildControls();
    this.bindKeys();
    this.bindOrbit();

    (window as unknown as { sandboxScene?: unknown }).sandboxScene = this;
    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.ready = true;
    this.animate();
  }

  /* ------------------------------------------------------------- terrain */

  /** Flat in the middle, rolling toward the edges — both test surfaces. */
  groundAt(x: number, z: number): number {
    const r = Math.hypot(x, z);
    const rise = Math.min(1, Math.max(0, (r - 34) / 46));
    return rise * rise * (
      1.5 * Math.sin(x * 0.055) * Math.sin(z * 0.07)
      + 0.9 * Math.sin(x * 0.13 + 1.7) * Math.sin(z * 0.11 + 0.6)
      + 1.1
    );
  }

  private buildGround(): void {
    const span = 280;
    const seg = 140;
    const geometry = new THREE.PlaneGeometry(span, span, seg, seg);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const h = this.groundAt(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      const tint = 0.92 + 0.14 * Math.sin(pos.getX(i) * 1.7) * Math.sin(pos.getZ(i) * 2.1);
      colors[i * 3] = 0.62 * tint;
      colors[i * 3 + 1] = 0.55 * tint;
      colors[i * 3 + 2] = 0.40 * tint;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const ground = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.scene.add(ground);
  }

  /* --------------------------------------------------------------- props */

  private addProp(
    spec: GrabbableSpec, mesh: THREE.Object3D, hp = 0,
  ): void {
    spec.y = this.groundAt(spec.x, spec.z) + spec.y;
    mesh.position.set(spec.x, spec.y, spec.z);
    mesh.rotation.y = spec.yawDeg * DEG;
    this.scene.add(mesh);
    this.props.push({ spec, mesh, hp, alive: hp > 0 });
  }

  private spawnProps(): void {
    const seedMat = new THREE.MeshLambertMaterial({ color: 0xc9a24f });
    const seedGeo = new THREE.SphereGeometry(0.8, 12, 10);
    seedGeo.scale(1, 0.75, 1.35);
    for (const [x, z, yaw] of [[6, -8, 20], [-9, -2, 250], [14, 6, 120]]) {
      this.addProp(
        {
          kind: 'seed', x: x!, y: 0.6, z: z!, yawDeg: yaw!,
          halfLenMm: 1.1, halfWideMm: 0.8, weightMg: 3,
        },
        new THREE.Mesh(seedGeo, seedMat),
      );
    }

    const crumbMat = new THREE.MeshLambertMaterial({ color: 0xa8793e });
    for (const [x, z] of [[-5, 10], [10, 14]]) {
      this.addProp(
        {
          kind: 'crumb', x: x!, y: 0.7, z: z!, yawDeg: 0,
          halfLenMm: 1.2, halfWideMm: 1.2, weightMg: 5,
        },
        new THREE.Mesh(
          new THREE.DodecahedronGeometry(1.1, 0), crumbMat,
        ),
      );
    }

    const twigMat = new THREE.MeshLambertMaterial({ color: 0x77563a });
    for (const [x, z, yaw, len] of [[-16, 8, 35, 9], [4, 22, 100, 12], [22, -6, 160, 7]]) {
      const geo = new THREE.CylinderGeometry(0.45, 0.55, len! * 2, 10);
      geo.rotateX(Math.PI / 2);
      this.addProp(
        {
          kind: 'twig', x: x!, y: 0.5, z: z!, yawDeg: yaw!,
          halfLenMm: len!, halfWideMm: 0.5, weightMg: 4 + len! * 0.4,
        },
        new THREE.Mesh(geo, twigMat),
      );
    }

    const leafGeo = new THREE.CircleGeometry(4, 20);
    leafGeo.scale(1, 1.4, 1);
    leafGeo.rotateX(-Math.PI / 2);
    this.addProp(
      {
        kind: 'leaf', x: -14, y: 0.35, z: -12, yawDeg: 60,
        halfLenMm: 5.6, halfWideMm: 4, weightMg: 4,
      },
      new THREE.Mesh(leafGeo, new THREE.MeshLambertMaterial({
        color: 0x5d8f3f, side: THREE.DoubleSide,
      })),
    );

    const rockMat = new THREE.MeshLambertMaterial({ color: 0x8d8d94 });
    for (const [x, z, r, mg] of [[18, 20, 2.4, 22], [-22, -6, 3.4, 55], [30, -14, 4.4, 120]]) {
      this.addProp(
        {
          kind: 'rock', x: x!, y: r! * 0.7, z: z!, yawDeg: 0,
          halfLenMm: r!, halfWideMm: r!, weightMg: mg!,
        },
        new THREE.Mesh(new THREE.DodecahedronGeometry(r!, 1), rockMat),
      );
    }

    /* The combat dummy: a stylised beetle who has signed a waiver. */
    const beetle = new THREE.Group();
    const shellMat = new THREE.MeshLambertMaterial({ color: 0x3a2f4d });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(2.6, 14, 12), shellMat);
    shell.scale.set(1, 0.72, 1.35);
    shell.position.y = 1.5;
    beetle.add(shell);
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 10), shellMat);
    head.position.set(0, 1.15, 3.7);
    beetle.add(head);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x241d31 });
    for (let i = 0; i < 6; i += 1) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.1, 2.6, 6), legMat);
      const side = i % 2 === 0 ? 1 : -1;
      leg.position.set(side * 2.3, 0.8, (Math.floor(i / 2) - 1) * 1.8);
      leg.rotation.z = side * 1.0;
      beetle.add(leg);
    }
    this.addProp(
      {
        kind: 'bug', x: 0, y: 0, z: 26, yawDeg: 200,
        halfLenMm: 3.6, halfWideMm: 2.6, weightMg: 45,
      },
      beetle,
      100,
    );
  }

  /* ------------------------------------------------------ the target eye */

  private ant(): QueenModel { return this.ants[this.caste]; }

  /** The head anchor the aim is measured from: her jaws, or a stand-in. */
  private headAnchor(into: THREE.Vector3): void {
    if (this.antReady[this.caste] && this.ant().jawPosition(into)) return;
    into.set(
      this.antPos.x + Math.sin(this.facing) * 3.4,
      this.antPos.y + 1.0,
      this.antPos.z + Math.cos(this.facing) * 3.4,
    );
  }

  private pickTarget(): void {
    if (this.phase !== 'roam') return;
    let best: Prop | null = null;
    let bestD = TARGET_RANGE_MM;
    for (const p of this.props) {
      const dx = p.spec.x - this.antPos.x;
      const dz = p.spec.z - this.antPos.z;
      const d = Math.hypot(dx, dz);
      if (d >= bestD) continue;
      const heading = Math.atan2(dx, dz);
      let off = (heading - this.facing) / DEG;
      off = ((off + 540) % 360) - 180;
      if (Math.abs(off) > 80) continue;
      best = p;
      bestD = d;
    }
    this.target = best;
    if (best) {
      this.targetRing.position.set(
        best.spec.x,
        this.groundAt(best.spec.x, best.spec.z) + 0.15,
        best.spec.z,
      );
      const r = Math.max(1.8, best.spec.halfLenMm * 0.9);
      this.targetRing.scale.setScalar(r / 1.85);
      (this.targetRing.material as THREE.MeshBasicMaterial).color.setHex(
        best.alive ? 0xe0553f : 0x51e07a,
      );
      this.targetRing.visible = true;
    } else {
      this.targetRing.visible = false;
    }
    this.refreshAction();
  }

  /* ------------------------------------------------- the grab state loop */

  /** GRAB or BITE pressed: commit to the current target. */
  private beginEngage(bite: boolean): void {
    if (this.phase !== 'roam' || !this.target) return;
    this.engaged = this.target;
    this.biting = bite && this.engaged.alive;
    this.grabPoint = grabPointFor(this.engaged.spec, this.antPos.x, this.antPos.z);
    this.phase = 'approach';
    this.targetRing.visible = false;
    this.refreshAction();
  }

  private release(): void {
    const p = this.engaged;
    if (p && this.hauling === 'carry') {
      /* Set it DOWN ahead of her, on the ground, not dropped from the sky. */
      const x = this.antPos.x + Math.sin(this.facing) * 4;
      const z = this.antPos.z + Math.cos(this.facing) * 4;
      p.spec.x = x;
      p.spec.z = z;
      p.spec.y = this.groundAt(x, z) + p.spec.halfWideMm * 0.7;
      p.mesh.position.set(p.spec.x, p.spec.y, p.spec.z);
    }
    this.engaged = null;
    this.grabPoint = null;
    this.hauling = null;
    this.haulFactor = 1;
    this.phase = 'roam';
    this.phaseT = 0;
    this.refreshAction();
  }

  /** One frame of the approach → align → clamp → hold pipeline. */
  private stepEngage(dt: number): void {
    const p = this.engaged;
    if (!p || !this.grabPoint) return;
    const g = this.grabPoint;
    this.headAnchor(this.jawScratch);
    const dist = Math.hypot(g.x - this.jawScratch.x, g.z - this.jawScratch.z);

    if (this.phase === 'approach' || this.phase === 'align') {
      /* BODY: turn toward the approach heading and close the distance.
       * HEAD: lead the look at the grab point inside neck limits. */
      const aim = headAimFor(
        this.jawScratch.x, this.jawScratch.y, this.jawScratch.z,
        this.facing / DEG,
        g.x, g.y, g.z, g.rollDeg,
      );
      const wantFacing = Math.atan2(g.x - this.antPos.x, g.z - this.antPos.z);
      let err = wantFacing - this.facing;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      const bodyTurn = Math.max(-TURN_RATE, Math.min(TURN_RATE, err * 4));
      this.facing += bodyTurn * dt;
      this.headYaw += (aim.yawDeg * DEG - this.headYaw) * Math.min(1, dt * 8);
      this.headPitch += (aim.pitchDeg * DEG - this.headPitch) * Math.min(1, dt * 8);
      this.jawSpread += (1 - this.jawSpread) * Math.min(1, dt * 6);

      if (this.phase === 'approach') {
        const walk = Math.min(WALK_SPEED, Math.max(2, (dist - CLOSE_MM) * 3));
        if (dist > CLOSE_MM) {
          this.antPos.x += Math.sin(this.facing) * walk * dt;
          this.antPos.z += Math.cos(this.facing) * walk * dt;
        } else if (Math.abs(err) < 18 * DEG) {
          this.phase = 'align';
          this.phaseT = 0;
        }
      } else {
        /* ALIGN: settle until the head is on it, then commit the clamp. */
        this.phaseT += dt;
        const settled = aim.withinLimits && dist < CLOSE_MM * 1.25;
        if (settled && this.phaseT > 0.15) {
          this.phase = 'clamp';
          this.phaseT = 0;
        } else if (this.phaseT > 2.5) {
          this.release(); // it walked away or we cannot get there — let go
        }
      }
      return;
    }

    if (this.phase === 'clamp') {
      this.phaseT += dt / CLAMP_S;
      this.jawSpread = Math.max(0.25, 1 - this.phaseT);
      if (this.phaseT >= 1) {
        if (this.biting && p.alive) {
          p.hp = Math.max(0, p.hp - BITE_DAMAGE[this.caste]);
          this.flash(p);
          if (p.hp <= 0) this.fell(p);
          this.phase = 'roam';
          this.phaseT = 0;
          this.engaged = null;
          this.grabPoint = null;
          this.biteCooldown = 0.5;
          this.refreshAction();
          return;
        }
        const verdict = carryVerdict(p.spec.weightMg, this.caste);
        if (verdict.mode === 'immobile') {
          this.toast('TOO HEAVY FOR ONE ANT');
          this.release();
          return;
        }
        this.hauling = verdict.mode;
        this.haulFactor = verdict.speedFactor;
        this.phase = 'hold';
        this.phaseT = 0;
        this.refreshAction();
      }
      return;
    }

    /* HOLD: the head springs back toward carry pose; the load follows the
     * jaws — in the air if carried, scraping the ground if dragged. */
    this.phaseT = Math.min(1, this.phaseT + dt / SPRING_S);
    const spring = 1 - (1 - this.phaseT) * (1 - this.phaseT);
    this.headYaw *= 1 - Math.min(1, dt * 6) * spring;
    this.headPitch *= 1 - Math.min(1, dt * 6) * spring;
    this.jawSpread = 0.6;
    if (this.hauling === 'carry') {
      p.spec.x = this.jawScratch.x + Math.sin(this.facing) * 0.6;
      p.spec.z = this.jawScratch.z + Math.cos(this.facing) * 0.6;
      p.spec.y = this.jawScratch.y + 0.2;
      p.mesh.position.set(p.spec.x, p.spec.y, p.spec.z);
      p.mesh.rotation.y = this.facing + g.rollDeg * DEG;
    } else {
      /* DRAG: it stays on the ground and trails the jaws. */
      const tx = this.jawScratch.x + Math.sin(this.facing) * 0.4;
      const tz = this.jawScratch.z + Math.cos(this.facing) * 0.4;
      const lag = Math.min(1, dt * 7);
      p.spec.x += (tx - p.spec.x) * lag;
      p.spec.z += (tz - p.spec.z) * lag;
      p.spec.y = this.groundAt(p.spec.x, p.spec.z) + p.spec.halfWideMm * 0.7;
      p.mesh.position.set(p.spec.x, p.spec.y, p.spec.z);
    }
  }

  private flash(p: Prop): void {
    p.mesh.traverse((node) => {
      const m = (node as THREE.Mesh).material as THREE.MeshLambertMaterial;
      if (m && m.emissive) {
        m.emissive.setHex(0xa03020);
        setTimeout(() => m.emissive.setHex(0x000000), 140);
      }
    });
  }

  /** The beetle is out of hit points: it tips over and becomes cargo. */
  private fell(p: Prop): void {
    p.alive = false;
    p.mesh.rotation.z = Math.PI * 0.9;
    p.mesh.position.y = this.groundAt(p.spec.x, p.spec.z) + 1.4;
    this.toast('THE BEETLE IS DOWN — now it is food');
  }

  /* ------------------------------------------------------------ movement */

  private simulate(dt: number): void {
    this.biteCooldown = Math.max(0, this.biteCooldown - dt);

    const busy = this.phase === 'approach' || this.phase === 'align'
      || this.phase === 'clamp';
    if (!busy) {
      this.facing += this.turnInput * TURN_RATE * dt;
      const speed = this.walkInput * WALK_SPEED
        * (this.hauling ? this.haulFactor : 1);
      this.antPos.x += Math.sin(this.facing) * speed * dt;
      this.antPos.z += Math.cos(this.facing) * speed * dt;
      /* Nothing here to wedge on: the sandbox floor is honest ground. */
      this.headYaw *= 1 - Math.min(1, dt * 4);
      this.headPitch *= 1 - Math.min(1, dt * 4);
      if (!this.engaged) this.jawSpread *= 1 - Math.min(1, dt * 5);
    }
    const floor = this.groundAt(this.antPos.x, this.antPos.z) + RIDE_MM;
    this.antPos.y += (floor - this.antPos.y) * Math.min(1, dt * 12);

    if (busy || this.phase === 'hold') this.stepEngage(dt);
    this.pickTarget();
    this.poseAnt(dt);
    this.aimCamera(dt);
    this.updateHud();
  }

  private poseAnt(dt: number): void {
    for (const caste of ['worker', 'major'] as const) {
      this.ants[caste].root.visible = this.antReady[caste]
        && caste === this.caste && !this.firstPerson;
    }
    if (!this.antReady[this.caste]) return;
    const ant = this.ant();
    ant.root.position.copy(this.antPos);
    ant.root.position.y = this.antPos.y - RIDE_MM;
    ant.root.rotation.set(0, this.facing, 0);
    const busy = this.phase !== 'roam';
    ant.update(dt, {
      speed: (this.walkInput !== 0 || this.phase === 'approach'
        ? WALK_SPEED * (this.hauling ? this.haulFactor : 1) : 0) / MODEL_SCALE,
      turn: this.turnInput * TURN_RATE,
      digging: 0,
      carrying: Math.max(this.jawSpread, this.hauling ? 0.7 : 0),
      headYaw: busy ? this.headYaw : 0,
      headPitch: busy ? this.headPitch : undefined,
    });
    ant.solveFeet(
      (x, z) => this.groundAt(x, z),
      FOOT_CLEARANCE_MM,
      RIDE_MM * 2,
    );
  }

  /* ------------------------------------------------------------- cameras */

  private aimCamera(dt: number): void {
    if (this.firstPerson) {
      const fwd = new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      const eye = this.antPos.clone()
        .add(new THREE.Vector3(0, 1.6, 0))
        .addScaledVector(fwd, 2.4);
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0);
      const pitch = this.headPitch;
      this.camera.lookAt(
        eye.x + fwd.x * Math.cos(pitch),
        eye.y + Math.sin(pitch),
        eye.z + fwd.z * Math.cos(pitch),
      );
      return;
    }
    const cp = Math.cos(this.camPitch);
    const desired = new THREE.Vector3(
      this.antPos.x - Math.sin(this.facing + this.camYaw) * this.camDist * cp,
      this.antPos.y + Math.sin(this.camPitch) * this.camDist,
      this.antPos.z - Math.cos(this.facing + this.camYaw) * this.camDist * cp,
    );
    desired.y = Math.max(desired.y, this.groundAt(desired.x, desired.z) + 2.5);
    this.camera.position.lerp(desired, Math.min(1, dt * 7));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.antPos.x, this.antPos.y + 1.5, this.antPos.z);
    void dt;
  }

  /* ----------------------------------------------------------------- HUD */

  private buildControls(): void {
    const right = document.createElement('div');
    right.className = 'density-lab-actions';
    this.hud.appendChild(right);

    this.actBtn = document.createElement('button');
    this.actBtn.className = 'density-lab-button density-lab-dig';
    this.actBtn.textContent = 'GRAB';
    this.actBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pressAction();
    });
    right.appendChild(this.actBtn);

    const left = document.createElement('div');
    left.className = 'density-lab-actions';
    left.style.left = 'max(16px, env(safe-area-inset-left))';
    left.style.right = 'auto';
    left.style.alignItems = 'flex-start';
    this.hud.appendChild(left);

    const hold = (
      label: string, set: (on: boolean) => void, parent: HTMLElement,
    ): void => {
      const button = document.createElement('button');
      button.className = 'density-lab-button density-lab-dig';
      button.style.width = '58px';
      button.style.height = '58px';
      button.textContent = label;
      button.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.setPointerCapture(e.pointerId);
        set(true);
      });
      const stop = (): void => set(false);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('lostpointercapture', stop);
      parent.appendChild(button);
    };
    hold('⇧', (on) => { this.walkInput = on ? 1 : 0; }, left);
    hold('⇩', (on) => { this.walkInput = on ? -1 : 0; }, left);
    const turnRow = document.createElement('div');
    turnRow.style.display = 'flex';
    turnRow.style.gap = '11px';
    left.appendChild(turnRow);
    hold('◀', (on) => { this.turnInput = on ? 1 : 0; }, turnRow);
    hold('▶', (on) => { this.turnInput = on ? -1 : 0; }, turnRow);

    const top = document.createElement('div');
    top.style.position = 'absolute';
    top.style.top = 'max(14px, env(safe-area-inset-top))';
    top.style.right = 'max(16px, env(safe-area-inset-right))';
    top.style.display = 'flex';
    top.style.gap = '10px';
    top.style.pointerEvents = 'auto';
    this.hud.appendChild(top);

    this.casteBtn = document.createElement('button');
    this.casteBtn.className = 'density-lab-button density-lab-mode';
    this.casteBtn.textContent = 'WORKER';
    this.casteBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setCaste(this.caste === 'worker' ? 'major' : 'worker');
    });
    top.appendChild(this.casteBtn);

    this.viewBtn = document.createElement('button');
    this.viewBtn.className = 'density-lab-button density-lab-mode';
    this.viewBtn.textContent = 'HER EYES';
    this.viewBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.setFirstPerson(!this.firstPerson);
    });
    top.appendChild(this.viewBtn);

    this.readout = document.createElement('div');
    this.readout.className = 'density-lab-status rail-status';
    this.hud.appendChild(this.readout);

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'density-lab-status rail-status';
    this.toastEl.style.top = '58px';
    this.toastEl.style.display = 'none';
    this.hud.appendChild(this.toastEl);

    this.bugBar = document.createElement('div');
    this.bugBar.className = 'density-lab-status rail-status';
    this.bugBar.style.top = 'auto';
    this.bugBar.style.bottom = 'max(14px, env(safe-area-inset-bottom))';
    this.bugBar.style.left = '50%';
    this.bugBar.style.transform = 'translateX(-50%)';
    this.bugBar.style.display = 'none';
    this.hud.appendChild(this.bugBar);
  }

  private pressAction(): void {
    if (this.phase === 'hold') {
      this.release();
      return;
    }
    if (this.phase === 'roam' && this.target) {
      if (this.target.alive && this.biteCooldown <= 0) this.beginEngage(true);
      else if (!this.target.alive) this.beginEngage(false);
    }
  }

  private setCaste(caste: SandboxCaste): void {
    if (this.phase !== 'roam') this.release();
    this.caste = caste;
    if (this.casteBtn) this.casteBtn.textContent = caste.toUpperCase();
    this.refreshAction();
  }

  private setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    if (this.viewBtn) this.viewBtn.textContent = on ? 'OVER HER' : 'HER EYES';
  }

  private refreshAction(): void {
    if (!this.actBtn) return;
    let label = 'GRAB';
    let enabled = false;
    if (this.phase === 'hold') {
      label = 'DROP';
      enabled = true;
    } else if (this.phase === 'roam' && this.target) {
      if (this.target.alive) {
        label = 'BITE';
        enabled = this.biteCooldown <= 0;
      } else {
        const verdict = carryVerdict(this.target.spec.weightMg, this.caste);
        label = verdict.mode === 'immobile' ? 'TOO HEAVY' : 'GRAB';
        enabled = verdict.mode !== 'immobile';
      }
    } else if (this.phase !== 'roam') {
      label = '…';
    }
    this.actBtn.textContent = label;
    this.actBtn.style.opacity = enabled || this.phase === 'hold' ? '' : '0.45';
  }

  private toast(text: string): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.style.display = '';
    this.toastUntil = performance.now() + 2200;
  }

  private updateHud(): void {
    if (this.toastEl && this.toastUntil < performance.now()) {
      this.toastEl.style.display = 'none';
    }
    const bug = this.props.find((p) => p.spec.kind === 'bug');
    if (this.bugBar && bug) {
      const near = Math.hypot(
        bug.spec.x - this.antPos.x, bug.spec.z - this.antPos.z,
      ) < 40;
      this.bugBar.style.display = near && bug.alive ? '' : 'none';
      if (near && bug.alive) {
        const blocks = Math.round(bug.hp / 10);
        this.bugBar.textContent = `beetle ${'▮'.repeat(blocks)}${'▯'.repeat(10 - blocks)}`;
      }
    }
    if (!this.readout) return;
    const held = this.engaged && this.phase === 'hold'
      ? `${this.hauling === 'drag' ? 'dragging' : 'carrying'} ${this.engaged.spec.kind}`
      : this.phase !== 'roam' ? this.phase : 'jaws empty';
    this.readout.innerHTML = `<b>sandbox</b> · ${this.caste} · ${held}`;
  }

  /* ------------------------------------------------------------- inputs */

  private bindKeys(): void {
    const keys = new Set<string>();
    const apply = (): void => {
      this.walkInput = (keys.has('w') ? 1 : 0) + (keys.has('s') ? -1 : 0);
      this.turnInput = (keys.has('a') ? 1 : 0) + (keys.has('d') ? -1 : 0);
    };
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === ' ') {
        e.preventDefault();
        this.pressAction();
        return;
      }
      if (key === 'v') this.setFirstPerson(!this.firstPerson);
      if (key === 'c') this.setCaste(this.caste === 'worker' ? 'major' : 'worker');
      keys.add(key);
      apply();
    });
    window.addEventListener('keyup', (e) => {
      keys.delete(e.key.toLowerCase());
      apply();
    });
    window.addEventListener('blur', () => {
      keys.clear();
      apply();
    });
  }

  private bindOrbit(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (this.dragPointer !== null) return;
      this.dragPointer = e.pointerId;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragPointer) return;
      this.camYaw -= e.movementX * 0.006;
      this.camPitch = Math.min(1.35, Math.max(0.08, this.camPitch + e.movementY * 0.005));
    });
    const done = (e: PointerEvent): void => {
      if (e.pointerId === this.dragPointer) this.dragPointer = null;
    };
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
    el.addEventListener('wheel', (e) => {
      this.camDist = Math.min(140, Math.max(18, this.camDist + e.deltaY * 0.05));
    }, { passive: true });
  }

  /* -------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.paused = on; }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setWalkForTest(walk: -1 | 0 | 1, turn: -1 | 0 | 1): void {
    this.walkInput = walk;
    this.turnInput = turn;
  }

  setCasteForTest(caste: SandboxCaste): void { this.setCaste(caste); }

  pressForTest(): void { this.pressAction(); }

  teleportMm(x: number, z: number, facingDeg: number): void {
    this.antPos.set(x, this.groundAt(x, z) + RIDE_MM, z);
    this.facing = facingDeg * DEG;
  }

  statsForTest(): Record<string, number | string> {
    const bug = this.props.find((p) => p.spec.kind === 'bug');
    return {
      caste: this.caste,
      phase: this.phase,
      targetKind: this.target?.spec.kind ?? 'none',
      hauling: this.hauling ?? 'none',
      haulFactor: +this.haulFactor.toFixed(2),
      antX: +this.antPos.x.toFixed(1),
      antZ: +this.antPos.z.toFixed(1),
      facingDeg: +(this.facing / DEG).toFixed(0),
      headYawDeg: +(this.headYaw / DEG).toFixed(0),
      headPitchDeg: +(this.headPitch / DEG).toFixed(0),
      bugHp: bug?.hp ?? -1,
      props: this.props.length,
      workerReady: this.antReady.worker ? 1 : 0,
      majorReady: this.antReady.major ? 1 : 0,
      limitsYawDeg: HEAD_LIMITS.yawDeg,
    };
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    for (const caste of ['worker', 'major'] as const) this.ants[caste].dispose();
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
