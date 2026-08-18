/**
 * THE HUD — every control on the rail, and the readout that feeds the
 * stats panel.
 *
 * Eight hundred lines of DOM construction, split out of `IslandScene`
 * because it is the largest thing in that file that touches the game only
 * through a handful of latches. It builds the joystick, the action rail,
 * the DEV drawer and the keyboard bindings, wires each control to the
 * scene's state, and then never runs again.
 *
 * The seam is wide — a HUD is by nature a control panel for everything —
 * and that width is exactly why it is stated below rather than left
 * implicit in `this`. `HudHost` is the complete list of what a button is
 * allowed to reach, and the compiler checks it. See the same note in
 * `islandCamera.ts` for why this is an interface and not a class.
 */
import * as THREE from 'three';
import type { BodyPosture } from './bodyPosture';
import type { BoreRig } from './BoreControl';
import { readFlick, readNudge, type Dodge } from './dodge';
import type { Vitals } from './islandVitals';
import { ABILITIES, type AbilityId, type AntKind } from './antKinds';
import type { NestDesigner } from '../nest/NestDesigner';
import type { NestView } from '../nest/nestView';
import type { IslandStream } from '../world/IslandStream';
import type { BuiltTree } from '../world/tree';
import type { TelemetryRecorder } from './IslandTelemetry';
import type { DebugStatsPanel } from './DebugStatsPanel';
import type { HudPart } from './hudModes';
import { MM, WINDOW_BYTES, WINDOW_MM } from '../world/worldScape';
import {
  AIM_LIMIT, DOUBLE_TAP_MS, DOUBLE_TAP_PX, PACE_NAMES,
  SMOOTH_RADIUS_MM, TAP_MS, TAP_TRAVEL_PX, stickCurve,
} from './islandTuning';

/** Everything a control on the rail may reach, and nothing else. */
export interface HudHost {
  /* --- the page --- */
  readonly hud: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly crosshair: HTMLElement;
  readonly digMissEl: HTMLElement;
  readonly statsPanel: DebugStatsPanel;

  /* --- the stick, and the stroke that is either a look or a flick --- */
  readonly stickEl: HTMLElement;
  readonly stickKnob: HTMLElement;
  readonly stickOrigin: { x: number; y: number };
  stickPointer: number | null;
  stickX: number;
  stickY: number;
  lookPointer: number | null;
  stroke: { x: number; y: number; lastX: number; lastY: number;
    at: number; travel: number };
  readonly keysDown: Set<string>;
  spaceWasDown: boolean;

  /* --- what the controls write --- */
  readonly input: { walk: number; yaw: number; strafe: number;
    dig: boolean; sprint: boolean; crawl: boolean };
  readonly posture: BodyPosture;
  readonly bore: BoreRig;
  readonly dodge: Dodge;
  readonly vitals: Vitals;
  readonly antKind: AntKind;
  /**
   * Every ability any caste the player can become has, in rail order.
   *
   * The rail is built from this and gated per-frame against `antKind` —
   * see the note where it is looped, and `applyHudMode`.
   */
  readonly playableAbilities: readonly AbilityId[];
  biteBtn: HTMLButtonElement | null;
  stingBtn: HTMLButtonElement | null;
  carryBtn: HTMLButtonElement | null;
  interactBtn: HTMLButtonElement | null;
  useAbility(id: AbilityId): void;
  /** Opens and closes the DEV drawer. Set by `buildControls`; driven from
   *  the PAUSE menu, which is where the handle lives now. */
  toggleDevDrawer: (() => boolean) | null;
  readonly at: THREE.Vector3;
  pace: 0 | 1 | 2;
  shiftHeld: boolean;
  crawlHeld: boolean;
  digMode: boolean;
  firstPerson: boolean;
  showPlan: boolean;
  aimDebug: boolean;
  aimPitch: number;
  lookYaw: number;
  lookPitch: number;
  lookIdle: number;

  /* --- the elements the scene keeps a handle on --- */
  aimChip: HTMLButtonElement | null;
  aimReadout: HTMLElement | null;
  rollReadout: HTMLElement | null;
  headingReadout: HTMLElement | null;
  depthReadout: HTMLElement | null;
  traceCanvas: HTMLCanvasElement | null;
  /** A double-tap landed on the glass — the scene decides whether it was
   *  ON the queen, and toggles her following. See `queenDoubleTap`. */
  queenDoubleTap(clientX: number, clientY: number): void;
  boreRadius(): number;
  boreLength(): number;
  poseReadout: HTMLElement | null;
  paceChip: HTMLButtonElement | null;
  rideChip: HTMLButtonElement | null;
  tiltChip: HTMLButtonElement | null;
  scoopBtn: HTMLButtonElement | null;
  sprintBtn: HTMLButtonElement | null;
  telemetryChip: HTMLButtonElement | null;

  /* --- what the readout reports --- */
  readonly stats: { fps: number; frames: number; fpsAt: number;
    scrolls: number; lastScrollMs: number; rebases: number };
  readonly chunkMeshes: Map<string, THREE.Mesh>;
  readonly stands: Map<string, THREE.InstancedMesh>;
  readonly queue: { cx: number; cy: number; cz: number }[];
  readonly telemetry: TelemetryRecorder;
  terrainVerts: number;
  terrainTris: number;
  pixelRatioNow: number;
  heights: Int16Array | null;
  stream: IslandStream | null;
  tree: BuiltTree | null;
  nestView: NestView | null;
  designer: NestDesigner | null;

  /* --- and the scene's own behaviour, called rather than copied --- */
  applyHudMode(): void;
  applyPace(): void;
  /** Register a control under its name in the mode table. See
   *  `hudModes.ts` — the TABLE decides where it appears, not the caller. */
  railPart(el: HTMLElement, part: HudPart): void;
  refreshPoseChips(): void;
  routeStick(): void;
  openDesigner(): void;
  setAimDebug(on: boolean): void;
  treeLevel(): number;
  groundHeightAt(x: number, z: number): number;
  telemetryReport(): string;
}

