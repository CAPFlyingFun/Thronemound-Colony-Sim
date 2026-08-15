/**
 * THE FRONT DOOR — Start / Resume / Settings / Info / Dev.
 *
 * Until now every route was a query string, which is fine for a probe and
 * hopeless for a person: the game opened straight into the island with no way
 * back and no way anywhere else. This is the menu that was missing, with the
 * dev rigs behind a PIN the way Beyond Extinction does it — see `devPin.ts`
 * for why that gate is deliberately thin.
 *
 * DOM only. It knows nothing about scenes; the caller passes what each button
 * does, so the menu can be tested and reasoned about without a renderer, and
 * so a route that does not exist yet is simply an action nobody supplied.
 * Buttons with no action are shown DISABLED rather than hidden, because a
 * menu whose shape changes as features land is one nobody learns.
 */

import './MainMenu.css';
import { DevGate, type PinResult } from './devPin';

export interface MainMenuActions {
  onStart?: () => void;
  onResume?: () => void;
  onSave?: () => void;
  onSettings?: () => void;
  onInfo?: () => void;
  /** Called once the PIN is accepted. */
  onDev?: () => void;
}

interface Entry {
  key: keyof MainMenuActions;
  label: string;
  /** Dev is the only one that has to pass the gate first. */
  gated?: boolean;
}

/*
 * NO SAVE ON THE FRONT DOOR — asked, and it is the right question: "save
 * doesn't need to be on the main menu, lol. What are you going to save in
 * the main menu?"
 *
 * Nothing. The front door is reached before a session exists or after one
 * has been left, so the button either wrote an empty mound over a real one
 * or wrote a state the player had already stopped playing. Saving belongs
 * where there is something to save — the PAUSE menu, mid-run — and that is
 * where it already is.
 *
 * `onSave` stays on the actions interface. It is not dead: the pause menu
 * and the autosave both use the same hook, and removing it here removes a
 * BUTTON rather than a capability.
 */
const ENTRIES: Entry[] = [
  { key: 'onStart', label: 'START' },
  { key: 'onResume', label: 'RESUME' },
  { key: 'onSettings', label: 'SETTINGS' },
  { key: 'onInfo', label: 'INFO' },
  { key: 'onDev', label: 'DEV', gated: true },
];

export class MainMenu {
  private readonly root: HTMLDivElement;

  private readonly gate = new DevGate();

  private pad: HTMLDivElement | null = null;

  private dots: HTMLDivElement | null = null;

  private note: HTMLDivElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly actions: MainMenuActions,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'main-menu';
    this.root.setAttribute('role', 'navigation');

    const title = document.createElement('h1');
    title.className = 'main-menu__title';
    title.textContent = 'Thronemound';
    this.root.appendChild(title);

    /*
     * THE BUILD, ON THE FRONT DOOR.
     *
     * It was only ever on the in-game STATS chip, which means the one
     * moment you most want it — before pressing START, deciding whether the
     * phone is showing you today's build or a cached one — is the one
     * moment it was not on screen. That question has already cost a "this
     * is still broken" report against code that was two versions old.
     *
     * Its own element rather than the status line below, because that line
     * is the BOOT's (it says "Waking the queen…") and `setLoaded` wipes it
     * — the version has to outlive that.
     */
    const version = document.createElement('div');
    version.className = 'main-menu__version';
    version.textContent = `v${__APP_VERSION__}`;
    this.root.appendChild(version);

    const list = document.createElement('div');
    list.className = 'main-menu__list';
    for (const entry of ENTRIES) {
      const b = document.createElement('button');
      b.className = 'main-menu__button';
      b.textContent = entry.label;
      b.dataset.key = entry.key;
      const action = actions[entry.key];
      if (!action) {
        /* Shown, not hidden — see the header. A greyed SAVE tells you saving
         * exists and is not ready; a missing one tells you nothing. */
        b.disabled = true;
        b.title = 'not yet';
      } else if (entry.gated) {
        b.addEventListener('click', () => this.openPad());
      } else {
        b.addEventListener('click', () => action());
      }
      list.appendChild(b);
    }
    this.root.appendChild(list);

    /*
     * THE MENU IS THE LOADING SCREEN.
     *
     * The island's boot is long and front-loaded, and it used to be spent
     * watching a black rectangle say "Raising the island…". It is spent here
     * now: the same words appear on this line while the world builds behind
     * the menu, so the wait buys a screen you can read, change settings on
     * and open the dev tools from. By the time START is pressed there is
     * usually nothing left to wait for.
     */
    this.statusLine = document.createElement('div');
    this.statusLine.className = 'main-menu__status';
    this.root.appendChild(this.statusLine);

