/**
 * A BRAIN FOR EVERYTHING ALIVE THAT IS NOT YOU.
 *
 * Asked for: "bring what we did for the AI's dinosaurs from Beyond Extinction
 * so that all AI insects have a brain and can look more realistic" — and, in
 * the same breath, that worms need collision and health/stats. Those are one
 * job rather than two, because in Beyond Extinction the stats ARE part of the
 * brain's data model, and building them separately would mean building them
 * twice.
 *
 * ## What was ported, and what was left behind
 *
 * The source is `Dinos/dino_ai.gd` (1,066 lines) and `Dinos/dino_config.gd`
 * in Beyond-Extinction-Godot, plus `src/engine/faunaLogic.ts` in the
 * TypeScript build. The best idea in all three is the one this file keeps:
 * **all numbers live in data and none of the behaviour does.** A species is a
 * table entry; adding one must never mean adding an `if`.
 *
 * What did NOT come across is the machinery around it — physics capsules
 * sized from mesh AABBs, foot IK, animation clip names, navmesh-free slope
 * walking, growth from hatchling to adult. Thronemound already has its own
 * answers to every one of those, and importing a second set is exactly the
 * "two competing tuning systems" the project rules warn about.
 *
 * ## Pure, and that is the point
 *
 * No THREE, no DOM, no terrain. Beyond Extinction's own note on
 * `faunaLogic.ts` says it best — behaviour maths as typed pure functions so
 * it can be tested deterministically. A brain you can only observe by
 * watching a creature for a minute is a brain nobody will ever verify.
 *
 * The FSM here therefore DECIDES; it does not act. `think()` takes what a
 * creature can sense and returns what it wants to do. Moving, biting, and
 * carving are the caller's business.
 */

/**
 * How an animal treats something it can see.
 *
 * ARK's four tiers, kept because they cover the real cases with no overlap:
 *
 * - `passive`    — never attacks. Grazes, wanders, ignores you.
 * - `skittish`   — passive, but FLEES from anything bigger. The prey default.
 * - `neutral`    — ignores you until hit, then retaliates for a while.
 * - `aggressive` — attacks anything valid it can see, unprompted.
 */
export type Temperament = 'passive' | 'skittish' | 'neutral' | 'aggressive';

/** What it eats, which decides what it hunts and what hunts it. */
export type Diet = 'herbivore' | 'carnivore' | 'omnivore';

/**
 * Where it can be.
 *
 * `soil` is Thronemound's own, and it is the reason this is a port rather
 * than a copy: Beyond Extinction's habitats are land / amphibious / water,
 * because nothing there lives inside the ground. A soil creature has no
 * chase and no flee-across-open-ground; it has "go deeper", which is the
 * same instinct expressed through the only axis it has.
 */
export type Habitat = 'land' | 'soil';

/**
 * What a creature is doing. Ported from `dino_ai.gd`'s enum, less `SWIM`
 * (no swimming creatures here yet) and plus nothing — the temptation to add
 * a state per species is how an FSM becomes an if-ladder.
 */
export type Behaviour =
  | 'idle' | 'wander' | 'chase' | 'attack' | 'flee' | 'hunt' | 'eat' | 'dead';

/**
 * A species, as data.
 *
 * Distances are MILLIMETRES and speeds millimetres a second, matching the
 * rest of this project — Beyond Extinction's numbers are metres for animals
 * a thousand times larger, so they are not transferable and are not
 * transferred. Only the SHAPE of the table is.
 */
export interface CreatureKind {
  readonly id: string;
  readonly temperament: Temperament;
  readonly diet: Diet;
  readonly habitat: Habitat;
  /** Relative bulk. A carnivore only hunts prey no bigger than itself. */
  readonly size: number;

  readonly maxHealth: number;
  readonly maxStamina: number;

  /** How far it can notice anything at all. */
  readonly sightMm: number;
  /**
   * How close before an AGGRESSIVE one commits to a chase, and how close
   * before a NEUTRAL one counts itself cornered.
   *
   * One number doing two jobs, and deliberately: it is "the distance at
   * which this animal stops being relaxed about you".
   */
  readonly aggroMm: number;
  /** Close enough to land a bite. */
  readonly attackMm: number;
  /** The forward arc it can see through. 360 is eyes in the back of its head. */
  readonly fovDeg: number;

