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
  MATERIALS, VOXEL_MM, VoxelWorld, isSolid, materialOf, type VoxelId,
} from '../voxel/VoxelWorld';
import {
  RELIEF_VOXELS, habitatFill, habitatGenerator, habitatSlope,
  type HabitatOptions,
  habitatCornerHeight, habitatHeight,
} from './habitatSoil';
import { ceilingFor, isGlassCell, type BoxOptions } from '../voxel/formicarium';
import { DRAPE_LIMIT } from '../voxel/terrain';
import { meshChunk } from '../voxel/mesher';
import { AntBody, LOOK_UP } from './AntBody';
import { AntStroll, type StrollSenses } from './antStroll';
import { VoxelGround } from './voxelGround';
import { ObserverCamera } from './observerCamera';
import { Excavation, type Cell, type Diggable } from './excavation';
import { DugSoil, FILL_EPSILON } from './dugSoil';
import { AntFounding, type FoundingSenses } from './founding';
import { DigGauge, DirtBurst } from './digGauge';

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
/** How much room to keep around her when the camera is following, in
 *  voxels — a couple of body lengths, enough to see her legs work. */
const FOLLOW_RADIUS = 6;

/**
 * How far above her origin to ask "is there soil here" — the middle of her
 * body, in voxels. Her back is about 0.64 voxels up (`bodyTopAboveSole`), so
 * this is chest height: low enough that a bank she cannot climb blocks her,
 * high enough that the floor she is standing on does not.
 */
const BODY_MIDDLE = 0.3;

const BODY_RING: readonly (readonly [number, number])[] = [
  [2, 0], [-2, 0], [0, 2], [0, -2],
];

export class HabitatScene {
  readonly scene = new THREE.Scene();

  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly world: VoxelWorld;

  private readonly ground: VoxelGround;

  /** How full every cell is, terrain plus whatever has been dug out of it. */
  private readonly dug: DugSoil;

  /** The height field the tray was generated from. */
  private readonly terrain: HabitatOptions;

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

  /** Public so a probe can ask where the view is pointing. */
  view: ObserverCamera | null = null;

  /** Is the camera locked onto her, or holding still over the tank? */
  private following = false;

  private readonly stroll: AntStroll;

  /** The dig system. The only thing here allowed to remove soil. */
  private readonly excavate: Excavation;

  /** Her founding brain — what she wants, never what she does. */
  readonly founding: AntFounding;

  /** Ant Scout's round digging bar, at the cell she is chewing. */
  private readonly gauge = new DigGauge();

  /** And the soil that comes out of it. */
  private readonly dust = new DirtBurst();

  /** Chunks whose geometry no longer matches the world. */
  private readonly stale = new Set<number>();

  private readonly rand: () => number;

  private readonly meshes = new Map<number, THREE.Mesh>();

  private last = 0;

  private watcher: ResizeObserver | null = null;

  private reframe = 0;

  private running = false;

  ready = false;

  /** See the seam at the head of `tick`. */
  private foundingOn = true;

