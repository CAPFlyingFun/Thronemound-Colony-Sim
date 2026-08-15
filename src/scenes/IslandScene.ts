/**
 * KAUAI FOR ANTS — `?scene=island`. Beyond Extinction's island, 1:1000,
 * now wearing BE's real biome textures and carrying the DIGGABLE SOIL
 * WINDOW with a pre-authored nest under the summit spawn.
 *
 * The island itself stays the anti-hole design the last round proved: all
 * 64 sections built once from the baked grid, never hidden, faded or
 * swapped; normals from central differences (no section seams); the walker
 * grounded on the DRAWN triangles (BE's own rule). On top of that, three
 * additions this round:
 *
 *  TEXTURES — BE's seven-band biome shader, ported verbatim in
 *  islandBiome.ts. The same material paints the soil chunks: tunnel walls
 *  are steep so the slope term dresses them as cliff rock for free, and
 *  their tops share the island's elevation bands, so the fine window is
 *  not a visible patch.
 *
 *  THE SOIL WINDOW — IslandStream: the streamed-world architecture with a
 *  floating 256 mm depth band riding under the local surface. Inside the
 *  window's rectangle the island sheet discards (the world room's hand-off)
 *  and the density mesh is the only ground — so the nest's entrance and any
 *  bite are simply visible. The clip NEVER outruns the meshes: it shrinks
 *  to retained soil on every scroll and only widens back when the rebuild
 *  queue drains. Nothing can hole.
 *
 *  THE PRE-TUNNEL — islandSoil folds a gate/hall/bend/store nest into the
 *  soil function at the spawn, mound stamped into the island grid so the
 *  anthill shows from afar, vent bored through it so the entrance is a real
 *  hole underfoot. Streaming away and back rebuilds it from zero saved
 *  samples, exactly as the world room proved.
 */

import * as THREE from 'three';

import './DensityTerrainLabScene.css';
import { buildSurfaceNets } from '../density/SurfaceNets';
import { QueenModel } from '../anim/QueenModel';
import {
  FOOT_CLEARANCE_MM, LegDrive, type DriveReport, type Ground, type LegSetup,
} from '../anim/legDrive';
import { CASTE_LENGTH_MM, VOXEL_MM, stanceRadius } from '../anim/hexapod';
import { TELEMETRY_MAX_SECONDS, TelemetryRecorder } from './IslandTelemetry';
import { buildNestView, type NestView } from '../nest/nestView';
import { NestDesigner } from '../nest/NestDesigner';
import { planBounds } from '../nest/nestCarve';
import { addNode } from '../nest/nestEdit';
import { type NestPlan } from '../nest/nestPlan';
import { chamberBox, chamberNorm, type ChamberBox } from './ChamberMovement';
import { BoreRig, YAW_RATE } from './BoreControl';
import { Dodge, readFlick, readNudge } from './dodge';
import {
  CLEARANCE_MM, GASTER_RIDE_MM, posture, PROBES, Spine,
  type SpinePose, type SpineReading,
} from '../anim/spine';
import { BodyPosture } from './bodyPosture';
import { DebugStatsPanel } from './DebugStatsPanel';
import { type Curtain, LoadingOverlay } from './LoadingOverlay';
import {
  fromBase64, ISLAND_SAVE_KEY, ISLAND_SAVE_V, parseIslandSave, toBase64,
  type IslandSave,
} from './islandSave';

/**
 * How the island was started, when it was not started on its own.
 *
 * Booting BEHIND the main menu is the case this exists for: the menu is
 * already covering the screen, so the island wants no curtain of its own and
 * something has to be told when she is finally standing.
 */
export interface IslandBoot {
  /** Something already opaque, or nothing and it draws its own. */
  curtain?: Curtain;
  /** Called once the queen has settled and the island is playable. */
  onReady?: () => void;
  /**
   * What the MENU plate does. Whoever OWNS the page decides — the island
   * knows it was asked, not what asking should cost. Left out, the plate
   * falls back to reloading to the front door, which is what `?scene=island`
   * wants: that route has no menu behind it to return to.
   */
  onMenu?: () => void;
}
import {
  pickMode, rankOf, type HudMode, type HudPart,
} from './hudModes';
import { SENSE_EASE, makeSensed, type SenseUniforms } from './undergroundSense';
import { IslandStream, type IslandScrollReport } from '../world/IslandStream';
import { SurfaceWalker } from '../world/surfaceWalk';
import {
  BARKS, PBR_BARKS, TILING_BARKS, bakeTree, buildTree, sidesAt, trunkProfile,
  type BuiltTree, type TreeSpec,
  type TrunkProfile,
} from '../world/tree';
import {
  burialMm, plantsIn, solidStand, SPECIES, type ForestSolid, type Species,
} from '../world/forest';
import { makeIslandSoil, type IslandSoil } from '../world/islandSoil';
import {
  loadBiomeTextures, makeBiomeMaterial, type BiomeTextureSet,
} from '../world/islandBiome';
import {
  CAP_PLANES, CELLS_Y, CELL_SIZE, MM, SAMPLES_Y, TILE_CELLS, WINDOW_CELLS,
  WINDOW_MM, WINDOW_BYTES,
} from '../world/worldScape';
import { guardContext } from '../render/contextGuard';
import { markLoaded } from '../pwa';
import {
  SPAN_MM, N, STEP_MM, MESH_N,
  SECTIONS, SEC_VERTS, WALK_SPEED, SPRINT,
  CRAWL, PACE_NAMES, SUPPORT_SHARE, LEAN_PER_ACCEL,
  LEAN_AT_SPRINT, LEAN_MAX, LEAN_RATE, LEAN_SPEED_RATE,
  BANK_PER_TURN, BANK_MAX, TURN_RATE, FOOT_AIR,
  stickCurve, RIDE, S_PERP, S_RAD,
  S_CENTER, S_BITE_JAW, S_DBG_CENTRE, S_DBG_DIR,
  S_DBG_END, S_DBG_JAW, S_DBG_HEAD, S_DBG_UP,
  S_DBG_RIGHT, S_DBG_REL, AIM_DBG_LAG, S_LENS_FWD,
  S_LENS_UP, S_LENS_RIGHT, S_LENS_CORNER, S_LENS_STEP,
  S_LENS_OUT, HEAD_PROBE_AT, HEAD_PROBE_DIR, HEAD_PROBE_RIGHT,
  BONE_FWD, S_ROLL, S_TARGET, S_SPOT,
  S_LEAN, S_SUPPORT, TAIL_HOLD_RAD, FPV_LIFT_RAD,
  FPV_LIFT_SOFT_MM, FPV_LIFT_HARD_MM, FPV_LIFT_RATE, S_NOSE,
  FAN_SWING, FAN_RISE, CHASE_MIN, SOIL_DARK,
  TREE_GIRTH_MM, TREE_HEIGHT_MM, TREE_FROM_HER_MM, TREE_BURIED_MM,
  SCRUB_WINDOW_MM, SCRUB_REGROW_MM, STAND_REACH_MM, S_FWD,
  S_UP, S_RIGHT, S_MAT, S_QLEAN,
  S_LEAN_AXIS, S_BANK_AXIS, S_BANK, UNDER_MM,
  ENCLOSED_MM, CH, CHUNKS_XZ, CHUNKS_Y,
  MESH_BUDGET, LEAD_S, LEAD_MAX, SCROLL_COOLDOWN_MS,
  SCOOP_WIDE_MM, SCOOP_TALL_MM, SCOOP_DEEP_MM, SMOOTH_STRENGTH,
  SMOOTH_PASSES, SMOOTH_RADIUS_MM, SMOOTH_MAX_SHIFT, SMOOTH_GROW,
  EYE_SKIN, BONE_CLEARANCE, CAMERA_SKIN, EYE_FORWARD,
  EYE_RISE, EYE_FOLLOW_MS, EYE_AIM_MS, EYE_FOLLOW_RATE, S_JAW,
  PROP_FLOOR_REACH, PROP_FLOOR_STEPS, PROP_FLOOR_BISECT,
  EYE_ROLL_RATE, EYE_SNAP, EYE_BISECTIONS, EYE_MARCH_STEPS,
  LOOK_HOLD_S, LOOK_RETURN_RATE, CHASE_PITCH, CHASE_PITCH_MIN,
  CHASE_PITCH_MAX, CHASE_GROUND_CLEAR, CHASE_REACH, SHELL_REACH,
  SHELL_SHARE, RISE_RATE, NOSE_REACH, BORE_HUG_WIDE,
  BODY_FIT_SCALE, QUEST_DEPTH_MM, QUEST_CHAMBER_SAMPLES, JAW_PAST_NOSE,
  BODY_HALF_TALL, BODY_FLOOR_MARGIN, AIM_LIMIT, CHAMBER_CAM_FAR,
  CHAMBER_CAM_NEAR, COLONIST_SPEED, COLONIST_TURN, COLONIST_ARRIVE,
  COLONIST_ROAM, TROPHALLAXIS_REACH, TROPHALLAXIS_RATE, CARRY_DELIVER_REACH,
  FIGHT_NOTICE,
} from './islandTuning';
import { Colonist } from './Colonist';
import { SoilQuery } from './soilQuery';
import {
  aimCamera, clampedHeadPitch, lensClearance, settleHeadPitch,
  type CameraHost,
} from './islandCamera';
import { buildControls, updateStatus, type HudHost } from './islandHud';
import {
  depthMm, questTick, type QuestHost, type VitalBar, type VitalKind,
} from './islandQuest';
import { Vitals } from './islandVitals';
import { FIRE_ANT, type AbilityId, type AntKind } from './antKinds';
import { Combat, necrosis } from './islandCombat';
import { Beetle } from './Beetle';
import {
  buildQuarryBars, syncQuarryBars, type QuarryBarHost, type QuarryBars,
} from './islandQuarryBar';
import { Carry, emptyStores, withinNest } from './islandCarry';
import { PROP_SCATTER, PROP_SPECS, Prop } from './islandProps';
import {
  bite, biteCentre, biteRay, boreAim, updateAimDebug, type DigHost,
} from './islandDig';
import {
  readSpine, refreshAim, simulate, type BodyHost,
} from './islandBody';
import {
  boreFrame, buildIsland, footingFrom, groundHeightAt, growForest,
  regrowScrub, type LandHost,
} from './islandLand';

/**
 * WHAT THE THUMB IS DOING, which is also what the rail should be showing.
 *
 * Three, and they are mutually exclusive because the STICK is: walking her,
 * driving the shovel, or setting her body. Everything on the rail belongs to
 * one or more of them — see `applyHudMode`.
 */
/* Re-exported so the scene stays the one import a probe needs. The table
 * itself lives in `hudModes.ts`, which knows nothing about the DOM. */
export type { HudMode } from './hudModes';

export class IslandScene {
  /** Every 'is there soil here' in one place. See `soilQuery.ts`. */
  private readonly ground = new SoilQuery();

  /* ------------------------------------------------- the soil, asked once */

  /* Thin delegates onto `SoilQuery`. Kept as methods rather than replaced at
   * the call sites because there are hundreds of those, and a rename touching
   * all of them would bury the one change that matters in the diff. */
  private renderedOn(data: Int16Array, xMm: number, zMm: number): number {
    return this.ground.renderedOn(data, xMm, zMm);
  }

  private sampleOf(data: Int16Array, col: number, row: number): number {
    return this.ground.sampleOf(data, col, row);
  }

  private sample(col: number, row: number): number {
    return this.ground.sample(col, row);
  }

  private renderedGroundAt(x: number, z: number): number {
    return this.ground.renderedGroundAt(x, z);
  }

  private walkGroundAt(x: number, z: number): number {
    return this.ground.walkGroundAt(x, z);
  }

  private floorBelow(x: number, z: number, fromY: number): number | null {
    return this.ground.floorBelow(x, z, fromY);
  }

  private groundDensityAt(x: number, y: number, z: number): number {
    return this.ground.groundDensityAt(x, y, z);
  }

  private groundSolidAt(x: number, y: number, z: number): boolean {
    return this.ground.groundSolidAt(x, y, z);
  }

  private soilDensityAt(x: number, y: number, z: number): number {
    return this.ground.densityAt(x, y, z);
  }

  /**
   * THE FIRST SOIL UNDER A POINT — what a loose thing rests on.
   *
   * Implements `PropGround`. It asks the SOIL rather than the surface
   * heightfield, which is the whole point: `walkGroundAt` reports the
   * ORIGINAL terrain and has no idea anything has been dug, so a prop
   * pinned to it is pinned to a floor that may no longer exist. Reported
   * twice, the second time as "after I released the twig 11mm underground,
   * it still popped up at the surface".
   *
   * MARCHED DOWN, then bisected — the same shape as the camera's retreat,
   * for the same reason. A coarse step alone would let a prop rest a
   * visible fraction of a step above a chamber floor, and a fine march
   * everywhere would be a field read per centimetre for every prop on the
   * island. Eight strides find the boundary; six halvings put it within a
   * tenth of a millimetre.
   *
   * If it is already INSIDE soil — dropped into a wall — the search starts
   * from where it is and finds nothing below, so it is left where it is
   * rather than fired to the centre of the earth. A prop in a wall is a
   * cosmetic problem; a prop at y = -infinity is a lost object.
   */
  floorUnder(x: number, y: number, z: number): number {
    if (this.soilSolidAt(x, y, z)) return y;
    let lo = y;
    let hi = y;
    for (let i = 1; i <= PROP_FLOOR_STEPS; i += 1) {
      const probe = y - (PROP_FLOOR_REACH * i) / PROP_FLOOR_STEPS;
      if (this.soilSolidAt(x, probe, z)) { lo = probe; hi = probe + PROP_FLOOR_REACH / PROP_FLOOR_STEPS; break; }
      lo = probe;
    }
    /* Nothing solid within reach — it is over a void, so let it keep
     * falling and ask again next frame rather than inventing a floor. */
    if (!this.soilSolidAt(x, lo, z)) return -Infinity;
    for (let i = 0; i < PROP_FLOOR_BISECT; i += 1) {
      const mid = (lo + hi) / 2;
      if (this.soilSolidAt(x, mid, z)) lo = mid; else hi = mid;
    }
    return hi;
  }

  private soilSolidAt(x: number, y: number, z: number): boolean {
    return this.ground.solidAt(x, y, z);
  }

  ready = false;

  private readonly host: HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;

  private readonly scene = new THREE.Scene();

  private readonly camera: THREE.PerspectiveCamera;

  private readonly queen = new QueenModel('queen');

  /** Stamped grid (mound included) — what the island mesh and walker use. */
  private heights: Int16Array | null = null;

  /** Pristine grid — what the soil function calls "the natural surface". */
  private heightsBase: Int16Array | null = null;

  private soil: IslandSoil | null = null;

  private stream: IslandStream | null = null;

  private nestView: NestView | null = null;

  private textures: BiomeTextureSet | null = null;

  private islandMaterial: THREE.MeshStandardMaterial | null = null;

  private soilMaterial: THREE.MeshStandardMaterial | null = null;

  /**
   * THE UNDERGROUND SENSE, the density lab's answer to a problem this room
   * had too: inside the soil every wall is the same brown, a tunnel is a
   * featureless void, and a camera that dips below the surface shows empty
   * space rather than dirt. Underground the terrain stops being lit and
   * becomes SENSED — near surfaces keep their shading, everything further
   * reads as contours on darkness, past her reach is unknown. A bubble
   * around her rather than an x-ray, so where the nest goes next is still
   * a decision and not a readout.
   */
  private sense: SenseUniforms | null = null;

  /** The fine window's rectangle, in world units. Island fragments inside die. */
  private readonly clip = { value: new THREE.Vector4(0, 0, 0, 0) };

  /** The top of the streamed soil's depth band, in world units — see
   *  `refreshBandTop`. Out of reach until the stream exists, so until then
   *  the island cuts out as before and no soil is thrown away. */
  private readonly bandTop = { value: 1e9 };

  /** The sky's own colour, kept so the underground blend has something to
   *  come back to. */
  private readonly skyColour = new THREE.Color(0x9cc4e0);

  private tree: BuiltTree | null = null;

  /** One instanced mesh per species — a whole tier in a single draw call. */
  private readonly stands = new Map<string, THREE.InstancedMesh>();

  /**
   * The unit-height trunk line each tier was baked from.
   *
   * The collision reads THIS rather than approximating it. A straight cone
   * from base radius to a fraction of it — which is what stood in for a
   * trunk before — measured up to 33 per cent fatter than the drawn wood at
   * mid-height and modelled none of the lean, so she stood on the invisible
   * one and floated over the visible one.
   */
  private readonly standProfiles = new Map<string, TrunkProfile>();

  /** Where she was when the small tiers were last grown. */
  private readonly scrubAt = new THREE.Vector3(Infinity, 0, Infinity);

  private forestMaterial: THREE.MeshStandardMaterial | null = null;

  /** The stand near enough to walk into, rebuilt with the scrub. */
  private stand: ForestSolid | null = null;

  private readonly chunkMeshes = new Map<string, THREE.Mesh>();

  private readonly queue: { cx: number; cy: number; cz: number }[] = [];

  private readonly queued = new Set<string>();

  private clipPending = false;

  /** Every chunk that has been MESHED since the last invalidation — the
   *  empties included. Two jobs: scrolls skip re-meshing chunks that built
   *  to nothing (most of the column is air or solid interior, and requeueing
   *  them every scroll was the bulk of the phone's backlog), and the clip's
   *  no-holes invariant is checked against THIS set, not the mesh map. */
  private readonly builtChunks = new Set<string>();

  /** The window-local cell rect (chunk-aligned) proven covered by built
   *  chunks. The clip may only ever expose THIS; it grows to the full
   *  window in reveal() and shrinks by intersection on every scroll. */
  private readonly meshedRect = { x0: 0, z0: 0, x1: 0, z1: 0 };

  private meshBudgetCapForTest = Infinity;

  private terrainVerts = 0;

  private terrainTris = 0;

  private readonly at = new THREE.Vector3();

  private facing = Math.PI;

  private readonly velocity = new THREE.Vector3();

  readonly input = {
    walk: 0, yaw: 0, strafe: 0, dig: false, sprint: false, crawl: false,
  };

