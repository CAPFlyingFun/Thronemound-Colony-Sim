import { describe, expect, it } from 'vitest';

import { QUEEN_RIG, WORKER_RIG } from '../src/anim/hexapod';
import { POSE_KEY, PoseStore, type PoseStorage } from '../src/anim/poseStore';

/** A `localStorage` that lives in a variable. */
const memory = (seed?: Record<string, string>): PoseStorage & { data: Record<string, string> } => ({
  data: { ...seed },
  getItem(k) { return this.data[k] ?? null; },
  setItem(k, v) { this.data[k] = v; },
});

const TAIL = QUEEN_RIG.gaster[0]!;
const pose = (name: string, y = 0.3) => ({
  name, rotations: { [TAIL]: [0, y, 0, Math.sqrt(1 - y * y)] as const },
});

describe('the pose book', () => {
  it('lets a local edit win over the committed pose of the same name', () => {
    const store = new PoseStore(QUEEN_RIG, memory());
    store.setBaked({ Sting: pose('Sting', 0.2) });
    expect(store.get('Sting')!.rotations[TAIL]![1]).toBeCloseTo(0.2, 9);
    expect(store.isEdited('Sting')).toBe(false);

    store.save(pose('Sting', 0.5));
    expect(store.get('Sting')!.rotations[TAIL]![1]).toBeCloseTo(0.5, 9);
    expect(store.isEdited('Sting')).toBe(true);
  });

  it('reverts to the committed pose rather than deleting it', () => {
    /* The two books never share a slot, so nothing an editor does can lose
     * what is already committed. That is the whole reason for the split. */
    const store = new PoseStore(QUEEN_RIG, memory());
    store.setBaked({ Sting: pose('Sting', 0.2) });
    store.save(pose('Sting', 0.5));
    const back = store.revert('Sting');
    expect(back!.rotations[TAIL]![1]).toBeCloseTo(0.2, 9);
    expect(store.isEdited('Sting')).toBe(false);
  });

  it('reverting a purely local pose leaves nothing behind', () => {
    const store = new PoseStore(QUEEN_RIG, memory());
    store.save(pose('Scratch'));
    expect(store.revert('Scratch')).toBeNull();
    expect(store.names()).toEqual([]);
  });

  it('survives a restart through storage', () => {
    const disk = memory();
    new PoseStore(QUEEN_RIG, disk).save(pose('Climb', 0.4));
    const next = new PoseStore(QUEEN_RIG, disk);
    expect(next.get('Climb')!.rotations[TAIL]![1]).toBeCloseTo(0.4, 9);
    expect(disk.data[POSE_KEY]).toBeTruthy();
  });

  it('works with nowhere to write, and says so', () => {
    /* No `localStorage` in a test or a headless probe. A store that threw
     * there would push a guard into every caller. */
    const store = new PoseStore(QUEEN_RIG);
    expect(store.persistent).toBe(false);
    store.save(pose('Alarm'));
    expect(store.get('Alarm')).not.toBeNull();
  });

  it('shrugs off a corrupt local book instead of taking the editor down', () => {
    const store = new PoseStore(QUEEN_RIG, memory({ [POSE_KEY]: '{not json' }));
    expect(store.names()).toEqual([]);
    store.save(pose('Fresh'));
    expect(store.get('Fresh')).not.toBeNull();
  });

  it('drops a pose it cannot read, and names it', () => {
    const store = new PoseStore(QUEEN_RIG, memory());
    const out = store.setBaked({ Good: pose('Good'), Bad: 'not a pose' });
    expect(out.loaded).toBe(1);
    expect(out.skipped).toEqual(['Bad']);
  });

  it('files a pose under its KEY when the key and the inner name disagree', () => {
    /* Otherwise saving under one name and loading under another diverge
     * silently, and the editor's list stops matching the book. */
    const store = new PoseStore(QUEEN_RIG, memory());
    store.setBaked({ Sting: pose('something-else') });
    expect(store.names()).toEqual(['Sting']);
    expect(store.get('Sting')!.name).toBe('Sting');
  });

  it('carries one book across castes, keeping what each rig owns', () => {
    /* A pose authored on the worker names jaw bones the queen has not got.
     * One shared book should not have to be three. */
    const jaw = WORKER_RIG.mandibleLeft![0]!;
    const shared = {
      Bite: { name: 'Bite', rotations: { [jaw]: [0, 0.2, 0, 0.98], [TAIL]: [0, 0.1, 0, 0.995] } },
    };
    const forWorker = new PoseStore(WORKER_RIG, memory());
    forWorker.setBaked(shared);
    expect(forWorker.get('Bite')!.rotations[jaw]).toBeDefined();

    const forQueen = new PoseStore(QUEEN_RIG, memory());
    forQueen.setBaked(shared);
    expect(forQueen.get('Bite')!.rotations[jaw]).toBeUndefined();
    expect(forQueen.get('Bite')!.rotations[TAIL]).toBeDefined();
  });

  it('exports the merged book, ready to be committed', () => {
    const store = new PoseStore(QUEEN_RIG, memory());
    store.setBaked({ Sting: pose('Sting', 0.2), Alarm: pose('Alarm', 0.1) });
    store.save(pose('Sting', 0.5));
    const out = JSON.parse(store.exportJson()) as Record<string, { rotations: Record<string, number[]> }>;
    expect(Object.keys(out).sort()).toEqual(['Alarm', 'Sting']);
    expect(out.Sting!.rotations[TAIL]![1]).toBeCloseTo(0.5, 9);
    expect(store.exportJson().endsWith('\n')).toBe(true);
  });

  it('lists names in a stable order, so the editor does not shuffle', () => {
    const store = new PoseStore(QUEEN_RIG, memory());
    store.save(pose('zeta'));
    store.save(pose('Alpha'));
    store.save(pose('mid'));
    expect(store.names()).toEqual(['Alpha', 'mid', 'zeta']);
  });
});
