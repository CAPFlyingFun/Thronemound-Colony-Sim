/**
 * THE OTHER HAND — a keyboard and a mouse driving the same ant.
 *
 * Asked for (Joshua, 2026-08-18): "if you connect your phone to a
 * Bluetooth mouse and keyboard, will automatically make it like a PC where
 * the camera... will always follow the mouse so you don't have to
 * right/left mouse press to move the camera... and other buttons which can
 * also free up buttons if in that mode to look better."
 *
 * THIS FILE ADDS NO MECHANICS. Every key here ends in a call the touch
 * rail already makes — `useAbility`, the DIG toggle, the pace latch, the
 * view flip — and the mouse ends in `applyLook`, the same function the
 * thumb drag calls. That is the acceptance the card asks for stated as an
 * architecture: "input source can switch without changing game mechanics",
 * true because there is nothing here for a mechanic to live in.
 *
 * LOOKING WITHOUT HOLDING A BUTTON, twice over, because the platforms
 * genuinely differ and pretending otherwise would ship a lie:
 *
 *   POINTER LOCK, where it exists (desktop, Android Chrome). A click
 *   captures the pointer and the mouse then reports relative motion for
 *   ever — true FPS look, no edges, no cursor.
 *
 *   RAW HOVER DELTAS, where it does not (iOS/iPadOS Safari has no pointer
 *   lock at all; a Bluetooth mouse there drives the assistive cursor and
 *   sends ordinary hover moves). Measuring our own deltas between hover
 *   moves gives a look that follows the mouse without a button held —
 *   which is the ask — and it stops at the screen edge, which pointer lock
 *   does not. Honest difference, documented rather than hidden.
 *
 * WHY THE TOUCH PATH IS MUTED IN PC MODE: the same `pointermove` would
 * otherwise reach both the drag handler and this one and swing the camera
 * twice per pixel.
 */
import { applyLook, type HudHost } from './islandHud';
import {
  DEFAULT_KEYS, bindFor, pickInputMode, saysKeyboard,
  type InputMode, type InputPref, type IntentAction,
} from './inputBindings';

/** What the driver needs from the scene beyond the HUD's own surface. */
export interface PcInputHost extends HudHost {
  /** The fallback door, for a host built before the arbiter existed. */
  useAbility(id: 'bite' | 'sting' | 'carry' | 'interact'): void;
  /** Arm or disarm the shovel — the DIG plate's own toggle. */
  toggleDig(): void;
  /** One dodge in the direction she is already asking for. */
  dodgeFromKeys(): void;
  /** The CRAWL/WALK/RUN latch, one step on. */
  cyclePace(): void;
  /** The live mode, so the HUD and the touch handlers can read it. */
  inputMode: InputMode;
  /** Told whenever the mode changes, so the HUD can re-dress. */
  onInputMode(mode: InputMode): void;
}

/**
 * A hover-move this small is a resting hand, not a look. iOS emits a
 * trickle of sub-pixel moves from a still Bluetooth mouse, and feeding
 * them to the camera makes the world drift while nobody is touching it.
 */
const HOVER_DEADZONE_PX = 0.5;

/**
 * A jump this big is the cursor being warped — an assistive cursor
 * snapping to a control, a window regaining focus — rather than a hand
 * moving the mouse. Swinging the camera by it would spin the world.
 */
const HOVER_JUMP_PX = 160;

export class PcInput {
  private mode: InputMode = 'touch';

  private pref: InputPref = 'auto';

  private lastUsed: 'key' | 'touch' | null = null;

  private readonly finePointer: boolean;

  /** Where the pointer was last seen, for the no-pointer-lock delta. */
  private hoverX = 0;

  private hoverY = 0;

  private hoverSeen = false;

  private gone = false;

