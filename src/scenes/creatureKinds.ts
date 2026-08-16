/**
 * THE ISLAND'S ANIMALS, AS DATA.
 *
 * The half of the Beyond Extinction port that is numbers rather than logic —
 * `Dinos/dino_config.gd`'s idea, which its own header states plainly: "each
 * entry is a pure dictionary of species stats; the AI reads these, no
 * behaviour lives here." Adding a species must never mean adding an `if`.
 *
 * It sits beside `antKinds.ts` rather than inside it, and the split is real:
 * `antKinds` answers "what can this ant DO" — which HUD plates it has, which
 * abilities are built. This answers "how does this creature BEHAVE when
 * nobody is driving it". The queen needs the first and not the second; a
 * worm needs the second and not the first; a colonist ant will want both,
 * which is the case that would have made one merged table awkward.
 *
 * ## The numbers are ours, the shape is theirs
 *
 * Beyond Extinction's figures are metres and tonnes for animals a thousand
 * times bigger. Nothing transfers. Every number below is either measured
 * biology with a source, or game tuning that says so.
 */
import type { CreatureKind } from './creatureBrain';

/**
 * THE EARTHWORM — the first animal with a brain, and the one that shows
 * what the brain is for.
 *
 * ## Temperament: skittish
 *
 * An earthworm has no defence at all. It cannot bite, it cannot outrun
 * anything, and its entire answer to a threat is to withdraw down its own
 * burrow — which is exactly what `skittish` means and why the tier exists.
 * Measured biology: Lumbricus terrestris retreats into its burrow in
 * response to vibration, which is the basis of the old "worm charming" trick
 * and of the well-documented escape response to mole vibrations (Catania,
 * K. C., 2008, PLoS ONE 3(10): e3472, "Worm Grunting, Fiddling, and
 * Charming"). A worm that stood its ground would be the wrong animal.
 *
 * ## Diet: herbivore
 *
 * Detritivore in truth — it eats decaying leaf litter and soil organic
 * matter, not living plants. `herbivore` is the closest tier we have and the
 * one that matters here, because what it actually controls is "never hunts,
 * and counts as prey", both of which are right.
 *
 * ## Senses
 *
 * A worm has no eyes. It has light-sensitive cells and, far more usefully,
 * it is exquisitely sensitive to vibration through the soil. So `fovDeg` is
 * 360 — it senses in every direction and cannot be crept up on from behind
 * — and `sightMm` is short, because vibration through packed earth does not
 * carry far. That combination is not a fudge; it is what having no eyes and
 * good touch actually feels like from the inside.
 *
 * ## The rest
 *
 * `attackMm` and `damage` are zero and stay zero: there is no arrangement of
 * circumstances in which an earthworm attacks anything. Health is game
 * tuning — soft enough that stepping on one matters, high enough that a
 * glancing knock does not delete it.
 */
export const EARTHWORM: CreatureKind = {
  id: 'earthworm',
  temperament: 'skittish',
  diet: 'herbivore',
  habitat: 'soil',
  /* Relative bulk. A 150 mm worm against a 9 mm queen is enormous by length
   * but it is a soft tube: this is what a predator weighs up, not a ruler. */
  size: 2.5,

  maxHealth: 40,
  maxStamina: 60,

  /* Vibration through soil, not sight — see above. */
  sightMm: 60,
  aggroMm: 30,
  attackMm: 0,
  fovDeg: 360,

  damage: 0,
  windupS: 0,
  cooldownS: 0,

  /* Its wander speed IS its dig speed, because for a worm those are the
   * same act — see `WORM_STEP_MM`, which this must agree with. */
  wanderSpeedMm: 3,
  /* Fleeing, it withdraws faster than it digs. Game tuning: a worm that fled
   * at its digging speed would never appear to react at all. */
  chaseSpeedMm: 7,

  /* It has the whole island, so the leash is long — Joshua's placement. The
   * band it lives in is the real constraint, not a radius. */
  leashMm: 20000,
  giveUpMm: 40000,

  /* Slow. A worm eats constantly and quietly; hunger here exists so the
   * stat is real rather than because a worm ever goes hunting. */
  hungerRate: 0.4,
  huntAt: 101,
  eatTimeS: 6,

  /* Withdraws at any real injury — a worm has no fight in it. */
  fleeHealth: 0.85,
  reprovokeS: 4,
};

/**
 * THE APHID — the small, soft, defenceless one.
 *
 * Replaces the procedural ladybug as the thing you meet, at Joshua's ask:
 * "about the same 2-3 mm like a real aphid."
 *
 * ## Temperament: skittish
 *
 * An aphid's entire defence is leaving. It has no jaws worth the name — its
 * mouthparts are a stylet built for piercing plant tissue, not for fighting
 * — so `attackMm` and `damage` are zero and stay zero, exactly as the
 * worm's are. What it does have is a startle response: measured biology,
 * aphids drop bodily off the plant when disturbed, and alarm pheromone
 * (E-beta-farnesene) sends the whole colony walking away or dropping
 * (Pickett & Griffiths 1980, J. Chem. Ecol. 6:349). `skittish` is that.
 *
 * This is the deliberate difference from the ladybug it replaces. That one
 * fought back and could kill her. An aphid cannot, and a bestiary where the
 * only creature is a threat is a poorer one than a bestiary with something
 * in it worth catching.
 *
 * ## Senses
 *
 * Compound eyes but poor resolution, and it lives by touch and smell. A
 * short sight range with a WIDE arc is the honest shape of that: it will
 * not spot you across the clearing, and it is very hard to sneak up on.
 */
