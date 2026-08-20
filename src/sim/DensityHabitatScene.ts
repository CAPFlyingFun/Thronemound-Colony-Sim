/**
 * THE HABITAT, ON DENSITY SOIL — smooth, continuous ground the ant can
 * actually walk.
 *
 * A SEPARATE SCENE, not an edit of `HabitatScene`, and that is deliberate.
 * Swapping the terrain under a working front door is the riskiest change this
 * project has made, and the most likely failure is a build where the soil
 * draws but she falls through it. Keeping the voxel scene intact means a
 * revert is one line in `main.ts` rather than an unpick, and it means the two
 * can be compared side by side while the new one is being proved.
 *
 * WHAT IS HERE: the tray as a signed density field, meshed by SurfaceNets,
 * with the ant standing and walking on the SAME field the mesher drew. The
 * observer camera, the tank, the lighting, the build stamp and the WATCH HER
 * button are TCS's own, unchanged — this is a geometry change, not an
 * art-direction one.
 *
 * WHAT IS DELIBERATELY NOT HERE YET: digging. The founding brain and the
 * excavator both speak in voxel CELLS, and a cell has no meaning in a field.
 * Carving `boreFrom` into the density and giving the brain bore-shaped work is
 * the next step, and doing it in the same change as the terrain swap would
 * have meant two unproven things failing at once with no way to tell which.
 * She strolls here. She does not dig. That is a temporary, known gap.
 *
 * DOUBLE-SIDED MATERIAL, on the frozen build's evidence rather than as a
 * shrug: `buildSurfaceNets` winds its negative-facing surfaces backwards, so
 * backface culling deletes every -X, -Y and -Z face — which makes a tunnel
 * CEILING invisible from underneath, since a ceiling is a -Y surface.
 * `BlockScene` measured this triangle by triangle and reached the same
 * conclusion. Fixing the winding is its own job and is not being attempted
 * inside a migration.
 */

import * as THREE from 'three';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { AntBody } from './AntBody';
import { AntStroll, type StrollSenses } from './antStroll';
import { ObserverCamera } from './observerCamera';
import { DensityGround } from './density/densityGround';
import {
  CELLS_X, CELLS_Y, CELLS_Z, GRADE, MM_PER_UNIT, TANK, TANK_HEIGHT,
  makeTcsSoil, soilColourAt,
} from './density/tcsSoil';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

/** How much room to keep around her when the camera is following, in units. */
const FOLLOW_RADIUS = 6;

/** How far above her origin the stroller asks "is there soil where I'd be". */
const BODY_MIDDLE = 0.3;

/**
 * The footprint her legs cover, as offsets to sample around a candidate spot.
 * Two voxels is ten millimetres — about as far as a foot gets from her middle.
 */
const BODY_RING: readonly (readonly [number, number])[] = [
  [2, 0], [-2, 0], [0, 2], [0, -2],
];

export class DensityHabitatScene {
  readonly scene = new THREE.Scene();

  readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: THREE.WebGLRenderer;

  /** The one description of where the soil is. Drawn and walked from this. */
  private readonly field = makeTcsSoil();

  readonly ground: DensityGround;

  private readonly ant = new AntBody('queen');

  private readonly stroll: AntStroll;

  view: ObserverCamera | null = null;

  private following = false;

  private soil: THREE.Mesh | null = null;

  private material: THREE.Material | null = null;

  private watcher: ResizeObserver | null = null;

  private viewButton: HTMLButtonElement | null = null;

  private stamp: HTMLElement | null = null;

  private reframe = 0;

  private running = false;

  private last = 0;

  ready = false;

  elapsed = 0;

  constructor(private readonly host: HTMLElement, seed = 1) {
    this.ground = new DensityGround(this.field);

    let n = seed >>> 0;
    const rand = (): number => {
      /* Mulberry32 — seeded, so the same seed gives the same ant every run. */
      n += 0x6d2b79f5;
      let t = n;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.stroll = new AntStroll(rand);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 400);
    host.appendChild(this.renderer.domElement);
    this.light();
    this.view = new ObserverCamera(this.camera, this.renderer.domElement);
    this.resize();
    /* Four ways to hear about a rotation, because on a phone one is not
     * enough — Safari fires `resize` before layout settles, and only
     * `visualViewport` reports the real drawable area. */
    window.addEventListener('resize', this.onViewportChange);
    window.addEventListener('orientationchange', this.onViewportChange);
    window.visualViewport?.addEventListener('resize', this.onViewportChange);
    this.watcher = new ResizeObserver(this.onViewportChange);
    this.watcher.observe(host);
    this.buildViewButton();
    this.buildStamp();
  }

