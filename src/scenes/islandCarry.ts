/**
 * WHAT SHE IS CARRYING, AND WHAT THE COLONY GETS FOR IT.
 *
 * The half of eating that is not hers. Her ENERGY bar is liquid
 * carbohydrate handed to her mouth to mouth; solid prey is the COLONY'S,
 * carried home and given to fourth-instar larvae, which are the only
 * members of a fire ant colony able to digest solids. They return it as a
 * liquid the adults can drink. So a beetle does not feed HER — it feeds the
 * FOOD store on the colony strip, and that is why this is a separate file
 * from `islandVitals` rather than another bar in it.
 *
 * WHAT IS BIOLOGY AND WHAT IS THE GAME'S DEPARTURE, said plainly:
 *
 * The larval-digestion route is real and it is the reason the design splits
 * this way. Fourth-instar larvae have the mouthparts and the midgut for
 * solid food; adult workers are filter feeders with a proventriculus that
 * will not pass particles, so prey physically cannot become adult food
 * except through the brood.
 *
 * A CLAUSTRAL FOUNDING QUEEN DOES NOT FORAGE. She seals herself in and
 * metabolises her own wing muscles until the first nanitics eclose — that
 * is the same histolysis this repo already leans on to gate hunger during
 * the founding. A queen dragging a beetle home is the game's departure, and
 * it is not a new one: it was made the moment she was given a beetle to
 * fight in v0.1.23. Recorded here rather than quietly enjoyed.
 *
 * PURE LOGIC, no THREE. The scene measures distances and moves meshes; this
 * file knows what is held, what it weighs, and what it is worth.
 */
import { STRENGTH, carryVerdict, type AntStrength } from './mandibleReach';

/** Anything she can pick up and take home. */
export interface Portable {
  readonly id: string;
  /* Structural, not a THREE.Vector3, for the reason `Quarry` gives: this
   * file does no geometry and should not import a renderer to hold a
   * position. */
  readonly at: { x: number; y: number; z: number };
  /** Wet mass, milligrams. What decides whether she can lift it at all. */
  readonly massMg: number;
  /** What the colony gets for it, milligrams of usable protein. */
  readonly proteinMg: number;
  /**
   * A LIVE THING CANNOT BE CARRIED. Not a rule about strength — a beetle
   * that is still fighting is a fight, not cargo, and the grip that holds
   * it is `islandCombat`'s. This is what makes killing it the price of
   * taking it.
   */
  alive: boolean;
  /**
   * WHERE ITS CENTRE GOES so the point she grabbed sits at her jaws.
   *
   * Optional, because most things she picks up are small enough that their
   * centre IS where she is holding them — a seed, an aphid. It exists for
   * the long ones: a twig taken by the end must be carried by the end, not
   * snap its middle into her mouth. Implemented by `Prop`, whose hull knows
   * its own surface.
   *
   * Typed loosely on purpose. This file does no geometry and owns no THREE
   * types — see the note on `at` — so the shapes here are structural and
   * the caller passes whatever vector it already has.
   */
  carriedCentre?(
    jaw: { x: number; y: number; z: number },
    holder: unknown,
    into: { x: number; y: number; z: number },
  ): void;
}

export interface CarryTuning {
  /** Stamina to take a load up off the ground. */
  liftCost: number;
  /** Stamina a second at FULL load; less costs proportionally less. */
  ladenDrain: number;
  /** How far her jaws reach for something on the ground, world units. */
  reach: number;
}

/**
 * HOW MUCH SHE CAN SHIFT IS NOT HERE. It is `STRENGTH` in `mandibleReach`,
 * which the sandbox has used since before this file existed — three rows,
 * a carry limit and a drag limit each, and `carryVerdict` to say which of
 * carry / drag / immobile a given weight falls into and what it costs in
 * pace.
 *
 * THIS FILE USED TO HAVE ITS OWN. A single `capacityMg` on the queen, a
 * binary lift-or-refuse and a sprint veto — a second model of the same idea,
 * poorer than the one already in the repo, and queen-shaped in a game whose
 * next step is playing a worker and then a major. Deferring to `STRENGTH`
 * is what makes that handoff a table row instead of a rewrite.
 *
 * What stays here is what is genuinely the island's: what a lift costs her
 * in stamina, what holding on costs per second, and how far her jaws reach.
 *
 * MEASURED, and kept because the strength table's comment reasons from it:
 * a newly-mated Solenopsis invicta queen is on the order of ten to fifteen
 * milligrams and burns a third of it founding. Fourteen is chosen inside
 * that range, not read off a paper.
 */