  readonly damage: number;
  /** Telegraph before the strike lands, and the gap between strikes. */
  readonly windupS: number;
  readonly cooldownS: number;

  readonly wanderSpeedMm: number;
  readonly chaseSpeedMm: number;

  /** It wanders within this of home, and abandons a chase past this. */
  readonly leashMm: number;
  readonly giveUpMm: number;

  /** Hunger points a second, out of 100, and the point it goes looking. */
  readonly hungerRate: number;
  readonly huntAt: number;
  readonly eatTimeS: number;

  /** Runs when health falls under this FRACTION. Zero means it never runs. */
  readonly fleeHealth: number;
  /** How long a neutral one stays angry after being hit. */
  readonly reprovokeS: number;
}

/**
 * How often a creature re-decides, in seconds.
 *
 * Beyond Extinction's 0.15 s, kept, and the reason is worth stating: with
 * two hundred worms and a colony of ants, thinking every frame is two
 * hundred sense passes at sixty hertz to make decisions that change maybe
 * twice a minute. Throttling is not an optimisation here, it is the
 * difference between a brain that scales and one that does not.
 *
 * It is NOT a movement tick. Creatures still move every frame; only the
 * decision is throttled, so nothing stutters.
 */
export const THINK_S = 0.15;

/**
 * How long a creature rests before getting on with something, in seconds.
 *
 * Resting is the state with a timeout; wandering is what it does otherwise.
 * The other way round — wander until told to stop — left every creature
 * frozen at its birth state, because nothing ever told one to stop.
 */
export const IDLE_S = 3;

/** Everything a creature currently is, as opposed to what its species is. */
export interface CreatureMind {
  behaviour: Behaviour;
  /** How long it has been doing that, in seconds. */
  forS: number;
  health: number;
  stamina: number;
  /** 0 to 100. Rises on its own; eating resets it. */
  hunger: number;
  /** Seconds of anger left after being hit. Zero is calm. */
  angryFor: number;
  /** Seconds until it may strike again. */
  cooldownFor: number;
  /** Accumulated time since the last decision — see `THINK_S`. */
  sinceThink: number;
}

/**
 * A fresh mind for a newly spawned creature.
 *
 * `phase` is 0..1 and offsets the think clock. Pass a different one per
 * creature — from whatever seeded random the caller already has — or two
 * hundred worms spawned on one frame think on the same frame forever after,
 * and the throttle becomes a periodic spike instead of a smooth load.
 *
 * It is a PARAMETER rather than a `Math.random()` inside because this file
 * is pure: given the same arguments it must return the same mind, or the
 * tests are not tests. An earlier version simply set it to zero and claimed
 * in a comment to have staggered it, which is worse than not staggering.
 */
export function newMind(kind: CreatureKind, phase = 0): CreatureMind {
  return {
    behaviour: 'idle',
    forS: 0,
    health: kind.maxHealth,
    stamina: kind.maxStamina,
    hunger: 0,
    angryFor: 0,
    cooldownFor: 0,
    sinceThink: Math.max(0, Math.min(1, phase)) * THINK_S,
  };
}

/** What a creature can tell about something else in the world. */
export interface Sighting {
  /** How far away, in millimetres. */
  readonly distMm: number;
  /**
   * Where it is relative to the way this creature is facing, in RADIANS —
   * zero is dead ahead. Used against `fovDeg`.
   */
  readonly bearing: number;
  /** Its bulk, for deciding whether it is prey or a threat. */
  readonly size: number;
  /** Whether it is something this creature could eat. */
  readonly edible: boolean;
}

/**
 * Can it see that at all?
 *
 * Range and arc together, because an animal with eyes on the side of its
 * head genuinely cannot see behind it, and a creature that reacts to
 * something at its back reads as cheating.
 */
export function canSee(kind: CreatureKind, what: Sighting): boolean {
  if (what.distMm > kind.sightMm) return false;
  const half = (kind.fovDeg * Math.PI) / 180 / 2;
  return Math.abs(what.bearing) <= half;
}

