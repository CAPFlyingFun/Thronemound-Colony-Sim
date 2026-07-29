/**
 * Six-axis orientation for ant surface walking.
 *
 * In a voxel world every surface is an axis-aligned cube face, so "up" is
 * always one of six directions — never an arbitrary angle. That turns general
 * gravity-walking (hard, quaternion-shaped) into a small discrete state
 * machine, and it is the single reason this feature is affordable here.
 *
 * The governing rule: **physics orientation is always one of the six discrete
 * frames; only the CAMERA interpolates.** Never interpolate the collision box
 * through an in-between angle — an axis-aligned box at 43 degrees fits nowhere,
 * and the moment you allow it the whole simplification collapses.
 *
 * Pure logic, no three.js, no renderer — the corner cases are exactly the kind
 * of thing that is miserable to debug by flailing in a browser and pleasant to
 * debug in a test.
 */

import { isSolid, type VoxelId } from './VoxelWorld';

export type AxisDirection = 'pos_x' | 'neg_x' | 'pos_y' | 'neg_y' | 'pos_z' | 'neg_z';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const AXIS_VECTORS: Readonly<Record<AxisDirection, Readonly<Vec3>>> = {
  pos_x: { x: 1, y: 0, z: 0 },
  neg_x: { x: -1, y: 0, z: 0 },
  pos_y: { x: 0, y: 1, z: 0 },
  neg_y: { x: 0, y: -1, z: 0 },
  pos_z: { x: 0, y: 0, z: 1 },
  neg_z: { x: 0, y: 0, z: -1 },
};

export const ALL_AXES: readonly AxisDirection[] = [
  'pos_x', 'neg_x', 'pos_y', 'neg_y', 'pos_z', 'neg_z',
];

/** World up — the frame you're in when not attached to anything. */
export const WORLD_UP: AxisDirection = 'pos_y';

export function axisVector(axis: AxisDirection): Readonly<Vec3> {
  return AXIS_VECTORS[axis];
}

export function opposite(axis: AxisDirection): AxisDirection {
  return axis.startsWith('pos') ? (axis.replace('pos', 'neg') as AxisDirection)
    : (axis.replace('neg', 'pos') as AxisDirection);
}

/** Nearest axis direction to an arbitrary vector. */
export function axisFromVector(v: Vec3): AxisDirection {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return v.x >= 0 ? 'pos_x' : 'neg_x';
  if (ay >= az) return v.y >= 0 ? 'pos_y' : 'neg_y';
  return v.z >= 0 ? 'pos_z' : 'neg_z';
}

/** Are two axes perpendicular? (Neither equal nor opposite.) */
export function isPerpendicular(a: AxisDirection, b: AxisDirection): boolean {
  return a !== b && a !== opposite(b);
}

export type SurfaceMode =
  | 'grounded'
  | 'attached'
  | 'transitioning'
  | 'airborne';

export interface SurfaceState {
  mode: SurfaceMode;
  /** Which way is "up" for gravity, movement plane and the collision box. */
  up: AxisDirection;
  /** Voxel the ant is standing on, if any. */
  support: Vec3 | null;
  /** Milliseconds remaining before another orientation change is allowed. */
  lockRemaining: number;
}

/**
 * Once a transition starts, competing surface normals are ignored until it
 * finishes. Without this the ant ping-pongs between two faces in a corner,
 * because both are legitimately "nearest" within a fraction of a voxel.
 */
export const ORIENTATION_LOCK_MS = 180;

/** How close to an edge before crossing it is even considered. */
export const EDGE_COMMIT_DISTANCE = 0.35;
/** How firmly movement must point across an edge to commit to it. */
export const INPUT_COMMIT_THRESHOLD = 0.45;

export function createSurfaceState(): SurfaceState {
  return { mode: 'grounded', up: WORLD_UP, support: null, lockRemaining: 0 };
}

export function tickLock(state: SurfaceState, dtMs: number): void {
  state.lockRemaining = Math.max(0, state.lockRemaining - dtMs);
}

export function canChangeOrientation(state: SurfaceState): boolean {
  return state.lockRemaining <= 0;
}

interface Sampler {
  get(x: number, y: number, z: number): VoxelId;
}

export interface SurfaceCandidate {
  /** The `up` this surface would give the ant. */
  up: AxisDirection;
  /** The solid voxel providing the surface. */
  voxel: Vec3;
  /** Ranking score; higher wins. */
  score: number;
}

function floorVec(v: Vec3): Vec3 {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) };
}

/**
 * Every solid face touching the ant, ranked.
 *
 * Ranking deliberately does NOT go by distance alone. At a corner two faces are
 * within a hair of each other, and picking by distance makes the choice
 * arbitrary — which is how orientation ping-pong starts. Priority order:
 *
 *   1. the surface currently supporting us (stay put unless there's a reason)
 *   2. the surface we're actively moving toward
 *   3. the one best aligned with the current up (least disorienting)
 */
