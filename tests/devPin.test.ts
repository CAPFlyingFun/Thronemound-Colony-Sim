import { describe, expect, it } from 'vitest';

import { DEV_PIN, DevGate } from '../src/ui/devPin';

const type = (gate: DevGate, s: string) => [...s].map((d) => gate.press(d)).pop();

describe('the dev PIN gate', () => {
  it('opens on the right four digits', () => {
    const gate = new DevGate();
    expect(type(gate, DEV_PIN)).toBe('open');
  });

  it('says nothing until the last digit', () => {
    const gate = new DevGate();
    const seen = [...DEV_PIN].map((d) => gate.press(d));
    expect(seen.slice(0, -1)).toEqual(['more', 'more', 'more']);
    expect(seen.at(-1)).toBe('open');
  });

  it('clears itself on a wrong entry, ready for another go', () => {
    const gate = new DevGate();
    expect(type(gate, '1234')).toBe('wrong');
    expect(gate.entered).toBe('');
    expect(gate.misses).toBe(1);
    /* And the next attempt is unaffected by the last one. */
    expect(type(gate, DEV_PIN)).toBe('open');
  });

  it('ignores digits past the length instead of shifting the entry', () => {
    /* A fat-fingered double tap on a phone must not silently change what was
     * typed — it should do nothing at all. */
    const gate = new DevGate('12');
    expect(gate.press('1')).toBe('more');
    expect(gate.press('2')).toBe('open');
    expect(gate.entered).toBe('');
  });

  it('ignores anything that is not a digit', () => {
    const gate = new DevGate();
    expect(gate.press('a')).toBe('more');
    expect(gate.press('')).toBe('more');
    expect(gate.press('12')).toBe('more');
    expect(gate.entered).toBe('');
  });

  it('rubs out the last digit, and does not mind being empty', () => {
    const gate = new DevGate();
    gate.press('2');
    gate.press('0');
    expect(gate.entered).toBe('20');
    gate.back();
    expect(gate.entered).toBe('2');
    gate.back();
    gate.back();
    expect(gate.entered).toBe('');
  });

  it('never leaves a half-typed PIN waiting for next time', () => {
    const gate = new DevGate();
    gate.press('2');
    gate.press('0');
    gate.reset();
    expect(gate.entered).toBe('');
  });

  it('reports the length so the keypad can draw the right dots', () => {
    expect(new DevGate().length).toBe(DEV_PIN.length);
    expect(new DevGate('12345').length).toBe(5);
  });

  it('never hands back the PIN through `entered`', () => {
    /* `entered` is for drawing dots. A gate that leaked the answer through
     * its own UI state would be sillier than one with no gate at all. */
    const gate = new DevGate();
    expect(gate.entered).toBe('');
    gate.press(DEV_PIN[0]!);
    expect(gate.entered).toBe(DEV_PIN[0]);
    type(gate, DEV_PIN.slice(1));
    expect(gate.entered).toBe('');
  });
});