  constructor(
    private readonly host: PcInputHost,
    private readonly canvas: HTMLElement,
  ) {
    this.finePointer = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: fine)').matches;
    window.addEventListener('keydown', this.onKeyDown);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.refresh();
  }

  /** Settings said something. `auto` hands the decision back to the hands. */
  setPref(pref: InputPref): void {
    this.pref = pref;
    this.refresh();
  }

  get inputMode(): InputMode { return this.mode; }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** True where the browser can capture the pointer at all — false on iOS,
   *  which is why the hover path exists. */
  get canLock(): boolean {
    return typeof this.canvas.requestPointerLock === 'function';
  }

  /** Recompute the mode and tell the HUD if it moved. */
  private refresh(): void {
    const want = pickInputMode(
      { lastUsed: this.lastUsed, finePointer: this.finePointer }, this.pref,
    );
    if (want === this.mode) return;
    this.mode = want;
    this.host.inputMode = want;
    /* Letting the pointer go with the mode: a captured mouse in a HUD
     * that has gone back to thumbs is a mouse the player cannot find. */
    if (want === 'touch' && this.locked) document.exitPointerLock();
    this.host.onInputMode(want);
  }

  /**
   * LET THE POINTER GO — because a captured mouse is an invisible one.
   *
   * Found by `probe:settings` the moment the capture existed: with the
   * pointer locked, every mouse event belongs to the canvas, so a pause
   * menu opened over it draws fine and cannot be clicked at all. The
   * browser releases the lock on Escape by itself, which hides the fault
   * behind the one route that happens to work — open the same menu with
   * the MENU plate and the player is left with a menu, no cursor, and no
   * way back. So anything that puts a menu up says so here.
   */
  release(): void {
    if (this.locked) document.exitPointerLock();
    this.hoverSeen = false;
  }

  /** Is a menu, panel or front door up? Then the keys and the capture are
   *  not ours — see `release`. */
  private static menuUp(): boolean {
    return document.querySelector('.tm-pause, .tm-settings, .main-menu') !== null;
  }

  /** A touch or pen said the phone is back in the hand. Called by the
   *  HUD's own pointer handler, which sees every pointer first. */
  noteTouch(): void {
    if (this.lastUsed === 'touch') return;
    this.lastUsed = 'touch';
    this.refresh();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.gone) return;
    /* A menu is up, or a text field has the keys: not ours. */
    if (PcInput.menuUp()) return;
    const key = e.key.toLowerCase();
    if (saysKeyboard(key)) {
      /* Evidence of a real keyboard — the mode may swing to PC before the
       * action below even runs, which is what makes the first press both
       * switch the HUD and do its job. */
      if (this.lastUsed !== 'key') { this.lastUsed = 'key'; this.refresh(); }
    }
    if (e.repeat) return;
    const bind = bindFor(key, DEFAULT_KEYS);
    if (!bind) return;
    /* MOVEMENT AND THE STROKE ARE NOT OURS — `islandHud` has owned W/A/S/D
     * and Space since before this file, and two writers on one input is
     * the bug this whole layer exists to prevent. */
    e.preventDefault();
    this.fire(bind.action);
  };

  private fire(action: IntentAction): void {
    switch (action) {
      case 'bite': case 'sting': case 'carry': case 'interact':
        /* THROUGH THE ARBITER, exactly as the plates go — `PlayerIntent`
         * is the one semantic door, and a keyboard that called
         * `useAbility` directly would be a second door with none of the
         * multi-source bookkeeping behind it. */
        if (this.host.intent) this.host.intent.ability(action);
        else this.host.useAbility(action);
        break;
      case 'dig': this.host.toggleDig(); break;
      case 'dodge': this.host.dodgeFromKeys(); break;
      case 'view': this.host.firstPerson = !this.host.firstPerson; break;
      /* SHIFT is the pace latch's key and it CYCLES, matching the plate —
       * `islandHud`'s own handler also reads shift as a held run, and the
       * two agree because both end at `applyPace`. */
      case 'pace': this.host.cyclePace(); break;
      default: break;
    }
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.gone) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      this.noteTouch();
      return;
    }
    if (this.mode !== 'pc' || this.host.designer?.isOpen) return;
    /* Never capture into a menu — see `release`. */
    if (PcInput.menuUp()) return;
    /* THE CLICK IS THE CAPTURE, which is why no mouse button is bound to
     * an action: a click that also bit something would bite on the way
     * in. Where lock does not exist the click does nothing and the hover
     * path is already looking. */
    if (this.canLock && !this.locked) {
      try { void this.canvas.requestPointerLock(); } catch { /* denied is fine */ }
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (this.gone || this.mode !== 'pc') return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
    if (this.host.designer?.isOpen || PcInput.menuUp()) return;
    if (this.locked) {
      applyLook(this.host, e.movementX, e.movementY);
      return;
    }
    /*
     * NOT LOCKED — measure our own deltas, on EVERY platform.
     *
     * A first cut stood down here wherever pointer lock existed, waiting
     * for the click that captures. Measured: on desktop that is a mouse
     * that does nothing at all until you click, which is precisely the
     * "you don't have to right/left mouse press to move the camera" the
     * ask was about — and it would strand anyone whose browser refuses
     * the capture with no look whatsoever.
     *
     * So the mouse always looks. The capture is an UPGRADE rather than a
     * requirement: locked, the motion is endless and the cursor is gone;
     * unlocked, it follows the pointer and stops at the screen edge,
     * which is all iOS can ever offer anyway. Same feel, one better.
     *
     * The first sighting only plants the origin — using it as a delta
     * would swing the camera by wherever the cursor happened to enter.
     */
    const dx = e.clientX - this.hoverX;
    const dy = e.clientY - this.hoverY;
    const was = this.hoverSeen;
    this.hoverX = e.clientX;
    this.hoverY = e.clientY;
    this.hoverSeen = true;
    if (!was) return;
    if (Math.abs(dx) < HOVER_DEADZONE_PX && Math.abs(dy) < HOVER_DEADZONE_PX) return;
    if (Math.abs(dx) > HOVER_JUMP_PX || Math.abs(dy) > HOVER_JUMP_PX) return;
    applyLook(this.host, dx, dy);
  };

  /** Losing the lock (Escape, a tab switch) must not leave the deltas
   *  stale, or the next hover move swings by the gap. */
  private readonly onLockChange = (): void => {
    this.hoverSeen = false;
  };

  dispose(): void {
    if (this.gone) return;
    this.gone = true;
    window.removeEventListener('keydown', this.onKeyDown);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    if (this.locked) document.exitPointerLock();
  }
}