  /**
   * What the pace latch multiplies her walk by: crawl, walk or run.
   *
   * `applyPace` writes both flags from ONE index, so they cannot disagree —
   * but the order here is still a run first, because `input` is public and
   * a probe or a script setting the flags by hand should get the same
   * answer the chip would have given it.
   */
  /**
   * A LINE THAT SAYS WHAT JUST HAPPENED, and then goes.
   *
   * The first use of one of the frames off the second art sheet: nine-
   * sliced with `border-image`, so the carved ends keep their shape while
   * the middle stretches to whatever the words need. Stretching the whole
   * picture — the obvious thing — squashes those ends into smears, which
   * is exactly the trap the frames were flagged for.
   */
  private toastCombat(text: string): void {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'tm-toast';
      this.hud.appendChild(this.toastEl);
    }
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-live');
    window.clearTimeout(this.toastUntil);
    this.toastUntil = window.setTimeout(() => {
      this.toastEl?.classList.remove('is-live');
    }, 2200);
  }

  /**
   * SOMETHING TO FIGHT.
   *
   * One beetle, a walk from where she starts, on the same side as the
   * landmark tree so the first thing a player does — head for the tree —
   * takes them past it. Not hidden and not on top of her: a first
   * encounter should be a thing you choose to have.
   *
   * It is a placeholder in the sense that a real bestiary will not be a
   * `for` loop over one number, and it is NOT a placeholder in the sense
   * that it has hit points, fights back, and can kill her.
   */
  private spawnQuarry(): void {
    if (this.quarry.length > 0) return;
    const away = 34 / MM;
    const x = this.at.x + away;
    const z = this.at.z + away * 0.4;
    const beetle = new Beetle('beetle', x, this.walkGroundAt(x, z), z);
    this.scene.add(beetle.root);
    this.quarry.push(beetle);
    this.spawnProps();
  }

  /**
   * THE LOOSE THINGS, scattered where walking finds them.
   *
   * Seeded off her founding spot rather than at fixed world coordinates,
   * because where she starts is where the island decided to put her and a
   * hardcoded pebble would end up inside a tree.
   */
  private spawnProps(): void {
    if (this.props.length > 0) return;
    for (const { key, dxMm, dzMm } of PROP_SCATTER) {
      const spec = PROP_SPECS[key];
      if (!spec) continue;
      const px = this.at.x + dxMm / MM;
      const pz = this.at.z + dzMm / MM;
      const prop = new Prop(key, spec, px, this.walkGroundAt(px, pz), pz);
      prop.tick(this);
      this.scene.add(prop.root);
      this.props.push(prop);
    }
  }

  /**
   * A PLATE WAS PRESSED. One door in, so a species that gains an ability
   * gains its button and its behaviour in the same place — see
   * `antKinds.ts`.
   */
  private useAbility(id: AbilityId): void {
    if (id === 'bite') {
      /* One button for both halves: BITE takes hold, and BITE lets go.
       * A separate release button is a second thing to find mid-fight, and
       * the grip is already the thing the plate is lit for. */
      if (this.combat.phase !== 'free') { this.combat.release(); return; }
      const target = this.quarryInReach();
      if (!target) { this.toastCombat('NOTHING IN REACH'); return; }
      if (!this.combat.grip(target, (c) => this.vitals.spend(c))) {
        this.toastCombat('TOO TIRED TO HOLD ON');
        return;
      }
      this.toastCombat('GRIPPED');
    } else if (id === 'sting') {
      /* The animal's own rule, not a balance one: the sting needs the
       * mandibles anchored before the gaster can reach round. */
      if (this.combat.phase === 'free') { this.toastCombat('BITE FIRST'); return; }
      if (!this.combat.sting()) this.toastCombat('OUT OF VENOM');
    } else if (id === 'carry') {
      /*
       * ONE PLATE, TWO HALVES — the same shape BITE already has, and it is
       * not a saving of space so much as an obligation: the rail fits four
       * action plates and `tests/antKinds.test.ts` pins that, so DROP
       * cannot have one of its own without pushing CLIMB off the ant. It
       * wears the DROP art while she is loaded, so the plate says which
       * half it is about to do.
       */
      if (this.carry.carrying) { this.carry.drop(); this.toastCombat('DROPPED'); }
      else {
        const item = this.cargoInReach();
        if (!item) { this.toastCombat('NOTHING TO CARRY'); return; }
        const no = this.carry.lift(item, (c) => this.vitals.spend(c));
        if (no === 'still-alive') this.toastCombat('KILL IT FIRST');
        else if (no === 'too-heavy') this.toastCombat('TOO HEAVY');
        else if (no === 'too-tired') this.toastCombat('TOO TIRED TO LIFT');
        else if (no === 'already-carrying') this.toastCombat('JAWS FULL');
        else this.toastCombat('CARRYING');
      }
    } else if (id === 'interact') {
      /*
       * THE SAME JAWS, A DIFFERENT SUBJECT. CARRY reaches for prey and
       * feeds the colony; INTERACT reaches for the loose things, which are
       * worth nothing to eat. They share one `Carry` because she has one
       * pair of mandibles and cannot hold a beetle and a pebble at once —
       * which is the physical truth rather than a restriction.
       */
      if (this.carry.carrying) { this.carry.drop(); this.toastCombat('PUT DOWN'); }
      else {
        const prop = this.propInReach();
        if (!prop) { this.toastCombat('NOTHING IN REACH'); return; }
        const no = this.carry.lift(prop, (c) => this.vitals.spend(c));
        /* The angle it was taken at, remembered in HER frame — so a twig
         * picked up sideways is carried sideways instead of swinging
         * through her as she turns. See `Prop.grip`. */
        if (!no) prop.takeGrip(this.queen.root.quaternion);
        if (no === 'too-heavy') this.toastCombat('TOO HEAVY TO SHIFT');
        else if (no === 'too-tired') this.toastCombat('TOO TIRED TO LIFT');
        else if (no) this.toastCombat('JAWS FULL');
        else this.toastCombat(this.carry.mode === 'drag' ? 'DRAGGING' : 'CARRYING');
      }
    }
    this.refreshCombatChips();
  }

  /** The two plates that change with the fight. */
  private refreshCombatChips(): void {
    const gripped = this.combat.phase !== 'free';
    /* BITE is the grip AND the release, so it stays lit while she holds
     * on — the same latch language DIG uses. */
    this.biteBtn?.classList.toggle('is-grip', gripped);
    /* STING is only a control while there is something to sting, and only
     * while she has venom for it. Dimmed rather than hidden: a button that
     * disappears mid-fight is a button the thumb misses. */
    this.stingBtn?.classList.toggle('is-spent', !gripped || this.combat.dry);
    /*
     * CARRY wears DROP's face while she is loaded. Swapping the art class
     * rather than the element keeps the plate in the same place under the
     * same thumb — a control that MOVES when its job changes is a control
     * the thumb has to go looking for mid-carry.
     */
    const loaded = this.carry.carrying;
    this.carryBtn?.classList.toggle('tm-art-carry', !loaded);
    this.carryBtn?.classList.toggle('tm-art-drop', loaded);
    this.carryBtn?.classList.toggle('is-grip', loaded);
    this.carryBtn?.setAttribute('aria-label', loaded ? 'Drop' : 'Carry');
    /* INTERACT lights while what she is holding is one of ITS things, so
     * the two plates never both claim the same load. */
    const holdingProp = this.props.some((p) => p === this.carry.held);
    this.interactBtn?.classList.toggle('is-grip', holdingProp);
  }

  /**
   * ONE FRAME OF THE FIGHT.
   *
   * The quarry pot ters whether or not she is interested; the venom in it
   * keeps working whether or not she is still holding it — which is the
   * whole point of a load — and the grip is dropped the moment it stops
   * being possible: out of reach, or the thing she is holding has died and
   * become cargo rather than a fight.
   */
  /**
   * BEING FED, which for a fire ant means being fed BY SOMEBODY.
   *
   * Almost everything an adult takes in arrives mouth to mouth from a
   * nestmate, and a founding queen takes nothing at all until her first
   * workers eclose — so the arrival of a worker is both the moment hunger
   * starts and the moment there is an answer to it. Stand near one and she
   * is topped up.
   *
   * Deliberately not a button. Trophallaxis is something ants do to each
   * other constantly and without deciding to, and a FEED key would be a
   * chore bolted onto a behaviour that is meant to be ambient.
   */
  private trophallaxisTick(dt: number): void {
    const fed = this.colony.some((c) => c.ready);
    /* The switch is one-way: once the colony exists she is on the colony's
     * economy, and losing every worker should be a crisis rather than a
     * return to living off her flight muscles. */
    if (fed) this.vitals.feeding = true;
    if (!this.vitals.feeding) return;
    for (const one of this.colony) {
      if (!one.ready) continue;
      const gap = Math.hypot(
        one.at.x - this.at.x, one.at.y - this.at.y, one.at.z - this.at.z,
      );
      if (gap > TROPHALLAXIS_REACH) continue;
      this.vitals.trophallaxis(TROPHALLAXIS_RATE * dt);
      break;
    }
  }

  private combatTick(dt: number): void {
    const held = this.combat.held;
    for (const q of this.quarry) {
      q.tick(dt, (x, z) => this.walkGroundAt(x, z), q === held);
      /* Necrosis runs on EVERYTHING, held or dropped or long since walked
       * away from. Solenopsins do not care whether she stayed to watch. */
      if (necrosis(q, dt)) this.toastCombat(`THE ${q.id.toUpperCase()} IS DOWN`);
    }
    this.combat.tick(
      dt,
      (cost) => this.vitals.spend(cost),
      (amount) => this.vitals.damage(amount),
      Math.random,
    );
    /* Reach is checked here rather than inside `Combat`, which has no
     * geometry and should not grow any. */
    const grip = this.combat.held;
    if (grip) {
      const gap = Math.hypot(
        grip.at.x - this.at.x, grip.at.y - this.at.y, grip.at.z - this.at.z,
      );
      if (gap > this.combat.reach + grip.radius) this.combat.release();
    }
    for (const e of this.combat.drain()) {
      if (e.kind === 'dry') this.toastCombat('OUT OF VENOM');
      else if (e.kind === 'shaken') this.toastCombat('SHAKEN OFF');
      /*
       * AND A KILL BY BITE SAYS SO.
       *
       * v0.1.46 gave the grip real damage and `Combat` has pushed `felled`
       * ever since — but nothing listened, because the only fell that
       * existed when this loop was written came from `necrosis`, which
       * toasts on its own a few lines up. So chewing something to death was
       * silent while poisoning it announced itself.
       */
      else if (e.kind === 'felled' && e.quarry) {
        this.toastCombat(`THE ${e.quarry.toUpperCase()} IS DOWN`);
      }
    }
    this.carryTick(dt);
    /* After the vitals have ticked, so the latch drops on the same frame she
     * bottoms out rather than one behind it. See `dropPaceIfSpent`. */
    this.dropPaceIfSpent();
    this.refreshCombatChips();
    /* THE DRESS FOLLOWS THE FACTS. A beetle closing, a load lifted, a seed
     * coming into reach — none of those are button presses, so the mode
     * cannot be recomputed only when something is pressed. It is guarded by
     * a signature check and writes nothing on a frame where nothing
     * changed. */
    this.applyHudMode();
  }

  /**
   * ONE FRAME OF THE TRIP HOME.
   *
   * Carrying is work, the load rides at her jaws, and arriving at the nest
   * hands it over. The order matters: the drain can FUMBLE the load, and a
   * beetle put down this frame must not also be delivered this frame.
   */
  private carryTick(dt: number): void {
    this.carry.tick(dt, (cost) => this.vitals.spend(cost));

    const load = this.carry.held;
    for (const q of this.quarry) q.carried = q === load;
    for (const p of this.props) {
      p.carried = p === load;
      /* Her rotation, so a carried thing keeps the grip it was taken with
       * instead of a fixed world angle — see `Prop.grip`. */
      p.tick(this, dt, this.queen.root.quaternion);
    }
    if (load) {
      /*
       * AT HER ACTUAL JAWS, off the rig — not at a point invented from her
       * root.
       *
       * Reported: "picking up stuff with the queen snaps to her in the
       * middle just under her body", and that is exactly what the old sum
       * did. `at` is her body CENTRE and `at.y` is its height, so a seed
       * rode 0.6 mm ahead of her middle at mid-body height, which is inside
       * her thorax rather than in her mouth.
       *
       * `jawPosition` is the same anchor the BITE already used, and it
       * already answers the worry raised here: "we didn't really create it
       * for the queen, but we still should even if the jaws doesn't have
       * the two jaw bones". It takes a real mandible tip where the rig has
       * one — the worker and the major both do — and the tip of the mouth
       * chain where it does not, which is the queen, whose auto-rig left
       * her mandibles out entirely.
       *
       * The old comment worried that reading the rig would inherit the leg
       * solve's twitch. It does, and that is now the right answer rather
       * than a cost: the load twitches WITH her head, so it reads as
       * attached. The camera needed filtering because a shaking lens is a
       * shaking picture; a seed that moves with the mouth holding it is
       * simply a seed being carried.
       *
       * The old sum stays as the fallback for the second before the model
       * has loaded, which is the only time it was ever right.
       */
      if (!(this.queenReady && this.queen.jawPosition(S_JAW))) {
        S_JAW.set(
          this.at.x + this.fwd.x * JAW_PAST_NOSE,
          this.at.y,
          this.at.z + this.fwd.z * JAW_PAST_NOSE,
        );
      }
      /* Component-wise, because `Portable.at` is a plain {x,y,z} — the
       * carry model deliberately owns no THREE types. */
      load.at.x = S_JAW.x;
      load.at.y = S_JAW.y;
      load.at.z = S_JAW.z;
    }

    /*
     * HOME, AND ONLY ONCE THERE IS ONE. Before the first worker there is
     * nobody to hand a beetle to and no larva to digest it, so delivery is
     * gated on the colony existing rather than on a radius alone. That is
     * not a stub: a claustral queen has no colony economy to feed.
     */
    if (!this.carry.carrying || this.colony.length === 0) return;
    /* A LEAF IS NOT FOOD. Only things worth something to the larvae are
     * handed over — otherwise walking home with a pebble would silently
     * eat it, and the player would learn not to carry anything indoors. */
    if ((this.carry.held?.proteinMg ?? 0) <= 0) return;
    if (!withinNest(this.at, this.workerAnchor, CARRY_DELIVER_REACH)) return;
    const gained = this.carry.deliver(this.stores);
    if (gained > 0) this.toastCombat(`FOOD +${Math.round(gained)}`);
  }

  /**
   * The nearest thing on the ground worth taking home.
   *
   * Separate from `quarryInReach` because they are different questions
   * asked at different moments: that one wants something to fight and
   * happily returns a live beetle, this one wants cargo. It still offers
   * live ones up, so `Carry.lift` can refuse them and the HUD can say KILL
   * IT FIRST — a reach test that silently skipped them would report
   * NOTHING TO CARRY while a beetle stood on her foot.
   */
  /**
   * The nearest loose thing. Like `cargoInReach` it offers up what she
   * cannot lift, so `Carry` can refuse it and the HUD can say TOO HEAVY TO
   * SHIFT — the stone exists precisely to be refused, and a reach test that
   * skipped it would report an empty patch of ground.
   */
  private propInReach(): Prop | null {
    let best: Prop | null = null;
    let bestGap = Infinity;
    for (const p of this.props) {
      if (this.carry.held === p) continue;
      const gap = Math.hypot(
        p.at.x - this.at.x, p.at.y - this.at.y, p.at.z - this.at.z,
      ) - p.radius;
      if (gap > this.carry.reach || gap >= bestGap) continue;
      best = p;
      bestGap = gap;
    }
    return best;
  }

  private cargoInReach(): Beetle | null {
    let best: Beetle | null = null;
    let bestGap = Infinity;
    for (const q of this.quarry) {
      if (this.carry.held === q) continue;
      const gap = Math.hypot(
        q.at.x - this.at.x, q.at.y - this.at.y, q.at.z - this.at.z,
      ) - q.radius;
      if (gap > this.carry.reach || gap >= bestGap) continue;
      best = q;
      bestGap = gap;
    }
    return best;
  }

  /**
   * The nearest thing within reach that is worth biting.
   *
   * Nearest rather than "the one she is looking at": her jaws are at her
   * head and her head is where she is pointed, so anything inside that
   * radius is in front of her by construction — and a cone test on a
   * control the player is stabbing at with a thumb turns a miss into a
   * mystery.
   */
  private quarryInReach(): Beetle | null {
    let best: Beetle | null = null;
    let bestGap = Infinity;
    for (const q of this.quarry) {
      const gap = Math.hypot(
        q.at.x - this.at.x, q.at.y - this.at.y, q.at.z - this.at.z,
      ) - q.radius;
      if (gap > this.combat.reach || gap >= bestGap) continue;
      best = q;
      bestGap = gap;
    }
    return best;
  }

  private paceMul(): number {
    /*
     * STAMINA IS A VETO, not a second latch. The button stays where the
     * player put it and she simply cannot deliver a run she has not got —
     * so a spent sprint drops to a walk and picks itself back up the moment
     * she has her second wind, without the chip flicking about under a
     * thumb that is not touching it.
     */
    /*
     * A LOAD TAKES THE RUN AND THEN SOME. The sprint is vetoed outright
     * while she is DRAGGING — there is no gait in which hauling something
     * along the ground is a sprint — and on top of that every pace is
     * scaled by `carryVerdict`'s taper, so a crumb costs her almost nothing
     * and a beetle costs her most of her stride. Continuous rather than a
     * step, because a load that only mattered at one threshold would be a
     * number on the HUD rather than something felt.
     */
    const laden = this.carry.speedFactor;
    if (this.sprinting) return SPRINT * laden;
    return (this.input.crawl ? CRAWL : 1) * laden;
  }

  /*
   * There is no TURN/STEER latch any more. It existed to choose which of
   * two things left-and-right meant; now the stick always turns and the
   * view always side-steps, so there is nothing left to choose.
   */

  /**
   * WHO THE STICK IS TALKING TO — locomotion, or her posture.
   *
   * There is one stick and now two things wanting it, and the alternative
   * considered was a second on-screen stick in the style of a game pad. It
   * was rejected on a hard constraint rather than on taste: the dig aim IS
   * the camera, the camera is the right half of the screen, and a phone has
   * two thumbs. A second stick would have to take the camera's half, and a
   * camera that cannot move is a shovel that cannot aim.
   *
   * So posture is MODAL: arm ↕ or 🚁 and the same stick means height or
   * attitude instead of walking, and walking is zeroed while it does — one
   * stick serving two masters at once is how you get a turn that quietly
   * crouches her.
   */
  /**
   * The pose chips' faces: which control has the stick, and what she is
   * currently holding.
   *
   * The readout appears only when she is off her neutral stance, because a
   * row of zeroes on the rail is four more characters of headroom spent
   * saying nothing — and because "there is a number on screen" is then
   * itself the answer to "why is she standing like that?", which is a
   * question this control is otherwise very good at causing.
   */
  /**
   * WHAT THE RAIL IS FOR, RIGHT NOW.
   *
   * The rail grew until it did not fit: eleven controls stacked up a
   * bottom-anchored column on a 430px-tall phone, and DIG climbed into the
   * MENU plate in the top-right corner. Reported exactly that way — "the
   * Menu and Dig are overlapping a little" — and dig mode, which is the only
   * time SCOOP and the two instruments are up, is worse still.
   *
   * The fix is not smaller buttons. It is that most of the rail is IRRELEVANT
   * at any given moment: BITE and CLIMB mean nothing with the shovel out, and
   * the whole action cluster means nothing while the stick is driving her
   * body rather than her legs. So every control declares which modes it
   * belongs to and one function hangs the right set.
   *
   * It buys legibility as well as room. The stick does three different jobs
   * depending on mode, and a rail that changes with it is the clearest
   * possible statement of which job is live.
   */
  /**
   * DRESS THE HUD FOR WHAT SHE IS DOING.
   *
   * Every visibility decision on the rail comes through here and every one
   * of them is read out of `HUD_LAYOUTS`. There is no second place that
   * hides a control: this is a loop over a table, which is what makes a
   * mode something you can read in one file instead of reconstructing from
   * a dozen call sites.
   *
   * `contextual` is the rank that does the interesting work. The table says
   * a mode ALLOWS a control; `contextLive` says whether it is true right
   * now — something in reach, something in her jaws. A part that is allowed
   * but not true is dimmed rather than removed, because a plate that blinks
   * in and out at the edge of a reach radius is worse than either state.
   */
  private applyHudMode(): void {
    const mode = pickMode({
      digging: this.digMode,
      posed: this.posture.armed,
      fighting: this.inAFight(),
      carrying: this.carry.carrying,
    });
    /*
     * WRITTEN ONLY WHEN IT CHANGES.
     *
     * This runs every frame now — the mode depends on live facts (a beetle
     * closing, a load lifted, something coming into reach) rather than on a
     * button press. Sixteen `style.display` assignments sixty times a
     * second is sixteen layout invalidations for a HUD that changes a
     * handful of times a minute, so the whole answer is reduced to one
     * short string and compared. The reads are cheap; the WRITES are what
     * had to be earned.
     */
    const sig = `${mode}|${this.contextLive('carry') ? 1 : 0}`
      + `${this.contextLive('interact') ? 1 : 0}`;
    if (sig === this.hudSig) return;
    this.hudSig = sig;
    this.hudMode = mode;
    for (const part of this.railParts) {
      const rank = rankOf(mode, part.part);
      part.el.style.display = rank === 'hidden' ? 'none' : '';
      /* Dimming is only ever about a contextual part being untrue. A
       * secondary control is quieter by SIZE, in the stylesheet, not by
       * opacity — see `.tm-cluster`. */
      part.el.classList.toggle(
        'is-idle', rank === 'contextual' && !this.contextLive(part.part),
      );
      part.el.classList.toggle('is-primary', rank === 'primary');
    }
    this.fanCluster();
  }

  /**
   * THE ARC — the reference draws the plates on a curve, not in a row.
   *
   * DIG sits in the corner a thumb rests on and the rest sweep away from it,
   * each one a little higher than the last. It reads as a fan under a hand
   * rather than a strip of buttons, and it is the arrangement the blueprint
   * shows.
   *
   * IT HAS TO BE COMPUTED, and that is the only reason this is script
   * rather than a stylesheet: the visual order is not the DOM order. The
   * cluster is `row-reverse` and three plates carry a CSS `order`, so
   * `nth-child` counts a sequence nobody sees. So the visible plates are
   * sorted the way the browser will lay them out — by `order`, then by
   * document position — and each is told its distance from the corner.
   *
   * Runs only inside `applyHudMode`, which is already behind a signature
   * check, so the sort happens on a mode change and not on a frame.
   */
  private fanCluster(): void {
    const cluster = this.hud.querySelector('.tm-cluster');
    if (!cluster) return;
    const up = [...cluster.children]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el, i) => ({
        el: el as HTMLElement,
        order: Number(getComputedStyle(el).order) || 0,
        i,
      }))
      .sort((a, b) => a.order - b.order || a.i - b.i);
    up.forEach((p, n) => p.el.style.setProperty('--tm-arc', String(n)));
  }

  /**
   * Is there a fight on?
   *
   * Generous on purpose, and wider than the jaws can reach: the HUD has to
   * put BITE up BEFORE she is close enough to use it, or the plate arrives
   * at the same moment the beetle does and the player is reading a new
   * control while being bitten. Living quarry only — a corpse is cargo, and
   * cargo is CARRY's business.
   */
  private inAFight(): boolean {
    for (const q of this.quarry) {
      if (!q.alive) continue;
      if (this.at.distanceTo(q.at) <= FIGHT_NOTICE) return true;
    }
    return false;
  }

  /** Whether a contextual control has anything to act on this instant. */
  private contextLive(part: HudPart): boolean {
    if (part === 'carry') return this.carry.carrying || this.cargoInReach() !== null;
    if (part === 'interact') {
      return this.props.some((p) => p === this.carry.held) || this.propInReach() !== null;
    }
    return true;
  }

  /** Register a rail control under its name in the mode table. */
  private railPart(el: HTMLElement, part: HudPart): void {
    this.railParts.push({ el, part });
  }

  private refreshPoseChips(): void {
    this.rideChip?.classList.toggle('is-grip', this.posture.mode === 'ride');
    this.tiltChip?.classList.toggle('is-grip', this.posture.mode === 'tilt');
    /* Arming or dropping a posture IS a mode change, so the rail follows it
     * on the same call that lights the plate. */
    this.applyHudMode();
    if (!this.poseReadout) return;
    const show = !this.posture.neutral || this.posture.armed;
    this.poseReadout.style.display = show ? '' : 'none';
    if (show) this.poseReadout.textContent = this.posture.readout();
  }

  /**
   * IS SHE ACTUALLY SPRINTING — asked once, for both the speed she gets and
   * the stamina she is charged.
   *
   * These used to be two expressions in two files: `paceScale` tested the
   * latch AND `canRun` AND the load, while `readEffort` passed the bare
   * latch. So the instant she bottomed out they disagreed — she was moved
   * at walking pace and billed at a sprint's, which meant the recovery
   * branch never ran and stamina sat at zero for as long as the latch was
   * held. One getter, so that cannot come back.
   */
  get sprinting(): boolean {
    return this.input.sprint && this.vitals.canRun && !this.carry.tooLadenToRun;
  }

  private routeStick(): void {
    if (this.posture.armed) {
      this.input.walk = 0;
      this.input.yaw = 0;
      this.posture.command(this.stickX, this.stickY);
      return;
    }
    /* Left and right TURN her. The side step is the view's job now. */
    this.input.yaw = this.stickX;
    this.input.walk = this.stickY;
  }

  /**
   * The CRAWL / WALK / RUN latch — 0, 1, 2 — and the only pace a thumb has.
   *
   * Shift has always doubled her pace for the PC hand and there was never a
   * way down from a walk at all; the chip now cycles all three, so a thumb
   * gets the crawl the wave gait was written for as well as the run.
   */
  private pace: 0 | 1 | 2 = 1;

  /**
   * SHE DROPS OUT OF THE RUN WHEN SHE RUNS OUT — and has to ask for it back.
   *
   * Asked for: "when stamina is drained, automatic change the button from
   * sprint to walk and allow at that instant the ability for stamina to
   * regenerate". The regeneration half was a bug and is fixed in
   * `sprinting`; this is the other half, and it is worth having on its own.
   *
   * The gear used to stay on RUN while she walked, because `canRun` is
   * checked where the SPEED is decided and nothing told the latch. So the
   * plate said RUN, the chip said RUN, and she was walking — the HUD naming
   * a gear the game had already refused her. This file's own rule is that a
   * control must not claim something it cannot do.
   *
   * IT ONLY EVER DROPS. Bottoming out moves the latch down to WALK; nothing
   * moves it back up. That was the worry raised with the request — "the
   * auto-button can be as well [annoying]" — and it is the half that would
   * actually bite: a latch that re-armed itself at the second-wind mark
   * would put her back into a sprint she did not ask for, seconds after she
   * stopped paying attention to it. Having to press it again is a fair
   * price and was accepted in the same breath.
   *
   * A HELD KEY IS NOT TOUCHED. Shift is a button someone is physically
   * holding; taking it away under their finger would be a lie in the other
   * direction. The latch is the thing that persists, so the latch is the
   * thing that drops.
   */
  private dropPaceIfSpent(): void {
    if (this.pace !== 2 || this.vitals.canRun) return;
    this.pace = 1;
    this.applyPace();
    this.toastCombat('WINDED — BACK TO A WALK');
  }

  /** Push the latch out to the two input flags and the chip's face. */
  private applyPace(): void {
    /* A HELD KEY OUTRANKS THE LATCH, and Shift outranks C — pressing both is
     * a fumble, not a request, and a run is the safer thing to give it. */
    const held = this.shiftHeld ? 2 : this.crawlHeld ? 0 : null;
    const now = held ?? this.pace;
    this.input.sprint = now === 2;
    this.input.crawl = now === 0;
    if (this.paceChip) this.paceChip.textContent = PACE_NAMES[this.pace];
    /*
     * THE PLATE WEARS THE PACE IT IS IN, not a light for one of three.
     *
     * Lighting it only on RUN left crawl and walk drawing the identical
     * button, so two of the three states were indistinguishable and the
     * plate said WALK while she crawled. Found in an audit of the room, and
     * it is the thing that made "we already have SPRINT, we don't need
     * CRAWL" wrong: a three-state latch has to be able to show three states.
     *
     * All three have their own art now — CRAWL arrived on the third sheet
     * and its lettered stand-in is retired.
     */
    const btn = this.sprintBtn;
    if (btn) {
      const art = this.pace === 2 ? 'sprint' : this.pace === 1 ? 'walk' : 'crawl';
      btn.className = `density-lab-button tm-art tm-art-${art}`;
      btn.setAttribute('aria-label', `Pace — ${PACE_NAMES[this.pace]}`);
      /* Lit on RUN still: it is the pace with a cost, and the one worth
       * seeing from the corner of an eye. */
      btn.classList.toggle('is-grip', this.pace === 2);
      /* And greyed while that cost cannot be met — see `paceMul`, which
       * vetoes the run rather than moving the latch. */
      btn.classList.toggle('is-spent', this.pace === 2 && !this.vitals.canRun);
    }
  }

  /** Shift runs and C crawls, both held; the chip latches. The keys match
   *  the density lab's, which has had all three paces for far longer. */
  private shiftHeld = false;

  private crawlHeld = false;

  private paceChip: HTMLButtonElement | null = null;

  /**
   * THE BORE — the dig room's control, brought over whole rather than
   * re-invented: hold DIG and she strokes, soil leaves at the bottom of
   * each stroke, steering is slow while cutting because a tunnel is a
   * committed shape, and pitch is a dial from straight down to straight up.
   *
   * The rule that makes it a tunnel rather than a trench is that the aim
   * steers TRAVEL, not just the bite — and the rule that makes it honest is
   * that digging never moves her by itself. Each stroke clears a little
   * more, and she can only walk into what has been cleared, so how fast a
   * tunnel grows is a property of her jaws and not of how long the stick
   * is held.
   */
  private readonly bore = new BoreRig(Math.PI);

  /** DIG is a MODE now: the DIG chip arms it, the 🪏 button strokes. */
  private digMode = false;

  /** Rail controls and the modes each one is relevant in. See `applyHudMode`. */
  private readonly railParts: { el: HTMLElement; part: HudPart }[] = [];

  /** The dress the HUD is currently wearing. Read by probes. */
  hudMode: HudMode = 'explore';

  /** The last answer `applyHudMode` wrote, so it can skip writing it again. */
  private hudSig = '';

  /** The shovel, revealed once DIG is armed. */
  private scoopBtn: HTMLButtonElement | null = null;

  /** The smoothing brush's radius, in millimetres — the slider's value. */
  private brushMm = SMOOTH_RADIUS_MM;

  /** Where the next press will act, drawn before it acts: the cut, and
   *  the halo the same stroke shaves around it. */
  /* ------------------------------------------------- the aim debug rig */

  /**
   * `?aimdebug=1` — draws where the SHOVEL thinks it is aiming against
   * where the CROSSHAIR is looking, because those are two different
   * calculations and only one of them is visible in normal play.
   *
   * Off unless asked for, and armed only while DIG is: these are
   * diagnostic overlays, not gameplay, and nothing here changes what the
   * stroke does. See `updateAimDebug`.
   */
  private aimDebug = false;

  private aimDbgDig: THREE.Line | null = null;

  private aimDbgCam: THREE.Line | null = null;

  private aimDbgSpot: THREE.Mesh | null = null;

  private aimDbgJaw: THREE.Mesh | null = null;

  private aimDbgHead: THREE.Line | null = null;

  /** A ring of recent camera look directions — see `AIM_DBG_LAG`. */
  private readonly aimDbgLook: THREE.Vector3[] = [];

  private aimDbgLookAt = 0;

  private aimDbgText: HTMLElement | null = null;

  private aimChip: HTMLButtonElement | null = null;

  private aimDbgAt = 0;




  private readonly keysDown = new Set<string>();

  private spaceWasDown = false;

  /**
   * WHICH WAY IS UP FOR HER — and it is not the world's answer.
   *
   * An ant has no down; it has a surface, and the surface is down. This is
   * the outward normal of whatever she is standing on: the hillside, a
   * tunnel floor, a shaft's wall, the roof of a chamber. Everything that
   * used to hard-code world +Y — the walk, her orientation, the leg solver's
   * frame, both cameras — reads this instead, which is the whole of walking
   * up a wall and across a ceiling.
   */
  private readonly up = new THREE.Vector3(0, 1, 0);

  /**
   * Her nose, in the world, always square to `up`.
   *
   * `facing` is a yaw about world +Y and cannot describe an ant on a
   * ceiling — the same heading means two different directions depending on
   * which way up she is. The rig still owns the RATE she turns at; what it
   * hands over is a change in heading, which is applied as a rotation about
   * her own up. On level ground the two are identical to the digit.
   */
  private readonly fwd = new THREE.Vector3(0, 0, 1);

  /** The rig's heading last frame, so a step of it can be applied as a turn
   *  about her own up rather than the world's. */
  private headingWas = 0;

  private walker: SurfaceWalker | null = null;

  /** How fast she is actually travelling over the ground, eased — the gait's
   *  input, and never the stick's. */
  private groundSpeed = 0;

  private readonly wasAt = new THREE.Vector3();

  /**
   * THE LEGS, DRIVING.
   *
   * The island had the foot solver but not this, and the difference is the
   * whole of the reported skating. `solveFeet` can only move a foot up and
   * down — the gait owns where it sits fore and aft — so with nothing
   * telling it where a foot IS in the world from one frame to the next,
   * nothing could hold one still. The drive plants a stance foot on a world
   * point and puts it back there every frame, which makes its ground speed
   * exactly zero however fast the cycle runs. It also means the LEGS move
   * her: the stick proposes, the planted feet refuse what they cannot
   * reach, and what survives is her displacement.
   */
  private drive: LegDrive | null = null;

  private driveReport: DriveReport | null = null;

  /**
   * THE FLIGHT RECORDER.
   *
   * Arms itself the first frame she actually moves and keeps sixty seconds of
   * every frame, because the float and the snap we are chasing last a handful
   * of frames each and a once-a-second sample reports a smooth run straight
   * over the top of them. See `IslandTelemetry.ts`.
   */
  private readonly telemetry = new TelemetryRecorder();

  private telemetryChip: HTMLButtonElement | null = null;

  /** Scratch for the seating measurement — no per-frame allocation. */
  private readonly seatFrom = new THREE.Vector3();

  /** How far the walker re-seated her along her up, this frame, in mm. */
  private seatLiftMm = 0;

  /** How high her body rides, taken from her own rig once it has loaded. */
  private legRide = RIDE;

  /**
   * What the legs may ask of the world: the nearest solid to a point,
   * searched down her own up and then back along it. Null is a real answer
   * and means nothing to stand on here, which is how a foot knows to stay
   * up rather than reach into space.
   */
  private readonly groundForLegs = {
    nearest: (at: THREE.Vector3, up: THREE.Vector3, down: number, rise: number) => {
      const walker = this.walker;
      if (!walker) return null;
      const from = S_RAD.copy(at).addScaledVector(up, rise);
      const dir = S_SPOT.copy(up).negate();
      return walker.cast(from, dir, rise + down);
    },
    /*
     * AND THE SAME QUESTION IN A DIRECTION THAT IS NOT HER UP.
     *
     * The one above is the right question for the ground she is standing on
     * and cannot answer for the one she is not. Measured at the landmark:
     * from a front foot's home, with a trunk 14 down to 5 mm away, it
     * returns SOIL every frame, while a ray along her forward finds bark the
     * whole time. So the corner scheduler gets a direction of its own.
     *
     * It is the SAME FIELD — the walker's own cast, over the union of soil,
     * landmark, scrub and anything dug. No second collision world, no tree.
     *
     * The null on a solid origin is not defensive tidying. `cast` reports a
     * hit at zero range when it starts inside something, which is correct
     * for a ray and is a foothold 2.5 mm inside the wood here; that is
     * exactly what the gait's downward cast hands back once a front foot's
     * home crosses the bark.
     */
    probeContact: (origin: THREE.Vector3, dir: THREE.Vector3, maxDistance: number) => {
      const walker = this.walker;
      if (!walker) return null;
      if (walker.solidAt(origin.x, origin.y, origin.z)) return null;
      const hit = walker.cast(origin, dir, maxDistance);
      if (!hit) return null;
      const normal = new THREE.Vector3();
      walker.normalAt(hit, normal);
      return { point: hit, normal };
    },
  };

  /** How far the third-person camera is swung off her tail by a drag; it
   *  decays back to zero, which is how the view returns behind her. */
  /**
   * THE PLAYER'S PAN, as an offset from neutral in her own frame.
   *
   * Not a world bearing and not the aim. Both decay to zero after
   * `LOOK_HOLD_S`, which is what makes the camera come home; and being HER
   * frame is what lets them keep meaning something on a wall, where a world
   * bearing stops meaning anything at all.
   */
  private lookYaw = 0;
  private lookPitch = 0;
  /** Seconds since the last look drag. Reset while a finger is down. */
  private lookIdle = 0;

  /** Last measured head-shell clearance, in mm — reused by the FPV lift. */
  private headClearMm = Infinity;

  /** The eased camera-only up-tilt, in radians. See `FPV_LIFT_RAD`. */
  private fpvLift = 0;

  /** Her neck's eased angle — the damper on the head clamp. */
  private headPitchNow = 0;
  /**
   * The direction the first-person lens actually looks, in world space.
   *
   * Published because the DIG reads it: the crosshair sits at the centre of
   * the frame, so the cut has to happen along the line the frame is built
   * on or the two disagree the moment her head is not level with her body.
   */
  private readonly lookDir = new THREE.Vector3(0, 0, 1);


  private camPitch = 0.5;

  private camDist = 30 / MM;

  /**
   * THE CAMERA'S OWN SMOOTHED STATE — a target, a look point, and an up,
   * each following the real thing over time rather than being copied from
   * it every frame.
   *
   * The lens position was already eased. Everything else was not, and that
   * is where the shake was: `lookAt` was pointed at her RAW centre and
   * `camera.up` copied her RAW up, so every millimetre the walker re-seated
   * her — and it re-seats her every frame, on a lattice — went straight
   * into the view as angular jitter, magnified by the length of the arm.
   * The chosen SPOT jittered too, both from `clearRun`'s step quantisation
   * and from the hard switch between the straight arm and the fan.
   *
   * Three low-pass filters, so the picture moves like a camera on a rig and
   * not like one bolted to her thorax. `null` until the first frame places
   * them, because starting them at the origin would sweep the whole island.
   */
  private camWant: THREE.Vector3 | null = null;

  private camLook: THREE.Vector3 | null = null;

  private camRoll = new THREE.Vector3(0, 1, 0);

  /** The first-person lens's own filtered state — see `settleEye`. */
  private eyeAt: THREE.Vector3 | null = null;

  private readonly eyeRoll = new THREE.Vector3(0, 1, 0);

  /** Her NOSE, filtered — the body half of the first-person look. */
  private readonly eyeFwd = new THREE.Vector3(0, 0, 1);

  /** Last frame's ground-guard lift, in world units. Diagnostics only. */
  private guardLift = 0;

  /** The spine's inputs and raw targets last frame. Diagnostics only. */
  private spineRead: SpineReading | null = null;

  private spineWant: SpinePose | null = null;

  /**
   * How far into soil the WORST near-plane corner sits, in mm, after the
   * guard has had its say. Positive is dirt in the picture. Reported by
   * `lensReportForTest` so a probe can separate a query fault from an
   * escape fault instead of counting one blurred total.
   */
  private lensWorstMm = 0;

  /** The terrain rises, low-passed — see `readSpine`. */
  private riseAhead = 0;

  private riseBehind = 0;

  private firstPerson = false;

  /**
   * WHERE SHE IS POINTED, up and down — and it STAYS there.
   *
   * Taking this from the camera's own look direction was a mistake with
   * teeth: a third-person camera sits behind and above her, so its look is
   * permanently tilted down, and "forward" therefore meant "downward" for
   * as long as she was underground. She dug, sank, and could not aim back
   * out of the hole she was making. A dial the player sets and the game
   * leaves alone is the only thing that can mean ""along the tunnel"".
   */
  private aimPitch = 0;

  /** The last bearing the aim line actually had — held through plumb, where
   *  a bearing stops meaning anything. */
  private aimBearing = 0;

  private underground = false;

  /**
   * SHUT IN — what the SENSE runs on, and not what the camera runs on.
   *
   * `underground` answers "is she below grade", which is the right question
   * for choosing a camera algorithm and the wrong one for choosing a way of
   * SEEING: a nine-millimetre scoop with the sky open over it is below
   * grade and still in daylight. Keeping them apart is deliberate and was
   * learned the expensive way — one attempt redefined `underground` itself
   * and silently moved the camera with it, which `probe-lens` caught as
   * soil in the picture. The camera's flag is left exactly as it was; this
   * one is new, and nothing but the sense and the sky-coloured background
   * may read it.
   */
  private enclosed = false;

  /** How much of the sensed view is wanted, 0..1 — see `SENSE_ON_MM`. */
  private senseWant = 0;

  /** The room camera's share of the underground view, eased 0..1. */
  private chamberCam = 0;

  /** The tunnel designer — built fresh each time DIG opens it, because its
   *  working box is fitted around wherever the plan has grown to. */
  private designer: NestDesigner | null = null;

  /** The designer's plan-local origin in island mm, for translating the
   *  plan into its working box and back. */
  private readonly designOriginMm = new THREE.Vector3();

  /**
   * HOW SHARP THE WORLD IS ALLOWED TO GET, and where it starts.
   *
   * These were one number, `min(dpr, 2)`, used as both. On the phone this
   * game is actually played on that was a hard ceiling at 44% of the
   * screen's pixels: an iPhone 15 Plus is 1290 x 2796 at devicePixelRatio
   * 3, so a cap of 2 renders 1864 x 860 into a 2796 x 1290 panel and lets
   * the GPU upscale the difference. The layout was never wrong — 932 x 430
   * LOGICAL is exactly that device — but the 3D world was soft for a reason
   * nothing on screen could tell you.
   *
   * TWO NUMBERS NOW, and the split is the whole fix:
   *
   * `pixelCap` is the CEILING it may reach — full native, up to 3.
   * `pixelRatioNow` STARTS at the old cautious 2 and climbs.
   *
   * Starting at 3 would be the obvious change and the wrong one: a device
   * that cannot hold it would open the game at 12 fps and take four seconds
   * of quarter-steps to claw back, which is the worst possible first
   * impression. Starting low and earning it costs a few seconds of softness
   * on a phone that will then keep the sharpness, and costs a weak phone
   * nothing at all. The climb and the drop are both already there — see
   * `animate`, fps < 28 down, fps > 55 up.
   */
  private readonly pixelCap = Math.min(window.devicePixelRatio, 3);

  private pixelRatioNow = Math.min(window.devicePixelRatio, 2);

  /**
   * The highest rung not yet PROVED too expensive. Starts at the cap and
   * only ever comes down — see the scaler in `animate` for why a ceiling
   * that never learns is a ceiling the scaler hunts against.
   */
  private pixelCeiling = Math.min(window.devicePixelRatio, 3);

  /** When the render scale last moved, so it is not judged mid-settle. */
  private pixelChangedAt = 0;

  /** Consecutive seconds comfortably above the target frame rate. */
  private goodSeconds = 0;

  /** The last position whose centre provably sampled AIR — the anchor the
   *  anti-embed safety net snaps back to. */
  private readonly lastSafe = new THREE.Vector3();

  private hasSafe = false;

  private embedFrames = 0;

  private queenReady = false;

  /** The queen's GLB has RESOLVED — loaded or failed, either way settled.
   *  `ready` is the WORLD (probes wait on it); the player-facing loading
   *  screen waits for this too, so the reveal never shows a queenless hill. */
  private queenSettled = false;

  /** worldReady && queenSettled — the moment the loading screen lets go. */
  playerReady = false;

  private paused = false;

  private previous = performance.now();

  private frame = 0;
  /** True while the GPU context is gone and the loop is stopped. */
  private contextLost = false;
  /** The "device dropped the 3D display" bar, once it has been raised. */
  private gpuNotice: HTMLElement | null = null;
  private stopContextGuard: (() => void) | null = null;

  private lastScrollAt = 0;

  private biteAt = 0;

  /** Did the LAST bite actually remove soil? Surface engagement hangs on
   *  it — digging at open air must not grip her to the aim line. */
  private biteTouched = false;

  /* ------------------------------------------------- the founding quests */

  /** 0 dig the entrance · 1 hollow the chamber · 2 cinematic · 3 done. */
  private questStage = 0;

  /** Soil removed while deep — the chamber's progress, in samples. */
  private deepCarved = 0;

  private questEl: HTMLElement | null = null;

  /* The objective card's live pieces, and the last thing written to them. */
  private questTitleEl: HTMLElement | null = null;

  private questBlurbEl: HTMLElement | null = null;

  private questStepsEl: HTMLElement | null = null;

  private questShown = '';

  private cineEl: HTMLElement | null = null;

  /** The live number in the colony strip — workers actually standing out. */
  private workersOutEl: HTMLElement | null = null;

  private workersOutShown = -1;

  private cineUntil = 0;

  /** The first worker — spawned when the chamber is made. */
  /** The colony on the surface — a worker and a major, each walking on her
   *  own legs. See `Colonist`. */
  private readonly colony: Colonist[] = [];


  private readonly workerAnchor = new THREE.Vector3();

  foodEl: HTMLElement | null = null;

  foodShown = -1;

  carryEl: HTMLElement | null = null;

  carryShown = -1;



  private showPlan = true;

  private readonly stats = {
    fps: 0,
    frames: 0,
    fpsAt: performance.now(),
    scrolls: 0,
    lastScrollMs: 0,
    rebases: 0,
    treeTris: 0,
  };

  private readonly hud: HTMLElement;

  /** The telemetry, folded behind a small STATS chip (collapsed default). */
  private readonly statsPanel: DebugStatsPanel;

  /** The full-screen curtain that hides the raw start-up. */
  private readonly loading: Curtain;

  private stickPointer: number | null = null;

  private lookPointer: number | null = null;

  /**
   * The look pointer's stroke so far — where it went down, when, and how
   * far it has actually travelled. Read once, on release, to decide whether
   * that was a pan or a flick. See `readFlick`.
   */
  private stroke = {
    x: 0, y: 0, lastX: 0, lastY: 0, at: 0, travel: 0,
  };

  /**
   * WHICH ANT SHE IS. The rail reads its own contents off this, and so
   * does her stamina — see `antKinds.ts`. One field, so a second playable
   * species is a swap rather than a branch.
   */
  readonly antKind: AntKind = FIRE_ANT;

  /** What keeps her going. See `islandVitals.ts`. */
  readonly vitals = new Vitals(FIRE_ANT.vitals);

  /** The jaws and the sting. See `islandCombat.ts`. */
  /* Her caste's row of `CASTE_COMBAT`, off her kind — the same way
   * `carry` takes her strength row. One playable ant, one source. */
  readonly combat = new Combat(FIRE_ANT.strength);

  /** What is in her jaws. Off the KIND's strength row — see `antKinds.ts`
   * and `STRENGTH` in `mandibleReach.ts`. */
  readonly carry = new Carry(FIRE_ANT.strength);

  /** The loose things INTERACT is for. See `islandProps.ts`. */
  readonly props: Prop[] = [];

  /**
   * THE COLONY'S LARDER, and the first thing on this island that is the
   * colony's rather than hers. Protein in milligrams, waiting on larvae
   * that do not exist yet — the store is real, the digestion is not.
   */
  readonly stores = emptyStores();

  /** Everything on the island she could get her jaws into. */
  readonly quarry: Beetle[] = [];

  /** Health bars over anything hurt or held. See `islandQuarryBar`. */
  private quarryBars: QuarryBars | null = null;

  /** What the bars need to know about the fight, without handing them
   *  the whole combat model. */
  get gripped(): Beetle | null { return this.combat.held as Beetle | null; }

  private toastEl: HTMLElement | null = null;

  private toastUntil = 0;

  biteBtn: HTMLButtonElement | null = null;

  carryBtn: HTMLButtonElement | null = null;

  interactBtn: HTMLButtonElement | null = null;

  /** Set by `buildControls`. The handle for it is on the PAUSE menu. */
  toggleDevDrawer: (() => boolean) | null = null;

  stingBtn: HTMLButtonElement | null = null;

  /** The bars `renderQuest` keeps current. See `islandQuest.ts`. */
  private readonly vitalBars: VitalBar[] = [];

  /** The numbers printed over those bars. */
  private readonly vitalNums: { kind: VitalKind; el: HTMLElement; shown: string }[] = [];

  /** The colony head-count badge on the queen's portrait. */
  private headCountEl: HTMLElement | null = null;

  private headCountShown = -1;

  /** Last seen, so the pace plate is only redrawn when it has to be. */
  private canRunWas = true;

  /** The evasive burst, and the numbers behind it. See `dodge.ts`. */
  private readonly dodge = new Dodge();

  /** Head, thorax and gaster, each chasing the terrain at its own rate.
   *  See `src/anim/spine.ts`. */
  private readonly spine = new Spine();

  private readonly stickOrigin = { x: 0, y: 0 };

  /**
   * WHERE THE STICK IS, kept apart from what it MEANS.
   *
   * The handler used to write `input.walk` and `input.yaw` straight out of
   * the pointer event, which made the stick and locomotion the same object —
   * and a stick that can also drive a posture needs somewhere to put a
   * deflection that is not a walk. Held here, routed once, in `routeStick`.
   */
  private stickX = 0;

  private stickY = 0;

  /**
   * Her height and attitude — the two things a real ant adjusts on a slope
   * and this rig had no way to express. See `bodyPosture.ts`.
   */
  readonly posture = new BodyPosture();

  private readonly stickEl = document.createElement('div');

  private readonly stickKnob = document.createElement('div');

  private readonly crosshair = document.createElement('div');

  private aimReadout: HTMLElement | null = null;

  /** The ↕ and 🚁 chips, and the live pose numbers beside them. */
  private rideChip: HTMLButtonElement | null = null;

  private tiltChip: HTMLButtonElement | null = null;

  /** The pace plate — the SPRINT art driving the CRAWL/WALK/RUN latch. */
  private sprintBtn: HTMLButtonElement | null = null;

  private poseReadout: HTMLElement | null = null;

  private headingReadout: HTMLElement | null = null;

  private depthReadout: HTMLElement | null = null;

  constructor(host: HTMLElement, private readonly boot: IslandBoot = {}) {
    this.host = host;
    host.classList.add('density-lab-host');
    /*
     * Safari in a TAB ignores `user-scalable=no` on purpose, and answers a
     * pinch with its own `gesture*` events rather than with touches — so
     * `touch-action` never sees them and the page magnifies anyway.
     * Refusing the gesture outright is the only thing that stops it.
     */
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      host.addEventListener(name, this.refuseGesture, { passive: false });
    }
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(this.pixelRatioNow);
    host.appendChild(this.renderer.domElement);
    this.watchContext();

    this.scene.background = new THREE.Color(0x9cc4e0);
    this.skyColour.copy(this.scene.background as THREE.Color);
    /* Haze, not blindness: from the summit the coast is ~5,600 world units
     * away and should read as distant blue land, the way islands do. */
    this.scene.fog = new THREE.Fog(0xb9c9d6, 1200, 11000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 16000);

    const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
    sun.position.set(4000, 6000, 2500);
    this.scene.add(sun, new THREE.AmbientLight(0xcfdcea, 0.8));

    // The sea: one plane at real sea level. The baked grid keeps true
    // bathymetry, so the seafloor falls away beneath it instead of meeting a
    // shelf — BE's own trick against z-fighting the shoreline.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry((SPAN_MM / MM) * 1.6, (SPAN_MM / MM) * 1.6),
      new THREE.MeshLambertMaterial({
        color: 0x2e6f8e, transparent: true, opacity: 0.82,
        /*
         * PUSHED BACK, so the shore always wins.
         *
         * The sea is one flat plane at zero and the island meets it along
         * every coastline, which is thousands of triangles sitting at the
         * same depth as the water. From high up the depth buffer cannot
         * separate them and they flicker against each other — the reported
         * z-fighting on land. Nudging the sea away from the camera breaks
         * the tie the same way every frame, and being a hair deeper than it
         * really is costs nothing on something you look down through.
         */
        polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(SPAN_MM / MM / 2, 0, SPAN_MM / MM / 2);
    this.scene.add(sea);

    this.scene.add(this.queen.root);

    this.hud = document.createElement('div');
    /* `tm-vitals-on` is a promise about the top-left corner: the vitals
     * panel is there, so the debug readouts that used to own it move down.
     * A class on the host rather than a rule on the island's elements —
     * the pieces being moved belong to other files. */
    this.hud.className = 'density-lab-hud tm-vitals-on';
    host.appendChild(this.hud);
    this.statsPanel = new DebugStatsPanel(this.hud);
    this.buildControls();

    /* The curtain goes up LAST in the DOM and FIRST in importance: plain
     * DOM, so it paints before any of the heavy lifting below, and opaque,
     * so the HUD and the blue empty canvas never flash through. */
    /*
     * WHO COVERS THE BOOT. Alone, the island draws its own opaque curtain —
     * without one the player watches the clear colour flash blue. Booted
     * behind the MENU there is already something opaque up, so it takes a
     * quiet curtain instead and hands its progress to the menu, which shows
     * the same words on a screen you can actually press things on. Two
     * full-screen overlays would only be a second thing to fade.
     */
    this.loading = this.boot.curtain ?? new LoadingOverlay(host);

    this.load().catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err);
      this.loading.fail(`The island failed to load — ${why}. Refresh to try again.`);
      /*
       * ONLY ON THE FAILING PATH. `load()` resolving is NOT the app being
       * loaded: it resolves the moment the world is standing, and leaves the
       * queen's model — a megabyte, and the longest fetch of the boot — still
       * in flight behind it. Marking loaded here on success would hand a
       * waiting update the app precisely during the download that is worst to
       * interrupt. The success signal is where the curtain actually lifts,
       * after the queen has settled. Failure has no such moment and needs
       * one: an update held behind a load that has already given up is an
       * update that never arrives, and a fresh build is exactly what a failed
       * load most wants.
       */
      markLoaded();
    });

    (window as unknown as { islandScene?: unknown }).islandScene = this;
    /*
     * `?ik=off` — the leg solver's off switch, read once at startup so it can
     * be reached from a phone, where there is no console. See `setIK`.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('ik') === 'off') this.setIK(false);
    /*
     * `?aimdebug=1` — the aim overlay's only switch, read once at startup
     * for the same reason `?ik=off` is: a phone has no console. It stays
     * off in every ordinary session, and even when armed it draws nothing
     * until DIG is.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('aimdebug') === '1') this.setAimDebug(true);
    /*
     * `?lean=0` — the body lean's off switch, same reasoning: it is a change
     * you judge by eye, so it has to be switchable on the device you are
     * looking at it on. See `LEAN_PER_ACCEL`.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('lean') === '0') this.leaning = false;
    /*
     * `?gait=tripod` — put the one gait back, for looking at the two side
     * by side. The speed-chosen gait is ON now: the CRAWL chip exists to
     * reach it, and a pace that named itself a crawl and then ran the same
     * tripod as a run would be a label rather than a gait. Walking and
     * running are untouched — `feetAllowedUp` only parts company with the
     * tripod below `GAIT_WAVE_BELOW`, which no walk reaches.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('gait') === 'tripod') this.adaptiveGait = false;
    /*
     * `?support=0` — take her feet out of her attitude and leave it to the
     * density gradient under her belly, as it was. The control for
     * `probe-support`, and the only way to compare a climb with and without
     * the support plane on the same build.
     */
    if (new URLSearchParams(
      typeof location === 'undefined' ? '' : location.search,
    ).get('support') === '0') this.footAttitude = false;
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.animate();
  }

  private async load(): Promise<void> {
    this.loading.setStatus('Preparing the island…');
    const url = `${import.meta.env.BASE_URL}kauai-1025.bin`;
    const [raw, textures] = await Promise.all([
      (await fetch(url)).arrayBuffer(),
      /*
       * EIGHT, NOT SIXTEEN, and the difference is measured rather than
       * taste. The bark asks for sixteen because bark is ONE texture on a
       * trunk. The ground is the heaviest shader in the game — a six-way
       * elevation/slope splat where every band is sampled twice for
       * anti-repeat and the rock bands three times for triplanar, so a
       * pixel of ground can cost a dozen samples before anisotropy
       * multiplies any of them.
       *
       * Time for the queen's model to finish loading, which under a
       * software rasteriser is a fair proxy for how much of the frame the
       * shading is eating: 46 s at 4, 57 s at 8, 106 s at 16. Eight buys
       * most of the grazing-angle win for a quarter of sixteen's cost, and
       * a phone is bandwidth-bound in exactly the way that measurement is.
       */
      loadBiomeTextures(
        import.meta.env.BASE_URL,
        Math.min(8, this.renderer.capabilities.getMaxAnisotropy()),
      ),
    ]);
    this.loading.setStatus('Raising the island…');
    this.heights = new Int16Array(raw);
    this.ground.heights = this.heights;
    this.heightsBase = this.heights.slice();
    this.textures = textures;
    /* BOTH surfaces band by the stride-1 data slope (aGroundNy): the
     * island's LOD rings and the soil window then agree on where rock
     * meets sand, instead of each mesh reading its own normals. */
    this.islandMaterial = makeBiomeMaterial(textures, this.clip, true, this.bandTop);
    this.soilMaterial = makeBiomeMaterial(textures, undefined, true, this.bandTop);
    /* The soil window's rim lies coplanar with the island surface it
     * replaces — polygon offset pulls the soil forward a hair so the
     * seam is a line, not a z-fight shimmer. */
    this.soilMaterial.polygonOffset = true;
    this.soilMaterial.polygonOffsetFactor = -1;
    this.soilMaterial.polygonOffsetUnits = -1;
    /* The soil only: the island's own surface sheet is the lit world she
     * is standing on, and contouring that would be an x-ray of the hill. */
    this.sense = makeSensed(this.soilMaterial);

    /*
     * The soil's "natural surface" is the DRAWN base island (triangle-exact
     * over the pristine grid) so the fine soil's top meets the island mesh
     * at the window rim with nothing to stitch.
     */
    this.soil = makeIslandSoil((xMm, zMm) => this.renderedOn(this.heightsBase!, xMm, zMm));

    /*
     * Stamp the nest's mound into the STAMPED grid: the island mesh and the
     * far view get a coarse tent of a hill (the grid is 55 mm-a-sample), and
     * the fine window redraws the real mound shape whenever you are close
     * enough to care — the world room's macro/fine split, in data.
     */
    const r = this.soil.reject;
    for (let row = Math.max(0, Math.floor(r.min[2] / STEP_MM));
      row <= Math.min(N - 1, Math.ceil(r.max[2] / STEP_MM)); row += 1) {
      for (let col = Math.max(0, Math.floor(r.min[0] / STEP_MM));
        col <= Math.min(N - 1, Math.ceil(r.max[0] / STEP_MM)); col += 1) {
        const natural = this.heights[row * N + col]! / 10;
        const top = this.soil.moundTopMm(col * STEP_MM, row * STEP_MM, natural);
        if (top > natural) this.heights[row * N + col] = Math.round(top * 10);
      }
    }

    this.buildIsland();
    this.loading.setStatus('Streaming the soil…');

    // The middle of the island: the Waiʻaleʻale plateau, ~1,300 m up,
    // with the pre-tunnel's gate 40 mm to the east.
    this.at.set(SPAN_MM / 2 / MM, 0, SPAN_MM / 2 / MM);
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;

    this.stream = new IslandStream(
      this.soil,
      (xMm, zMm) => this.renderedOn(this.heightsBase!, xMm, zMm),
      this.at.x, this.at.z,
    );
    this.ground.stream = this.stream;
    /*
     * The walker is built once the soil exists, because the only thing it
     * needs is a way to ask how solid a point is — and that answer is the
     * live field where there is one and the island's own heightfield where
     * there is not. Its numbers are the island's, not the block room's: her
     * ride height, the field's cell, and a reach that spans a tunnel.
     */
    this.walker = new SurfaceWalker(
      (x, y, z) => this.soilDensityAt(x, y, z),
      {
        cell: CELL_SIZE,
        ride: RIDE,
        gripLift: 3 / MM,
        gripReach: 9 / MM,
        align: 12,
        maxTiltRate: (240 * Math.PI) / 180,
        /* The fold is a trapezoid now, not a switch — see `aimUp`. This
         * accel keeps the corner inside its measured timing while taking
         * the slam off both ends of the turn. */
        tiltAccel: (2400 * Math.PI) / 180,
        /* And the goal it chases is low-passed — see `SurfaceWalkTuning.
         * goalGain`. At an inside crease the raw contact normal alternates
         * faces on alternate frames; the filter turns that into its
         * average, and it is what took the lurch out of the fold. */
        goalGain: 1000,
        snap: 14,
        /* 0.3 mm: the stand-still dead-band — see SurfaceWalkTuning. */
        deadband: 0.06,
        gravity: 9,
      },
      (x, y, z) => this.soilSolidAt(x, y, z),
    );
    this.remeshEverything();
    this.clipToWindow();

    void this.plantTree();

    this.nestView = buildNestView(this.soil.plan);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.visible = this.showPlan;
    this.scene.add(this.nestView.root);

    /* The WORLD is ready here; the queen's model arrives when it arrives.
     * Gating `ready` on her GLB made every probe hostage to one slow fetch —
     * so the split is explicit: `ready` is the world (probes wait on it),
     * `playerReady` also waits for the queen to settle (loaded OR failed),
     * and only THAT lifts the curtain. The player never sees a queenless
     * island; the probes never hang on a model fetch. */
    this.ready = true;
    this.loading.setStatus('Waking the queen…');
    void this.queen.load().then((ok) => {
      this.queen.root.visible = ok;
      this.queenReady = ok;
      if (ok) this.buildLegDrive();
    }).finally(() => {
      this.queenSettled = true;
      this.playerReady = true;
      this.spawnQuarry();
      void this.loading.finish();
      /* Whoever is holding the curtain — the menu, when there is one — is
       * told here rather than left to poll, and told AFTER the queen has
       * settled, so "ready" means she is standing rather than merely that
       * the ground exists. */
      this.boot.onReady?.();
      /* The curtain is up: a waiting update may now take the app, because
       * from here a reload costs nothing but the load it already finished. */
      markLoaded();
    });
  }

  /**
   * ONE TREE, beside her, sunk into the hill.
   *
   * Loaded off the main thread of the boot: the bark is a megapixel and the
   * island is already playable without it, so the tree arrives when it
   * arrives rather than holding the curtain up. Which bark is a throw of the
   * dice, but a repeatable one — seeded off the spawn, so the tree that
   * grows here is this tree every time you load, not a different one each
   * run.
   */
  /** Which detail level the tree is actually showing, for the stats chip. */
  private treeLevel(): number {
    if (!this.tree) return -1;
    return this.tree.root.getCurrentLevel();
  }

  private async plantTree(): Promise<void> {
    const seed = Math.floor(this.at.x * 7919 + this.at.z * 104729) >>> 0;
    /*
     * `?bark=bark-ridged` — look at ONE of them.
     *
     * Which bark a tree wears is a hash of where it stands, which is right
     * for the world and useless for judging a new texture: the only way to
     * see the one you just added is to keep reloading until the island hands
     * it to you. An unknown name falls through to the seed rather than
     * leaving a tree with no bark.
     */
    const asked = new URLSearchParams(window.location.search).get('bark');
    const bark = (asked && (BARKS as readonly string[]).includes(asked)
      ? asked as typeof BARKS[number]
      : BARKS[seed % BARKS.length]!);
    const loader = new THREE.TextureLoader();
    const barkUrl = (suffix: string) => (
      `${import.meta.env.BASE_URL}tree-tex/${bark}${suffix}.jpg`
    );
    let map: THREE.Texture;
    try {
      map = await loader.loadAsync(barkUrl(''));
    } catch {
      return; // A missing bark is not worth failing the island over.
    }
    /*
     * The depth maps, for the barks that have them. A failure here costs the
     * relief and not the tree.
     */
    const pbr = PBR_BARKS.has(bark);
    const [normalMap, roughnessMap] = pbr
      ? await Promise.all([
        loader.loadAsync(barkUrl('_normal')).catch(() => undefined),
        loader.loadAsync(barkUrl('_rough')).catch(() => undefined),
      ])
      : [undefined, undefined];
    /*
     * MIRRORED BOTH WAYS, and that is a decision rather than a default.
     *
     * None of these images tile — measured, the wrap join on the newest
     * three was five to nine times worse than an ordinary interior join,
     * which on a trunk that wraps its texture six times is six hard lines
     * running the height of the tree. Blending the edges into agreement
     * fixes the join and leaves a blurred stripe down the middle that is
     * more obvious than the seam was. Mirroring costs neither: the join is
     * exactly continuous by construction, the image stays as sharp as it
     * came, and what it buys instead is a line of symmetry per tile, which
     * on bark disappears into the grain.
     *
     * It also means a new bark has to satisfy nothing at all beyond being
     * square.
     */
    /* Sixteen, not eight: the trunk is almost always seen at a grazing
     * angle — she is standing on it — and grazing angles are exactly what
     * anisotropy is for. Free on anything made this decade. */
    const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
    /*
     * A NON-SQUARE bark would otherwise be stretched. The wrap gives one unit
     * of U and one of V the same number of world millimetres, which is right
     * for the square photographs and wrong for a 512x1024 library tile: its
     * texels would be twice as dense up the trunk as around it and the grain
     * would read squashed. Scaling V by the image's own aspect makes a texel
     * square again whatever shape the file is, and leaves 1:1 images alone.
     */
    const aspect = map.image && map.image.height
      ? map.image.width / map.image.height : 1;
    /* Whether it TILES, not whether it has depth — see `TILING_BARKS`. */
    const wrap = TILING_BARKS.has(bark)
      ? THREE.RepeatWrapping : THREE.MirroredRepeatWrapping;
    for (const tex of [map, normalMap, roughnessMap]) {
      if (!tex) continue;
      tex.wrapS = wrap;
      tex.wrapT = wrap;
      tex.anisotropy = aniso;
      if (aspect !== 1) tex.repeat.set(1, aspect);
    }
    /* Colour is the only one that is colour: a normal map is a direction and
     * a roughness map is a number, and sRGB-decoding either corrupts it. */
    map.colorSpace = THREE.SRGBColorSpace;

    this.tree = buildTree({
      girth: TREE_GIRTH_MM / MM,
      height: TREE_HEIGHT_MM / MM,
      seed,
    }, map, bark, { normalMap, roughnessMap });
    this.ground.tree = this.tree;

    /*
     * SEVEN HUNDRED MILLIMETRES OUT — but WHICH WAY matters.
     *
     * The first cut picked a fixed bearing and landed on the Waiʻaleʻale
     * headwall: measured, the ground fell 572 mm over those 700, so the tree
     * was correctly buried into a forty-five degree cliff and grew out of
     * the rock below her like a flagpole. Walking a ring of bearings and
     * taking the one whose ground sits closest to her own costs sixteen
     * height lookups and puts the tree on the flattest thing within reach.
     */
    /*
     * SEVEN HUNDRED TO THE PIN, which leaves about fifty millimetres of
     * clear ground — and that is DELIBERATE, not an oversight in the
     * arithmetic.
     *
     * v0.0.77 "fixed" this by adding a girth, on the reasoning that the
     * trunk's flared foot is 640 mm of radius so the stated 700 mm was
     * never clear ground. The arithmetic was right and the change was
     * wrong: a five-second walk to an eighty-foot tree is the opening of
     * this game, it has been that way since the first version, and moving
     * the tree to arm's length turned the landmark into scenery at the
     * edge of the frame. Reverted on the player's word.
     *
     * What that investigation DID establish stands, and is worth keeping
     * here: because the bark is fifty millimetres away, a telemetry session
     * recorded by holding the stick forward is a recording of her climbing
     * this tree — every corner-phase row of one such log sat 1.4-1.7 mm
     * from bark. Read a walking log with that in mind, or start it facing
     * away from here.
     */
    const away = TREE_FROM_HER_MM / MM;
    const here = this.walkGroundAt(this.at.x, this.at.z);
    let tx = this.at.x + away;
    let tz = this.at.z;
    let best = Infinity;
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      const cx = this.at.x + Math.sin(a) * away;
      const cz = this.at.z + Math.cos(a) * away;
      const drop = Math.abs(this.walkGroundAt(cx, cz) - here);
      if (drop < best) { best = drop; tx = cx; tz = cz; }
    }
    /*
     * And DOWN into the ground by its burial depth. The island's drawn
     * surface is a 109 mm mesh while the fine soil window redraws the same
     * ground at one millimetre as she approaches, so the two disagree by a
     * few millimetres wherever the hill curves — a tree seated exactly on
     * the coarse surface would be left standing in air the moment the fine
     * one resolved underneath it. A hundred millimetres swallows that with
     * room to spare, and at a metre of girth it costs nothing visible.
     */
    this.tree.root.position.set(
      tx,
      this.walkGroundAt(tx, tz) - TREE_BURIED_MM / MM,
      tz,
    );
    /* Solid AFTER placing: the collision is built in world space, and until
     * the tree has a position there is nothing to build it around. */
    this.tree.makeSolid(this.tree.root.position);
    this.scene.add(this.tree.root);
    this.stats.treeTris = this.tree.triangles[0] ?? 0;

    /*
     * ONE MATERIAL FOR THE WHOLE FOREST. The bake marks its leaves with a
     * vertex colour rather than a second material, so wood and foliage
     * share a shader and a tier stays one draw call. Fog off for the same
     * reason the landmark's is: the island's curve is tuned for fifty-six
     * kilometres and would swallow a two-metre sapling standing beside her.
     */
    this.forestMaterial = new THREE.MeshStandardMaterial({
      map, vertexColors: true, roughness: 0.95, metalness: 0, fog: false,
    });
    this.growForest();
  }


  /**
   * Hand her legs the job of moving her.
   *
   * Only once her rig is loaded, because the drive is built out of where
   * her feet actually rest — `legPlan` is read off the model, not guessed.
   * Until then the walker steps her along her nose as it always did, which
   * is what the first second of a session looks like either way.
   */
  private buildLegDrive(): void {
    const setup: LegSetup[] = this.queen.legPlan().map((leg) => ({
      slot: leg.slot,
      home: new THREE.Vector3(leg.home[0], leg.home[1], leg.home[2]),
      reach: leg.reach,
    }));
    if (setup.length === 0) return;
    /*
     * SEAT HER AT THE HEIGHT HER OWN LEGS IMPLY.
     *
     * Measured: her rig rests its feet 0.26 mm ABOVE her body origin, and
     * the island was seating that origin 1.3 mm above the contact — so her
     * feet hovered 1.56 mm off the ground, against a downward reach of 1.1
     * to 1.8 mm, with the search starting higher still. All six legs came
     * back groping: nothing to stand on, every frame. A leg that never
     * plants is never anchored, and a foot that is never anchored is free
     * to slide, which is the skating.
     *
     * The ride the legs want is minus their own rest height — her origin a
     * hair BELOW the contact, because that is where this rig puts the sole
     * plane. Handing that to the walker makes the body height and the leg
     * geometry one number instead of two that have to be hoped into
     * agreement.
     */
    const meanFootY = setup.reduce((sum, leg) => sum + leg.home.y, 0) / setup.length;
    this.legRide = -meanFootY;
    if (this.walker) {
      this.at.addScaledVector(this.up, this.legRide - this.walker.tune.ride);
      (this.walker.tune as { ride: number }).ride = this.legRide;
    }
    this.drive = new LegDrive(setup);
    /* The slow gaits, if they were asked for — see `feetAllowedUp`. */
    this.drive.adaptiveGait = this.adaptiveGait;
    this.drive.walkSpeed = WALK_SPEED;
    this.drive.plantAll(
      { at: this.at, up: this.up, forward: this.fwd }, this.groundForLegs,
    );
  }
  /* -------------------------------------------- the land and its forest */

  /*
   * Moved out to `islandLand.ts` — the heightfield mesh, the stands grown
   * from it, and the footing queries that have to agree with both.
   */
  private get landHost(): LandHost {
    return this as unknown as LandHost;
  }

  private growForest(): void { growForest(this.landHost); }

  private regrowScrub(force = false): void { regrowScrub(this.landHost, force); }

  private groundHeightAt(x: number, z: number): number {
    return groundHeightAt(this.landHost, x, z);
  }

  private footingFrom(x: number, z: number, y: number): number {
    return footingFrom(this.landHost, x, z, y);
  }

  private boreFrame(): {
    up: readonly [number, number, number];
    surface: (x: number, y: number, z: number) => number;
  } { return boreFrame(this.landHost); }

  private buildIsland(): void { buildIsland(this.landHost); }


  /* ------------------------------------------------------------ the soil */

  private key(cx: number, cy: number, cz: number): string { return `${cx},${cy},${cz}`; }

  private remeshEverything(): void {
    for (const mesh of this.chunkMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunkMeshes.clear();
    this.builtChunks.clear();
    this.queue.length = 0;
    this.queued.clear();
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) this.meshChunk(cx, cy, cz);
      }
    }
  }

  private meshChunk(cx: number, cy: number, cz: number): void {
    const stream = this.stream!;
    const key = this.key(cx, cy, cz);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    const data = buildSurfaceNets(stream.field, 0, {
      x0: cx * CH, y0: cy * CH, z0: cz * CH,
      x1: Math.min(WINDOW_CELLS, (cx + 1) * CH),
      y1: Math.min(CELLS_Y, (cy + 1) * CH),
      z1: Math.min(WINDOW_CELLS, (cz + 1) * CH),
    });
    // Built is built, even when the region meshes to NOTHING (all air or
    // solid interior — most of the column). Forgetting the empties meant
    // every scroll requeued them all, which WAS the phone's backlog.
    this.builtChunks.add(key);
    if (data.indices.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    // The biome shader wants per-vertex elevation in real metres; a soil
    // vertex's world Y in wu times MM is exactly that.
    const elev = new Float32Array(data.positions.length / 3);
    for (let v = 0; v < elev.length; v += 1) {
      elev[v] = (data.positions[v * 3 + 1]! + stream.bandFloorWu) * MM;
    }
    geometry.setAttribute('aElev', new THREE.BufferAttribute(elev, 1));
    // ...and the ORIGINAL surface elevation at each vertex, so the shader
    // can tell an undug top (paint the biome, match the island seamlessly)
    // from an excavated wall or floor (paint dirt, whatever the altitude).
    const orig = new Float32Array(elev.length);
    // ...and the original terrain's SLOPE (its normal's Y), so undug soil
    // bands by the same slope the island does. Surface-nets normals read
    // flatter than the data grid's, and the flat reading turned the mound's
    // dark cliff bands into open mountain/snow — white ground at her feet.
    const groundNy = new Float32Array(elev.length);
    const d = STEP_MM / MM; // one data cell, in world units
    for (let v = 0; v < orig.length; v += 1) {
      const wx = stream.originWorldX + data.positions[v * 3]!;
      const wz = stream.originWorldZ + data.positions[v * 3 + 2]!;
      /*
       * THE SAME SURFACE THE FIELD WAS BUILT FROM — measured, 4.31 mm out
       * on average and 22.9 mm at worst when it was not.
       *
       * `groundHeightAt` is bilinear on the FULL 1025-sample grid. The soil
       * window is generated from `renderedOn`, which is triangle-exact on
       * the DRAWN 513 grid — a different surface, and on curved ground they
       * disagree by millimetres. The dug test starts at 1.5 mm and is
       * saturated by 4.0 mm, so undug ground was reading as fully
       * excavated and the whole window painted itself rock: the patch of
       * wrong texture around her. Read off the drawn grid and an untouched
       * soil top is exactly its own original, to the digit, everywhere.
       */
      orig[v] = this.renderedOn(this.heights!, wx * MM, wz * MM);
      const dhx = (this.groundHeightAt(wx + d, wz) - this.groundHeightAt(wx - d, wz)) / (2 * d);
      const dhz = (this.groundHeightAt(wx, wz + d) - this.groundHeightAt(wx, wz - d)) / (2 * d);
      groundNy[v] = 1 / Math.hypot(dhx, 1, dhz);
    }
    geometry.setAttribute('aOrig', new THREE.BufferAttribute(orig, 1));
    geometry.setAttribute('aGroundNy', new THREE.BufferAttribute(groundNy, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, this.soilMaterial!);
    /* World position is fixed at BUILD time — retained chunks keep their
     * mesh untouched across scrolls, which is what makes scrolls pop-free. */
    mesh.position.set(stream.originWorldX, stream.bandFloorWu, stream.originWorldZ);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  private enqueue(cx: number, cy: number, cz: number): void {
    const key = this.key(cx, cy, cz);
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push({ cx, cy, cz });
  }

  private onScroll(scroll: IslandScrollReport): void {
    this.stats.scrolls += 1;
    this.stats.lastScrollMs = scroll.ms;
    if (scroll.rebased) this.stats.rebases += 1;
    const moved = new Map<string, THREE.Mesh>();
    const keep = scroll.retained;
    for (const [key, mesh] of this.chunkMeshes) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      const nx = cx - scroll.tilesX;
      const nz = cz - scroll.tilesZ;
      const inside = !scroll.rebased
        && nx >= 0 && nx < CHUNKS_XZ && nz >= 0 && nz < CHUNKS_XZ
        && nx * CH >= keep.x0 && (nx + 1) * CH <= keep.x1
        && nz * CH >= keep.z0 && (nz + 1) * CH <= keep.z1;
      if (inside) {
        moved.set(this.key(nx, cy, nz), mesh);
      } else {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.chunkMeshes.clear();
    for (const [key, mesh] of moved) this.chunkMeshes.set(key, mesh);
    // The built set (empties included) rekeys by the same rule the meshes do.
    const movedBuilt = new Set<string>();
    for (const key of this.builtChunks) {
      const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
      const nx = cx - scroll.tilesX;
      const nz = cz - scroll.tilesZ;
      const inside = !scroll.rebased
        && nx >= 0 && nx < CHUNKS_XZ && nz >= 0 && nz < CHUNKS_XZ
        && nx * CH >= keep.x0 && (nx + 1) * CH <= keep.x1
        && nz * CH >= keep.z0 && (nz + 1) * CH <= keep.z1;
      if (inside) movedBuilt.add(this.key(nx, cy, nz));
    }
    this.builtChunks.clear();
    for (const key of movedBuilt) this.builtChunks.add(key);
    this.queue.length = 0;
    this.queued.clear();
    const jobs: { cx: number; cy: number; cz: number; d: number }[] = [];
    for (let cz = 0; cz < CHUNKS_XZ; cz += 1) {
      for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
        for (let cx = 0; cx < CHUNKS_XZ; cx += 1) {
          if (this.builtChunks.has(this.key(cx, cy, cz))) continue;
          const wx = this.stream!.originWorldX + (cx + 0.5) * CH * CELL_SIZE;
          const wz = this.stream!.originWorldZ + (cz + 0.5) * CH * CELL_SIZE;
          jobs.push({ cx, cy, cz, d: Math.hypot(wx - this.at.x, wz - this.at.z) });
        }
      }
    }
    jobs.sort((a, b) => a.d - b.d);
    for (const job of jobs) this.enqueue(job.cx, job.cy, job.cz);
    /*
     * THE CLIP MUST NEVER OUTRUN THE MESHES — the island sheet keeps
     * covering everything but the retained, still-meshed soil until the
     * queue drains (reveal). The world room's law, inherited verbatim.
     */
    if (scroll.rebased) {
      this.meshedRect.x1 = this.meshedRect.x0;
      this.meshedRect.z1 = this.meshedRect.z0;
    } else {
      /* The one rectangle provably covered after this scroll: what was
       * covered BEFORE, shifted, intersected with what was retained. The
       * keep rect alone is NOT proof — on a backlogged phone it claims
       * chunks still sitting in the queue from earlier scrolls, and every
       * claimed-but-unbuilt chunk was a see-through hole to the sea plane
       * (the playtest teal). */
      const sx = scroll.tilesX * CH;
      const sz = scroll.tilesZ * CH;
      this.meshedRect.x0 = Math.max(this.meshedRect.x0 - sx, Math.ceil(keep.x0 / CH) * CH, 0);
      this.meshedRect.x1 = Math.min(this.meshedRect.x1 - sx, Math.floor(keep.x1 / CH) * CH, WINDOW_CELLS);
      this.meshedRect.z0 = Math.max(this.meshedRect.z0 - sz, Math.ceil(keep.z0 / CH) * CH, 0);
      this.meshedRect.z1 = Math.min(this.meshedRect.z1 - sz, Math.floor(keep.z1 / CH) * CH, WINDOW_CELLS);
    }
    this.applyClipFromMeshedRect();
    this.clipPending = true;
  }

  private reveal(): void {
    if (!this.clipPending || this.queue.length > 0) return;
    this.clipPending = false;
    this.clipToWindow();
  }

  /**
   * Where the streamed band's ceiling currently sits, for both shaders.
   *
   * The band moves — it re-anchors under whatever the window's centre is
   * standing on — so this has to be refreshed with it, or the island keeps
   * its cut-out at the old altitude and a strip of hill goes missing.
   */
  private refreshBandTop(): void {
    if (!this.stream) return;
    this.bandTop.value = this.stream.bandFloorWu
      + (CELLS_Y - CAP_PLANES - 1) * CELL_SIZE;
  }

  private clipToWindow(): void {
    this.refreshBandTop();
    this.meshedRect.x0 = 0;
    this.meshedRect.z0 = 0;
    this.meshedRect.x1 = WINDOW_CELLS;
    this.meshedRect.z1 = WINDOW_CELLS;
    this.applyClipFromMeshedRect();
  }

  private applyClipFromMeshedRect(): void {
    const r = this.meshedRect;
    const inset = CELL_SIZE * 2;
    if (r.x1 - r.x0 > 0 && r.z1 - r.z0 > 0) {
      this.clip.value.set(
        this.stream!.originWorldX + r.x0 * CELL_SIZE + inset,
        this.stream!.originWorldZ + r.z0 * CELL_SIZE + inset,
        this.stream!.originWorldX + r.x1 * CELL_SIZE - inset,
        this.stream!.originWorldZ + r.z1 * CELL_SIZE - inset,
      );
    } else {
      this.clip.value.set(0, 0, 0, 0);
    }
  }

  /** The no-holes invariant, checkable from a probe: every soil chunk the
   *  clip rectangle exposes must have been BUILT (empties count). */
  clipCoveredForTest(): boolean {
    const c = this.clip.value;
    if (!this.stream || (c.x === 0 && c.y === 0 && c.z === 0 && c.w === 0)) return true;
    const x0 = Math.floor((c.x - this.stream.originWorldX) / CELL_SIZE / CH);
    const z0 = Math.floor((c.y - this.stream.originWorldZ) / CELL_SIZE / CH);
    const x1 = Math.ceil((c.z - this.stream.originWorldX) / CELL_SIZE / CH);
    const z1 = Math.ceil((c.w - this.stream.originWorldZ) / CELL_SIZE / CH);
    for (let cz = Math.max(0, z0); cz < Math.min(CHUNKS_XZ, z1); cz += 1) {
      for (let cx = Math.max(0, x0); cx < Math.min(CHUNKS_XZ, x1); cx += 1) {
        for (let cy = 0; cy < CHUNKS_Y; cy += 1) {
          if (!this.builtChunks.has(this.key(cx, cy, cz))) return false;
        }
      }
    }
    return true;
  }

  setMeshBudgetCapForTest(cap: number): void { this.meshBudgetCapForTest = cap; }

  loadingStateForTest(): {
    world: number; queenSettled: number; player: number; overlayGone: number;
  } {
    return {
      world: this.ready ? 1 : 0,
      queenSettled: this.queenSettled ? 1 : 0,
      player: this.playerReady ? 1 : 0,
      overlayGone: this.loading.done ? 1 : 0,
    };
  }

  /* ------------------------------------------------------------ the walk */

  /* ------------------------------------------------------------ the walk */

  /*
   * Moved out to `islandBody.ts` — one frame of her, from the stick to
   * where her feet land. The widest seam in the split, and unavoidably so:
   * a frame of an animal touches nearly everything about the animal.
   */
  private get bodyHost(): BodyHost {
    return this as unknown as BodyHost;
  }

  private simulate(dt: number): void { simulate(this.bodyHost, dt); }

  private refreshAim(): void { refreshAim(this.bodyHost); }

  /* ------------------------------------------------------------ the jaws */

  /*
   * Moved out to `islandDig.ts` — the aim line, the bite, the scoop's
   * centre, the smoothing pass and the debug rig that draws all four.
   */
  private get digHost(): DigHost {
    return this as unknown as DigHost;
  }

  private boreAim(): THREE.Vector3 { return boreAim(this.digHost); }

  private bite(): void { bite(this.digHost); }

  private biteRay(aim: THREE.Vector3): { origin: THREE.Vector3; reach: number } {
    return biteRay(this.digHost, aim);
  }

  private biteCentre(
    aim: THREE.Vector3, reach: number, out: THREE.Vector3,
    origin?: THREE.Vector3,
  ): boolean {
    return biteCentre(this.digHost, aim, reach, out, origin ?? this.at);
  }

  private updateAimDebug(): void { updateAimDebug(this.digHost); }

  /* ----------------------------------------------------- the nest's save */

  /* ------------------------------------------------- the tunnel designer */

  /**
   * DIG opens the DESIGNER — the tunnel system is how new tunnels get made.
   * Built fresh each open: its working box is fitted around wherever the
   * plan has grown to, with room to grow on every side.
   */
  openDesigner(): void {
    if (!this.soil || !this.ready || this.designer?.isOpen) return;
    /* A nestless island (the founding dig) has no plan to bound — the
     * working box grows around HER instead, sitting on the ground she
     * stands on, so the first nest is dug where the queen is. */
    const here: { min: number[]; max: number[] } = (() => {
      const xMm = this.at.x * MM;
      const zMm = this.at.z * MM;
      const gMm = this.groundHeightAt(this.at.x, this.at.z) * MM;
      return { min: [xMm, gMm, zMm], max: [xMm, gMm, zMm] };
    })();
    const b = planBounds(this.soil.plan) ?? here;
    const PAD = 160;
    /*
     * The box must be TALL enough that an entrance dragged anywhere in its
     * footprint can reach the terrain there — on the summit the ground
     * rises and falls tens of millimetres across one box, and a mouth
     * clamped short of the surface is floating or buried, the exact thing
     * ground-snap exists to prevent. Sample the drawn surface across the
     * footprint and take the box to it.
     */
    const bx0 = b.min[0] - PAD;
    const bx1 = b.max[0] + PAD;
    const bz0 = b.min[2] - PAD;
    const bz1 = b.max[2] + PAD;
    let terrainMin = Infinity;
    let terrainMax = -Infinity;
    for (let j = 0; j <= 8; j += 1) {
      for (let i = 0; i <= 8; i += 1) {
        const h = this.renderedHeightAtMm(
          bx0 + ((bx1 - bx0) * i) / 8, bz0 + ((bz1 - bz0) * j) / 8,
        );
        terrainMin = Math.min(terrainMin, h);
        terrainMax = Math.max(terrainMax, h);
      }
    }
    this.designOriginMm.set(
      bx0, Math.min(b.min[1] - PAD, terrainMin - 48), bz0,
    );
    const blockMm = {
      x: bx1 - this.designOriginMm.x,
      y: Math.max(b.max[1] + 48, terrainMax + 48) - this.designOriginMm.y,
      z: bz1 - this.designOriginMm.z,
    };
    /*
     * THE FOUNDING SEED: a nestless island's first DIG does not open an
     * empty drawing and wait for the player to guess that PLACE comes
     * first — it seeds the entrance at the queen's own feet, grounded on
     * the drawn surface, and opens the tools around it already selected.
     * The queen digs where the queen is.
     */
    let local = this.shiftPlan(this.soil.plan, -1);
    let seeded = false;
    if (!local.nodes.some((n) => n.kind === 'entrance')) {
      local = addNode(local, 'entrance', {
        x: this.at.x * MM - this.designOriginMm.x,
        y: this.renderedHeightAtMm(this.at.x * MM, this.at.z * MM)
          - this.designOriginMm.y,
        z: this.at.z * MM - this.designOriginMm.z,
      }).plan;
      seeded = true;
    }
    this.designer?.dispose();
    this.designer = new NestDesigner(
      this.scene, this.camera, this.renderer.domElement, this.hud,
      {
        mmPerUnit: MM,
        origin: new THREE.Vector3(
          this.designOriginMm.x / MM, this.designOriginMm.y / MM, this.designOriginMm.z / MM,
        ),
        blockMm,
        /* The drawn island surface, in plan-local mm — what entrance nodes
         * snap to. Drawn, not bilinear: a mouth must sit on the ground the
         * player SEES (the walker's own hard-won rule). */
        groundMm: (xMm, zMm) => this.renderedHeightAtMm(
          this.designOriginMm.x + xMm, this.designOriginMm.z + zMm,
        ) - this.designOriginMm.y,
        /* The founding mouth lands at HER feet, not ahead of the camera. */
        antMm: {
          x: this.at.x * MM - this.designOriginMm.x,
          y: this.at.y * MM - this.designOriginMm.y,
          z: this.at.z * MM - this.designOriginMm.z,
        },
      },
      {
        build: (plan) => this.applyPlan(this.shiftPlan(plan, 1)),
        close: () => this.closeDesigner(),
      },
      local,
    );
    /* Everything stops (the block scene's rule): the stick is released, the
     * jaws are off, and the camera is the designer's until DONE. */
    this.input.walk = 0;
    this.input.yaw = 0;
    this.input.dig = false;
    this.stickPointer = null;
    this.stickX = 0;
    this.stickY = 0;
    /* The designer owns the body too: a held crouch would sit under its
     * camera for the whole session and be blamed on the plan. */
    this.posture.reset();
    this.lookPointer = null;
    /* The designer is exempt from the hide-all because it flies with a
     * stick of its own wearing the same class, so the GAME's stick has to
     * be put away by hand — and now that it parks instead of vanishing,
     * put back by hand too, in `closeDesigner`. */
    this.stickEl.style.display = 'none';
    if (this.nestView) this.nestView.root.visible = false;
    /* A seeded mouth is an EDIT — DONE must carve it even untouched, or
     * the founding dig would quietly evaporate on close. */
    this.designer.show(local, { dirty: seeded });
  }

  private closeDesigner(): void {
    if (!this.designer) return;
    /* DONE with unbuilt changes carves them — a designer that can lose the
     * nest you just drew is worse than one that occasionally digs. */
    if (this.designer.hasUnbuilt) this.applyPlan(this.shiftPlan(this.designer.current(), 1));
    this.designer.hide();
    this.designer.dispose();
    this.designer = null;
    // Back to its corner. It used to reappear on the next touch; a parked
    // stick that stays gone after a designer session is a control lost.
    this.stickEl.style.display = '';
    if (this.nestView) this.nestView.root.visible = this.showPlan;
  }

  /** The plan, translated into (+1) or out of (-1) the island's absolute mm. */
  private shiftPlan(plan: NestPlan, sign: 1 | -1): NestPlan {
    const o = this.designOriginMm;
    return {
      nodes: plan.nodes.map((n) => ({
        ...n, x: n.x + sign * o.x, y: n.y + sign * o.y, z: n.z + sign * o.z,
      })),
      edges: plan.edges.map((e) => ({ ...e })),
    };
  }

  /**
   * DIG IT: the plan becomes the world. One representation — the soil is
   * carved FROM it, the rails ARE it, the sonar view DRAWS it — so the
   * regenerate covers the union of the old and new reject boxes (a deleted
   * tunnel must refill) and everything else is rebuilt from the plan.
   */
  private applyPlan(plan: NestPlan): void {
    if (!this.soil || !this.stream) return;
    const before = this.soil.reject;
    this.soil.setPlan(plan);
    const after = this.soil.reject;
    const box = this.stream.regenerateBox(
      {
        x: Math.min(before.min[0], after.min[0]) / MM,
        y: Math.min(before.min[1], after.min[1]) / MM,
        z: Math.min(before.min[2], after.min[2]) / MM,
      },
      {
        x: Math.max(before.max[0], after.max[0]) / MM,
        y: Math.max(before.max[1], after.max[1]) / MM,
        z: Math.max(before.max[2], after.max[2]) / MM,
      },
    );
    if (box) {
      const lo = (v: number) => Math.max(0, Math.floor((v - 1) / CH));
      const hi = (v: number, max: number) => Math.min(max - 1, Math.floor((v + 1) / CH));
      for (let cz = lo(box.minZ); cz <= hi(box.maxZ, CHUNKS_XZ); cz += 1) {
        for (let cy = lo(box.minY); cy <= hi(box.maxY, CHUNKS_Y); cy += 1) {
          for (let cx = lo(box.minX); cx <= hi(box.maxX, CHUNKS_XZ); cx += 1) {
            this.enqueue(cx, cy, cz);
          }
        }
      }
    }
    /* Her rail may have been resized, moved or deleted: let go and let the
     * regrab find whatever bore is under her now. The room she stood in may
     * be gone too — it re-derives from her position next frame. The tunnel
     * builder asks for the ride to be PRESERVED instead: its plan only ever
     * grows, and committing a leg mid-crawl must not drop her off a rail
     * or un-declare a gate she just declined. */
    if (this.nestView) {
      this.nestView.dispose();
      this.scene.remove(this.nestView.root);
    }
    this.nestView = buildNestView(plan);
    this.nestView.root.scale.setScalar(1 / MM);
    this.nestView.root.visible = this.showPlan && !this.designer?.isOpen;
    this.scene.add(this.nestView.root);
  }

  /** Her drawn body's pitch on her planted feet, radians, nose-down positive. */
  private bodyLean = 0;
  private leanSpeedWas = 0;
  /** Her speed, smoothed — see `LEAN_SPEED_RATE`. */
  private leanSpeed = 0;
  /** Her drawn body's roll into a turn, radians, inside-of-the-turn down. */
  private bodyBank = 0;
  private readonly bankFwdWas = new THREE.Vector3();
  private bankHasPrev = false;
  /** `?lean=0` turns it off, for looking at the two side by side. */
  private leaning = true;
  /** `?gait=tripod` turns it off. Applied to the drive as it is built. */
  private adaptiveGait = true;

  /** `?support=0` — her attitude back to the belly sample alone, for
   *  measuring the two side by side. See `SUPPORT_SHARE`. */
  private footAttitude = true;

  private pose(dt: number): void {
    if (!this.queenReady) return;
    /*
     * SHE IS DRAWN IN THE FRAME SHE IS STANDING IN.
     *
     * This used to build her up out of the heightfield's slope — `(-hx, 1,
     * -hz)` — and that hard-coded `1` was the ceiling on the whole game:
     * with a positive Y component by construction she could never be steeper
     * than ninety degrees, let alone inverted, however good the walk under
     * her got. The walker's up is volumetric and has no such preference, so
     * on the underside of an overhang she is simply upside down, which in
     * her own frame is perfectly ordinary.
     */
    const up = S_UP.copy(this.up);
    const forward = S_FWD.copy(this.fwd);
    forward.addScaledVector(up, -forward.dot(up)).normalize();
    const right = S_RIGHT.crossVectors(up, forward).normalize();
    this.queen.root.position.copy(this.at);
    this.queen.root.quaternion.setFromRotationMatrix(S_MAT.makeBasis(right, up, forward));
    /*
     * AND THEN SHE LEANS — see `LEAN_PER_ACCEL`. Post-multiplied, so the
     * axis is her OWN right and a positive angle carries her nose toward
     * her feet; that makes it mean the same thing on a wall or upside down
     * as it does on the flat. Her feet do not hear about it: they are
     * anchored in the world, so the legs simply take up the difference.
     */
    const rawSpeed = dt > 1e-6
      ? (this.driveReport?.movedMm ?? 0) / MM / dt : this.leanSpeed;
    this.leanSpeed += (rawSpeed - this.leanSpeed) * (1 - Math.exp(-LEAN_SPEED_RATE * dt));
    const speedNow = this.leanSpeed;
    const accel = dt > 1e-6 ? (speedNow - this.leanSpeedWas) / dt : 0;
    this.leanSpeedWas = speedNow;
    const wantLean = this.leaning
      ? Math.max(-LEAN_MAX, Math.min(LEAN_MAX,
        accel * LEAN_PER_ACCEL + (speedNow / (WALK_SPEED * SPRINT)) * LEAN_AT_SPRINT))
      : 0;
    this.bodyLean += (wantLean - this.bodyLean) * (1 - Math.exp(-LEAN_RATE * dt));
    /*
     * The turn rate, measured off her nose rather than off the stick — a
     * stick held against a wall she cannot turn on would bank her into
     * nothing. Signed about her own up, so it means the same inverted.
     */
    let turnRate = 0;
    if (this.bankHasPrev && dt > 1e-6) {
      const swept = S_BANK.crossVectors(this.bankFwdWas, forward).dot(up);
      turnRate = Math.asin(Math.max(-1, Math.min(1, swept))) / dt;
    }
    this.bankFwdWas.copy(forward);
    this.bankHasPrev = true;
    const wantBank = this.leaning
      ? Math.max(-BANK_MAX, Math.min(BANK_MAX, turnRate * BANK_PER_TURN))
      : 0;
    this.bodyBank += (wantBank - this.bodyBank) * (1 - Math.exp(-LEAN_RATE * dt));
    /*
     * THE CYCLIC RIDES ON TOP OF THE LEAN, and is added AFTER its clamp.
     *
     * Folding the 🚁 control into `wantLean` instead would have been fewer
     * lines and wrong: that value is bounded by `LEAN_MAX` at nine degrees,
     * which is the right authority for an involuntary lean into an
     * acceleration and nowhere near enough to lift a gaster off a wall. A
     * deliberate attitude is a different quantity with a different limit, so
     * it is summed here and clamped in `bodyPosture.ts`.
     *
     * Her feet still do not hear about it — see the note above. The legs
     * take up the whole difference, which is what makes this a hub tilting
     * on its legs rather than the whole animal being rotated through the
     * floor.
     */
    const leanTotal = this.bodyLean + this.posture.pitch;
    const bankTotal = this.bodyBank + this.posture.roll;
    if (Math.abs(leanTotal) > 1e-5) {
      this.queen.root.quaternion.multiply(
        S_QLEAN.setFromAxisAngle(S_LEAN_AXIS, leanTotal),
      );
    }
    if (Math.abs(bankTotal) > 1e-5) {
      /* About her own FORWARD: rolling, not steering. */
      this.queen.root.quaternion.multiply(
        S_QLEAN.setFromAxisAngle(S_BANK_AXIS, bankTotal),
      );
    }
    this.queen.update(dt, {
      /*
       * WHAT SHE ACTUALLY TRAVELLED, not what the stick asked for.
       *
       * `velocity` is the command: stick times walk speed times sprint. It
       * says the same thing whether she is crossing open ground or pressed
       * against a trunk going nowhere, so the gait ran her legs at a sprint
       * while she stood still — reported as the animation being set to
       * running while she walked. Her real ground speed is the distance she
       * covered across her own tangent plane, which is zero when she is
       * blocked and honest on every slope.
       */
      speed: this.groundSpeed,
      turn: -this.input.yaw * TURN_RATE,
      digging: this.input.dig ? 1 : 0,
      carrying: 0,
      /*
       * HER HEAD FOLLOWS THE AIM — ported from the sandbox room, which
       * drives both of these from its own arrow keys.
       *
       * This was `headYaw: 0` with no pitch at all, so she faced dead ahead
       * whatever the dial said: aiming ninety degrees up a trunk swung the
       * camera and the bore and left her looking at the bark in front of her
       * nose. `gaitPose` clamps yaw through the neck's own release curve and
       * pitch to +16.7/-75 degrees, so handing it a raw camera angle is
       * safe. In first person her head IS the camera, and turning it would
       * only fight the view.
       */
      /* Left and right were backwards — reported, and the sign lives here
       * and nowhere else. Her pitch was already right, so only this flips. */
      headYaw: this.firstPerson ? 0 : this.lookYaw,
      /* EASED, not snapped — see `settleHeadPitch`. The clamp is a
       * geometric answer and can change fast; her neck is not allowed to. */
      headPitch: settleHeadPitch(
        this.cameraHost, clampedHeadPitch(this.cameraHost), dt),
      /* The ground's own posture, kept entirely separate from the aim above
       * — see `readSpine`. */
      spine: readSpine(this.bodyHost, dt),
    });
    /* And her FEET are solved in that frame too. The solver has always
     * taken one; the island had been passing `undefined` and letting it
     * measure every foot as a height above sea level, which on a wall asks
     * a question the wall has no answer to. `boreFrame` casts along her own
     * up, so a foot on a ceiling is planted on the ceiling. */
    /* ANCHORED. Without this the solver may only raise and lower a foot,
     * and nothing in the pipeline knows where one IS from frame to frame —
     * so nothing can hold one still, and every planted foot skates. */
    this.queen.solveFeet(
      (x, z, y) => this.footingFrom(x, z, y),
      FOOT_CLEARANCE_MM / MM,
      RIDE * 2,
      this.drive ? (slot) => this.drive!.anchorFor(slot) : undefined,
      this.boreFrame(),
    );
    /*
     * NOTHING SHE IS MADE OF MAY BE IN THE SOIL.
     *
     * The legs and antennae have the solver above, which places them
     * per joint. Everything else — mandibles, the tip of a gaster over a
     * bank — has nobody, and on this island it simply sank. `groundGuard`
     * walks the bones that geometry is actually drawn on, asks how far
     * each would have to rise to be out of the dirt, and returns the
     * worst; the model is lifted rigidly by that, because a fail-safe
     * that tries to bend things is a fail-safe with its own bugs.
     *
     * The probe asks whether a POINT is in soil, not whether it is under
     * the surface. In a burrow those are different questions — a height
     * query answers "the rim, several millimetres over your head" — and
     * only the first one has a sensible answer down here.
     */
    /* Out along HER up, not the world's — on a ceiling the way out of the
     * dirt is downward, and a guard that only ever lifted in +Y pushed her
     * further into it. */
    /*
     * Stepped in eighths and then halved down to the clearance, rather than
     * crawled in 0.004-unit increments: a buried bone was costing a hundred
     * and thirty probes and there are forty of them, which measured at 732
     * probes a frame. Twelve probes get the same answer to well inside the
     * clearance the guard is enforcing.
     */
    const GUARD_REACH = RIDE * 2;
    const lift = this.queen.groundGuard((x, y, z) => {
      if (!this.soilSolidAt(x, y, z)) return 0;
      let lo = 0;
      let clear = -1;
      for (let i = 1; i <= 8; i += 1) {
        const d = (i / 8) * GUARD_REACH;
        if (!this.soilSolidAt(x + up.x * d, y + up.y * d, z + up.z * d)) { clear = d; break; }
        lo = d;
      }
      if (clear < 0) return GUARD_REACH;
      while (clear - lo > BONE_CLEARANCE) {
        const mid = (lo + clear) * 0.5;
        if (this.soilSolidAt(x + up.x * mid, y + up.y * mid, z + up.z * mid)) lo = mid;
        else clear = mid;
      }
      return clear;
    });
    /* Kept for the shake probe: this is a discrete search and a prime
     * suspect for vertical jitter, so it has to be measurable. */
    this.guardLift = lift;
    if (lift > 0) this.queen.root.position.addScaledVector(up, lift);
  }

  /* ---------------------------------------------------------- the camera */

  /*
   * Moved out to `islandCamera.ts` — three placements and their clearance
   * guards were the largest single subject left in this file. Only three of
   * its thirteen functions are called from outside it, so only three
   * delegates come back; the rest of the seam is stated as `CameraHost`
   * over there, and the cast is here rather than there so `private` keeps
   * meaning something for everything the camera has no business in.
   */
  private get cameraHost(): CameraHost {
    return this as unknown as CameraHost;
  }

  /* The same one-cast seam the camera uses, for the same reason: naming the
   * surface in `islandQuarryBar` is the point, and `private` stays
   * meaningful for everything the bars have no business touching. */
  private get barHost(): QuarryBarHost {
    return this as unknown as QuarryBarHost;
  }

  private aimCamera(dt: number): void { aimCamera(this.cameraHost, dt); }

  private lensClearance(): number { return lensClearance(this.cameraHost); }


  /* ---------------------------------------------------------------- HUD */

  /* ---------------------------------------------------------------- HUD */

  /*
   * Moved out to `islandHud.ts`. Eight hundred lines of DOM that runs once
   * and then never again, and the widest seam in the file — which is the
   * argument for stating it rather than leaving it implicit. `HudHost`
   * names every latch a button may reach.
   */
  private get hudHost(): HudHost {
    return this as unknown as HudHost;
  }

  private buildControls(): void { buildControls(this.hudHost); }

  private updateStatus(): void { updateStatus(this.hudHost); }

  /* --------------------------------------------------------------- loop */

  private animate = (): void => {
    /* Nothing to draw into. `watchContext` cancels the pending frame, so
     * this is the belt to that pair of braces — and it is what stops a
     * restore from ever running two loops at once. */
    if (this.contextLost) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.previous) / 1000);
    this.previous = now;
    if (!this.paused) this.simulate(dt);
    /*
     * The winded state is a per-FRAME fact and the pace plate is redrawn on
     * a per-TAP one, so the two are reconciled on the edge rather than by
     * repainting a button sixty times a second. `applyPace` is the only
     * thing that knows what the plate should look like, so it stays the
     * only thing that decides.
     */
    if (this.vitals.canRun !== this.canRunWas) {
      this.canRunWas = this.vitals.canRun;
      this.applyPace();
    }
    if (this.designer?.isOpen) this.designer.update();

    this.stats.frames += 1;
    if (now - this.stats.fpsAt > 1000) {
      this.stats.fps = Math.round(this.stats.frames * 1000 / (now - this.stats.fpsAt));
      this.stats.frames = 0;
      this.stats.fpsAt = now;
      /*
       * RESOLUTION BREATHES WITH THE FRAME RATE — and it must not HUNT.
       *
       * A phone that cannot hold ~30fps drops a notch and earns it back
       * above 55: the single biggest lever on a fill-rate-bound iPhone. The
       * danger is the loop. Drop a notch, frame rate recovers past 55, climb
       * back, frame rate collapses again — and every one of those steps
       * calls `resize()`, which reallocates the drawing buffer. A scaler
       * oscillating once a second is a visible pulse, and it looks exactly
       * like the camera shaking.
       *
       * That was survivable while the ceiling was 2, because there were four
       * steps to hunt over. v0.1.38 raised it to 3 for the sake of a native
       * 3x screen and gave the loop twice the room — and pointing at nearby
       * ground, which is the most fill-rate-hungry thing in the game, is
       * exactly where a phone sits on the threshold.
       *
       * THREE GUARDS, and each one is doing a different job:
       *
       * A COOLDOWN, so a change is never followed by another for four
       * seconds. Whatever the last change did to the frame rate has to be
       * given time to show up before it is judged.
       *
       * A CLIMB THAT COSTS MORE THAN A DROP. Falling behind is urgent —
       * that is a stutter the player feels now. Getting sharper is not, so
       * it wants THREE consecutive good seconds, not one lucky one.
       *
       * A HIGH-WATER MARK. Once a resolution has been proved too expensive,
       * it stops being a destination: the ceiling comes down to just below
       * it and the scaler settles instead of retrying the thing it already
       * knows does not work.
       */
      const fps = this.stats.fps;
      const cooling = now - this.pixelChangedAt < 4000;
      if (fps < 28 && this.pixelRatioNow > 1 && !cooling) {
        /* This rung is too expensive. Remember that, and stop aiming at it. */
        this.pixelCeiling = Math.max(1, this.pixelRatioNow - 0.25);
        this.pixelRatioNow = this.pixelCeiling;
        this.renderer.setPixelRatio(this.pixelRatioNow);
        this.pixelChangedAt = now;
        this.goodSeconds = 0;
        this.resize();
      } else if (fps > 55) {
        this.goodSeconds += 1;
        const roof = Math.min(this.pixelCap, this.pixelCeiling);
        if (this.goodSeconds >= 3 && this.pixelRatioNow < roof && !cooling) {
          this.pixelRatioNow = Math.min(roof, this.pixelRatioNow + 0.25);
          this.renderer.setPixelRatio(this.pixelRatioNow);
          this.pixelChangedAt = now;
          this.goodSeconds = 0;
          this.resize();
        }
      } else {
        /* Anywhere between the two is not a run of good seconds. */
        this.goodSeconds = 0;
      }
      this.updateStatus();
    }

    /* The landmark picks its own detail level, from the distance to its
     * WOOD rather than to its origin — see `BuiltTree.updateLevels`. It has
     * to happen after the camera has been placed and before the draw. */
    this.tree?.updateLevels(this.camera.position);
    /*
     * The quarry bars project from the camera, so like the tree's levels
     * they belong AFTER it has been placed — see `syncQuarryBars`. Built
     * lazily because `hud` does not exist until the HUD does.
     */
    if (!this.quarryBars) this.quarryBars = buildQuarryBars(this.barHost);
    syncQuarryBars(this.barHost, this.quarryBars);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  };

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /* --------------------------------------------------- the lost context */

  /**
   * What to do when the device takes the GPU away.
   *
   * It happens most on a rotate: turning the phone reallocates the drawing
   * buffer, and a first launch after an update is doing that with an emptied
   * cache, a megabyte of ant still arriving and terrain being built. three.js
   * rebuilds its own state if the context returns, but says nothing either
   * way and quietly makes `render` a no-op — so the sim keeps stepping, the
   * HUD keeps ticking, and the screen stays black with nothing to press.
   *
   * A loss that heals leaves no trace but a dropped frame: no banner, because
   * one that flashes up and away is worse than the hitch it describes. Only
   * a loss that does not heal gets a message, and the message has the one
   * button that can actually help.
   */
  private watchContext(): void {
    this.stopContextGuard = guardContext(this.renderer.domElement, {
      onLost: () => {
        this.contextLost = true;
        /* Stop the loop. Every draw from here is discarded, and simulating
         * an invisible island is just battery. */
        cancelAnimationFrame(this.frame);
        this.frame = 0;
      },
      onRestored: () => {
        this.contextLost = false;
        this.clearGpuNotice();
        /* The buffer is new and may be a different size — a rotate is the
         * usual reason the context went in the first place. */
        this.resize();
        /* Without this the first frame back carries the whole outage as its
         * dt; the clamp in `animate` would cap it at 50 ms, but she would
         * still take a step nobody asked for. */
        this.previous = performance.now();
        this.animate();
      },
      onAbandoned: () => this.showGpuNotice(),
    });
  }

  private showGpuNotice(): void {
    if (this.gpuNotice) return;
    const bar = document.createElement('div');
    bar.className = 'tm-update tm-update--alert';
    bar.setAttribute('role', 'alert');
    bar.innerHTML = `
      <span class="tm-update__text">The device dropped the 3D display.</span>
      <button class="tm-update__go" type="button">RELOAD</button>
    `;
    bar.querySelector('.tm-update__go')?.addEventListener('click', () => {
      window.location.reload();
    });
    document.body.appendChild(bar);
    this.gpuNotice = bar;
  }

  private clearGpuNotice(): void {
    this.gpuNotice?.remove();
    this.gpuNotice = null;
  }

  /* -------------------------------------------------------------- probes */

  /* ------------------------------------------------- the founding quests */

  /* ------------------------------------------------- the founding quests */

  /*
   * Moved out to `islandQuest.ts` — the four founding stages, the first
   * worker, and the colony half of the HUD. A narrow seam: sixteen members
   * for three hundred lines, because the founding really is its own
   * subject rather than a slice of everything.
   */
  private get questHost(): QuestHost {
    return this as unknown as QuestHost;
  }

  private depthMm(): number { return depthMm(this.questHost); }

  private questTick(dt: number): void { questTick(this.questHost, dt); }

  /* -------------------------------------------------------------- probes */

  /**
   * THE CAMERA'S TERRAIN QUESTION, ANSWERED IN THE OPEN.
   *
   * Every stage of the chain for one world point, so a probe can say WHICH
   * subsystem owns a bad frame rather than counting one blurred total:
   * whether the fine window had an answer at all, what it said, what the
   * coarse island would have said instead, what the tree contributes, and
   * whether the chunk covering the point is built, queued or missing.
   *
   * The distinction that matters is `fine`: 'solid' and 'air' are both
   * ANSWERS and both authoritative — carved air must never be overruled by
   * the coarse heightfield merely because the point lies under the original
   * surface — while 'unavailable' is the only state the fallback may serve.
   */
  lensQueryForTest(x: number, y: number, z: number): {
    fine: 'solid' | 'air' | 'unavailable';
    fineMm: number | null;
    coarseMm: number;
    treeMm: number | null;
    scrubMm: number | null;
    finalMm: number;
    localCell: [number, number, number] | null;
    chunk: string;
    chunkState: 'built' | 'queued' | 'missing' | 'out-of-window';
  } {
    const stream = this.stream;
    const raw = stream?.densityAtWu(x, y, z);
    const available = raw !== null && raw !== undefined;
    const tree = this.tree?.solid?.densityAt(x, y, z);
    const scrub = this.stand?.densityAt(x, y, z);
    let localCell: [number, number, number] | null = null;
    let chunk = 'out-of-window';
    let chunkState: 'built' | 'queued' | 'missing' | 'out-of-window' = 'out-of-window';
    if (stream) {
      const lx = (x - stream.originWorldX) / CELL_SIZE;
      const ly = (y - stream.bandFloorWu) / CELL_SIZE;
      const lz = (z - stream.originWorldZ) / CELL_SIZE;
      localCell = [lx, ly, lz];
      if (available) {
        const key = this.key(
          Math.floor(lx / CH), Math.floor(ly / CH), Math.floor(lz / CH),
        );
        chunk = key;
        chunkState = this.chunkMeshes.has(key) || this.builtChunks.has(key)
          ? 'built' : this.queued.has(key) ? 'queued' : 'missing';
      }
    }
    return {
      fine: available ? (raw > 0 ? 'solid' : 'air') : 'unavailable',
      fineMm: available ? raw * MM : null,
      coarseMm: (this.walkGroundAt(x, z) - y) * MM,
      treeMm: tree === undefined ? null : tree * MM,
      scrubMm: scrub === undefined ? null : scrub * MM,
      finalMm: this.soilDensityAt(x, y, z) * MM,
      localCell,
      chunk,
      chunkState,
    };
  }

  /** What the guard left in frame, and what it was defending. */
  /** For probes: carve a hollow, so a test can dig without a shovel. */
  carveForTest(x: number, y: number, z: number, radius: number): void {
    this.stream?.subtractSphere({ x, y, z }, radius);
  }

  /** For probes: what a loose thing would rest on here. See `floorUnder`. */
  floorUnderForTest(x: number, y: number, z: number): number {
    return this.floorUnder(x, y, z);
  }

  lensReportForTest(): {
    worstMm: number; clearanceMm: number; fovDeg: number; nearMm: number;
    camMm: [number, number, number]; queuedChunks: number;
  } {
    const p = this.camera.position;
    return {
      worstMm: this.lensWorstMm,
      clearanceMm: this.lensClearance() * MM,
      fovDeg: this.camera.fov,
      nearMm: this.camera.near * MM,
      camMm: [p.x * MM, p.y * MM, p.z * MM],
      queuedChunks: this.queue.length,
    };
  }

  /** The overlay's one switch, so the chip, the URL and a probe cannot
   *  disagree about whether it is on. */
  private setAimDebug(on: boolean): void {
    this.aimDebug = on;
    this.aimChip?.classList.toggle('is-grip', on);
  }

  /** The aim overlay, for a probe that wants it without a URL. */
  setAimDebugForTest(on: boolean): void { this.setAimDebug(on); }

  /** What the overlay is drawing, as numbers — the same values, so a probe
   *  can assert the discrepancy the picture shows. */
  aimDebugForTest(): {
    camAtMm: [number, number, number]; digAtMm: [number, number, number];
    jawMm: [number, number, number] | null; biteMm: [number, number, number];
    camVsBoreDeg: number; camVsHeadDeg: number | null;
    jawOffAxisMm: number | null; jawToCarveMm: number | null;
    carveAheadMm: number; carveUpMm: number; carveSideMm: number;
    reachMm: number; willBite: boolean;
  } {
    const aim = this.boreAim();
    const centre = new THREE.Vector3();
    const jaw = new THREE.Vector3();
    const haveJaw = this.queenReady && this.queen.jawPosition(jaw);
    /* The shovel's own ray, not a rebuild of it — see `biteRay`. */
    const ray = this.biteRay(aim);
    const willBite = this.biteCentre(aim, ray.reach, centre, ray.origin);
    this.camera.updateMatrixWorld();
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const head = new THREE.Vector3();
    const haveHead = this.queenReady && this.queen.eyeForwardWorld(head);
    const p = this.camera.position;
    const ang = (a: THREE.Vector3, b: THREE.Vector3): number =>
      (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
    let ahead = 0; let lift = 0; let side = 0;
    if (haveJaw && haveHead) {
      const up = new THREE.Vector3();
      this.queen.eyeUpWorld(up);
      const right = new THREE.Vector3().crossVectors(head, up).normalize();
      const rel = centre.clone().sub(jaw);
      ahead = rel.dot(head) * MM;
      lift = rel.dot(up) * MM;
      side = rel.dot(right) * MM;
    }
    return {
      camAtMm: [p.x * MM, p.y * MM, p.z * MM],
      digAtMm: [this.at.x * MM, this.at.y * MM, this.at.z * MM],
      jawMm: haveJaw ? [jaw.x * MM, jaw.y * MM, jaw.z * MM] : null,
      biteMm: [centre.x * MM, centre.y * MM, centre.z * MM],
      camVsBoreDeg: ang(camDir, aim),
      camVsHeadDeg: haveHead ? ang(camDir, head) : null,
      jawOffAxisMm: haveJaw ? jaw.distanceTo(this.at) * MM : null,
      jawToCarveMm: haveJaw ? jaw.distanceTo(centre) * MM : null,
      carveAheadMm: ahead, carveUpMm: lift, carveSideMm: side,
      reachMm: this.at.distanceTo(centre) * MM,
      willBite,
    };
  }

  /**
   * STOP THE WORLD, KEEP DRAWING IT.
   *
   * `simulate` is skipped; the render is not. A pause that blanked the
   * screen would be a scene change, and the thing a pause menu has to prove
   * — that nothing was lost — is proved by the island still being there
   * behind it, mid-stride.
   *
   * The clock is not stopped, only ignored: `animate` recomputes `previous`
   * every frame whether it simulates or not, so a resume after five minutes
   * costs one frame of `dt`, not five minutes of it.
   */
  setPaused(on: boolean): void {
    this.paused = on;
    /* Her feet are still on the stick from before the menu went up. Let go
     * for her, or she walks off the moment it comes down. */
    if (on) { this.input.walk = 0; this.input.yaw = 0; this.input.strafe = 0; }
  }

  get isPaused(): boolean { return this.paused; }

  /**
   * Open or close the DEV drawer, and say which it now is.
   *
   * The handle used to be a pill at the bottom of the action rail, where it
   * was both the brightest thing on a tidied HUD and — being the last child
   * of a bottom-anchored column — 38px of headroom taken off the game's own
   * controls. It lives on the pause menu now. The drawer itself did not
   * move.
   */
  toggleDev(): boolean { return this.toggleDevDrawer?.() ?? false; }

  /** The MENU plate was pressed. See `IslandBoot.onMenu`. */
  openMenu(): void {
    if (this.boot.onMenu) { this.boot.onMenu(); return; }
    window.location.href = import.meta.env.BASE_URL;
  }

  setPausedForTest(on: boolean): void { this.setPaused(on); }

  /** Where the next stroke would land, and what it is aimed at — the numbers
   *  behind "it says it dug and nothing happened". */
  biteProbeForTest(): { seatMm: number; aimDeg: number; upY: number; ceilMm: number } {
    const aim = this.boreAim();
    const spot = new THREE.Vector3();
    const hit = this.biteCentre(aim, NOSE_REACH + JAW_PAST_NOSE, spot);
    return {
      seatMm: hit ? spot.distanceTo(this.at) * MM : -1,
      aimDeg: (this.aimPitch * 180) / Math.PI,
      upY: this.up.y,
      ceilMm: this.bandTop.value * MM,
    };
  }

  /**
   * Point the shovel, from a probe.
   *
   * It writes the LOOK, because that is the input now: `aimPitch` is
   * derived from it every frame, so setting the derived value alone lasted
   * exactly until the next camera update. Both are set so the very next
   * `boreAim()` — before any frame has run — already reads the new angle.
   */
  aimPitchForTest(radians: number): void {
    this.lookPitch = radians;
    this.aimPitch = radians;
    this.lookIdle = 0;
  }

  /** What the soil let her head have this frame. See `clampedHeadPitch`. */
  headPitchForTest(): { want: number; allowed: number; neck: number } {
    return {
      want: this.lookPitch,
      allowed: clampedHeadPitch(this.cameraHost),
      neck: this.headPitchNow,
    };
  }

  /**
   * TURN THE LEG SOLVER OFF, to tell a gait fault from a solver fault.
   *
   * Everything upstream keeps running — the corner scheduler, the anchors,
   * the clip, her body — and only the bending of the legs to reach those
   * anchors stops. If feet still stick with this off, the IK was never the
   * problem.
   *
   * Reachable three ways, because the interesting case is on a phone:
   * `?ik=off` in the URL, `window.islandScene.setIK(false)` from a console,
   * and the colonists follow her so the whole colony is one switch.
   */
  setIK(on: boolean): void {
    this.queen.ikEnabled = on;
    for (const one of this.colony) one.model.ikEnabled = on;
  }

  get ikEnabled(): boolean { return this.queen.ikEnabled; }

  /** Whatever the switch is set to now — colonists arrive later and ask. */
  private get ikWanted(): boolean { return this.queen.ikEnabled; }

  /**
   * THE CORNER, IN ONE LINE — for a probe or a console, never for a frame.
   *
   * `FL NEW/PLANT FR NEW/SWING ML OLD/PLANT ...` with the phase, how far the
   * two surfaces disagree, how near the tracked candidate is, and how many
   * feet are actually down. Built only when someone asks: the report itself
   * is state the drive already holds, and this costs a string.
   */
  /**
   * One frame into the recorder, in the units a reader thinks in.
   *
   * Everything here is state the scene already holds — the cost is a small
   * object per frame and nothing at all once sixty seconds are up.
   */
  private readonly telemPrev = new THREE.Vector3();
  private telemHasPrev = false;

  private recordTelemetry(dt: number): void {
    const r = this.driveReport;
    this.telemetry.offer({
      x: this.at.x * VOXEL_MM, y: this.at.y * VOXEL_MM, z: this.at.z * VOXEL_MM,
      upX: this.up.x, upY: this.up.y, upZ: this.up.z,
      walk: this.input.walk,
      yaw: this.input.yaw,
      strafe: this.input.strafe,
      sprint: this.input.sprint,
      crawl: this.input.crawl,
      reqMmS: this.velocity.length() * VOXEL_MM,
      /*
       * MEASURED, NOT CLAIMED. r.movedMm is what the drive believes it did,
       * and against the anti-embed treadmill the drive believed 7.5 mm/s
       * while the body was pinned to the millimetre for seventeen seconds —
       * the one log column that could have named the bug read healthy.
       * Forward-projected so a snap backward shows as negative.
       */
      actMmS: dt > 1e-6 && this.telemHasPrev
        ? (S_SPOT.copy(this.at).sub(this.telemPrev).dot(this.fwd) * VOXEL_MM) / dt
        : 0,
      heldBackMm: r?.heldBackMm ?? 0,
      planted: r?.planted ?? 0,
      groping: r?.groping ?? 0,
      strain: r?.strain ?? 0,
      allowed: r?.allowed ?? 1,
      clearanceMm: r?.clearanceMm ?? 0,
      seatMm: this.seatLiftMm,
      phase: r?.corner.phase ?? 'none',
      turnDeg: r?.corner.turnDeg ?? 0,
      candidateMm: r?.corner.candidateMm ?? 0,
      onNew: r?.corner.onNew ?? 0,
      onOld: r?.corner.onOld ?? 0,
    }, dt);
    this.telemPrev.copy(this.at);
    this.telemHasPrev = true;
    if (this.telemetryChip) {
      const st = this.telemetry.status;
      this.telemetryChip.textContent = st === 'recording'
        ? `REC ${this.telemetry.elapsed.toFixed(0)}s`
        : st === 'stopped' ? `LOG ${this.telemetry.count}f` : 'REC';
      this.telemetryChip.style.color = st === 'recording' ? '#f87171' : '';
    }
    /* The pose numbers ease toward what the stick asked for, so they change
     * on frames where nothing was touched — the readout has to be driven by
     * the clock rather than by the button that started it. */
    this.refreshPoseChips();
  }

  /** The recording as pasteable text — the console hook, for a probe. */
  telemetryReport(): string {
    return this.telemetry.report(
      `THRONEMOUND TELEMETRY v${__APP_VERSION__} — max ${TELEMETRY_MAX_SECONDS}s`,
    );
  }

  cornerLineForTest(): string {
    const r = this.driveReport?.corner;
    if (!r) return 'no drive';
    const feet = r.feet.map((f) => (
      `${f.slot.replace(/[a-z]/g, '').padEnd(2)} ${f.owner.toUpperCase()}/${f.state}`
    ));
    return `${r.phase} turn=${r.turnDeg}deg cand=${r.candidateMm}mm `
      + `new=${r.onNew} old=${r.onOld} planted=${r.planted} | ${feet.join('  ')}`;
  }

  stepForTest(dt: number, steps: number): void {
    for (let i = 0; i < steps; i += 1) this.simulate(dt);
  }

  setFacingForTest(radians: number): void {
    /* Three things have to agree or the next frame undoes this: the rig owns
     * the heading, the heading's LAST value is what a turn is measured
     * against, and her nose is what actually points anywhere. */
    this.facing = radians;
    this.bore.turn(radians - this.bore.heading);
    this.headingWas = this.bore.heading;
    this.fwd.set(Math.sin(radians), 0, Math.cos(radians));
    this.walker?.squareForward({ at: this.at, up: this.up, forward: this.fwd });
  }

  teleportMm(xMm: number, zMm: number): void {
    this.at.x = xMm / MM;
    this.at.z = zMm / MM;
    this.at.y = this.walkGroundAt(this.at.x, this.at.z) + RIDE;
    this.velocity.set(0, 0, 0);
    this.underground = false;
    this.enclosed = false;
    this.hasSafe = false;
    /* Set down the right way up wherever she lands, gripping again. Carrying
     * a ceiling's attitude across a teleport would have her arrive upside
     * down over open ground and fall off the hill. */
    this.up.set(0, 1, 0);
    if (this.walker) {
      this.walker.gripping = true;
      this.walker.fallSpeed = 0;
      this.walker.squareForward({ at: this.at, up: this.up, forward: this.fwd });
    }
    /* Her feet are anchored to world points; a teleport leaves them behind
     * on ground she is no longer standing on. */
    this.drive?.plantAll(
      { at: this.at, up: this.up, forward: this.fwd }, this.groundForLegs,
    );
    if (this.stream) {
      const scroll = this.stream.recentreOn(this.at.x, this.at.z);
      if (scroll) this.onScroll(scroll);
    }
  }

  /* ------------------------------------------------------------ the save */

  /**
   * Write her nest and her whereabouts to storage. False when it could not.
   *
   * False rather than a throw: storage is denied in private browsing and full
   * on a loaded phone, and neither is worth taking a running game down for.
   * The caller says so instead.
   */
  saveToStorage(): boolean {
    if (!this.stream) return false;
    const save: IslandSave = {
      v: ISLAND_SAVE_V,
      when: Date.now(),
      at: [this.at.x, this.at.y, this.at.z],
      up: [this.up.x, this.up.y, this.up.z],
      fwd: [this.fwd.x, this.fwd.y, this.fwd.z],
      facing: this.facing,
      dug: toBase64(this.stream.serializeEdits()),
    };
    try {
      window.localStorage.setItem(ISLAND_SAVE_KEY, JSON.stringify(save));
      return true;
    } catch {
      return false;
    }
  }

  /** Is there a save worth offering a RESUME for? */
  static hasSave(): boolean {
    try {
      return parseIslandSave(window.localStorage.getItem(ISLAND_SAVE_KEY)) !== null;
    } catch {
      return false;
    }
  }

  /** When it was written, for a menu that wants to say so. */
  static savedWhen(): number {
    try {
      return parseIslandSave(window.localStorage.getItem(ISLAND_SAVE_KEY))?.when ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Put a saved island back: the digs first, then her.
   *
   * THAT ORDER IS THE WHOLE THING. Her seat is derived from the soil beneath
   * her, so placing her before the tunnels exist seats her on ground that is
   * about to be removed — she would be left standing inside her own nest's
   * ceiling. Restoring the soil first means the frame that places her reads
   * the world she actually saved.
   *
   * A save that will not parse leaves the fresh island exactly as it was; a
   * save whose BYTES are bad is dropped, because `restoreEdits` refuses
   * before touching the store and there is nothing half-applied to undo.
   */
  resumeFromStorage(): boolean {
    if (!this.stream) return false;
    const save = (() => {
      try { return parseIslandSave(window.localStorage.getItem(ISLAND_SAVE_KEY)); } catch {
        return null;
      }
    })();
    if (!save) return false;
    try {
      this.stream.restoreEdits(fromBase64(save.dug));
    } catch {
      /* A save we cannot read is not a save. Left in storage rather than
       * deleted: it costs nothing, and a future build may understand it. */
      return false;
    }
    this.at.set(save.at[0], save.at[1], save.at[2]);
    this.up.set(save.up[0], save.up[1], save.up[2]).normalize();
    this.fwd.set(save.fwd[0], save.fwd[1], save.fwd[2]).normalize();
    this.facing = save.facing;
    this.bore.turn(save.facing - this.bore.heading);
    this.headingWas = this.bore.heading;
    this.velocity.set(0, 0, 0);
    if (this.walker) {
      this.walker.gripping = true;
      this.walker.fallSpeed = 0;
      this.walker.squareForward({ at: this.at, up: this.up, forward: this.fwd });
    }
    /* Her feet were anchored to world points on the island she left. */
    this.drive?.plantAll(
      { at: this.at, up: this.up, forward: this.fwd }, this.groundForLegs,
    );
    /* The window follows her, and every chunk it holds is now wrong: the
     * soil under it has just changed everywhere she ever dug. */
    const scroll = this.stream.recentreOn(this.at.x, this.at.z);
    if (scroll) this.onScroll(scroll);
    this.remeshEverything();
    return true;
  }

  drainQueueForTest(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.queued.delete(this.key(job.cx, job.cy, job.cz));
      this.meshChunk(job.cx, job.cy, job.cz);
    }
    this.reveal();
  }

  /** Is there soil at this ABSOLUTE mm position? Off the LIVE field. */
  solidAtMm(xMm: number, yMm: number, zMm: number): boolean | null {
    const stream = this.stream;
    if (!stream) return null;
    const x = Math.round((xMm / MM - stream.originWorldX) / CELL_SIZE);
    const z = Math.round((zMm / MM - stream.originWorldZ) / CELL_SIZE);
    const y = Math.round(yMm - stream.bandFloorMm);
    if (x < 0 || x > WINDOW_CELLS || z < 0 || z > WINDOW_CELLS
      || y < 0 || y >= SAMPLES_Y) return null;
    return stream.field.get(x, y, z) > 0;
  }

  planForTest(): { id: string; x: number; y: number; z: number }[] {
    return (this.soil?.plan.nodes ?? []).map(
      (n) => ({ id: n.id, x: n.x, y: n.y, z: n.z }),
    );
  }

  /** Elevation in real metres at a position in island millimetres. */
  heightAtMm(xMm: number, zMm: number): number {
    return this.groundHeightAt(xMm / MM, zMm / MM) * MM;
  }

  /** The DRAWN surface's elevation (real m) — what standing-on must match. */
  renderedHeightAtMm(xMm: number, zMm: number): number {
    if (!this.heights) return 0;
    return this.renderedOn(this.heights, xMm, zMm);
  }

  /** Fire a toast from a probe, so a shot can catch it lit. */
  toastForTest(text: string): void { this.toastCombat(text); }

  statsForTest(): Record<string, number> {
    return {
      verts: this.terrainVerts,
      tris: this.terrainTris,
      loaded: this.heights ? 1 : 0,
      meshed: this.chunkMeshes.size,
      queued: this.queue.length,
      edited: this.stream?.editedSamples ?? 0,
      scrolls: this.stats.scrolls,
      rebases: this.stats.rebases,
      bandFloorMm: this.stream?.bandFloorMm ?? -1,
      underground: this.underground ? 1 : 0,
      /* The sense's own flag, reported beside the camera's so a probe can
       * tell the two apart — they are meant to disagree in an open pit. */
      enclosed: this.enclosed ? 1 : 0,
      ...this.vitals.report(),
      combatPhase: this.combat.phase === 'stinging' ? 2
        : this.combat.phase === 'gripped' ? 1 : 0,
      venom: +this.combat.venom.toFixed(3),
      stingsLeft: this.combat.stingsLeft,
      quarry: this.quarry.length,
      quarryUp: this.quarry.filter((q) => q.alive).length,
      pace: this.pace,
      canRun: this.vitals.canRun ? 1 : 0,
      firstPerson: this.firstPerson ? 1 : 0,
      aimDeg: (this.aimPitch * 180) / Math.PI,
      scoopWideMm: SCOOP_WIDE_MM,
      scoopTallMm: SCOOP_TALL_MM,
      scoopDeepMm: SCOOP_DEEP_MM,
      digMode: this.digMode ? 1 : 0,
      questStage: this.questStage,
      questDepthMm: +this.depthMm().toFixed(1),
      deepCarved: this.deepCarved,
      workerOut: this.colony.filter((c) => c.ready).length,
      playerReady: this.playerReady ? 1 : 0,
      statsOpen: this.statsPanel.bodyVisible ? 1 : 0,
      designing: this.designer?.isOpen ? 1 : 0,
      planNodes: this.soil?.plan.nodes.length ?? 0,
      designX: this.designOriginMm.x,
      designY: this.designOriginMm.y,
      designZ: this.designOriginMm.z,
    };
  }

  /** The whole plan, deep-copied, in island mm — for probes to extend. */
  currentPlanForTest(): NestPlan {
    return JSON.parse(JSON.stringify(this.soil!.plan)) as NestPlan;
  }

  /** Run the designer's DIG IT pipeline on a plan in island mm. */
  applyPlanForTest(plan: NestPlan): void {
    this.applyPlan(plan);
  }

  closeDesignerForTest(): void {
    this.closeDesigner();
  }

  private readonly refuseGesture = (e: Event): void => { e.preventDefault(); };

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.stopContextGuard?.();
    this.stopContextGuard = null;
    this.clearGpuNotice();
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.host.removeEventListener(name, this.refuseGesture);
    }
    this.statsPanel.dispose();
    this.designer?.dispose();
    this.scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const mesh of this.stands.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.stands.clear();
    this.forestMaterial?.dispose();
    this.tree?.dispose();
    this.islandMaterial?.dispose();
    this.soilMaterial?.dispose();
    if (this.textures) for (const tex of Object.values(this.textures)) tex.dispose();
    this.nestView?.dispose();
    this.queen.dispose();
    for (const one of this.colony) one.dispose();
    for (const q of this.quarry) q.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}

