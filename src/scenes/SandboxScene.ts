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
  carryPose, carryVerdict, dragStandoffMm, grabPointFor, headAimFor,
  HEAD_LIMITS, STRENGTH, type GrabbableSpec, type GrabPoint,
  type SandboxCaste,
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
  /** Falling speed, mm/s — gravity owns every prop nobody is holding. */
  vy: number;
}

/** Where a free prop's centre rests above the ground it sits on. */
const restHeight = (spec: GrabbableSpec): number => {
  if (spec.kind === 'leaf') return 0.35;
  if (spec.kind === 'twig') return 0.55;
  return spec.halfWideMm * 0.7;
};

/** Readable at ant scale — real g would snap things down in two frames. */
const GRAVITY_MM_S2 = 320;

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

  /** Keys and stick combined, −1..1, refreshed each frame. */
  private moveWalk = 0;

  private moveTurn = 0;

  /* ------------------------------------------------------- the invisible */

  private phase: Phase = 'roam';

  /** What the jaws are working toward or holding. */
  private engaged: Prop | null = null;

  private grabPoint: GrabPoint | null = null;

  /** 0..1 through the clamp, then through the spring-back. */
  private phaseT = 0;

  /** Seconds since the engage began — approach gets a hard timeout. */
  private engageT = 0;

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

  /** First-person look pitch, radians — the right-half drag sets it. */
  private fpPitch = 0;

  private camPointer: number | null = null;

  /** A second touch makes the camera drag a PINCH: zoom, not orbit. */
  private pinchPointer: number | null = null;

  private pinchLast = 0;

  private readonly touchAt = new Map<number, { x: number; y: number }>();

  /* ---------------------------------------------------------- joystick */

  private stickPointer: number | null = null;

  private stickBase = { x: 0, y: 0 };

  private stickEl: HTMLElement | null = null;

  private knobEl: HTMLElement | null = null;

  /** Analog −1..1 from the stick; keys write ±1 into the same pair. */
  private stickWalk = 0;

  private stickTurn = 0;

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
    this.props.push({ spec, mesh, hp, alive: hp > 0, vy: 0 });
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
      /* The facing cone only matters at range — anything she is basically
       * standing on is grabbable from any angle; she'll shuffle herself. */
      if (d > 8) {
        const heading = Math.atan2(dx, dz);
        let off = (heading - this.facing) / DEG;
        off = ((off + 540) % 360) - 180;
        if (Math.abs(off) > 80) continue;
      }
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
    this.engageT = 0;
    this.phase = 'approach';
    this.targetRing.visible = false;
    this.refreshAction();
  }

  private release(): void {
    const p = this.engaged;
    if (p && this.hauling === 'carry') {
      /* Let go AHEAD of her, from jaw height — gravity takes it from
       * there. The carried tilt comes OFF: a leaf lies back down flat,
       * a twig keeps the heading it was held at (its spec learns the new
       * axis so the next grab still lines up square). A felled beetle
       * keeps its dead sprawl. */
      const x = this.antPos.x + Math.sin(this.facing) * 4;
      const z = this.antPos.z + Math.cos(this.facing) * 4;
      p.spec.x = x;
      p.spec.z = z;
      p.spec.y = Math.max(p.spec.y, this.groundAt(x, z) + restHeight(p.spec));
      p.vy = 0;
      if (p.spec.kind !== 'bug') {
        p.mesh.rotation.set(0, p.mesh.rotation.y, 0);
        p.spec.yawDeg = p.mesh.rotation.y / DEG;
      }
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
    this.engageT += dt;
    /* Six seconds is a lost cause, whatever phase it died in — release
     * rather than hold the player hostage to a chase that cannot end. */
    if (this.phase !== 'hold' && this.engageT > 6) {
      this.release();
      return;
    }
    /* The grab point tracks the OBJECT, not the moment the button was
     * pressed — a shoved twig used to leave her marching to where it
     * had been, forever. */
    if (this.phase === 'approach' || this.phase === 'align') {
      this.grabPoint = grabPointFor(p.spec, this.antPos.x, this.antPos.z);
    }
    const g = this.grabPoint;
    this.headAnchor(this.jawScratch);
    const dist = Math.hypot(g.x - this.jawScratch.x, g.z - this.jawScratch.z);
    /* The beetle's grab point is its CENTRE — the jaws stop at its shell,
     * not inside it. Everything else closes to the usual jaw gap. */
    const closeMm = p.spec.kind === 'bug'
      ? p.spec.halfWideMm + 0.8 : CLOSE_MM;

    if (this.phase === 'approach' || this.phase === 'align') {
      /* BODY: turn toward the approach heading and close the distance.
       * HEAD: lead the look at the grab point inside neck limits. */
      const aim = headAimFor(
        this.jawScratch.x, this.jawScratch.y, this.jawScratch.z,
        this.facing / DEG,
        g.x, g.y, g.z, g.rollDeg,
      );
      /*
       * Where is the grab point in HER frame? `ahead` is signed — and that
       * sign is the fix for "standing over it and helpless": a point at or
       * behind her jaws walks her BACKWARD until the jaws are over it, so
       * grabbing works right at the object instead of only after a manual
       * three-point turn.
       */
      const relX = g.x - this.antPos.x;
      const relZ = g.z - this.antPos.z;
      const flat = Math.hypot(relX, relZ);
      const ahead = relX * Math.sin(this.facing) + relZ * Math.cos(this.facing);
      const side = relX * Math.cos(this.facing) - relZ * Math.sin(this.facing);
      /* Only steer the body when the point is meaningfully off-centre —
       * atan2 under her feet is noise, and she'd pirouette on it. */
      let err = 0;
      if (flat > 2.2) {
        err = Math.atan2(relX, relZ) - this.facing;
        while (err > Math.PI) err -= 2 * Math.PI;
        while (err < -Math.PI) err += 2 * Math.PI;
        /* A point BEHIND her is reached by backing up, not spinning. */
        if (ahead < -0.5 && Math.abs(err) > Math.PI / 2) {
          err = err > 0 ? err - Math.PI : err + Math.PI;
        }
      }
      const bodyTurn = Math.max(-TURN_RATE, Math.min(TURN_RATE, err * 4));
      this.facing += bodyTurn * dt;
      this.headYaw += (aim.yawDeg * DEG - this.headYaw) * Math.min(1, dt * 8);
      this.headPitch += (aim.pitchDeg * DEG - this.headPitch) * Math.min(1, dt * 8);
      this.jawSpread += (1 - this.jawSpread) * Math.min(1, dt * 6);

      if (this.phase === 'approach') {
        /* Drive the JAWS onto the point: forward when it is out front,
         * backward when it is under or behind her. */
        const jawAhead = (g.x - this.jawScratch.x) * Math.sin(this.facing)
          + (g.z - this.jawScratch.z) * Math.cos(this.facing);
        const advance = jawAhead + dist * 0.25 - closeMm * 0.55;
        if (Math.abs(advance) > 0.45) {
          const walk = Math.max(
            -WALK_SPEED * 0.6, Math.min(WALK_SPEED, advance * 3),
          );
          this.antPos.x += Math.sin(this.facing) * walk * dt;
          this.antPos.z += Math.cos(this.facing) * walk * dt;
        } else if (Math.abs(side) < 1.6 || flat <= 2.2) {
          this.phase = 'align';
          this.phaseT = 0;
        }
      } else {
        /* ALIGN: settle until the head is on it, then commit the clamp. */
        this.phaseT += dt;
        const settled = (aim.withinLimits || flat < 2.4) && dist < closeMm * 1.4;
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
      /* The load's CENTRE rides its own half-extent past the jaws — the
       * fix for rocks and leaves phasing through her head. */
      const pose = carryPose(p.spec);
      p.spec.x = this.jawScratch.x + Math.sin(this.facing) * pose.fwdMm;
      p.spec.z = this.jawScratch.z + Math.cos(this.facing) * pose.fwdMm;
      p.spec.y = this.jawScratch.y + pose.upMm;
      p.mesh.position.set(p.spec.x, p.spec.y, p.spec.z);
      p.mesh.rotation.set(
        -pose.pitchDeg * DEG, this.facing + g.rollDeg * DEG, 0, 'YXZ',
      );
    } else {
      /* DRAG: on the ground, trailing at its own radius plus daylight. */
      const standoff = dragStandoffMm(p.spec);
      const tx = this.jawScratch.x + Math.sin(this.facing) * standoff;
      const tz = this.jawScratch.z + Math.cos(this.facing) * standoff;
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

  /* ------------------------------------------------------------- physics */

  /**
   * The cheap laws: everything falls to its rest height, nothing shares
   * a footprint, and pushing a thing works exactly as well as this caste
   * could drag it — a worker shoulders a seed aside and bounces off the
   * boulder that a major shoves along. Circles in XZ, no torque, no
   * stacking: sandbox physics, honest where the jaws need it.
   */
  private stepProps(dt: number): void {
    const held = this.phase === 'hold' ? this.engaged : null;
    for (const p of this.props) {
      if (p === held) continue;
      const rest = this.groundAt(p.spec.x, p.spec.z) + restHeight(p.spec);
      if (p.spec.y > rest + 0.02) {
        p.vy -= GRAVITY_MM_S2 * dt;
        p.spec.y = Math.max(rest, p.spec.y + p.vy * dt);
      } else {
        p.spec.y = rest;
        p.vy = 0;
      }
    }
    /* Pairwise separation — thirteen props, the naive loop is nothing. */
    for (let i = 0; i < this.props.length; i += 1) {
      const a = this.props[i]!;
      if (a === held) continue;
      for (let j = i + 1; j < this.props.length; j += 1) {
        const b = this.props[j]!;
        if (b === held) continue;
        const rr = a.spec.halfWideMm + b.spec.halfWideMm;
        const dx = b.spec.x - a.spec.x;
        const dz = b.spec.z - a.spec.z;
        const d = Math.hypot(dx, dz);
        if (d >= rr || d < 1e-4) continue;
        const push = (rr - d) / 2;
        const nx = dx / d;
        const nz = dz / d;
        /* The heavier one gives less ground. */
        const wa = a.spec.weightMg;
        const wb = b.spec.weightMg;
        const shareA = wb / (wa + wb);
        a.spec.x -= nx * push * 2 * shareA;
        a.spec.z -= nz * push * 2 * shareA;
        b.spec.x += nx * push * 2 * (1 - shareA);
        b.spec.z += nz * push * 2 * (1 - shareA);
      }
    }
    /* Her body against the clutter: light things get nudged along, heavy
     * things stop her. Strength is the same dial the jaws use. */
    const antR = 2.6;
    for (const p of this.props) {
      /* Never body-shove the thing the jaws are working on — the approach
       * used to punt its own target across the sand, forever chasing it. */
      if (p === held || p === this.engaged) continue;
      const dx = p.spec.x - this.antPos.x;
      const dz = p.spec.z - this.antPos.z;
      const rr = antR + p.spec.halfWideMm;
      const d = Math.hypot(dx, dz);
      if (d >= rr || d < 1e-4) continue;
      const overlap = rr - d;
      const nx = dx / d;
      const nz = dz / d;
      const canShove = p.spec.weightMg <= STRENGTH[this.caste].dragMg && !p.alive;
      if (canShove) {
        p.spec.x += nx * overlap;
        p.spec.z += nz * overlap;
      } else {
        this.antPos.x -= nx * overlap;
        this.antPos.z -= nz * overlap;
      }
    }
    for (const p of this.props) {
      if (p === held) continue;
      p.mesh.position.set(p.spec.x, p.spec.y, p.spec.z);
    }
  }

  /* ------------------------------------------------------------ movement */

  private simulate(dt: number): void {
    this.biteCooldown = Math.max(0, this.biteCooldown - dt);

    const busy = this.phase === 'approach' || this.phase === 'align'
      || this.phase === 'clamp';
    this.moveWalk = Math.max(-1, Math.min(1, this.walkInput + this.stickWalk));
    this.moveTurn = Math.max(-1, Math.min(1, this.turnInput + this.stickTurn));
    if (!busy) {
      this.facing += this.moveTurn * TURN_RATE * dt;
      const speed = this.moveWalk * WALK_SPEED
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
    this.stepProps(dt);
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
      speed: (Math.abs(this.moveWalk) > 0.05 || this.phase === 'approach'
        ? WALK_SPEED * Math.max(0.4, Math.abs(this.moveWalk))
          * (this.hauling ? this.haulFactor : 1) : 0) / MODEL_SCALE,
      turn: this.moveTurn * TURN_RATE,
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
      /* The right-half drag owns the look; a grab in progress borrows the
       * eyes so you watch the jaws do the work. */
      const pitch = this.phase === 'roam' ? this.fpPitch : this.headPitch;
      this.camera.lookAt(
        eye.x + fwd.x * Math.cos(pitch),
        eye.y + Math.sin(pitch),
        eye.z + fwd.z * Math.cos(pitch),
      );
      return;
    }
    /*
     * LOCK-IN: while she walks and no thumb owns the view, the orbit
     * eases back behind her — about 1.2 s to settle — so the camera ends
     * up travelling the way she is going without ever being wrestled.
     */
    if (this.camPointer === null && Math.abs(this.moveWalk) > 0.12) {
      let yaw = this.camYaw % (Math.PI * 2);
      if (yaw > Math.PI) yaw -= Math.PI * 2;
      if (yaw < -Math.PI) yaw += Math.PI * 2;
      this.camYaw = yaw * (1 - Math.min(1, dt * 2.5));
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

    /* The joystick: touch anywhere on the LEFT half and it appears under
     * the thumb — a real stick, analog in both axes, not four buttons. */
    const stick = document.createElement('div');
    stick.style.cssText = 'position:absolute;width:104px;height:104px;'
      + 'border-radius:50%;border:2px solid rgba(255,248,230,0.7);'
      + 'background:rgba(60,50,36,0.25);display:none;pointer-events:none;'
      + 'transform:translate(-50%,-50%);';
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:46px;'
      + 'height:46px;border-radius:50%;background:rgba(233,195,111,0.95);'
      + 'box-shadow:0 3px 10px rgba(0,0,0,0.3);'
      + 'transform:translate(-50%,-50%);';
    stick.appendChild(knob);
    this.hud.appendChild(stick);
    this.stickEl = stick;
    this.knobEl = knob;

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
    if (this.phase === 'approach' || this.phase === 'align' || this.phase === 'clamp') {
      this.release(); // CANCEL — the player is never locked out of the button
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
      label = 'CANCEL';
      enabled = true;
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

  /**
   * The screen in two halves: LEFT is the joystick, RIGHT pans the view —
   * in third person it orbits her, in first person it turns her head and
   * body, in both cases with the same thumb.
   */
  private bindOrbit(): void {
    const el = this.renderer.domElement;
    const STICK_RANGE = 46;
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
        /* Second finger on the right half: the drag becomes a pinch. */
        this.pinchPointer = e.pointerId;
        this.touchAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const a = this.touchAt.get(this.camPointer!);
        if (a) this.pinchLast = Math.hypot(e.clientX - a.x, e.clientY - a.y);
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (this.touchAt.has(e.pointerId)) {
        this.touchAt.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this.camPointer !== null && this.pinchPointer !== null) {
        if (e.pointerId !== this.camPointer && e.pointerId !== this.pinchPointer) return;
        const a = this.touchAt.get(this.camPointer);
        const b = this.touchAt.get(this.pinchPointer);
        if (!a || !b) return;
        const now = Math.hypot(b.x - a.x, b.y - a.y);
        if (this.pinchLast > 1) {
          this.camDist = Math.min(140, Math.max(14, this.camDist * (this.pinchLast / now)));
        }
        this.pinchLast = now;
        return;
      }
      if (e.pointerId === this.stickPointer) {
        const dx = e.clientX - this.stickBase.x;
        const dy = e.clientY - this.stickBase.y;
        const len = Math.hypot(dx, dy);
        const cap = Math.min(1, len / STICK_RANGE);
        const nx = len > 1e-3 ? (dx / len) * cap : 0;
        const ny = len > 1e-3 ? (dy / len) * cap : 0;
        if (this.knobEl) {
          this.knobEl.style.transform = 'translate(-50%,-50%) '
            + `translate(${nx * STICK_RANGE}px, ${ny * STICK_RANGE}px)`;
        }
        this.stickWalk = -ny;
        this.stickTurn = -nx;
        return;
      }
      if (e.pointerId !== this.camPointer) return;
      if (this.firstPerson) {
        this.facing -= e.movementX * 0.005;
        this.fpPitch = Math.min(1.1, Math.max(-1.1, this.fpPitch - e.movementY * 0.004));
      } else {
        this.camYaw -= e.movementX * 0.006;
        this.camPitch = Math.min(1.35, Math.max(0.08, this.camPitch + e.movementY * 0.005));
      }
    });
    const done = (e: PointerEvent): void => {
      if (e.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.stickWalk = 0;
        this.stickTurn = 0;
        if (this.stickEl) this.stickEl.style.display = 'none';
        if (this.knobEl) this.knobEl.style.transform = 'translate(-50%,-50%)';
      }
      if (e.pointerId === this.camPointer) this.camPointer = null;
      if (e.pointerId === this.pinchPointer) this.pinchPointer = null;
      this.touchAt.delete(e.pointerId);
      /* One finger of a pinch lifting leaves the other as a plain drag. */
      if (this.camPointer === null && this.pinchPointer !== null) {
        this.camPointer = this.pinchPointer;
        this.pinchPointer = null;
      }
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
