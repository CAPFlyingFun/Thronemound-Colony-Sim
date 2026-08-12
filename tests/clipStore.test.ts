import { describe, expect, it } from 'vitest';

import { QUEEN_RIG, WORKER_RIG } from '../src/anim/hexapod';
import { CLIP_KEY, ClipStore, parseClip, type ClipStorage } from '../src/anim/clipStore';
import { emptyClip, putKey } from '../src/anim/clip';

const memory = (seed?: Record<string, string>): ClipStorage & { data: Record<string, string> } => ({
  data: { ...seed },
  getItem(k) { return this.data[k] ?? null; },
  setItem(k, v) { this.data[k] = v; },
});

const TAIL = QUEEN_RIG.gaster[0]!;
const pose = (y: number) => ({ name: 'k', rotations: { [TAIL]: [0, y, 0, 0.9] as const } });
const clip = (name: string, y = 0.3) => putKey(putKey(emptyClip(name, 2), 0, pose(0)), 1, pose(y));

describe('reading a clip', () => {
  it('takes a whole one', () => {
    const c = parseClip(JSON.parse(JSON.stringify(clip('walk'))), QUEEN_RIG);
    expect(c).not.toBeNull();
    expect(c!.keys).toHaveLength(2);
    expect(c!.duration).toBeCloseTo(2, 9);
    expect(c!.loop).toBe(true);
  });

  it('refuses what it cannot use, rather than throwing on a boot path', () => {
    for (const bad of [null, 'x', 42, {}, { name: 'a' }, { keys: [] }, { name: 1, keys: [] }]) {
      expect(parseClip(bad, QUEEN_RIG)).toBeNull();
    }
  });

  it('drops unreadable keys and keeps the rest', () => {
    const c = parseClip({
      name: 'patchy',
      duration: 3,
      keys: [
        { t: 0, pose: pose(0.1) },
        { t: 'soon', pose: pose(0.2) },
        { t: 1, pose: 'not a pose' },
        { t: 2, pose: pose(0.3) },
      ],
    }, QUEEN_RIG);
    expect(c!.keys.map((k) => k.t)).toEqual([0, 2]);
  });

  it('sorts keys and refuses negative times', () => {
    const c = parseClip({
      name: 'jumbled',
      keys: [{ t: 2, pose: pose(0.1) }, { t: -5, pose: pose(0.2) }, { t: 1, pose: pose(0.3) }],
    }, QUEEN_RIG);
    expect(c!.keys.map((k) => k.t)).toEqual([0, 1, 2]);
  });

  it('falls back to a sane duration rather than a zero-length clip', () => {
    for (const d of [0, -2, 'long', undefined]) {
      const c = parseClip({ name: 'x', duration: d, keys: [] }, QUEEN_RIG);
      expect(c!.duration).toBeGreaterThan(0);
    }
  });

  it('keeps only the bones this caste owns', () => {
    /* One book across castes: the workers have jaws and the queen has not. */
    const jaw = WORKER_RIG.mandibleLeft![0]!;
    const raw = {
      name: 'bite',
      keys: [{ t: 0, pose: { name: 'k', rotations: { [jaw]: [0, 0.2, 0, 0.98], [TAIL]: [0, 0.1, 0, 0.99] } } }],
    };
    expect(parseClip(raw, WORKER_RIG)!.keys[0]!.pose.rotations[jaw]).toBeDefined();
    expect(parseClip(raw, QUEEN_RIG)!.keys[0]!.pose.rotations[jaw]).toBeUndefined();
    expect(parseClip(raw, QUEEN_RIG)!.keys[0]!.pose.rotations[TAIL]).toBeDefined();
  });
});

describe('the clip book', () => {
  it('lets a local edit win, and reverts to the committed one', () => {
    const store = new ClipStore(QUEEN_RIG, memory());
    store.setBaked({ walk: clip('walk', 0.2) });
    expect(store.isEdited('walk')).toBe(false);
    store.save(clip('walk', 0.5));
    expect(store.isEdited('walk')).toBe(true);
    expect(store.revert('walk')!.keys[1]!.pose.rotations[TAIL]![1]).toBeCloseTo(0.2, 9);
  });

  it('survives a restart through storage', () => {
    const disk = memory();
    new ClipStore(QUEEN_RIG, disk).save(clip('sting', 0.4));
    expect(new ClipStore(QUEEN_RIG, disk).get('sting')!.keys).toHaveLength(2);
    expect(disk.data[CLIP_KEY]).toBeTruthy();
  });

  it('works with nowhere to write, and says so', () => {
    const store = new ClipStore(QUEEN_RIG);
    expect(store.persistent).toBe(false);
    store.save(clip('scratch'));
    expect(store.get('scratch')).not.toBeNull();
  });

  it('shrugs off a corrupt local book', () => {
    const store = new ClipStore(QUEEN_RIG, memory({ [CLIP_KEY]: 'not json' }));
    expect(store.names()).toEqual([]);
  });

  it('files a clip under its KEY when the two names disagree', () => {
    const store = new ClipStore(QUEEN_RIG, memory());
    store.setBaked({ walk: clip('something-else') });
    expect(store.names()).toEqual(['walk']);
    expect(store.get('walk')!.name).toBe('walk');
  });

  it('exports the merged book, ready to commit', () => {
    const store = new ClipStore(QUEEN_RIG, memory());
    store.setBaked({ walk: clip('walk'), sting: clip('sting') });
    store.save(clip('walk', 0.9));
    const out = JSON.parse(store.exportJson()) as Record<string, { keys: unknown[] }>;
    expect(Object.keys(out).sort()).toEqual(['sting', 'walk']);
    expect(store.exportJson().endsWith('\n')).toBe(true);
  });

  it('names what it had to skip', () => {
    const store = new ClipStore(QUEEN_RIG, memory());
    expect(store.setBaked({ good: clip('good'), bad: 7 }).skipped).toEqual(['bad']);
  });
});
