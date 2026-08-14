/**
 * THE FOUNDING — the quest that opens the game, and the colony it hatches.
 *
 * Four stages: dig the entrance, hollow the chamber, hold a black beat
 * while the story turns over, and then the first worker is out on the
 * surface. Plus the HUD that reports it — the vitals panel, the colony
 * strip and the quest line, which are the only things on screen that are
 * about the COLONY rather than about driving an ant.
 *
 * Split out of `IslandScene` on a narrow seam: sixteen members for three
 * hundred lines, because the founding is genuinely its own subject. See
 * `islandCamera.ts` for why these are free functions over a host
 * interface.
 */
import * as THREE from 'three';
import type { SurfaceWalker } from '../world/surfaceWalk';
import { Colonist } from './Colonist';
import { stageOf, type Vitals } from './islandVitals';
import type { Carry, ColonyStores } from './islandCarry';

/** The four, named once so a typo cannot invent a fifth. */
export type VitalKind = 'health' | 'stamina' | 'energy' | 'water';

/** A bar the HUD keeps current, and the last percent it was told. */
export interface VitalBar {
  kind: VitalKind;
  fill: HTMLElement;
  shown: number;
}
import { MM } from '../world/worldScape';
import type { Ground } from '../anim/legDrive';
import {
  COLONIST_ARRIVE, COLONIST_ROAM, QUEST_CHAMBER_SAMPLES, QUEST_DEPTH_MM,
} from './islandTuning';

/** What the founding may reach, and nothing else. */
export interface QuestHost {
  readonly scene: THREE.Scene;
  readonly at: THREE.Vector3;
  readonly hud: HTMLElement;
  readonly colony: Colonist[];
  walker: SurfaceWalker | null;
  ikWanted: boolean;
  questStage: number;
  deepCarved: number;
  questEl: HTMLElement | null;
  /* The card's three live pieces, and the last thing written to them. */
  questTitleEl: HTMLElement | null;
  questBlurbEl: HTMLElement | null;
  questStepsEl: HTMLElement | null;
  questShown: string;
  cineEl: HTMLElement | null;
  cineUntil: number;
  workersOutEl: HTMLElement | null;
  workersOutShown: number;
  workerAnchor: THREE.Vector3;
  readonly vitals: Vitals;
  readonly vitalBars: VitalBar[];
  /** The numbers printed over the live bars, and the last text written. */
  readonly vitalNums: { kind: VitalKind; el: HTMLElement; shown: string }[];
  headCountEl: HTMLElement | null;
  headCountShown: number;
  /** What is in her jaws, for the carry meter. See `islandCarry.ts`. */
  readonly carry: Carry;
  /** The colony's larder, for the FOOD cell. */
  readonly stores: ColonyStores;
  foodEl: HTMLElement | null;
  foodShown: number;
  carryEl: HTMLElement | null;
  carryShown: number;
  readonly groundForLegs: Ground;
  walkGroundAt(x: number, z: number): number;
  /** The MENU plate was pressed. The scene decides what that costs. */
  openMenu(): void;
}

/** How far below the ORIGINAL ground she is, in mm. Never negative. */
export function depthMm(host: QuestHost, ): number {
  return Math.max(
    0, (host.walkGroundAt(host.at.x, host.at.z) - host.at.y) * MM,
  );
}

export function questTick(host: QuestHost, dt: number): void {
  if (!host.questEl) buildQuestHud(host);
  if (host.questStage === 0 && depthMm(host) >= QUEST_DEPTH_MM) {
    host.questStage = 1;
  } else if (host.questStage === 1 && host.deepCarved >= QUEST_CHAMBER_SAMPLES) {
    host.questStage = 2;
    host.cineUntil = performance.now() + 5200;
    if (host.cineEl) host.cineEl.classList.add('is-on');
    spawnWorker(host);
  } else if (host.questStage === 2 && performance.now() > host.cineUntil) {
    host.questStage = 3;
    if (host.cineEl) host.cineEl.classList.remove('is-on');
  }
  renderQuest(host);
  poseWorker(host, dt);
}

