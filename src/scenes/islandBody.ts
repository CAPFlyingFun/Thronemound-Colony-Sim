/**
 * THE BODY — one frame of her, from the stick to where her feet land.
 *
 * `simulate` is the whole of a tick: read the pace, ask the walker where
 * the surface is, mix in a dodge, move her, seat her, and hand the legs a
 * ground to reach for. `readSpine` and `shellClearance` are how her shape
 * answers the terrain; `moveSurface` is the movement itself, including the
 * embed recovery that gets her out of a wall she should never have been
 * in. `refreshAim` keeps the three instruments honest.
 *
 * This is the widest seam in the split and unavoidably so: a frame of an
 * animal touches nearly everything about the animal. It is stated anyway,
 * because sixty-eight named members in one interface is still a smaller
 * thing to hold in your head than eight hundred lines mixed in with a
 * camera, a HUD and a quest. See `islandCamera.ts` for the reasoning.
 */
import * as THREE from 'three';
import type { QueenModel } from '../anim/QueenModel';
import type { SurfaceWalker } from '../world/surfaceWalk';
import type { LegDrive, DriveReport, Ground } from '../anim/legDrive';
import {
  CLEARANCE_MM, GASTER_RIDE_MM, PROBES, posture,
  type Spine, type SpinePose, type SpineReading,
} from '../anim/spine';
import type { BodyPosture } from './bodyPosture';
import { YAW_RATE, type BoreRig } from './BoreControl';
import type { Dodge } from './dodge';
import type { Vitals } from './islandVitals';
import type { NestDesigner } from '../nest/NestDesigner';
import type { IslandStream, IslandScrollReport } from '../world/IslandStream';
import {
  SENSE_EASE, roofShare, ROOF_OPEN_MM, type SenseUniforms,
} from './undergroundSense';
import { CELL_SIZE, MM } from '../world/worldScape';
import { VOXEL_MM } from '../anim/hexapod';
import {
  BODY_FIT_SCALE, BODY_FLOOR_MARGIN, BODY_HALF_TALL, BORE_HUG_WIDE,
  CRAWL, FOOT_AIR, LEAD_MAX, LEAD_S, LEAN_MAX, LEAN_RATE,
  MESH_BUDGET, NOSE_REACH, RIDE, RISE_RATE, SCROLL_COOLDOWN_MS,
  SHELL_REACH, SHELL_SHARE, SOIL_DARK, SPRINT, TURN_RATE, UNDER_MM,
  senseAt, WALK_SPEED, QUEST_DEPTH_MM, SPAN_MM, SUPPORT_SHARE, TAIL_HOLD_RAD,
  S_LEAN, S_RAD, S_RIGHT, S_SPOT, S_SUPPORT,
} from './islandTuning';

/** One frame of her — everything it may reach, and nothing else. */
export interface BodyHost {
  readonly scene: THREE.Scene;
  readonly queen: QueenModel;
  readonly spine: Spine;
  readonly bore: BoreRig;
  readonly posture: BodyPosture;
  readonly dodge: Dodge;
  readonly vitals: Vitals;
  combatTick(dt: number): void;
  trophallaxisTick(dt: number): void;
  readonly groundForLegs: Ground;

  /* --- where she is --- */
  readonly at: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly wasAt: THREE.Vector3;
  readonly seatFrom: THREE.Vector3;
  readonly lastSafe: THREE.Vector3;
  facing: number;
  headingWas: number;
  groundSpeed: number;
  seatLiftMm: number;
  legRide: number;
  riseAhead: number;
  riseBehind: number;
  embedFrames: number;
  hasSafe: boolean;
  footAttitude: boolean;
  headClearMm: number;
  aimBearing: number;

  /* --- what the thumb asked for --- */
  readonly input: { walk: number; yaw: number; strafe: number;
    dig: boolean; sprint: boolean; crawl: boolean };
  /** Whether she is REALLY sprinting — see the note in `readEffort`. */
  readonly sprinting: boolean;
  digMode: boolean;
  queenReady: boolean;
  underground: boolean;
  enclosed: boolean;
  /** How far the sense has been ASKED for, 0..1 — see `SENSE_ON_MM`. */
  senseWant: number;

  /* --- the world --- */
  readonly queue: { cx: number; cy: number; cz: number }[];
  readonly queued: Set<string>;
  readonly skyColour: THREE.Color;
  heights: Int16Array | null;
  stream: IslandStream | null;
  walker: SurfaceWalker | null;
  drive: LegDrive | null;
  driveReport: DriveReport | null;
  spineRead: SpineReading | null;
  spineWant: SpinePose | null;
  sense: SenseUniforms | null;
  designer: NestDesigner | null;
  lastScrollAt: number;
  meshBudgetCapForTest: number;

  /* --- the readouts it keeps current --- */
  aimReadout: HTMLElement | null;
  headingReadout: HTMLElement | null;
  depthReadout: HTMLElement | null;

  /* --- and the rest of the scene, called rather than copied --- */
  paceMul(): number;
  pose(dt: number): void;
  questTick(dt: number): void;
  recordTelemetry(dt: number): void;
  aimCamera(dt: number): void;
  updateAimDebug(): void;
  boreAim(): THREE.Vector3;
  boreFrame(): {
    up: readonly [number, number, number];
    surface: (x: number, y: number, z: number) => number;
  };
  bite(): void;
  depthMm(): number;
  key(cx: number, cy: number, cz: number): string;
  meshChunk(cx: number, cy: number, cz: number): void;
  onScroll(scroll: IslandScrollReport): void;
  regrowScrub(force?: boolean): void;
  reveal(): void;
  walkGroundAt(x: number, z: number): number;
  soilSolidAt(x: number, y: number, z: number): boolean;
  soilDensityAt(x: number, y: number, z: number): number;
}

