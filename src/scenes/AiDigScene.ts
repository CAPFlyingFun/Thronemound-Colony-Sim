/**
 * THE ISLAND'S BODY, DRIVEN BY THE COLONY'S BRAIN.
 *
 * Joshua, 2026-08-21: "If I can dig correctly in the island map and crawl in
 * it, should be the same here. Maybe look at the island scene, add your AI's
 * to the player controls and make it a new scene like `?scene=aidig` and I
 * don't mind for this one time."
 *
 * A DELIBERATE, ONE-TIME EXCEPTION to the standing no-scenes rule, granted in
 * those words. It is worth having because it settles a question the density
 * tray cannot: the island ant already pitches into a slope, already bores a
 * tunnel along her own axis, and already crawls down one. If the same brain
 * that drives the tray drives HER and it looks right, then the tray's problem
 * is its body layer and not its AI — and if it looks wrong the same way, the
 * brain is at fault. Either answer is worth more than another round of
 * guessing on the tray.
 *
 * ## Why this is small
 *
 * `IslandScene.input` is public, and its own comment says so: "a probe or a
 * script setting the flags by hand should get the same answer the chip would
 * have given it." So the AI does not reach into the island at all — it fills
 * in the same six fields a thumb does, once a frame, and the island digs,
 * pitches and crawls exactly as it does for a player. `aimPitchForTest`
 * writes the look, which is how she aims her dig up or down.
 *
 * Nothing here carves soil or moves a body. That is the point: everything
 * below the input is the island's, untouched and unforked.
 */

import { IslandScene } from './IslandScene';

/** How far below level she looks while working, in radians. */
const DIG_LOOK = 0.55;

/** Seconds of digging before she picks a new bearing. */
const LEG_SECONDS = { min: 5, max: 11 } as const;

/** How hard she turns onto a new bearing, in -1..1 of yaw. */
const TURN = 0.45;

/** Seconds spent swinging onto it. */
const TURN_SECONDS = { min: 0.5, max: 1.4 } as const;

export class AiDigScene {
  private readonly island: IslandScene;

  private raf = 0;

  private last = 0;

  private leg = 0;

  private turning = 0;

  private yaw = 0;

  /** Exposed so a probe can see whether the island ever handed over. */
  ready = false;

  /** Whether the island reports itself in dig mode. For the probe. */
  get digging(): boolean {
    return (this.island as unknown as { digMode: boolean }).digMode === true;
  }

  frames = 0;

  /** What the AI wants this frame. Read through the getters below. */
  private readonly want = { walk: 0, yaw: 0, dig: false };

  /**
   * MAKE THE ISLAND READ THE AI, whatever else writes to `input`.
   *
   * Setting the six fields once a frame from a separate loop did nothing:
   * the island fills them from its own controls inside its own frame, so
   * whichever of the two ran second won, and it was not this one. Measured —
   * she stood still on the surface for forty-five seconds with the objective
   * stuck at 0 of 25 mm.
   *
   * Replacing the fields with GETTERS removes the race rather than trying to
   * win it: there is no longer a moment when the object holds a stale value,
   * because it holds no value at all. The island's own writes still land, on
   * a setter that drops them — which is exactly what "the AI has the
   * controls" should mean.
   */
  private seizeControls(): void {
    const input = this.island.input as unknown as Record<string, unknown>;
    const fixed: Record<string, () => unknown> = {
      walk: () => this.want.walk,
      yaw: () => this.want.yaw,
      strafe: () => 0,
      dig: () => this.want.dig,
      sprint: () => false,
      crawl: () => false,
    };
    for (const [key, get] of Object.entries(fixed)) {
      Object.defineProperty(input, key, {
        configurable: true, enumerable: true, get, set: () => {},
      });
    }
  }

  constructor(host: HTMLElement, private readonly rand: () => number = Math.random) {
    this.island = new IslandScene(host, {
      onReady: () => {
        this.seizeControls();
        /*
         * AND PRESS THE DIG PLATE. `input.dig` is the thumb HELD on the
         * button; `digMode` is the latch the button toggles, and the island
         * only bores while it is set. Measured with the input taken over but
         * this left out: `input` read back exactly what the AI wanted —
         * walk 1, dig true — and `digMode` was still false, so she stood on
         * the surface with the objective at 0 of 25 mm.
         *
         * `toggleDig` is the same public entry the plate and the keyboard
         * use, so nothing here is reaching past the island's own front door.
         */
        this.island.toggleDig();
        this.ready = true;
        this.leg = this.span(LEG_SECONDS);
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.frame);
      },
    });
  }

  private span(range: { min: number; max: number }): number {
    return range.min + this.rand() * (range.max - range.min);
  }

  /**
   * One frame of wanting to dig, written into the island's own input.
   *
   * Deliberately the simplest brain that answers the question. She holds the
   * dig, looks down, walks into her own face and swings onto a new bearing
   * now and then — no site selection, no reach gate, no approach. Those live
   * on the tray and are not what is being tested here: what is being tested
   * is whether a body that already knows how to tunnel looks right when
   * something other than a thumb is driving it.
   */
  private readonly frame = (): void => {
    this.raf = requestAnimationFrame(this.frame);
    if (!this.ready) return;
    this.frames += 1;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    this.leg -= dt;
    this.turning -= dt;
    if (this.leg <= 0) {
      this.leg = this.span(LEG_SECONDS);
      this.turning = this.span(TURN_SECONDS);
      this.yaw = (this.rand() * 2 - 1 > 0 ? 1 : -1) * TURN;
    }

    this.want.walk = 1;
    this.want.yaw = this.turning > 0 ? this.yaw : 0;
    this.want.dig = true;
    /* Looking down is what points the bore down — the island takes its dig
     * direction from her aim, which is exactly the arrangement the tray is
     * being rebuilt toward. */
    this.island.aimPitchForTest(-DIG_LOOK);
  };

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    (this.island as unknown as { dispose?: () => void }).dispose?.();
  }
}