/**
 * THE TOP-LEFT CLUSTER — portrait, vitals, colony.
 *
 * Built to the design's measurements to the pixel: portrait 62, health
 * 205 x 14, stamina 190 x 11, food and water 90 x 8, colony strip
 * 260 x 42. The point of pinning those numbers now is that the layout
 * gets judged at its real density rather than at a sketch of one.
 *
 * What it deliberately does NOT do is show a reading for a system that
 * does not exist. Health, stamina, hunger and thirst have no game behind
 * them — no field, no tick, nothing in `statsForTest` — so their frames
 * are hatched and dimmed, exactly as BITE and CARRY are on the action
 * cluster. Workers out is real, counted off the colony, and is the one
 * thing in here lit at full.
 */
export function buildVitalsHud(host: QuestHost, ): void {
  const panel = document.createElement('div');
  panel.className = 'tm-vitals';

  /* Her own medallion now, rather than a system-font ant sitting in a
   * plate borrowed from the button set. */
  const portrait = document.createElement('div');
  portrait.className = 'tm-portrait';
  portrait.setAttribute('role', 'img');
  portrait.setAttribute('aria-label', 'The Queen');
  /*
   * THE BADGE, and what it is allowed to say.
   *
   * The reference draws a gold disc on the portrait carrying a level. There
   * is no XP and no levelling in this game, so a level would be a number I
   * made up sitting on the most-looked-at object on screen. What IS true
   * and worth watching is the colony's HEAD COUNT — the queen, plus every
   * worker that has eclosed. It starts at 1 and it is the whole point of
   * the founding.
   */
  const badge = document.createElement('span');
  badge.className = 'tm-portrait-badge';
  badge.title = 'Colony — the queen and every worker out';
  portrait.appendChild(badge);
  host.headCountEl = badge;
  panel.appendChild(portrait);

  const bars = document.createElement('div');
  bars.className = 'tm-vitals-bars';
  panel.appendChild(bars);

  /*
   * The icon LABELS the bar; it does not report it. A bar with a system
   * behind it is lit and gets a fill; one without keeps the hatch, which
   * says NO SIGNAL rather than empty. Health and stamina go live with
   * `islandVitals`; food and water stay hatched because there is nothing
   * to eat and nothing to drink, and a bar that can only fall is worse
   * than an honest empty frame.
   */
  const bar = (kind: VitalKind, label: string, live: boolean): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'tm-vital';
    const icon = document.createElement('i');
    icon.className = `tm-vital-icon tm-vi-${kind}${live ? ' is-live' : ''}`;
    const el = document.createElement('div');
    el.className = `tm-bar tm-bar-${kind}${live ? '' : ' is-soon'}`;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', live ? label : `${label} — not implemented yet`);
    const fill = document.createElement('div');
    fill.className = 'tm-bar-fill';
    el.appendChild(fill);
    /*
     * THE NUMBERS, over the bar, as the reference draws them. A bar says
     * "about two thirds"; a player deciding whether to start a fight wants
     * "862 / 1,050". Only on a bar with a system behind it — a readout on a
     * hatched frame would be a number nobody could act on.
     */
    if (live) {
      const num = document.createElement('span');
      num.className = 'tm-bar-num';
      el.appendChild(num);
      host.vitalNums.push({ kind, el: num, shown: '' });
    }
    row.append(icon, el);
    if (live) host.vitalBars.push({ kind, fill, shown: -1 });
    return row;
  };

  /*
   * ALL FOUR ARE LIVE NOW. Energy and water were hatched because there was
   * no way to refill them; a nestmate is that way, and until there is a
   * nestmate they do not drain at all — see `Vitals.feeding`.
   *
   * FOOD became ENERGY on the same change, and the rename is the point:
   * an adult fire ant runs on liquid carbohydrate she is handed, while
   * solid prey belongs to the colony and is processed by larvae. Her bar
   * and the colony's store are different economies, so they get different
   * words.
   */
  bars.appendChild(bar('health', 'Health', true));
  bars.appendChild(bar('stamina', 'Stamina', true));
  const pair = document.createElement('div');
  pair.className = 'tm-vitals-pair';
  pair.appendChild(bar('energy', 'Energy', true));
  pair.appendChild(bar('water', 'Water', true));
  bars.appendChild(pair);

  host.hud.appendChild(panel);

  const colony = document.createElement('div');
  colony.className = 'tm-colony';
  const cell = (
    glyph: string, value: string, label: string, live: boolean,
  ): HTMLElement => {
    const c = document.createElement('div');
    c.className = `tm-colony-cell${live ? '' : ' is-soon'}`;
    const icon = document.createElement('i');
    icon.className = `tm-colony-icon tm-ci-${glyph}`;
    const text = document.createElement('div');
    text.className = 'tm-colony-text';
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('span');
    s.textContent = label;
    text.append(b, s);
    c.append(icon, text);
    return c;
  };
  const workers = cell('worker', '0', 'WORKERS', true);
  host.workersOutEl = workers.querySelector('b');
  /*
   * FOOD IS REAL NOW, and it is the colony's rather than hers — milligrams
   * of protein she has carried home. BROOD stays dimmed because there are
   * still no larvae, which is also what makes the store honest: it is a
   * pile waiting on a digestion nothing has written yet.
   */
  const food = cell('food', '0', 'FOOD', true);
  host.foodEl = food.querySelector('b');
  colony.append(
    workers,
    cell('brood', '—', 'BROOD', false),
    food,
  );
  host.hud.appendChild(colony);

  /*
   * THE CARRY METER, beside the colony strip and dimmed.
   *
   * CARRY is registered in antKinds.ts with `built: false`, so there is
   * nothing to report and the meter says so: hatched, no fill element at
   * all, exactly as energy and water read before v0.1.24 made them live.
   * Drawn rather than withheld for the reason the dimmed plates are drawn —
   * absent says nothing, dimmed says coming.
   *
   * It is here now because frame-meter is here now. The frame is a
   * medallion with a run beside it, which is a picture of a thing held.
   */
  const carry = document.createElement('div');
  /*
   * NO LONGER `is-soon`. CARRY is built, so the hatch comes off and the
   * bar reports a real load — the promise the dimmed plate was making
   * since v0.1.25, kept in the same commit as the mechanic.
   */
  carry.className = 'tm-meter tm-meter-carry';
  carry.setAttribute('role', 'img');
  carry.setAttribute('aria-label', 'Carrying');
  /*
   * STONE, THEN READOUT, THEN RIM — and the order is the whole point.
   *
   * The readout overshoots into the rim and the rim is painted over the top
   * of it, so the gold hides the join. That is the only arrangement that
   * cannot show a seam: landing the readout exactly on the frame's boundary
   * was tried three times and the boundary is a fraction of a pixel wide,
   * so it either left a black gap or covered the gold.
   *
   * The frame is therefore drawn TWICE — the lower pass brings the stone
   * the art has always carried, the upper pass brings only the rim. A child
   * always paints above its parent's border, so neither can be the
   * container's own border-image; both are siblings. See the CSS.
   *
   * THE LEVEL IS NOT AN ELEMENT. It is the track's own background, set by
   * `--tm-level` (0 to 1), because a CSS mask clips the element's background
   * but NOT a child — which is why the fill kept coming out square-ended
   * across a channel whose ends are curved.
   */
  const stone = document.createElement('div');
  stone.className = 'tm-meter-stone';
  /* The level, between the two passes of the frame: above the stone the
   * lower pass draws, below the rim the upper one does. Drawn art rather
   * than a CSS shape — see the CSS. */
  const level = document.createElement('div');
  level.className = 'tm-meter-level';
  const track = document.createElement('div');
  track.className = 'tm-meter-track';
  const label = document.createElement('span');
  label.className = 'tm-meter-label';
  label.textContent = 'CARRY';
  const frame = document.createElement('div');
  frame.className = 'tm-meter-frame';
  carry.append(stone, track, frame, level, label);
  host.carryEl = carry;
  host.hud.appendChild(carry);
}

