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
import { AntStroll, type StrollIntent, type StrollSenses } from './antStroll';
import { ObserverCamera } from './observerCamera';
import { DensityGround } from './density/densityGround';
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
    this.lastIntent = intent;
    this.ant.step(dt, intent, this.ground, this.surfaceAt);
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
      'left:calc(10px + env(safe-area-inset-left,0px))',
      'top:calc(10px + env(safe-area-inset-top,0px))',
      'right:calc(10px + env(safe-area-inset-right,0px))',
      'padding:8px 10px', 'border-radius:8px',
      'background:rgba(8,10,14,0.86)', 'color:#cfe3d0',
      'font:500 9.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:pre', 'pointer-events:none', 'user-select:none',
      'overflow:hidden',
    ].join(';');
    this.host.appendChild(box);
    this.metrics = box;

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
      this.metrics.textContent = [
        `v${__APP_VERSION__}`,
        `manifest ${wantDisplay}  ->  live ${live}${stale ? '   ** REINSTALL **' : ''}`,
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
    this.resize(true);
    this.settleFor = SETTLE_SECONDS;
    if (!this.following) this.frameTank();
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
    this.soil?.geometry.dispose();
    this.material?.dispose();
    this.renderer.dispose();
  }
}
