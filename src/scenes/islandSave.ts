/**
 * SAVING THE ISLAND — where she stood, and every hole she made.
 *
 * The island lost everything on reload until now, which is the one thing that
 * made digging feel provisional: a tunnel is an hour's work and it evaporated
 * when the tab did.
 *
 * It is small because the soil is a pure function of position. Nothing about
 * the island has to be stored except what she CHANGED about it — the sparse
 * edit map, through `IslandStream.serializeEdits` — plus the handful of
 * numbers saying where she is. A dug nest is kilobytes.
 *
 * WHAT IS NOT HERE is as deliberate as what is. No mesh, no chunk cache, no
 * heightfield: all three are derivable, and a save that carries derived data
 * is a save that goes stale against its own generator the next time the
 * terrain function is touched. And no camera, no HUD state, no pace latch —
 * those are how you were looking at the world, not what the world is.
 */

/** Bumped when the shape below changes in a way an old save cannot satisfy. */
export const ISLAND_SAVE_V = 1;

export const ISLAND_SAVE_KEY = 'thronemound.island.v1';

export interface IslandSave {
  v: number;
  /** Epoch millis, for "saved 2 minutes ago" in a menu. */
  when: number;
  /** Her physics root, her up and her nose — the walker's whole frame. */
  at: [number, number, number];
  up: [number, number, number];
  fwd: [number, number, number];
  /** The rig's heading, which is not derivable from `fwd` up a vertical wall. */
  facing: number;
  /** `IslandStream.serializeEdits`, base64'd so it survives JSON. */
  dug: string;
}

const isTriple = (v: unknown): v is [number, number, number] => (
  Array.isArray(v) && v.length === 3
  && v.every((n) => typeof n === 'number' && Number.isFinite(n))
);

/**
 * Bytes to base64 without `btoa`'s argument limit.
 *
 * A dug nest runs to tens of thousands of samples, and
 * `btoa(String.fromCharCode(...bytes))` spreads every one of them into an
 * argument list — which throws a range error somewhere past a hundred
 * thousand, exactly when a save is worth having. Chunked instead.
 */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    s += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Read a save back, or null.
 *
 * Null rather than a throw, and checked field by field, because the only
 * caller is a menu deciding whether to offer RESUME. A save from an older
 * build, a half-written one, or something else entirely under the same key
 * must all come back as "there is no save" rather than as an exception on
 * the boot path.
 */
export function parseIslandSave(raw: string | null): IslandSave | null {
  if (!raw) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const s = o as Record<string, unknown>;
  if (s.v !== ISLAND_SAVE_V) return null;
  if (!isTriple(s.at) || !isTriple(s.up) || !isTriple(s.fwd)) return null;
  if (typeof s.facing !== 'number' || !Number.isFinite(s.facing)) return null;
  if (typeof s.dug !== 'string') return null;
  const when = typeof s.when === 'number' && Number.isFinite(s.when) ? s.when : 0;
  return {
    v: ISLAND_SAVE_V, when, at: s.at, up: s.up, fwd: s.fwd, facing: s.facing, dug: s.dug,
  };
}

/** A short "when", for a menu that has to say whether a resume is stale. */
export function savedAgo(when: number, now: number): string {
  if (!when) return 'saved';
  const s = Math.max(0, Math.round((now - when) / 1000));
  if (s < 60) return 'saved just now';
  const m = Math.round(s / 60);
  if (m < 60) return `saved ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `saved ${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'saved yesterday' : `saved ${d}d ago`;
}
