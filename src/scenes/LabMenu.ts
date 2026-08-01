/**
 * The front door: title, RESUME / NEW GAME / SAVE / SETTINGS, and the version.
 *
 * Pure DOM, no knowledge of the scene — the scene hands in callbacks and a
 * few live readings and this only draws. The game keeps running underneath at
 * boot (an ant colony is its own attract mode); what the menu does own is
 * making sure a destructive choice is asked twice and a successful save is
 * acknowledged, because a button that silently does something irreversible
 * and a button that silently does nothing are the two ways to lose a player's
 * trust in the same afternoon.
 */

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export interface MenuHooks {
  /** Is there a save on disk right now? Read every time the menu opens. */
  hasSave: () => boolean;
  /** Close the menu, loading the save when one exists. */
  onResume: (loadSave: boolean) => void;
  /** Wipe the save and the world and start over. Already confirmed. */
  onNewGame: () => void;
  /** Snapshot now. Returns false when storage refused. */
  onSave: () => boolean;
  /** The settings the menu edits. */
  settings: {
    getMode: () => 'first' | 'auto' | 'third';
    setMode: (mode: 'first' | 'auto' | 'third') => void;
    getRunning: () => boolean;
    setRunning: (running: boolean) => void;
    eraseSave: () => void;
  };
}

export class LabMenu {
  readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private opened = false;
  /** Double-tap guard for the destructive buttons. */
  private armed: 'new' | 'erase' | null = null;

  constructor(private readonly hooks: MenuHooks) {
    this.root = document.createElement('div');
    this.root.className = 'lab-menu';
    this.panel = document.createElement('div');
    this.panel.className = 'lab-menu__panel';
    this.root.appendChild(this.panel);
    this.root.addEventListener('pointerdown', (event) => {
      // The backdrop resumes, the way every pause screen since forever has.
      if (event.target === this.root) this.close(false);
    });
    this.hide();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Close without loading anything — the Escape key's half of the toggle. */
  dismiss(): void {
    if (this.opened) this.close(false);
  }

  /** The boot showing: RESUME leads when there is a world to go back to. */
  open(boot = false): void {
    this.opened = true;
    this.armed = null;
    this.root.style.display = '';
    this.home(boot);
  }

  private hide(): void {
    this.opened = false;
    this.root.style.display = 'none';
  }

  private close(loadSave: boolean): void {
    this.hide();
    this.hooks.onResume(loadSave);
  }

  private button(
    label: string, kind: 'primary' | 'plain' | 'danger', onPress: () => void,
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `lab-menu__button lab-menu__button--${kind}`;
    b.textContent = label;
    b.addEventListener('click', onPress);
    return b;
  }

  private home(boot: boolean): void {
    const saved = this.hooks.hasSave();
    this.panel.replaceChildren();
    this.panel.insertAdjacentHTML('beforeend', `
      <div class="lab-menu__title">THRONEMOUND</div>
      <div class="lab-menu__subtitle">COLONY SIM</div>
    `);

    if (saved) {
      this.panel.appendChild(this.button('RESUME', 'primary', () => this.close(boot)));
    } else {
      this.panel.appendChild(this.button(boot ? 'START' : 'RESUME', 'primary', () => this.close(false)));
    }

    const fresh = this.button(saved ? 'NEW GAME' : 'NEW GAME', 'plain', () => {
      /*
       * Twice, on the same button, with the label carrying the warning. A
       * separate dialog is heavier than the decision deserves and a single
       * tap is lighter than losing a mound deserves.
       */
      if (this.armed !== 'new' && saved) {
        this.armed = 'new';
        fresh.textContent = 'ERASE SAVE & START OVER?';
        fresh.classList.add('lab-menu__button--danger');
        return;
      }
      this.hide();
      this.hooks.onNewGame();
    });
    this.panel.appendChild(fresh);

    const save = this.button('SAVE', 'plain', () => {
      const wrote = this.hooks.onSave();
      save.textContent = wrote ? 'SAVED ✓' : 'SAVE FAILED — STORAGE FULL?';
      save.classList.toggle('lab-menu__button--danger', !wrote);
      // Acknowledged on the button itself, then the menu redraws — by then
      // a first save exists and RESUME takes its place at the top.
      window.setTimeout(() => { if (this.opened) this.home(boot); }, 1400);
    });
    this.panel.appendChild(save);

    this.panel.appendChild(this.button('SETTINGS', 'plain', () => this.settings(boot)));
    this.panel.insertAdjacentHTML('beforeend', `
      <div class="lab-menu__version">v${__APP_VERSION__} · build ${__BUILD_TIME__}</div>
    `);
  }

  private settings(boot: boolean): void {
    this.armed = null;
    this.panel.replaceChildren();
    this.panel.insertAdjacentHTML('beforeend', '<div class="lab-menu__title lab-menu__title--small">SETTINGS</div>');

    const group = document.createElement('div');
    group.className = 'lab-menu__group';
    group.insertAdjacentHTML('beforeend', '<div class="lab-menu__label">CAMERA</div>');
    const modes: Array<['first' | 'auto' | 'third', string]> = [
      ['first', 'FIRST PERSON'], ['auto', 'AUTO'], ['third', 'THIRD PERSON'],
    ];
    for (const [mode, label] of modes) {
      const b = this.button(label, 'plain', () => {
        this.hooks.settings.setMode(mode);
        this.settings(boot);
      });
      if (this.hooks.settings.getMode() === mode) b.classList.add('lab-menu__button--active');
      group.appendChild(b);
    }
    this.panel.appendChild(group);

    const pace = document.createElement('div');
    pace.className = 'lab-menu__group';
    pace.insertAdjacentHTML('beforeend', '<div class="lab-menu__label">PACE</div>');
    const running = this.hooks.settings.getRunning();
    const paceButton = this.button(running ? 'RUN' : 'CRAWL', 'plain', () => {
      this.hooks.settings.setRunning(!this.hooks.settings.getRunning());
      this.settings(boot);
    });
    paceButton.classList.add('lab-menu__button--active');
    pace.appendChild(paceButton);
    this.panel.appendChild(pace);

    const erase = this.button('ERASE SAVE', 'plain', () => {
      if (this.armed !== 'erase') {
        this.armed = 'erase';
        erase.textContent = 'REALLY ERASE THE SAVE?';
        erase.classList.add('lab-menu__button--danger');
        return;
      }
      this.hooks.settings.eraseSave();
      this.settings(boot);
    });
    if (this.hooks.hasSave()) this.panel.appendChild(erase);

    this.panel.appendChild(this.button('BACK', 'primary', () => {
      this.armed = null;
      this.home(boot);
    }));
    this.panel.insertAdjacentHTML('beforeend', `
      <div class="lab-menu__version">v${__APP_VERSION__} · build ${__BUILD_TIME__}</div>
    `);
  }
}
