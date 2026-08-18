/**
 * THE JAWS — where the bite lands, what it takes out, and the debug rig
 * that draws the whole chain when you want to see why it did not.
 *
 * One subject: turning "she is pointed there" into "that soil is gone".
 * The aim line, the reach past her nose, the scoop's centre, the smoothing
 * pass afterwards, and the chunks that have to be remeshed as a result.
 *
 * `updateAimDebug` lives here rather than with the other instrumentation
 * because it is not really a debug view of the SCENE — it is a drawing of
 * this file's arithmetic, and it has to move when the arithmetic does.
 *
 * See `islandCamera.ts` for why these are free functions over a host
 * interface rather than a class.
 */
import * as THREE from 'three';
import type { Grit } from './islandGrit';
import type { QueenModel } from '../anim/QueenModel';
import type { IslandStream } from '../world/IslandStream';
import { CELL_SIZE, MM } from '../world/worldScape';
import { DigJob } from './digJob';
import {
  AIM_DBG_LAG, AIM_LIMIT, CH, CHUNKS_XZ, CHUNKS_Y,
  JAW_PAST_NOSE, NOSE_REACH, QUEST_DEPTH_MM, RIDE,
  SMOOTH_MAX_SHIFT, SMOOTH_PASSES, SMOOTH_RADIUS_MM, SMOOTH_STRENGTH,
  S_BITE_JAW, S_CENTER, S_DBG_CENTRE, S_DBG_DIR, S_DBG_END,
  S_DBG_HEAD, S_DBG_JAW, S_DBG_REL, S_DBG_RIGHT, S_DBG_UP,
  S_TARGET,
} from './islandTuning';

/** What the jaws may reach, and nothing else. */
export interface DigHost {
  readonly scene: THREE.Scene;
  /** The spoil thrown off a cut, once there is a scene to throw it in. */
  readonly grit: Grit | null;
  readonly camera: THREE.PerspectiveCamera;
  readonly queen: QueenModel;
  readonly at: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly fwd: THREE.Vector3;
  readonly lookDir: THREE.Vector3;
  readonly hud: HTMLElement;
  readonly queue: { cx: number; cy: number; cz: number }[];
  readonly queued: Set<string>;
  readonly aimDbgLook: THREE.Vector3[];
  ready: boolean;
  queenReady: boolean;
  firstPerson: boolean;
  digMode: boolean;
  hasSafe: boolean;
  biteTouched: boolean;
  aimPitch: number;
  brushMm: number;
  deepCarved: number;
  stream: IslandStream | null;
  /** The bore being eaten right now, if any — see `digJob.ts`. One at a
   *  time, and its duration is the cooldown; that is the whole rule. */
  digJob: DigJob | null;
  /** One body length, off her own rig — the bore's length. */
  boreLength(): number;
  /** Half of max(her height x BORE_WIDEN, BORE_MIN) — the bore's radius. */
  boreRadius(): number;

  /* --- the debug rig's own handles --- */
  aimDebug: boolean;
  aimDbgAt: number;
  aimDbgLookAt: number;
  aimDbgDig: THREE.Line | null;
  aimDbgCam: THREE.Line | null;
  aimDbgSpot: THREE.Mesh | null;
  aimDbgJaw: THREE.Mesh | null;
  aimDbgHead: THREE.Line | null;
  aimDbgText: HTMLElement | null;

  /* --- the scene's own behaviour --- */
  key(cx: number, cy: number, cz: number): string;
  enqueue(cx: number, cy: number, cz: number): void;
  meshChunk(cx: number, cy: number, cz: number): void;
  reveal(): void;
  depthMm(): number;
  soilSolidAt(x: number, y: number, z: number): boolean;
  groundSolidAt(x: number, y: number, z: number): boolean;
  /** A stroke that removed nothing — the scene's chance to say "out of
   *  reach" instead of the silence that reads as a broken button. */
  biteMiss(): void;
}

