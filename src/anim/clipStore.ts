/**
 * WHERE CLIPS LIVE — the same split as `poseStore`, for the same reasons.
 *
 * A committed book shipped as JSON, a local book in browser storage, local
 * winning per name, and `revert` bringing the committed one back rather than
 * deleting anything. Storage is injected so a test or a headless probe gets a
 * working memory-only store instead of a throw.
 *
 * SEPARATE FROM THE POSE BOOK, deliberately. A clip and a pose are different
 * shapes, and one book holding both would have to guess which it was reading
 * on every entry — a guess that is wrong exactly when a file is damaged,
 * which is the moment it matters. Two keys, two parsers, no guessing. A pose
 * is still reachable from the timeline as a clip with a single key, which is
 * how the editor offers both without a second list.
 */

import { type AntClip, type ClipKey } from './clip';
import type { RigMap } from './hexapod';
import { parsePose } from './pose';

export const CLIP_KEY = 'thronemound.clips.v1';

export interface ClipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ClipBook = Record<string, AntClip>;

/**
 * Read a clip, dropping what this rig has not got.
 *
 * Null rather than a throw, and per-field, because the callers are a menu and
 * a boot path: a clip from an older build must read as "there is no clip",
 * never as an exception.
 */
export function parseClip(raw: unknown, rig: RigMap): AntClip | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== 'string') return null;
  if (!Array.isArray(c.keys)) return null;
  const duration = typeof c.duration === 'number' && Number.isFinite(c.duration) && c.duration > 0
    ? c.duration : 2;
  const keys: ClipKey[] = [];
  for (const entry of c.keys) {
    if (!entry || typeof entry !== 'object') continue;
    const k = entry as Record<string, unknown>;
    if (typeof k.t !== 'number' || !Number.isFinite(k.t)) continue;
    const pose = parsePose(k.pose, rig);
    if (!pose) continue;
    keys.push({ t: Math.max(0, k.t), pose: pose.pose });
  }
  keys.sort((a, b) => a.t - b.t);
  return {
    name: c.name, duration, loop: c.loop !== false, keys,
  };
}

export class ClipStore {
  private baked: ClipBook = {};

  private local: ClipBook = {};

  readonly persistent: boolean;

  constructor(private readonly rig: RigMap, private readonly storage?: ClipStorage) {
    this.persistent = !!storage;
    this.readLocal();
  }

  setBaked(raw: unknown): { loaded: number; skipped: string[] } {
    const out = this.read(raw);
    this.baked = out.book;
    return { loaded: Object.keys(out.book).length, skipped: out.skipped };
  }

  all(): ClipBook {
    return { ...this.baked, ...this.local };
  }

  names(): string[] {
    return Object.keys(this.all()).sort((a, b) => a.localeCompare(b));
  }

  get(name: string): AntClip | null {
    return this.all()[name] ?? null;
  }

  isEdited(name: string): boolean {
    return name in this.local;
  }

  save(clip: AntClip): void {
    this.local[clip.name] = clip;
    this.writeLocal();
  }

  revert(name: string): AntClip | null {
    delete this.local[name];
    this.writeLocal();
    return this.get(name);
  }

  exportJson(): string {
    return `${JSON.stringify(this.all(), null, 2)}\n`;
  }

  private read(raw: unknown): { book: ClipBook; skipped: string[] } {
    const book: ClipBook = {};
    const skipped: string[] = [];
    if (!raw || typeof raw !== 'object') return { book, skipped };
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      const clip = parseClip(entry, this.rig);
      if (!clip) { skipped.push(name); continue; }
      /* Filed under its KEY, so saving under one name and loading under
       * another cannot diverge. */
      book[name] = { ...clip, name };
    }
    return { book, skipped };
  }

  private readLocal(): void {
    if (!this.storage) return;
    try {
      const text = this.storage.getItem(CLIP_KEY);
      if (!text) return;
      this.local = this.read(JSON.parse(text) as unknown).book;
    } catch {
      this.local = {};
    }
  }

  private writeLocal(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(CLIP_KEY, JSON.stringify(this.local));
    } catch { /* Full or blocked storage: the session keeps working. */ }
  }
}
