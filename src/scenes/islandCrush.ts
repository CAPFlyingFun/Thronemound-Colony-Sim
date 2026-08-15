/**
 * WHAT IT COSTS TO BE RUN OVER.
 *
 * Asked for: "for the heavy objects, we should like take some HP loss if
 * like getting run over by a heavy rock or something, maybe like 30% since
 * ants' bodies are flexible but too much will obviously kill/injure them
 * greatly."
 *
 * MOMENTUM DECIDES IT, not mass and not speed on their own. Mass alone
 * would have a stone resting against her ankle doing 30% a frame, and speed
 * alone would have a seed skittering past at a run hurting as much as a
 * boulder. What hurts is mass TIMES speed — the thing the exoskeleton has
 * to absorb — and it is one number, so there is one curve rather than a
 * table of cases.
 *
 * THIS IS GAME TUNING INSPIRED BY BIOLOGY, not measured biology, and the
 * distinction matters enough to say plainly. The shape of it is honest: an
 * ant's cuticle is a jointed tube that deforms and springs back, which is
 * why they walk away from falls and pinches that would flatten a vertebrate
 * of the same relative size, and it is the reason a light knock costs
 * NOTHING here instead of a sliver. Where exactly the free band ends and
 * how steeply it climbs after are chosen to make a stone at a full roll
 * cost the 30% asked for. No paper says 30%.
 *
 * THE CURVE HAS NO CEILING OF ITS OWN. Nothing on the island today can
 * reach a kill from full health — a 120 mg stone at its terminal roll comes
 * to 0.30, and at the speed cap 0.45 — but a heavier thing added later
 * will, and it should. "Too much will obviously kill" is the request, and
 * a curve that quietly refused to would be lying about its own numbers.
 */

/** Below this momentum an ant shrugs it off entirely — mg x units/second. */
export const CRUSH_FREE = 25;

/**
 * Seconds before the SAME thing can crush her again.
 *
 * A latch that cleared as soon as the two stopped touching was the first
 * attempt, and the live probe found it charging ten times for one event:
 * 55.7, then 7.4, 7.5, 7.6, 1.5, 2.7, 3.5, 4.2, 4.8, 9.3 — a stone landing
 * on her, being shoved clear, falling back and landing again while it
 * settled. One rock, ninety frames, the whole bar.
 *
 * Contact is the wrong thing to gate on, because a thing coming to rest ON
 * her genuinely does touch, separate and touch again. A crushing is ONE
 * event, so the gate is time. It doubles as the refractory period a real
 * injury has, and it stops a stone jittering against her on a bank from
 * grinding the bar down a sliver at a time.
 */
export const CRUSH_AGAIN_AFTER = 1.5;

/**
 * How far past touching still counts as being run over, world units.
 *
 * The shove resolves an overlap to EXACTLY zero, so a contact tested at
 * exactly the sum of the radii is a coin flip on the last bit of a float.
 * A tenth of a millimetre of slack turns that into a fact.
 */
export const CRUSH_REACH_SLACK = 0.02;

/**
 * The momentum that costs `CRUSH_SHARE`: a stone at a full roll.
 *
 * 120 mg at 1.8 units a second, which is what `islandProps` settles a stone
 * at on a steep bank. Written as the product so that changing either the
 * stone or the roll tuning shows up here as a number that no longer
 * matches, rather than as a silent drift in how much it hurts.
 */
export const CRUSH_FULL = 120 * 1.8;

/** What that costs, as a fraction of full health. Joshua's number. */
export const CRUSH_SHARE = 0.3;

/**
 * THE CURVE FLATTENS, and it has to.
 *
 * A straight line through the free band and the stone was the first
 * attempt, and the live probe killed it — literally. Falling is much faster
 * than rolling: a stone rolls at about 1.8 and falls at up to 6, so the
 * same 120 mg reaches four times the momentum by dropping fifteen
 * millimetres onto her. On a straight line that is 109% of the bar, and a
 * stone nudged off a ledge a body-length up was an instant death. Measured,
 * not guessed: health 100 to 0 in ninety frames.
 *
 * A square root is the fix and it is not an arbitrary one. What an
 * exoskeleton does under a load is CRUMPLE — it deforms progressively, and
 * each further increment of impulse is absorbed a little better than the
 * last, which is the same reason a crumple zone works and why doubling a
 * car's speed does not double its occupants' injuries. Modelling that as a
 * concave curve is right in shape. The exponent is chosen, not derived.
 *
 * What it produces: a stone rolling into her is the 30% asked for; the same
 * stone dropped on her head is 57%, a severe injury she survives from full
 * health; a pebble falling on her is 22%; a seed is nothing at all. And it
 * still reaches a kill — around 2,150, roughly a 360 mg thing at a full
 * fall — so "too much will obviously kill" stays true and stays out of
 * reach of anything currently on the island.
 */
const CRUSH_FALLOFF = 0.5;

/**
 * Health lost when something of this mass, moving this fast, runs her over.
 *
 * Zero for anything under the free band, which is most contacts: she pushes
 * seeds around constantly and none of that is an injury.
 */
export function crushDamage(massMg: number, speed: number, healthMax: number): number {
  const momentum = Math.max(0, massMg) * Math.max(0, speed);
  if (momentum <= CRUSH_FREE) return 0;
  const over = (momentum - CRUSH_FREE) / (CRUSH_FULL - CRUSH_FREE);
  return Math.min(healthMax, healthMax * CRUSH_SHARE * over ** CRUSH_FALLOFF);
}