/** The way she is pointed AND pitched — the line the bore cuts and, while
 *  she is engaged in one, the line she travels. */
export function boreAim(host: DigHost, ): THREE.Vector3 {
  /*
   * SHE DIGS WHERE YOU ARE POINTING HER, and the pointing keeps still
   * until you change it. Dragging up and down sets it in either view —
   * no buttons, no gauge — and the camera follows it rather than setting
   * it, which is the way round that stops "forward" quietly meaning
   * "into the floor".
   */
  /*
   * PITCHED IN HER OWN FRAME — and READ against the world.
   *
   * Both halves matter, and putting both in the same frame is what went
   * wrong. The gauge has to be world-referenced: it is a depth
   * instrument, and a depth measured against whatever slope she happens
   * to be on tells you nothing. But the CONTROL cannot be, because the
   * camera looks down this line: build it from a compass bearing and she
   * is clinging to a vertical trunk with a bearing that has been frozen
   * since the last time she was upright, so the view unhooks from her
   * body and panning turns something that is not the ant.
   *
   * So the aim is a rotation between her nose and her back, which the
   * view can ride, and `refreshAim` reports the world angle OF that line.
   * Nose-first up a trunk then reads +90 on the dial, which is exactly
   * what was asked for — the number is world, the stick is hers.
   */
  /*
   * IN HER EYES, THE CUT IS WHATEVER THE CROSSHAIR COVERS.
   *
   * The crosshair sits at the centre of the frame, and the frame is now
   * built on her HEAD's forward rather than her body's — so the cut has
   * to run down that same line or the two disagree by the whole of the
   * spine's lean the moment she is on a slope. `lookDir` is the vector
   * the lens was actually built from, written by `aimCamera` each frame
   * it draws a first-person view.
   *
   * Third person keeps the body-frame aim: there the crosshair is hidden
   * and the shovel's line is hers, not the camera's.
   */
  if (host.firstPerson && host.lookDir.lengthSq() > 1e-9) {
    return new THREE.Vector3().copy(host.lookDir).normalize();
  }
  const cp = Math.cos(host.aimPitch);
  return new THREE.Vector3().copy(host.fwd).multiplyScalar(cp)
    .addScaledVector(host.up, Math.sin(host.aimPitch));
}

/**
 * ONE STROKE OF THE SHOVEL — and a stroke is a CYLINDER now, not a
 * mouthful.
 *
 * Joshua's blueprint (drawn, 2026-08-18): a bore one BODY LENGTH long,
 * its diameter off her own standing height, starting at the thorax and
 * running out past the head along the aim. It is not carved on the press:
 * the press starts a `DigJob` that chips the cylinder away on a steady
 * half-second beat over `volume / DIG_RATE_MM3_S` seconds rounded up —
 * his own arithmetic, "143/30=4.767 seconds" — and that duration IS the
 * cooldown. A press while a job runs does nothing on purpose: the bore
 * being eaten is the answer to that press. Held past the end, the next
 * stroke starts a new bore from wherever she stands now, which is how a
 * long tunnel is one held button.
 *
 * WHY: "popcorn tunnel as each bite." The old stroke dropped two 6 mm
 * spheres exactly tangent, and tangent spheres leave a waist — every
 * press a discrete pocket the walls remembered. The job sweeps deeply
 * overlapping spheres down one line instead, which is how the worms cut
 * and why their tunnels look right. And because the bore is HER length
 * and HER height widened, a small ant digs a small fast tunnel and a big
 * ant a big slow one, with nothing per-caste written anywhere.
 */
