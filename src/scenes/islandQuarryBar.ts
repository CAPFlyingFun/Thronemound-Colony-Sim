/**
 * A HEALTH BAR OVER THE THING SHE IS FIGHTING — and only when it says
 * something.
 *
 * Asked for from the device: "no HP bar over the enemy on attack (doesn't
 * need to always show… only when less than max, or tracking)". The bracket
 * is the design and it is a good one, so it is enforced here rather than
 * softened: a bar over every beetle at all times is a HUD standing in the
 * world, and the world is the thing this game is asking you to look at.
 *
 * SO IT APPEARS FOR EXACTLY TWO REASONS, and disappears again:
 *
 *   1. The creature is HURT. A full-health beetle pottering about is
 *      scenery; a damaged one is a story you started.
 *   2. She has HOLD of it. At full health, gripped, the bar is what tells
 *      you the biting is working — which is the whole complaint that
 *      prompted this: "I never did see the HP loss in the beetle".
 *
 * "Tracking" was the word used, and it could have meant the HUD's combat
 * mode, which is entered by PROXIMITY. That reading was rejected: anything
 * wandering near her would light up a bar, which is the always-on version
 * with extra steps. Gripped is the version where the player is doing
 * something to it.
 *
 * DOM RATHER THAN A SPRITE, the same call the pose editor's bone labels
 * made and for the same reasons: text and a thin bar are crisp at any zoom
 * for free, cost one `project` each, and add no textures to build, upload
 * and dispose. One pooled row per quarry, positioned by transform so moving
 * them is a compositor job rather than a layout.
 */
import * as THREE from 'three';
import type { Quarry } from './islandCombat';

const AT = new THREE.Vector3();

/** What the bar may touch. Deliberately tiny — it reads, it never writes. */
export interface QuarryBarHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly hud: HTMLElement;
  readonly quarry: readonly (Quarry & { at: THREE.Vector3; radius: number })[];
  /** What she has hold of, if anything. */
  readonly gripped: Quarry | null;
}

/** One row per quarry, made once and kept. */
export interface QuarryBars {
  layer: HTMLElement;
  rows: Map<string, { root: HTMLElement; fill: HTMLElement; shown: number }>;
}

export function buildQuarryBars(host: QuarryBarHost): QuarryBars {
  const layer = document.createElement('div');
  layer.className = 'tm-quarry-layer';
  host.hud.appendChild(layer);
  return { layer, rows: new Map() };
}

/**
 * Should this creature's bar be on screen at all?
 *
 * Pulled out as a pure function because it IS the design — the whole point
 * of the card was the bracket, and a rule that lives inside a rendering
 * loop is a rule nobody can test. See `tests/quarryBar.test.ts`.
 */
export function barWanted(q: Quarry, gripped: Quarry | null): boolean {
  /* A felled quarry is cargo, not an opponent. Its bar would be a zero
   * following a corpse about, which is worse than nothing. */
  if (!q.alive) return false;
  return q.hp < q.hpMax || q === gripped;
}

/**
 * How full, 0..1 — clamped, because venom can carry `hp` below zero for a
 * frame before the fell is noticed and a negative width is a layout bug
 * rather than a dead beetle.
 */
export function barLevel(q: Quarry): number {
  if (!(q.hpMax > 0)) return 0;
  return Math.min(1, Math.max(0, q.hp / q.hpMax));
}

/**
 * Place every bar for this frame.
 *
 * MUST RUN AFTER THE CAMERA IS POSITIONED. `project` reads the camera's
 * matrices, so calling this earlier in a frame puts every bar where its
 * beetle was last frame and the whole layer trails a pan. That is the exact
 * bug the pose editor's labels hit; recorded here so it is not re-learned.
 */
export function syncQuarryBars(host: QuarryBarHost, bars: QuarryBars): void {
  const rect = host.hud.getBoundingClientRect();
  const live = new Set<string>();
  for (const q of host.quarry) {
    if (!barWanted(q, host.gripped)) continue;
    live.add(q.id);
    let row = bars.rows.get(q.id);
    if (!row) {
      const root = document.createElement('div');
      root.className = 'tm-quarry';
      const fill = document.createElement('div');
      fill.className = 'tm-quarry-fill';
      root.appendChild(fill);
      bars.layer.appendChild(root);
      row = { root, fill, shown: -1 };
      bars.rows.set(q.id, row);
    }
    /* Above it rather than on it — its own radius is how much to clear, so
     * a bigger creature gets a bigger gap without a second constant. */
    AT.set(q.at.x, q.at.y + q.radius * 1.6, q.at.z).project(host.camera);
    if (AT.z > 1) { row.root.style.display = 'none'; continue; }
    row.root.style.display = '';
    row.root.style.transform = `translate(${
      (((AT.x + 1) / 2) * rect.width).toFixed(1)}px, ${
      (((1 - AT.y) / 2) * rect.height).toFixed(1)}px)`;
    /* To the whole percent, for the reason the vitals round: nothing reads
     * 63.4% of a 34px run differently from 63.5%, and the write is a
     * repaint either way. */
    const pct = Math.round(barLevel(q) * 100);
    if (pct !== row.shown) {
      row.shown = pct;
      row.fill.style.width = `${pct}%`;
      /* Hurt, badly hurt, nearly done — three states, because a colour that
       * slides continuously says less than one that changes. */
      row.root.classList.toggle('is-low', pct <= 50);
      row.root.classList.toggle('is-dire', pct <= 20);
    }
  }
  /* Anything that stopped qualifying loses its row outright rather than
   * being hidden: a felled beetle is removed from the scene eventually and
   * a Map that only ever grows is a leak with a long fuse. */
  for (const [id, row] of bars.rows) {
    if (live.has(id)) continue;
    row.root.remove();
    bars.rows.delete(id);
  }
}
