/**
 * WHERE A SAVED ISLAND ACTUALLY LIVES.
 *
 * Reported from the device: "Could not save — storage is full or blocked."
 * Measured with `probe:save-size`, on the real save object:
 *
 *     fresh island                  0.3 KiB
 *     after 40 of her own bites  1783.6 KiB
 *     + 2 min, 3 worms digging   2644.7 KiB
 *
 * localStorage holds strings as UTF-16, so 2.64 million characters is about
 * 5.3 MB against a quota of roughly 5. Forty bites spends a third of the
 * budget; Joshua dug a shaft down and back up, which is hundreds.
 *
 * ## What it is NOT, both checked
 *
 * NOT the worms. Her own forty bites are 1.34 MiB of that total and the
 * three worms added 0.65 MiB over two minutes. The bug predates them.
 *
 * NOT wasted samples. The first guess was that the brush stored its whole
 * bounding box including untouched samples — `TerrainStream.remember` already
 * deletes any sample still agreeing with the generator, so every one of the
 * quarter-million stored is a real disagreement. A bite's box is about twenty
 * samples on a side; roughly half of eight thousand genuinely change. The
 * volume is honest.
 *
 * NOT compressible. Deflating the finished JSON gives 1.5x and the raw edit
 * bytes only 1.2x. (The first measurement squeezed the base64, which
 * scrambles exactly the structure deflate exploits — so it was redone on the
 * binary, and the answer got worse rather than better.)
 *
 * ## And NOT quantisable, which is why this is a storage change
 *
 * The obvious shrink is the value: float32 per sample looks extravagant. It
 * is not safe. Sampling the stored values turned up magnitudes at 3.4e38 —
 * FLT_MAX, which the density field uses as a saturated "definitely inside" or
 * "definitely outside". Squeezing those into an int8 would quietly rewrite
 * the terrain, and a save format that corrupts the world it restores is worse
 * than one that is merely large.
 *
 * So the payload moves to somewhere built to hold megabytes. IndexedDB's
 * quota is a large fraction of free disk rather than five megabytes, and it
 * stores a Blob as bytes rather than as UTF-16 text — which alone halves it.
 *
 * ## The marker, and why it stays in localStorage
 *
 * IndexedDB is asynchronous, and the front menu decides whether to light up
 * RESUME while it is being built — synchronously, before any island exists.
 * So a few bytes saying "a save is here, written at this time" stay in
 * localStorage and the payload goes to IndexedDB. That is not a workaround:
 * a marker is a fact about whether to draw a button, and the payload is the
 * world. They have different readers and different sizes.
 */

const DB_NAME = 'thronemound';
const DB_STORE = 'saves';
const DB_VERSION = 1;

/** The few bytes that say a save exists, kept where a synchronous read can see it. */
export const SAVE_MARK_KEY = 'thronemound.island.mark.v1';

/** What the marker holds. Deliberately tiny — it must never be the problem. */
export interface SaveMark {
  when: number;
  /** Payload size in bytes, so a probe or a menu can say how big it got. */
  bytes: number;
}

/** Open the database, or nothing at all if the browser refuses. */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    /* Absent in some embedded webviews, and blocked outright in Firefox's
     * private mode — where the request throws rather than erroring. */
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    /* A blocked open never settles either way, and a save button that hangs
     * forever is worse than one that reports failure. */
    req.onblocked = () => resolve(null);
  });
}

function runTx(
  db: IDBDatabase, mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let req: IDBRequest;
    try {
      req = work(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
    } catch (e) { reject(e); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Write the save. True when it landed.
 *
 * Stored as a Blob rather than a string: IndexedDB keeps a string as UTF-16
 * exactly as localStorage does, so handing it text would give away half the
 * gain for nothing.
 */
export async function putSave(key: string, text: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(text);
  const db = await openDb();
  if (db) {
    try {
      await runTx(db, 'readwrite', (s) => s.put(new Blob([bytes]), key));
      markSaved(bytes.byteLength);
      return true;
    } catch { /* Falls through to the small-save path below. */ }
  }
  /*
   * NO DATABASE, so try the old shelf and let it refuse if it is too small.
   * A player on a browser without IndexedDB still gets saves for as long as
   * their nest is modest, which is better than none — and the failure they
   * eventually hit is the honest one.
   */
  try {
    window.localStorage.setItem(key, text);
    markSaved(bytes.byteLength);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the save back, from wherever it is.
 *
 * IndexedDB first, then localStorage — which is not only a fallback but a
 * MIGRATION: anyone with a save written by a build before this one has it
 * sitting in localStorage, and losing their nest to a storage change would
 * be a poor trade for fixing a storage bug.
 */
export async function getSave(key: string): Promise<string | null> {
  const db = await openDb();
  if (db) {
    try {
      const got = await runTx(db, 'readonly', (s) => s.get(key));
      if (got instanceof Blob) return await got.text();
      if (typeof got === 'string') return got;
    } catch { /* Falls through to the old shelf. */ }
  }
  try { return window.localStorage.getItem(key); } catch { return null; }
}

/** Forget it, in both places, so an erase really erases. */
export async function dropSave(key: string): Promise<void> {
  const db = await openDb();
  if (db) {
    try { await runTx(db, 'readwrite', (s) => s.delete(key)); } catch { /* nothing to undo */ }
  }
  try {
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(SAVE_MARK_KEY);
  } catch { /* nothing to undo */ }
}

/** Note that a save exists, for the synchronous readers. */
export function markSaved(bytes: number): void {
  try {
    const mark: SaveMark = { when: Date.now(), bytes };
    window.localStorage.setItem(SAVE_MARK_KEY, JSON.stringify(mark));
  } catch { /* The save still landed; only the button hint is lost. */ }
}

/** What the marker says, or null. Synchronous, which is its whole job. */
export function readMark(): SaveMark | null {
  try {
    const raw = window.localStorage.getItem(SAVE_MARK_KEY);
    if (!raw) return null;
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object') return null;
    const m = o as Partial<SaveMark>;
    if (typeof m.when !== 'number' || !Number.isFinite(m.when)) return null;
    return { when: m.when, bytes: typeof m.bytes === 'number' ? m.bytes : 0 };
  } catch {
    return null;
  }
}
