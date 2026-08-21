/**
 * THE ROUND DIGGING BAR, and the dirt that comes off the face.
 *
 * Asked for by name: "make it like a 3D version of Ant Scout with the round
 * loading/digging bar". So this is that bar, copied from the thing it is meant
 * to look like rather than reinvented. Ant Scout draws it in one line
 * (`js/systems/render.js`):
 *
 *     ctx.strokeStyle = '#ffd23a'; ctx.lineWidth = 3;
 *     ctx.arc(sx, sy, CELL * 0.32, -PI/2, -PI/2 + digProgress * PI * 2);
 *
 * Four things worth keeping out of that, and all four are here:
 *
 *   - THE COLOUR. `#ffd23a`, which is TCS's gold anyway.
 *   - IT STARTS AT TWELVE O'CLOCK AND GOES CLOCKWISE. A progress ring that
 *     starts anywhere else reads as decoration rather than as a clock.
 *   - IT SITS ON THE CELL, not on the HUD. The bar is at the face she is
 *     chewing, which is what makes it legible with no labels at all — you can
 *     see WHICH cell is coming out as well as how far along it is.
 *   - AND THE CELL IS OUTLINED behind it, pale, so a fresh target reads
 *     before the bar has anything in it.
 *
 * ## Two things the 2D version did not have to solve
 *
 * IT HAS TO FACE THE PLAYER. A ring lying in the world's XY plane is an
 * ellipse from anywhere else and a line from the side. It is billboarded onto
 * the camera every frame, so it is a circle from wherever the keeper has
 * dragged the view to.
 *
 * AND IT MUST NOT BE BURIED. The face she is digging is, by definition, soil
 * with more soil behind it — a depth-tested ring at that cell is half inside
 * the material. So the gauge does not depth-test at all and draws last. That
 * is the right call for what it IS: a readout that happens to live at a world
 * position, not an object in the tank.
 *
 * ## How the arc grows without allocating
 *
 * The ring is built once as a fan of segments wound clockwise from the top,
 * and `setDrawRange` reveals a prefix of them. So a frame of progress is one
 * integer written to the geometry — no rebuilt buffers, no per-frame garbage,
 * which matters because eventually there is one of these per digging ant.
 * The cost is that the arc advances in whole segments; at 72 of them that is
 * five degrees, which is finer than the eye follows on a two-second fill.
 */

import * as THREE from 'three';

/** Ant Scout's gold, unchanged. */
export const DIG_GOLD = 0xffd23a;

/** The pale outline on the cell being worked. */
export const DIG_OUTLINE = 0xfff0b4;

/**
 * The ring's radii, as a fraction of a voxel.
 *
 * Ant Scout strokes at `CELL * 0.32` — a ring two thirds the width of the
 * cell it is on, sitting comfortably inside the outline box. These keep that
 * proportion, with the stroke width turned into an inner radius.
 */
export const RING_OUTER = 0.34;
export const RING_INNER = 0.26;

/** How finely the sweep is quantised. 72 is five degrees a step. */
export const RING_SEGMENTS = 72;

/**
 * How long a puff of dug soil lives, in seconds, and how many come out of a
 * broken cell.
 *
 * Ant Scout throws dust continuously WHILE digging and a bigger burst when
 * the cell goes. Only the burst is here: the continuous version is a 2D
 * game's answer to a face you are looking at flat on, and in 3D a permanent
 * haze around the queen mostly hides the queen.
 */
export const DUST_LIFE = 0.9;
export const DUST_GRAINS = 14;

/**
 * The dig readout: an outlined cell with a round bar on it.
 *
 * Owns no state about digging — it is SHOWN a target and a progress each
 * frame and does as it is told. The excavator decides what is true; this
 * decides what that looks like.
 */
export class DigGauge {
  readonly root = new THREE.Group();

  private readonly ring: THREE.Mesh;

  private readonly outline: THREE.LineSegments;

  private readonly ringGeometry: THREE.BufferGeometry;