export function rankSurfaces(
  world: Sampler,
  position: Vec3,
  state: SurfaceState,
  moveDir: Vec3 | null,
): SurfaceCandidate[] {
  const base = floorVec(position);
  const candidates: SurfaceCandidate[] = [];

  for (const axis of ALL_AXES) {
    // A surface whose normal is `axis` sits in the direction opposite `axis`.
    const toward = axisVector(opposite(axis));
    const voxel: Vec3 = {
      x: base.x + toward.x,
      y: base.y + toward.y,
      z: base.z + toward.z,
    };
    if (!isSolid(world.get(voxel.x, voxel.y, voxel.z))) continue;

    let score = 0;
    if (state.support
      && state.up === axis
      && state.support.x === voxel.x && state.support.y === voxel.y && state.support.z === voxel.z) {
      score += 100; // current support wins ties outright
    }
    if (moveDir) {
      const dot = moveDir.x * toward.x + moveDir.y * toward.y + moveDir.z * toward.z;
      if (dot > 0) score += 40 * dot; // moving into this surface
    }
    const up = axisVector(state.up);
    const alignment = up.x * axisVector(axis).x + up.y * axisVector(axis).y + up.z * axisVector(axis).z;
    score += 10 * alignment; // prefer the least disorienting change

    candidates.push({ up: axis, voxel, score });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

/** The surface directly beneath the ant in its current frame, if any. */
export function supportBelow(world: Sampler, position: Vec3, up: AxisDirection): Vec3 | null {
  const down = axisVector(opposite(up));
  const base = floorVec(position);
  const voxel = { x: base.x + down.x, y: base.y + down.y, z: base.z + down.z };
  return isSolid(world.get(voxel.x, voxel.y, voxel.z)) ? voxel : null;
}

export interface EdgeDecision {
  /** Whether to reorient this frame. */
  commit: boolean;
  /** The new up, if committing. */
  up: AxisDirection | null;
  reason: 'none' | 'no-support' | 'not-committed' | 'locked' | 'convex' | 'concave';
}

/**
 * Decide whether the ant crosses onto an adjacent face.
 *
 * The commitment rule exists so you can stand still low on a wall without being
 * yanked onto the floor: proximity alone is never enough, movement has to point
 * across the edge as well.
 */
export function evaluateEdge(
  world: Sampler,
  position: Vec3,
  state: SurfaceState,
  moveDir: Vec3 | null,
  moveMagnitude: number,
): EdgeDecision {
  if (!canChangeOrientation(state)) {
    return { commit: false, up: null, reason: 'locked' };
  }

  const support = supportBelow(world, position, state.up);
  if (support) {
    // Still standing on our own surface — nothing to decide.
    return { commit: false, up: null, reason: 'none' };
  }

  // Support has run out: we're at an edge. Only cross with committed movement.
  if (!moveDir || moveMagnitude < INPUT_COMMIT_THRESHOLD) {
    return { commit: false, up: null, reason: 'not-committed' };
  }

  const ranked = rankSurfaces(world, position, state, moveDir)
    .filter((candidate) => candidate.up !== state.up);
  const best = ranked[0];
  if (!best) return { commit: false, up: null, reason: 'no-support' };

  // Perpendicular to the old up is a convex edge (crawling over a lip);
  // the reverse of it is concave (into an inside corner).
  const reason = isPerpendicular(best.up, state.up) ? 'convex' : 'concave';
  return { commit: true, up: best.up, reason };
}

/** Apply an orientation change and start the hysteresis lock. */
export function applyOrientation(state: SurfaceState, up: AxisDirection, support: Vec3 | null): void {
  state.up = up;
  state.support = support;
  state.mode = up === WORLD_UP ? 'grounded' : 'attached';
  state.lockRemaining = ORIENTATION_LOCK_MS;
}

/**
 * Yaw and pitch are measured INSIDE a frame, so the same numbers mean different
 * world directions once `up` changes. Reorienting without re-solving them
 * teleports your head: you look down a shaft, mount its wall, and end up facing
 * sideways for no reason you can see.
 *
 * These three functions are the fix. `lookVector` turns a frame plus yaw/pitch
 * into a world direction; `reframeLook` runs it backwards, finding the yaw and
 * pitch that reproduce a given world direction in a NEW frame. Reorient through
 * them and only "which way is down" changes — the view stays put.
 *
 * The maximum pitch a frame can express. Straight along `up` is a singularity
 * (yaw stops meaning anything there), so stop just short of it.
 */
export const MAX_PITCH = 1.5;

/**
 * A deterministic reference right-vector per axis, so yaw means the same thing
 * every time you attach to a given face. Depends only on the axis letter, never
 * the sign, and is always perpendicular to it.
 */
export function referenceRight(up: AxisDirection): Vec3 {
  return up.endsWith('_y') ? { x: 1, y: 0, z: 0 }
    : up.endsWith('_x') ? { x: 0, y: 1, z: 0 }
      : { x: 1, y: 0, z: 0 };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z);
  return length === 0 ? { x: 0, y: 0, z: 0 } : { x: v.x / length, y: v.y / length, z: v.z / length };
}

/** The movement-plane forward for a frame at this yaw. */
export function surfaceForward(up: AxisDirection, yaw: number): Vec3 {
  const u = axisVector(up);
  const r0 = referenceRight(up);
  const f0 = normalize(cross(u, r0));
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return normalize({
    x: f0.x * cos - r0.x * sin,
    y: f0.y * cos - r0.y * sin,
    z: f0.z * cos - r0.z * sin,
  });
}

/** Where the camera points, in world space, for a frame at this yaw and pitch. */
export function lookVector(up: AxisDirection, yaw: number, pitch: number): Vec3 {
  const forward = surfaceForward(up, yaw);
  const u = axisVector(up);
  const cos = Math.cos(pitch);
  const sin = Math.sin(pitch);
  return normalize({
    x: forward.x * cos + u.x * sin,
    y: forward.y * cos + u.y * sin,
    z: forward.z * cos + u.z * sin,
  });
}

/**
 * The yaw and pitch that reproduce a world-space look direction in `up`'s
 * frame — `lookVector` run backwards.
 *
 * `fallbackYaw` covers the singularity: looking exactly along the new up, every
 * yaw gives the same view, so there is nothing to solve and the old one is kept.
 */
export function reframeLook(look: Vec3, up: AxisDirection, fallbackYaw = 0): { yaw: number; pitch: number } {
  const u = axisVector(up);
  const alongUp = Math.min(1, Math.max(-1, dot(normalize(look), u)));
  const pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, Math.asin(alongUp)));

  const n = normalize(look);
  const planar = { x: n.x - u.x * alongUp, y: n.y - u.y * alongUp, z: n.z - u.z * alongUp };
  if (planar.x * planar.x + planar.y * planar.y + planar.z * planar.z < 1e-8) {
    return { yaw: fallbackYaw, pitch };
  }
  const p = normalize(planar);
  const r0 = referenceRight(up);
  const f0 = normalize(cross(u, r0));
  return { yaw: Math.atan2(-dot(p, r0), dot(p, f0)), pitch };
}