/**
 * HOW FAR ABOVE HER HEAD THE NEAREST SOIL IS, in millimetres, or `null`
 * for open sky.
 *
 * Straight up in WORLD +y, not along her own up, and that is the point: the
 * question is whether the sky is over her, and the sky does not tilt when
 * she walks onto a wall. Sampled from just clear of her head to
 * `ROOF_OPEN_MM`, which is where the sense has faded out anyway.
 *
 * `ROOF_STEPS` of `soilSolidAt` a frame, and it is affordable where an
 * earlier note said a cast was not: the step is three millimetres and the
 * thinnest thing this has to notice is a tunnel roof, which is thicker
 * than that. The camera guard alone spends more than this on a frame
 * anywhere near soil. A roof thin enough to slip between two samples reads
 * as sky, which for a roof that thin is close enough to true.
 */
const ROOF_STEPS = 20;

function roofGapMm(host: BodyHost): number | null {
  const from = host.at.y + RIDE;
  const reach = ROOF_OPEN_MM / MM;
  for (let i = 1; i <= ROOF_STEPS; i += 1) {
    const up = (reach * i) / ROOF_STEPS;
    if (host.soilSolidAt(host.at.x, from + up, host.at.z)) return up * MM;
  }
  return null;
}

export function simulate(host: BodyHost, dt: number): void {
  if (!host.heights) return;
  /* The rig owns the heading: it steers slowly while she is cutting and
   * at walking rate otherwise. Its yaw runs the other way to the stick's,
   * hence the sign. */
  /*
   * THE VIEW SIDE-STEPS HER; THE STICK TURNS HER.
   *
   * `lookYaw` is the orbit arm's swing off her tail, and it comes back to
   * zero on its own — so holding the view dragged slides her that way and
   * letting go stops her, with no latch and no mode. Negated because a
   * rightward drag DECREASES lookYaw (`lookYaw -= movementX`) while a
   * positive strafe is screen-right.
   */
  const bore = host.bore.step(dt, {
    /*
     * Scaled so the rig delivers TURN_RATE at full stick rather than its
     * own YAW_RATE, which other rooms share and this one should not be
     * quietly redefining.
     *
     * BOTH TERMS ARE POSITIVE, and that is a correction. The stick's yaw
     * carried a minus inherited from the rig's own convention and the
     * camera's pull carried the opposite of it, so pushing right turned
     * her left and dragging the view right swung her nose away from it.
     * Measured against a FROZEN screen-right — the camera follows her, so
     * a live screen axis chases its own tail — the two read -1.58 and
     * -0.99 where they should have read positive. `shot-hands.mjs`.
     */
    yaw: -host.input.yaw * (TURN_RATE / YAW_RATE),
    forward: host.input.walk,
    dig: host.input.dig,
  });
  /*
   * THE RIG STEERS; HER OWN UP IS THE AXIS IT TURNS ABOUT.
   *
   * The rig's heading is a yaw about world +Y, and there is no such thing
   * for an ant on a ceiling: the same number means two opposite directions
   * depending on which way up she is. So what is taken from it is the
   * CHANGE, applied as a rotation of her nose about her own up. On level
   * ground the two are identical to the digit; upside down, only this one
   * is a turn.
   */
  let swing = bore.heading - host.headingWas;
  while (swing > Math.PI) swing -= Math.PI * 2;
  while (swing < -Math.PI) swing += Math.PI * 2;
  host.headingWas = bore.heading;
  if (Math.abs(swing) > 1e-9) host.fwd.applyAxisAngle(host.up, swing).normalize();
  /*
   * HER COMPASS BEARING, and it HOLDS when she has none.
   *
   * `atan2(fwd.x, fwd.z)` is the direction her nose points on the map,
   * which is meaningless the moment her nose is vertical: up a shaft or a
   * trunk the horizontal part of it is almost nothing and the bearing
   * spins on rounding. Everything world-referenced reads this — the aim,
   * the gauge, the scroll's look-ahead — so it keeps the last bearing it
   * could actually measure rather than inventing one.
   */
  const flat = Math.hypot(host.fwd.x, host.fwd.z);
  if (flat > 0.15) host.facing = Math.atan2(host.fwd.x, host.fwd.z);
  const speed = host.input.walk * WALK_SPEED * host.paceMul();
  host.velocity.copy(host.fwd).multiplyScalar(speed);

  /*
   * ONE MOVEMENT LAW: HER LEGS, EVERYWHERE.
   *
   * There were three — a rail that owned the tunnels, a gravity-free
   * bore travel that owned the digging, and this walker that owned the
   * surface — and they handed her between one another on heuristics.
   * Nearly every movement bug reported over a week lived in those
   * hand-offs rather than inside any one system, so each fix moved the
   * failure instead of removing it.
   *
   * The walker is the one that always worked, so it is the one that
   * stayed. It reads floors out of the dug soil, steps up small ledges,
   * refuses walls and climbs one it is pressed against — underground
   * exactly as above it, because underground is only more soil. The
   * scoop is wider than she is, so a stroke opens something she can
   * simply walk into and nothing has to gate her.
   */
  host.wasAt.copy(host.at);
  moveSurface(host, dt, speed);
  /*
   * Measured ACROSS her up: being re-seated along it by a fraction of a
   * millimetre a frame is not walking, and counting it had a motionless
   * ant reporting a jog.
   */
  const moved = S_RAD.copy(host.at).sub(host.wasAt);
  moved.addScaledVector(host.up, -moved.dot(host.up));
  const went = moved.length() / Math.max(dt, 1e-6);
  host.groundSpeed += (went - host.groundSpeed) * Math.min(1, dt * 12);

  /*
   * WHAT THE EFFORT COST HER.
   *
   * Fed the pace latch's REQUEST and her MEASURED speed, not the stick:
   * holding sprint against a wall is not running, and a run that spends
   * stamina while she stands still would be the kind of drain a player
   * cannot see the cause of. See `islandVitals.ts`.
   */
  host.vitals.tick(dt, {
    /*
     * ACTUALLY SPRINTING, not merely asking to — and the difference was a
     * real bug.
     *
     * This passed `input.sprint`, the raw latch. Once she bottoms out,
     * `canRun` goes false and `paceScale` quietly drops her to WALK speed —
     * but the latch is still held, so this said "running", `tick` took the
     * DRAIN branch, and the recovery branch in its `else` never ran. She
     * was walking, paying a walk's costs, and regenerating nothing.
     *
     * Reported exactly: "you have to stop after it drains to gain some
     * which is annoying". She did, and there was no way to tell from the
     * screen why — the gear still read RUN.
     *
     * `sprinting` is the one place that decides, and `paceScale` reads the
     * same getter, so the speed she is given and the cost she is charged
     * for it cannot disagree again.
     */
    running: host.sprinting,
    moving: host.groundSpeed / WALK_SPEED,
    crawling: host.input.crawl,
    digging: host.input.dig,
    /*
     * Off the flat. Her up IS the surface normal she is standing on, so
     * this is simply "the ground under her is steep" — which on a trunk is
     * true and on a bank is true and needs no climbing system to ask.
     */
    climbing: host.up.y < 0.72,
    /* The nest's own air. `enclosed` is the same flag the sensed view
     * uses, which is the right one: it means roofed, not merely low. */
    sheltered: host.enclosed,
  });

  /* The camera's threshold, which is a question about GRADE and is right
   * to be: whether to run the tunnel chase or the open-country one. */
  const overhead = host.walkGroundAt(host.at.x, host.at.z) - (host.at.y + RIDE);
  host.underground = overhead > UNDER_MM / MM;
  /*
   * A RAMP, NOT A SWITCH. See `SENSE_ON_MM`: the old 16 mm threshold kept
   * the wireframe off for the whole of the entrance dig and then snapped it
   * on near the bottom. This fades it in over the four millimetres either
   * side of her going under, which is what sinking actually looks like.
   *
   * AND IT IS MULTIPLIED BY THE ROOF, which is the half that was missing —
   * see `roofShare` for the reported nighttime sky. Depth says she is below
   * where the ground used to be; the roof says whether anything is actually
   * between her and the sky. A five-millimetre scoop satisfies the first
   * and not the second, and it is the second that decides how the world is
   * LIT. Both, multiplied: a deep tunnel is 1, an open pit is 0, and a
   * tunnel mouth is the honest blend of the two.
   */
  host.senseWant = senseAt(overhead * MM) * roofShare(roofGapMm(host));
  /* Kept as the boolean a probe reads: the sense is UP rather than merely
   * fading in. */
  host.enclosed = host.senseWant >= 1;

  host.combatTick(dt);
  host.trophallaxisTick(dt);
  host.questTick(dt);
  /* The small tiers follow her; the big ones were planted once. */
  host.regrowScrub();

  /*
   * Which ROOM she is loose in, if any. It is DERIVED from where she is,
   * it is only ever asked below ground, and it decides exactly one
   * thing: that the rail leaves her alone in here. It does not move her.
   *
   * Both halves of that matter, and both were reported as bugs. A room
   * is a wide oval — a generous queen chamber is 22 mm across and 11 mm
   * tall — so a shallow one reaches up through the hill, and asking the
   * question on the SURFACE let the room claim someone standing on their
   * own anthill and pull them down to its floor: "it teleports me
   * underground". And when the room's containment also drove movement it
   * was a cage rather than a floor, so a room whose only tunnel leaves
   * straight up — which is exactly what the designer's PLACE chain
   * builds, each piece dropped below the last — sealed her in: "I am
   * stuck in a room". The carved soil is the only container she needs;
   * a second, tighter, invisible one was the bug.
   */
  /* Her walked path used to be the tunnel camera's rail. The chase finds
   * its own open air now, so nothing reads the trail — and a per-frame
   * list of clones nothing reads is just work. */

  if (host.stream) {
    // Soil leaves at the bottom of the stroke, not on the button — and
    // which stroke it is depends on which tool the shovel is holding.
    if (bore.bite) host.bite();

    /* The builder digs on a BUTTON, not on a frame: `digPiece` is called
     * straight from the palette's chips. Nothing to do per-frame here. */

    const lead = Math.min(LEAD_MAX, Math.abs(speed) * LEAD_S);
    const now = performance.now();
    /*
     * ONE SCROLL AT A TIME, FINISHED BEFORE THE NEXT.
     *
     * A scroll regenerates the whole window — measured at 290 to 508 ms —
     * and then dumps most of two hundred chunks into the mesh queue. The
     * gate was a flat 150 ms, which is a third of one scroll's own cost,
     * so on a run downhill the next one started while the last was still
     * being digested and the backlog never came back to zero: the report's
     * "queued 190" beside "scrolls 245", and the lag and the black holes
     * underground are both that same backlog seen from different angles.
     * Waiting for the queue to be nearly drained cannot deadlock — the
     * queue drains on its own every frame whether she moves or not.
     */
    const digesting = host.queue.length > MESH_BUDGET * 4;
    if (!digesting && now - host.lastScrollAt > SCROLL_COOLDOWN_MS) {
      /*
       * The look-ahead rides her NOSE, not a compass bearing. `facing` is
       * `atan2(fwd.x, fwd.z)`, which is noise when her nose is near
       * vertical — down a shaft the horizontal part of it is almost
       * nothing and the bearing spins, so a full-length lead was being
       * flung in a random direction every frame. Using the nose's own
       * horizontal components shrinks the lead to nothing exactly when the
       * bearing stops meaning anything, which is the behaviour wanted.
       */
      const scroll = host.stream.recentreOn(
        host.at.x + host.fwd.x * lead,
        host.at.z + host.fwd.z * lead,
      );
      if (scroll) {
        host.lastScrollAt = now;
        host.onScroll(scroll);
      }
    }

    /* The budget breathes with the backlog: three per frame when caught
     * up, up to twelve when a scroll dumped work — a 200-deep queue must
     * drain in a second, not stay a permanent debt on a 20 fps phone. */
    const budget = Math.min(
      host.meshBudgetCapForTest,
      Math.min(12, Math.max(MESH_BUDGET, host.queue.length >> 4)),
    );
    let built = 0;
    const meshStart = performance.now();
    while (built < budget && host.queue.length > 0) {
      const job = host.queue.shift()!;
      host.queued.delete(host.key(job.cx, job.cy, job.cz));
      host.meshChunk(job.cx, job.cy, job.cz);
      built += 1;
      /* One chunk ALWAYS lands, but the frame never spends more than
       * ~6 ms meshing — the playtest HUD's "last 74 ms" hitches were
       * this loop eating a whole scroll's backlog in one gulp. */
      /*
       * The slice grows with the backlog. Six milliseconds is right when
       * the queue is a handful, and far too polite when a scroll has just
       * dumped two hundred chunks: underground an unbuilt chunk is a hole
       * onto nothing, so the backlog is not just late scenery, it is the
       * black the report describes. Ten milliseconds for as long as the
       * pile is deep, six the rest of the time.
       */
      if (performance.now() - meshStart > (host.queue.length > 64 ? 10 : 6)) break;
    }
    host.reveal();
  }

  /* The crossover is deliberately not instant: breaking the surface is
   * one of the moments this game has, and half a second of contours
   * resolving into daylight is the whole of the effect. */
  if (host.sense) {
    host.sense.uSense.value += (host.senseWant - host.sense.uSense.value)
      * (1 - Math.exp(-SENSE_EASE * dt));
    /*
     * AND THE VOID BEHIND A MISSING CHUNK IS SOIL, NOT NOTHING.
     *
     * Underground, a chunk still in the mesh queue leaves a hole with the
     * clear colour behind it — sky above ground, and after a scroll, a
     * black gap in the tunnel wall. It cannot be meshed any sooner than it
     * is, but what shows through while it is pending can be the colour of
     * packed earth instead of the colour of nothing, which turns a hole
     * into a patch of unlit dirt. Eased on the same crossing the sense
     * shader uses, so surfacing does not flash.
     */
    (host.scene.background as THREE.Color)
      .copy(host.skyColour).lerp(SOIL_DARK, host.sense.uSense.value);
  }
  refreshAim(host);
  host.pose(dt);
  host.recordTelemetry(dt);
  // While the designer is up the camera is ITS fly rig, not the follow cam.
  if (!host.designer?.isOpen) host.aimCamera(dt);
  /* Last, so the crosshair ray is drawn from where the lens ACTUALLY
   * ended up this frame rather than where it was asked to go. */
  host.updateAimDebug();
}