/**
 * Should it pick a fight?
 *
 * THE ONE BEHAVIOURAL BUG THAT CAME ACROSS WITH THE PORT, already fixed at
 * the source. Beyond Extinction's note on `neutralShouldEngage` records it:
 * "neutral was at least as aggressive as aggressive". A neutral animal that
 * engages on sight is just an aggressive animal with a different label. The
 * distinction only means something if neutral needs a REASON — it has been
 * hit, or you have walked inside its personal space.
 */
export function shouldEngage(
  kind: CreatureKind, what: Sighting, angry: boolean,
): boolean {
  switch (kind.temperament) {
    case 'passive':
    case 'skittish':
      return false;
    case 'neutral':
      return angry || what.distMm <= kind.aggroMm;
    case 'aggressive':
      /* Across its whole aggro range, unprompted — that is what the word
       * means, and what makes it different from the case above. */
      return what.distMm <= kind.aggroMm;
    default:
      return false;
  }
}

/**
 * Should it run?
 *
 * Two separate reasons, and both matter. A skittish animal runs from
 * anything bigger than itself whatever its health; anything else runs only
 * when it is hurt badly enough. `fleeHealth` of zero means an animal that
 * fights to the death, which is a real choice for a defensive species.
 */
export function shouldFlee(
  kind: CreatureKind, mind: CreatureMind, threat: Sighting | null,
): boolean {
  if (threat && kind.temperament === 'skittish' && threat.size >= kind.size) {
    return true;
  }
  if (kind.fleeHealth <= 0) return false;
  return mind.health <= kind.maxHealth * kind.fleeHealth;
}

/**
 * Is that worth eating?
 *
 * Size-gated, from the source: a carnivore only hunts what it can actually
 * bring down. Without the gate a hungry small predator commits suicide on
 * the biggest thing it can see, which reads as broken rather than as brave.
 */
export function isPrey(kind: CreatureKind, what: Sighting): boolean {
  if (kind.diet === 'herbivore') return false;
  if (!what.edible) return false;
  return what.size <= kind.size;
}

/** Is it hungry enough to go looking? Herbivores never are, in this sense. */
export function wantsToHunt(kind: CreatureKind, mind: CreatureMind): boolean {
  if (kind.diet === 'herbivore') return false;
  return mind.hunger >= kind.huntAt;
}

/** What the world looks like from where this creature is standing. */
export interface Senses {
  /** The nearest thing it might fight or flee, already filtered by `canSee`. */
  readonly threat: Sighting | null;
  /** The nearest thing it might eat. */
  readonly prey: Sighting | null;
  /** How far it has strayed from where it started, in millimetres. */
  readonly fromHomeMm: number;
}

/**
 * WHAT IT DOES NEXT.
 *
 * Ordered by urgency, and the order IS the design — every rung overrides
 * everything below it. Dead beats hurt, hurt beats hungry, hungry beats
 * bored. Reading it top to bottom is reading the animal's priorities.
 *
 * Returns the behaviour only. Nothing here moves anything: see the note at
 * the top of this file about deciding versus acting.
 */
export function think(
  kind: CreatureKind, mind: CreatureMind, senses: Senses,
): Behaviour {
  if (mind.health <= 0) return 'dead';

  /* Eating is brief and uninterruptible — an animal that abandoned its meal
   * the instant anything else happened would never finish one. */
  if (mind.behaviour === 'eat' && mind.forS < kind.eatTimeS) return 'eat';

  if (shouldFlee(kind, mind, senses.threat)) return 'flee';

  /*
   * ON A LEASH. Past `giveUpMm` from home it goes back regardless of what
   * it wanted — this is what stops one aggressive creature following you
   * across the whole island, and what keeps a population where it was put.
   */
  if (senses.fromHomeMm > kind.giveUpMm) return 'wander';

  const threat = senses.threat;
  if (threat && shouldEngage(kind, threat, mind.angryFor > 0)) {
    /* Close enough to bite, and not still recovering from the last one. */
    if (threat.distMm <= kind.attackMm && mind.cooldownFor <= 0) return 'attack';
    return 'chase';
  }

  if (wantsToHunt(kind, mind)) {
    const prey = senses.prey;
    if (prey && isPrey(kind, prey)) {
      if (prey.distMm <= kind.attackMm && mind.cooldownFor <= 0) return 'attack';
      return 'hunt';
    }
    /* Hungry with nothing in sight: go looking rather than stand still. */
    return 'wander';
  }

  /*
   * NOTHING TO DO, so it gets on with something.
   *
   * A first cut returned the CURRENT behaviour here whenever it was already
   * idle or wandering, on the theory that the caller would decide when to
   * flip. No caller did, and since a fresh mind starts idle, every creature
   * on the island idled forever — which is the exact "animal that stands
   * still until something happens to it is scenery" failure this comment
   * was warning about. Caught by `probe:brain` in the running game, where
   * two hundred worms had been sitting at `idle` for thirty seconds.
   *
   * So resting is a state with a TIMEOUT and wandering is the default. A
   * caller that wants a creature to stop and rest asks for it by name with
   * `setBehaviour(mind, 'idle')`, and gets `IDLE_S` of it.
   */
  if (mind.behaviour === 'idle' && mind.forS < IDLE_S) return 'idle';
  return 'wander';
}