export function bite(host: DigHost, ): void {
  /* One bore at a time — the duration is the cooldown, by decree. */
  if (host.digJob) return;
  const aim = boreAim(host);
  /*
   * SEATED THE WAY EVERY STROKE HAS BEEN: the ray from the lens (her
   * centre in third person) walked to the first soil it meets, with the
   * hillside scrape as the fallback — see `biteCentre`. The seat is the
   * FACE the bore starts eating at; the job's origin steps half a radius
   * back onto the air side so the mouth's lip opens on this side of it.
   */
  const centre = new THREE.Vector3();
  const ray = biteRay(host, aim);
  const seated = biteCentre(host, aim, ray.reach, centre, ray.origin);
  if (!seated) {
    host.biteTouched = false;
    host.biteMiss();
    return;
  }
  const r = host.boreRadius();
  const origin = centre.clone().addScaledVector(aim, -(r * 1.5));
  host.digJob = new DigJob(origin, aim, host.boreLength(), r);
  /* The press answers NOW — beat zero of the schedule, not next frame. */
  digJobTick(host, 0, true);
}

/**
 * ONE FRAME OF THE BORE BEING EATEN. Called every simulated frame; quiet
 * when there is no job. `held` is the SCOOP press: releasing it abandons
 * the rest of the cylinder — the soil already chipped stays gone, which
 * is the honest partial — and there is no cooldown left to serve, because
 * the cooldown was only ever the eating itself.
 */
export function digJobTick(host: DigHost, dt: number, held: boolean): void {
  const job = host.digJob;
  if (!job) return;
  if (!held) {
    host.digJob = null;
    return;
  }
  const points = job.tick(dt);
  if (points.length > 0) {
    const touched = carveBrush(host, points, job.aim, job.radiusWu);
    job.carved += touched;
    if (touched > 0) host.biteTouched = true;
  }
  if (job.done) {
    /* A whole cylinder of nothing — wood, or the seat lied — is a press
     * that failed, and that belongs on the screen like any other miss. */
    if (job.carved === 0) {
      host.biteTouched = false;
      host.biteMiss();
    }
    host.digJob = null;
  }
}

/**
 * A SWEEP OF SPHERES TAKEN ALONG `points` — the cut itself.
 *
 * Everything that must accompany a cut travels with it: the spoil burst,
 * the one-way smoothing pass, the chamber-quest credit, and the
 * synchronous remesh of every chunk touched. A caller that carved without
 * these would reintroduce the stale-floor bug the remesh note below
 * describes, which is why this is one function rather than advice.
 *
 * This used to be `carveScoop`, two tangent 6 mm balls — the popcorn.
 * The sphere count and size are the caller's now (`digJobTick` hands in
 * one beat's worth of deeply-overlapping bore slices); what stays HERE is
 * everything a cut owes the rest of the game.
 */
