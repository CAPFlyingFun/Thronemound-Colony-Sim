/**
 * THE STING — and it is two actions, not one, because that is how a fire
 * ant actually fights.
 *
 * A worker does not simply sting. She CLAMPS onto soft tissue with her
 * mandibles first, and only then arches her gaster over and drives the
 * sting home — then, still gripping, PIVOTS about the bite and stings
 * again, seven or eight times in a rough circle, before letting go and
 * finding a new site. The grip is not flavour; it is the anchor the sting
 * needs, and it is the reason a fire ant leaves a ring of welts rather
 * than one.
 *
 * So BITE grips and STING is only available while gripped, which gives the
 * rail a real two-button combination and gives the player the animal's own
 * tactics for free.
 *
 * VENOM IS A RESERVE, NOT A COOLDOWN. A sting spends about 3.1% of what
 * she carries, so a full ant is worth roughly THIRTY-TWO of them — about
 * four sequences — and then she is dry and has only her jaws until it
 * builds back. A finite pool is a better mechanic than a timer for the
 * same reason it is true: it makes the player choose which fight to spend
 * it on.
 *
 * AND THE VENOM DOES NOT LAND AS A HIT. Solenopsins are alkaloids that
 * cause necrosis — the damage is done over the following seconds, not on
 * contact. So a sting adds a LOAD to the quarry and the load does the
 * killing, which means letting go of something already full of venom is a
 * legitimate way to win, and disengaging is a tactic rather than a retreat.
 *
 * Pure arithmetic and a state machine: no THREE, no DOM, no scene.
 */

/** Anything she can get her jaws into. */
export interface Quarry {
  readonly id: string;
  /*
   * WHERE IT IS, structurally rather than as a THREE.Vector3 — this file
   * does no geometry and should not start importing a renderer to hold a
   * position. The scene measures the distance; the quarry only has to
   * have somewhere to be and a size to be caught by.
   */
  readonly at: { x: number; y: number; z: number };
  readonly radius: number;
  /** Still up? A felled quarry may still be gripped — it becomes cargo. */
  alive: boolean;
  /** Hit points, whatever the creature counts them in. */
  hp: number;
  /** Venom sitting in it, ticking damage down. */
  venomLoad: number;
  /** How hard it fights back, in health a second, while she is holding it. */
  readonly struggle: number;
  /** How likely it is to shake her off, per second. */
  readonly breakFree: number;
}

export interface CombatTuning {
  /** Stings in a full reserve — the research's 3.1% a sting. */
  venomStings: number;
  /** Stings a sequence delivers before she must re-grip. */
  sequenceStings: number;
  /** Seconds between stings inside a sequence. */
  stingInterval: number;
  /** Venom a single sting injects, in quarry hit points' worth. */
  stingLoad: number;
  /** How fast a load burns down into damage, per second. */
  necrosisRate: number;
  /** Seconds to refill an empty reserve. */
  venomRefillSeconds: number;

  /** Stamina to take hold. */
  gripCost: number;
  /** Stamina a second while holding on. */
  gripDrain: number;
  /** Stamina per sting. */
  stingCost: number;
  /** How far her jaws reach, in world units. */
  reach: number;
}

/**
 * The numbers, from the literature where it had them.
 *
 * `venomStings` is 32 because a sting is about 3.1% of the supply.
 * `sequenceStings` is 7, the low end of the reported 7-8 per attack — the
 * low end because the player can simply grip again, and a sequence that
 * outlasts the player's patience is a sequence they will stop watching.
 */
export const DEFAULT_COMBAT: CombatTuning = {
  venomStings: 32,
  sequenceStings: 7,
  stingInterval: 0.42,
  stingLoad: 9,
  necrosisRate: 4,
  venomRefillSeconds: 240,

  gripCost: 8,
  gripDrain: 4,
  stingCost: 2,
  reach: 2.4,
};

export type CombatPhase = 'free' | 'gripped' | 'stinging';

/** What just happened, for the HUD and the sound that does not exist yet. */
export interface CombatEvent {
  kind: 'grip' | 'sting' | 'released' | 'shaken' | 'felled' | 'dry';
  quarry?: string;
}

export class Combat {
  phase: CombatPhase = 'free';

  /** 0..1 of a full reserve. */
  venom = 1;

  /** What she has hold of, if anything. */
  held: Quarry | null = null;

  /** Stings left in the sequence under way. */
  private left = 0;

  private next = 0;

  private readonly events: CombatEvent[] = [];

