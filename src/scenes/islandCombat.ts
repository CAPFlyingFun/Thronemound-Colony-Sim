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
  /**
   * HP A SECOND that load bleeds off at, set by whoever stung it.
   *
   * On the QUARRY rather than in the tuning because the dose belongs to the
   * ant that delivered it — a worker's venom lingers where a major's bites
   * — and the load has to keep working after she has let go and walked
   * away. A quarry that had to ask its attacker how fast to bleed would
   * need to remember an attacker.
   */
  venomRate: number;
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
  /** Seconds between bite beats while she has hold. See `tick`. */
  biteInterval: number;
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
  /* One a second, as asked. Her own beat, not the quarry's — the struggle
   * coming back at her is still continuous, because being shaken about is
   * not a series of events the way a bite is. */
  biteInterval: 1,
  stingLoad: 9,
  necrosisRate: 4,
  venomRefillSeconds: 240,

  gripCost: 8,
  gripDrain: 4,
  stingCost: 2,
  reach: 2.4,
};

/**
 * WHAT EACH CASTE DOES IN A FIGHT — data, the way `STRENGTH` is data.
 *
 * Set by Joshua: "1 enemy HP loss per second for queen, 4 HP loss for
 * worker, and like 9 HP for Major", plus a venom DOT of "3HP/s for 10s for
 * the workers, and 6HP/s for 8s for major".
 *
 * BITE IS THE GRIP, still. That was asked for explicitly — "I would still
 * keep bite = grip" — so this does not add an attack button. Holding on IS
 * the attack: the mandibles are in it, and it bleeds while she is there.
 * The grip's own costs, its struggle and its break-free chance are what
 * make that a decision rather than a hold-to-win.
 *
 * THE QUEEN HAS NO VENOM, which is not a nerf but the same fact v0.1.44
 * recorded: her sting came off in `FIRE_ANT.abilities`, so a zero here
 * keeps the two from disagreeing. A caste with no sting cannot dose.
 *
 * WORKER PAIN LASTS LONGER, MAJOR PAIN HITS HARDER — from the observation
 * that set the numbers: "at least to humans (me, lol) the smaller fire ants
 * hurt worse than the big ones". Worth being precise, because the totals
 * run the other way: 3 for 10 seconds is 30, and 6 for 8 is 48, so a major
 * still does more overall. What the small one gets is DURATION. Read as
 * lingering rather than as total, which is what a fire-ant sting actually
 * does to a person, that is the right shape.
 *
 * (Biologically, majors carry larger venom sacs and deliver more per sting;
 * the impression that minors hurt worse is usually a number-of-stings
 * effect, since minors defend a nest in their hundreds. So this is GAME
 * TUNING chosen to match a felt experience, not a measured per-sting
 * potency. Flagged rather than quietly inverted.)
 */
export interface CasteCombat {
  /** HP off the quarry per bite beat, while she has hold of it. */
  bite: number;
  /** Venom dose: HP a second... */
  venomRate: number;
  /** ...and for how many seconds. Zero rate means this caste has no sting. */
  venomSeconds: number;
}

export const CASTE_COMBAT: Record<'queen' | 'worker' | 'major', CasteCombat> = {
  queen: { bite: 1, venomRate: 0, venomSeconds: 0 },
  worker: { bite: 4, venomRate: 3, venomSeconds: 10 },
  major: { bite: 9, venomRate: 6, venomSeconds: 8 },
};

export type CombatPhase = 'free' | 'gripped' | 'stinging';

/** What just happened, for the HUD and the sound that does not exist yet. */
export interface CombatEvent {
  kind: 'grip' | 'bite' | 'sting' | 'released' | 'shaken' | 'felled' | 'dry';
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

  /** Counts down to the next bite beat. See `tick`. */
  private chew = 0;

  /**
   * SECONDS UNTIL SHE CAN DOSE AGAIN — and it is the DOT's own duration.
   *
   * Joshua's idea, and it is the right one: "could be that cooldown based
   * on duration so press sting once and once that 8 or 10 seconds are up,
   * will be the cool down". The venom working and the ability being spent
   * become the same fact, which means the cooldown explains itself on
   * screen — you are watching it happen to the beetle.
   *
   * It also fixes a real hole rather than merely gating one. A press fires
   * `sequenceStings` stings and each ADDED a full dose, so a worker put
   * 4 x 30 = 120 hp of venom into a 100 hp beetle: one press killed
   * anything beetle-sized and the bite never mattered. The dose is set
   * rather than accumulated now, and this stops her topping it up.
   */
  private cooling = 0;

  private readonly events: CombatEvent[] = [];