export function buildQuestHud(host: QuestHost, ): void {
  buildVitalsHud(host);
  host.questEl = document.createElement('div');
  /*
   * THIRD IN THE LEFT COLUMN, under the vitals and the colony strip.
   *
   * It used to be centred on the top edge, which worked while the top-left
   * held nothing but a chip. It does not work now: on a phone narrower
   * than the design canvas the centred box reaches back across the vitals
   * panel and the two draw on top of each other — reported with a
   * screenshot of exactly that. Centring cannot be made safe here, because
   * the narrower the screen the further left the box starts.
   *
   * So it joins the column it belongs to. The design asks for a quest
   * PANEL at 210-235 wide, which is what this now is.
   */
  /*
   * THE OBJECTIVE CARD, to the blueprint's shape.
   *
   * It was one line of text inside an ornate gold frame — "QUEST · dig the
   * entrance · 0/25 mm down" — which said the right thing in the wrong
   * form. The reference draws a CARD: a badge, a title, a sentence of
   * guidance, and then the objective broken into steps with their own
   * progress and a tick when one is done. That is a different amount of
   * information, not a restyling of the same amount, which is why this is
   * markup rather than a stylesheet change.
   *
   * The frame goes with it. A carved gold border is the right dressing for
   * a plate you press; on a readout this size it spends thirty pixels of a
   * short screen on rim and crowds the thing it is framing.
   */
  host.questEl.className = 'tm-quest';
  host.questEl.innerHTML = '<div class="tm-quest-head">'
    + '<span class="tm-quest-badge">!</span>'
    + '<div class="tm-quest-lede">'
    + '<div class="tm-quest-title"></div>'
    + '<div class="tm-quest-blurb"></div>'
    + '</div></div>'
    + '<div class="tm-quest-steps"></div>';
  host.questTitleEl = host.questEl.querySelector('.tm-quest-title');
  host.questBlurbEl = host.questEl.querySelector('.tm-quest-blurb');
  host.questStepsEl = host.questEl.querySelector('.tm-quest-steps');
  host.hud.appendChild(host.questEl);

  /*
   * SENSE AND MENU, top right, off on their own.
   *
   * MENU is not decoration and is the reason this pair goes in now:
   * "Congratulations, you have entered Thronemound. There is no exit."
   * Once START is pressed there has been no way back to the front door
   * short of retyping the address, which is a real dead end rather than a
   * missing nicety.
   *
   * WHAT IT DOES IS NOT DECIDED HERE, and that is the fix. This plate used
   * to run `window.location.href = BASE_URL` itself — a full page reload,
   * so the one control offering a way out was the one that threw the
   * session away, with no confirmation and nowhere to save first. Now it
   * asks the scene, and the scene asks whoever owns the page. See
   * `IslandBoot.onMenu` and `src/ui/PauseMenu.ts`.
   *
   * SENSE is drawn beside it and dimmed. The ping — a radius sweep that
   * lights up trails, prints and whatever else is close — does not exist,
   * and is deliberately NOT wired to the underground view, which already
   * switches itself on depth. A view mode and an ability are different
   * things and merging them would make both worse.
   */
  const utility = document.createElement('div');
  utility.className = 'tm-utility';
  host.hud.appendChild(utility);

  const util = (name: string, label: string, onPress: (() => void) | null): void => {
    const b = document.createElement('button');
    b.className = `density-lab-button tm-art tm-art-${name}${onPress ? '' : ' is-soon'}`;
    b.setAttribute('aria-label', label);
    if (onPress) {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(); });
    } else b.setAttribute('aria-disabled', 'true');
    utility.appendChild(b);
  };

  util('sense', 'Sense', null);
  util('menu', 'Menu', () => host.openMenu());

  /*
   * The founding cinematic, as the brief wrote it: a held black beat
   * while the colony's story turns over. DOM, not canvas — it must sit
   * over everything and cost nothing when off.
   */
  host.cineEl = document.createElement('div');
  host.cineEl.style.cssText = 'position:absolute;inset:0;z-index:40;'
    + 'display:flex;flex-direction:column;justify-content:center;'
    + 'align-items:center;gap:14px;text-align:center;padding:0 9vw;'
    + 'background:rgba(6,5,8,0.88);color:#e8dfc8;pointer-events:none;'
    + 'opacity:0;transition:opacity 1.1s ease;'
    + 'font-family:ui-monospace,monospace;';
  host.cineEl.innerHTML = '<div style="font-size:19px;letter-spacing:0.4px">'
    + 'The Queen has made this her home.</div>'
    + '<div style="font-size:14px;opacity:0.8">Now she waits for her '
    + 'first generation to emerge…</div>';
  const style = document.createElement('style');
  style.textContent = '.density-lab-hud > div.is-on { opacity: 1 !important; }';
  document.head.appendChild(style);
  host.hud.appendChild(host.cineEl);
}