  setFoundingForTest(on: boolean): void { this.foundingOn = on; }

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
    this.terrain = terrain;
    const world = this.world;
    /*
     * HOW FULL A CELL IS — the terrain's answer for untouched soil, and the
     * dug store's for anything an ant has been at. One object, consulted by
     * the mesher, by the ant's footing and by the dig system alike, so a
     * half-eaten cell is drawn, stood on and chewed as the same shape.
     */
    this.dug = new DugSoil(SIZE, SIZE, (x, y, z) => (
      world.get(x, y, z) === GLASS ? 1 : habitatFill(x, y, z, terrain)
    ));
    const dug = this.dug;
    this.soil = {
      get: (x, y, z) => world.get(x, y, z),
      inBounds: (x, y, z) => world.inBounds(x, y, z),
      /*
       * AND AN AIR CELL IS EMPTY, whatever the height field says about it.
       * The terrain's fill is a function of position, so it keeps answering
       * for a cell long after an ant has removed it — a dug cell would go on
       * reporting the fraction it had when it was soil.
       */
      fill: (x, y, z) => (isSolid(world.get(x, y, z)) ? dug.fill(x, y, z) : 0),
      /*
       * AND A PART-DUG CELL IS NOT A SLOPE. `slope` is what makes the mesher
       * blend a cell into the smooth terrain sheet around it, which is right
       * for a hillside and wrong for the floor of a tunnel — a cut face
       * should look cut. The sampler owns that distinction, and the mesher's
       * own note says so: "dug soil can be part full without being surface at
       * all."
       */
      slope: (x, y, z) => (
        world.get(x, y, z) === GLASS || dug.touched(x, y, z)
          ? null
          : habitatSlope(x, z, terrain)
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
    this.rand = rand;
    this.stroll = new AntStroll(rand);
    /*
     * THE DIG SYSTEM'S VIEW OF THE WORLD: the voxel array for what is where,
     * and the dug-fill store for how much of it is left. Assembled here
     * rather than inside `Excavation` so the excavator stays testable against
     * a nine-cell fake, and so nothing but this line knows the two are
     * separate objects.
     */
    const diggable: Diggable = {
      get: (x, y, z) => world.get(x, y, z),
      inBounds: (x, y, z) => world.inBounds(x, y, z),
      dig: (x, y, z) => world.dig(x, y, z),
      fillOf: (x, y, z) => this.dug.fill(x, y, z),
      setFill: (x, y, z, fill) => this.dug.setFill(x, y, z, fill),
      clearFill: (x, y, z) => this.dug.clear(x, y, z),
    };
    this.excavate = new Excavation(diggable);
    this.founding = new AntFounding(rand);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 4000);
    host.appendChild(this.renderer.domElement);
    this.light();
    this.view = new ObserverCamera(this.camera, this.renderer.domElement);
    this.resize();
    /*
     * FOUR WAYS TO HEAR ABOUT A ROTATION, because on a phone one is not
     * enough.
     *
     * Reported from an iPhone: turning the device did not recentre. The
     * first cut listened to `window.resize` alone and read `clientWidth`
     * immediately — but Safari fires that BEFORE the new layout has settled,
     * so the aspect was recomputed from the old size and the tank sat half
     * off the screen. `orientationchange` fires early too, `visualViewport`
     * is the one that reports the real drawable area, and a `ResizeObserver`
     * on the host catches every case none of them cover. All four land in
     * the same deferred handler, which reads the size a frame later, once
     * the browser has finished.
     */
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);
    window.visualViewport?.addEventListener('resize', this.onViewportChange);
    this.watcher = new ResizeObserver(this.onViewportChange);
    this.watcher.observe(host);
    this.buildViewButton();
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
  surfaceAt = (x: number, z: number, from?: number): number | null => {
    const vx = Math.floor(x);
    const vz = Math.floor(z);
    if (!this.world.inBounds(vx, 0, vz)) return null;
    /*
     * SCANNED DOWN FROM WHERE THE ASKER IS, not from the lid — and that
     * argument is what lets an ant be underground at all.
     *
     * Scanning from the ceiling answers "the top of this column", which is
     * the right question for an ant on the surface and exactly the wrong one
     * for an ant in a tunnel: her floor is under her, and the top of her
     * column is the roof of the burrow with the whole tray on top of it. A
     * queen who walked into her own shaft was lifted straight back out of it.
     *
     * `solveFeet` has the identical argument for the identical reason — its
     * note says a burrow makes "the ground here" depend on where you are
     * standing — so this is the same rule applied one level up, at the body
     * instead of at the foot.
     *
     * Capped at the lid so the glass ceiling is never mistaken for ground,
     * and carrying the top cell's fill so she stands on the drawn bank
     * rather than on the cell boundary under it.
     */
    const lid = Math.floor(this.box.ceilingY) - 1;
    const top = from === undefined ? lid : Math.min(lid, Math.floor(from));
    for (let y = top; y >= 0; y -= 1) {
      const id = this.world.get(vx, y, vz);
      if (id === GLASS || !isSolid(id)) continue;
      const fill = this.soil.fill(vx, y, vz);
      /*
       * A CELL WITH NO SOIL IN IT IS NOT GROUND, whatever its id says.
       *
       * A voxel can be solid and empty at once — the terrain gives a column's
       * top cell a fractional fill and it can land on nought, and a cell dug
       * down to a hair keeps its material id until it is removed. Stopping at
       * one of those reports a floor at the cell's own base with open air
       * under it. Measured mid-tunnel: she was seated at y=40.00 standing on a
       * cell of fill 0, with the real floor 0.9 voxels below her at 39.1, and
       * all six feet groping for ground she was floating over.
       */
      if (fill <= FILL_EPSILON) continue;
      return y + fill;
    }
    return null;
  };

