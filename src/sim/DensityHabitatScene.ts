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
import { AntBody } from './AntBody';
import { AntStroll, type StrollIntent, type StrollSenses } from './antStroll';
import { ObserverCamera } from './observerCamera';
import { DensityGround } from './density/densityGround';
import { DigBrain } from './density/digBrain';
import { DigGauge } from './digGauge';
import { boreFrom } from './density/boreFrom';
import { boreBounds, carveInto } from './density/carveInto';
import { boreRadiusMm, toUnits } from './density/casteDig';
import { SoilMesh } from './density/soilMesh';
import {
  CELLS_X, CELLS_Y, CELLS_Z, GRADE, MM_PER_UNIT, TANK, TANK_HEIGHT,
  makeTcsSoil, soilColourAt,
} from './density/tcsSoil';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

/**
 * How long after a reveal the scene keeps re-checking its own size, in
 * seconds. See `settleFor` — long enough to outlast an app launch, short
 * enough that it is over before anybody has done anything.
 */
const SETTLE_SECONDS = 2;

/**
 * How far HUD furniture sits from the screen edge, in CSS pixels.
 *
 * A FLOOR, not an addition to `env(safe-area-inset-*)`. Those insets read 0
 * under `viewport-fit=contain`, because the system has already done the
 * insetting — so `calc(10px + env(...))` that used to clear a home indicator
 * now clears ten pixels, and the build stamp ended up hard against the bottom
 * edge. `max()` keeps whichever is larger, so the same rule is right under
 * either fit and the numbers stop depending on which one is set.
 */
const MARGIN_PX = 18;

/**
 * How big the round dig bar is drawn, in world units.
 *
 * A queen is 1.8 units nose to tail, so a gauge at its native size would be
 * most of her length and read as a hoop she was standing in. This is a little
 * over a bore's width — enough to see the ring turn, small enough that the
 * soil it sits on is still what you are looking at.
 */
const GAUGE_SCALE = 1.6;

/** Reused so the frame allocates nothing. */
const SCRATCH_FACE = new THREE.Vector3();

/**
 * How much soil is left above her when the cutaway is on, in world units.
 *
 * Enough to keep the roof of her own tunnel — a burrow with its ceiling
 * sliced off is a groove, not a burrow — and not so much that the camera ends
 * up back inside the ground it just cut. A queen stands about 0.63 units tall.
 */
const CUT_HEADROOM = 1.1;

/** Which way the page is asked to sit relative to the system insets. */
type ViewportFit = 'cover' | 'contain';

/** Where the guard's verdict is kept between launches. */
const FIT_KEY = 'tm.viewportFit';

/**
 * How many screen points of shortfall count as "covered", per axis.
 *
 * Not zero: the zoom makes these numbers fractional — 810 x 1.150 came to
 * 931.5 against a 932-point screen, which is covered by any sane reading and
 * is not zero. Two points is under one device pixel of visible edge and well
 * clear of the 59 the real fault produced.
 */
