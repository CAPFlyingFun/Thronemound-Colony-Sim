/**
 * The block room: one cube of dirt, and an ant who can walk all the way
 * round it.
 *
 * This is a deliberate restart. The colony sim grew a streamed world, a
 * climb, a save, a menu and a first-person capsule, and somewhere in that
 * pile the feel of digging broke and stayed broken. Rather than keep
 * bisecting a large room, this is the smallest room that can still be wrong
 * in an interesting way: a 64 mm block of soil, the queen standing on it,
 * and two verbs — walk, dig.
 *
 * Three things are copied from the Godot build rather than invented here,
 * because they are known to work there:
 *
 *   1. THE BLOCK. A cube, not a landscape. Six faces, eight corners, twelve
 *      edges, and every one of them a case that walking has to survive.
 *   2. ADHESION. She walks on the top, the sides and the UNDERSIDE without
 *      falling off. Her "down" is the surface she is on, not the world's.
 *   3. DIGGING AT THE MANDIBLE. The bite is taken at the jaw bone and
 *      reaches out by a bite width measured off her own bones — see
 *      `QueenModel.antennaToJaw` — rather than from a crosshair.
 *
 * ## What is deliberately NOT here
 *
 * No streaming, no save, no menu, no climb machinery, no underground sense,
 * no HUD instruments. Those are the things being re-added one at a time, and
 * a room that starts with them has nothing to tell us.
 *
 * ## Modes, and the head
 *
 * She has a MODE — walk, dig, combat — cycled with `*` and `/` or by tapping
 * the chip above the action button, and the mode decides two things: which
 * action button is on screen at all, and whether her head PITCHES.
 *
 * Her head yaws toward the camera in every mode, because the view can be
 * swung right round her and a body facing north while you look south should
 * not stare rigidly ahead; her gaster swings the other way at 30% of it, as
 * a counterweight. But she only pitches her face while digging. That was the
 * open problem this room was built to answer — the gait held her head up, so
 * a jaw-mounted bite aimed where the ANIMATION pointed rather than where the
 * player was looking. In DIG mode the two are now the same angle.
 */

import * as THREE from 'three';
import './DensityTerrainLabScene.css';
import { DensityField } from '../density/DensityField';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import { FollowCamera } from './FollowCamera';
import { STICK_DEADZONE, clampStickOrigin, stickVector } from '../voxel/locomotion';
import { MODES, cycleMode } from './modes';
import { SENSE_EASE, makeSensed, type SenseUniforms } from './undergroundSense';
import {
  CASTE_BITE_MM, CASTE_LENGTH_MM, HEAD_PITCH_DOWN, HEAD_PITCH_UP, HEAD_YAW_LIMIT,
} from '../anim/hexapod';
import {
  FOOT_CLEARANCE_MM, LegDrive, type DriveReport, type LegSetup,
} from '../anim/legDrive';

/** Millimetres per world unit, the scale the whole project runs on. */
const MM = 5;

/**
 * The block: 64 mm on a side, sampled every half millimetre.
 *
 * Both halves are chosen against the same constraint — the bite. A queen's
 * mandible is 1.75 mm across, so at half-millimetre cells a bite spans three
 * and a half of them, which is enough for the brush to read as a bite rather
 * than a stairstep. Finer would be prettier and cost four times the memory
 * for a room whose whole point is to be small: 129³ samples is 8.6 MB, and
 * the quarter-millimetre version of the same cube would be 69 MB.
 *
 * Sixty-four millimetres is about seven queens end to end — big enough that
 * walking round it is a journey and the faces are not all in shot at once,
 * small enough to see the whole experiment.
 */
const BLOCK_MM = 64;
const CELL_MM = 0.5;
const CELL = CELL_MM / MM;
const BLOCK_CELLS = Math.round(BLOCK_MM / CELL_MM);
/**
 * Air around the block, and it is not padding — it is the only reason the
 * outside of the cube gets a surface at all.
 *
 * Surface nets draws where the field CROSSES zero. Filled as
 * `min(x, SPAN - x, ...)` the field is zero on the boundary sample and
 * positive everywhere inside: it never goes negative, so there is no
 * crossing to draw and the outer faces come out missing or patchy — you can
 * see straight through the block from outside, which is exactly what was
 * reported. Three cells of genuinely negative space on every side gives the
 * mesher the sign change it needs, and the faces close.
 */
const MARGIN_CELLS = 3;
const CELLS = BLOCK_CELLS + MARGIN_CELLS * 2;
const SPAN = CELLS * CELL;
/** The block's own bounds inside that field, and its middle. */
const LOW = MARGIN_CELLS * CELL;
const HIGH = LOW + BLOCK_CELLS * CELL;
const MID = (LOW + HIGH) * 0.5;

/** Cells per meshed chunk, so a bite rebuilds a corner and not the cube. */
const CHUNK = 32;

/** How far off the soil her body rides, and how far a foot may reach. */
const RIDE = 1.4 / MM;
/** The adhesion cast: from this far off her back, in through her soles. */
const GRIP_LIFT = 3 / MM;
const GRIP_REACH = 9 / MM;
/** Looking for the far side of an edge: behind and below, in her own frame. */
const WRAP_ARCS = [0.6, 1.1, 1.7, 2.4];

/** World units per second. Slower than the sim's run — this is a small room. */
const WALK_SPEED = 1.6;
const YAW_RATE = 2.2;
/**
 * How fast the eased stick catches the real one, per second. Ten is a time
 * constant of a tenth of a second: 63% of the way there in 100 ms, 95% in
 * 300. Fast enough to feel direct, slow enough that rolling a thumb round
 * the pad reads as one curve instead of a walk and a turn taking turns.
 */
const STICK_EASE = 10;
/** How fast her up eases onto a new face. Snappy, or corners read as slides. */
/**
 * How steep a grade the gyro will accept, up or down. Her neck stops at 75
 * degrees down and the body has no reason to out-reach where she can look.
 */
const TRIM_LIMIT = (75 * Math.PI) / 180;
const ALIGN = 12;
const SNAP = 14;
const GRAVITY = 9;

/**
 * First person: 90 degrees, down from 120.
 *
 * Wide, because an eye at an ant's head is a centimetre from the soil and a
 * narrow lens shows a wall with no sense of where its edges are. But 120 was
 * reported as dizzying, and it would be: at that width the edges of the frame
 * stretch hard, and everything near the eye — which underground is
 * everything — sweeps across it far faster than it moves. Ninety keeps the
 * context and loses most of the distortion.
 */
const FIRST_PERSON_FOV = 90;
const THIRD_PERSON_FOV = 60;

/**
 * How far one tap of a tuner button moves the eye, in mm, and its pitch, in
 * degrees. Small enough to land on something, big enough to get there.
 */
/**
 * A fifth of a millimetre ahead of the sockets, tuned on the device and kept.
 *
 * Dead on the socket the eye sits just far enough back that her own head
 * clips the near plane. Two taps forward on the tuner cleared it and put the
 * mandibles in shot, so that is where it starts now; the tuner still moves it
 * from here.
 */
/**
 * The head-profile inset: how far to the side the eye sits, how much of her
 * it frames, and how much of the screen it takes. Six millimetres of span is
 * her head and a little of her thorax — enough context to read a nod against,
 * without her legs cluttering it.
 */
const HEAD_INSET_MM = 12;
const HEAD_INSET_SPAN_MM = 6;
const HEAD_INSET_FRACTION = 0.32;
/**
 * How many antenna-to-jaw spans wide a bite is.
 *
 * The rule as given was two, and two is what her anatomy says. Four is a
 * PACING decision on top of it: at two spans a queen's bite takes about
 * 1.4 mm3 and a burrow is half an hour of tapping, which nobody wants to do.
 * Doubling the radius is eight times the soil per bite.
 *
 * Kept as a multiple of the measured span rather than a millimetre figure, so
 * a worker and a major still scale off their own heads.
 */
const BITE_WIDTH_SPANS = 4;
/**
 * How deep the eye must be for the underground view to be at full strength.
 * Five millimetres is a bit over half her body length — a burrow she has her
 * head inside rather than a dip she is crossing.
 */
const SENSE_FULL_MM = 5;
/** How far up to look for soil overhead when measuring that depth. */
const SENSE_PROBE_MM = 14;
const EYE_FORWARD_MM = 0.2;
const EYE_NUDGE_MM = 0.1;
const EYE_NUDGE_DEG = 2;

