/**
 * HOW BIG EACH CREATURE IS, and how much to shrink its model to get there.
 *
 * Two different kinds of number live here and the file would be a menace if
 * it did not say which is which.
 *
 * `mm` IS MEASURED BIOLOGY and is cited. Joshua researched these; they are
 * what the animal actually is, not what plays well.
 *
 * `fit` IS ARITHMETIC — the target divided by the model's own body length,
 * solved by `probe:scale` against the files in `public/models`. It is not a
 * taste decision and must not be hand-nudged: a re-export of a model
 * changes it, and the way to change it is to re-run the probe.
 *
 * ## Why the model's length is not its bounding box
 *
 * All three of these would have been scaled WRONG by the obvious method,
 * each in its own way.
 *
 * The earthworm is rigged in an S, so its box is 55.5 x 44.4 while the
 * animal along its spine is 128.7 — scaling the box to 150 mm would have
 * produced a worm less than half the length asked for. The housefly and
 * the aphid have the opposite problem: their boxes are 23.6 and 14.1, but
 * that is wings and splayed legs. Their bodies are 9.2 and 6.7.
 *
 * So the length is measured ALONG THE SPINE — the longest bone chain that
 * stays near the median plane, since legs and wings splay off it in
 * mirrored pairs and a backbone does not. And never using the Y extent,
 * which every auto-rigged model here reports as exactly 8.5 because the
 * rigger normalises into a fixed box.
 *
 * ## What the hierarchy comes out as
 *
 * Against the queen's 9 mm: an aphid is a quarter of her, a housefly is
 * about three quarters, and an earthworm is nearly seventeen of her. That
 * last one is the interesting one for design — a worm is not an animal she
 * fights, it is terrain that moves.
 */

/** A creature's real size, and the scale that gets its model there. */
export interface CreatureScale {
  /** The model file in `public/models`. */
  readonly model: string;
  /** Body length in millimetres — measured biology. See `source`. */
  readonly mm: number;
  /** Where that number comes from. */
  readonly source: string;
  /**
   * Multiply the loaded model by this. Solved by `probe:scale`; the value
   * it divides is the model's own spine length, noted here so a drifted
   * re-export is obvious rather than silent.
   *
   * FULL PRECISION, not rounded to something readable. `modelMm * fit` has
   * to reproduce `mm` exactly, because that identity is the only thing
   * standing between a re-exported model and a silently wrong size — and a
   * rounded length times an unrounded scale does not.
   */
  readonly fit: number;
  /** What the model measures along its spine before `fit`, in mm. */
  readonly modelMm: number;
}

/** The queen, for scale — what every one of these is read against. */
export const QUEEN_MM = 9;

export const CREATURES: Record<string, CreatureScale> = {
  housefly: {
    model: 'housefly.glb',
    mm: 6.5,
    source: 'Musca domestica body 4-8 mm, mean 6.35 — Animal Diversity Web',
    fit: 0.7091318219187078,
    modelMm: 9.166137802718907,
  },
  aphid: {
    model: 'aphid.glb',
    mm: 2.5,
    /* The one where species matters most: aphids run from under 1 mm to
     * nearly 8. 2-4 is the garden aphid a player recognises. */
    source: 'garden aphids 1.5-4 mm — UMN and MSU Extension',
    fit: 0.37481517612977344,
    modelMm: 6.669954044588677,
  },
  earthworm: {
    model: 'earthworm.glb',
    mm: 150,
    /* Deliberately not the top of the range. "Earthworm" is not one size —
     * Lumbricus terrestris runs 120-250 — and at 250 she would be sharing
     * the island with something the length of the whole nest. */
    source: 'Lumbricus terrestris commonly 120-250 mm — U. Maryland, Dimensions.com',
    fit: 1.1655090707915066,
    modelMm: 128.6991270673971,
  },
};

/** How many queens long a creature is — the number that says what it IS. */
export function inQueens(id: keyof typeof CREATURES | string): number {
  const c = CREATURES[id];
  return c ? c.mm / QUEEN_MM : 0;
}