  constructor() {
    this.root.visible = false;
    /* Last, and over everything. See the note on burial at the head. */
    this.root.renderOrder = 10;

    this.ringGeometry = buildRing();
    this.ring = new THREE.Mesh(this.ringGeometry, new THREE.MeshBasicMaterial({
      color: DIG_GOLD, side: THREE.DoubleSide, depthTest: false, transparent: true,
    }));
    this.ring.renderOrder = 11;

    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({
        color: DIG_OUTLINE, depthTest: false, transparent: true, opacity: 0.5,
      }),
    );
    this.outline.renderOrder = 10;

    this.root.add(this.outline);
    this.root.add(this.ring);
  }

  /**
   * Put the readout on a cell, filled to `progress`, seen from `camera`.
   *
   * A null cell hides the whole thing, which is what "she stopped digging"
   * looks like — Ant Scout clears its target the same frame the button comes
   * up, and a bar left hanging on a cell nobody is chewing is a lie.
   *
   * THE OUTLINE STAYS PUT AND ONLY THE RING TURNS. The box is a cell and a
   * cell is axis-aligned; billboarding it would spin the soil's own geometry
   * against the soil around it.
   */
  show(
    cell: readonly [number, number, number] | null,
    progress: number,
    camera: THREE.Camera,
  ): void {
    if (!cell) { this.root.visible = false; return; }
    this.root.visible = true;
    /* Cell centres are at the half — the cell (2,3,4) spans 2..3 in x. */
    this.root.position.set(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5);
    this.ring.quaternion.copy(camera.quaternion);

    const filled = Math.max(0, Math.min(1, progress));
    /*
     * Six indices a segment — two triangles. Rounded UP so any progress at
     * all shows something: a bar that is still empty a fifth of a second
     * after she started reads as a bar that is not working.
     */
    const segments = filled <= 0 ? 0 : Math.max(1, Math.ceil(filled * RING_SEGMENTS));
    this.ringGeometry.setDrawRange(0, segments * 6);
    this.ring.visible = segments > 0;
  }

  /**
   * The same readout, on a WORLD POINT rather than a cell.
   *
   * The density tray has no cells to outline — a bore is a capsule at an
   * arbitrary angle, and boxing it would draw a grid that does not exist.
   * So the box is hidden here and the ring alone carries the progress, which
   * is the half of Ant Scout's readout that was ever about time.
   *
   * A separate entry point rather than a mode flag on `show`, because the
   * voxel tray still uses cells and its call should not have to know that
   * another tray exists.
   */
  showAt(
    point: THREE.Vector3 | null,
    progress: number,
    camera: THREE.Camera,
    scale = 1,
  ): void {
    if (!point) { this.root.visible = false; return; }
    this.root.visible = true;
    this.root.position.copy(point);
    this.outline.visible = false;
    this.ring.quaternion.copy(camera.quaternion);
    this.ring.scale.setScalar(scale);
    const filled = Math.max(0, Math.min(1, progress));
    const segments = filled <= 0 ? 0 : Math.max(1, Math.ceil(filled * RING_SEGMENTS));
    this.ringGeometry.setDrawRange(0, segments * 6);
    this.ring.visible = segments > 0;
  }

  dispose(): void {
    this.ringGeometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
  }
}

/**
 * A ring wound CLOCKWISE FROM THE TOP, segment by segment, so that drawing
 * the first `n` segments draws the first `n` steps of a clock face.
 *
 * The winding is the whole trick and it is easy to get subtly wrong: on
 * screen, up is `+y` and clockwise from up goes toward `+x`, so the angle
 * runs `(sin t, cos t)` and not the `(cos t, sin t)` that comes to hand
 * first. That version starts at three o'clock and turns the wrong way.
 */