/* ------------------------------------------------ chambers and the modes */

/** The angle she is pointed, in degrees, live. */
export function refreshAim(host: BodyHost, ): void {
  if (host.digMode && host.headingReadout && host.depthReadout) {
    /*
     * The bearing of the AIM, not of her body. On a trunk her nose points
     * at the sky and has no bearing worth printing; the line she is about
     * to cut along still does, right up until it goes plumb, and then it
     * holds rather than spinning on rounding.
     */
    const line = host.boreAim();
    const flat = Math.hypot(line.x, line.z);
    if (flat > 0.15) host.aimBearing = Math.atan2(line.x, line.z);
    const hdg = Math.round(((host.aimBearing * 180) / Math.PI + 360) % 360);
    const bearing = `${String(hdg).padStart(3, '0')}\u00b0`;
    if (host.headingReadout.textContent !== bearing) {
      host.headingReadout.textContent = bearing;
    }
    const down = Math.round(host.depthMm());
    const depth = down > 0 ? `\u25bc ${down} mm` : 'surface';
    if (host.depthReadout.textContent !== depth) {
      host.depthReadout.textContent = depth;
      host.depthReadout.classList.toggle('is-steep', down >= QUEST_DEPTH_MM);
    }
  }
  if (!host.aimReadout) return;
  /*
   * THE ANGLE IS READ AGAINST THE WORLD, whatever frame the stick works
   * in. `aimPitch` is her own pitch — nought means along her nose — and
   * printing that would have the dial say nought while she points at the
   * sky up a trunk. The rise of the actual aim line is the number an
   * altimeter would agree with.
   */
  const line = host.boreAim();
  const deg = Math.round(
    (Math.asin(Math.max(-1, Math.min(1, line.y))) * 180) / Math.PI,
  );
  const text = `${deg > 0 ? '+' : ''}${deg}°`;
  if (host.aimReadout.textContent !== text) host.aimReadout.textContent = text;
  host.aimReadout.classList.toggle('is-steep', deg <= -45);
}

