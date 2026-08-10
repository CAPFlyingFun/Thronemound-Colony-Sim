/**
 * When a waiting update may reload the app by itself, and when it must ask.
 *
 * The rule used to be a stopwatch: an update that installed within twenty
 * seconds of boot counted as "at launch" and reloaded unattended, on the
 * reasoning that nothing had been played yet so there was no tunnel to eat.
 * The stopwatch was wrong twice over.
 *
 * First, the arithmetic. The first update check runs eight seconds after
 * load, and eight is less than twenty — so an update found by that check
 * ALWAYS fell inside the automatic window. Not sometimes: always. Every
 * launch that discovered a new build reloaded itself eight seconds in.
 *
 * Second, and worse, eight seconds in is not "before anything has happened".
 * It is the middle of the island load — a height field, a set of biome
 * textures and a megabyte of ant model in flight at once. Tearing the
 * document down there does not cost a tunnel, it costs the load, and the
 * second attempt starts from an emptied cache with the device already warm.
 *
 * So the axis is load progress, not wall-clock. An update may take the app
 * only while there is genuinely nothing to lose: the load has finished and
 * the player has not touched anything yet. During the load it WAITS — held,
 * not discarded — and is reconsidered the moment the curtain lifts. Once a
 * thumb has been on the stick it asks, as it always did.
 */

/** What to do with an update that has installed and is waiting. */
export type UpdateAction =
  /** Reload now, unattended. Nothing is in flight and nothing is played. */
  | 'auto'
  /** Raise the prompt and let the player choose the moment. */
  | 'prompt'
  /** Neither yet: keep it and decide again when the load finishes. */
  | 'hold';

export interface UpdateState {
  /** The app has not yet reported itself loaded. */
  loading: boolean;
  /** A pointer or a key has reached the page. */
  interacted: boolean;
  /** An automatic update already happened in this tab. */
  looped: boolean;
}

/**
 * `looped` is the guard against a build that fails on the way up: the first
 * automatic reload is free, a second one in the same tab would be a loop, so
 * the second update of a session always asks. It is checked before
 * {@link UpdateState.loading} on purpose — a held update that can only ever
 * become a prompt should become one now rather than after the load.
 */
export function decideUpdate(state: UpdateState): UpdateAction {
  if (state.interacted || state.looped) return 'prompt';
  if (state.loading) return 'hold';
  return 'auto';
}