  /** What the founding brain is allowed to ask. Reads only. */
  private readonly foundingSenses: FoundingSenses = {
    /*
     * OUTSIDE THE WORLD IS FULL, not air. A brain that reads the void as
     * diggable space would walk its ramp out through the end of the array;
     * the dig system would refuse the cells, but she would stand there
     * wanting them forever.
     */
    fillAt: (x, y, z) => {
      if (!this.world.inBounds(x, y, z)) return 1;
      if (!isSolid(this.world.get(x, y, z))) return 0;
      return this.dug.fill(x, y, z);
    },
    floorUnder: (x, z, from) => this.surfaceAt(x, z, from),
  };

  /** What the stroller is allowed to ask about the world. */
  private readonly senses: StrollSenses = {
    groundAhead: (heading, probe) => {
      const x = this.ant.at.x + Math.sin(heading) * probe;
      const z = this.ant.at.z + Math.cos(heading) * probe;
      const eye = this.ant.at.y + LOOK_UP;
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
        const top = this.surfaceAt(x + ox, z + oz, eye);
        if (top === null) return false;
      }
      /*
       * AND SOMEWHERE HER BODY FITS — asked as "is there soil where I would
       * be standing", not as "is the ground ahead much higher than here".
       *
       * The height comparison it replaces could only work above ground. In a
       * tunnel every reading is taken from her own eye height, so a wall and
       * an open corridor report floors a few millimetres apart and the test
       * waved her into the rock face. Solid-at-body-height is the same
       * question asked directly, and it means the same thing on a bank as it
       * does forty millimetres down.
       */
      /*
       * ASKED OF `VoxelGround.solidAt`, which is the ONE test in this build
       * that understands a part-full cell: it reports a cell drawn seven
       * tenths full as solid for its first seven tenths and air above that.
       *
       * Asked instead of the voxel's ID — which is what a first cut did —
       * every point on the tray reads as solid, because the terrain marks the
       * top cell of every column solid and then gives it a fractional fill.
       * She stood in the open turning circles: 4674 degrees of heading change
       * and nought voxels travelled, permanently in the "avoiding" state,
       * because the whole world was a wall.
       *
       * Sampled at her BODY's middle rather than at the floor, because that
       * is the question: not "is the ground higher there" but "is there soil
       * where I would be". It means the same thing on a bank as it does forty
       * millimetres down a tunnel.
       */
      if (this.ground.solidAt(x, this.ant.at.y + BODY_MIDDLE, z)) return false;
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

    /* Framed on the whole tank, fitted to whatever shape the screen is. */
    this.frameTank();

    this.ready = true;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  /**
   * ONE BUTTON, AND IT MOVES A CAMERA.
   *
   * The brief is firm that the UI reads simulation state and sends keeper
   * commands but never implements simulation, so this is about as much UI as
   * Lab 00 is entitled to: it changes what is looked at and nothing about
   * what happens. She walks the same either way.
   *
   * A button rather than a double-tap because a double-tap on the glass is
   * also the start of a drag, and an observer who wanted to swing the view
   * should not find themselves snapped onto an ant instead.
   */
  private buildViewButton(): void {
    const b = document.createElement('button');
    b.textContent = 'WATCH HER';
    b.style.cssText = [
      'position:absolute', 'right:14px', 'bottom:14px', 'z-index:5',
      'min-height:44px', 'padding:10px 16px',
      'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'letter-spacing:0.12em', 'color:#efe3c4',
      'background:rgba(24,22,18,0.86)',
      'border:1px solid rgba(247,226,176,0.34)', 'border-radius:10px',
      'touch-action:manipulation',
    ].join(';');
    b.addEventListener('click', () => {
      this.setFollow(!this.following);
      b.textContent = this.following ? 'WATCH THE TANK' : 'WATCH HER';
    });
    this.host.appendChild(b);
    this.viewButton = b;
  }

  private viewButton: HTMLButtonElement | null = null;

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
    this.soilMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
    });
    for (const index of this.world.allMeshableChunks()) this.remesh(index);
    this.scene.add(this.gauge.root);
    this.scene.add(this.dust.points);
    this.drawTank();
  }

  /** Glass reads as air to the MESHER only — the wire box draws the tank. */
  private readonly drawn = {
    get: (x: number, y: number, z: number): VoxelId => {
      const id = this.world.get(x, y, z);
      return id === GLASS ? 0 : id;
    },
    inBounds: (x: number, y: number, z: number): boolean => (
      this.world.inBounds(x, y, z)
    ),
    fill: (x: number, y: number, z: number): number => this.soil.fill(x, y, z),
    slope: (x: number, y: number, z: number) => this.soil.slope(x, y, z),
    cornerHeight: (cx: number, cz: number): number => this.corner(cx, cz),
  };

  /**
   * THE HEIGHT OF THE DRAWN SHEET AT A LATTICE CORNER — reported from the
   * device as "the faces of the terrain aren't blending".
   *
   * `fill` can only squash a cell flat, so a slope drawn from fills alone is
   * a flight of level treads with a riser between each pair, and the tray
   * reads as a checkerboard of tiles rather than as ground. Corners are
   * SHARED: every surface cell touching this corner places its top vertex at
   * this same height, so their tops meet along their common edges exactly and
   * the steps disappear into one sheet. The mesher has had the hook all along
   * (`cornerHeight`); this scene simply never gave it one.
   *
   * AND IT SAGS INTO A DIG. The pristine field is a fiction reconciling a
   * height function with a lattice, and the fiction only holds while the
   * lattice underneath still matches it: cut a trench and the sheets either
   * side go on sloping toward ground that is not there any more, leaving a
   * crust hanging over the hole with its underside culled — which is a hole
   * in the world at every glancing angle. So a corner with a dug column
   * against it is pulled down toward that column's floor.
   *
   * Not all the way down, though. `DRAPE_LIMIT` is a voxel and a half, which
   * covers the rim of a shallow cutting; anything deeper is a SHAFT, and a
   * shaft mouth should stay a crisp rim with blocky walls under it rather
   * than a sheet plunging to its floor. That boundary is the frozen dig
   * scene's, and it was drawn there for the same reason.
   */
  private corner(cx: number, cz: number): number {
    const pristine = habitatCornerHeight(cx, cz, this.terrain);
    /* Costs four column reads a corner and cannot fire on untouched soil. */
    if (this.dug.overrides === 0 && this.world.excavated === 0) return pristine;
    let h = pristine;
    for (let dx = -1; dx <= 0; dx += 1) {
      for (let dz = -1; dz <= 0; dz += 1) {
        const x = cx + dx;
        const z = cz + dz;
        /*
         * UNDUG COLUMNS COST ONE READ. The pristine top cell of a column
         * that nobody has touched is still soil, and its corner cannot have
         * sagged — so the expensive part is skipped for the whole tray
         * except the handful of columns around the nest.
         *
         * It is not a micro-optimisation. Asked as a full column scan from
         * the lid, this ran for every corner of every surface cell of every
         * chunk rebuilt by a bite, and the simulation went from finishing a
         * founding in under seven minutes to not finishing two minutes of it
         * in three of wall clock.
         */
        const top = Math.ceil(habitatHeight(x, z, this.terrain)) - 1;
        if (!this.world.inBounds(x, top, z)) continue;
        if (isSolid(this.world.get(x, top, z))
          && this.dug.fill(x, top, z) > FILL_EPSILON) continue;
        const floor = this.surfaceAt(x, z, top);
        if (floor === null) continue;
        /*
         * Clamped against the PRISTINE height, never against the running
         * minimum: the cap is "how far the sheet may sag below where it was",
         * and taking it off an already-sagged `h` compounds per dug column —
         * four open shafts round one corner would pull it down four limits
         * deep, in whatever order the loop happened to visit them.
         */
        h = Math.min(h, Math.max(floor, pristine - DRAPE_LIMIT));
      }
    }
    return h;
  }

  private soilMaterial: THREE.Material | null = null;

  /**
   * Rebuild one chunk's geometry from the world as it is now.
   *
   * The same path builds the tray at start and repairs it after a bite, so a
   * dug tunnel cannot be drawn by different code from the soil around it.
   * A chunk that ends up with no faces has its mesh removed outright rather
   * than left holding the old triangles.
   */
  private remesh(index: number): void {
    const [cx, cy, cz] = this.world.chunkCoords(index);
    const data = meshChunk(this.drawn, cx, cy, cz);
    const existing = this.meshes.get(index);
    if (!data || data.indices.length === 0) {
      if (existing) {
        this.scene.remove(existing);
        existing.geometry.dispose();
        this.meshes.delete(index);
      }
      return;
    }
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
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geometry;
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.soilMaterial!);
    this.scene.add(mesh);
    this.meshes.set(index, mesh);
  }

  /**
   * Redraw whatever digging changed, once a frame.
   *
   * BATCHED RATHER THAN IMMEDIATE. A single bite dirties up to 27 chunks
   * through the mesher's dependency radius, and neighbouring bites dirty most
   * of the same ones; re-meshing at the moment of the break would rebuild the
   * same chunk several times in a frame for nothing.
   */
  private repaint(): void {
    if (this.stale.size === 0) return;
    for (const index of this.stale) this.remesh(index);
    this.stale.clear();
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
  /**
   * ONE FRAME OF THE COLONY, in the brief's own order.
   *
   *     AI decides -> dig system validates -> terrain changes -> she moves
   *
   * The order is the design, not a detail. Digging happens BEFORE she is
   * moved and has no say in where she ends up: the excavator removes a cell,
   * and then the walker walks her wherever her legs can carry her, which may
   * be into the space that just appeared or may be nowhere at all. Card 01:
   * "Digging must NEVER directly drive ant locomotion." Nothing below writes
   * a position.
   */
  tick(dt: number): void {
    if (!this.ready) return;
    this.elapsed += dt;

    /*
     * THE STROLLER ALONE, when the founding is switched off.
     *
     * Not a game mode — a test seam. "She stands and walks correctly on voxel
     * soil" and "she founds a nest unaided" are two different claims about
     * two different systems, and `probe:habitat` exists to hold the first
     * one. With the brain running she commits to a site six seconds in and
     * never strolls again, so that probe would be measuring the founding and
     * reporting it as locomotion.
     */
    if (!this.foundingOn) {
      this.ant.step(
        dt, this.stroll.step(dt, this.ant.heading, this.senses),
        this.ground, this.surfaceAt,
      );
      return;
    }

    /* 1. WHAT SHE WANTS. */
    const want = this.founding.step(dt, {
      x: this.ant.at.x, y: this.ant.at.y, z: this.ant.at.z,
      heading: this.ant.heading,
    }, this.foundingSenses);

    /*
     * While she is still choosing a site she walks like an ant rather than
     * like a machine on rails — the stroller already knows to keep off the
     * glass, and the founding brain has no business learning that too.
     */
    const move = this.founding.state === 'seeking'
      ? this.stroll.step(dt, this.ant.heading, this.senses)
      : { walk: want.walk, turn: want.turn };

    /* 2. AND WHETHER SHE MAY HAVE IT. */
    /*
     * THE DIG SYSTEM FINISHES WHAT IT STARTS.
     *
     * A new wish is only taken up when the excavator is free. The brain is
     * allowed to change its mind about what it WANTS every frame — it derives
     * the corridor from her pose, and her pose moves — but a half-chewed cell
     * abandoned a frame before it breaks is a cell that never breaks.
     *
     * That was not hypothetical. The brain drops a cell from its wish list as
     * soon as the cell is thin enough to be finished, which is exactly one
     * frame before the excavator would have removed it: measured, a queen dug
     * a fifty-five-cell tunnel and removed precisely none of it, leaving a
     * ramp of cells shaved to a fiftieth of a voxel that still counted as
     * soil. Ownership of "when is this cell done" belongs to the thing doing
     * the digging.
     *
     * An empty wish still cancels — that is the brain saying stop, which is a
     * different statement from the brain saying dig elsewhere.
     */
    if (!want.digAt) this.excavate.cancel();
    else if (!this.excavate.target) this.excavate.aim(want.digAt, want.leave);

    /* 3. THE SOIL CHANGES — and only here. */
    const working = this.excavate.target;
    const bite = this.excavate.bite(dt);
    /*
     * A cell being EATEN INTO redraws as well as one that goes: the fill
     * drains in eighths and the tunnel wall has to follow it, or the soil
     * stays whole on screen until the instant it vanishes — which is the
     * cube-popping-out-of-existence this was meant to replace.
     */
    if (bite.changed && working) this.dirty(working);
    if (bite.broke) this.broke(bite.broke, bite.removed);
    this.gauge.show(this.excavate.target, this.excavate.progress, this.camera);
    this.dust.step(dt);

    /* 4. AND SHE MOVES, on her own legs, knowing none of the above. */
    this.ant.step(dt, move, this.ground, this.surfaceAt);

    this.repaint();
  }

  /**
   * A cell came out: throw its dirt and mark what has to be re-drawn.
   *
   * THE NEIGHBOURS TOO. A chunk's mesh is built from its own cells AND a
   * margin of the ones around it, so removing a cell on a chunk boundary
   * changes the faces of the chunk next door. Re-meshing only the owner
   * leaves a soil wall standing in mid-air along the seam.
   */
  private broke(cell: Cell, removed: VoxelId): void {
    this.dust.burst(cell, materialOf(removed).color, this.rand);
    this.dirty(cell);
  }

  /**
   * Mark a cell's geometry out of date — AND ITS NEIGHBOURS'.
   *
   * A chunk's mesh is built from its own cells and a margin of the ones
   * around it, so changing a cell on a chunk boundary changes the faces of
   * the chunk next door. Re-meshing only the owner leaves a soil wall
   * standing in mid-air along the seam. `chunksNear` already knows the
   * mesher's dependency radius; its own comment is about a bug of exactly
   * this shape.
   */
  private dirty(cell: Cell): void {
    for (const index of this.world.chunksNear(cell[0], cell[1], cell[2])) {
      this.stale.add(index);
    }
  }

  private readonly frame = (): void => {
    const now = performance.now();
    /* Clamped: a backgrounded tab returns with a second of dt and an ant
     * that teleports across the tank. */
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.running) this.tick(dt);
    this.view?.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * The whole habitat on screen, whichever way the phone is held.
   *
   * The radius is the tank's own half-diagonal, so the fit holds for a
   * corner-on view as well as a face-on one.
   */
  private frameTank(): void {
    const { size, ceilingY } = this.box;
    const centre = new THREE.Vector3(size / 2, ceilingY * 0.4, size / 2);
    const radius = Math.hypot(size, ceilingY, size) / 2;
    this.view?.fit(centre, radius, this.camera.aspect);
  }

  /**
   * Deferred by one frame, deliberately. Every rotation signal a browser
   * offers arrives before the layout it is announcing, so measuring on the
   * event measures the OLD screen — which is what left the tank half off the
   * side after turning the phone.
   */
  private readonly onViewportChange = (): void => {
    if (this.reframe) cancelAnimationFrame(this.reframe);
    this.reframe = requestAnimationFrame(() => {
      this.reframe = 0;
      this.resize();
      /* Re-fit rather than merely re-aspect: a portrait phone turned
       * landscape keeps its vertical field of view and gains horizontal, so
       * a subject framed for the tall screen is not framed for the wide
       * one. Following her is the exception — she is the subject then, and
       * yanking the distance would throw the view off her. */
      /* Re-fit either way. Following used to be exempt, on the grounds that
       * she is the subject and the distance should not be yanked — but a
       * fixed distance is exactly what stops being right when the screen
       * changes shape, so it re-fits on HER instead of on the tank. */
      if (this.following) {
        this.view?.fit(this.ant.at, FOLLOW_RADIUS, this.camera.aspect);
      } else {
        this.frameTank();
      }
    });
  };

  private readonly resize = (): void => {
    const vv = window.visualViewport;
    const w = this.host.clientWidth || vv?.width || window.innerWidth;
    const h = this.host.clientHeight || vv?.height || window.innerHeight;
    /*
     * `setSize(w, h)` — AND NOT `setSize(w, h, false)`.
     *
     * That third argument means "do not touch the canvas's CSS size", and
     * passing it was the whole of the not-centering bug. Three.js sizes the
     * DRAWING BUFFER to `w * pixelRatio`; with `updateStyle` off it leaves
     * the element's CSS size alone, and this project's only canvas rule is
     * `canvas { display: block }` — no width, no height. So the canvas laid
     * itself out at its buffer size: on a phone at devicePixelRatio 3, three
     * times the viewport in each direction.
     *
     * The render was correct the whole time. The player was seeing the
     * top-left ninth of it, which put an ant centred in the picture off the
     * right-hand edge of the screen — and no amount of re-fitting the camera
     * could help, because the fit was never the thing that was wrong.
     *
     * Every other scene in the repo calls the two-argument form. This one
     * was the exception, and it had no reason to be.
     */
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /**
   * Watch her, or watch the tank. The observer's one switch, and the only
   * thing in this lab a press does — it moves a point of view, never her.
   */
  setFollow(on: boolean): void {
    this.following = on;
    if (!this.view) return;
    if (on) {
      this.view.follow = () => this.ant.at;
      /* FITTED, not a fixed distance. Close enough to read her gait — she is
       * about two and a half voxels long — but derived from the lens and the
       * current aspect like every other framing here, so turning the phone
       * while watching her keeps her the same size on screen. */
      this.view.fit(this.ant.at, FOLLOW_RADIUS, this.camera.aspect);
    } else {
      this.view.follow = null;
      this.frameTank();
    }
  }

  get followingForTest(): boolean { return this.following; }

  /* ------------------------------------------------------------- probes */

  setPausedForTest(on: boolean): void { this.running = !on; }

  /** The ratio the renderer is actually drawing at — capped, so a probe can
   *  tell a cap apart from a canvas whose buffer leaked into its CSS size. */
  rendererRatioForTest(): number { return this.renderer.getPixelRatio(); }

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
    seat: { rideMm: number; bellyMm: number; soleMm: number };
    bellyClearMm: number | null;
    founding: string;
    depthMm: number;
    digAt: readonly [number, number, number] | null;
    digProgress: number;
    refused: string | null;
    excavated: number;
    den: { x: number; y: number; z: number } | null;
  } {
    const r = this.ant.report;
    const top = this.surfaceAt(this.ant.at.x, this.ant.at.z);
    const seat = this.ant.seatForTest();
    return {
      seat,
      founding: this.founding.state,
      depthMm: this.founding.depthMm({
        x: this.ant.at.x, y: this.ant.at.y, z: this.ant.at.z, heading: 0,
      }, VOXEL_MM),
      digAt: this.excavate.target,
      digProgress: this.excavate.progress,
      refused: this.excavate.refused,
      excavated: this.excavate.excavated,
      den: this.founding.den,
      /*
       * THE NUMBER THE SEATING MODEL IS ABOUT: how far the lowest point of
       * her BODY is above the soil directly under her, in millimetres. Not
       * derivable from `ride` — that is measured to her ORIGIN, and the
       * whole correction was that her origin is not her belly. On this rig
       * the belly sits ABOVE the origin, so it adds.
       *
       * Measured against the column under her CENTRE, which is not quite
       * what she is seated on: the look-ahead can hold her a little above
       * it while she crests something. So this reads at or above the
       * target, never far below it.
       */
      bellyClearMm: top === null
        ? null
        : (this.ant.at.y - top) * VOXEL_MM + seat.bellyMm,
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
    this.view?.dispose();
    this.viewButton?.remove();
    this.watcher?.disconnect();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    this.gauge.dispose();
    this.dust.dispose();
    this.soilMaterial?.dispose();
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
