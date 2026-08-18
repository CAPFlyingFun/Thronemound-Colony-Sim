/**
 * DEVICE PREFERENCES — how this PLAYER likes the game, on this device.
 *
 * Deliberately not the game save. The save is the COLONY — where she dug,
 * what the larder holds — and it belongs to the world. These are facts
 * about the hand and the glass: how wide a lens reads well on this screen,
 * how fast a thumb likes the camera, whether up should mean up. Losing
 * the save loses a colony; losing these costs four slider nudges. They
 * are stored under their own key so neither can ever corrupt the other.
 *
 * Part of the Foundation Pass (ChatGPT's plan, Joshua's go, 2026-08-18):
 * "the same SettingsPanel should open from MAIN MENU and PAUSE. One
 * component. No duplicate settings logic." The PANEL lives in
 * `settingsPanel.ts`; this file is the truth it edits, so anything else
 * that needs a preference reads it here and never grows a second copy.
 *
 * EVERY FIELD SHIPS WIRED. Tutorial guidance and the touch/PC control
 * mode are real rows in the plan, but the systems they steer do not
 * exist yet, and the HUD rule is older than all of this: a control must
 * not appear enabled until the mechanic actually exists. They join when
 * their mechanics do.
 */

export interface DevicePrefs {
  /** First-person lens, degrees. */
  fov1: number;
  /** Third-person lens, degrees. */
  fov3: number;
  /** Look-drag speed, as a multiple of the tuned default. */
  lookSens: number;
  /** Dragging down looks up, for the players wired that way. */
  invertY: boolean;
  /** Render resolution, as a share of the device's own pixels. */
  resScale: number;
}

/** The tuned defaults — what every player had before the panel existed,
 *  so an untouched panel changes nothing about the game. */
export const PREF_DEFAULTS: DevicePrefs = {
  fov1: 60,
  fov3: 60,
  lookSens: 1,
  invertY: false,
  resScale: 1,
};

/** The rails each value is clamped to — also what the sliders show. */
export const PREF_RANGE = {
  fov1: { min: 45, max: 100, step: 1 },
  fov3: { min: 45, max: 100, step: 1 },
  lookSens: { min: 0.3, max: 2.5, step: 0.1 },
  resScale: { min: 0.5, max: 1, step: 0.05 },
} as const;

/* Dotted and versioned like every durable key in the repo —
 * 'thronemound.island.v1', 'thronemound.poses.v1' — so a future storage
 * sweep finds them all with one prefix. */
const KEY = 'thronemound.prefs.v1';

const clamp = (v: number, lo: number, hi: number): number => (
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : NaN
);

/**
 * Whatever is stored, made SAFE — every field clamped to its rails, every
 * missing or mangled field falling back to its default. A hand-edited or
 * half-written blob degrades one field, never the set.
 */
export function sanitizePrefs(raw: unknown): DevicePrefs {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof typeof PREF_RANGE, fallback: number): number => {
    const got = clamp(Number(r[k]), PREF_RANGE[k].min, PREF_RANGE[k].max);
    return Number.isNaN(got) ? fallback : got;
  };
  return {
    fov1: num('fov1', PREF_DEFAULTS.fov1),
    fov3: num('fov3', PREF_DEFAULTS.fov3),
    lookSens: num('lookSens', PREF_DEFAULTS.lookSens),
    invertY: typeof r.invertY === 'boolean' ? r.invertY : PREF_DEFAULTS.invertY,
    resScale: num('resScale', PREF_DEFAULTS.resScale),
  };
}

/**
 * Load, defaulting on every failure. Storage is denied outright in some
 * private-browsing modes — the same reality `islandSave` lives with — and
 * a player the browser refuses still gets a working game at defaults.
 */
export function loadPrefs(): DevicePrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...PREF_DEFAULTS };
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

/** Save, quietly tolerating a browser that refuses. Returns whether the
 *  write stuck, so a panel can say "won't persist here" honestly. */
export function savePrefs(prefs: DevicePrefs): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(sanitizePrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

/** For tests and probes: the storage key, so nothing hardcodes a copy. */
export const PREFS_KEY = KEY;