function buildRing(): THREE.BufferGeometry {
  const positions = new Float32Array(RING_SEGMENTS * 4 * 3);
  const indices = new Uint16Array(RING_SEGMENTS * 6);
  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const a = (i / RING_SEGMENTS) * Math.PI * 2;
    const b = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
    const corners = [
      [Math.sin(a) * RING_INNER, Math.cos(a) * RING_INNER],
      [Math.sin(a) * RING_OUTER, Math.cos(a) * RING_OUTER],
      [Math.sin(b) * RING_OUTER, Math.cos(b) * RING_OUTER],
      [Math.sin(b) * RING_INNER, Math.cos(b) * RING_INNER],
    ];
    for (let c = 0; c < 4; c += 1) {
      const at = (i * 4 + c) * 3;
      positions[at] = corners[c]![0]!;
      positions[at + 1] = corners[c]![1]!;
      positions[at + 2] = 0;
    }
    const v = i * 4;
    const at = i * 6;
    indices[at] = v; indices[at + 1] = v + 1; indices[at + 2] = v + 2;
    indices[at + 3] = v; indices[at + 4] = v + 2; indices[at + 5] = v + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return geometry;
}

/**
 * THE DIRT THAT COMES OUT, when a cell finally goes.
 *
 * Ant Scout bursts dirt at the cell the moment it breaks, and it is doing
 * more work than it looks: without it a cube of soil vanishes between one
 * frame and the next, which reads as a rendering glitch rather than as an
 * excavation. The particles are what say "that was removed".
 *
 * COLOURED FROM THE MATERIAL THAT BROKE, so clay throws red dust and sand
 * throws pale — the strata are already in the world and this is nearly free
 * to honour.
 *
 * One fixed pool, reused. Grains past their life are parked far away rather
 * than removed, so the buffer never resizes.
 */
export class DirtBurst {
  readonly points: THREE.Points;

  private readonly life: Float32Array;

  private readonly velocity: Float32Array;

  private readonly positions: Float32Array;

  private readonly colors: Float32Array;

  private next = 0;

  constructor(private readonly capacity = DUST_GRAINS * 8) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.points = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.22, vertexColors: true, transparent: true, opacity: 0.85,
      sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.park();
  }

  private park(): void {
    for (let i = 0; i < this.capacity; i += 1) this.positions[i * 3 + 1] = -1000;
  }

  /** Throw a handful of soil out of a cell, in the colour it was. */
  burst(
    cell: readonly [number, number, number],
    colour: readonly [number, number, number],
    rand: () => number,
  ): void {
    for (let n = 0; n < DUST_GRAINS; n += 1) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const at = i * 3;
      this.positions[at] = cell[0] + 0.5 + (rand() - 0.5) * 0.8;
      this.positions[at + 1] = cell[1] + 0.5 + (rand() - 0.5) * 0.8;
      this.positions[at + 2] = cell[2] + 0.5 + (rand() - 0.5) * 0.8;
      this.velocity[at] = (rand() - 0.5) * 2.2;
      this.velocity[at + 1] = rand() * 2.4;
      this.velocity[at + 2] = (rand() - 0.5) * 2.2;
      this.colors[at] = colour[0];
      this.colors[at + 1] = colour[1];
      this.colors[at + 2] = colour[2];
      this.life[i] = DUST_LIFE;
    }
    this.flush();
  }

  /**
   * Fall and fade. Gravity is a made-up number rather than 9.81: these are
   * five-millimetre cells, the whole burst lives under a second, and what it
   * has to look like is soil dropping — not what it has to be is ballistics.
   */
  step(dt: number): void {
    let live = false;
    for (let i = 0; i < this.capacity; i += 1) {
      if (this.life[i]! <= 0) continue;
      live = true;
      this.life[i] = Math.max(0, this.life[i]! - dt);
      const at = i * 3;
      this.velocity[at + 1] = this.velocity[at + 1]! - 9 * dt;
      this.positions[at] = this.positions[at]! + this.velocity[at]! * dt;
      this.positions[at + 1] = this.positions[at + 1]! + this.velocity[at + 1]! * dt;
      this.positions[at + 2] = this.positions[at + 2]! + this.velocity[at + 2]! * dt;
      if (this.life[i]! <= 0) this.positions[at + 1] = -1000;
    }
    if (live) this.flush();
  }

  private flush(): void {
    const attribute = this.points.geometry.getAttribute('position');
    attribute.needsUpdate = true;
    this.points.geometry.getAttribute('color').needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
