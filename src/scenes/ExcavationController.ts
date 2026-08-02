import {
  advanceManualFrame,
  type DigFrame,
  type ExcavationPath,
  type ManualAdvance,
  type PathPoint,
} from './excavationPath';

export interface ExcavationHandoff {
  frame: DigFrame;
  path: ExcavationPath;
}

const clonePoint = (frame: DigFrame): PathPoint => ({
  position: { ...frame.position },
  forward: { ...frame.forward },
  up: { ...frame.up },
  right: { ...frame.right },
});

/**
 * Owns the ant while soil is actively being excavated.
 *
 * Deliberately has no terrain-normal input. The terrain may be changing every
 * bite; the dig frame must not be allowed to chase those changes. Surface
 * locomotion can reacquire a wall/floor/ceiling after `exit()`.
 */
export class ExcavationController {
  active = false;
  frame: DigFrame | null = null;
  readonly samples: PathPoint[] = [];

  get cameraCollidesWithTerrain(): boolean {
    return !this.active;
  }

  get xrayMix(): number {
    return this.active ? 1 : 0;
  }

  enter(frame: DigFrame): void {
    this.active = true;
    this.frame = clonePoint(frame);
    this.samples.length = 0;
    this.samples.push(clonePoint(frame));
  }

  step(input: ManualAdvance): DigFrame {
    if (!this.active || !this.frame) throw new Error('Cannot advance excavation before enter()');
    this.frame = advanceManualFrame(this.frame, input);
    this.samples.push(clonePoint(this.frame));
    return clonePoint(this.frame);
  }

  path(): ExcavationPath {
    return {
      branches: [{ id: 'manual', points: this.samples.map(clonePoint) }],
      connectors: [],
    };
  }

  exit(): ExcavationHandoff | null {
    if (!this.active || !this.frame) return null;
    const handoff: ExcavationHandoff = {
      frame: clonePoint(this.frame),
      path: this.path(),
    };
    this.active = false;
    this.frame = null;
    return handoff;
  }

  cancel(): void {
    this.active = false;
    this.frame = null;
    this.samples.length = 0;
  }
}
