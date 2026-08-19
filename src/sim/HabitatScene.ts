/**
 * LAB 00 — THE VOXEL ANT BODY BRIDGE. `?scene=habitat`.
 *
 * The smallest room that can be wrong about the one thing this milestone is
 * for: can a Fire Ant queen STAND on voxel soil and WALK over it under her
 * own direction, with nobody's hand on her.
 *
 * WHAT IS HERE: a formicarium — the glass tank from `voxel/formicarium`, the
 * layered soil from `voxel/terrain`, and one queen. She is driven by
 * `antStroll` (what she wants), moved by `AntBody` (the legs move her) and
 * posed by the shared rig. Four files, one job each.
 *
 * WHAT IS DELIBERATELY NOT HERE, and every absence is a later milestone:
 * digging, brood, food, pheromones, the habitat builder, saves, a HUD with
 * anything in it, and any way at all for the player to steer her. There is
 * no input handler in this file. That is the acceptance criterion, not an
 * oversight — "no player input required" is on the list.
 *
 * AND NOTHING FROM `IslandScene`. Also on the list, and the reason the
 * simulation gets its own tuning rather than importing `islandTuning`: those
 * constants belong to the frozen direct-control build.
 *
 * THE MATERIAL IS PLAIN, on purpose. `voxel/voxelMaterial` builds the real
 * tiled/normal-mapped soil this world will eventually wear, and wiring it in
 * is a rendering job that cannot make the bridge more or less correct.
 * Vertex colours off the mesher show the shape of the ground and the shape
 * of the ant, which is what this milestone is judged on. Swapping the
 * material later touches this file and nothing under it.
 */

import * as THREE from 'three';
import {
  MATERIALS, VoxelWorld, isSolid, materialOf, type VoxelId,
} from '../voxel/VoxelWorld';
import {
  RELIEF_VOXELS, habitatFill, habitatGenerator, habitatSlope,
  type HabitatOptions,
} from './habitatSoil';
import { ceilingFor, isGlassCell, type BoxOptions } from '../voxel/formicarium';
import { meshChunk } from '../voxel/mesher';
import { AntBody } from './AntBody';
import { AntStroll, type StrollSenses } from './antStroll';
import { VoxelGround } from './voxelGround';

/** The tank, in voxels. 96 is 48 cm across — a real formicarium footprint. */
const SIZE = 96;

/** Where the flat reference ground sits before the terrain adds relief. */
const SURFACE_Y = 40;

/** A material id of our own for the glass, above the soil ids. */
const GLASS: VoxelId = 5;

/**
 * The footprint her legs cover, as offsets to sample around a candidate
 * spot, in voxels.
 *
 * Two voxels is ten millimetres — a little under a queen's length, which is
 * about as far as a foot gets from her middle. Four points rather than eight
 * because the fifth through eighth never disagreed with their neighbours in
 * a tray this smooth, and this runs inside a decision she makes several
 * times a second.
 */
const BODY_RING: readonly (readonly [number, number])[] = [
  [2, 0], [-2, 0], [0, 2], [0, -2],
];

export class HabitatScene {
  readonly scene = new THREE.Scene();

  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly world: VoxelWorld;

  private readonly ground: VoxelGround;

  /**
   * The world as BOTH the mesher and the ant read it — one description of
   * where the soil's surface is, so the ground she walks on and the ground
   * that is drawn cannot drift apart.
   *
   * The mesher takes `fill` and `slope` to draw a partial top cell as the
   * smooth bank it represents rather than as a five-millimetre stair. Before
   * the ant read the same numbers she was walking the raw lattice: measured,
   * two of six feet planted, because a one-cell step is taller than she is.
   */
  private readonly soil: {
    get(x: number, y: number, z: number): VoxelId;
    inBounds(x: number, y: number, z: number): boolean;
    fill(x: number, y: number, z: number): number;
    slope(x: number, y: number, z: number): readonly [number, number, number] | null;
  };