const STICK_RADIUS = 70;
const LOOK_PER_PIXEL = 0.005;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class BlockScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly follow: FollowCamera;
  private readonly field: DensityField;
  private readonly queen: QueenModel;
  private readonly chunks = new Map<string, THREE.Mesh>();
  /*
   * DOUBLE SIDED, and not as a shrug — as the only honest answer until the
   * mesher is fixed.
   *
   * `buildSurfaceNets` winds its NEGATIVE-facing surfaces backwards. Tallied
   * on this very block, triangle by triangle: the +X, +Y and +Z faces come
   * out ~32,000 wound outward and a few hundred not, while X-, Y- and Z-
   * come out 31,752 wound INWARD and not one correct. Backface culling then
   * removes exactly those three faces, which is the "terrain is not showing
   * on all directions" this room was reported for — and, far more
   * importantly, it is why a tunnel CEILING is invisible from underneath:
   * a ceiling is a -Y surface.
   *
   * The heightfield rooms never showed it because a landscape's surface
   * faces up, and +Y is the case that works.
   *
   * Drawing both sides costs fill rate and hides the bug rather than fixing
   * it. It is not a one-line flip, and that is measured too: inverting the
   * `flip` rule in `addQuad`'s three call sites (`start < 0` to `start > 0`)
   * does not correct the negative faces, it reverses the POSITIVE ones as
   * well — the tally goes from three faces right to none right. So the flag
   * globally reverses the mesh rather than distinguishing the two directions
   * a crossing can face, and whatever actually decides orientation is
   * somewhere else. The next pass at it starts from that, with the
   * watertightness suite's orientation check as the harness.
   */
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0x7a5136, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });

  /**
   * The underground view, faded in by DEPTH.
   *
   * Digging is unreadable from inside a hole: the eye is a millimetre from a
   * wall, the wall is one flat brown, and there is nothing in the picture to
   * tell you which way is out. The sense shader replaces that with contours
   * and a grid — the same one the colony sim uses — so the shape of the space
   * around her is legible even when the lighting says nothing.
   *
   * Driven by how far under the surface the EYE is, not by a flag: none at
   * the surface, full at `SENSE_FULL_MM` below it. A switch would flip on the
   * frame her head crossed the soil, which is exactly the frame she is
   * bobbing across it several times a second.
   */
  private readonly sense: SenseUniforms = makeSensed(this.material);

  /** Where she is, and the frame she is in. `up` is the face she is on. */
  private readonly at = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly forward = new THREE.Vector3(0, 0, 1);
  private readonly velocity = new THREE.Vector3();
  private gripping = true;
  private fallSpeed = 0;
  private walkSpeed = 0;
  private turnRate = 0;
  private ready = false;
  private removed = 0;
  /** Where the last bite landed and how big it was. For probes. */
  private readonly lastBiteAt = new THREE.Vector3();
  private lastBiteRadius = 0;

  /**
   * Where the player is looking, as a pitch. The seam the head tracking will
   * plug into: today it aims the CAMERA only, and the jaws point wherever
   * the gait is holding her head, which is the open problem.
   */
  private aimPitch = 0;

  /**
   * The legs, and after `plantAll` they are what actually moves her. Null
   * until the model has loaded, because the leg homes are read off the rig.
   */
  private drive: LegDrive | null = null;
  private report: DriveReport | null = null;
  /**
   * Which mode she is in, as an index into `MODES`. Decides whether her head
   * pitches with your look and which action button is on screen.
   *
   * Opens in DIG rather than at the top of the ring, because this room exists
   * to test digging and it is reloaded on a phone dozens of times a session.
   * A default that costs a tap every single time is the wrong default.
   */
  private mode = MODES.findIndex((m) => m.id === 'dig');
  private readonly modeButton = document.createElement('button');
  /** The one action button, whose meaning is the mode's. See `setMode`. */
  private readonly actionButton = document.createElement('button');
  /**
   * First person, and the tuning offsets for where its eye sits.
   *
   * The eye starts at the midpoint of her antenna sockets, measured off the
   * rig — see `QueenModel.eyeOffset` — and these are a nudge on top of it,
   * in HER frame, so it can be dialled in on the device and the settled
   * numbers folded back into the code. The tuner disappears with them.
   */
  private firstPerson = false;
  private readonly eyeNudge = new THREE.Vector3();
  private eyePitch = 0;
  private readonly tuner = document.createElement('div');
  private readonly viewButton = document.createElement('button');
  /** Instruments off by default: they cover the thing they measure. */
  private debug = false;
  private readonly debugButton = document.createElement('button');
  private readonly trimButton = document.createElement('button');
  /** The eased stick, which is what actually drives her. See `step`. */
  private driveWalk = 0;
  private driveYaw = 0;
  /**
   * How far her body origin rides above the surface — DERIVED from the legs,
   * not chosen.
   *
   * It began as a hand-picked 1.4 mm and that was the whole reason only two
   * legs could reach the ground: the rig's own foot homes sit at y = +0.27 mm,
   * so her origin is essentially AT her contact plane rather than above it,
   * and lifting the body 1.4 mm lifted every foot target 1.7 mm clear of the
   * block — past the 1.1 mm a front leg has to spare. The rear pair, with
   * 1.83 mm, could just reach, which is exactly what the first run measured:
   * two planted, four groping.
   *
   * In a design where the legs carry the body, the body's height is the legs'
   * business. So it is the feet's own offset, plus the ride clearance.
   */
  private ride = RIDE;

  private readonly input = { walk: 0, yaw: 0, dig: false };
  /**
   * THE GYRO: an attitude she flies to, rather than one the ground picks for
   * her. `pitch` is the GRADE her nose holds against world horizontal, nose-up
   * positive; `hold()` pitches its goal until she is on it.
   *
   * What it is for, measured rather than assumed. Everything about how she sits
   * was, until this, decided entirely by the soil — `hold()` casts through her
   * soles, finds a face, and eases her up onto its normal. Underground that
   * means floor, wall and ceiling normals swapping about beneath her, each swap
   * yanking her whole body: over twenty seconds of tunnelling her nose wandered
   * with a standard deviation of 39.5 degrees and tumbled through 6952 degrees
   * in total. Holding a grade through the same run: 11.0 degrees and 2861, for
   * the same depth reached. Seventy per cent less wander at no cost in
   * progress, which is "the camera going all over the place while digging"
   * with a number attached.
   *
   * What it is NOT for, which corrects what I first assumed of it. It does not
   * unlock digging downward, because nothing was blocking that. Digging while
   * STANDING STILL sinks her 0 mm at any trim — `hold()` grabs the first solid
   * under her and, stood on a plateau beside a pit, that is the plateau. Biting
   * while she WALKS sinks her tens of millimetres with no gyro at all, and
   * trimming nose-down makes entry steadily worse: 44.7 mm untrimmed, 14.1 at
   * -40 degrees, 2.8 at -60, 1.7 at -75, because a steeply pitched body aims
   * its grip cast into intact soil and seats on that instead of travelling.
   * So dig in with it off and switch it on once she is under — which is where
   * it was asked to live in the first place.
   *
   * Off, this is the identity: she lies on the normal exactly as before, and
   * the six-face walk is untouched.
   */
  private readonly trim = { on: false, pitch: 0 };
  private digCooldown = 0;
  /** Set by `setPausedForTest` so probes own the clock. Never set in play. */
  private paused = false;
  /** Why the last bite did nothing, for probes. Cleared on a real bite. */
  private lastBiteWhy = 'never ran';

  private readonly status: HTMLDivElement;
  private readonly stick = document.createElement('div');
  private readonly stickKnob = document.createElement('div');
  private readonly stickOrigin = { x: 0, y: 0 };
  private stickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lookAt = { x: 0, y: 0 };
  private frame = 0;
  /**
   * The head-profile inset's camera. Orthographic and framed on her head —
   * see `renderHeadInset`.
   */
  private readonly headCam = new THREE.OrthographicCamera(
    -HEAD_INSET_SPAN_MM / 2 / MM, HEAD_INSET_SPAN_MM / 2 / MM,
    HEAD_INSET_SPAN_MM / 2 / MM, -HEAD_INSET_SPAN_MM / 2 / MM,
    0.01, 40 / MM,
  );
  private previous = performance.now();
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly host: HTMLElement) {
    host.replaceChildren();
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x8db4d6);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 400);
    this.follow = new FollowCamera(this.camera, {
      distance: 24 / MM, minDistance: 2.4, maxDistance: 24, eyeHeight: 1.8 / MM,
      clearance: CELL * 2, ease: 8,
    });
    this.follow.mode = 'third';

    this.field = new DensityField({
      cellsX: CELLS, cellsY: CELLS, cellsZ: CELLS, cellSize: CELL,
    });
    /*
     * A cube as a signed field: the distance to the nearest face, positive
     * inside. Surface nets rounds the edges by about a cell, which is what a
     * block of soil looks like anyway — a machined corner would be the
     * surprising part.
     */
    this.field.fill((x, y, z) => Math.min(
      x - LOW, HIGH - x, y - LOW, HIGH - y, z - LOW, HIGH - z,
    ));
    this.remeshAll();

    this.addLighting();
    this.queen = new QueenModel('queen');
    this.scene.add(this.queen.root);

    // On top of the block, in the middle, facing +Z.
    this.at.set(MID, HIGH + RIDE, MID);
    this.follow.target.copy(this.at);

    const hud = document.createElement('div');
    hud.className = 'density-lab-hud';
    host.appendChild(hud);
    this.status = document.createElement('div');
    this.status.className = 'density-lab-status';
    hud.appendChild(this.status);
    this.buildControls(hud);

    void this.queen.load().then((ok) => {
      this.ready = ok;
      if (!ok) return;
      this.queen.root.visible = true;
      this.buildLegs();
    });

    (window as unknown as { blockScene?: unknown }).blockScene = this;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.material.dispose();
    this.queen.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }

  private addLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0xc9e6ff, 0x4a2f1f, 1.8));
    const sun = new THREE.DirectionalLight(0xfff1ce, 2.6);
    sun.position.set(SPAN * 1.4, SPAN * 2, SPAN * 0.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const extent = SPAN * 0.9;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;
    sun.shadow.camera.far = SPAN * 6;
    this.scene.add(sun);
    /*
     * A second light from BELOW, which a landscape would never want and this
     * room cannot do without: she spends a third of her time on the
     * underside, and an unlit underside is a black screen with an ant on it.
     */
    const bounce = new THREE.DirectionalLight(0xbfd8ff, 0.9);
    bounce.position.set(-SPAN * 0.6, -SPAN * 2, -SPAN * 0.4);
    this.scene.add(bounce);
  }

  /* ----------------------------------------------------------- the soil */

  /** Signed density at a world point: positive inside the soil. */
  densityAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x > SPAN || y > SPAN || z > SPAN) return -1;
    return this.field.sample(x, y, z);
  }

  solidAt(p: THREE.Vector3): boolean {
    return this.densityAt(p.x, p.y, p.z) > 0;
  }

  /**
   * The outward normal of the soil at a point, from the field's gradient.
   *
   * Central differences at one cell, which on a rounded cube edge gives the
   * blend between two faces rather than a jump — the reason she rounds a
   * corner instead of snapping to the next face.
   */
  normalAt(p: THREE.Vector3, into: THREE.Vector3): THREE.Vector3 {
    const h = CELL;
    into.set(
      this.densityAt(p.x - h, p.y, p.z) - this.densityAt(p.x + h, p.y, p.z),
      this.densityAt(p.x, p.y - h, p.z) - this.densityAt(p.x, p.y + h, p.z),
      this.densityAt(p.x, p.y, p.z - h) - this.densityAt(p.x, p.y, p.z + h),
    );
    if (into.lengthSq() < 1e-12) into.copy(WORLD_UP);
    return into.normalize();
  }

  /** March for the first solid point, and bisect once it is found. */
  private cast(
    from: THREE.Vector3, dir: THREE.Vector3, reach: number,
  ): THREE.Vector3 | null {
    const step = CELL * 0.5;
    const probe = new THREE.Vector3();
    let previous = 0;
    for (let d = 0; d <= reach; d += step) {
      probe.copy(from).addScaledVector(dir, d);
      if (this.solidAt(probe)) {
        let lo = previous;
        let hi = d;
        for (let i = 0; i < 6; i += 1) {
          const mid = (lo + hi) * 0.5;
          probe.copy(from).addScaledVector(dir, mid);
          if (this.solidAt(probe)) hi = mid;
          else lo = mid;
        }
        return probe.copy(from).addScaledVector(dir, hi);
      }
      previous = d;
    }
    return null;
  }

  /* --------------------------------------------------------- the meshing */

  private chunkKey(cx: number, cy: number, cz: number): string {
    return `${cx},${cy},${cz}`;
  }

  private remeshAll(): void {
    const n = Math.ceil(CELLS / CHUNK);
    for (let cz = 0; cz < n; cz += 1) {
      for (let cy = 0; cy < n; cy += 1) {
        for (let cx = 0; cx < n; cx += 1) this.remeshChunk(cx, cy, cz);
      }
    }
  }

  private remeshChunk(cx: number, cy: number, cz: number): void {
    const key = this.chunkKey(cx, cy, cz);
    const existing = this.chunks.get(key);
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
      this.chunks.delete(key);
    }
    const data = buildSurfaceNets(this.field, 0, {
      x0: cx * CHUNK, y0: cy * CHUNK, z0: cz * CHUNK,
      x1: Math.min(CELLS, (cx + 1) * CHUNK),
      y1: Math.min(CELLS, (cy + 1) * CHUNK),
      z1: Math.min(CELLS, (cz + 1) * CHUNK),
    });
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.chunks.set(key, mesh);
  }

  /* ---------------------------------------------------------- the digging */

  /**
   * A bite, taken AT THE MANDIBLE, sized and placed by her own bones.
   *
   * Both numbers come off the rig rather than out of a table, which is what
   * makes them vary per ant instead of by a scale factor:
   *
   *   WIDTH   twice the span from her antenna socket to her jaw. The radius
   *           is therefore that span itself.
   *   WHERE   the point a straight line DOWN from that jaw meets the soil,
   *           down being hers and not the world's.
   *
   * There is no crosshair and no aim ray. The player steers the dig by
   * steering her HEAD — which follows the look in DIG mode — and the hole
   * appears under her face. Nothing in the placement grows as an angle
   * flattens, which is what put a hole six millimetres downrange before.
   */
  private bite(): void {
    this.lastBiteWhy = 'ran';
    if (!this.ready) { this.lastBiteWhy = 'model not ready'; return; }
    const jaw = new THREE.Vector3();
    if (!this.queen.jawPosition(jaw)) { this.lastBiteWhy = 'no jaw bone'; return; }
    /*
     * THE BITE IS SIZED BY HER OWN BONES.
     *
     * "Measure from antennas to bottom of jaw bone and double that for the
     * digging distance" — so the width is a multiple of the antenna-socket-to-
     * jaw span. Measured rather than tabled, which means the worker and the
     * major get their own without anyone typing a number: see
     * `QueenModel.antennaToJaw` and `BITE_WIDTH_SPANS`.
     *
     * It reproduces the hand-picked figure almost exactly, which is the
     * reason to trust it. `CASTE_BITE_MM.queen` was 1.75 mm; twice her
     * measured span is 1.736 mm, inside one percent, off the rig.
     */
    const radius = this.queen.antennaToJaw() * BITE_WIDTH_SPANS / 2;
    if (radius <= 0) { this.lastBiteWhy = 'rig has no antenna-to-jaw span'; return; }

    /*
     * WHY THERE IS NO RAY HERE ANY MORE.
     *
     * The brush used to be dropped on the first solid point along a ray cast
     * up to 9 mm from the jaw. On a flat face with the camera near level that
     * ray is almost a tangent, so it ran a long way before the ground rose
     * into it: the hole landed at `jawHeight / tan(aim)` downrange, which is
     * 6.36 mm at ten degrees off level and unbounded as the aim flattens. At
     * exactly level it found nothing within 9 mm and refused to dig.
     *
     * Her head reaches the soil on its own — the gait's dig dip takes her jaw
     * from 1.121 mm over it to 0.070 mm — so there was never anything to
     * search for.
     */
    /*
     * And it lands where a straight line DOWN from the jaw meets the soil —
     * "make it a straight line from that bone straight down and at that
     * projected point will be that dig radius".
     *
     * Down in HER frame, not the world's, so it works on a wall and on the
     * ceiling. Note there is no aim ray here at all: the player steers the
     * dig by steering her HEAD, which in DIG mode follows the look, and the
     * hole appears under her face. That is why it can never end up six
     * millimetres downrange again — the placement has no term that grows as
     * an angle flattens.
     *
     * The cast starts above the jaw and reaches past it, so it finds the
     * surface whether her face is just over the soil or already inside a
     * tunnel she has dug. With nothing found she bites at the jaw itself,
     * which is the deep-in-a-tunnel case.
     */
    const from = jaw.clone().addScaledVector(this.up, radius * 2);
    const hit = this.cast(from, this.up.clone().negate(), radius * 6);
    const at = hit ?? jaw.clone();
    // Recorded so a probe can measure where the bite ACTUALLY went rather
    // than recompute a formula and agree with itself.
    this.lastBiteAt.copy(at);
    this.lastBiteRadius = radius;
    const result = this.field.subtractSphere(at, radius);
    if (result.changedSamples === 0) { this.lastBiteWhy = 'brush changed nothing'; return; }
    this.lastBiteWhy = '';
    this.removed += result.removedVolume;

    const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CHUNK));
    const hi = (v: number, max: number) => Math.min(
      Math.ceil(max / CHUNK) - 1, Math.floor((v + 1) / CHUNK),
    );
    for (let cz = lo(result.bounds.minZ); cz <= hi(result.bounds.maxZ, CELLS); cz += 1) {
      for (let cy = lo(result.bounds.minY); cy <= hi(result.bounds.maxY, CELLS); cy += 1) {
        for (let cx = lo(result.bounds.minX); cx <= hi(result.bounds.maxX, CELLS); cx += 1) {
          this.remeshChunk(cx, cy, cz);
        }
      }
    }
  }

  /* --------------------------------------------------------- the walking */

  /**
   * One step, in HER frame.
   *
   * Her up is the face she is on and her forward is a tangent of it, so the
   * same code walks the top, a side and the underside — there is no special
   * case for "upside down", because nothing here refers to the world's
   * vertical except gravity, and gravity only applies once she has let go.
   */
  /**
   * Read the leg homes off the rig itself, in her body frame.
   *
   * Not a table of guessed offsets: the model is posed at rest, each leg's
   * tip bone is asked where it is, and the answer is converted into her own
   * frame. Whatever the rig says her stance is, that is what the legs return
   * to — and it stays true if the model is ever re-exported.
   */
  private buildLegs(): void {
    const setup: LegSetup[] = this.queen.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    /*
     * Rest exactly where her own feet say, and NOT a clearance higher. The
     * body's minimum clearance is a safety for when the ground rises into
     * her (see `RIDE_CLEARANCE_MM`); adding it here instead raised her a
     * quarter of a millimetre off the soil before the IK had even had its
     * turn, which with the IK's own 0.5 mm was most of the gap reported
     * under her feet.
     */
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.ride = -meanFootY;
    // Re-seat her at the height her own legs imply before they take over.
    this.at.addScaledVector(this.up, this.ride - RIDE);
    this.drive = new LegDrive(setup);
    this.drive.plantAll(
      { at: this.at, up: this.up, forward: this.forward }, this.groundForLegs,
    );
  }

  /**
   * What the legs are allowed to ask the world. Nearest solid to a point,
   * searched along her own down and then her own up — null is a real answer
   * and means "nothing to stand on here".
   */
  private readonly groundForLegs = {
    nearest: (at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number) => {
      const from = at.clone().addScaledVector(up, rise);
      return this.cast(from, up.clone().negate(), rise + down);
    },
  };

  private step(dt: number): void {
    /*
     * The sign is REPORTED, not reasoned: pushing the stick right turned her
     * left. The lab's own steering carries the same comment for the same
     * reason — forward is (sin h, 0, cos h), so a rising heading swings her
     * nose from +Z toward +X, and with the camera behind her that is the
     * LEFT of the screen. The arithmetic is consistent and is the mirror of
     * what a thumb means.
     */
    /*
     * The stick is EASED before anything reads it.
     *
     * A thumb rolling from twelve o'clock round to nine is a smooth path, but
     * the two axes it lands on are read straight, and the leg system turns
     * them into a per-leg travel direction — `v + ω × r`. Swap walk for yaw in
     * one frame and every one of those six directions swings, so the step
     * targets jump and she snaps from striding to spinning. Easing the
     * COMMAND, not the result, fixes it at the source and leaves the feet's
     * own geometry alone: the twist she is asked for turns over about a tenth
     * of a second, which is quick enough to feel direct and long enough that
     * a full lap of the stick reads as one curve.
     */
    const ease = 1 - Math.exp(-STICK_EASE * dt);
    this.driveWalk += (this.input.walk - this.driveWalk) * ease;
    this.driveYaw += (this.input.yaw - this.driveYaw) * ease;
    /*
     * The sign is REPORTED, not reasoned: pushing the stick right turned her
     * left. The lab's own steering carries the same comment for the same
     * reason — forward is (sin h, 0, cos h), so a rising heading swings her
     * nose from +Z toward +X, and with the camera behind her that is the
     * LEFT of the screen. The arithmetic is consistent and is the mirror of
     * what a thumb means.
     */
    this.turnRate = this.driveYaw * YAW_RATE;
    if (!this.drive) {
      const yaw = this.driveYaw * YAW_RATE * dt;
      if (Math.abs(yaw) > 1e-9) this.forward.applyAxisAngle(this.up, yaw).normalize();
    }

    if (this.drive) {
      /*
       * THE LEGS MOVE HER. The stick proposes, the planted feet constrain,
       * and what survives is her displacement — see `legDrive`.
       */
      const before = this.at.clone();
      this.report = this.drive.step(
        dt,
        { at: this.at, up: this.up, forward: this.forward },
        {
          walk: this.driveWalk,
          yaw: this.driveYaw,
          speed: WALK_SPEED,
          yawRate: YAW_RATE,
          // hold() owns how high she rides in this room. See `DriveInput`.
          settle: false,
        },
        this.groundForLegs,
      );
      /*
       * Speed is what she TRAVELS, measured across her own up — never how far
       * she was re-seated along it. The gait takes this number and decides
       * from it whether she is walking, and a body being nudged up and down
       * by half a millimetre a frame is not walking. Reading the raw
       * displacement had a motionless ant reporting 6.5 mm/s.
       */
      const moved = this.at.clone().sub(before);
      this.velocity.copy(moved).divideScalar(Math.max(dt, 1e-6));
      moved.addScaledVector(this.up, -moved.dot(this.up));
      this.walkSpeed = moved.length() / Math.max(dt, 1e-6);
    } else {
      const wanted = this.forward.clone().multiplyScalar(WALK_SPEED * this.driveWalk);
      this.velocity.lerp(wanted, 1 - Math.exp(-10 * dt));
      this.walkSpeed = this.velocity.length();
      this.at.addScaledVector(this.velocity, dt);
    }

    if (this.gripping) this.hold(dt);
    else this.fall(dt);

    // The forward is re-flattened against whatever up she ended on.
    this.forward.addScaledVector(this.up, -this.forward.dot(this.up));
    if (this.forward.lengthSq() < 1e-8) this.forward.set(this.up.z, this.up.x, this.up.y);
    this.forward.normalize();
  }

  /**
   * How far she can be lifted off her own back before the lift itself is
   * INSIDE something. Nought means she is embedded.
   *
   * `cast` reports a hit at zero distance when its origin is already solid,
   * which is correct for a ray and catastrophic here: `hold()` used to start
   * three millimetres above her without asking whether there was three
   * millimetres of room. Her own tunnels are about five millimetres across, so
   * underground that start point sits in the CEILING — the cast then "hit" the
   * ceiling at zero range, seated her a body-height above it, and did it again
   * the next frame. An elevator to the surface, running at up to three
   * millimetres a frame, dressed up as a grip. Reported twice: teleported to
   * the surface while moving in a tunnel, and now jumping out as soon as she
   * gets underground.
   */
  private clearLift(): number {
    const probe = new THREE.Vector3();
    const step = CELL * 0.5;
    for (let lift = GRIP_LIFT; lift > 0; lift -= step) {
      probe.copy(this.at).addScaledVector(this.up, lift);
      if (!this.solidAt(probe)) return lift;
    }
    return 0;
  }

  /**
   * Hold on: cast from off her back, in through her soles.
   *
   * When it lands she is drawn onto the contact and her up eases onto its
   * normal — that is the whole of walking round a corner. When it finds
   * nothing she has walked over an edge, so the wrap search looks BEHIND AND
   * BELOW her, in her own frame, which is where the far side of an edge is.
   * Only when that is empty too has she genuinely walked off into the air.
   */
  private hold(dt: number): void {
    /*
     * Embedded is its own case, and casting cannot answer it. Her origin being
     * inside soil means every ray out of her starts solid and reports itself
     * at zero range, so the only honest question is which way is OUT — which
     * is what `nearestSurface` marches for.
     */
    if (this.solidAt(this.at)) {
      const out = this.nearestSurface(this.at);
      if (out) {
        const normalOut = new THREE.Vector3();
        this.normalAt(out.point, normalOut);
        this.at.lerp(out.point.clone().addScaledVector(normalOut, this.ride),
          1 - Math.exp(-SNAP * dt));
        this.up.lerp(this.trimmedUp(normalOut), 1 - Math.exp(-ALIGN * dt)).normalize();
        return;
      }
    }
    const lift = this.clearLift();
    const from = this.at.clone().addScaledVector(this.up, lift);
    const dir = this.up.clone().negate();
    let hit = this.cast(from, dir, lift + GRIP_REACH);
    let normal = new THREE.Vector3();

    if (!hit) {
      for (const arc of WRAP_ARCS) {
        const wrapDir = this.up.clone().multiplyScalar(-Math.cos(arc))
          .addScaledVector(this.forward, -Math.sin(arc)).normalize();
        const wrapFrom = this.at.clone().addScaledVector(this.up, GRIP_LIFT * 0.5);
        hit = this.cast(wrapFrom, wrapDir, GRIP_REACH);
        if (hit) break;
      }
    }
    if (!hit) {
      this.gripping = false;
      this.fallSpeed = 0;
      return;
    }
    this.normalAt(hit, normal);
    const seat = hit.clone().addScaledVector(normal, this.ride);
    this.at.lerp(seat, 1 - Math.exp(-SNAP * dt));
    this.up.lerp(this.trimmedUp(normal), 1 - Math.exp(-ALIGN * dt)).normalize();
  }

  /**
   * The attitude she should be holding: the surface normal, pitched until her
   * nose sits at the commanded GRADE.
   *
   * The grade is measured against world horizontal, not against the soil under
   * her, and that distinction is the whole design. Trim taken relative to the
   * local surface compounds: nose down forty, seat on the forty-degree floor
   * that produces, take another forty off THAT, and within a second or two she
   * is vertical and then inverted. A gyroscope holds an attitude in the world,
   * which is exactly what stops the runaway — "descend at forty degrees" is a
   * fixed point, not an increment.
   *
   * Only the pitch is taken. Roll — which way up she is, which face of the
   * block she is on — still comes entirely from the normal, so she keeps
   * walking round corners and along the underside while the gyro is holding
   * her grade.
   */
  private trimmedUp(normal: THREE.Vector3): THREE.Vector3 {
    if (!this.trim.on) return normal;
    const right = new THREE.Vector3().crossVectors(normal, this.forward);
    // Nose straight at the normal leaves no axis to pitch about. Rare, and
    // holding the last attitude through it beats spinning on a degenerate one.
    if (right.lengthSq() < 1e-8) return normal;
    right.normalize();
    // The forward that goes with THIS normal, rather than the stale one.
    const nose = new THREE.Vector3().crossVectors(right, normal).normalize();
    const grade = Math.asin(THREE.MathUtils.clamp(nose.y, -1, 1));
    /*
     * Positive about her right is nose DOWN — rotating the frame about +X
     * carries +Z toward -Y. So closing the gap from where her nose is to where
     * it is asked to be is (grade - commanded), not the other way round. This
     * sign was checked against the model, not reasoned: see probe-gyro.
     */
    return normal.clone().applyAxisAngle(right, grade - this.trim.pitch).normalize();
  }

  /** Is this point within the block's own bounds, rather than outside it? */
  private insideBlock(p: THREE.Vector3): boolean {
    const m = CELL * 2;
    return p.x > LOW + m && p.x < HIGH - m
      && p.y > LOW + m && p.y < HIGH - m
      && p.z > LOW + m && p.z < HIGH - m;
  }

  /**
   * The nearest bit of surface to a point buried in soil, searched outward
   * along her own axes. What an ant in a tunnel takes hold of.
   */
  private nearestSurface(p: THREE.Vector3): { point: THREE.Vector3 } | null {
    const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
    const dirs = [
      this.up.clone().negate(), this.up.clone(),
      right, right.clone().negate(),
      this.forward.clone(), this.forward.clone().negate(),
    ];
    /*
     * Marched OUT of the soil, not cast back into it.
     *
     * This used to start `GRIP_REACH` away and cast inward, which only works
     * when that start point is in open air. Buried deeper than the reach it is
     * in soil too, so `cast` returned its own origin — nine millimetres from
     * her, in the middle of solid ground, reported as a face. Every direction
     * tied at exactly that distance, the first won, and she was seated on a
     * fiction with a zero-gradient normal that falls back to world up. Walking
     * out of the soil to where it STOPS being solid needs no such assumption
     * and is the boundary by definition.
     */
    const step = CELL * 0.5;
    const probe = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    let bestDist = Infinity;
    for (const dir of dirs) {
      for (let d = 0; d <= GRIP_REACH; d += step) {
        probe.copy(p).addScaledVector(dir, d);
        if (this.solidAt(probe)) continue;
        if (d < bestDist) { bestDist = d; best = probe.clone(); }
        break;
      }
    }
    return best ? { point: best } : null;
  }

  /** Off the block: straight down, world frame, until something catches. */
  private fall(dt: number): void {
    this.fallSpeed += GRAVITY * dt;
    this.at.y -= this.fallSpeed * dt;
    const probe = this.at.clone();
    /*
     * INSIDE the block is not the same as landed, and conflating them is the
     * teleport.
     *
     * `solidAt` is true for every point in the soil, so the moment she lost
     * her grip underground this fired and flung her to the top of the block.
     * Reported as being teleported to the surface while moving around in a
     * tunnel. Underground she should simply take hold of whatever is nearest
     * — a tunnel has a floor, walls and a ceiling and all three are grip.
     */
    if (this.solidAt(probe) && this.insideBlock(probe)) {
      const near = this.nearestSurface(probe);
      if (near) {
        this.normalAt(near.point, this.up);
        this.at.copy(near.point).addScaledVector(this.up, this.ride);
        this.gripping = true;
        this.fallSpeed = 0;
        this.velocity.set(0, 0, 0);
        return;
      }
    }
    if (this.solidAt(probe) || this.at.y < LOW - SPAN) {
      // Landed on the outside, or lost entirely: back onto the top and re-grip.
      const from = new THREE.Vector3(
        THREE.MathUtils.clamp(this.at.x, LOW + CELL * 4, HIGH - CELL * 4),
        HIGH + GRIP_LIFT * 2,
        THREE.MathUtils.clamp(this.at.z, LOW + CELL * 4, HIGH - CELL * 4),
      );
      const hit = this.cast(from, new THREE.Vector3(0, -1, 0), SPAN * 2);
      if (hit) {
        this.normalAt(hit, this.up);
        this.at.copy(hit).addScaledVector(this.up, this.ride);
        this.gripping = true;
        this.fallSpeed = 0;
        this.velocity.set(0, 0, 0);
      }
    }
  }

  /* ------------------------------------------------------------- the loop */

  /**
   * Stop the live loop advancing her, so `stepForTest` is the ONLY thing that
   * does. Rendering carries on, so screenshot probes still work.
   *
   * Without this, "deterministic" was a lie: the animation loop calls
   * `simulate` with wall-clock dt, so every probe was measuring its own steps
   * PLUS however many frames the browser happened to slip in, at whatever dt
   * the machine was managing. It showed up as the same probe on the same build
   * reporting she ended up thirteen millimetres down on one run and on the
   * surface on the next.
   */
  setPausedForTest(on: boolean): void {
    this.paused = on;
  }

  /** Advance the room deterministically. For tests. */
  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  private simulate(dt: number): void {
    this.step(dt);

    if (this.ready) {
      this.queen.root.position.copy(this.at);
      /*
       * Her whole body is oriented by the frame she is standing in — up off
       * the face, nose along her forward. On the underside that is upside
       * down in world terms and perfectly ordinary in hers.
       */
      const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
      const basis = new THREE.Matrix4().makeBasis(right, this.up, this.forward);
      this.queen.root.quaternion.setFromRotationMatrix(basis);
      /*
       * HER HEAD FOLLOWS YOUR LOOK. Yaw always, pitch only where the mode
       * asks for it — see `modes.ts`. The pitch is the same `aimPitch` the
       * bite is taken along, so in DIG mode her jaws point at the hole she
       * is about to make rather than wherever the walk cycle left them.
       */
      const mode = MODES[this.mode]!;
      this.queen.update(dt, {
        speed: this.walkSpeed,
        turn: this.turnRate,
        digging: this.input.dig ? 1 : 0,
        carrying: 0,
        headYaw: this.follow.lookYaw,
        /*
         * The PLAYER's look, not the biased view. Onboard, `lookPitch`
         * returns the camera's own pitch — which now carries her resting
         * posture — so reading it here applied that posture twice and drove
         * her face past vertical at a level camera.
         */
        /*
         * WHERE HER FACE POINTS, absolutely — the camera's own pitch, because
         * the bone IS the camera. Aim it 43 degrees down and she is 43
         * degrees down; take it to 75 and so is she.
         *
         * Undefined where the mode does not want her pitching, which leaves
         * her in her bind pose rather than snapping her level. One limit for
         * both cameras: see `HEAD_PITCH_DOWN`.
         */
        headPitch: mode.pitchHead
          ? (this.firstPerson ? this.aimPitch : this.follow.lookPitch)
          : undefined,
      });
      /*
       * Feet onto the soil, in her frame: elevation is measured along HER
       * up, and the surface under a foot is found by casting in through it.
       * The same call the sim uses, handed a frame instead of a height map.
       */
      this.queen.solveFeet(
        (x, z, y) => this.surfaceUnder(x, y, z),
        FOOT_CLEARANCE_MM / 5,
        RIDE * 2,
        this.drive ? (slot) => this.drive!.anchorFor(slot) : undefined,
        {
          up: [this.up.x, this.up.y, this.up.z],
          surface: (x, y, z) => this.surfaceUnder(x, y, z),
        },
      );
    }

    /*
     * The bite comes AFTER she is posed, and that ordering is the fix, not
     * housekeeping.
     *
     * It used to run at the top of this function, which meant it read a jaw
     * from the previous frame — at her previous position, with her head
     * wherever it had been. On the frame the button goes down that is the
     * head still HELD UP by the walking gait, 1.12 mm off the soil, and the
     * old placement then projected that height forward into 6 mm of error.
     * Posing her first means `jawPosition` returns the jaw that is drawn on
     * the screen, dipped into the dig at 0.07 mm.
     */
    this.digCooldown = Math.max(0, this.digCooldown - dt);
    if (this.input.dig && MODES[this.mode]!.action?.id === 'dig' && this.digCooldown === 0) {
      this.bite();
      this.digCooldown = 0.25;
    }

    /*
     * WHERE THE EYE SITS: on her antenna sockets, as they are RIGHT NOW.
     *
     * `FollowCamera.eye` is an offset in her frame, so the live socket is
     * decomposed onto her right, up and forward every frame. It has to be the
     * live bone and not the rig's bind pose: her head is posed continuously —
     * dipped into a dig, turned toward the look — and the bind-pose figure
     * put the eye 2.05 mm behind the sockets, which on a 9 mm ant is inside
     * her thorax. Riding the live bone is also the only way "looking down the
     * mandibles" means anything, since the mandibles move.
     */
    /*
     * WHERE THE EYE SITS: on her antenna sockets as they are right now, given
     * to the rig as a WORLD POINT rather than as an offset in her frame.
     *
     * The frame round-trip is what broke it. Decomposing the live socket onto
     * her right/up/forward and letting the rig rebuild it looks harmless, but
     * the rig rebuilds on axes already turned by the look yaw — so the offset
     * was rotated twice and the eye swung wide of the head it is bolted to.
     * Measured: her jaws sat 10 degrees off the view centre looking straight
     * ahead and 79 degrees off at a sixty degree turn. A world point has no
     * frame to disagree about.
     */
    /*
     * THE EYE, MOUNTED IN HER HEAD'S FRAME — a boom, not a hand.
     *
     * The position is her antenna sockets, and every offset on top of it runs
     * along the HEAD's axes rather than her body's. That distinction is
     * invisible looking straight ahead and is the whole difference at a full
     * turn: a fifth of a millimetre pushed along her BODY forward is a fifth
     * of a millimetre sideways once her head has swung sixty degrees, and at
     * 0.87 mm from the jaw that is a large angle. It showed as the two
     * mandibles splitting evenly about the view centre when straight and
     * unevenly when turned.
     *
     * Handed over as a WORLD POINT. `FollowCamera.eye` is an offset in her
     * frame and the rig rebuilds it on axes already turned by the look yaw,
     * so anything passed that way gets rotated twice.
     */
    this.follow.body.copy(this.at);
    this.follow.onboardEye = null;
    this.follow.onboardLook = null;
    this.follow.onboardLookAt = null;
    const socket = new THREE.Vector3();
    const jaw = new THREE.Vector3();
    if (this.queen.eyePosition(socket) && this.queen.jawPosition(jaw)) {
      // Her head's own axes, from geometry: down the mandibles, and across.
      const headFwd = jaw.clone().sub(socket).normalize();
      const headRight = new THREE.Vector3().crossVectors(this.up, headFwd);
      if (headRight.lengthSq() < 1e-8) headRight.crossVectors(this.forward, headFwd);
      headRight.normalize();
      const headUp = new THREE.Vector3().crossVectors(headFwd, headRight).normalize();
      const eye = socket.clone()
        .addScaledVector(headFwd, EYE_FORWARD_MM / MM + this.eyeNudge.z)
        .addScaledVector(headUp, this.eyeNudge.y)
        .addScaledVector(headRight, this.eyeNudge.x);
      this.follow.onboardEye = eye;
      if (this.firstPerson) {
        /*
         * And the view is centred on the JAWS themselves, as a point.
         *
         * Not a direction: a direction is computed against where the eye was
         * asked to go, and the rig marches the eye out of soil, which at a
         * steep look with her head buried moves it. The jaws slid 106 degrees
         * off the centre of a view aiming exactly where it had been told.
         * A point is aimed from wherever the eye actually ended up.
         */
        this.follow.onboardLookAt = jaw.clone();
        this.follow.onboardLookPitch = this.eyePitch;
      }
    }

    this.follow.target.copy(this.at).addScaledVector(this.up, RIDE);
    this.follow.up.copy(this.up);
    /*
     * Down the mandibles, not down her forward. Her face already points about
     * 36 degrees below her body axis — an ant's mouthparts hang under the
     * head joint — so a first-person eye aimed along her forward looks over
     * the top of the work. `eyePitch` is the tuner's share of that.
     */
    /*
     * Onboard the view sits at her REST posture and moves from there, so a
     * level camera is already looking down the mandibles at the work rather
     * than out over the top of them. Same offset the bone gets, so the two
     * stay the same angle — which is the invariant this whole camera is
     * built on. `eyePitch` is the tuner's share on top.
     */
    // The view IS the aim now — no posture folded in, because the bone is not
    // offset from it either. `eyePitch` is the tuner's share and nothing else.
    this.follow.aimPitch = this.aimPitch + (this.firstPerson ? this.eyePitch : 0);
    this.follow.update(
      dt,
      Math.atan2(this.forward.x, this.forward.z),
      (p) => this.solidAt(p),
      CELL * 2,
      undefined,
      this.forward,
    );
  }

  /**
   * How high the soil is under a point, measured along HER up.
   *
   * The foot solver wants an elevation, and on a wall or an underside there
   * is no such thing in world terms — so the cast goes in along her own down
   * and the answer is reported as a distance along her own up. Off the block
   * entirely, the answer is "far below", which parks the foot rather than
   * planting it in mid-air.
   */
  /**
   * The soil under a point — the NEAREST surface, not the outermost one.
   *
   * This used to start its cast `GRIP_LIFT` (3 mm) above the point, which is
   * above the roof of anything she has dug. So a foot standing in a tunnel
   * got the answer for the ORIGINAL ground overhead, read as being far below
   * the surface, and was lifted out onto it. That is the ant in a pit with
   * her legs splayed across the flat around it.
   *
   * The lift exists for a real reason — a foot a little INTO the soil needs
   * the surface just above it, not the next one down — so it is kept and
   * made small: one cell, which is less than the height of a single bite's
   * tunnel and enough to cover a foot that has sunk a fraction of a
   * millimetre.
   */
  private surfaceUnder(x: number, y: number, z: number): number {
    const from = new THREE.Vector3(x, y, z).addScaledVector(this.up, CELL);
    const hit = this.cast(from, this.up.clone().negate(), CELL + GRIP_REACH);
    if (!hit) return -SPAN;
    return hit.dot(this.up);
  }

  /**
   * How far the eye is beneath the soil overhead, in world units.
   *
   * Marched along her own up rather than the world's, so a tunnel in a wall
   * counts as buried the same as one in the floor. The depth is measured to
   * the OUTERMOST soil on that line, not the first surface met — inside a
   * burrow the first thing above the eye is the tunnel's roof a millimetre
   * away, and being a millimetre under a metre of soil is still buried.
   *
   * Zero when there is nothing overhead, which is the surface and above.
   */
  private buriedDepth(from: THREE.Vector3): number {
    let last = 0;
    const probe = new THREE.Vector3();
    for (let d = 0; d <= SENSE_PROBE_MM / MM; d += CELL) {
      probe.copy(from).addScaledVector(this.up, d);
      if (this.solidAt(probe)) last = d;
    }
    return last;
  }

  /** Advance only the sense ramp, for probes that park the camera. */
  senseStepForTest(dt: number): void {
    const want = Math.min(1, this.buriedDepth(this.camera.position) / (SENSE_FULL_MM / MM));
    this.sense.uSense.value += (want - this.sense.uSense.value)
      * (1 - Math.exp(-SENSE_EASE * dt));
  }

  private animate = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
    /*
     * Eased toward the depth's answer rather than snapped to it. The depth
     * itself is the fade — a hard cut would flicker every time her head
     * crossed the soil line, which while digging is several times a second.
     */
    const want = Math.min(1, this.buriedDepth(this.camera.position) / (SENSE_FULL_MM / MM));
    this.sense.uSense.value += (want - this.sense.uSense.value)
      * (1 - Math.exp(-SENSE_EASE * dt));
    this.renderer.render(this.scene, this.camera);
    this.renderHeadInset();
    this.updateStatus();
    this.frame = requestAnimationFrame(this.animate);
  };

  /**
   * A PROFILE of her head, inset top-right — the instrument for reading a
   * pitch off the screen.
   *
   * An angle is the one thing the main view cannot show you, in either
   * camera: over her shoulder her head is small and mostly facing away, and
   * onboard you are inside it. So this looks at her from the side, square on,
   * where a nod is the whole picture.
   *
   * ORTHOGRAPHIC on purpose. The reading has to be an angle and nothing else,
   * and a perspective lens a few millimetres from a 2 mm head bends every
   * line it draws. Locked to HER frame rather than the world's, so level in
   * the inset means level to the ant, on a wall and on the ceiling too.
   *
   * It is a debug instrument and it says so: it costs a second scene draw
   * over a sixth of the screen and comes out when the head is signed off.
   */
  private renderHeadInset(): void {
    if (!this.ready || !this.debug) return;
    const head = new THREE.Vector3();
    if (!this.queen.eyePosition(head)) return;
    /*
     * Her LEFT, so a nose-down nod reads as clockwise the way a protractor
     * does. Her own up is the inset's up, so the horizon in here is her body
     * axis and the angle you read is the angle the bone was given.
     */
    const right = new THREE.Vector3().crossVectors(this.up, this.forward).normalize();
    this.headCam.position.copy(head).addScaledVector(right, -HEAD_INSET_MM / MM);
    this.headCam.up.copy(this.up);
    this.headCam.lookAt(head);
    this.headCam.updateProjectionMatrix();

    const size = this.renderer.getSize(new THREE.Vector2());
    const w = Math.round(Math.min(size.x, size.y) * HEAD_INSET_FRACTION);
    const x = Math.round(size.x - w - 12);
    const y = Math.round(size.y - w - 12);
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(x, y, w, w);
    this.renderer.setScissor(x, y, w, w);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.headCam);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
  }

  private updateStatus(): void {
    const face = this.up.y > 0.7 ? 'top'
      : this.up.y < -0.7 ? 'UNDERSIDE'
        : 'side';
    const mode = MODES[this.mode]!;
    this.status.innerHTML = `<strong>BLOCK ROOM — ${mode.label}: ${mode.hint}</strong><br>
      Block: ${BLOCK_MM} mm cube · ${CELL_MM} mm cells · ${CELLS}³<br>
      Bite: ${(this.queen.antennaToJaw() * BITE_WIDTH_SPANS * MM).toFixed(2)} mm wide, measured (table said ${CASTE_BITE_MM.queen}) · removed ${(this.removed * MM ** 3).toFixed(0)} mm³<br>
      On the ${face} · up ${this.up.x.toFixed(2)}, ${this.up.y.toFixed(2)}, ${this.up.z.toFixed(2)}<br>
      Gyro: ${this.trim.on
    ? `HOLDING ${(this.trim.pitch * 180 / Math.PI).toFixed(0)}° · flying ${this.gradeDeg().toFixed(0)}°`
    : `off · flying ${this.gradeDeg().toFixed(0)}°`}<br>
      Queen: ${CASTE_LENGTH_MM.queen} mm · ${this.gripping ? 'gripping' : 'FALLING'} · `
      + `head ${(this.follow.lookYaw * 180 / Math.PI).toFixed(0)}° off, `
      + `${mode.pitchHead
        ? `cam ${(this.follow.lookPitch * 180 / Math.PI).toFixed(0)}° → BONE `
          + `${this.headAngleDeg().toFixed(0)}° (should match)`
        : `level · BONE ${this.headAngleDeg().toFixed(0)}°`}<br>`
      + `${this.firstPerson
        ? `EYE nudge fwd ${(this.eyeNudge.z * MM).toFixed(2)}, up ${(this.eyeNudge.y * MM).toFixed(2)}, `
          + `right ${(this.eyeNudge.x * MM).toFixed(2)} mm · pitch `
          + `${(this.eyePitch * 180 / Math.PI).toFixed(0)}° — read these off and I will bake them in`
        : '3rd person · tap 1ST for the head cam'}<br>
      Sense: ${(this.sense.uSense.value * 100).toFixed(0)}% at ${(this.buriedDepth(this.camera.position) * MM).toFixed(2)} mm deep<br>
      Legs: ${this.report
    ? `${this.report.planted} planted · ${this.report.groping} reaching · `
      + `${this.report.movedMm.toFixed(2)} mm moved, ${this.report.heldBackMm.toFixed(2)} held back · `
      + `stroke ${(this.report.strain * 100).toFixed(0)}% · `
      + `${this.report.clearanceMm.toFixed(2)} mm clear`
    : 'waiting for the model'}`;
  }

  /**
   * Change mode, and make the HUD say so.
   *
   * The action button is HIDDEN rather than disabled when a mode has no verb,
   * because a greyed-out button on a phone is a thumb-sized piece of screen
   * spent saying "not this". A mode with nothing to do gets its space back.
   *
   * Anything the old mode had held down is released on the way out — holding
   * DIG and cycling away from digging must not leave her chewing.
   */
  setMode(next: number): void {
    this.mode = next;
    this.input.dig = false;
    const mode = MODES[this.mode]!;
    this.modeButton.textContent = mode.label;
    if (mode.action) {
      this.actionButton.textContent = mode.action.label;
      this.actionButton.style.display = '';
    } else {
      this.actionButton.style.display = 'none';
    }
  }

  /**
   * Swap cameras, and show the tuner only where it means anything.
   *
   * The field of view changes with it: 120 degrees onboard, because an eye a
   * centimetre off the soil at 60 sees a wall and no context, and back to 60
   * over her shoulder where a wide angle would just distort her.
   */
  /** Show or hide every instrument at once. `B` on a keyboard. */
  private setDebug(on: boolean): void {
    this.debug = on;
    this.debugButton.textContent = on ? 'DEBUG' : 'debug';
    this.status.style.display = on ? '' : 'none';
    this.tuner.style.display = on && this.firstPerson ? '' : 'none';
  }

  /**
   * Engage or release the gyro, taking the grade she is CURRENTLY LOOKING AT
   * as the one to hold.
   *
   * A numeric dial would need a row of buttons and a value to read before it
   * meant anything. This is one tap: aim where you want to go, engage, and the
   * body flies the line the view was on — the way a backhoe's boom is placed
   * and then held, rather than a camera hand-held on target. Releasing hands
   * her straight back to the soil.
   *
   * The grade comes from the VIEW, in the world. It first came from
   * `aimPitch`, which is neither: that is the head's aim relative to her body,
   * and it saturates at the neck's limit of +16.71 degrees. So every press
   * read "HOLD 17°" whatever the screen was pointing at — nose UP, which
   * underground is a command to climb out. Reported as defaulting to the same
   * angle every time and then crawling backwards out of the tunnel.
   */
  setTrim(on: boolean, grade = this.lookGrade()): void {
    this.trim.on = on;
    if (on) this.trim.pitch = THREE.MathUtils.clamp(grade, -TRIM_LIMIT, TRIM_LIMIT);
    this.trimButton.textContent = on
      ? `HOLD ${(this.trim.pitch * 180 / Math.PI).toFixed(0)}°`
      : 'hold';
  }

  private setFirstPerson(on: boolean): void {
    this.firstPerson = on;
    this.follow.mode = on ? 'first' : 'third';
    this.camera.fov = on ? FIRST_PERSON_FOV : THIRD_PERSON_FOV;
    this.camera.updateProjectionMatrix();
    this.viewButton.textContent = on ? '1ST' : '3RD';
    this.tuner.style.display = on && this.debug ? '' : 'none';
  }

  /**
   * Her head's ABSOLUTE pitch: where her face actually points, measured from
   * the model, not the offset the camera asked for.
   *
   * On screen because that is the number being read off it. Her head does not
   * rest level — it hangs nose-down by its own construction — so a readout of
   * the camera's offset says 0 while her face is already forty degrees into
   * the floor, and two people looking at the same ant disagree by that much.
   *
   * Head joint to jaw tip, which of the several lines that could fairly be
   * called "the head angle" is the one that looks like the head: the neck
   * base reads -26.94 at rest, this reads -36.35, the mouth chain alone
   * -45.00 and the antenna sockets -64.76.
   */
  private headAngleDeg(): number {
    if (!this.ready) return 0;
    const head = new THREE.Vector3();
    const jaw = new THREE.Vector3();
    if (!this.queen.headJointPosition(head) || !this.queen.jawPosition(jaw)) return 0;
    const d = jaw.sub(head).normalize();
    return (Math.asin(Math.max(-1, Math.min(1, d.dot(this.up)))) * 180) / Math.PI;
  }

  /**
   * The grade the VIEW is on, against world horizontal. What "hold this line"
   * means when you press the button while looking somewhere.
   */
  lookGrade(): number {
    const dir = this.camera.getWorldDirection(new THREE.Vector3());
    return Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  }

  /**
   * The grade she is actually flying: her nose against world horizontal,
   * nose-up positive. What the gyro is trying to make equal to its command.
   */
  gradeDeg(): number {
    return (Math.asin(THREE.MathUtils.clamp(this.forward.y, -1, 1)) * 180) / Math.PI;
  }

  /** Aim through the same clamp a drag uses. For probes. */
  setAimPitchForTest(next: number): void {
    this.aimPitch = THREE.MathUtils.clamp(next, -HEAD_PITCH_DOWN, HEAD_PITCH_UP);
  }

  /* ------------------------------------------------------------ the input */

  private buildControls(hud: HTMLElement): void {
    this.stick.className = 'density-lab-stick';
    this.stickKnob.className = 'density-lab-stick-knob';
    this.stick.appendChild(this.stickKnob);
    hud.appendChild(this.stick);

    const actions = document.createElement('div');
    actions.className = 'density-lab-actions';
    hud.appendChild(actions);
    /*
     * MODE first, then the action the mode offers.
     *
     * One action button that means whatever the mode says, rather than one
     * button per verb — a phone has room for about two, and this game will
     * have more verbs than that. Tapping MODE cycles forward; on a keyboard
     * `*` goes forward and `/` goes back.
     */
    this.modeButton.className = 'density-lab-button density-lab-mode';
    this.modeButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setMode(cycleMode(this.mode));
    });
    actions.appendChild(this.modeButton);

    this.actionButton.className = 'density-lab-button density-lab-dig';
    actions.appendChild(this.actionButton);
    const hold = (on: boolean) => (event: PointerEvent) => {
      event.preventDefault();
      this.input.dig = on;
    };
    this.actionButton.addEventListener('pointerdown', hold(true));
    this.actionButton.addEventListener('pointerup', hold(false));
    this.actionButton.addEventListener('pointercancel', hold(false));
    this.actionButton.addEventListener('pointerleave', hold(false));
    this.setMode(this.mode);

    /*
     * FIRST PERSON, and a tuner for where its eye goes.
     *
     * The toggle is its own button rather than a fourth entry in the mode
     * ring, because which camera you are on is orthogonal to what you are
     * doing — you want first person while digging AND while walking, and
     * folding them together would double the ring every time a verb is added.
     */
    /*
     * DEBUG off by default. The readout, the tuner and the head inset are
     * instruments, and instruments covering most of a phone screen make it
     * impossible to judge how the thing actually looks — which is the whole
     * reason for looking at it. One tap puts them all back.
     */
    this.debugButton.className = 'density-lab-button density-lab-mode';
    this.debugButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setDebug(!this.debug);
    });
    actions.appendChild(this.debugButton);

    this.trimButton.className = 'density-lab-button density-lab-mode';
    this.trimButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setTrim(!this.trim.on);
    });
    actions.appendChild(this.trimButton);
    this.setTrim(false);

    this.viewButton.className = 'density-lab-button density-lab-mode';
    this.viewButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.setFirstPerson(!this.firstPerson);
    });
    actions.appendChild(this.viewButton);

    this.tuner.className = 'density-lab-tuner';
    const rows: Array<[string, (dir: number) => void]> = [
      ['FWD', (d) => { this.eyeNudge.z += d * EYE_NUDGE_MM / MM; }],
      ['UP', (d) => { this.eyeNudge.y += d * EYE_NUDGE_MM / MM; }],
      ['RIGHT', (d) => { this.eyeNudge.x += d * EYE_NUDGE_MM / MM; }],
      ['PITCH', (d) => { this.eyePitch += (d * EYE_NUDGE_DEG * Math.PI) / 180; }],
    ];
    for (const [label, apply] of rows) {
      const row = document.createElement('div');
      row.className = 'density-lab-tuner-row';
      const name = document.createElement('span');
      name.textContent = label;
      row.appendChild(name);
      for (const dir of [-1, 1]) {
        const button = document.createElement('button');
        button.textContent = dir < 0 ? '\u2212' : '+';
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          apply(dir);
        });
        row.appendChild(button);
      }
      this.tuner.appendChild(row);
    }
    const reset = document.createElement('button');
    reset.textContent = 'RESET';
    reset.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.eyeNudge.set(0, 0, 0);
      this.eyePitch = 0;
    });
    this.tuner.appendChild(reset);
    hud.appendChild(this.tuner);
    this.setFirstPerson(false);
    this.setDebug(false);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      // Bound to the canvas for the life of the gesture, so its release comes
      // back here even if the finger ends up over the HUD or off the edge.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
      if (event.clientX < window.innerWidth * 0.5 && this.stickPointer === null) {
        this.stickPointer = event.pointerId;
        const o = clampStickOrigin(event.clientX, event.clientY, {
          minX: STICK_RADIUS + 12, maxX: window.innerWidth * 0.5 - 12,
          minY: STICK_RADIUS + 12, maxY: window.innerHeight - STICK_RADIUS - 12,
        });
        this.stickOrigin.x = o.x;
        this.stickOrigin.y = o.y;
        this.stick.style.left = `${o.x}px`;
        this.stick.style.top = `${o.y}px`;
        this.stick.classList.add('is-live');
        return;
      }
      this.lookPointer = event.pointerId;
      this.lookAt = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerId === this.stickPointer) {
        const v = stickVector(
          event.clientX - this.stickOrigin.x, event.clientY - this.stickOrigin.y, STICK_RADIUS,
        );
        /*
         * BOTH axes, proportionally. This is where "it snaps from forward to
         * turn" actually lived.
         *
         * The stick used to be quantised to ONE axis — whichever component
         * was larger won, and it won at `sign(component) × magnitude`, the
         * full throw. So she could never walk and turn at once, a lean of
         * one degree past the diagonal swapped a full walk for a full spin in
         * a single frame, and nothing in between the four compass points
         * existed. Easing the command afterwards, which is what the last
         * change did, can only smooth the edges of a square wave; it cannot
         * make the square wave a curve.
         *
         * Passing both through is all it takes, because the legs already
         * handle a mixed twist properly — `v + ω × r` per leg — and have
         * since they were built from Hexapod_v4. A diagonal thumb is a
         * curved walk, and rolling right round the pad sweeps continuously
         * from walk to spin and back.
         */
        this.input.walk = 0;
        this.input.yaw = 0;
        if (v.magnitude > STICK_DEADZONE) {
          // Rescale so the throw starts at zero just outside the deadzone
          // rather than jumping to 0.12 the moment it is crossed.
          const throwOut = (v.magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE);
          const k = throwOut / v.magnitude;
          this.input.walk = -v.y * k;
          this.input.yaw = -v.x * k;
        }
        this.stickKnob.style.transform = `translate(${v.x * STICK_RADIUS}px, ${v.y * STICK_RADIUS}px)`;
        return;
      }
      if (event.pointerId !== this.lookPointer) return;
      const dx = event.clientX - this.lookAt.x;
      const dy = event.clientY - this.lookAt.y;
      this.lookAt = { x: event.clientX, y: event.clientY };
      this.follow.orbit(-dx * LOOK_PER_PIXEL, -dy * LOOK_PER_PIXEL);
      /*
       * Clamped to what her NECK can do, not to what a camera can do.
       *
       * In first person the eye is on her head, so any range the view has
       * that the neck does not is range where the two silently part company.
       * Fifteen degrees up is the neck's limit, so it is the view's too.
       */
      this.aimPitch = THREE.MathUtils.clamp(
        this.aimPitch - dy * LOOK_PER_PIXEL,
        -HEAD_PITCH_DOWN,
        HEAD_PITCH_UP,
      );
      /*
       * And the YAW is clamped to her neck too, onboard, for the same reason
       * the pitch is: the eye is on her head, so a view that can swing
       * further than the neck is a view that parts company with it.
       */
      if (this.firstPerson) {
        this.follow.yawOffset = THREE.MathUtils.clamp(
          this.follow.yawOffset, -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT,
        );
      }
    });
    const release = (event: PointerEvent) => {
      if (event.pointerId === this.stickPointer) {
        this.stickPointer = null;
        this.input.walk = 0;
        this.input.yaw = 0;
        this.stick.classList.remove('is-live');
        this.stickKnob.style.transform = '';
      }
      if (event.pointerId === this.lookPointer) this.lookPointer = null;
    };
    /*
     * RELEASED FROM ANYWHERE, and captured so it usually does not have to be.
     *
     * These used to be on the canvas alone. The HUD, the buttons and the
     * tuner all take pointer events, and the screen edge takes them too — so
     * a thumb that slid off the canvas mid-drag fired its `pointerup`
     * somewhere the canvas never heard, the stick stayed latched at whatever
     * it was last set to, and she span on the spot at full deflection until
     * the app was killed. Reported exactly that way.
     *
     * Three layers, because a stuck control is unrecoverable without one:
     *   CAPTURE  binds the pointer to the canvas on the way down, so its up
     *            comes back here wherever the finger has wandered to.
     *   WINDOW   catches the release anyway if capture was refused or lost,
     *            which is the case capture alone does not cover.
     *   BLUR     zeroes everything when the app goes away, since a pointer
     *            that ends while backgrounded may never report at all.
     */
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    const letGo = (): void => {
      this.stickPointer = null;
      this.lookPointer = null;
      this.input.walk = 0;
      this.input.yaw = 0;
      this.input.dig = false;
      this.stick.classList.remove('is-live');
      this.stickKnob.style.transform = '';
    };
    window.addEventListener('blur', letGo);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) letGo();
    });

    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyW') this.input.walk = 1;
      if (event.code === 'KeyS') this.input.walk = -1;
      if (event.code === 'KeyA') this.input.yaw = 1;
      if (event.code === 'KeyD') this.input.yaw = -1;
      if (event.code === 'Space') { event.preventDefault(); this.input.dig = true; }
      // Named by key, not by code: `*` and `/` live in different places on
      // a numpad and a main row, and the player means the character.
      if (event.key === '*') { event.preventDefault(); this.setMode(cycleMode(this.mode)); }
      if (event.key === '/') { event.preventDefault(); this.setMode(cycleMode(this.mode, -1)); }
      if (event.code === 'KeyV') { event.preventDefault(); this.setFirstPerson(!this.firstPerson); }
      if (event.code === 'KeyB') { event.preventDefault(); this.setDebug(!this.debug); }
      if (event.code === 'KeyH') { event.preventDefault(); this.setTrim(!this.trim.on); }
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'KeyW' || event.code === 'KeyS') this.input.walk = 0;
      if (event.code === 'KeyA' || event.code === 'KeyD') this.input.yaw = 0;
      if (event.code === 'Space') this.input.dig = false;
    });
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