export const QUEEN_BODY_MG = 14;

export const FIRE_ANT_CARRY: CarryTuning = {
  liftCost: 6,
  ladenDrain: 2.2,
  reach: 2.4,
};

/** What the colony has in store. Grows when she brings something home. */
export interface ColonyStores {
  /** Usable protein, milligrams, waiting on the larvae. */
  proteinMg: number;
}

export function emptyStores(): ColonyStores {
  return { proteinMg: 0 };
}

/** Why a pick-up was refused, so the HUD can say something true. */
export type CarryRefusal =
  | 'already-carrying' | 'still-alive' | 'too-heavy' | 'too-tired' | null;

export interface CarryEvent {
  kind: 'lifted' | 'dropped' | 'fumbled' | 'delivered';
  item?: string;
  /** Protein handed over, on `delivered`. */
  proteinMg?: number;
}

export class Carry {
  /** What is in her jaws, if anything. */
  held: Portable | null = null;

  private readonly events: CarryEvent[] = [];

  constructor(
    /** Which row of `STRENGTH` she lifts by — off her kind. */
    public strength: AntStrength = 'queen',
    private tuning: CarryTuning = FIRE_ANT_CARRY,
  ) {}

  retune(tuning: CarryTuning): void { this.tuning = tuning; }

  get reach(): number { return this.tuning.reach; }

  /**
   * WHAT THE LOAD PHYSICALLY COSTS HER: 0 empty, 1 at the heaviest thing
   * she could move at all. Measured against the DRAG limit rather than the
   * carry one because that is the true ceiling — past it she cannot shift
   * the thing in any fashion.
   *
   * This is the number the stamina drain is tuned against and it has not
   * moved. `load` below is the READOUT, and the two are deliberately
   * separate now: a meter that reads well and a drain that plays well want
   * different curves, and making one serve both means a HUD change quietly
   * retunes how long she can hold a twig.
   */
  get strain(): number {
    if (!this.held) return 0;
    return Math.min(1, this.held.massMg / STRENGTH[this.strength].dragMg);
  }

  /**
   * WHAT THE METER SHOWS — and the whole bar is now reachable, which is the
   * fix.
   *
   * Reported: "the carry bar isn't being filled correctly like the HP bar
   * or other stats." Measured in the running game before touching anything,
   * with the queen's 20 mg carry limit against her 60 mg drag limit: seed
   * 5%, leaf 6.7%, crumb 8.3%, twig 13.3%. The CSS was innocent — the bar
   * draws 0 to 131.5px exactly — but `strain` alone meant the heaviest
   * thing she can CARRY reads one third, so two thirds of the channel could
   * only ever be reached by dragging and the colour ramp never left green.
   * A bar whose top two thirds are unreachable in normal play is a bar that
   * looks broken, and it was fair to call it that.
   *
   * So the two limits get half the bar each, and the join is a landmark
   * rather than an arbitrary bend: HALF-FULL IS EXACTLY THE HEAVIEST SHE
   * CAN CARRY. `loadColour`'s middle stop sits at 0.5 too, so the amber
   * means that and nothing else — green is a load she walks off with, amber
   * is her carrying limit, red is a drag nearing what will not move at all.
   *
   * Monotonic in mass across the join, so nothing jumps backwards when a
   * carry becomes a drag: same queen, twig 20%, pebble 52.5%.
   */
  get load(): number {
    if (!this.held) return 0;
    const s = STRENGTH[this.strength];
    const mg = this.held.massMg;
    if (mg <= s.carryMg) return Math.max(0, mg / s.carryMg) * 0.5;
    const over = (mg - s.carryMg) / (s.dragMg - s.carryMg);
    return Math.min(1, 0.5 + over * 0.5);
  }