/**
 * THE WALK, in her own frame: forward is along her nose, and down is
 * whatever she is standing on.
 *
 * Everything that used to make this hard was world +Y sneaking in. A floor
 * was "the soil below at this x,z", so a wall was a thing to be REFUSED
 * and then climbed at a fixed rate by a special case; a ceiling was not a
 * surface at all; and stepping off a lip left her hanging in the black
 * with nothing underneath, because "underneath" meant one fixed direction
 * that no longer pointed at any soil. Every one of those was a hand-off
 * between two ideas of down.
 *
 * There is one idea of down now and it is `up`, negated. She steps along
 * her nose, and `SurfaceWalker` seats her back onto the soil and turns her
 * up onto its normal — so a wall is a floor she is turning onto, a ceiling
 * is a floor she is under, and there is no case analysis anywhere for
 * either. Walking up out of a shaft is not a rule; it is what walking IS
 * once down points at the shaft's wall.
 */
/**
 * WHAT THE GROUND IS DOING, ahead of her, under her and behind her.
 *
 * Three probes and no more. Each is a surface elevation measured ALONG
 * HER OWN UP at a point offset along her nose, using the same
 * `boreFrame().surface` the leg solver already uses — so on a trunk
 * "ahead" is further up the bark and "rise" is out of it, and none of
 * this needs to know a tree exists.
 *
 * The offsets are fractions of her body length, so a major anticipates in
 * proportion to herself. Cheap enough to run every frame: three surface
 * casts against the six the legs already pay for.
 */