export function renderQuest(host: QuestHost): void {
  /*
   * THE LIVE BARS, written only when they MOVE — and "move" means a whole
   * percent, not a float. A width assignment is a layout, this runs every
   * frame, and no eye can tell 61.4% of a 205px bar from 61.5%.
   */
  for (const b of host.vitalBars) {
    const pct = Math.round(host.vitals.fractionOf(b.kind) * 100);
    if (pct === b.shown) continue;
    b.shown = pct;
    b.fill.style.width = `${pct}%`;
    /* The two that can kill her say so before they do. Health and stamina
     * are read constantly and do not need to shout; a need she has stopped
     * thinking about is exactly the one that catches her out. */
    if (b.kind === 'energy' || b.kind === 'water') {
      const stage = stageOf(pct / 100);
      b.fill.parentElement?.classList.toggle('is-low', stage === 2);
      b.fill.parentElement?.classList.toggle('is-dire', stage === 3);
    }
  }
  /* The readouts over the bars. Same rule as the widths — written only when
   * the ROUNDED value moves, because this runs every frame and a
   * `textContent` assignment is a layout. */
  for (const n of host.vitalNums) {
    const { now, max } = host.vitals.absOf(n.kind);
    const text = n.kind === 'health' || n.kind === 'stamina'
      ? `${now} / ${max}` : String(now);
    if (text === n.shown) continue;
    n.shown = text;
    n.el.textContent = text;
  }

  /* The colony's head count on the queen's badge — her, plus everyone out. */
  if (host.headCountEl) {
    const heads = 1 + host.colony.reduce((k, c) => k + (c.ready ? 1 : 0), 0);
    if (heads !== host.headCountShown) {
      host.headCountShown = heads;
      host.headCountEl.textContent = String(heads);
    }
  }

  /* Written only when it CHANGES. It is one number on a HUD that runs
   * every frame, and a textContent assignment per frame is a layout the
   * browser did not need to do. */
  if (host.workersOutEl) {
    const out = host.colony.reduce((n, c) => n + (c.ready ? 1 : 0), 0);
    if (out !== host.workersOutShown) {
      host.workersOutShown = out;
      host.workersOutEl.textContent = String(out);
    }
  }
  /*
   * THE LARDER. Written only when it changes, same as the worker count —
   * this runs every frame and a `textContent` assignment is a layout.
   */
  if (host.foodEl) {
    const mg = Math.round(host.stores.proteinMg);
    if (mg !== host.foodShown) {
      host.foodShown = mg;
      host.foodEl.textContent = String(mg);
    }
  }
  /*
   * THE LOAD, to the whole percent — the same reason the vital bars round:
   * no eye reads 63.4% of a 128px run differently from 63.5%, and the
   * assignment is a repaint either way.
   */
  if (host.carryEl) {
    const pct = Math.round(host.carry.load * 100);
    if (pct !== host.carryShown) {
      host.carryShown = pct;
      host.carryEl.style.setProperty('--tm-level', String(pct / 100));
      /* Lit while she is actually holding something, so an empty meter is
       * quiet rather than a bar that is merely at zero. */
      host.carryEl.classList.toggle('is-loaded', pct > 0);
    }
  }
  renderQuestCard(host);
}