const FIT_TOLERANCE = 2;

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
  /**
   * The soil itself. Public because the ground, the mesher and the excavator
   * all read the same one — that identity is the point of the density move,
   * and hiding it behind three accessors would only make it look like three
   * sources.
   */
  readonly field = makeTcsSoil();

  readonly ground: DensityGround;

  private readonly ant = new AntBody('queen');

  private readonly stroll: AntStroll;

  view: ObserverCamera | null = null;

  private following = false;

  private soil: SoilMesh | null = null;

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
    this.scene.add(this.gauge.root);

    const mid = TANK / 2;
    const top = this.surfaceAt(mid, mid) ?? GRADE;
    this.ant.place(mid, mid, top, 0);
    this.ant.plant(this.ground);

    this.frameTank();
    this.ready = true;
    /*
     * SHE DOES NOT LIVE BEHIND THE DOOR.
     *
     * `start` used to set the world running the moment it was built, which
     * meant the queen spent the whole time the menu was up walking about and
     * digging — so PLAY opened onto a tray that had already been worked, from
     * a game nobody had started. It also quietly broke `probe:density`, whose
     * seat measurement came out 0.203 mm against a 0.020 mm target because she
     * was standing in a hole she had dug before the probe began.
     *
     * The render loop still runs, so the menu has a lit tray behind it. Only
     * the SIMULATION waits, and `reveal` is what starts it — the same moment
     * the canvas is sized and the door comes down.
     */
    this.running = false;
    this.last = performance.now();
    /* The cutaway is a material clipping plane, and three.js will not honour
     * one unless local clipping is switched on for the whole renderer. */
    this.renderer.localClippingEnabled = true;
    this.renderer.setAnimationLoop(this.frame);
  }

  /**
   * The tray, meshed in chunks so a bite costs a bite. See `SoilMesh`.
   *
   * `buildSurfaceNets` emits FIELD-LOCAL positions and this field starts at
   * the world origin, so no offset is applied — the same trap the voxel mesher
   * had, where translating the mesh as well put every chunk at twice its own
   * coordinate.
   */
  private buildSoil(): void {
    this.soil = new SoilMesh(this.field, soilColourAt);
    this.soil.buildAll();
    this.scene.add(this.soil.group);
  }

  private light(): void {
    this.scene.background = new THREE.Color(0x1a1d22);
    /*
     * TURNED DOWN, because the normals got CORRECT.
     *
     * 2.2 of sun and 1.1 of hemisphere was tuned against normals from
     * `computeVertexNormals`, and `buildSurfaceNets` winds a good share of its
     * quads backwards — so a fair fraction of the tray was being lit from
     * inside itself and came out darker than it should have. The gradient
     * normals `SoilMesh` uses now all point out of the soil, correctly, and
     * the same lighting promptly blew the surface to white: topsoil's albedo
     * is 0.28 and 0.28 x 3.3 is 0.92, which is not brown.
     *
     * A fix that makes an old tuning wrong is still a fix. This is the same
     * scene relit for normals that mean what they say.
     */
    const sun = new THREE.DirectionalLight(0xffffff, 1.25);
    sun.position.set(60, 120, 40);
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2c22, 0.55));
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
    /*
     * THE DIGGER DRIVES HER, and the stroller is what she does when there is
     * nothing to dig. Two brains, one body, and only one of them steering at
     * a time — the alternative is blending two sets of intent, which is how
     * an ant ends up walking toward one thing while facing another.
     */
    const intent = this.digging
      ? this.dig.step(dt, this.ant.at, this.ant.heading, this.ant.forward,
        (into) => this.ant.model.jawPosition(into))
      : this.stroll.step(dt, this.ant.heading, this.senses);
    this.lastIntent = intent;
    this.ant.step(dt, intent, this.ground, this.surfaceAt);
    /* The bar rides the WORK FACE — a bore ahead of her jaw, not her jaw —
     * so it reads as the soil being worked rather than as a badge on the ant. */
    const face = this.digging && this.dig.onFace
      ? SCRATCH_FACE.copy(this.dig.jaw)
        .addScaledVector(this.dig.aim, toUnits(boreRadiusMm('queen')))
      : null;
    this.gauge.showAt(face, this.dig.progress, this.camera, GAUGE_SCALE);
    this.cutaway();
  }

  /**
   * TAKE THE LID OFF WHEN SHE IS UNDER IT.
   *
   * Only while FOLLOWING, and only once she is actually below the original
   * grade: the whole tank seen from outside should be a whole tank, and
   * slicing it on the surface would remove the tray for no reason. Once she
   * is underground the soil above her is the only thing between the camera
   * and the thing it is pointed at.
   */
  private cutaway(): void {
    if (!this.soil) return;
    const under = this.following && this.ant.at.y < GRADE - 0.05;
    this.soil.setCut(under ? this.ant.at.y + CUT_HEADROOM : null);
  }

  /** Her brain, and the switch between her two of them. */
  private digging = true;

  private readonly gauge = new DigGauge();

  private readonly dig = new DigBrain('queen', {
    /*
     * Every one of these is a CLOSURE rather than a captured reference,
     * because the field initialiser runs before `ground` exists — and reading
     * it eagerly is a `used before initialization` the compiler catches only
     * because the property happens to be declared later in the file. A
     * closure asks at call time, which is the only time the answer matters.
     */
    solidAt: (x, y, z) => this.ground.solidAt(x, y, z),
    surfaceAt: (x, z, from) => this.surfaceAt(x, z, from),
    carve: (origin, aim, length, radius) => {
      const region = carveInto(
        this.field, boreFrom(origin, aim, length, radius),
        boreBounds(origin, aim, length, radius),
      );
      if (region) this.soil?.rebuild(region);
    },
    size: TANK,
  });

  /** For a probe, and for a future keeper control. */
  setDiggingForTest(on: boolean): void { this.digging = on; }

  /** Her current bite direction, so a probe can ask the field the same
   * question the reach gate asks rather than a proxy for it. */
  digAimForTest(): THREE.Vector3 { return this.dig.aim; }

  digSiteForTest(): { stand: THREE.Vector3; target: THREE.Vector3 } | null {
    return this.dig.site;
  }

  digReportForTest(): {
    phase: string; progress: number; bites: number; arms: number;
    onFace: boolean; jaw: { x: number; y: number; z: number };
    jawAboveSoilMm: number | null; bodyAboveSoilMm: number | null;
  } {
    return {
      phase: this.dig.phase,
      progress: this.dig.progress,
      bites: this.dig.bites,
      arms: this.dig.arms,
      onFace: this.dig.onFace,
      jaw: { x: this.dig.jaw.x, y: this.dig.jaw.y, z: this.dig.jaw.z },
      jawAboveSoilMm: (() => {
        const top = this.surfaceAt(this.dig.jaw.x, this.dig.jaw.z, this.dig.jaw.y + 1);
        return top === null ? null : (this.dig.jaw.y - top) * MM_PER_UNIT;
      })(),
      bodyAboveSoilMm: (() => {
        const top = this.surfaceAt(this.ant.at.x, this.ant.at.z, this.ant.at.y + 1);
        return top === null ? null : (this.ant.at.y - top) * MM_PER_UNIT;
      })(),
    };
  }

  /** What her brain asked for this frame, so a probe can watch the input. */
  private lastIntent: StrollIntent = { walk: 0, turn: 0 };

  intentForTest(): StrollIntent { return this.lastIntent; }

  private readonly frame = (): void => {
    const now = performance.now();
    /* Clamped: a backgrounded tab returns with a second of dt. */
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    /* See `settleFor`: a viewport that finishes settling without telling
     * anybody is caught here rather than never. */
    if (this.settleFor > 0) {
      this.settleFor -= dt;
      this.resize();
    }
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
      `right:max(${MARGIN_PX}px, env(safe-area-inset-right,0px))`,
      `bottom:max(${MARGIN_PX}px, env(safe-area-inset-bottom,0px))`,
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
    /* One stamp, whatever happens upstream. Cheap insurance: a second scene
     * constructed over the first would otherwise leave two of these on top of
     * each other, and a duplicate is exactly the sort of thing that reads as
     * a rendering fault in a screenshot. */
    for (const old of this.host.querySelectorAll('.tm-build')) old.remove();
    const tag = document.createElement('div');
    tag.className = 'tm-build';
    tag.textContent = `v${__APP_VERSION__} · ${__BUILD_TIME__}`;
    tag.style.cssText = [
      'position:absolute', 'z-index:5',
      `left:max(${MARGIN_PX}px, env(safe-area-inset-left,0px))`,
      `bottom:max(${MARGIN_PX}px, env(safe-area-inset-bottom,0px))`,
      'font:500 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
      'letter-spacing:0.08em', 'color:rgba(239,227,196,0.42)',
      'user-select:none', 'padding:6px', 'margin:-6px',
    ].join(';');
    /* TAP THE STAMP FOR THE NUMBERS. See `toggleMetrics`. The padding and
     * negative margin give a 10px label a thumb-sized hit area without
     * moving it. */
    tag.addEventListener('click', () => this.toggleMetrics());
    this.host.appendChild(tag);
    this.stamp = tag;
  }

  private metrics: HTMLDivElement | null = null;

  private metricsTimer = 0;

  /**
   * THE VIEWPORT, ON SCREEN, ON THE DEVICE.
   *
   * This exists because I have now guessed twice about a screen I cannot see
   * and been wrong twice, and a third guess is worth less than one
   * measurement. iOS's standalone-PWA viewport is not reproducible in the
   * headless Chromium the probes run in — on the build that was visibly short
   * on device, every probe here measured the canvas as reaching all four
   * edges exactly. So the instrument goes to where the fault is.
   *
   * Every number that could disagree, side by side, updating live: if the
   * canvas is short, exactly one of these rows is lying and this says which.
   * `innerHeight` against `visualViewport.height` against the host's client
   * box against the canvas's own rectangle against the size the renderer was
   * last given — plus the safe-area insets, which are the usual suspect, and
   * whether the app is actually in standalone mode at all.
   *
   * It is a debug readout and it should not outlive the bug.
   */
  private toggleMetrics(): void {
    if (this.metrics) {
      window.clearInterval(this.metricsTimer);
      this.metrics.remove();
      this.metrics = null;
      this.metricsRuler?.remove();
      this.metricsRuler = null;
      return;
    }
    const box = document.createElement('div');
    box.className = 'tm-metrics';
    box.style.cssText = [
      'position:absolute', 'z-index:6',
      `left:max(${MARGIN_PX}px, env(safe-area-inset-left,0px))`,
      `top:max(${MARGIN_PX}px, env(safe-area-inset-top,0px))`,
      `right:max(${MARGIN_PX}px, env(safe-area-inset-right,0px))`,
      'padding:8px 10px', 'border-radius:8px',
      'background:rgba(8,10,14,0.86)', 'color:#cfe3d0',
      'font:500 9.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:pre', 'pointer-events:none', 'user-select:none',
      'overflow:hidden',
    ].join(';');
    this.host.appendChild(box);
    this.metrics = box;
    /* The numbers get their own element: writing `textContent` on the panel
     * itself would delete the buttons every quarter second. */
    const lines = document.createElement('div');
    lines.style.cssText = 'white-space:pre';
    box.appendChild(lines);

    /* `env()` is not readable from script, so it is measured off a probe
     * element that has been given the insets as its padding. */
    const ruler = document.createElement('div');
    ruler.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'visibility:hidden', 'pointer-events:none',
      'padding-top:env(safe-area-inset-top,0px)',
      'padding-right:env(safe-area-inset-right,0px)',
      'padding-bottom:env(safe-area-inset-bottom,0px)',
      'padding-left:env(safe-area-inset-left,0px)',
    ].join(';');
    document.body.appendChild(ruler);

    /*
     * WHAT THE MANIFEST ASKS FOR, against what iOS ACTUALLY GAVE US.
     *
     * iOS bakes the display mode in at INSTALL time, so a Home Screen app
     * keeps the shell it was added with however many times the page reloads.
     * That cost a whole round trip: a device running the new build reported
     * `fullscreen YES` from a manifest that had said `standalone` since the
     * previous version, and the experiment had simply not run yet.
     *
     * An instrument that can say "you are running the old install" is worth
     * more than one that leaves it to be inferred from a mode nobody expected.
     */
    let wantDisplay = '?';
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) {
      void fetch(link.href)
        .then((r) => (r.ok ? r.json() : null))
        .then((m: { display?: string } | null) => {
          wantDisplay = m?.display ?? '?';
        })
        .catch(() => { wantDisplay = 'unreadable'; });
    }

    const n = (v: number): string => String(Math.round(v * 10) / 10);
    /* Three decimals, because a page zoom of 1.15 rounds to 1.1 and the
     * difference between "no zoom" and "zoomed" is the question. */
    const n3 = (v: number): string => v.toFixed(3);
    const yn = (v: boolean): string => (v ? 'YES' : 'no ');
    const paint = (): void => {
      if (!this.metrics) return;
      const vv = window.visualViewport;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const pad = getComputedStyle(ruler);
      const hostRect = this.host.getBoundingClientRect();
      /*
       * THE THREE ANSWERS, KEPT APART.
       *
       * They were OR'd into one word, which made the readout unable to show
       * the one distinction now in question: WebKit has open bugs about
       * manifest `fullscreen` on iOS, and the working comparison apps (Ant
       * Scout, StormTracker) both ask for `standalone`. A label that says
       * "standalone" when the media query matched `fullscreen` is an
       * instrument answering a question nobody asked.
       */
      const mStandalone = window.matchMedia('(display-mode: standalone)').matches;
      const mFullscreen = window.matchMedia('(display-mode: fullscreen)').matches;
      const mMinimalUi = window.matchMedia('(display-mode: minimal-ui)').matches;
      const navStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
      /*
       * SCREEN AGAINST WINDOW — the row that decides the next move.
       *
       * If the screen reports the device's full logical size while the window
       * reports less, WebKit is shrinking the web-app viewport and the shell
       * settings are the suspect. If the screen ITSELF is small, the device's
       * own Display Zoom is in play and nothing about the manifest explains
       * it. Those want opposite fixes, so the ratio is printed rather than
       * left to be worked out from two rows.
       */
      const sh = window.screen;
      const ratioW = window.innerWidth > 0 ? sh.width / window.innerWidth : 0;
      const ratioH = window.innerHeight > 0 ? sh.height / window.innerHeight : 0;
      const live = mFullscreen ? 'fullscreen'
        : mStandalone ? 'standalone'
          : mMinimalUi ? 'minimal-ui' : 'browser';
      /*
       * ONLY AN INSTALLED APP CAN BE A STALE INSTALL. In a browser tab the
       * live mode is `browser` and always differs from whatever the manifest
       * asks for, which is not a fault and must not shout about one — an
       * instrument that cries wolf in the ordinary case gets ignored in the
       * one case it matters.
       */
      const installed = mStandalone || mFullscreen || mMinimalUi || navStandalone;
      const stale = installed && wantDisplay !== '?' && wantDisplay !== 'unreadable'
        && wantDisplay !== live;
      /*
       * THE SHORTFALL, STATED AS A NUMBER RATHER THAN LEFT TO ARITHMETIC.
       *
       * The viewport, converted back to screen points through the zoom, is
       * what should equal the screen. In landscape it does — 810 x 1.15 is
       * 931.5 of 932. In portrait it came to 872.85 of 932, short by the
       * status-bar inset, which is the whole fault in one row.
       */
      const zoom = vv?.scale ?? 1;
      const coveredW = window.innerWidth * zoom;
      const coveredH = window.innerHeight * zoom;
      /*
       * COMPARED ALONG THE LONG AND SHORT AXES, not width against width.
       *
       * `screen` does not rotate on iOS — it reported 430 x 932 in both
       * orientations — so subtracting it from a viewport that DOES rotate
       * produces nonsense the moment the phone is turned (it read "right
       * -380" in landscape). Sorting both pairs asks the question that
       * survives rotation: how much of the long side of the screen is
       * covered, and how much of the short side.
       */
      const screenLong = Math.max(sh.width, sh.height);
      const screenShort = Math.min(sh.width, sh.height);
      const coverLong = Math.max(coveredW, coveredH);
      const coverShort = Math.min(coveredW, coveredH);
      lines.textContent = [
        `v${__APP_VERSION__}`,
        `manifest ${wantDisplay}  ->  live ${live}${stale ? '   ** REINSTALL **' : ''}`,
        `fit      ${this.fitReport}`,
        `mode     standalone ${yn(mStandalone)} fullscreen ${yn(mFullscreen)}`,
        `         minimal-ui ${yn(mMinimalUi)} nav.standalone ${yn(navStandalone)}`,
        `screen   ${n(sh.width)} x ${n(sh.height)}  avail ${n(sh.availWidth)} x ${n(sh.availHeight)}`,
        `outer    ${n(window.outerWidth)} x ${n(window.outerHeight)}`,
        `window   ${n(window.innerWidth)} x ${n(window.innerHeight)}`,
        `screen/window  ${n3(ratioW)} w   ${n3(ratioH)} h`,
        `visual   ${vv ? `${n(vv.width)} x ${n(vv.height)}  off ${n(vv.offsetTop)}` : 'none'}`,
        `zoom     ${vv ? n3(vv.scale) : '-'}   dpr ${n3(window.devicePixelRatio)}`,
        `docEl    ${n(document.documentElement.clientWidth)} x ${n(document.documentElement.clientHeight)}`,
        `#app     ${n(this.host.clientWidth)} x ${n(this.host.clientHeight)}  top ${n(hostRect.top)}  bot ${n(hostRect.bottom)}`,
        `canvas   ${n(rect.width)} x ${n(rect.height)}  top ${n(rect.top)}  bot ${n(rect.bottom)}`,
        `renderer ${n(this.sizedW)} x ${n(this.sizedH)}  ratio ${n(this.renderer.getPixelRatio())}`,
        `safe     t${pad.paddingTop} r${pad.paddingRight} b${pad.paddingBottom} l${pad.paddingLeft}`,
        `GAP vs window   bot ${n(window.innerHeight - rect.bottom)}  right ${n(window.innerWidth - rect.width)}`,
        `covers   ${n(coverLong)} of ${n(screenLong)} long   ${n(coverShort)} of ${n(screenShort)} short`,
        `SHORT BY ${n(screenLong - coverLong)} long   ${n(screenShort - coverShort)} short  (screen pts)`,
      ].join('\n');
    };
    /*
     * LEVERS THAT WORK ON THE INSTALLED APP, with no reinstall and no push.
     *
     * The manifest's `display` is the one setting iOS bakes in at install
     * time. Everything else in the shell comes from META TAGS in the HTML,
     * which are read on every page load — and the viewport meta can be
     * rewritten at RUNTIME and takes effect at once. So the remaining
     * suspects can be A/B'd right here, against a readout that updates four
     * times a second, instead of through a build-deploy-reinstall cycle for
     * each guess.
     *
     * `viewport-fit` is the interesting one: `cover` asks the page to extend
     * under the system insets and `contain` asks it not to. If the portrait
     * shortfall moves when that flips, the insets are the mechanism and the
     * manifest was never the whole story.
     */
    const bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'gap:6px', 'flex-wrap:wrap', 'margin-top:8px',
      'pointer-events:auto',
    ].join(';');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const button = (label: string, act: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'font:600 9.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace',
        'padding:7px 9px', 'border-radius:6px', 'border:1px solid #3a4a3c',
        'background:#16321c', 'color:#cfe3d0', 'letter-spacing:0.06em',
      ].join(';');
      b.addEventListener('click', (e) => { e.stopPropagation(); act(); paint(); });
      bar.appendChild(b);
    };
    void meta;
    /* The manual overrides go through the guard's own setter and are
     * REMEMBERED, so a choice made here survives closing the app — the
     * runtime-only version of these buttons reset on every reopen, which is
     * what prompted the guard in the first place. */
    const pick = (fit: ViewportFit): void => {
      this.setFit(fit);
      this.remember(fit);
      this.fitReport = `${fit} (chosen)`;
      if (!this.following) this.frameTank();
    };
    button('fit cover', () => pick('cover'));
    button('fit contain', () => pick('contain'));
    button('re-scan', () => { this.fitTried = false; this.fitGuard(); });
    button('reload', () => window.location.reload());
    box.appendChild(bar);
    /* The bar takes taps; the panel around it still must not. */
    box.style.pointerEvents = 'none';
    bar.style.pointerEvents = 'auto';

    paint();
    this.metricsTimer = window.setInterval(paint, 250);
    this.metricsRuler = ruler;
  }

  private metricsRuler: HTMLElement | null = null;

  private readonly onViewportChange = (): void => {
    /* Deferred a frame: every rotation signal a browser has fires before the
     * new layout has settled, so reading the size now reads the old one. */
    if (this.reframe) cancelAnimationFrame(this.reframe);
    this.reframe = requestAnimationFrame(() => {
      this.reframe = 0;
      /* An EVENT always re-applies. See `resize`'s note on `force`. */
      this.resize(true);
      if (!this.following) this.frameTank();
      /* And a rotation is exactly when the fault appeared: the fit that
       * covered in landscape was 59 points short in portrait. Re-measured
       * here, not only at startup. */
      if (this.ready) this.fitGuard();
    });
  };

  /**
   * THE DRAWABLE AREA, asked of the thing that actually knows it.
   *
   * `visualViewport` first, because on iOS it is the only one that reports
   * the area the page can really paint — `innerHeight` and an element's
   * client box can both be a launch-time value that nothing later corrects.
   * The host's own box second, for a scene mounted in something smaller than
   * the window, and `innerWidth/Height` last so there is always an answer.
   */
  private viewportSize(): { w: number; h: number } {
    const de = document.documentElement;
    const vv = window.visualViewport;
    const hostW = this.host.clientWidth;
    const hostH = this.host.clientHeight;

    /*
     * A HOST THAT IS GENUINELY SMALLER THAN THE PAGE gets to say so — a
     * panel, a split view, a scene mounted in something. Judged against the
     * document, not against the visual viewport, because the visual viewport
     * shrinks for reasons that have nothing to do with the element.
     */
    const pageW = Math.max(de.clientWidth, window.innerWidth);
    const pageH = Math.max(de.clientHeight, window.innerHeight);
    if (hostW > 0 && hostH > 0 && (hostW < pageW - 1 || hostH < pageH - 1)) {
      return { w: Math.max(1, Math.round(hostW)), h: Math.max(1, Math.round(hostH)) };
    }

    /*
     * OTHERWISE THE HOST IS THE PAGE, and the candidates that all claim to
     * measure it get to disagree. TAKE THE LARGEST.
     *
     * The previous version took the smallest, and that was the portrait gap.
     * It read `host < visualViewport ? host : visualViewport`, which is a
     * minimum however it is spelled, and on iOS in portrait the visual
     * viewport can report a height that excludes the home-indicator band
     * while `#app` — pinned to `inset: 0`, so the viewport by definition —
     * reports the whole screen. Taking the smaller of those is taking the
     * band off, and the band is the gap. In landscape the two agree closely
     * enough that nothing showed, which is exactly the shape of the report:
     * portrait only.
     *
     * The failure modes are NOT symmetric, and that is the whole argument.
     * Too small leaves a strip of page with no game on it — visible, and the
     * thing being fixed. Too large draws a few rows of pixels past the edge,
     * where `#app`'s `overflow: hidden` clips them and nobody can tell. When
     * instruments disagree about a number whose errors cost that differently,
     * the answer is not the average and it is certainly not the minimum.
     */
    const w = Math.max(hostW, vv?.width ?? 0, de.clientWidth, window.innerWidth);
    const h = Math.max(hostH, vv?.height ?? 0, de.clientHeight, window.innerHeight);
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
  }

  /**
   * Size the renderer to the viewport.
   *
   * `force` exists because skipping the work when the measurement has not
   * changed is only safe for the per-frame settling window, where `setSize`
   * would otherwise reallocate the drawing buffer sixty times a second. It is
   * NOT safe for an event.
   *
   * That distinction was learned the hard way. An unconditional early return
   * made rotation stop fixing the short canvas — which had been the one
   * reliable workaround — because if the measurement is wrong in a way that
   * is STABLE, "it has not changed" is exactly the wrong reason to do
   * nothing. An event says the world moved; the answer to that is always to
   * re-measure and re-apply, whatever the numbers say.
   */
  private resize(force = false): void {
    const { w, h } = this.viewportSize();
    if (!force && w === this.sizedW && h === this.sizedH) return;
    this.sizedW = w;
    this.sizedH = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private sizedW = 0;

  private sizedH = 0;

  /**
   * Seconds left of the SETTLING WINDOW — resize on every frame while it runs.
   *
   * Measured on device, and it is the whole reason this exists: opened in
   * portrait the game came up short, and one rotation to landscape and back
   * fixed it permanently. That is the signature of a size read ONCE, too
   * early, that nothing afterwards re-reads — the rotation was simply the
   * first event that forced a second look.
   *
   * Every event a browser offers was already listened for (`resize`,
   * `orientationchange`, `visualViewport`, a `ResizeObserver` on the host).
   * The lesson is that on iOS the drawable area can settle without any of
   * them firing, so an event-driven resize has a hole in it that no amount of
   * more events closes. Watching for a couple of seconds does close it, and
   * costs one comparison a frame — the resize above returns immediately when
   * nothing moved.
   */
  private settleFor = 0;

  /**
   * The game is on screen NOW — size it for the viewport it is actually in.
   *
   * Called when the menu comes down rather than when the scene is built,
   * which is the other half of the fix: by then the app has been open long
   * enough to have settled, and a human has touched the screen.
   */
  reveal(): void {
    /* The game begins here, not when the scene was built. See `start`. */
    this.running = true;
    this.applyRememberedFit();
    this.resize(true);
    this.settleFor = SETTLE_SECONDS;
    if (!this.following) this.frameTank();
    this.fitGuard();
  }

  /* ------------------------------------------------ the viewport-fit guard */

  /**
   * HOW MUCH OF THE SCREEN THE PAGE ACTUALLY COVERS, in screen points, along
   * the long and the short axis.
   *
   * The viewport is in CSS pixels and the screen is in points, and the two
   * differ by the page zoom — which on the device in question was 1.150 when
   * nobody had asked for any zoom at all. Multiplying through is what makes
   * the comparison mean anything.
   *
   * Sorted axes, because `screen` does not rotate on iOS: it read 430 x 932
   * in BOTH orientations while the viewport rotated underneath it, so
   * width-against-width is nonsense the moment the phone turns.
   */
  private coverage(): { long: number; short: number } {
    const sh = window.screen;
    const zoom = window.visualViewport?.scale ?? 1;
    const w = window.innerWidth * zoom;
    const h = window.innerHeight * zoom;
    return {
      long: Math.max(sh.width, sh.height) - Math.max(w, h),
      short: Math.min(sh.width, sh.height) - Math.min(w, h),
    };
  }

  /** The `viewport-fit` currently asked for, and how to ask for another. */
  private currentFit(): ViewportFit {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    return /viewport-fit=cover/.test(meta?.content ?? '') ? 'cover' : 'contain';
  }

  private setFit(fit: ViewportFit): void {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute(
      'content',
      /viewport-fit=\w+/.test(meta.content)
        ? meta.content.replace(/viewport-fit=\w+/, `viewport-fit=${fit}`)
        : `${meta.content}, viewport-fit=${fit}`,
    );
    /* A viewport-meta edit fires no resize event, so the scene is told. */
    this.resize(true);
  }

  /**
   * WHAT THE GUARD DECIDED, for the readout. Not a boolean: "it was already
   * fine" and "it was short and this fixed it" are different answers and the
   * panel should not have to guess which one it is looking at.
   */
  fitReport = 'not run';

  private fitTried = false;

  /** Start in whatever won last time, so a fixed device does not re-flash. */
  private applyRememberedFit(): void {
    try {
      const saved = window.localStorage.getItem(FIT_KEY);
      if (saved === 'cover' || saved === 'contain') {
        if (saved !== this.currentFit()) this.setFit(saved);
        this.fitReport = `${saved} (remembered)`;
      }
    } catch {
      /* Private mode, or storage disabled. The guard below still runs, so
       * the only thing lost is one frame of the wrong fit at startup. */
    }
  }

  /**
   * MEASURE THE FIT, AND CORRECT IT — every launch, on every device.
   *
   * The alternative was to write down the answer that worked once. It was
   * `contain`, measured on an iPhone 15 Plus, where `cover` left the portrait
   * viewport 59.2 points short of a 932-point screen — exactly the status-bar
   * inset — while landscape covered 931.5 of 932 and looked perfect. But a
   * constant is a claim about every device and every iOS version, and this
   * one has already changed its behaviour under us once.
   *
   * So the app asks instead. If the page is not covering the screen, try the
   * other fit and keep whichever covers more; if the first one was already
   * fine, leave it alone — `cover` is the better look where it works, and
   * there is no reason to give it up on a device that never had the fault.
   *
   * ONE FLIP PER SESSION. `fitTried` is what stops a device where neither fit
   * covers from oscillating between them forever at rotation speed.
   */
  private fitGuard(): void {
    const before = this.coverage();
    const fit = this.currentFit();
    if (before.long <= FIT_TOLERANCE && before.short <= FIT_TOLERANCE) {
      this.fitReport = `${fit} (covers)`;
      this.remember(fit);
      return;
    }
    if (this.fitTried) {
      this.fitReport = `${fit} (short ${before.long.toFixed(0)}, no better fit)`;
      return;
    }
    this.fitTried = true;
    const other: ViewportFit = fit === 'cover' ? 'contain' : 'cover';
    this.setFit(other);
    /* Re-measured on the NEXT frame: the meta change has to reach layout
     * before the numbers mean anything, and reading them now reads the old
     * ones — the same trap `onViewportChange` defers a frame for. */
    requestAnimationFrame(() => {
      const after = this.coverage();
      const better = Math.max(after.long, after.short)
        < Math.max(before.long, before.short);
      const won: ViewportFit = better ? other : fit;
      if (!better) this.setFit(fit);
      this.remember(won);
      this.fitReport = better
        ? `${won} (fixed ${before.long.toFixed(0)}pt shortfall)`
        : `${won} (short ${before.long.toFixed(0)}, ${other} no better)`;
      this.resize(true);
      if (!this.following) this.frameTank();
    });
  }

  private remember(fit: ViewportFit): void {
    try { window.localStorage.setItem(FIT_KEY, fit); } catch { /* see above */ }
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
  soilForTest(): SoilMesh | null { return this.soil; }

  /**
   * How much soil sits below the surface, in world units — the depth a
   * founding shaft has to fit inside. See the probe's check on it.
   */
  gradeForTest(): number { return GRADE; }

  /**
   * Seconds left of the settling window, so a probe can see it ARMED rather
   * than infer it from a size that happened to be right.
   */
  settleForTest(): number { return this.settleFor; }

  /** The size the renderer was last set to, in CSS pixels. */
  sizedForTest(): { w: number; h: number } {
    return { w: this.sizedW, h: this.sizedH };
  }

  /**
   * The colour behind the world, as a hex string — so a probe can compare the
   * PAGE against it rather than against a constant written down twice.
   */
  sceneBackgroundForTest(): string | null {
    const bg = this.scene.background;
    return bg instanceof THREE.Color ? `#${bg.getHexString()}` : null;
  }

  /** Everything a probe needs to judge "she stands and walks correctly". */
  reportForTest(): {
    at: { x: number; y: number; z: number };
    heading: number; state: string; elapsed: number;
    planted: number; groping: number; movedMm: number;
    surfaceUnder: number | null; ride: number;
    cellMm: number; samples: number;
    seat: { rideMm: number; bellyMm: number; soleMm: number };
    bellyClearMm: number | null;
  } {
    const r = this.ant.report;
    const top = this.surfaceAt(this.ant.at.x, this.ant.at.z, this.ant.at.y + 1);
    const seat = this.ant.seatForTest();
    return {
      /*
       * THE SAME SHAPE THE VOXEL TRAY REPORTS.
       *
       * Not tidiness: the default route is the only route now, so every
       * locomotion probe points here, and one that asked for `seat` got
       * `undefined` and reported the belly clearance as NaN — a check that
       * fails without saying anything true. Two scenes answering the same
       * question have to answer it in the same words.
       */
      seat,
      /*
       * How far the lowest point of her BODY is above the soil under her, in
       * millimetres. Not derivable from `ride`, which is measured to her
       * ORIGIN — and the whole belly model is that her origin is not her
       * belly. On this rig the belly sits ABOVE the origin, so it adds.
       */
      bellyClearMm: top === null
        ? null
        : (this.ant.at.y - top) * MM_PER_UNIT + seat.bellyMm,
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
    window.clearInterval(this.metricsTimer);
    this.metrics?.remove();
    this.metricsRuler?.remove();
    this.watcher?.disconnect();
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('orientationchange', this.onViewportChange);
    window.visualViewport?.removeEventListener('resize', this.onViewportChange);
    this.soil?.dispose();
    this.gauge.dispose();
    this.renderer.dispose();
  }
}