export function carveBrush(
  host: DigHost, points: readonly THREE.Vector3[], aim: THREE.Vector3,
  radiusWu: number, grit?: number,
): number {
  let touched = 0;
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const at of points) {
    const result = host.stream!.subtractEllipsoid(at, aim, {
      deep: radiusWu,
      wide: radiusWu,
      tall: radiusWu,
    });
    if (result.changedSamples === 0) continue;
    touched += result.changedSamples;
    const bb = result.bounds;
    minX = Math.min(minX, bb.minX); maxX = Math.max(maxX, bb.maxX);
    minY = Math.min(minY, bb.minY); maxY = Math.max(maxY, bb.maxY);
    minZ = Math.min(minZ, bb.minZ); maxZ = Math.max(maxZ, bb.maxZ);
  }
  /* SPOIL, and only when soil actually came out. A stroke that met air
   * cuts nothing, and throwing chips off it would be the ghost's own
   * "confident hole over open air" mistake in another form. */
  if (touched === 0) return 0;
  const face = points[points.length - 1]!;
  host.grit?.burst(face, aim, grit);
  /*
   * AND SHAVE WHAT WAS JUST CUT, in the same stroke.
   *
   * This ran automatically once before and had to be pulled out,
   * because the brush could fill as well as shave and it brought roofs
   * down on tunnels barely wider than she is. One-way, it cannot: soil
   * is only ever removed, so the worst a stroke can do is open the hole
   * slightly wider than intended, which is the failure you want. So the
   * two are one action again — cut, then round off what the cut left.
   */
  const relaxed = smoothAround(host, face);
  if (relaxed) {
    minX = Math.min(minX, relaxed.minX); maxX = Math.max(maxX, relaxed.maxX);
    minY = Math.min(minY, relaxed.minY); maxY = Math.max(maxY, relaxed.maxY);
    minZ = Math.min(minZ, relaxed.minZ); maxZ = Math.max(maxZ, relaxed.maxZ);
  }
  // Work done at depth is chamber-building, whatever she calls it.
  if (host.depthMm() >= QUEST_DEPTH_MM * 0.7) host.deepCarved += touched;

  /*
   * THE CUT IS DRAWN THIS FRAME, NOT WHEN THE QUEUE GETS ROUND TO IT.
   *
   * The density changes the instant the scoop lands, and her body and
   * feet answer to the density — she steps down onto the new floor at
   * once. The PICTURE used to answer to the queue, and while digging the
   * queue runs one to two HUNDRED chunks deep (measured 140-213), which
   * at three to twelve chunks a frame is up to a second and a half of
   * lag. For that second the screen still draws the floor she just
   * removed, with her standing the best part of a scoop below it —
   * reported as "falls halfway into the terrain", with her legs planted
   * on ground the picture claims is solid. The physics was measured
   * clean the whole time (worst 0.4 mm); only the drawing was late.
   *
   * A scoop touches a couple of dozen chunks at most, so they are meshed
   * HERE, synchronously — the backlog behind them can take its time, but
   * what the shovel just changed is never allowed to be stale.
   */
  const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
  const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
  for (let cz = lo(minZ); cz <= hi(maxZ, CHUNKS_XZ); cz += 1) {
    for (let cy = lo(minY); cy <= hi(maxY, CHUNKS_Y); cy += 1) {
      for (let cx = lo(minX); cx <= hi(maxX, CHUNKS_XZ); cx += 1) {
        const key = host.key(cx, cy, cz);
        if (host.queued.has(key)) {
          /* Already waiting in line: pull it out — it is done now. */
          host.queued.delete(key);
          const at = host.queue.findIndex(
            (j) => j.cx === cx && j.cy === cy && j.cz === cz,
          );
          if (at >= 0) host.queue.splice(at, 1);
        }
        host.meshChunk(cx, cy, cz);
      }
    }
  }
  host.reveal();
  return touched;
}

/**
 * HOW FAR ALONG THE AIM THE SCOOP SITS — where it MEETS SOIL, not at a
 * fixed arm's length.
 *
 * Her jaws are about five millimetres out and the scoop is three deep, so
 * an anchor pinned to her reach is entirely INSIDE the hill the moment
 * she is closer to a face than that. It still carves: it opens a bubble a
 * few millimetres in, sealed behind an unbroken wall, so nothing appears
 * to happen — and stepping BACK until the scoop straddles the surface is
 * what made it work again. Reported exactly that way: right up against
 * dirt it will not dig, back up and it will.
 *
 * So the ray is walked out from her centre to the first soil it meets and
 * the scoop is seated a half-depth past that, which puts its near lip in
 * the air on this side of every face however close she is. Finding no
 * soil inside her reach means she is aiming at open sky, and the arm's
 * length is the honest answer again — that is the stroke that misses, and
 * it should.
 *
 * The preview draws from this same number, so what the ghost promises is
 * what the stroke takes.
 *
 * SOIL ONLY. The walker's field has the tree unioned into it so she can
 * climb the thing, but the shovel edits the voxel field and a tree is not
 * in it — aiming at bark would find "solid", cut nothing, and read as the
 * dig being broken again. Wood is not diggable, so the shovel does not
 * see it.
 */
/**
 * WHERE THE STROKE'S RAY STARTS, AND HOW FAR IT MAY GO — decided once,
 * so the shovel, the debug overlay and the probe hook cannot disagree.
 *
 * That they must agree is the overlay's entire value: "if the shovel is
 * aiming somewhere strange, this line is strange in exactly the same
 * way". Three copies of this arithmetic is three chances for the picture
 * to be reassuring about a cut it is no longer describing.
 */