/**
 * Turn a screen drag into a new world look direction.
 *
 * Storing look as yaw-about-`up` plus pitch means the DRAG AXES change meaning
 * whenever the frame does. Standing on the floor, dragging sideways turns you
 * left and right; mount a wall and the same drag runs you along the shaft while
 * dragging vertically moves you toward and away from the wall. The camera ends
 * up pointing correctly and then the controls do something different from what
 * they did a second ago.
 *
 * So rotate the LOOK VECTOR about the camera's own axes — sideways about its
 * up, vertically about its right — and re-solve yaw and pitch from the result.
 * A drag then means the same thing on screen in all six frames, and the frame
 * keeps owning gravity, collision and the movement plane.
 */
export function dragLook(look: Vec3, up: AxisDirection, dx: number, dy: number): Vec3 {
  const l = normalize(look);
  const u = axisVector(up);
  // The camera's own right and up, which is what the drag should feel relative
  // to. Near the pole `l` and `u` are parallel and the cross collapses; fall
  // back to the frame's reference right so a drag still does something sane.
  let right = cross(l, u);
  if (right.x * right.x + right.y * right.y + right.z * right.z < 1e-8) {
    right = referenceRight(up);
  }
  right = normalize(right);
  const camUp = normalize(cross(right, l));
  return normalize(rotateAbout(rotateAbout(l, camUp, -dx), right, -dy));
}

/** Rodrigues rotation of `v` about a unit `axis` by `angle` radians. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const k = normalize(axis);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - cos);
  return {
    x: v.x * cos + kv.x * sin + k.x * kd,
    y: v.y * cos + kv.y * sin + k.y * kd,
    z: v.z * cos + kv.z * sin + k.z * kd,
  };
}

/**
 * The signed roll between two frames, measured about the look direction they
 * share.
 *
 * Screen-up is always the frame's `up`, so reorienting rotates the whole
 * picture about the centre of the screen in a single frame — the look direction
 * stayed put but the image spun. Feeding this back as a decaying offset turns
 * that cut into a turn.
 */
export function rollBetween(look: Vec3, from: AxisDirection, to: AxisDirection): number {
  const l = normalize(look);
  const screenUp = (axis: AxisDirection): Vec3 | null => {
    const u = axisVector(axis);
    const right = cross(l, u);
    if (right.x * right.x + right.y * right.y + right.z * right.z < 1e-8) return null;
    return normalize(cross(normalize(right), l));
  };
  const a = screenUp(from);
  const b = screenUp(to);
  if (!a || !b) return 0; // looking along one of the axes; roll is undefined
  return Math.atan2(dot(cross(a, b), l), dot(a, b));
}

/**
 * The wall an unattached ant could grip: solid, perpendicular to world up, and
 * touching the ant. Returns the `up` that gripping it would produce.
 */
export function attachableWall(
  world: Sampler,
  position: Vec3,
  state: SurfaceState,
  facing: Vec3 | null,
): AxisDirection | null {
  if (state.mode === 'attached') return null;
  const ranked = rankSurfaces(world, position, state, facing)
    .filter((candidate) => isPerpendicular(candidate.up, WORLD_UP));
  return ranked[0]?.up ?? null;
}