/**
 * Advance the clocks: hunger, anger, attack cooldown, stamina.
 *
 * Split from `think` because it must run EVERY FRAME while thinking is
 * throttled — a cooldown that only ticked on think frames would be quantised
 * to 0.15 s and a creature could not be hit at a rate finer than that.
 *
 * Stamina recovers here and nowhere else, which keeps this file honest
 * against the project's survival rule: a bar may only move if there is a way
 * to move it back.
 */
export function tickMind(
  kind: CreatureKind, mind: CreatureMind, dt: number, spending: boolean,
): void {
  if (dt <= 0) return;
  mind.forS += dt;
  mind.sinceThink += dt;
  if (mind.angryFor > 0) mind.angryFor = Math.max(0, mind.angryFor - dt);
  if (mind.cooldownFor > 0) mind.cooldownFor = Math.max(0, mind.cooldownFor - dt);
  /* Herbivores get hungry too — they just do not hunt for it. Capped, so a
   * creature nobody visits for an hour is not infinitely starving. */
  mind.hunger = Math.min(100, mind.hunger + kind.hungerRate * dt);
  const drain = kind.maxStamina * 0.12;
  const regen = kind.maxStamina * 0.08;
  mind.stamina = spending
    ? Math.max(0, mind.stamina - drain * dt)
    : Math.min(kind.maxStamina, mind.stamina + regen * dt);
}

/** Is a decision due? Consumes the accumulator when it is. */
export function thinkDue(mind: CreatureMind): boolean {
  if (mind.sinceThink < THINK_S) return false;
  mind.sinceThink -= THINK_S;
  return true;
}

/** Move to a new behaviour, restarting its clock only on a real change. */
export function setBehaviour(mind: CreatureMind, next: Behaviour): void {
  if (mind.behaviour === next) return;
  mind.behaviour = next;
  mind.forS = 0;
}

/**
 * Take a hit.
 *
 * Anger is set here rather than in `think`, because being hit is an EVENT
 * and the throttled decision pass would otherwise miss one that arrived and
 * expired between two thinks. Returns whether that killed it.
 */
export function wound(
  kind: CreatureKind, mind: CreatureMind, amount: number,
): boolean {
  if (mind.health <= 0) return false;
  mind.health = Math.max(0, mind.health - Math.max(0, amount));
  mind.angryFor = kind.reprovokeS;
  if (mind.health > 0) return false;
  mind.behaviour = 'dead';
  mind.forS = 0;
  return true;
}

/** Finish a meal: hunger cleared, cooldown started. */
export function feed(kind: CreatureKind, mind: CreatureMind): void {
  mind.hunger = 0;
  mind.cooldownFor = kind.cooldownS;
}

/** How fast it should be going, for the behaviour it is in. */
export function speedMm(kind: CreatureKind, mind: CreatureMind): number {
  switch (mind.behaviour) {
    case 'chase':
    case 'hunt':
    case 'flee':
      return kind.chaseSpeedMm;
    case 'wander':
      return kind.wanderSpeedMm;
    default:
      /* Idle, attacking, eating and dead are all standing still — an animal
       * that drifts while biting looks like it is skating. */
      return 0;
  }
}
