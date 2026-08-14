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
}

export interface CarryTuning {
  /** The most she can have in her jaws at once, milligrams. */
  capacityMg: number;
  /** Stamina to take a load up off the ground. */
  liftCost: number;
  /** Stamina a second at FULL load; less costs proportionally less. */
  ladenDrain: number;
  /** How far her jaws reach for something on the ground, world units. */
  reach: number;
  /** Past this share of capacity she is too laden to run. */
  sprintCeiling: number;
}

/**
 * THE NUMBERS, and which of them are measured.
 *
 * MEASURED: a newly-mated Solenopsis invicta queen is on the order of ten
 * to fifteen milligrams, and she burns a third of that during claustral
 * founding. Fourteen is a value chosen inside that range, not a figure
 * read off a paper.
 *
 * DESIGNED, AND SAYING SO: `capacityMg` is five times her body mass. Ants
 * carrying several times their own weight in their mandibles is a real and
 * general observation, but the multiples quoted for it vary wildly by
 * species and by whether the load is carried or dragged, and I could not
 * find a figure for Solenopsis I would be willing to encode. So five is
 * GAME TUNING wearing a research finding's clothes, and it is tuned to one
 * thing: a beetle should be most of a load but not all of it, so the meter
 * has somewhere to go and a second item is a real decision.
 *
 * `sprintCeiling` at 0.55 makes a beetle heavy enough to cost her the run.
 * That is the point of a load — it should change how she is played, not
 * just add a number to the corner of the screen.
 */
export const QUEEN_BODY_MG = 14;

export const FIRE_ANT_CARRY: CarryTuning = {
  capacityMg: QUEEN_BODY_MG * 5,
  liftCost: 6,
  ladenDrain: 2.2,
  reach: 2.4,
  sprintCeiling: 0.55,
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

  constructor(private tuning: CarryTuning = FIRE_ANT_CARRY) {}

  retune(tuning: CarryTuning): void { this.tuning = tuning; }

  get reach(): number { return this.tuning.reach; }

  /** 0 empty, 1 at capacity. What the carry meter draws. */
  get load(): number {
    if (!this.held) return 0;
    return Math.min(1, this.held.massMg / this.tuning.capacityMg);
  }

  get carrying(): boolean { return this.held !== null; }

  /**
   * Too laden to run. The run is VETOED rather than the latch moved —
   * the same language `islandVitals` uses for winded, and for the same
   * reason: a latch that moves under the player reads as a control that
   * fought them, where a refusal reads as a load that is heavy.
   */
  get tooLadenToRun(): boolean { return this.load > this.tuning.sprintCeiling; }

  drain(): CarryEvent[] { return this.events.splice(0, this.events.length); }

  /**
   * Pick it up. Returns null on success, or why not — the caller turns
   * that into something the player can read.
   */
  lift(item: Portable, spend: (cost: number) => boolean): CarryRefusal {
    if (this.held) return 'already-carrying';
    if (item.alive) return 'still-alive';
    if (item.massMg > this.tuning.capacityMg) return 'too-heavy';
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
    if (!spend(this.tuning.ladenDrain * this.load * dt)) this.drop('fumbled');
  }

  report(): { carrying: string; load: number; laden: boolean } {
    return {
      carrying: this.held?.id ?? '',
      load: +this.load.toFixed(3),
      laden: this.tooLadenToRun,
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
