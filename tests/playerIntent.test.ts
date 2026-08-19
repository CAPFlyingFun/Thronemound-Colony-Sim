import { describe, expect, it } from 'vitest';
import { PlayerIntent, type PlayerInputState } from '../src/scenes/playerIntent';

const make = () => {
  const input: PlayerInputState = {
    walk: 0, yaw: 0, strafe: 0, dig: false, sprint: false, crawl: false,
  };
  const actions: string[] = [];
  const intent = new PlayerIntent<string>(input, (id) => actions.push(id));
  return { input, actions, intent };
};

describe('player intent source arbitration', () => {
  it('writes keyboard movement to the same movement sink', () => {
    const { input, intent } = make();
    intent.setMove('keyboard', 1, -1);
    expect({ walk: input.walk, yaw: input.yaw, strafe: input.strafe })
      .toEqual({ walk: 1, yaw: -1, strafe: 0 });
  });

  it('lets an active touch stick own locomotion, then resumes held keys', () => {
    const { input, intent } = make();
    intent.setMove('keyboard', 1, 0.5);
    intent.setMove('touch', 0.25, -0.75);
    expect(input.walk).toBe(0.25);
    expect(input.yaw).toBe(-0.75);

    intent.releaseMove('touch');
    expect(input.walk).toBe(1);
    expect(input.yaw).toBe(0.5);
  });

  it('keeps DIG held until every input source releases it', () => {
    const { input, intent } = make();
    intent.setDig('keyboard', true);
    intent.setDig('touch', true);
    intent.setDig('touch', false);
    expect(input.dig).toBe(true);
    intent.setDig('keyboard', false);
    expect(input.dig).toBe(false);
  });

  it('releasing one source never erases the other source state', () => {
    const { input, intent } = make();
    intent.setMove('keyboard', -1, 1);
    intent.setMove('touch', 0.4, 0.2);
    intent.setDig('keyboard', true);

    intent.releaseSource('touch');
    expect({ walk: input.walk, yaw: input.yaw, dig: input.dig })
      .toEqual({ walk: -1, yaw: 1, dig: true });

    intent.releaseSource('keyboard');
    expect({ walk: input.walk, yaw: input.yaw, dig: input.dig })
      .toEqual({ walk: 0, yaw: 0, dig: false });
  });

  it('holds DIG for the mouse too, and lets go with it', () => {
    /*
     * The left button became the shovel (`inputBindings.DEFAULT_MOUSE`), so
     * the mouse is a third holder of DIG. It was added to the source record
     * before `syncDig` was taught to read it, which is a shovel held by a
     * button that nothing ever noticed — hence this.
     */
    const { input, intent } = make();
    intent.setDig('mouse', true);
    expect(input.dig).toBe(true);
    intent.setDig('keyboard', true);
    intent.setDig('mouse', false);
    expect(input.dig).toBe(true);
    intent.setDig('keyboard', false);
    expect(input.dig).toBe(false);
  });

  it('releaseAll drops EVERY source, including ones added later', () => {
    /* The pause menu calls this. A source missed here is a control still
     * held while the game is stopped. */
    const { input, intent } = make();
    intent.setDig('mouse', true);
    intent.setMove('keyboard', 1, 0);
    intent.setMove('touch', 0.5, 0.5);
    intent.releaseAll();
    expect({ walk: input.walk, yaw: input.yaw, dig: input.dig })
      .toEqual({ walk: 0, yaw: 0, dig: false });
  });

  it('forwards an ability through one semantic action door', () => {
    const { actions, intent } = make();
    intent.ability('bite');
    expect(actions).toEqual(['bite']);
  });
});