export function biteRay(host: DigHost, aim: THREE.Vector3): { origin: THREE.Vector3; reach: number } {
  let hull = NOSE_REACH + JAW_PAST_NOSE;
  if (host.queenReady && host.queen.jawPosition(S_BITE_JAW)) {
    hull = Math.max(hull, S_BITE_JAW.sub(host.at).dot(aim));
  }
  if (!host.firstPerson) return { origin: host.at, reach: hull };
  /*
   * The reach stays measured from HER. How far her jaws go is a fact
   * about the animal, not about where the lens sits — and the lens is
   * stepped forward of her centre along this very aim, so charging the
   * distance it has already covered is what stops a first-person stroke
   * quietly out-reaching a third-person one.
   */
  const eye = host.camera.position;
  const ahead = (eye.x - host.at.x) * aim.x
    + (eye.y - host.at.y) * aim.y + (eye.z - host.at.z) * aim.z;
  return { origin: eye, reach: Math.max(0, hull - ahead) };
}

export function biteCentre(
  host: DigHost,
  aim: THREE.Vector3, reach: number, out: THREE.Vector3,
  origin: THREE.Vector3 = host.at,
): boolean {
  const step = CELL_SIZE * 0.5;
  /* HER bore now sets the seat's depth, not a constant scoop — the face
   * is pulled one radius in so the mouth straddles the surface however
   * close she stands, exactly the half-depth rule the scoop had. */
  const r = host.boreRadius();
  const far = reach + r * 2;
  for (let d = 0; d <= far; d += step) {
    const x = origin.x + aim.x * d;
    const y = origin.y + aim.y * d;
    const z = origin.z + aim.z * d;
    if (host.groundSolidAt(x, y, z)) {
      out.set(x, y, z).addScaledVector(aim, r);
      return true;
    }
  }
  /*
   * NOTHING ALONG THE AIM — SO DIG THE GROUND SHE IS ON.
   *
   * Measured on a hillside, aiming level: thirty millimetres of the ray
   * ahead of her is air, every sample, because she stands a body-height
   * off a surface that falls away in front of her. The stroke was seated
   * at arm's length in that air and removed nothing, which is the press
   * that does nothing — and at zero degrees, which is where the dial
   * starts and where "dig the entrance" begins.
   *
   * She is standing ON soil, though, and her jaws can reach it. So the
   * fallback drops from arm's length along her own down until it finds
   * the floor, and centres the scoop on it: half the mouthful is under
   * the surface, which is a scrape. That is what an ant aiming level at
   * a hillside actually does.
   */
  out.copy(origin).addScaledVector(aim, reach);
  for (let d = 0; d <= RIDE * 4; d += step) {
    const x = out.x - host.up.x * d;
    const y = out.y - host.up.y * d;
    const z = out.z - host.up.z * d;
    if (host.groundSolidAt(x, y, z)) {
      out.set(x, y, z);
      return true;
    }
  }
  /* Air ahead and air below it: she is over a drop, and this stroke is a
   * genuine miss. Left at arm's length so the ghost still shows where. */
  return false;
}

/** Builder ids are `b{k}-{i}` and `b{k}-e{i}` — how its half of a merged
 *  plan is told apart from anything the designer or a probe authored. */
function isBuilderId(id: string): boolean {
  return /^b\d+-/.test(id);
}

/**
 * Shave the bumps around a point, and only ever OUTWARD.
 *
 * A blur moves a surface both ways: it takes off the ridges that poke
 * into a tunnel, and it fills the hollows — and the filling is how a
 * roof comes down on a passage barely wider than the animal in it.
 * One-way, soil may be removed and never added, so narrowing is not
 * unlikely but arithmetically impossible. That is what lets this run on
 * every stroke instead of being a tool you have to remember to use.
 */
