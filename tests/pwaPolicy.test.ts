import { describe, expect, it } from 'vitest';
import { decideUpdate, isDifferentBuild, type UpdateState } from '../src/pwaPolicy';

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  loading: false, interacted: false, looped: false, ...over,
});

describe('what a waiting update is allowed to do', () => {
  it('takes itself when the load is done and nothing has been touched', () => {
    expect(decideUpdate(state())).toBe('auto');
  });

  /*
   * THE BUG THIS EXISTS FOR. The old rule was a twenty-second window from
   * boot, and the first update check runs at eight seconds — so an update
   * found by that check was always inside the window and always reloaded,
   * eight seconds in, with the height field, the biome textures and the ant
   * model all still in flight.
   */
  it('never reloads while the app is still loading', () => {
    expect(decideUpdate(state({ loading: true }))).toBe('hold');
  });

  it('asks once a thumb has been on the screen', () => {
    expect(decideUpdate(state({ interacted: true }))).toBe('prompt');
  });

  /*
   * A build that dies on the way up must not be able to reload the tab into
   * itself for ever, so the second automatic update of a session is a prompt.
   */
  it('asks for the second update of a session, never auto-reloads twice', () => {
    expect(decideUpdate(state({ looped: true }))).toBe('prompt');
  });

  /*
   * A held update is reconsidered when the load finishes. If by then it can
   * only ever be a prompt, it should say so immediately rather than sit in a
   * hold that will never turn into anything else.
   */
  it('prefers asking over holding when it could never be automatic', () => {
    expect(decideUpdate(state({ loading: true, interacted: true }))).toBe('prompt');
    expect(decideUpdate(state({ loading: true, looped: true }))).toBe('prompt');
  });
});

/*
 * The restart loop, pinned. The game announced an update to the build it was
 * already running, and did it again after every reload, because a WAITING
 * worker was being read as proof of new code.
 */
describe('isDifferentBuild', () => {
  const NOW = '08-13 11:48';

  it('is not an update when the waiting worker is this very build', () => {
    expect(isDifferentBuild(`/sw.js?v=${encodeURIComponent(NOW)}`, NOW)).toBe(false);
  });

  it('IS an update when the stamp differs', () => {
    expect(isDifferentBuild('/sw.js?v=08-13%2012:02', NOW)).toBe(true);
  });

  /* A registration from before the scheme carries no stamp, and really is
   * something else. */
  it('treats an unstamped worker as an update', () => {
    expect(isDifferentBuild('/sw.js', NOW)).toBe(true);
  });

  /* Nothing waiting is not an update, and must never be reported as one —
   * that is the whole loop. */
  it('is not an update when nothing is waiting', () => {
    expect(isDifferentBuild(null, NOW)).toBe(false);
  });

  it('survives a URL it cannot parse rather than trapping the player', () => {
    expect(isDifferentBuild('::::', NOW)).toBe(true);
  });
});
