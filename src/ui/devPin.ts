/**
 * THE DEV PIN — a gate, not a lock, and the difference is the whole design.
 *
 * "That pin was 2026 and can do the same as it's not top secret and anyone
 * looking at the Repo and access it anyway, haha. Just for the average
 * person doesn't need to have access to it."
 *
 * Exactly so, and it is worth writing down because it decides how much
 * machinery this deserves. The code ships in the bundle; anyone who opens
 * the source or this file has it. So there is no hashing, no attempt
 * lockout and no timing-safe compare here — those would buy nothing against
 * someone reading the repo and would only make the thing slower to use for
 * the one person it is actually for. What it does buy is that a player who
 * taps DEV out of curiosity gets a keypad instead of a terrain sculptor.
 *
 * Kept apart from any DOM so the behaviour that matters — what a keypress
 * does, when it opens, what a wrong entry leaves behind — can be tested
 * without a browser.
 */

export const DEV_PIN = '2026';

export type PinResult =
  /** Not enough digits yet. */
  | 'more'
  /** Right — the caller should open the dev menu. */
  | 'open'
  /** Wrong, and the entry has been cleared ready for another go. */
  | 'wrong';

export class DevGate {
  private digits = '';

  private wrong = 0;

  constructor(private readonly pin: string = DEV_PIN) {}

  /** What has been typed, for drawing the dots. Never the PIN itself. */
  get entered(): string {
    return this.digits;
  }

  /** How many digits the keypad should draw. */
  get length(): number {
    return this.pin.length;
  }

  /** Wrong entries this session, so the UI can say "try again" with feeling. */
  get misses(): number {
    return this.wrong;
  }

  /**
   * Take one digit.
   *
   * The check happens on the LAST digit rather than on a separate confirm
   * button: a fixed-length PIN has nothing to confirm, and an extra tap is
   * an extra thing to get wrong on a phone. Digits past the length are
   * ignored rather than shifting the entry along, so a fat-fingered double
   * tap does not silently change what was typed.
   */
  press(digit: string): PinResult {
    if (!/^[0-9]$/.test(digit)) return 'more';
    if (this.digits.length >= this.pin.length) return 'more';
    this.digits += digit;
    if (this.digits.length < this.pin.length) return 'more';
    if (this.digits === this.pin) {
      this.digits = '';
      return 'open';
    }
    this.digits = '';
    this.wrong += 1;
    return 'wrong';
  }

  /** Rub out the last digit. */
  back(): void {
    this.digits = this.digits.slice(0, -1);
  }

  /** Start again — on close, so a half-typed PIN is never waiting later. */
  reset(): void {
    this.digits = '';
  }
}