export function buildControls(host: HudHost, ): void {
  const actions = document.createElement('div');
  actions.className = 'density-lab-actions';
  host.hud.appendChild(actions);

  /*
   * DIG IS A MODE: tap DIG to arm it, and the PALETTE appears. From there
   * it is a coaster builder — a row of pieces, one tap each, laid on the
   * end of what is already there. The two-step survives from the chewing
   * era for the same reason it was introduced: a palette that is always
   * on screen is a palette that gets dug into by a mis-tap.
   */
  const dig = document.createElement('button');
  /*
   * THE FIRST BUTTON WEARING THE REAL ART, and it is deliberately only
   * one of them.
   *
   * The ten HUD pieces are WebP, and WebP has to survive three things
   * before a HUD is built on top of it: the bundler, the service worker's
   * cache, and whatever Safari does on the device. Proving that with one
   * button costs nothing; discovering it with ten, after the layout is
   * built around them, costs the layout. `tm-art` carries the picture and
   * drops the label, because the artwork already says DIG.
   */
  dig.className = 'density-lab-button density-lab-dig tm-art tm-art-dig';
  dig.setAttribute('aria-label', 'Dig');
  dig.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.digMode = !host.digMode;
    /* A burst in flight while the jaws come out would carry her off the
     * spot she was lining up. */
    if (host.digMode) host.dodge.cancel();
    dig.classList.toggle('is-grip', host.digMode);
    /* The overlay's switch belongs to the shovel, and leaves with it —
     * along with the overlay itself, which `updateAimDebug` hides on
     * the same condition. It lives inside the DEV drawer rather than on
     * the rail, so it is not a `railPart` and keeps its own line. */
    if (host.aimChip) host.aimChip.style.display = host.digMode ? '' : 'none';
    /* SCOOP and the two instruments used to be switched here by hand.
     * They are declared against 'dig' now and this one call hangs the
     * whole rail — including everything that has to LEAVE. */
    host.applyHudMode();
    if (!host.digMode) host.input.dig = false;
    /* Digging is aiming, and aiming is done down her own eyes: arming
     * DIG drops into first person with a wide 100° field so the tunnel
     * mouth and the instruments share the frame. Disarming narrows the
     * lens back; the VIEW chip still switches freely either way. */
    if (host.digMode) host.firstPerson = true;
    host.camera.fov = host.digMode ? 100 : 60;
    host.camera.updateProjectionMatrix();
  });
  actions.appendChild(dig);
  host.railPart(dig, 'dig');

  /*
   * THE SHOVEL: hold it and she strokes, each stroke one mouthful along
   * the aim. Arming DIG first is deliberate — a lone held button carved
   * tunnels out of mis-taps, and a scoop this size deserves the intent.
   */
  const scoopBtn = document.createElement('button');
  scoopBtn.className = 'density-lab-button tm-art tm-art-scoop';
  scoopBtn.setAttribute('aria-label', 'Scoop — hold to dig');
  scoopBtn.style.display = 'none';
  host.scoopBtn = scoopBtn;
  scoopBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    scoopBtn.setPointerCapture(e.pointerId);
    host.input.dig = true;
  });
  const stopDig = (): void => { host.input.dig = false; };
  scoopBtn.addEventListener('pointerup', stopDig);
  scoopBtn.addEventListener('pointercancel', stopDig);
  scoopBtn.addEventListener('lostpointercapture', stopDig);
  host.railPart(scoopBtn, 'scoop');


  /*
   * THE SHAVE HAS NO SLIDER ANY MORE.
   *
   * It was there because the right size looked like it depended on
   * whether you were easing one lip or a whole chamber floor. Played, it
   * did not: the widest setting was better everywhere, so the control was
   * a thing to push to the end before starting. A setting with one good
   * value is a constant.
   */



  /*
   * The angle, where the thumb can see it.
   *
   * Taking the ± buttons away also took away the only way to tell how
   * steeply she was pointed, and a bore you cannot read is a bore that
   * quietly goes too deep — which is exactly what happened. This is a
   * readout and not a control: the drag still does the aiming.
   */
  /*
   * THE THREE INSTRUMENTS SHARE ONE ROW.
   *
   * They were a column, one chip per rail slot, which is 66px of a rail
   * that has to hold DIG, SCOOP and VIEW as well. On a landscape phone
   * that is the difference between VIEW being on screen and VIEW being cut
   * in half by the bottom edge — reported with a screenshot of exactly
   * that. They are a navigation panel and read better together anyway:
   * angle, bearing, depth, in the order you use them.
   */
  const instruments = document.createElement('div');
  instruments.className = 'tm-instruments';
  actions.appendChild(instruments);
  /* The row goes when its contents do, or walking leaves an empty flex
   * item and the gap either side of it. */
  host.railPart(instruments, 'instruments');

  host.aimReadout = document.createElement('div');
  host.aimReadout.className = 'density-lab-aim-readout';
  instruments.appendChild(host.aimReadout);
  /* An AIM readout, so it goes out with the aiming. Walking, it reports
   * her lean — which is a thing the posture readout says better, in the
   * mode where it matters — and 29px of rail is the difference between
   * DIG clearing the MENU plate and climbing into it. */
  host.railPart(host.aimReadout, 'aim');

  /*
   * ROLL, between the angle and the bearing, because that is the order a
   * pilot reads them: attitude first, then course. The angle says where
   * the next stroke goes; roll says which way is UP while she cuts it —
   * and in a bore that has looped, "up" is the fact she has lost.
   * World-referenced like its neighbours, from her actual body frame
   * rather than the posture rig's dial (the rig is an override and reads
   * zero whenever the player has not armed it, which in dig mode is
   * always — an instrument that always says level is a decoration).
   */
  host.rollReadout = document.createElement('div');
  host.rollReadout.className = 'density-lab-aim-readout';
  instruments.appendChild(host.rollReadout);
  host.railPart(host.rollReadout, 'roll');

  /*
   * THE OTHER TWO INSTRUMENTS, while the shovel is out.
   *
   * The angle alone says which way the next stroke goes and nothing about
   * where that leaves her. A bearing and a depth make the three together
   * a navigation panel: you can drive a tunnel on a heading, hold a
   * grade, and know how far under you are — which is the whole of digging
   * blind. Both are world-referenced, like the angle beside them.
   */
  host.headingReadout = document.createElement('div');
  host.headingReadout.className = 'density-lab-aim-readout';
  instruments.appendChild(host.headingReadout);
  host.railPart(host.headingReadout, 'heading');

  host.depthReadout = document.createElement('div');
  host.depthReadout.className = 'density-lab-aim-readout';
  instruments.appendChild(host.depthReadout);
  host.railPart(host.depthReadout, 'depth');

  /*
   * THE ROUTE TRACE — the underground panel. Same row, other blindness:
   * below grade the four gauges above give way to this one canvas, the
   * tunnel's own side-on profile. The MODE decides which set is up —
   * `digDeep` in `hudModes` — so this is just the element; the scene
   * samples the route and draws it. See `routeTrace.ts`.
   */
  host.traceCanvas = document.createElement('canvas');
  host.traceCanvas.className = 'tm-routetrace';
  instruments.appendChild(host.traceCanvas);
  host.railPart(host.traceCanvas, 'trace');


  /* The PLAN button is gone: the shovel is how tunnels get made now.
   * The designer code stays for the tests and for a possible return as
   * a colony-scale tool, but the queen digs with her jaws, not a CAD. */


  /*
   * THE DEV DRAWER — "move all the debug buttons in like a DEV menu or
   * something so it doesn't take up a lot of the screen".
   *
   * The rail is bottom-anchored and grows UPWARD, so every chip costs
   * headroom exactly where the dig controls live — which is how the DIG
   * toggle, the only way OUT of dig mode, once got pushed off the top of a
   * phone. Four of the chips on it (the sonar overlay, the aim overlay and
   * the flight recorder's three) are instruments rather than controls:
   * reached deliberately, when something already looks wrong, and never
   * mid-crawl. Those fold behind one chip.
   *
   * Not PIN-gated, unlike the front door's DEV button. That gate exists so
   * a curious player does not land in a terrain sculptor; this drawer only
   * holds readouts and two overlays, and the person who wants it wants it
   * several times a session with a phone in one hand.
   */
  const devPanel = document.createElement('div');
  devPanel.className = 'density-lab-subrow tm-dev-panel';
  devPanel.style.display = 'none';

  const plan = document.createElement('button');
  plan.className = 'density-lab-button density-lab-mode';
  plan.textContent = 'SONAR';
  plan.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.showPlan = !host.showPlan;
    if (host.nestView) host.nestView.root.visible = host.showPlan;
  });
  devPanel.appendChild(plan);

  /*
   * AIM — the dig overlay's switch, and it lives with the dig controls
   * because that is the only mode it draws in.
   *
   * It was shipped as `?aimdebug=1` alone, which is a fine switch for a
   * probe and a poor one for the person actually holding the phone: it
   * cannot be turned off without retyping the address, and it cannot be
   * turned ON at the moment something looks wrong, which is the only
   * moment anyone wants it. The chip appears with the shovel and goes
   * away with it, so an ordinary session never sees it — and the URL
   * still works, for probes and for arriving with it already on.
   */
  host.aimChip = document.createElement('button');
  host.aimChip.className = 'density-lab-button density-lab-mode';
  host.aimChip.textContent = 'AIM';
  host.aimChip.style.display = 'none';
  host.aimChip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.setAimDebug(!host.aimDebug);
  });
  devPanel.appendChild(host.aimChip);

  const view = document.createElement('button');
  view.className = 'density-lab-button tm-art tm-art-view';
  view.setAttribute('aria-label', 'View — first or third person');
  view.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.firstPerson = !host.firstPerson;
  });
  /*
   * ONE WRAPPING CLUSTER, NOT SIX STACKED ROWS.
   *
   * VIEW, DODGE, RIDE and TILT were each taking a rail row to hold one
   * 62px plate, and six rows of one do not fit a 430px-tall phone: walk
   * mode measured 400px of content in a 324px budget, which flex pays for
   * by quietly squashing whichever row is least protected.
   *
   * They are all the same size and they all wrap, so they belong in the
   * same box. Mode visibility is per-PLATE rather than per-row, so the
   * cluster simply holds fewer of them in dig mode and shrinks to suit.
   */
  const cluster = document.createElement('div');
  cluster.className = 'tm-cluster';
  actions.appendChild(cluster);

  /*
   * DIG JOINS THE CLUSTER INSTEAD OF SITTING ON TOP OF IT.
   *
   * It was built above as its own rail row, which put the biggest and most
   * used control in the game at the TOP of a stack of nine smaller plates —
   * furthest from the thumb, and 93px of rail height (86 plus a gap) spent
   * on a single button. Measured, that rail ran 324px tall on the design
   * canvas and hit its own max-height ceiling, which is what pushed its top
   * edge up to y=90 and straight through the quest panel's corner.
   *
   * In the cluster it is one of the group, ordered to the corner nearest
   * the thumb (see `order` in the stylesheet), and the rail loses a whole
   * row. Re-parenting rather than rebuilding: `appendChild` MOVES a node,
   * so every listener, every `railPart` registration and the `is-grip`
   * toggle all come with it untouched.
   */
  cluster.appendChild(dig);
  /*
   * AND SCOOP WITH IT — the fix for "in dig mode the scoop is in the wrong
   * place". DIG was re-parented into the cluster in v0.1.36 and SCOOP was
   * not, so it stayed a direct child of the rail: in the old bottom ROW that
   * put it in a line above the plates and nobody noticed, and in the edge
   * DOCK it put it at the top of the column, across the objective card.
   *
   * It is the dig mode's PRIMARY, so once it is in the cluster the mode
   * table sends it to the corner where the thumb is — which is where DIG
   * sits in every other mode, and where a held stroke belongs.
   */
  cluster.appendChild(scoopBtn);

  cluster.appendChild(view);
  host.railPart(view, 'view');

  /*
   * DODGE — A BUTTON YOU SWIPE, not a button you press.
   *
   * The evade already exists and has only ever had one way in: a flick
   * across the open canvas. That gesture is off in first person and off
   * with DIG armed, because in her own eyes a drag turns HER and lining
   * up a bite is a dozen quick short strokes that all look exactly like
   * flicks. Which is a sound decision and leaves a real hole: from inside
   * her own head there is currently NO WAY TO DODGE AT ALL.
   *
   * A dedicated plate closes it, and it takes the direction the same way
   * the canvas does — "press and swipe and release in the direction of
   * dodge" — because a dodge with no direction is not a dodge. What it
   * does NOT copy is the flick's speed and duration gates: those exist to
   * tell an evade apart from a look, and on a button that was down on
   * DODGE there is nothing to tell apart. See `readNudge`.
   *
   * The pointer is captured, so the thumb may finish the stroke anywhere
   * on the glass; only where it STARTED has to be the button.
   */
  const dodgeBtn = document.createElement('button');
  dodgeBtn.className = 'density-lab-button tm-art tm-art-dodge tm-dodge';
  dodgeBtn.setAttribute('aria-label', 'Dodge');
  dodgeBtn.title = 'Dodge — press, swipe the way you want to go, release.';
  const nudge = { x: 0, y: 0, id: -1 };
  dodgeBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { dodgeBtn.setPointerCapture(e.pointerId); } catch { /* fine */ }
    nudge.id = e.pointerId;
    nudge.x = e.clientX;
    nudge.y = e.clientY;
    dodgeBtn.classList.add('is-grip');
  });
  const endNudge = (e: PointerEvent): void => {
    if (e.pointerId !== nudge.id) return;
    nudge.id = -1;
    dodgeBtn.classList.remove('is-grip');
    const dir = readNudge(e.clientX - nudge.x, e.clientY - nudge.y);
    /* A tap is not a direction. Guessing one would send her somewhere
     * the player did not ask to go, which on a control whose whole job
     * is escaping something is the worst possible failure. */
    /*
     * A DODGE IS PAID FOR BEFORE IT HAPPENS. `spend` refuses rather than
     * going into credit, and `start` refuses while one is already in
     * flight — so the stamina only leaves when the burst actually does.
     */
    if (dir && host.vitals.stamina >= host.vitals.dodgeCost
      && host.dodge.start(dir, MM)) host.vitals.spend(host.vitals.dodgeCost);
  };
  dodgeBtn.addEventListener('pointerup', endNudge);
  dodgeBtn.addEventListener('pointercancel', () => {
    nudge.id = -1;
    dodgeBtn.classList.remove('is-grip');
  });
  cluster.appendChild(dodgeBtn);
  /*
   * Not in dig mode, and that is not an oversight: arming DIG already
   * CANCELS a burst in flight, deliberately, because a dodge mid-stroke
   * carries her off the spot she was lining up. Handing her a dodge
   * button in there would quietly reverse a decision someone made on
   * purpose. Available walking and while setting her body, which is
   * where the swipe cannot reach.
   */
  host.railPart(dodgeBtn, 'dodge');

  /*
   * CRAWL / WALK / RUN — and on a touch screen it is the ONLY pace there is.
   *
   * Shift has always doubled her pace for the PC hand; a thumb had no
   * equivalent, so a phone was locked to 7.5 mm/s whatever it did. The
   * chip is a latch rather than a held button because there is nowhere
   * left on a phone to hold a second finger down: the left half of the
   * screen is the stick and the right half is the look-drag.
   *
   * It cycles three ways rather than two because there is now a second
   * GAIT down there to reach: below `GAIT_WAVE_BELOW` she picks her way
   * one foot at a time, and without a crawl on the chip that gait was
   * only reachable by feathering a thumbstick, which nobody does
   * deliberately.
   */
  /*
   * THE ACTION CLUSTER, at the sizes the design calls for.
   *
   * Ordered so the hierarchy reads without labels: DIG is 72 px because it
   * is what this game is about, the frequent actions are 54, the modifiers
   * 50. Each sits in a box larger than its plate — see the `.tm-art-*`
   * rules — so the tight look costs nothing in reach.
   *
   * Three of these are real and four are not, and they are built the same
   * way on purpose: the layout has to be judged at the density it will
   * actually have, not at the density of the subset that happens to work
   * today. The ones without systems behind them carry `is-soon`.
   */
  /* Already built, above — the single plates join it rather than each
   * taking a rail row of their own. */


  const plate = (
    name: string, label: string, onPress: (() => void) | null,
    /* The table's name for it, when that differs from the ART's name. It
     * does exactly once: the pace latch wears the SPRINT plate. */
    part: HudPart = name as HudPart,
    /* Where it goes. The cluster unless it belongs to the other thumb —
     * see the pace latch. */
    into: HTMLElement = cluster,
  ): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = `density-lab-button tm-art tm-art-${name}${onPress ? '' : ' is-soon'}`;
    b.setAttribute('aria-label', label);
    if (!onPress) b.setAttribute('aria-disabled', 'true');
    else {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(); });
    }
    into.appendChild(b);
    /* Registered under its own art name, which IS its name in the mode
     * table — so `bite` appears where the table says `bite` appears and
     * nowhere else. Nothing here decides visibility any more. */
    host.railPart(b, part);
    return b;
  };

  /*
   * THE CLUSTER IS THE ANT'S, not the HUD's.
   *
   * These were three hardcoded `plate` calls, which is fine for one ant and
   * becomes an `if` ladder the moment there are two. The list comes off
   * `antKind` now, so a fire ant showing STING and a twig ant showing SCOUT
   * is a data difference — see `antKinds.ts`.
   *
   * `built` decides whether a plate is live or dimmed, and it lives on the
   * ABILITY rather than the kind: whether the game does a thing is a fact
   * about the game, and whether this ant does it is a fact about the ant.
   */
  /*
   * BUILT FROM EVERY CASTE THE PLAYER CAN BE, not from the one she is.
   *
   * The rail used to be built from `antKind.abilities`, which was right
   * while the ant you play never changed. It does now — the founding hands
   * you a worker, and a worker stings where the queen did not — and this
   * HUD CANNOT BE REBUILT to suit: `buildControls` binds six listeners to
   * `window` and `document` with anonymous handlers, so running it twice
   * would double every key press and every stick release. Rebuilding was
   * the obvious way to do this and it is a trap.
   *
   * So every plate the player could ever hold is built ONCE, and which of
   * them she can see is decided each frame by `applyHudMode`, which already
   * shows and hides these exact elements by mode. A caste change is then a
   * change of DATA that the existing display pass picks up, with nothing
   * torn down and nothing bound twice.
   */
  for (const id of host.playableAbilities) {
    const ability = ABILITIES[id];
    const b = plate(ability.art, ability.label,
      ability.built ? () => host.useAbility(id) : null);
    /* The two the fight drives keep a handle, so `refreshCombatChips` can
     * light and dim them without going looking through the DOM. */
    if (id === 'bite') host.biteBtn = b;
    if (id === 'sting') host.stingBtn = b;
    /* CARRY keeps one too: it wears DROP's face while she is loaded, which
     * `refreshCombatChips` swaps by class rather than by rebuilding the
     * plate — see IslandScene. */
    if (id === 'carry') host.carryBtn = b;
    if (id === 'interact') host.interactBtn = b;
  }
  /*
   * SPRINT is real: it is the pace latch the CRAWL/WALK/RUN chip drives,
   * wearing the plate the design asked for. Cycling rather than holding
   * because that is what the latch already does, and because there is
   * nowhere on a phone to hold a second finger down — the left half is the
   * stick and the right half is the look.
   */
  /*
   * THE PACE LATCH SITS BY THE STICK, not in the action cluster.
   *
   * Joshua's layout, and it is the better home on its own terms: pace is
   * not an ACTION, it is how the thing you are already doing is done, and
   * the thing you are already doing is driven by the left thumb. Putting it
   * beside the stick puts it under the hand that owns it, and gives the
   * right-hand cluster its seat back — which is what let STING in without
   * anything else leaving.
   *
   * Its own box rather than a member of the cluster, because the cluster is
   * a zigzag with a rhythm of its own and a plate that belongs to the other
   * thumb should not be part of it. Still registered under `pace`, so the
   * mode table decides when it is there exactly as before.
   */
  const gait = document.createElement('div');
  gait.className = 'tm-gait';
  host.hud.appendChild(gait);
  host.sprintBtn = plate('sprint', 'Pace', () => {
    host.pace = ((host.pace + 1) % 3) as 0 | 1 | 2;
    host.applyPace();
  }, 'pace', gait);

  /*
   * The CRAWL/WALK/RUN chip is now the SPRINT plate's job, so the chip is
   * built but not shown: `applyPace` still writes its label, several
   * probes read it, and two visible controls for one latch is how a player
   * learns that one of them does nothing.
   */
  host.paceChip = document.createElement('button');
  host.paceChip.className = 'density-lab-button density-lab-mode';
  host.paceChip.style.display = 'none';
  host.paceChip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.pace = ((host.pace + 1) % 3) as 0 | 1 | 2;
    /* Written HERE as well as in `applyKeys`, because that only runs on a
     * key event — on a phone there are none, so the latch would have sat
     * there doing nothing until someone plugged a keyboard in. */
    host.applyPace();
  });
  host.applyPace();
  actions.appendChild(host.paceChip);

  /*
   * THE FLIGHT RECORDER'S THREE BUTTONS.
   *
   * REC is a readout rather than a control — it arms itself the moment she
   * moves, because the interesting run is the one nobody remembered to
   * start recording. STOP freezes the buffer so a good run cannot be
   * overwritten by walking back; COPY puts the report on the clipboard.
   *
   * Tapping REC once it has stopped clears it and re-arms, so a second
   * attempt does not need a page reload.
   */
  /*
   * ONE ROW, NOT THREE. As three stacked buttons these pushed the rail
   * off the top of a phone in dig mode — the DIG toggle, which is also
   * the way OUT of dig mode, went with it. Reported as "I can't get out
   * of dig mode". The rail is bottom-anchored and grows upward, so every
   * chip added anywhere costs headroom exactly where the dig controls
   * live; the recorder's three buttons now share one slot.
   */
  const logRow = document.createElement('div');
  logRow.className = 'tm-log-row';
  devPanel.appendChild(logRow);

  host.telemetryChip = document.createElement('button');
  host.telemetryChip.className = 'density-lab-button density-lab-mode';
  host.telemetryChip.textContent = 'REC';
  host.telemetryChip.title = 'Records automatically once she moves';
  host.telemetryChip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.telemetry.reset();
  });
  logRow.appendChild(host.telemetryChip);

  const logStop = document.createElement('button');
  logStop.className = 'density-lab-button';
  logStop.textContent = 'STOP';
  logStop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    host.telemetry.stop();
  });
  logRow.appendChild(logStop);

  const logCopy = document.createElement('button');
  logCopy.className = 'density-lab-button';
  logCopy.textContent = 'COPY';
  logCopy.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    /* Stop first: copying a still-running buffer gives a report that
     * disagrees with itself between the summary and the events. */
    host.telemetry.stop();
    const text = host.telemetryReport();
    const done = (ok: boolean) => {
      logCopy.textContent = ok ? 'COPIED' : 'SEE LOG';
      window.setTimeout(() => { logCopy.textContent = 'COPY'; }, 1500);
    };
    /* The clipboard needs a secure context and a user gesture; on a plain
     * http:// LAN address for phone testing it is simply absent, so the
     * console is the fallback rather than a silent failure. */
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => {
        console.log(text);
        done(false);
      });
    } else {
      console.log(text);
      done(false);
    }
  });
  logRow.appendChild(logCopy);

  /*
   * ↕ AND 🚁 — her height and her attitude, on the stick that walks her.
   *
   * These are not debug chips and do not go in the drawer. A real ant
   * reads the slope it is on and sets its body to suit; this rig had no
   * way to say either thing, so a 90° crease was crawled at exactly the
   * height and attitude flat ground is, which is where the abdomen scrapes
   * and the belly rides the bend. Until the postural controller can choose
   * these from what her feet report, a thumb chooses them — and once it
   * can, these stay as the override and as the way to SEE what it chose.
   *
   * One row rather than two rail slots: they are a pair, they are never
   * both armed, and the rail has no headroom to spare.
   */
  const poseRow = document.createElement('div');
  poseRow.className = 'tm-log-row';
  /* The row survives only to carry the live pose numbers now that its
   * two chips have moved into the cluster. */
  actions.appendChild(poseRow);
  host.railPart(poseRow, 'poseRow');

  /*
   * Arming is a TAP; centring is a LONG PRESS.
   *
   * Releasing the stick deliberately holds the pose — you set an attitude
   * in order to walk a crease with it — so "back to normal" has to be its
   * own gesture rather than a side effect of letting go. A long press is
   * the one gesture left on a phone that no other control here uses.
   */
  const poseBtn = (
    label: string, mode: 'ride' | 'tilt', title: string,
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.className = `density-lab-button tm-art tm-art-${mode === 'ride' ? 'ride' : 'tilt'}`;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    let held: number | null = null;
    let longPressed = false;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      longPressed = false;
      held = window.setTimeout(() => {
        longPressed = true;
        held = null;
        /* Centre BOTH, not just this one: "put her back how she was" is
         * one intention, and having to find which of two buttons is
         * holding a stray two degrees is not a thing to do on a phone. */
        host.posture.centre();
        host.posture.disarm();
        host.refreshPoseChips();
      }, 500);
    });
    const finish = (e: PointerEvent): void => {
      e.preventDefault();
      if (held !== null) { window.clearTimeout(held); held = null; }
      if (longPressed) return;
      host.posture.toggle(mode);
      /* A stick already under a thumb when the mode changes would keep
       * meaning whatever it meant a moment ago. Re-route it now, and zero
       * the walk the instant posture takes over. */
      host.routeStick();
      host.refreshPoseChips();
    };
    btn.addEventListener('pointerup', finish);
    btn.addEventListener('pointercancel', (e) => {
      if (held !== null) { window.clearTimeout(held); held = null; }
      e.preventDefault();
    });
    /*
     * INTO THE DRAWER, and this is a change of mind that is worth stating
     * because the note above used to say the opposite.
     *
     * "These are not debug chips and do not go in the drawer" was written
     * when the cluster had room and the argument was about what they MEAN —
     * a postural override is gameplay, not instrumentation, and that is
     * still true. What changed is the HUD blueprint, which lists the
     * player's actions as DIG / BITE / CARRY / INTERACT / CLIMB / SPRINT
     * and does not include these, and a device report naming TILT and RIDE
     * among ten plates that were eating the camera drag.
     *
     * So they move, and the reason is reach rather than status: the drawer
     * is the only place that is not the playing screen and is still
     * reachable. Arming one still puts the HUD into `pose` — the mode is
     * real and the readout still appears on the rail. When the postural
     * controller can choose height and attitude from what her feet report,
     * these want a proper home; that is a design decision and it is on the
     * board rather than settled here.
     */
    devPanel.appendChild(btn);
    return btn;
  };
  /*
   * WORDS, NOT EMOJI, now that these sit on a plate. ↕ and 🚁 were a good
   * shorthand on a bare pill and are the wrong thing on gold: they are
   * full-colour glyphs the system font draws, and they fight the plate
   * rather than sit on it. RIDE and TILT also say what they are without
   * needing the hover title to explain the joke.
   */
  host.rideChip = poseBtn(
    'RIDE', 'ride', 'Body height — stick forward lowers, back raises. Hold to centre.',
  );
  host.tiltChip = poseBtn(
    'TILT', 'tilt', 'Body attitude — stick tilts her like a rotor hub. Hold to centre.',
  );

  /*
   * The numbers the pose was found at, live, so a good crease posture can
   * be read off the screen and become the automatic version's target
   * rather than a constant somebody guessed.
   */
  host.poseReadout = document.createElement('div');
  host.poseReadout.className = 'density-lab-aim-readout tm-pose-readout';
  host.poseReadout.style.display = 'none';
  poseRow.appendChild(host.poseReadout);
  host.refreshPoseChips();

  actions.appendChild(devPanel);

  /*
   * THE DEV HANDLE IS NOT ON THE PLAYING SCREEN ANY MORE — it is on the
   * PAUSE menu, and this is the seam that lets it be.
   *
   * It was a cream pill at the very bottom of the rail. Two things wrong
   * with that, and the second is the one that got reported: with the
   * cluster tidied it became the brightest object on the HUD, and being
   * the LAST child of a bottom-anchored column it sat UNDER the plates and
   * shoved all ten of them 38px further up the screen — a debug handle
   * costing the game's controls a row of headroom.
   *
   * The DRAWER stays here, because this is where its instruments belong
   * and it is closed by default, so it costs nothing until asked for. Only
   * the way IN moved. `main.ts` hands this to `PauseMenu`, which is the
   * right home for it: dev chrome behind a deliberate stop, exactly like
   * the version readout that went the same way.
   *
   * Deliberately NOT a `railPart`. It has its own open/closed state, and a
   * drawer that vanished when you armed the shovel would be useless
   * precisely when it is most wanted.
   */
  host.toggleDevDrawer = (): boolean => {
    const open = devPanel.style.display === 'none';
    devPanel.style.display = open ? '' : 'none';
    return open;
  };

  /* Hang the opening set. Every `railPart` above is invisible until this
   * runs, which is why it has to be the last thing the rail does. */
  host.applyHudMode();

  /*
   * WASD for the PC hand (playtest: "I was having trouble moving"):
   * W/S walk, A/D turn, Shift runs, C crawls, Space DIGS (hold), B opens the nest
   * tools, V swaps the view. There is no aim key: she digs where the view
   * looks.
   * Arrows mirror WASD. Keys and stick write the same inputs.
   */
  const applyKeys = () => {
    const k = host.keysDown;
    if (host.designer?.isOpen) {
      /* The designer owns the keys, but the Space EDGE must keep tracking
       * or a release while designing leaves it stuck "down" — and the
       * next press after DONE would be swallowed. */
      host.spaceWasDown = k.has(' ');
      return;
    }
    const forward = (k.has('w') || k.has('arrowup') ? 1 : 0)
      - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const turn = (k.has('d') || k.has('arrowright') ? 1 : 0)
      - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    if (host.stickPointer === null) {
      host.input.walk = forward;
      host.input.yaw = turn;
    }
    /* The keys are holds and the chip is a latch, so a hold wins for as
     * long as it is held and the latch is still there afterwards — the
     * chip's face keeps reading the latch throughout, because that is
     * what it will go back to. */
    host.shiftHeld = k.has('shift');
    host.crawlHeld = k.has('c');
    host.applyPace();
    /* Space is the shovel, and it is HELD — but only once DIG is armed. */
    const space = k.has(' ');
    if (space !== host.spaceWasDown) {
      host.input.dig = host.digMode && space;
      host.spaceWasDown = space;
    }
  };
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'b' && !e.repeat) host.openDesigner();
    if (key === 'v' && !e.repeat) host.firstPerson = !host.firstPerson;
    if (key === 'p' && !e.repeat) {
      host.showPlan = !host.showPlan;
      if (host.nestView) host.nestView.root.visible = host.showPlan;
    }
    host.keysDown.add(key);
    applyKeys();
  });
  window.addEventListener('keyup', (e) => {
    host.keysDown.delete(e.key.toLowerCase());
    applyKeys();
  });
  window.addEventListener('blur', () => {
    host.keysDown.clear();
    applyKeys();
  });

  /*
   * Parked at its corner from the first frame rather than conjured under
   * a thumb. `nest-stick` still carries the geometry and the designer's
   * hide-list exemption; `tm-stick` carries the plate art and the home.
   */
  host.stickEl.className = 'nest-stick tm-stick is-home';
  host.stickKnob.className = 'nest-stick-knob';
  host.stickEl.appendChild(host.stickKnob);
  host.hud.appendChild(host.stickEl);

  // Her aim, in her own eyes: shown only in first person.
  host.crosshair.className = 'density-lab-crosshair';
  host.crosshair.style.display = 'none';
  host.crosshair.style.pointerEvents = 'none';
  host.hud.appendChild(host.crosshair);

  /* The miss note, parked just under the crosshair's spot and invisible
   * until `biteMiss` lights it. In EITHER view — third person hides the
   * crosshair but a press over a drop misses just the same. */
  host.digMissEl.className = 'dig-miss';
  host.digMissEl.textContent = 'OUT OF REACH';
  host.digMissEl.style.pointerEvents = 'none';
  host.hud.appendChild(host.digMissEl);

  const canvas = host.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fine */ }
    if (host.designer?.isOpen) { host.designer.handlePointerDown(e); return; }
    /*
     * THE STICK IS FIXED, and it has to be.
     *
     * Reported: "we need to make the joystick fixed as I can't press the
     * button to go faster or slower because the joystick right now
     * dynamically moves."
     *
     * It used to claim the whole LEFT HALF of the glass and jump to
     * whatever thumb landed there — "the discoverability of a fixed pad
     * with the ergonomics of a floating one", which was a fair trade right
     * up until something else wanted to live on that side. v0.1.64 moved
     * the pace latch next to the pad, and a pad that teleports onto your
     * thumb lands ON the plate you were reaching for. My regression: the
     * plate moved, the pad's appetite did not.
     *
     * So the pad stays home and the touch has to land on IT. Everything
     * else on the left is a look-drag now, exactly as the right half
     * already was — which is also what makes the pace plate reachable,
     * because a tap beside the pad is no longer a tap on it.
     *
     * Measured against the ELEMENT rather than a remembered corner: it is
     * bottom-anchored with safe-area insets, so where it actually is
     * depends on the phone.
     */
    const pad = host.stickEl.getBoundingClientRect();
    const onPad = e.clientX >= pad.left && e.clientX <= pad.right
      && e.clientY >= pad.top && e.clientY <= pad.bottom;
    if (onPad && host.stickPointer === null) {
      host.stickPointer = e.pointerId;
      /* The pad's own centre, not the touch. A fixed stick measures from
       * where it IS, so a thumb landing off-centre is already an input —
       * which is what makes the edge of the pad mean full deflection. */
      host.stickOrigin.x = pad.left + pad.width / 2;
      host.stickOrigin.y = pad.top + pad.height / 2;
      host.stickEl.classList.add('is-live');
      /* And the knob answers on the first frame rather than waiting for a
       * move, so a tap-and-hold at the edge walks her at once. */
      const dx = Math.max(-48, Math.min(48, e.clientX - host.stickOrigin.x));
      const dy = Math.max(-48, Math.min(48, e.clientY - host.stickOrigin.y));
      host.stickX = stickCurve(dx / 48);
      host.stickY = stickCurve(-dy / 48);
      host.routeStick();
      host.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (host.lookPointer === null) {
      host.lookPointer = e.pointerId;
      /* The stroke starts here. Whether it turns out to be a look or a
       * flick is decided on RELEASE — see the note there. */
      host.stroke.x = e.clientX;
      host.stroke.y = e.clientY;
      host.stroke.lastX = e.clientX;
      host.stroke.lastY = e.clientY;
      host.stroke.at = performance.now();
      host.stroke.travel = 0;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (host.designer?.isOpen) { host.designer.handlePointerMove(e); return; }
    if (e.pointerId === host.stickPointer) {
      const dx = Math.max(-48, Math.min(48, e.clientX - host.stickOrigin.x));
      const dy = Math.max(-48, Math.min(48, e.clientY - host.stickOrigin.y));
      host.stickX = stickCurve(dx / 48);
      host.stickY = stickCurve(-dy / 48);
      host.routeStick();
      host.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (e.pointerId === host.lookPointer) {
      /* Path length, not displacement: a drag that wandered out and back
       * has gone nowhere, and `readFlick` rejects it on the difference. */
      host.stroke.travel += Math.hypot(
        e.clientX - host.stroke.lastX, e.clientY - host.stroke.lastY,
      );
      host.stroke.lastX = e.clientX;
      host.stroke.lastY = e.clientY;
      if (host.firstPerson) {
        /* Her own eyes: the drag turns HER, and the glance IS the
         * aim — one number, so view and dig can never disagree about
         * which way she is pointed. */
        /* The rig is turned and nothing else: `simulate` reads the step
         * off it and applies it about her own up, so a look-drag on a
         * ceiling turns her along the ceiling. Writing `facing` here as
         * well would fight that for a frame. */
        host.bore.turn(-e.movementX * 0.004);
        /*
         * PITCH IS A LOOK, and a look comes home. It used to write
         * `aimPitch` directly, which is the shovel's angle and has no
         * neutral to return to — so first person opened at whatever the
         * last drag left, in either view, instead of along her nose.
         * While DIGGING the pan is held rather than decayed, so this is
         * still exactly the aim when it needs to be.
         */
        host.lookPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
          host.lookPitch - e.movementY * 0.004));
        host.lookIdle = 0;
      } else {
        // Third person: the drag pans the view — above ground a full
        // orbit, underground a tight override the trail cam resumes from
        // the moment the finger lifts.
        /* Over her shoulder the vertical drag AIMS HER, and the camera
         * elevation follows that aim, so what you are looking along is
         * always the line she will cut. */
        /* An OFFSET off her tail, bounded to half a turn either way — it
         * decays back to zero, which is how the view swings home. */
        /*
         * BOTH AXES ARE A PAN NOW. The vertical drag used to aim the
         * SHOVEL and let the camera's elevation follow it, which is why
         * the third-person view could be left tilted with no way back:
         * an aim has no neutral. A pan does, and reaches it three
         * seconds after the finger lifts.
         */
        host.lookYaw = Math.max(-Math.PI, Math.min(Math.PI,
          host.lookYaw - e.movementX * 0.005));
        host.lookPitch = Math.min(AIM_LIMIT, Math.max(-AIM_LIMIT,
          host.lookPitch - e.movementY * 0.004));
        host.lookIdle = 0;
      }
    }
  });
  /*
   * LETTING GO HAS TO BE UNCONDITIONAL.
   *
   * The stick latched: a pointerup that never arrives — a finger leaving
   * the glass, a capture stolen, the tab going away mid-drag — left
   * `input.walk` exactly as it was, so she carried on walking, and if the
   * thumb happened to be below centre she carried on walking BACKWARDS
   * with nothing on screen to say why. Reported, twice.
   *
   * So there is one place that drops the stick, it clears the inputs
   * whether or not the id matches, and everything that could possibly
   * mean "the finger is gone" calls it.
   */
  const dropStick = (): void => {
    host.stickPointer = null;
    host.stickX = 0;
    host.stickY = 0;
    /*
     * THE POSE IS NOT DROPPED WITH THE FINGER — deliberately, and it is
     * the one place this differs from every other control on the rail.
     * You set an attitude in order to WALK with it (that is the whole
     * point of it on a crease), so `posture.command` is not called here:
     * the last deflection stands until the stick moves again, the control
     * is disarmed and re-armed, or it is centred by a long press.
     */
    host.input.walk = 0;
    host.input.yaw = 0;
    /* `strafe` stays nought: nothing writes it any more except the dodge
     * mixer in `moveSurface`, which owns its own lifetime. */
    host.input.strafe = 0;
    host.stickKnob.style.transform = 'translate(0px, 0px)';
    /* Home is a CSS position, and the inline `left`/`top` written while
     * the thumb was down would win over it — so they are cleared, not
     * overwritten with numbers this method would have to compute. */
    /* `is-home` is permanent now — nothing ever writes an inline position,
     * so there is nothing to clear. Only the lit state comes off. */
    host.stickEl.classList.remove('is-live');
  };
  /*
   * AND LETTING GO OF THE LOOK HAS TO BE UNCONDITIONAL TOO — the half of
   * `dropStick`'s own lesson that was never applied to the camera.
   *
   * Reported: "after digging down and working my way back up, the camera
   * ended up locking up and I was no longer able to pan or pitch in 1st or
   * 3rd person view." Reproduced exactly, and it is not about digging at
   * all — digging is simply where a phone is most likely to interrupt a
   * touch.
   *
   * `lookPointer` is the id of the finger currently driving the camera, and
   * a new stroke is only accepted when it is null. It was cleared in ONE
   * place: a `pointerup` whose id matched. Every other way a finger can
   * stop existing — a `pointercancel` when the browser takes the gesture
   * over, a palm, a notification, the tab going away — left it set to an id
   * that will never be seen again, and from that moment the camera could
   * not be moved for the rest of the session. The stick was fixed for this
   * exact failure, twice; the look sat next to it and was not.
   *
   * So it gets its own unconditional drop, and everything that could mean
   * "the finger is gone" calls both.
   */
  const dropLook = (): void => {
    host.lookPointer = null;
    host.stroke.travel = 0;
  };
  /*
   * THE DOUBLE-TAP, read the same way the flick is: on release, off the
   * stroke's own record, so a pan can never be mistaken for one. A tap is
   * a stroke that went nowhere and lasted no time; two of them close
   * together in time and place are handed to the scene, which decides
   * whether they landed ON the queen. Nothing here knows what a queen is.
   */
  let tapAt = 0;
  let tapX = 0;
  let tapY = 0;
  const release = (e: PointerEvent) => {
    if (host.designer?.isOpen) { host.designer.handlePointerUp(e); return; }
    if (e.pointerId === host.stickPointer) dropStick();
    if (e.pointerId === host.lookPointer) {
      /* Read before `dropLook` wipes the stroke. */
      const wasTap = host.stroke.travel < TAP_TRAVEL_PX
        && performance.now() - host.stroke.at < TAP_MS;
      if (wasTap) {
        const now = performance.now();
        if (now - tapAt < DOUBLE_TAP_MS
          && Math.hypot(e.clientX - tapX, e.clientY - tapY) < DOUBLE_TAP_PX) {
          tapAt = 0;
          host.queenDoubleTap(e.clientX, e.clientY);
        } else {
          tapAt = now;
          tapX = e.clientX;
          tapY = e.clientY;
        }
      }
      dropLook();
      /*
       * A FLICK IS READ ON RELEASE, NEVER DURING THE DRAG.
       *
       * Halfway through a fast pan the numbers look exactly like a flick
       * — short, quick, far enough — so classifying as it happens would
       * fire a dodge every time you whipped the camera round. Waiting for
       * the finger costs nothing a player can feel and makes an ordinary
       * look impossible to misread.
       *
       * NOT IN FIRST PERSON, AND NOT WITH DIG ARMED. In her own eyes the
       * drag turns HER and aims the jaws, and lining a bite up is a lot
       * of quick short strokes — every one of which is a flick by these
       * numbers. Rather than special-case the thresholds and make digging
       * worse to make dodging possible, the gesture simply belongs to
       * third person. DIG forces first person anyway, so one test covers
       * both.
       */
      if (!host.firstPerson && !host.digMode) {
        const dir = readFlick({
          dx: host.stroke.lastX - host.stroke.x,
          dy: host.stroke.lastY - host.stroke.y,
          travelPx: host.stroke.travel,
          ms: performance.now() - host.stroke.at,
        });
        /*
     * A DODGE IS PAID FOR BEFORE IT HAPPENS. `spend` refuses rather than
     * going into credit, and `start` refuses while one is already in
     * flight — so the stamina only leaves when the burst actually does.
     */
    if (dir && host.vitals.stamina >= host.vitals.dodgeCost
      && host.dodge.start(dir, MM)) host.vitals.spend(host.vitals.dodgeCost);
      }
      // Finger off: the eye starts sliding back to the tube's own line.
      }
  };
  /* The belt and braces: a pointer that vanishes without a pointerup, a
   * window that loses focus, a tab that goes to the background. */
  window.addEventListener('pointercancel', () => { dropStick(); dropLook(); });
  window.addEventListener('blur', () => {
    dropStick();
    dropLook();
    host.input.dig = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { dropStick(); dropLook(); host.input.dig = false; }
  });
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  /* AND CAPTURE BEING TAKEN AWAY, which is the third way a finger stops
   * existing and the one that fires no up and no cancel. SCOOP already
   * guards it — see `stopDig` above — and the camera has more to lose:
   * a held button that misses its release stops one action, a look that
   * misses its release stops the camera for the rest of the session. */
  canvas.addEventListener('lostpointercapture', release);
  window.addEventListener('pointerup', release);
}

