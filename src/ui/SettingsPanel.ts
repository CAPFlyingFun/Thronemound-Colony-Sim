/**
 * THE SETTINGS PANEL — one component, opened from the front door AND the
 * pause menu.
 *
 * The Foundation Pass (ChatGPT's plan, Joshua's go, 2026-08-18) said it in
 * as many words: "the same SettingsPanel should open from MAIN MENU and
 * PAUSE. One component. No duplicate settings logic." Both menus were
 * already drawn waiting for it — `MainMenu` declares `onSettings` and
 * greys its entry, `PauseMenu` draws a dimmed placeholder — so this file
 * is the thing that lights them up, and `main.ts` is the only wiring.
 *
 * EVERY ROW SHIPS WIRED. The plan lists more sections — tutorial
 * guidance, control mode, audio — and they are deliberately NOT here yet:
 * a control must not appear enabled until the mechanic actually exists
 * (the HUD's oldest rule). Camera and resolution are the rows whose
 * mechanics are real today; the others join with their systems.
 *
 * LIVE-APPLY, NO OK BUTTON. A field-of-view number means nothing as a
 * number — you set it by looking at what it does. Every change writes to
 * `devicePrefs` immediately and is handed to the scene through
 * `onChange`, so the world updates behind the panel as the slider moves.
 *
 * THE STYLE RIDES INSIDE THE ROOT — the `PauseMenu`/`LoadingOverlay`
 * pattern: removing the overlay removes its CSS, so a panel that is not
 * up costs nothing and leaves nothing behind.
 */
import {
  DevicePrefs, PREF_DEFAULTS, PREF_RANGE, loadPrefs, savePrefs,
} from '../scenes/devicePrefs';
import type { InputPref } from '../scenes/inputBindings';

const CSS = `
.tm-settings {
  position: absolute;
  inset: 0;
  /* Above BOTH doors it opens from: the pause menu stands at 60 and the
   * front menu at 90000 — measured, not guessed, because a first cut at
   * 70 rendered the panel UNDER the front menu, which swallowed every
   * click while the sliders sat visible and dead. BACK reveals whichever
   * door it was opened from, exactly where it was. */
  z-index: 90010;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(6, 5, 8, 0.78);
  backdrop-filter: blur(3px);
  color: #efe3c4;
  font: 600 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.1em;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.tm-settings.is-up { opacity: 1; }
.tm-settings h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.22em;
  color: #f3e2b0;
}
.tm-settings-sheet {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 72vh;
  overflow-y: auto;
  padding: 4px 6px;
}
.tm-settings-section {
  margin: 6px 0 0;
  font-size: 10px;
  letter-spacing: 0.3em;
  color: #8fa383;
}
.tm-settings-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}
.tm-settings-row .tm-set-name {
  min-width: 118px;
  font-size: 11px;
  font-weight: 800;
  color: #f4ecd8;
  text-align: left;
}
.tm-settings-row input[type="range"] {
  width: 190px;
  accent-color: #e9c36f;
  touch-action: none;
}
/* Fixed width and tabular digits, so the row does not twitch as the
 * number changes under the thumb — the FOV panel's own lesson. */
.tm-settings-row .tm-set-value {
  min-width: 48px;
  text-align: right;
  color: #e9c36f;
  font-variant-numeric: tabular-nums;
}
.tm-settings button {
  min-width: 190px;
  min-height: 44px;
  padding: 11px 18px;
  border: 1px solid rgba(247, 226, 176, 0.34);
  border-radius: 10px;
  background: rgba(28, 22, 15, 0.86);
  color: #efe3c4;
  font: inherit;
  letter-spacing: 0.14em;
  cursor: pointer;
}
.tm-settings button:hover { background: rgba(44, 34, 22, 0.92); }
.tm-settings button.is-on {
  border-color: rgba(247, 226, 176, 0.5);
  color: #f3e2b0;
}
.tm-settings button.is-quiet {
  background: rgba(18, 14, 10, 0.7);
  border-color: rgba(247, 226, 176, 0.16);
}
.tm-settings-say {
  min-height: 15px;
  font-size: 11px;
  opacity: 0.78;
}
/* The toggle sits in a slider row's clothes, so the sheet reads as one
 * table rather than sliders with a stray pill in the middle. */
.tm-settings-row button.tm-set-flip {
  min-width: 190px;
  min-height: 32px;
  padding: 6px 12px;
}
/* And a named choice is a row of pills filling the same 190px, so the
 * three columns of the sheet stay three columns. */
.tm-set-group { display: flex; gap: 4px; width: 190px; }
.tm-settings button.tm-set-pill {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  padding: 6px 4px;
  font-size: 10px;
  letter-spacing: 0.06em;
}
@media (max-height: 400px) {
  .tm-settings { gap: 7px; }
  .tm-settings-sheet { gap: 5px; max-height: 66vh; }
  .tm-settings-row { min-height: 26px; }
  .tm-settings button { min-height: 38px; }
}
`;

export class SettingsPanel {
  private readonly root = document.createElement('div');

  private readonly say = document.createElement('div');

  private readonly prefs: DevicePrefs;

  private gone = false;

  constructor(
    host: HTMLElement,
    private readonly hooks: {
      /** Every change, live — the scene applies it while the slider moves. */
      onChange: (prefs: DevicePrefs) => void;
      onClose: () => void;
    },
  ) {
    this.prefs = loadPrefs();
    this.root.className = 'tm-settings';

    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);

    const title = document.createElement('h2');
    title.textContent = 'SETTINGS';
    this.root.appendChild(title);

    const sheet = document.createElement('div');
    sheet.className = 'tm-settings-sheet';
    this.root.appendChild(sheet);