export const APHID: CreatureKind = {
  id: 'aphid',
  temperament: 'skittish',
  diet: 'herbivore',
  habitat: 'land',
  /* 2.5 mm against the queen's 9 — see `creatureScale`, where the figure is
   * cited to UMN and MSU Extension for garden aphids at 1.5-4 mm. */
  size: 0.3,

  maxHealth: 12,
  maxStamina: 30,

  sightMm: 40,
  aggroMm: 18,
  attackMm: 0,
  fovDeg: 300,

  damage: 0,
  windupS: 0,
  cooldownS: 0,

  /* Slow and short-legged. Game tuning: an aphid walks, it does not run,
   * and its escape is dropping rather than sprinting. */
  wanderSpeedMm: 2,
  chaseSpeedMm: 5,

  leashMm: 120,
  giveUpMm: 260,

  hungerRate: 0.5,
  huntAt: 101,
  eatTimeS: 5,

  /* Leaves at the first sign of trouble — that is the whole animal. */
  fleeHealth: 0.9,
  reprovokeS: 3,
};

/**
 * THE HOUSEFLY — the one that does not stay on the ground.
 *
 * 6.5 mm, near three quarters of the queen, and the first creature here
 * whose habitat is genuinely not hers. It is `passive`: a fly has no
 * interest in an ant and no means of hurting one. What it has is a startle
 * distance and the ability to simply leave, which makes it the island's
 * first animal that is a SIGHT rather than an encounter.
 *
 * `habitat` is `land` because flight is not modelled yet and claiming a
 * habitat the game cannot honour would be the kind of lie this table
 * exists to avoid. When flight arrives it gets its own case; until then it
 * walks, which is a thing houseflies do a great deal of.
 */
export const HOUSEFLY: CreatureKind = {
  id: 'housefly',
  temperament: 'skittish',
  diet: 'herbivore',
  habitat: 'land',
  /* 6.5 mm — Animal Diversity Web, via `creatureScale`. */
  size: 0.75,

  maxHealth: 20,
  maxStamina: 80,

  /* The best eyes on the island by a distance, and near-panoramic. Getting
   * close to one should feel like an achievement. */
  sightMm: 220,
  aggroMm: 90,
  attackMm: 0,
  fovDeg: 340,

  damage: 0,
  windupS: 0,
  cooldownS: 0,

  wanderSpeedMm: 6,
  chaseSpeedMm: 30,

  leashMm: 400,
  giveUpMm: 900,

  hungerRate: 0.8,
  huntAt: 101,
  eatTimeS: 3,

  fleeHealth: 0.95,
  reprovokeS: 2,
};

/**
 * THE BEETLE AND THE LADYBUG — KEPT AS DATA, ABSENT FROM THE WORLD.
 *
 * Joshua: "as far as the beetle, remove it as I will add a real GLB
 * beetle(s) and a ladybug later... maybe don't remove completely, but keep
 * in the insect brain database so it can work for later in the insects
 * array."
 *
 * So these are entries with no model and no spawn. That is a deliberate
 * shape rather than dead code: the whole point of a data-driven bestiary is
 * that adding a creature is a table row, and these rows are already written
 * and already tested. When the GLBs arrive they need a file name and a
 * spawn, not a design.
 *
 * The beetle is where the island's first real THREAT lives. It keeps the
 * numbers the procedural one fought with — it could and did kill her — so
 * nothing about the difficulty has to be rediscovered.
 */
export const BEETLE: CreatureKind = {
  id: 'beetle',
  /* Neutral, not aggressive: it ignores her until she starts something, and
   * then it means it. See `shouldEngage` for why that distinction is real. */
  temperament: 'neutral',
  diet: 'omnivore',
  habitat: 'land',
  size: 1.4,

  maxHealth: 120,
  maxStamina: 100,

  sightMm: 120,
  aggroMm: 45,
  attackMm: 8,
  fovDeg: 200,

  damage: 14,
  windupS: 0.35,
  cooldownS: 1.5,

  wanderSpeedMm: 5,
  chaseSpeedMm: 14,

  leashMm: 300,
  giveUpMm: 700,

  hungerRate: 0.9,
  huntAt: 60,
  eatTimeS: 4,

  fleeHealth: 0.2,
  reprovokeS: 6,
};

/** A ladybug is a small beetle that eats aphids — which is why it is here. */
export const LADYBUG: CreatureKind = {
  id: 'ladybug',
  temperament: 'passive',
  /* The one carnivore on the island so far, and its prey is already in this
   * table: `size` 0.3 for an aphid against 0.6 here means a ladybug can hunt
   * one and nothing else. That is a food chain waiting for two models. */
  diet: 'carnivore',
  habitat: 'land',
  size: 0.6,

  maxHealth: 45,
  maxStamina: 70,

  sightMm: 90,
  aggroMm: 30,
  attackMm: 5,
  fovDeg: 220,

  damage: 6,
  windupS: 0.3,
  cooldownS: 1.2,

  wanderSpeedMm: 4,
  chaseSpeedMm: 11,

  leashMm: 250,
  giveUpMm: 600,

  hungerRate: 1.2,
  huntAt: 45,
  eatTimeS: 5,

  fleeHealth: 0.35,
  reprovokeS: 5,
};

/**
 * Every creature the island can run a brain for, by id.
 *
 * Being in here does NOT mean being in the world — see `BEETLE` and
 * `LADYBUG`, which are waiting on models. What it means is that the brain
 * knows how the animal behaves, so putting one in the world is a spawn
 * rather than a design.
 */
export const CREATURE_KINDS: Readonly<Record<string, CreatureKind>> = {
  earthworm: EARTHWORM,
  aphid: APHID,
  housefly: HOUSEFLY,
  beetle: BEETLE,
  ladybug: LADYBUG,
};
