/**
 * PLAYER INTENT — one semantic door between hands and the ant.
 *
 * Touch and keyboard may exist at the same time. They each keep their own
 * held state here, and this class decides what the game should receive.
 * The scene therefore consumes movement / dig / abilities without needing
 * to know which piece of hardware produced them.
 */

/**
 * MOUSE is its own source, not a flavour of keyboard, because it holds DIG
 * independently: the left button can be down while Space is up and the OR
 * below has to see both. Added when the left button became the shovel —
 * see `inputBindings.DEFAULT_MOUSE`.
 */
export type InputSource = 'touch' | 'keyboard' | 'mouse';

export interface PlayerInputState {
  walk: number;
  yaw: number;
  strafe: number;
  dig: boolean;
  sprint: boolean;
  crawl: boolean;
}

interface SourceIntent {
  moving: boolean;
  walk: number;
  yaw: number;
  strafe: number;
  dig: boolean;
}

const blankSource = (): SourceIntent => ({
  moving: false,
  walk: 0,
  yaw: 0,
  strafe: 0,
  dig: false,
});

/**
 * Touch owns locomotion while the joystick is actually held. Keyboard state
 * is still remembered underneath, so releasing the joystick immediately
 * hands control back to keys that are still down. DIG is different: it is a
 * hold from either source, so it remains down until BOTH sources release it.
 */
export class PlayerIntent<Action extends string = string> {
  private readonly sources: Record<InputSource, SourceIntent> = {
    touch: blankSource(),
    keyboard: blankSource(),
    mouse: blankSource(),
  };

  constructor(
    private readonly input: PlayerInputState,
    private readonly useAbility: (id: Action) => void,
  ) {}

  setMove(source: InputSource, walk: number, yaw: number, strafe = 0): void {
    const state = this.sources[source];
    state.moving = true;
    state.walk = walk;
    state.yaw = yaw;
    state.strafe = strafe;
    this.syncMove();
  }

  releaseMove(source: InputSource): void {
    const state = this.sources[source];
    state.moving = false;
    state.walk = 0;
    state.yaw = 0;
    state.strafe = 0;
    this.syncMove();
  }

  setDig(source: InputSource, down: boolean): void {
    this.sources[source].dig = down;
    this.syncDig();
  }

  releaseSource(source: InputSource): void {
    const state = this.sources[source];
    state.moving = false;
    state.walk = 0;
    state.yaw = 0;
    state.strafe = 0;
    state.dig = false;
    this.syncMove();
    this.syncDig();
  }

  releaseAll(): void {
    /* Every source, read off the record rather than listed here — the list
     * form silently skipped `mouse` the day it was added, which is a
     * shovel left down when the game pauses. */
    for (const source of Object.keys(this.sources) as InputSource[]) {
      this.releaseSource(source);
    }
  }

  ability(id: Action): void {
    this.useAbility(id);
  }

  private syncMove(): void {
    const touch = this.sources.touch;
    const chosen = touch.moving ? touch : this.sources.keyboard;
    this.input.walk = chosen.moving ? chosen.walk : 0;
    this.input.yaw = chosen.moving ? chosen.yaw : 0;
    this.input.strafe = chosen.moving ? chosen.strafe : 0;
  }

  private syncDig(): void {
    /* HELD BY ANY HAND. Named sources here would have to be edited every
     * time one is added, and the first time that was missed the left mouse
     * button held DIG that nothing ever read. */
    this.input.dig = Object.values(this.sources).some((s) => s.dig);
  }
}