  constructor(private tuning: CombatTuning = DEFAULT_COMBAT) {}

  retune(tuning: CombatTuning): void { this.tuning = tuning; }

  get reach(): number { return this.tuning.reach; }

  /** Stings she could still pay for. */
  get stingsLeft(): number {
    return Math.floor(this.venom * this.tuning.venomStings);
  }

  get dry(): boolean { return this.stingsLeft < 1; }

  /** Drain the queue. The caller decides what to do with them. */
  drain(): CombatEvent[] { return this.events.splice(0, this.events.length); }

  /**
   * Take hold. Costs stamina, and refuses if she cannot pay — a grip she
   * has not the strength for is exactly the moment a fight goes wrong.
   */
  grip(quarry: Quarry, spend: (cost: number) => boolean): boolean {
    if (this.phase !== 'free') return false;
    if (!spend(this.tuning.gripCost)) return false;
    this.held = quarry;
    this.phase = 'gripped';
    this.events.push({ kind: 'grip', quarry: quarry.id });
    return true;
  }

  /** Let go, deliberately or otherwise. */
  release(why: CombatEvent['kind'] = 'released'): void {
    if (this.phase === 'free') return;
    const id = this.held?.id;
    this.held = null;
    this.phase = 'free';
    this.left = 0;
    this.events.push({ kind: why, quarry: id });
  }

  /**
   * Begin a sequence. ONLY WHILE GRIPPED — that is the whole mechanic, and
   * it is the animal's, not a balance decision.
   */
  sting(): boolean {
    if (this.phase !== 'gripped' && this.phase !== 'stinging') return false;
    if (this.dry) {
      this.events.push({ kind: 'dry' });
      return false;
    }
    this.phase = 'stinging';
    this.left = this.tuning.sequenceStings;
    this.next = 0;
    return true;
  }

  /**
   * One frame. `spend` is stamina; `hurt` is what the quarry does back.
   */
  tick(dt: number, spend: (cost: number) => boolean, hurt: (amount: number) => void,
    chance: () => number): void {
    if (!(dt > 0)) return;
    const t = this.tuning;

    /* The reserve builds back whatever she is doing — she is not choosing
     * to make venom, and a pool that only fills while idle would have the
     * player standing about waiting for it. */
    this.venom = Math.min(1, this.venom + dt / t.venomRefillSeconds);

    if (this.phase === 'free' || !this.held) return;
    const held = this.held;

    /* Holding on is work, and it is work she can run out of. */
    if (!spend(t.gripDrain * dt)) { this.release('shaken'); return; }

    /*
     * IT FIGHTS BACK. A grip is not a free position: the quarry struggles
     * for as long as she is on it, which is what stops the answer to every
     * encounter being "grab it and wait".
     */
    if (held.alive) {
      hurt(held.struggle * dt);
      if (chance() < held.breakFree * dt) { this.release('shaken'); return; }
    }

    if (this.phase !== 'stinging') return;
    this.next -= dt;
    if (this.next > 0) return;
    this.next = t.stingInterval;

    if (this.dry) { this.events.push({ kind: 'dry' }); this.phase = 'gripped'; return; }
    if (!spend(t.stingCost)) { this.phase = 'gripped'; return; }

    this.venom = Math.max(0, this.venom - 1 / t.venomStings);
    held.venomLoad += t.stingLoad;
    this.events.push({ kind: 'sting', quarry: held.id });
    this.left -= 1;
    if (this.left <= 0) this.phase = 'gripped';
  }

  report(): {
    phase: CombatPhase; venom: number; stings: number; holding: string;
  } {
    return {
      phase: this.phase,
      venom: +this.venom.toFixed(3),
      stings: this.stingsLeft,
      holding: this.held?.id ?? '',
    };
  }
}

/**
 * THE VENOM DOING ITS WORK, on one quarry, for one frame.
 *
 * Separate from `Combat` because it has to keep running on things she has
 * already let go of — the whole point of a load is that walking away does
 * not undo it. Returns true on the frame the quarry goes down.
 */
export function necrosis(
  q: Quarry, dt: number, tuning: CombatTuning = DEFAULT_COMBAT,
): boolean {
  if (q.venomLoad <= 0 || !q.alive) return false;
  const bite = Math.min(q.venomLoad, tuning.necrosisRate * dt);
  q.venomLoad -= bite;
  q.hp -= bite;
  if (q.hp > 0) return false;
  q.hp = 0;
  q.alive = false;
  return true;
}