export function updateStatus(host: HudHost, ): void {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const elevM = host.heights
    ? (host.groundHeightAt(host.at.x, host.at.z) * MM).toFixed(0)
    : '…';
  host.statsPanel.setHTML(`
    <b>kauai island</b> · 56 m square · 1:1000 · all 64 sections resident<br>
    terrain ${host.terrainVerts.toLocaleString()} v / ${host.terrainTris.toLocaleString()} t
    · elevation ${elevM} m<br>
    aim ${((host.aimPitch * 180) / Math.PI).toFixed(0)}° ·
    bore \u2300${(host.boreRadius() * 2 * MM).toFixed(1)} x ${(host.boreLength() * MM).toFixed(0)} mm<br>
    soil window ${WINDOW_MM} mm · ${(WINDOW_BYTES / 1048576).toFixed(1)} MB ·
    chunks ${host.chunkMeshes.size} · queued ${host.queue.length} ·
    dug ${host.stream?.editedSamples ?? 0}<br>
    ${host.stands.size ? `forest ${[...host.stands.values()]
      .map((m) => m.count).reduce((a, b) => a + b, 0).toLocaleString()} plants ·
      ${host.stands.size} draws<br>` : ''}
    ${host.tree ? `tree ${host.tree.bark} · ${host.tree.triangles.map((t) => t.toLocaleString()).join(' / ')} t · lod ${host.treeLevel()}<br>` : ''}
    band floor ${host.stream?.bandFloorMm ?? 0} m · scrolls ${host.stats.scrolls}
    (${host.stats.rebases} rebases) · last ${host.stats.lastScrollMs.toFixed(0)} ms<br>
    at (${(host.at.x * MM / 1000).toFixed(1)}, ${(host.at.z * MM / 1000).toFixed(1)}) m ·
    ${memory ? `heap ${(memory.usedJSHeapSize / 1048576).toFixed(0)} MB · ` : ''}fps ${host.stats.fps}
    @ ${host.pixelRatioNow.toFixed(2)}x<br>
    ${(() => {
    /*
     * WHAT THE DEVICE ACTUALLY GIVES US, which nothing on screen used to
     * say. The render scale alone is half an answer: "2.00x" is native on
     * a laptop and 44% of the pixels on the phone this game is played on.
     * CSS size, DPR, and the real backing store make the difference
     * legible — and make it obvious the moment the adaptive scaler has
     * quietly given resolution away to hold the frame rate.
     */
    const c = host.renderer.domElement;
    const dpr = window.devicePixelRatio;
    const cssW = Math.round(c.clientWidth);
    const cssH = Math.round(c.clientHeight);
    const native = `${Math.round(cssW * dpr)}x${Math.round(cssH * dpr)}`;
    const buf = `${c.width}x${c.height}`;
    const share = (c.width * c.height) / (cssW * dpr * cssH * dpr);
    return `css ${cssW}x${cssH} · dpr ${dpr} · buffer ${buf}`
      + ` of ${native} (${(share * 100).toFixed(0)}%)`;
  })()}
  `);
}