  /**
   * WHERE THE FLOOR IS UNDER A POINT, seen from a height.
   *
   * The same contract the voxel scene had, and the third argument matters for
   * the same reason: an ant in a tunnel wants the floor under HER, not the top
   * of her column, which is the roof with the whole tray on it.
   */
  surfaceAt = (x: number, z: number, from?: number): number | null => (
    this.ground.surfaceIn(x, z, from === undefined ? TANK_HEIGHT : from)
  );

  /** What the stroller may ask about the world. */
  private readonly senses: StrollSenses = {
    groundAhead: (heading, probe) => {
      const x = this.ant.at.x + Math.sin(heading) * probe;
      const z = this.ant.at.z + Math.cos(heading) * probe;
      const eye = this.ant.at.y + 1;
      /* Somewhere her whole body fits, not somewhere her middle does. */
      for (const [ox, oz] of BODY_RING) {
        if (this.surfaceAt(x + ox * 0.2, z + oz * 0.2, eye) === null) return false;
      }
      /* And not into soil that is where her body wants to be. Asked of the
       * field directly, which is the only test that means the same thing on a
       * bank as it does inside a tunnel. */
      return !this.ground.solidAt(x, this.ant.at.y + BODY_MIDDLE, z);
    },
  };

  async start(): Promise<void> {
    await this.ant.load();
    this.scene.add(this.ant.model.root);
    this.buildSoil();
    this.drawTank();

    const mid = TANK / 2;
    const top = this.surfaceAt(mid, mid) ?? GRADE;
    this.ant.place(mid, mid, top, 0);
    this.ant.plant(this.ground);

    this.frameTank();
    this.ready = true;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.frame);
  }

  /**
   * The tray, meshed once.
   *
   * `buildSurfaceNets` emits field-local positions, and this field starts at
   * the world origin, so no offset is applied — the same trap the voxel
   * mesher had, where translating the mesh as well put every chunk at twice
   * its own coordinate.
   */
  private buildSoil(region?: Parameters<typeof buildSurfaceNets>[2]): void {
    const data = buildSurfaceNets(this.field, 0, region);
    if (this.soil) {
      this.scene.remove(this.soil);
      this.soil.geometry.dispose();
      this.soil = null;
    }
    if (data.indices.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    /*
     * SHADING normals from the mesh, GAMEPLAY normals from the gradient. They
     * agree because they read the same field, and each is the cheaper answer
     * for its own question: a triangle normal is what a renderer wants, and a
     * gradient is defined even where no triangle is.
     */
    geometry.computeVertexNormals();

    /* Strata, computed from depth rather than stored per cell — so a tunnel
     * wall is the right colour without anybody remembering to paint it. */
    const pos = data.positions;
    const colours = new Float32Array(pos.length);
    const band: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < pos.length; i += 3) {
      soilColourAt(pos[i]!, pos[i + 1]!, pos[i + 2]!, band);
      colours[i] = band[0]; colours[i + 1] = band[1]; colours[i + 2] = band[2];
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));

    this.material ??= new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
      /* See the note at the head of the file — a tunnel ceiling is a -Y
       * surface, and those come out of the mesher wound inward. */
      side: THREE.DoubleSide,
    });
    this.soil = new THREE.Mesh(geometry, this.material);
    this.scene.add(this.soil);
  }

  private light(): void {
    this.scene.background = new THREE.Color(0x1a1d22);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2c22, 1.1));
  }

  /** The glass, as a wire box. Density is for SOIL; the tank stays the tank. */
  private drawTank(): void {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK, TANK_HEIGHT, TANK)),
      new THREE.LineBasicMaterial({
        color: 0x7fa8c4, transparent: true, opacity: 0.5,
      }),
    );
    edges.position.set(TANK / 2, TANK_HEIGHT / 2, TANK / 2);
    this.scene.add(edges);
  }

  tick(dt: number): void {
    if (!this.ready) return;
    this.elapsed += dt;
    const intent = this.stroll.step(dt, this.ant.heading, this.senses);
    this.ant.step(dt, intent, this.ground, this.surfaceAt);
  }

  private readonly frame = (): void => {
    const now = performance.now();
    /* Clamped: a backgrounded tab returns with a second of dt. */
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.running) this.tick(dt);
    if (this.following) this.view?.fit(this.ant.at, FOLLOW_RADIUS, this.camera.aspect);
    this.view?.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private frameTank(): void {
    const centre = new THREE.Vector3(TANK / 2, TANK_HEIGHT / 2, TANK / 2);
    this.view?.fit(centre, TANK * 0.75, this.camera.aspect);
  }

  private buildViewButton(): void {
    const b = document.createElement('button');
    b.textContent = 'WATCH HER';
    b.style.cssText = [
      'position:absolute', 'z-index:5',
      'right:calc(14px + env(safe-area-inset-right,0px))',
      'bottom:calc(14px + env(safe-area-inset-bottom,0px))',
      'min-height:44px', 'padding:10px 16px',
      'font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'letter-spacing:0.12em', 'color:#efe3c4',
      'background:#20241d', 'border:1px solid #4c5340', 'border-radius:10px',
    ].join(';');
    b.addEventListener('click', () => {
      this.following = !this.following;
      b.textContent = this.following ? 'WATCH THE TANK' : 'WATCH HER';
      if (!this.following) this.frameTank();
    });
    this.host.appendChild(b);
    this.viewButton = b;
  }

  /** So the live version is never a guess. */
  private buildStamp(): void {
    const tag = document.createElement('div');
    tag.className = 'tm-build';
    tag.textContent = `v${__APP_VERSION__} · ${__BUILD_TIME__}`;
    tag.style.cssText = [
      'position:absolute', 'z-index:5',
      'left:calc(12px + env(safe-area-inset-left,0px))',
      'bottom:calc(10px + env(safe-area-inset-bottom,0px))',
      'font:500 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'letter-spacing:0.08em', 'color:rgba(239,227,196,0.42)',
      'pointer-events:none', 'user-select:none',
    ].join(';');
    this.host.appendChild(tag);
    this.stamp = tag;
  }

  private readonly onViewportChange = (): void => {
    /* Deferred a frame: every rotation signal a browser has fires before the
     * new layout has settled, so reading the size now reads the old one. */
    if (this.reframe) cancelAnimationFrame(this.reframe);
    this.reframe = requestAnimationFrame(() => {
      this.reframe = 0;
      this.resize();
      if (!this.following) this.frameTank();
    });
  };

  private resize(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setPausedForTest(on: boolean): void { this.running = !on; }

  setFollow(on: boolean): void {
    this.following = on;
    if (this.viewButton) {
      this.viewButton.textContent = on ? 'WATCH THE TANK' : 'WATCH HER';
    }
    if (!on) this.frameTank();
  }

  get followingForTest(): boolean { return this.following; }

  rendererRatioForTest(): number { return this.renderer.getPixelRatio(); }

  boundsForTest(): { size: number; ceilingY: number } {
    return { size: TANK, ceilingY: TANK_HEIGHT };
  }

  /** The drawn soil, so a probe can count triangles rather than trust a log. */
  soilForTest(): THREE.Mesh | null { return this.soil; }

  /** Everything a probe needs to judge "she stands and walks correctly". */
  reportForTest(): {
    at: { x: number; y: number; z: number };
    heading: number; state: string; elapsed: number;
    planted: number; groping: number; movedMm: number;
    surfaceUnder: number | null; ride: number;
    cellMm: number; samples: number;
  } {
    const r = this.ant.report;
    const top = this.surfaceAt(this.ant.at.x, this.ant.at.z, this.ant.at.y + 1);
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
      cellMm: MM_PER_UNIT / (CELLS_X / TANK),
      samples: (CELLS_X + 1) * (CELLS_Y + 1) * (CELLS_Z + 1),
    };
  }

  tickForTest(dt: number, walk: number, turn: number): void {
    if (!this.ready) return;
    this.elapsed += dt;
    this.ant.step(dt, { walk, turn }, this.ground, this.surfaceAt);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.view?.dispose();
    this.viewButton?.remove();
    this.stamp?.remove();
    this.watcher?.disconnect();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    this.soil?.geometry.dispose();
    this.material?.dispose();
    this.renderer.dispose();
  }
}