    this.section(sheet, 'CAMERA');
    this.slider(sheet, 'FOV — 1st person', 'fov1', (v) => `${Math.round(v)}°`);
    this.slider(sheet, 'FOV — 3rd person', 'fov3', (v) => `${Math.round(v)}°`);
    this.slider(sheet, 'Look speed', 'lookSens', (v) => `×${v.toFixed(1)}`);
    this.flip(sheet, 'Invert Y');
    this.section(sheet, 'CONTROLS');
    this.choice(sheet, 'Input', ['auto', 'touch', 'pc'], ['AUTO', 'TOUCH', 'KEY+MOUSE']);
    this.section(sheet, 'GRAPHICS');
    this.slider(sheet, 'Resolution', 'resScale', (v) => `${Math.round(v * 100)}%`);

    const reset = document.createElement('button');
    reset.textContent = 'RESET TO DEFAULTS';
    reset.classList.add('is-quiet');
    reset.addEventListener('click', () => {
      Object.assign(this.prefs, PREF_DEFAULTS);
      this.commit();
      /* Redrawn rather than nudged: six controls tracking one reset is
       * six chances to miss one. */
      this.dispose();
      // eslint-disable-next-line no-new
      new SettingsPanel(host, this.hooks);
    });
    this.root.appendChild(reset);

    const back = document.createElement('button');
    back.textContent = 'BACK';
    back.addEventListener('click', () => this.close());
    this.root.appendChild(back);

    this.say.className = 'tm-settings-say';
    this.root.appendChild(this.say);

    host.appendChild(this.root);
    requestAnimationFrame(() => this.root.classList.add('is-up'));
    /* CAPTURE, and eaten: the pause menu under this also listens for
     * Escape, and one key press must close one layer, not two. */
    window.addEventListener('keydown', this.onKey, true);
  }

  private section(into: HTMLElement, label: string): void {
    const h = document.createElement('div');
    h.className = 'tm-settings-section';
    h.textContent = label;
    into.appendChild(h);
  }

  private slider(
    into: HTMLElement,
    label: string,
    key: keyof typeof PREF_RANGE,
    show: (v: number) => string,
  ): void {
    const row = document.createElement('div');
    row.className = 'tm-settings-row';
    const name = document.createElement('span');
    name.className = 'tm-set-name';
    name.textContent = label;
    row.appendChild(name);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(PREF_RANGE[key].min);
    input.max = String(PREF_RANGE[key].max);
    input.step = String(PREF_RANGE[key].step);
    input.value = String(this.prefs[key]);
    /* The joystick and the camera read raw pointer events off the glass;
     * without this a drag on the slider also drives the world beneath —
     * the block lab's own hard-won line. */
    for (const ev of ['pointerdown', 'pointermove', 'pointerup'] as const) {
      input.addEventListener(ev, (e) => e.stopPropagation());
    }
    row.appendChild(input);

    const value = document.createElement('span');
    value.className = 'tm-set-value';
    value.textContent = show(this.prefs[key]);
    row.appendChild(value);

    input.addEventListener('input', () => {
      this.prefs[key] = Number(input.value);
      value.textContent = show(this.prefs[key]);
      this.commit();
    });
    into.appendChild(row);
  }

  /**
   * A ROW OF EXCLUSIVE PILLS — for a setting whose values are named
   * rather than measured. AUTO is not a fourth state hiding behind the
   * other two: it means "follow the hand I am using", which is what a
   * phone with a keyboard in front of it actually wants.
   */
  private choice(
    into: HTMLElement,
    label: string,
    values: readonly InputPref[],
    labels: readonly string[],
  ): void {
    const row = document.createElement('div');
    row.className = 'tm-settings-row';
    const name = document.createElement('span');
    name.className = 'tm-set-name';
    name.textContent = label;
    row.appendChild(name);
    const group = document.createElement('div');
    group.className = 'tm-set-group';
    const paint: (() => void)[] = [];
    values.forEach((value, i) => {
      const b = document.createElement('button');
      b.className = 'tm-set-pill';
      b.textContent = labels[i] ?? value;
      paint.push(() => b.classList.toggle('is-on', this.prefs.inputMode === value));
      b.addEventListener('click', () => {
        this.prefs.inputMode = value;
        for (const p of paint) p();
        this.commit();
      });
      group.appendChild(b);
    });
    for (const p of paint) p();
    row.appendChild(group);
    into.appendChild(row);
  }

  private flip(into: HTMLElement, label: string): void {
    const row = document.createElement('div');
    row.className = 'tm-settings-row';
    const name = document.createElement('span');
    name.className = 'tm-set-name';
    name.textContent = label;
    row.appendChild(name);
    const b = document.createElement('button');
    b.className = 'tm-set-flip';
    const paint = (): void => {
      b.textContent = this.prefs.invertY ? 'ON' : 'OFF';
      b.classList.toggle('is-on', this.prefs.invertY);
    };
    paint();
    b.addEventListener('click', () => {
      this.prefs.invertY = !this.prefs.invertY;
      paint();
      this.commit();
    });
    row.appendChild(b);
    into.appendChild(row);
  }

  /** Persist and hand the scene the new truth — every change, at once. */
  private commit(): void {
    const stuck = savePrefs(this.prefs);
    this.hooks.onChange({ ...this.prefs });
    /* Said ONCE things stop persisting, in the save button's own voice —
     * the settings still apply for this session either way. */
    this.say.textContent = stuck
      ? '' : 'Applied — but storage is blocked, so this will not survive a reload';
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || this.gone) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };

  private close(): void {
    this.dispose();
    this.hooks.onClose();
  }

  get isUp(): boolean { return !this.gone; }

  dispose(): void {
    if (this.gone) return;
    this.gone = true;
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
