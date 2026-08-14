/**
 * THE PAUSE MENU — the door back out of the island that does not burn it.
 *
 * WHAT IT REPLACES. The MENU plate ran `window.location.href = BASE_URL`.
 * That is not "jumping back to the front menu", which is how the card
 * described it — it is a FULL PAGE RELOAD. The streamed window, the colony,
 * the founding, whatever she was carrying: gone, with no confirmation and
 * no way to save first, because saving lived only on the front menu you
 * could not reach without doing this. The one control offering a way out
 * was the one that threw the session away.
 *
 * ITS OWN COMPONENT, not a second face on `MainMenu`. They answer different
 * questions — one is "what would you like to do?", the other is "you are in
 * the middle of something, what now?" — and the front menu's START is a
 * loaded gun in the second context. What IS shared is the thing worth
 * sharing: the save, which both drive through `IslandScene`.
 *
 * THE STYLE RIDES INSIDE THE ROOT, the pattern `LoadingOverlay` uses:
 * removing the overlay removes its CSS with it, so a menu that is not up
 * costs nothing and cannot leave rules behind to fight the next one.
 */

/** Where the buttons go, in the order a thumb should meet them. */
export interface PauseMenuActions {
  onResume: () => void;
  onSave: () => boolean;
  onMainMenu: () => void;
  /** Toggle the DEV drawer, returning whether it is now open. Optional: a
   *  build without instrumentation simply does not draw the handle. */
  onDev?: () => boolean;
}

const CSS = `
.tm-pause {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(6, 5, 8, 0.72);
  backdrop-filter: blur(3px);
  color: #efe3c4;
  font: 600 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.1em;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.tm-pause.is-up { opacity: 1; }
.tm-pause h2 {
  margin: 0 0 2px;
  font-size: 15px;
  letter-spacing: 0.22em;
  color: #f3e2b0;
  font-weight: 700;
}
.tm-pause button {
  min-width: 190px;
  padding: 11px 18px;
  border: 1px solid rgba(247, 226, 176, 0.34);
  border-radius: 10px;
  background: rgba(28, 22, 15, 0.86);
  color: #efe3c4;
  font: inherit;
  letter-spacing: 0.14em;
  cursor: pointer;
  /* The touch floor the rest of the HUD keeps. A pause menu missed by a
   * thumb is a pause menu that reads as a frozen game. */
  min-height: 44px;
}
.tm-pause button:hover { background: rgba(44, 34, 22, 0.92); }
.tm-pause button.is-on {
  border-color: rgba(247, 226, 176, 0.5);
  color: #f3e2b0;
}
.tm-pause button.is-quiet {
  border-color: rgba(247, 226, 176, 0.16);
  background: rgba(18, 14, 10, 0.7);
  color: rgba(239, 227, 196, 0.72);
}
/* Dimmed says "coming"; absent says nothing. The same treatment the ability
 * rail gives an unbuilt plate, and the same the front menu already gives
 * this exact button. */
.tm-pause button:disabled {
  opacity: 0.38;
  cursor: default;
  background: rgba(18, 14, 10, 0.62);
}
.tm-pause .tm-pause-say {
  min-height: 16px;
  font-size: 11px;
  letter-spacing: 0.08em;
  opacity: 0.78;
}
/*
 * THE BUILD, WHERE IT CAN BE READ WITHOUT BEING IN THE WAY.
 *
 * It was on the STATS chip, across the top of the playing screen, at the
 * weight of a vital. That is dev chrome in the best seat in the house. Here
 * it costs nothing — the game is stopped and you are already looking — and
 * it still does the one job it cannot fail at: a screenshot of a paused
 * game dates itself, which is how "this is still broken" gets checked
 * against a two-version-old build.
 */
.tm-pause .tm-pause-build {
  position: absolute;
  bottom: 10px;
  right: 12px;
  font-size: 9px;
  letter-spacing: 0.18em;
  opacity: 0.42;
}
/* A short landscape phone is the case: four buttons at 44 plus a title is
 * 240 of a 320-tall screen, which fits, but only just. */
@media (max-height: 400px) {
  .tm-pause { gap: 9px; }
  .tm-pause button { min-height: 38px; padding: 8px 16px; }
}
`;