    host.appendChild(this.root);
  }

  private readonly statusLine: HTMLDivElement;

  private loadFailed = false;

  /** Show what the boot behind the menu is doing. */
  setStatus(text: string): void {
    if (this.loadFailed) return;
    this.statusLine.textContent = text;
  }

  /**
   * The boot has finished — let the gated buttons through.
   *
   * START is disabled until this arrives, because a START that drops you into
   * a half-built island is worse than one you wait a moment for. Everything
   * else on the menu stays live throughout: settings and the dev tools have
   * no reason to wait on terrain.
   */
  setLoaded(): void {
    if (this.loadFailed) return;
    this.statusLine.textContent = '';
    this.statusLine.classList.add('is-done');
    this.setEnabled('onStart', true);
  }

  /** The boot gave up. Say so here rather than behind the menu. */
  setFailed(message: string): void {
    this.loadFailed = true;
    this.statusLine.textContent = message;
    this.statusLine.classList.add('is-bad');
    this.setEnabled('onStart', false);
  }

  /**
   * Enable or disable one entry.
   *
   * A disabled button keeps its place in the list — the menu's shape must not
   * change as the boot progresses, or the thing under your thumb moves.
   */
  setEnabled(key: keyof MainMenuActions, on: boolean): void {
    const b = this.root.querySelector<HTMLButtonElement>(`.main-menu__button[data-key="${key}"]`);
    if (b && this.actions[key]) b.disabled = !on;
  }

  /** The PIN keypad, built on demand and torn down on close. */
  private openPad(): void {
    if (this.pad) return;
    this.gate.reset();
    const pad = document.createElement('div');
    pad.className = 'main-menu__pad';

    const heading = document.createElement('div');
    heading.className = 'main-menu__padtitle';
    heading.textContent = 'Dev';
    const sub = document.createElement('div');
    sub.className = 'main-menu__note';
    sub.textContent = 'Enter PIN';
    this.note = sub;

    this.dots = document.createElement('div');
    this.dots.className = 'main-menu__dots';
    pad.append(heading, sub, this.dots);
    this.drawDots();

    const keys = document.createElement('div');
    keys.className = 'main-menu__keys';
    const addKey = (label: string, onPress: () => void): void => {
      const b = document.createElement('button');
      b.className = 'main-menu__key';
      b.textContent = label;
      b.addEventListener('click', onPress);
      keys.appendChild(b);
    };
    for (let i = 1; i <= 9; i += 1) addKey(String(i), () => this.digit(String(i)));
    addKey('✕', () => this.closePad());
    addKey('0', () => this.digit('0'));
    addKey('⌫', () => { this.gate.back(); this.drawDots(); });
    pad.appendChild(keys);

    /* A hardware keyboard is the likelier input on the machine this tool is
     * actually used from, so it types too. */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { this.closePad(); return; }
      if (e.key === 'Backspace') { this.gate.back(); this.drawDots(); return; }
      if (/^[0-9]$/.test(e.key)) this.digit(e.key);
    };
    window.addEventListener('keydown', onKey);
    this.padCleanup = () => window.removeEventListener('keydown', onKey);

    this.pad = pad;
    this.root.appendChild(pad);
  }

  private padCleanup: (() => void) | null = null;

  private digit(d: string): void {
    const result: PinResult = this.gate.press(d);
    this.drawDots();
    if (result === 'open') {
      this.closePad();
      this.actions.onDev?.();
      return;
    }
    if (result === 'wrong' && this.note) {
      this.note.textContent = this.gate.misses > 1 ? 'Still no' : 'Try again';
    }
  }

  private drawDots(): void {
    if (!this.dots) return;
    const filled = this.gate.entered.length;
    this.dots.textContent = '';
    for (let i = 0; i < this.gate.length; i += 1) {
      const dot = document.createElement('span');
      dot.className = i < filled ? 'main-menu__dot is-on' : 'main-menu__dot';
      this.dots.appendChild(dot);
    }
  }

  private closePad(): void {
    this.padCleanup?.();
    this.padCleanup = null;
    this.pad?.remove();
    this.pad = null;
    this.dots = null;
    this.note = null;
    this.gate.reset();
  }

  /** Take the menu down — the caller is about to put a scene up. */
  dispose(): void {
    this.closePad();
    this.root.remove();
  }

  /** For tests: is the keypad showing? */
  get padOpen(): boolean {
    return !!this.pad;
  }
}