export function readSpine(host: BodyHost, dt: number): SpinePose {
  const frame = host.boreFrame();
  if (!frame || !host.queenReady) return host.spine.pose;
  const body = host.queen.bodyLength();
  const ahead = body * PROBES.ahead;
  const behind = body * PROBES.behind;
  const up = host.up;
  const at = (along: number): number => {
    const px = host.at.x + host.fwd.x * along;
    const py = host.at.y + host.fwd.y * along;
    const pz = host.at.z + host.fwd.z * along;
    /* Elevation ALONG HER UP, which is what makes this frame-relative. */
    return frame.surface(px, py, pz) - (px * up.x + py * up.y + pz * up.z);
  };
  const here = at(0);
  /*
   * THE RISES ARE FILTERED, because the surface they come off is a
   * LATTICE and the baseline is short.
   *
   * Measured walking: the raw rises land on multiples of a sixteenth of a
   * millimetre — the lattice's own step — and over a 1.8 mm baseline one
   * of those steps is two degrees of head. The full +-0.9 mm range the
   * ground actually produced swung the target 26 degrees, at frame rate.
   * That is quantisation, not terrain, and converting it to an angle
   * first only magnifies it.
   *
   * So the elevation differences are low-passed before they become
   * angles. This is not the spine's own smoothing — that shapes the
   * TRAIN, and no amount of it can help when the target itself is noise.
   */
  const rawAhead = at(ahead) - here;
  const rawBehind = at(-behind) - here;
  const k = 1 - Math.exp(-RISE_RATE * Math.max(0, dt));
  host.riseAhead += (rawAhead - host.riseAhead) * k;
  host.riseBehind += (rawBehind - host.riseBehind) * k;
  const wantAhead = host.riseAhead;
  const wantBehind = host.riseBehind;
  /*
   * The proximity floor: how much daylight each end has, measured the
   * same way. `SPINE_CLEARANCE` is a hundredth of a millimetre, so this
   * only ever fires when anticipation has already failed.
   */
  /*
   * TWO DIFFERENT QUESTIONS, ASKED TWO DIFFERENT WAYS.
   *
   * The rises above are terrain DIFFERENCES and say where a section
   * should point. The clearances below are MEASURED distances from a
   * drawn shell to solid and say whether it is about to touch anything.
   * Deriving the second from the sign of the first was a category error
   * that fired the emergency bias on 89% of walking frames.
   */
  const reading: SpineReading = {
    aheadRise: wantAhead,
    behindRise: wantBehind,
    headClear: (host.headClearMm = shellClearance(host, 'head')),
    gasterClear: shellClearance(host, 'gaster'),
    /*
     * The one thing a rise cannot say. Rounding onto a trunk her probes
     * both read exactly zero — the bark ahead of her is at the same height
     * in her own frame as the bark under her — so without this her back is
     * a plank through the only manoeuvre it exists for. The gait already
     * knows the angle; it just had nowhere to send it.
     */
    fold: host.driveReport?.corner.fold ?? 0,
    /*
     * The tail does not relax on the neck's schedule. While the rear feet
     * have yet to cross — the transfer phases — the gaster is still
     * sweeping the surface she is leaving, so its lift holds at the
     * corner's full character even as the attitude angle spends itself.
     * See `SpineReading.tailFold`.
     */
    tailFold: (() => {
      const c = host.driveReport?.corner;
      if (!c) return undefined;
      return c.phase === 'transferMiddle' || c.phase === 'transferRear'
        ? Math.max(c.fold, TAIL_HOLD_RAD)
        : c.fold;
    })(),
  };
  /* Millimetres converted ONCE, here at the boundary — everything inside
   * `posture` is then in the same units as the reading it was handed. */
  const want = posture(reading, ahead, behind, undefined, {
    soft: CLEARANCE_MM.soft / MM,
    hard: CLEARANCE_MM.hard / MM,
  }, {
    low: GASTER_RIDE_MM.low / MM,
    high: GASTER_RIDE_MM.high / MM,
  });
  /* Diagnostics for `shot-spine.mjs` — every input and both outputs, so
   * the bobbing can be attributed rather than guessed at. */
  host.spineRead = reading;
  host.spineWant = want;
  return host.spine.follow(want, dt);
}