  constructor(
    /** Which row of `CASTE_COMBAT` she fights by — off her kind. */
    private caste: keyof typeof CASTE_COMBAT = 'queen',
    private tuning: CombatTuning = DEFAULT_COMBAT,
  ) {}

  /** The caste's own numbers, so callers read one source. */
  get profile(): CasteCombat { return CASTE_COMBAT[this.caste]; }

  /** She has a sting at all — a queen does not. See `CASTE_COMBAT`. */
  get venomous(): boolean { return this.profile.venomRate > 0; }

  /** Seconds until the sting is available again. 0 when it is ready. */
  get stingReadyIn(): number { return Math.max(0, this.cooling); }

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
    /* A full beat before the first bite, so taking hold is not a free hit
     * and spamming grip-release cannot out-damage simply holding on. */
    this.chew = this.tuning.biteInterval;
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
    /*
     * A CASTE WITH NO STING CANNOT START A SEQUENCE — refused here rather
     * than allowed to run and deliver a dose of zero.
     *
     * v0.1.44 took the sting off the queen in `FIRE_ANT.abilities`, which
     * removes her BUTTON. This is the same fact one layer down, and it has
     * to be said twice: the UI list is what the player can reach, and a
     * mechanic that quietly no-ops when called directly is the kind of
     * thing a future caller trusts and a future bug hides in.
     */
    if (!this.venomous) return false;
    /* Still bleeding out the last dose — see `cooling`. */
    if (this.cooling > 0) return false;
    if (this.phase !== 'gripped' && this.phase !== 'stinging') return false;
    if (this.dry) {
      this.events.push({ kind: 'dry' });
      return false;
    }
    this.phase = 'stinging';
    this.left = this.tuning.sequenceStings;
    this.next = 0;
    /* The dose's own length. Set when the sequence STARTS rather than when
     * it finishes, so the burst and its cooldown are one press. */
    this.cooling = this.profile.venomSeconds;
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
    /* Runs whatever she is doing, and whether or not she still has hold —
     * it is the venom's clock, not the grip's. */
    if (this.cooling > 0) this.cooling = Math.max(0, this.cooling - dt);

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

    /*
     * THE BITE BEAT — the grip IS the attack, and it lands on a clock.
     *
     * Asked for as "1 bite or sting per second and takes damage also once
     * per second", and the beat is the point rather than the arithmetic: a
     * continuous `bite * dt` trickle is invisible and has nothing for an
     * animation to sync to, where a discrete hit is a thing you watch land
     * and a clip can be cut to. Same total damage, legible delivery.
     *
     * Only while she is ON it and only while it is alive — a felled quarry
     * is cargo, not a fight, and biting cargo is just carrying it.
     */
    if (held.alive) {
      this.chew -= dt;
      if (this.chew <= 0) {
        this.chew += t.biteInterval;
        held.hp = Math.max(0, held.hp - this.profile.bite);
        this.events.push({ kind: 'bite', quarry: held.id });
        if (held.hp <= 0) {
          held.alive = false;
          this.events.push({ kind: 'felled', quarry: held.id });
        }
      }
    }

    if (this.phase !== 'stinging') return;
    this.next -= dt;
    if (this.next > 0) return;
    this.next = t.stingInterval;

    if (this.dry) { this.events.push({ kind: 'dry' }); this.phase = 'gripped'; return; }
    if (!spend(t.stingCost)) { this.phase = 'gripped'; return; }

    this.venom = Math.max(0, this.venom - 1 / t.venomStings);
    /*
     * SET, NOT ADDED — the dose does not stack.
     *
     * A press is `sequenceStings` stings, which is the animal: she pivots
     * about the bite and stings several times without letting go. What she
     * is delivering across that burst is ONE envenomation, not four, and
     * adding four full doses is what let a worker put 120 hp of venom into
     * a 100 hp beetle from a single press.
     *
     * `Math.max` rather than a bare assignment so a second sting cannot
     * REDUCE a load that is already deeper — stinging something a major has
     * already hit should not help it.
     */
    const dose = this.profile;
    held.venomLoad = Math.max(held.venomLoad, dose.venomRate * dose.venomSeconds);
    held.venomRate = Math.max(held.venomRate, dose.venomRate);
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
  /* The quarry's OWN rate, set by whoever dosed it — a worker's venom
   * bleeds slower and longer than a major's. Falls back to the tuning for
   * anything stung before the caste table existed, or in a test that builds
   * a quarry by hand. */
  const rate = q.venomRate > 0 ? q.venomRate : tuning.necrosisRate;
  const bite = Math.min(q.venomLoad, rate * dt);
  q.venomLoad -= bite;
  q.hp -= bite;
  if (q.hp > 0) return false;
  q.hp = 0;
  q.alive = false;
  return true;
}
