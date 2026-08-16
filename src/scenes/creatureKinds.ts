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

/** Every creature the island can run a brain for, by id. */
export const CREATURE_KINDS: Readonly<Record<string, CreatureKind>> = {
  earthworm: EARTHWORM,
};