  private readonly box: BoxOptions;

  private readonly ant = new AntBody('queen');

  private readonly stroll: AntStroll;

  private readonly meshes = new Map<number, THREE.Mesh>();

  private last = 0;

  private running = false;

  ready = false;

  /** Seconds of simulation since START — the colony's own clock. */
  elapsed = 0;

  constructor(private readonly host: HTMLElement, seed = 1) {
    /*
     * DETERMINISTIC BY DEFAULT. A habitat that differs every reload cannot
     * be compared against yesterday's screenshot, and this room exists to
     * be compared. The seed is the only randomness in the world.
     */
    const gen = habitatGenerator({ surfaceY: SURFACE_Y, size: SIZE, seed });
    /*
     * ROUNDED UP TO A WHOLE CELL, and that `Math.ceil` is load-bearing.
     *
     * `RELIEF_VOXELS` is 1.5, so the first cut handed `ceilingFor` a
     * fractional height and got a ceiling of 53.5 back. Every scan that
     * counted down from it then walked HALF-INTEGER y values — 40.5, 39.5 —
     * which index no cell, so the surface scan reported the wrong column
     * top and seated her 1.5 mm above the soil with all six feet reaching
     * into space. Measured: 0.46 of 6 planted.
     *
     * A cell index is an integer. The lid is a row of cells.
     */
    this.box = {
      size: SIZE, ceilingY: ceilingFor(Math.ceil(SURFACE_Y + RELIEF_VOXELS)),
    };
    const box = this.box;
    /* The glass is folded into the generator rather than stamped afterwards,
     * so a chunk is never meshed in a state where the tank has no walls. */
    this.world = new VoxelWorld(SIZE, box.ceilingY + 2, SIZE, (x, y, z) => (
      isGlassCell(x, y, z, box) ? GLASS : gen(x, y, z)
    ));
    /*
     * Glass is a whole cell and gets no fill — it is a pane, not a bank. The
     * terrain's fill applies to soil only, and only to the top of a column,
     * which is what `surfaceFill` already answers.
     */
    const terrain: HabitatOptions = { surfaceY: SURFACE_Y, size: SIZE, seed };
    const world = this.world;
    this.soil = {
      get: (x, y, z) => world.get(x, y, z),
      inBounds: (x, y, z) => world.inBounds(x, y, z),
      fill: (x, y, z) => (
        world.get(x, y, z) === GLASS ? 1 : habitatFill(x, y, z, terrain)
      ),
      slope: (x, y, z) => (
        world.get(x, y, z) === GLASS ? null : habitatSlope(x, z, terrain)
      ),
    };
    this.ground = new VoxelGround(this.soil);

    let n = seed >>> 0;
    const rand = (): number => {
      /* Mulberry32 — small, seeded, and not `Math.random`, so the same seed
       * gives the same ant every run. */
      n += 0x6d2b79f5;
      let t = n;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.stroll = new AntStroll(rand);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    host.appendChild(this.renderer.domElement);
    this.light();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /**
   * The top of the soil in a column, in world units, or null for a column
   * with nothing in it.
   *
   * Scanned from the ceiling down so a column with a cavity in it reports
   * its TOP surface — which is the one an ant on the surface stands on.
   * When the colony starts digging, the ant inside a tunnel will need the
   * floor beneath HER instead, and that is `VoxelGround.nearest`, which is
   * already the leg solver's question. Two different questions, two
   * different callers, neither guessing.
   */
  surfaceAt = (x: number, z: number): number | null => {
    const vx = Math.floor(x);
    const vz = Math.floor(z);
    if (!this.world.inBounds(vx, 0, vz)) return null;
    /*
     * Below the lid, so the glass ceiling is never mistaken for ground, and
     * carrying the top cell's fill so she stands on the drawn bank rather
     * than on the cell boundary under it.
     */
    for (let y = Math.floor(this.box.ceilingY) - 1; y >= 0; y -= 1) {
      const id = this.world.get(vx, y, vz);
      if (id === GLASS || !isSolid(id)) continue;
      return y + this.soil.fill(vx, y, vz);
    }
    return null;
  };

  /** What the brain is allowed to ask about the world. */
  private readonly senses: StrollSenses = {
    groundAhead: (heading, probe) => {
      const x = this.ant.at.x + Math.sin(heading) * probe;
      const z = this.ant.at.z + Math.cos(heading) * probe;
      /*
       * SOMEWHERE HER WHOLE BODY FITS, not somewhere her middle does.
       *
       * She is about two and a half voxels long and her legs reach out to
       * either side of that, so a spot with soil under its centre and a
       * glass pane half a voxel away is a spot where three of her feet are
       * over the pane. A pane is solid from the floor to the lid, so a leg
       * searching down it finds no surface at all and stays up: measured,
       * she settled 0.1 voxels off the glass and walked the perimeter with
       * a leg permanently groping.
       *
       * So the question is asked of a small ring, not a point. Cheaper than
       * it looks — four samples, only while she is deciding.
       */
      for (const [ox, oz] of BODY_RING) {
        const top = this.surfaceAt(x + ox, z + oz);
        if (top === null) return false;
        /*
         * And ground she could actually step ONTO. A rise taller than she
         * is reads as a wall: there is no climbing in this milestone, so
         * walking at one would be walking into it.
         */
        if (top - (this.ant.at.y - 0.2) >= 1.5) return false;
      }
      return true;
    },
  };

  async start(): Promise<void> {
    await this.ant.load();
    this.scene.add(this.ant.model.root);
    this.build();

    /* Set down in the middle, on whatever the terrain put there. */
    const mid = SIZE / 2;
    const top = this.surfaceAt(mid, mid) ?? SURFACE_Y;
    this.ant.place(mid, mid, top, 0);
    this.ant.plant(this.ground);

    this.camera.position.set(mid - 26, top + 16, mid - 26);
    this.camera.lookAt(mid, top, mid);

    this.ready = true;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  private light(): void {
    this.scene.background = new THREE.Color(0x1a1d22);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2c22, 1.1));
  }

  /**
   * Mesh every chunk once. Nothing moves the soil in this milestone.
   *
   * THE GLASS IS NOT DRAWN, and that is the honest reading of a
   * formicarium: you look THROUGH the panes. The ant still meets them —
   * `this.soil` carries the glass and her legs read it — so what is drawn
   * and what is solid differ here on purpose, in the one place where being
   * invisible is the object's whole nature. The tank's extent is drawn as a
   * wire box instead, so the player can see where the world ends.
   *
   * COLOUR IS ASSEMBLED HERE. The mesher's `colors` are a SHADE — ambient
   * occlusion times a per-voxel tint — and the material colour normally
   * arrives through the tiled texture array via `aLayer`. Lab 00 does not
   * want that pipeline yet, so the shade is multiplied by the material's own
   * colour and handed over as plain vertex colours. Swapping the real
   * material in later replaces this function and nothing under it.
   */
  private build(): void {
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
    });
    /* Glass reads as air to the MESHER only. */
    const drawn = {
      ...this.soil,
      get: (x: number, y: number, z: number) => {
        const id = this.world.get(x, y, z);
        return id === GLASS ? 0 : id;
      },
    };
    for (const index of this.world.allMeshableChunks()) {
      const [cx, cy, cz] = this.world.chunkCoords(index);
      const data = meshChunk(drawn, cx, cy, cz);
      if (!data || data.indices.length === 0) continue;
      const geometry = new THREE.BufferGeometry();
      /*
       * NO `mesh.position` OFFSET. `meshChunk` already emits WORLD-space
       * positions — it adds `chunkX * CHUNK` itself — so translating the
       * mesh as well put every chunk at twice its own coordinate and
       * scattered the tray into floating slabs. `DigScene` does not offset
       * them either; that is where this was checked.
       */
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(
        tinted(data.colors, data.layers), 3,
      ));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      const mesh = new THREE.Mesh(geometry, material);
      this.scene.add(mesh);
      this.meshes.set(index, mesh);
    }
    this.drawTank();
  }

  /** The tank's edges, so an invisible pane still reads as a boundary. */
  private drawTank(): void {
    const { size, ceilingY } = this.box;
    const box = new THREE.Box3(
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(size, ceilingY, size),
    );
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(
        size, ceilingY, size,
      )),
      new THREE.LineBasicMaterial({ color: 0x7fa8c4, transparent: true, opacity: 0.5 }),
    );
    box.getCenter(edges.position);
    this.scene.add(edges);
  }

  /** One simulation step. Split out so a probe can drive it without a clock. */
  tick(dt: number): void {
    if (!this.ready) return;
    this.elapsed += dt;
    const intent = this.stroll.step(dt, this.ant.heading, this.senses);
    this.ant.step(dt, intent, this.ground, this.surfaceAt);
  }

  private readonly frame = (): void => {
    const now = performance.now();
    /* Clamped: a backgrounded tab returns with a second of dt and an ant
     * that teleports across the tank. */
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.running) this.tick(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private readonly resize = (): void => {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /* ------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.running = !on; }

  /**
   * One step with the brain BYPASSED — a probe naming her intent directly.
   *
   * Not a cheat and not player input: it is how "does she stand correctly"
   * gets asked without the answer depending on whether the stroll happened
   * to be walking that second. Standing and walking are two different
   * claims about her legs — a tripod gait carries her on three feet by
   * design, so the six-feet-down question can only be asked of an ant who
   * has been told to hold still.
   */
  tickForTest(dt: number, walk: number, turn: number): void {
    if (!this.ready) return;
    this.elapsed += dt;
    this.ant.step(dt, { walk, turn }, this.ground, this.surfaceAt);
  }

  /** Everything a probe needs to judge "she stands and walks correctly". */
  reportForTest(): {
    at: { x: number; y: number; z: number };
    heading: number; state: string; elapsed: number;
    planted: number; groping: number; movedMm: number;
    surfaceUnder: number | null; ride: number;
  } {
    const r = this.ant.report;
    const top = this.surfaceAt(this.ant.at.x, this.ant.at.z);
    return {
      at: { x: this.ant.at.x, y: this.ant.at.y, z: this.ant.at.z },
      heading: this.ant.heading,
      state: this.stroll.state,
      elapsed: this.elapsed,
      planted: r?.planted ?? 0,
      groping: r?.groping ?? 0,
      movedMm: r?.movedMm ?? 0,
      surfaceUnder: top,
      ride: top === null ? 0 : this.ant.at.y - top,
    };
  }

  boundsForTest(): { size: number; ceilingY: number } {
    return { size: SIZE, ceilingY: this.box.ceilingY };
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    this.renderer.dispose();
  }
}

/**
 * The mesher's shade, multiplied by each vertex's own material colour.
 *
 * `layers` carries the voxel id per vertex, which is exactly what the tiled
 * material uses to pick a texture — so this is the same mapping done with a
 * flat colour instead of an image.
 */
function tinted(shade: Float32Array, layers: Float32Array): Float32Array {
  const out = new Float32Array(shade.length);
  for (let i = 0, v = 0; i < shade.length; i += 3, v += 1) {
    const material = materialOf(layers[v] ?? 0);
    const colour = material.color === MATERIALS[0]!.color
      ? [0.5, 0.5, 0.5] as const : material.color;
    out[i] = shade[i]! * colour[0]!;
    out[i + 1] = shade[i + 1]! * colour[1]!;
    out[i + 2] = shade[i + 2]! * colour[2]!;
  }
  return out;
}