  /** Carrying it, dragging it, or empty-jawed. */
  get mode(): 'carry' | 'drag' | null {
    if (!this.held) return null;
    const v = carryVerdict(this.held.massMg, this.strength);
    return v.mode === 'immobile' ? null : v.mode;
  }

  /**
   * What the load does to her pace, 1 when her jaws are empty. Continuous
   * rather than a veto: `carryVerdict` tapers a carry from full stride with
   * a crumb down to a trudge at the limit, and a drag is slower still.
   */
  get speedFactor(): number {
    if (!this.held) return 1;
    return carryVerdict(this.held.massMg, this.strength).speedFactor;
  }

  get carrying(): boolean { return this.held !== null; }

  /**
   * A DRAG IS NOT A RUN. She has it on the ground and is hauling; there is
   * no gait in which that is a sprint. Still a veto rather than moving the
   * latch, the language `islandVitals` uses for winded: a latch that moves
   * under the player reads as a control that fought them.
   */
  get tooLadenToRun(): boolean { return this.mode === 'drag'; }

  drain(): CarryEvent[] { return this.events.splice(0, this.events.length); }

  /**
   * Pick it up. Returns null on success, or why not — the caller turns
   * that into something the player can read.
   */
  lift(item: Portable, spend: (cost: number) => boolean): CarryRefusal {
    if (this.held) return 'already-carrying';
    if (item.alive) return 'still-alive';
    /* Not "heavier than a number" — heavier than she can shift AT ALL,
     * which is the third verdict and the one that will start mattering the
     * day a nanitic is the one asking. */
    if (carryVerdict(item.massMg, this.strength).mode === 'immobile') return 'too-heavy';
    if (!spend(this.tuning.liftCost)) return 'too-tired';
    this.held = item;
    this.events.push({ kind: 'lifted', item: item.id });
    return null;
  }

  /** Put it down where she stands. It stays a thing she can pick up again. */
  drop(why: 'dropped' | 'fumbled' = 'dropped'): Portable | null {
    const item = this.held;
    if (!item) return null;
    this.held = null;
    this.events.push({ kind: why, item: item.id });
    return item;
  }

  /**
   * Hand it to the colony. Separate from `drop` because it is a different
   * act with a different outcome: dropping leaves a beetle on the ground,
   * delivering turns it into protein and the beetle is gone.
   */
  deliver(stores: ColonyStores): number {
    const item = this.held;
    if (!item) return 0;
    this.held = null;
    stores.proteinMg += item.proteinMg;
    this.events.push({
      kind: 'delivered', item: item.id, proteinMg: item.proteinMg,
    });
    return item.proteinMg;
  }

  /**
   * One frame. Carrying is work, scaled by how much of her strength the
   * load is using — and if she runs out of it she FUMBLES rather than
   * carrying on for free. A load she cannot pay for is a load she puts
   * down, which is the honest failure and leaves the beetle recoverable.
   */
  tick(dt: number, spend: (cost: number) => boolean): void {
    if (!(dt > 0) || !this.held) return;
    /* `strain`, NOT `load` — the drain is tuned against the physical
     * fraction of her strength the thing is using, and `load` is now the
     * meter's curve. Reading the meter here would have made a readout fix
     * into a stamina rebalance. */
    if (!spend(this.tuning.ladenDrain * this.strain * dt)) this.drop('fumbled');
  }

  report(): {
    carrying: string; load: number; strain: number; laden: boolean;
    mode: string; pace: number;
  } {
    return {
      carrying: this.held?.id ?? '',
      load: +this.load.toFixed(3),
      strain: +this.strain.toFixed(3),
      laden: this.tooLadenToRun,
      mode: this.mode ?? '',
      pace: +this.speedFactor.toFixed(3),
    };
  }
}

/**
 * Is she close enough to the nest to hand it over?
 *
 * Squared distances, so nothing takes a root sixty times a second for a
 * question that is only ever compared against itself.
 */
export function withinNest(
  at: { x: number; y: number; z: number },
  nest: { x: number; y: number; z: number },
  radius: number,
): boolean {
  const dx = at.x - nest.x;
  const dy = at.y - nest.y;
  const dz = at.z - nest.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}