export function smoothAround(host: DigHost, centre: THREE.Vector3): { minX: number; minY: number;
  minZ: number; maxX: number; maxY: number; maxZ: number } | null {
  if (!host.stream) return null;
  const box = host.stream.boxAround(centre, host.brushMm / MM);
  let touched = null;
  for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) {
    const done = host.stream.smoothBox(box, SMOOTH_STRENGTH, SMOOTH_MAX_SHIFT, true);
    if (!done) break;
    touched = done;
  }
  return touched;
}

/**
 * THE AIM, DRAWN — diagnostic only, and it computes nothing of its own.
 *
 * GREEN is the line the stroke actually works along: the same
 * `boreAim()` vector `bite()` calls, from the same origin `biteRay`
 * gives it, ending at the same `biteCentre` the cut is seated on. It is not a
 * reconstruction — if the shovel is aiming somewhere strange, this line
 * is strange in exactly the same way, which is the whole point.
 *
 * RED is where the crosshair is looking: the camera's own position and
 * world direction. When the two disagree, both stay on screen and the
 * angle between them is printed, so "it digs where I am not pointing"
 * stops being a feeling and becomes a number.
 *
 * The yellow bead is the exact centre of the next terrain removal.
 *
 * Nothing is allocated per frame: three objects are made once on first
 * use and their vertices rewritten in place.
 */
