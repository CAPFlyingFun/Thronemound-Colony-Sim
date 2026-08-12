/**
 * WHERE NAMED POSES LIVE — local edits over committed ones.
 *
 * The shape is Beyond Extinction's `AnimStore` and it is worth keeping: a
 * BAKED book shipped as JSON in the repo, a LOCAL book in browser storage,
 * and the local one wins per name. Authoring is then a thing you do on the
 * device you are looking at her on, and publishing is a separate, deliberate
 * act — export the merged book and commit it. Nothing an editor does can
 * lose what is already committed, because the two never share a slot.
 *
 * STORAGE IS INJECTED rather than reached for. `localStorage` does not exist
 * in the test environment or in a headless probe, and a store that throws
 * there would push its callers into guarding every use. Handed nothing, it
 * keeps the book in memory and says so through `persistent`.
 */

import type { RigMap } from './hexapod';
import { type AntPose, parsePose } from './pose';

export const POSE_KEY = 'thronemound.poses.v1';

/** The bit of `localStorage` this needs, and nothing more. */
export interface PoseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PoseBook = Record<string, AntPose>;

export class PoseStore {
  private baked: PoseBook = {};

  private local: PoseBook = {};

  /** False when there is nowhere to write — a memory-only session. */
  readonly persistent: boolean;

  constructor(private readonly rig: RigMap, private readonly storage?: PoseStorage) {
    this.persistent = !!storage;
    this.readLocal();
  }

  /**
   * Take the committed book, as loaded from JSON.
   *
   * Poses naming bones this rig does not own are dropped by `parsePose`
   * rather than refused: the workers have jaws and the queen does not, and
   * one shared book should not have to be three.
   */
  setBaked(raw: unknown): { loaded: number; skipped: string[] } {
    const out = this.read(raw);
    this.baked = out.book;
    return { loaded: Object.keys(out.book).length, skipped: out.skipped };
  }

  /** Every pose by name, local edits winning over committed ones. */
  all(): PoseBook {
    return { ...this.baked, ...this.local };
  }

  names(): string[] {
    return Object.keys(this.all()).sort((a, b) => a.localeCompare(b));
  }

  get(name: string): AntPose | null {
    return this.all()[name] ?? null;
  }

  /** True when this name is a local edit rather than the committed one. */
  isEdited(name: string): boolean {
    return name in this.local;
  }

  save(pose: AntPose): void {
    this.local[pose.name] = pose;
    this.writeLocal();
  }

  /**
   * Drop a local edit. The committed pose of the same name comes BACK — this
   * is a revert, not a delete, which is why it reports what is left.
   */
  revert(name: string): AntPose | null {
    delete this.local[name];
    this.writeLocal();
    return this.get(name);
  }

  /** The merged book, for writing back into the repo as the baked JSON. */
  exportJson(): string {
    return `${JSON.stringify(this.all(), null, 2)}\n`;
  }

  private read(raw: unknown): { book: PoseBook; skipped: string[] } {
    const book: PoseBook = {};
    const skipped: string[] = [];
    if (!raw || typeof raw !== 'object') return { book, skipped };
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      const parsed = parsePose(entry, this.rig);
      if (!parsed) { skipped.push(name); continue; }
      /* The KEY is the name, so a book whose key and whose inner name
       * disagree is stored under the key — otherwise saving under one name
       * and loading under another quietly diverge. */
      book[name] = { name, rotations: parsed.pose.rotations };
    }
    return { book, skipped };
  }

  private readLocal(): void {
    if (!this.storage) return;
    try {
      const text = this.storage.getItem(POSE_KEY);
      if (!text) return;
      this.local = this.read(JSON.parse(text) as unknown).book;
    } catch {
      /* A corrupt or unreadable book is not worth taking the editor down
       * for; the committed poses still load and the next save overwrites. */
      this.local = {};
    }
  }

  private writeLocal(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(POSE_KEY, JSON.stringify(this.local));
    } catch { /* Full or blocked storage: the session keeps working. */ }
  }
}