/**
 * HOW MUCH AIR A BODY SEGMENT'S SHELL HAS, along her own down.
 *
 * Against the unioned solid field — soil, landmark, scrub, dug tunnel
 * wall — so it works on a ceiling and upside down with no per-object
 * branch anywhere. `Infinity` when nothing is within reach, which is the
 * ordinary case and must contribute nothing.
 *
 * The shell RADIUS is subtracted, which `groundGuard` deliberately does
 * not do: there the number drives a rigid lift of the whole model and a
 * radius over-reports, floating all six planted feet. Here it drives a
 * bend of one segment, and over-reporting is the safe direction.
 */
export function shellClearance(host: BodyHost, which: 'head' | 'gaster'): number {
  if (!host.queenReady) return Infinity;
  const radius = host.queen.segmentShell(which, S_SPOT);
  if (radius < 0) return Infinity;
  /*
   * HALF THE RADIUS, and that is a calibration rather than a guess.
   *
   * `groundGuard`'s own note says why the whole radius is wrong: it is
   * the widest the mesh gets ANYWHERE around that bone, and subtracting
   * it straight down assumes the widest part hangs directly below. On the
   * gaster that radius is 1.53 mm — most of her abdomen — and using it
   * reported -0.53 to -1.53 mm of clearance on flat ground she is
   * visibly not clipping through. I reproduced the exact mistake that
   * comment warns about.
   *
   * Measured: standing on the flat her gaster bone sits about 1.0 mm off
   * solid and nothing shows, so whatever actually hangs below that bone
   * is under 1.0 mm — under two thirds of the radius. Half is inside
   * that and still conservative.
   */
  const shell = radius * SHELL_SHARE;
  const up = host.up;
  const reach = SHELL_REACH;
  const step = CELL_SIZE * 0.5;
  let clear = Infinity;
  for (let d = 0; d <= reach; d += step) {
    if (host.soilSolidAt(
      S_SPOT.x - up.x * d, S_SPOT.y - up.y * d, S_SPOT.z - up.z * d,
    )) {
      /*
       * BISECTED, BECAUSE THE MARCH'S STEP IS HALF A MILLIMETRE.
       *
       * `CELL_MM` is 1 and the step is half a cell, so the raw answer is
       * quantised to 0.5 mm — and biased, because the march stops at the
       * first SOLID sample and the surface is anywhere in the step before
       * it, so it over-reports clearance by up to a step. Measured, that
       * is not subtle: her abdomen's clearance came back as 0.73, 1.23,
       * 1.73, 2.23 and nothing in between, on every situation sampled.
       *
       * A control law wants to hold this quantity inside a band a few
       * tenths of a millimetre wide, and a sensor coarser than its own
       * dead-band cannot do that — it chatters between lattice steps. So
       * the same six bisections `SurfaceWalker.nearestSurface` uses, for
       * the same reason and to the same tolerance: half a millimetre over
       * sixty-four, which is under a hundredth.
       */
      let lo = Math.max(0, d - step);
      let hi = d;
      for (let i = 0; i < 6; i += 1) {
        const mid = (lo + hi) * 0.5;
        if (host.soilSolidAt(
          S_SPOT.x - up.x * mid, S_SPOT.y - up.y * mid, S_SPOT.z - up.z * mid,
        )) hi = mid; else lo = mid;
      }
      clear = hi - shell;
      break;
    }
  }
  /*
   * THE HEAD ALSO LOOKS WHERE SHE IS GOING.
   *
   * `CLEARANCE_MM`'s own words are "what is in front of it", and along
   * her down that is true of the ground but never of a wall: marching
   * down from the head spot, a vertical face ahead reads clear on one
   * frame and half a millimetre INSIDE on the next — a cliff, not a
   * ramp — and no follow rate can answer a warning that arrives after
   * the touch. Measured at the trunk corner: 4.01 mm to 0.01 mm in one
   * frame at walking pace. So the head takes the nearer of two
   * questions, below and AHEAD, and the wall becomes the same gentle
   * ramp the ground always was — the bias starts easing her face up
   * while it is still a millimetre out. The gaster keeps the single
   * probe: what it drags over is always beneath it.
   */
  if (which === 'head') {
    const fwd = host.fwd;
    for (let d = 0; d <= reach; d += step) {
      if (host.soilSolidAt(
        S_SPOT.x + fwd.x * d, S_SPOT.y + fwd.y * d, S_SPOT.z + fwd.z * d,
      )) { clear = Math.min(clear, d - shell); break; }
    }
  } else {
    /*
     * THE GASTER LOOKS WHERE IT TRAILS — the head's own fix, mirrored.
     * "What it drags over is always beneath it" is true in steady state
     * and false in the one manoeuvre that clips it: mid-fold her frame
     * has already rotated onto the new face, so the floor the tail is
     * still sweeping lies AFT along -forward, not below — the same
     * cliff-not-ramp blindness the head's second probe cured, arriving
     * from behind. Reported as the abdomen clipping through the ground
     * during the transition, which is exactly this probe's blind spot.
     */
    const fwd = host.fwd;
    for (let d = 0; d <= reach; d += step) {
      if (host.soilSolidAt(
        S_SPOT.x - fwd.x * d, S_SPOT.y - fwd.y * d, S_SPOT.z - fwd.z * d,
      )) { clear = Math.min(clear, d - shell); break; }
    }
  }
  return clear;
}

/**
 * How much higher she should ride because she is standing on WOOD.
 *
 * Nought on soil. On a trunk it is two thirds of the facet sagitta —
 * `r (1/cos(pi/sides) - 1)` at twenty sides is 1.23% of the radius, and
 * averaging that over a facet is about two thirds of the peak. The radius
 * is read off the collision itself rather than guessed: march out along
 * her own up until the wood ends, which is the local skin depth and needs
 * no knowledge of which tree she is on.
 */