/**
 * THE OBJECTIVE, AS A CARD.
 *
 * Two steps because the founding genuinely has two — dig in, then hollow
 * the chamber — and they are the same two the quest has always tracked.
 * What is new is that both are on screen at once with their own progress,
 * so "how much of this is left" is a thing you can read rather than infer
 * from which sentence is showing.
 *
 * NOTHING HERE IS INVENTED. The reference card also carries a feed of
 * colony events beneath it — a worker idle, a water source found, brood
 * ready — and this does not, because none of those events exist yet. A
 * list of plausible-looking notifications would be the one thing on this
 * HUD that was not true. It is on the board instead.
 *
 * Written only when it CHANGES, like every other readout here: this runs
 * every frame and `innerHTML` is a parse.
 */
function renderQuestCard(host: QuestHost): void {
  if (!host.questEl || !host.questStepsEl) return;

  const deep = depthMm(host);
  const chamber = Math.min(
    100, Math.round((host.deepCarved / QUEST_CHAMBER_SAMPLES) * 100),
  );
  const done = host.questStage >= 3;

  const title = done ? 'THE COLONY BEGINS' : 'THE FOUNDING';
  const blurb = done
    ? 'The first worker is out. She is the proof the colony is real.'
    : 'Dig in, then hollow a chamber for the queen.';
  const steps = done ? [] : [
    {
      what: 'Dig the entrance',
      now: `${deep.toFixed(0)} / ${QUEST_DEPTH_MM} mm`,
      ok: host.questStage >= 1,
    },
    {
      what: "Hollow the queen's chamber",
      now: `${chamber}%`,
      ok: host.questStage >= 2,
    },
  ];

  const sig = `${title}|${steps.map((x) => `${x.what}${x.now}${x.ok}`).join('|')}`;
  if (sig === host.questShown) return;
  host.questShown = sig;

  if (host.questTitleEl) host.questTitleEl.textContent = title;
  if (host.questBlurbEl) host.questBlurbEl.textContent = blurb;
  host.questStepsEl.innerHTML = steps.map((x) => '<div class="tm-quest-step'
    + `${x.ok ? ' is-done' : ''}">`
    + '<span class="tm-quest-box"></span>'
    + `<span class="tm-quest-what">${x.what}</span>`
    + `<span class="tm-quest-num">${x.now}</span>`
    + '</div>').join('');
}