export function updateAimDebug(host: DigHost, ): void {
  const show = host.aimDebug && host.digMode && host.ready;
  if (!show) {
    if (host.aimDbgDig) host.aimDbgDig.visible = false;
    if (host.aimDbgCam) host.aimDbgCam.visible = false;
    if (host.aimDbgHead) host.aimDbgHead.visible = false;
    if (host.aimDbgSpot) host.aimDbgSpot.visible = false;
    if (host.aimDbgJaw) host.aimDbgJaw.visible = false;
    if (host.aimDbgText) host.aimDbgText.style.display = 'none';
    return;
  }
  if (!host.aimDbgDig) {
    const line = (colour: number): THREE.Line => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const obj = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: colour, depthTest: false, transparent: true, opacity: 0.95,
      }));
      obj.renderOrder = 12;
      obj.frustumCulled = false;
      host.scene.add(obj);
      return obj;
    };
    /*
     * Unit spheres, SCALED BY RANGE each frame. Drawn at a fixed world
     * size and with depth testing off, a bead a millimetre from the
     * lens — which is exactly where her jaws are in first person —
     * becomes a wall of colour across the whole screen. Reported as
     * "weird stuff", and it was: the yellow shape swallowing the frame
     * was her mandible marker seen from the inside.
     */
    const bead = (colour: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 10, 8),
        new THREE.MeshBasicMaterial({ color: colour, depthTest: false }),
      );
      m.renderOrder = 13;
      host.scene.add(m);
      return m;
    };
    host.aimDbgDig = line(0x2fe36a);   // GREEN  the dig ray, as bite() has it
    host.aimDbgCam = line(0xe0553f);   // RED    the crosshair's own ray
    host.aimDbgHead = line(0x35d6e8);  // CYAN   the head bone's forward axis
    host.aimDbgSpot = bead(0xffffff); // WHITE  the carve centre
    host.aimDbgJaw = bead(0xffd23f);  // YELLOW the mandible tip
    host.aimDbgText = document.createElement('div');
    host.aimDbgText.className = 'density-lab-status rail-status';
    host.aimDbgText.style.top = '58px';
    host.aimDbgText.style.whiteSpace = 'pre';
    host.aimDbgText.style.fontSize = '11px';
    host.hud.appendChild(host.aimDbgText);
  }

  /*
   * THE SAME ARITHMETIC `bite()` DOES, in the same order — including the
   * jaw bone's say over how far along the aim the hull reaches, and
   * `biteCentre`'s own fallback to a scrape when the aim meets nothing.
   * Anything less faithful would draw a line the cut does not follow,
   * which is the bug this exists to catch.
   */
  const aim = boreAim(host);
  const centre = S_DBG_CENTRE;
  const haveJaw = host.queenReady && host.queen.jawPosition(S_DBG_JAW);
  /* The SAME origin and reach the shovel uses — see `biteRay`. Drawing
   * this from her centre while the stroke fires from the lens is exactly
   * the "line the cut does not follow" this overlay exists to catch. */
  const ray = biteRay(host, aim);
  const willBite = biteCentre(host, aim, ray.reach, centre, ray.origin);

  const put = (obj: THREE.Line, a: THREE.Vector3, b: THREE.Vector3): void => {
    const pos = obj.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    obj.visible = true;
  };

  /* GREEN — the stroke's real ray: from wherever `biteRay` starts it (the
   * lens in first person, her centre over the shoulder) to the exact seat
   * of the next scoop. */
  put(host.aimDbgDig!, ray.origin, centre);
  /* About a degree across, whatever the range — see `bead`. */
  const sizeAt = (at: THREE.Vector3): number =>
    Math.max(0.02, host.camera.position.distanceTo(at) * 0.012);
  host.aimDbgSpot!.position.copy(centre);
  host.aimDbgSpot!.scale.setScalar(sizeAt(centre));
  host.aimDbgSpot!.visible = true;
  (host.aimDbgSpot!.material as THREE.MeshBasicMaterial).color.setHex(
    willBite ? 0xffffff : 0xff5c5c,
  );

  /* YELLOW — where her mandibles actually are, and CYAN — where the head
   * bone is actually pointed. The gap between the yellow bead and the
   * green line's origin IS the anatomical error being measured. */
  const haveHead = host.queenReady && host.queen.eyeForwardWorld(S_DBG_HEAD);
  host.aimDbgJaw!.visible = haveJaw;
  if (haveJaw) {
    host.aimDbgJaw!.position.copy(S_DBG_JAW);
    host.aimDbgJaw!.scale.setScalar(sizeAt(S_DBG_JAW));
  }
  if (haveJaw && haveHead) {
    S_DBG_END.copy(S_DBG_JAW).addScaledVector(S_DBG_HEAD, NOSE_REACH * 2);
    put(host.aimDbgHead!, S_DBG_JAW, S_DBG_END);
  } else if (host.aimDbgHead) host.aimDbgHead.visible = false;

  /* RED — the crosshair's own ray, stopped where it first meets soil so
   * both lines end on the same face and the gap between their ends is
   * the error at the range that matters. */
  host.camera.updateMatrixWorld();
  const camAt = host.camera.position;
  const camDir = host.camera.getWorldDirection(S_DBG_DIR);
  const reach = Math.max(host.at.distanceTo(centre), NOSE_REACH * 3);
  S_DBG_END.copy(camAt).addScaledVector(camDir, reach);
  for (let d = CELL_SIZE * 0.5; d <= reach; d += CELL_SIZE * 0.5) {
    const x = camAt.x + camDir.x * d;
    const y = camAt.y + camDir.y * d;
    const z = camAt.z + camDir.z * d;
    if (host.soilSolidAt(x, y, z)) { S_DBG_END.set(x, y, z); break; }
  }
  put(host.aimDbgCam!, camAt, S_DBG_END);

  /*
   * HOW FAR THE HEAD TRAILS THE VIEW, measured rather than assumed.
   *
   * The whole reason the dig was taken off the jaw bone in v0.0.1 was
   * that the bone "lags her by a frame of easing". This keeps a ring of
   * recent camera looks and reports WHICH one the head's current facing
   * matches best: 0 means the head is on this frame's view, 5 means it
   * is showing what the camera was looking at five frames ago.
   */
  if (host.aimDbgLook.length < AIM_DBG_LAG) {
    host.aimDbgLook.push(camDir.clone());
  } else {
    host.aimDbgLook[host.aimDbgLookAt % AIM_DBG_LAG]!.copy(camDir);
  }
  host.aimDbgLookAt += 1;
  let bestLag = -1;
  let bestOff = Infinity;
  if (haveHead && host.aimDbgLook.length === AIM_DBG_LAG) {
    for (let k = 0; k < AIM_DBG_LAG; k += 1) {
      const idx = (host.aimDbgLookAt - 1 - k + AIM_DBG_LAG * 2) % AIM_DBG_LAG;
      const off = Math.acos(Math.max(-1, Math.min(1,
        host.aimDbgLook[idx]!.dot(S_DBG_HEAD))));
      if (off < bestOff) { bestOff = off; bestLag = k; }
    }
  }

  const now = performance.now();
  if (now - host.aimDbgAt < 100) return;
  host.aimDbgAt = now;
  const mm = (v: THREE.Vector3): string =>
    `${(v.x * MM).toFixed(1)}, ${(v.y * MM).toFixed(1)}, ${(v.z * MM).toFixed(1)}`;
  const deg = (a: THREE.Vector3, b: THREE.Vector3): number =>
    (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
  /*
   * WHERE THE CARVE LANDS RELATIVE TO HER JAWS, split in the HEAD's own
   * frame — forward is reach, and the other two are the offsets the
   * report is about: how far above her mandibles the hole opens, and how
   * far to one side.
   */
  let lift = 0;
  let side = 0;
  let ahead = 0;
  if (haveJaw && haveHead) {
    host.queen.eyeUpWorld(S_DBG_UP);
    S_DBG_RIGHT.crossVectors(S_DBG_HEAD, S_DBG_UP).normalize();
    S_DBG_REL.copy(centre).sub(S_DBG_JAW);
    ahead = S_DBG_REL.dot(S_DBG_HEAD) * MM;
    lift = S_DBG_REL.dot(S_DBG_UP) * MM;
    side = S_DBG_REL.dot(S_DBG_RIGHT) * MM;
  }
  host.aimDbgText!.style.display = '';
  host.aimDbgText!.textContent = [
    `AIM DEBUG  ${willBite ? 'bite WILL touch soil' : 'bite touches NOTHING'}`,
    `RED   cam ray ${mm(camAt)}`,
    `GREEN dig ray ${mm(host.at)}`,
    `YELLOW jaw    ${haveJaw ? mm(S_DBG_JAW) : 'no rig'}`,
    `WHITE carve   ${mm(centre)}`,
    `cam vs bore   ${deg(camDir, aim).toFixed(1)}\u00b0`,
    `cam vs head   ${haveHead ? `${deg(camDir, S_DBG_HEAD).toFixed(1)}\u00b0` : '-'}`,
    `jaw off axis  ${haveJaw ? `${(S_DBG_JAW.distanceTo(host.at) * MM).toFixed(2)} mm from centre` : '-'}`,
    `jaw to carve  ${haveJaw ? `${(S_DBG_JAW.distanceTo(centre) * MM).toFixed(2)} mm` : '-'}`,
    `carve vs jaw  fwd ${ahead.toFixed(2)}  up ${lift.toFixed(2)}  side ${side.toFixed(2)} mm`,
    `head lag      ${bestLag < 0 ? '-' : `${bestLag} frame(s), ${((bestOff * 180) / Math.PI).toFixed(1)}\u00b0`}`,
  ].join('\n');
}


/** Remesh every chunk a brush result touched — bite()'s own loop, shared. */
export function enqueueBounds(host: DigHost, b: {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}): void {
  const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
  const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
  for (let cz = lo(b.minZ); cz <= hi(b.maxZ, CHUNKS_XZ); cz += 1) {
    for (let cy = lo(b.minY); cy <= hi(b.maxY, CHUNKS_Y); cy += 1) {
      for (let cx = lo(b.minX); cx <= hi(b.maxX, CHUNKS_XZ); cx += 1) {
        host.enqueue(cx, cy, cz);
      }
    }
  }
}