export function moveSurface(host: BodyHost, dt: number, speed: number): void {
  const walker = host.walker;
  if (!walker) return;
  const span = SPAN_MM / MM;

  /*
   * THE LEGS MOVE HER, once she has any.
   *
   * The stick proposes a shove and a spin; the planted feet refuse what
   * they cannot reach; what survives is her displacement. That is what
   * makes the gait match the ground — the cycle and the travel come out
   * of the same step rather than being two numbers hoped into agreement,
   * which is what the skating was. Sliding her along her nose is the
   * fallback for the first second, before her model has loaded.
   */
  /*
   * A DODGE IS THE ORDINARY MOVEMENT WITH DIFFERENT NUMBERS IN IT.
   *
   * It is mixed into the same walk/strafe/speed the stick fills and
   * handed to the same drive, which is the whole point: the burst then
   * inherits the surface frame, the foot clip, the collision and the
   * measured-speed gait without any of them being told a dodge exists.
   * On a trunk "left" is along the bark because `forward` and `up` are
   * hers, not the world's.
   *
   * `authority` eases from one to nought over the tail of the burst, so
   * control returns to whatever the thumb is asking for by then rather
   * than snapping back to it.
   */
  const burst = host.dodge.sample(dt);
  const stickSpeed = WALK_SPEED * host.paceMul();
  const w = burst.authority;
  const walk = host.input.walk + (burst.forward - host.input.walk) * w;
  const strafe = host.input.strafe + (burst.side - host.input.strafe) * w;
  const pace = burst.active
    ? stickSpeed + (burst.speed - stickSpeed) * w
    : stickSpeed;

  if (host.drive) {
    host.driveReport = host.drive.step(
      dt,
      { at: host.at, up: host.up, forward: host.fwd },
      {
        walk,
        strafe,
        /* Told, not obeyed: the rig has already turned her this frame and
         * the gait still has to step for it. See `DriveInput.spin`. */
        yaw: -host.input.yaw,
        spin: false,
        speed: pace,
        yawRate: TURN_RATE,
        /* The walker seats her: two systems both deciding how high she
         * rides do not average out, they fight. */
        settle: false,
        /*
         * A DODGE MAY NOT STAGE A CLIMB, and neither may a dig stroke.
         *
         * The drive is handed one walk and one strafe and cannot tell a
         * burst from a thumb, which is the whole virtue of mixing the
         * dodge in up there — and it is exactly why the veto has to be
         * said here, where the difference is still known. A flick that
         * happens to point at bark is an evasion, not a decision to go
         * up; a mandible stroke is not travel at all.
         */
        mayTransition: !burst.active && !host.input.dig,
      },
      host.groundForLegs,
    );
  } else {
    host.at.addScaledVector(host.fwd, walk * pace * dt);
    if (strafe !== 0) {
      /* `up x fwd` is her model +X, which is screen-LEFT — hence the
       * minus. Same convention as `DriveInput.strafe`. */
      const side = S_RIGHT.crossVectors(host.up, host.fwd).normalize();
      host.at.addScaledVector(side, -strafe * pace * dt);
    }
  }
  host.at.x = Math.min(span - 2, Math.max(2, host.at.x));
  host.at.z = Math.min(span - 2, Math.max(2, host.at.z));

  /*
   * ATTITUDE HOLDS STILL WHILE THE JAWS ARE WORKING.
   *
   * Digging takes the ground out from under her, so the normal the grip
   * finds flips between the floor, the fresh rim and the wall several
   * times a second — and her up steers the cast that found it, which is a
   * feedback loop no rate limit can tame. Frozen for the frames a stroke
   * is actually cutting; free the rest of the time, which is when
   * cornering happens anyway.
   */
  const aimDt = host.input.dig && host.underground ? 0 : dt;
  /*
   * WOOD IS DRAWN PROUD OF ITS OWN COLLISION, so she rides a little
   * higher on it.
   *
   * The trunk's collision is the round cone — a circle at every height.
   * The mesh is a polygon whose flats are TANGENT to that circle, which
   * is what stopped her hovering, but it means the drawn bark stands out
   * from the collision by up to a facet's sagitta, and she seats on the
   * collision. Measured on the landmark: her claws sat 2.7 mm inside the
   * picture — reported as "still in the tree, but a lot closer".
   *
   * The lift is the mean of that excess rather than its worst, so she
   * sits on the bark whichever way round the trunk she is, and it is
   * applied ONLY where the thing under her is wood. Soil has no facets
   * and already measured 0.28 mm, which is contact; lifting her there
   * would put the hovering back on the ground instead.
   */
  /* One height law everywhere now: her legs' own rest plane, plus the
   * hundredth of a millimetre of air that keeps her out of the ground —
   * and plus whatever the ↕ control is holding, which is the only thing
   * allowed to move her off that plane. Handing the walker one number
   * keeps the body height and the leg geometry a single fact, which is
   * what stopped the skating; the posture adds to it rather than
   * competing with it for the same reason. */
  host.posture.update(dt);
  (walker.tune as { ride: number }).ride = host.legRide + FOOT_AIR
    + host.posture.rideMm / MM;
  /*
   * THE SEATING, MEASURED — how much the WALKER moved her this frame, as
   * distinct from how much her legs did.
   *
   * The two are separate authorities over the same body: the legs drive her
   * along the ground and the walker re-seats her onto it, easing toward the
   * seat point every frame. A recording that only shows clearance cannot say
   * which of them produced a bob, and "she sinks and pops back" is a
   * completely different bug depending on the answer. So the position is
   * snapped either side of the call and the difference along her up is kept.
   */
  host.seatFrom.copy(host.at);
  /*
   * STILL means the PLAYER is asking for nothing and no corner is being
   * worked. Only then may the walker's dead-band refuse the sub-band seat
   * corrections that, at rest, are pure noise — at 22 Hz and a tenth of a
   * millimetre, the vibration — but that in motion are the very steps a
   * corner is made of.
   */
  /* 'normal' IS the idle phase — every other value means a corner is in
   * hand. (The telemetry's 'none' is its own placeholder for "no drive
   * yet", not a phase the drive ever reports.) */
  const still = Math.abs(host.input.walk) < 0.01
    && Math.abs(host.input.strafe) < 0.01
    && Math.abs(host.input.yaw) < 0.01
    && (host.driveReport?.corner.phase ?? 'normal') === 'normal';
  /*
   * THE CORNER'S PRE-TILT. The moment a front grip holds the new face the
   * drive reports a lean, and the walker bends her attitude goal toward
   * the wall by that share — shoulders rising while the front feet take
   * hold, the way an ant actually enters a climb. This is what lifts the
   * head clear of the bark during the flat approach; see
   * `CornerTurn.leanToward`.
   */
  const leanShare = host.drive ? host.drive.cornerLean(S_LEAN) : 0;
  let attitude = leanShare > 0 ? { toward: S_LEAN, share: leanShare } : undefined;
  /*
   * AND WHEN THERE IS NO CORNER, HER FEET GET A SAY.
   *
   * The walker's attitude goal is the density gradient sampled at her own
   * centre — the ground under her BELLY, one point. Her six planted feet
   * are a support polygon spanning most of her length, and they know
   * things that point does not. Measured with `probe-support`, degrees
   * between the two answers:
   *
   *   standing   6.7    walking   5.4 (peak 15)
   *   AFTER A DIG   44 mean, 53 peak
   *
   * That last line is the whole reason this exists. She digs the ground
   * out from under her own middle, so the belly sample is reading the
   * HOLE while her feet stand on its rim — and the fifty-three degrees of
   * disagreement is the same fifty degrees she was then measured slowly
   * rotating through, over seven seconds of standing still, to match the
   * pit instead of the ground. Blending toward the feet is what makes her
   * attitude a thing she stands on rather than a thing she hovers over.
   *
   * HALF, and not all of it. The two are both real: the gradient is the
   * true local surface and the polygon is the average across her span, so
   * a crest reads differently to each and neither is a lie. Half moves the
   * dig case tens of degrees while leaving the six or seven degrees of
   * ordinary standing difference at three, which is invisible. Scaled by
   * the fit's own confidence so a stance shrunk to a sliver by swinging
   * legs fades out rather than shouting.
   *
   * THE CORNER KEEPS ITS SLOT UNCONDITIONALLY. Mid-fold her feet straddle
   * floor and wall and the plane through both dissents by 17 to 22
   * degrees — real, and precisely the thing that must not be allowed to
   * argue with the scheduler that is deliberately turning her.
   */
  if (!attitude && host.drive && host.footAttitude) {
    const fit = host.drive.supportNormal(S_SUPPORT, host.up);
    if (fit > 0) attitude = { toward: S_SUPPORT, share: SUPPORT_SHARE * fit };
  }
  walker.settle(
    { at: host.at, up: host.up, forward: host.fwd }, dt, aimDt, still,
    attitude,
  );
  host.seatLiftMm = host.seatFrom.sub(host.at).dot(host.up) * -VOXEL_MM;

  /*
   * The safety net is smaller than it was, because most of what it caught
   * cannot happen any more: there is no "off the modelled window" — the
   * density answers everywhere — and no "no floor below at this x,z",
   * because below is wherever she is standing. What is left is genuinely
   * being inside soil, which the walker's own embedded case handles first
   * and this only backs up.
   */
  /*
   * Tested WELL above her origin, because her origin is not the lowest
   * part of her — the rig puts its sole plane through it, so a correctly
   * seated ant has her root a fraction inside the surface — AND because
   * the surface itself is a millimetre lattice. Walking up even a gentle
   * slope, the density surface under her jumps by whole cell steps as she
   * crosses cell boundaries, so a healthy seated origin transiently sits
   * over a millimetre deep. The old half-millimetre probe read every such
   * step as a burial: three frames of it and she was snapped back to
   * lastSafe, which on a slope she is walking UP means snapped backward —
   * a permanent treadmill, felt as "stuck for some reason", eighteen
   * millimetres from spawn, with the drive reporting full speed the whole
   * time. Reproduced deterministically and gone at two millimetres.
   *
   * Two millimetres is still far inside anything that has actually
   * swallowed her: a collapse or a fall into soil buries the whole body,
   * and her trunk is four millimetres through.
   */
  const probeUp = 2 / MM;
  if (host.soilDensityAt(
    host.at.x + host.up.x * probeUp,
    host.at.y + host.up.y * probeUp,
    host.at.z + host.up.z * probeUp,
  ) > 0) {
    // Three CONSECUTIVE bad frames means it is real. One is usually the
    // rounding flickering while she hugs a curved wall — snapping on that
    // yanked her off the shaft wall mid-climb, every climb.
    host.embedFrames += 1;
    if (host.embedFrames >= 3 && host.hasSafe) {
      host.at.copy(host.lastSafe);
      host.embedFrames = 0;
    }
  } else {
    host.embedFrames = 0;
    host.lastSafe.copy(host.at);
    host.hasSafe = true;
  }
}

