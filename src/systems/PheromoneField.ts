export type PheromoneKind = 'food' | 'home' | 'alarm';

export interface PheromoneSignal {
  kind: PheromoneKind;
  x: number;
  y: number;
  strength: number;
  radius: number;
  expiresAt: number;
  sourceAntId?: number;
}

export class PheromoneField {
  private readonly signals: PheromoneSignal[] = [];

  add(signal: PheromoneSignal): void {
    this.signals.push(signal);
  }

  decay(now: number): void {
    for (let index = this.signals.length - 1; index >= 0; index--) {
      const signal = this.signals[index];
      if (!signal || signal.expiresAt <= now || signal.strength <= 0.02) {
        this.signals.splice(index, 1);
      }
    }
  }

  strongest(kind: PheromoneKind, x: number, y: number): PheromoneSignal | undefined {
    let best: PheromoneSignal | undefined;
    let bestScore = 0;
    for (const signal of this.signals) {
      if (signal.kind !== kind) continue;
      const distance = Math.hypot(signal.x - x, signal.y - y);
      if (distance > signal.radius) continue;
      const score = signal.strength * (1 - distance / signal.radius);
      if (score > bestScore) {
        best = signal;
        bestScore = score;
      }
    }
    return best;
  }

  snapshot(): readonly PheromoneSignal[] {
    return this.signals;
  }
}
