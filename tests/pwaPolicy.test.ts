import { describe, expect, it } from 'vitest';
import { decideUpdate, type UpdateState } from '../src/pwaPolicy';

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