/**
 * The first worker: hatched where the chamber quest completed, wearing
 * the real worker rig, pottering a small patrol around her birthplace.
 * She is the payoff — proof the colony is REAL — not yet a colonist
 * with jobs; that part arrives with the sandbox mechanics.
 */
export function spawnWorker(host: QuestHost, ): void {
  if (host.colony.length > 0) return;
  host.workerAnchor.copy(host.at);
  /* A worker first, then a major beside her — the two castes the rig
   * actually ships and the two the sandbox mechanics were written for. */
  let seed = 0x51ce;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const caste of ['worker', 'major'] as const) {
    const one = new Colonist(caste, rand);
    one.model.ikEnabled = host.ikWanted;
    host.scene.add(one.model.root);
    host.colony.push(one);
    void one.load().then((ok) => {
      if (!ok) return;
      const a = rand() * Math.PI * 2;
      one.place(
        host.workerAnchor.x + Math.cos(a) * COLONIST_ARRIVE,
        host.workerAnchor.z + Math.sin(a) * COLONIST_ARRIVE,
        (x, z) => host.walkGroundAt(x, z),
      );
    });
  }
}

export function poseWorker(host: QuestHost, dt: number): void {
  const walker = host.walker;
  if (!walker || host.colony.length === 0) return;
  for (const one of host.colony) {
    one.step(
      dt,
      host.workerAnchor,
      COLONIST_ROAM,
      (x, z) => host.walkGroundAt(x, z),
      (p, into) => { walker.normalAt(p, into); },
      host.groundForLegs,
    );
  }
}