export class PauseMenu {
  private readonly root = document.createElement('div');

  private readonly say = document.createElement('div');

  private gone = false;

  constructor(host: HTMLElement, private readonly actions: PauseMenuActions) {
    this.root.className = 'tm-pause';

    const style = document.createElement('style');
    style.textContent = CSS;
    this.root.appendChild(style);

    const title = document.createElement('h2');
    title.textContent = 'PAUSED';
    this.root.appendChild(title);

    this.button('RESUME', () => this.close());
    this.button('SAVE GAME', () => {
      /* The one thing on this menu that reports back. A save that says
       * nothing is a save you press twice. */
      this.say.textContent = this.actions.onSave()
        ? 'Saved' : 'Could not save — storage is full or blocked';
    });

    /*
     * SETTINGS IS DRAWN AND DIMMED, and that is a statement rather than a
     * gap. The card asks for the pause menu to share the front menu's
     * settings UI; there ISN'T one — `MainMenu` declares `onSettings` and
     * nothing in the repo implements it, so the front menu draws that
     * button greyed too. Inventing a second settings screen here to satisfy
     * the wording would be the exact thing the card warns against, and
     * hiding it would tell the player less than the front door does. When a
     * shared panel exists this takes an action and lights up; until then it
     * says "coming", in the same voice as an unbuilt ability plate.
     */
    const settings = this.button('SETTINGS', () => {});
    settings.disabled = true;
    settings.title = 'not yet';

    /*
     * THE DEV DRAWER'S HANDLE, REHOMED.
     *
     * It was a pill at the foot of the action rail. Being the last child of
     * a bottom-anchored column it sat UNDER the ten plates and pushed every
     * one of them 38px up the screen — a debug handle costing the game's
     * controls a row of headroom, which is what got it moved. Behind a
     * deliberate stop it costs the playing screen nothing at all, and it is
     * in the company it belongs in: the version readout came here for the
     * same reason.
     *
     * Quiet, and second from last: it is not what anyone opened this menu
     * for. The drawer itself never moved — see `islandHud.ts`.
     */
    if (this.actions.onDev) {
      const dev = this.button('DEV TOOLS', () => {
        const open = this.actions.onDev?.() ?? false;
        dev.classList.toggle('is-on', open);
        this.say.textContent = open
          ? 'Drawer open on the island' : 'Drawer closed';
      }, true);
    }

    /*
     * LEAVING IS SECONDARY, and it asks. It is the only button here that can
     * lose anything, and the thing it loses is the whole session — so it is
     * quiet, it is last, and it makes you press it twice. The second press
     * is a different word, not the same one: a confirmation you can hit by
     * double-tapping is not a confirmation.
     */
    let armed = false;
    const leave = this.button('MAIN MENU', () => {
      if (!armed) {
        armed = true;
        leave.textContent = 'LEAVE — UNSAVED WORK IS LOST';
        leave.classList.remove('is-quiet');
        this.say.textContent = 'Press again to leave, or Resume to stay';
        return;
      }
      this.actions.onMainMenu();
    }, true);

    this.root.appendChild(this.say);
    this.say.className = 'tm-pause-say';

    const build = document.createElement('div');
    build.className = 'tm-pause-build';
    build.textContent = `v${__APP_VERSION__}`;
    this.root.appendChild(build);

    host.appendChild(this.root);
    /* A frame before the class, or the transition has nothing to run from
     * and the overlay simply appears. */
    requestAnimationFrame(() => this.root.classList.add('is-up'));

    window.addEventListener('keydown', this.onKey);
  }

  private button(label: string, onPress: () => void, quiet = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    if (quiet) b.classList.add('is-quiet');
    b.addEventListener('click', onPress);
    this.root.appendChild(b);
    return b;
  }

  /** Escape closes it, the same key that opened it. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || this.gone) return;
    e.preventDefault();
    this.close();
  };

  private close(): void {
    this.dispose();
    this.actions.onResume();
  }

  get isUp(): boolean { return !this.gone; }

  dispose(): void {
    if (this.gone) return;
    this.gone = true;
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
