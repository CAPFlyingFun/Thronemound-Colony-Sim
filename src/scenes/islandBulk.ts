/**
 * WHO SHOVES WHOM — one rule for props, insects and ants alike.
 *
 * Asked for: "can the objects collide with each other and the ants? Maybe we
 * need to make an array or weight/push system like Path of Titans so the
 * heavier the object or ant, the more it can push/pull/carry."
 *
 * That is the right shape for it, and the reason is that it collapses three
 * problems into one. A pebble against a stone, a queen against a pebble and
 * an ant against another ant are the same question — two things overlap, so
 * how much does each give way? — and answering it once means a ladybug added
 * next week gets collision with everything for free, by having a mass.
 *
 * INVERSE MASS DECIDES THE SHARE, which is the whole of it. Each body moves
 * by the OTHER's fraction of the total, so a 12 mg queen walking into a
 * 120 mg stone takes 91% of the correction and the stone barely notices,
 * while the same queen against a 3 mg seed sends it skittering and hardly
 * breaks stride. Nothing needs a "can push" flag: heavy things push light
 * ones because the arithmetic says so.
 *
 * SEPARATE FROM THE TERRAIN, deliberately. `islandProps` resolves a shape
 * against the soil, which is a FIELD and answers "am I inside you" at a
 * point. This is body-against-body, which is pairwise and has no field to
 * ask. Keeping them apart means neither grows a special case for the other,
 * and it is why this file imports nothing but three.
 *
 * ROUND, and honestly so. Bodies are treated as spheres here even though
 * their terrain collision is shaped, because a twig shoving a pebble by its
 * exact silhouette is work nobody will see at 4 mm across — while a twig
 * sinking into a stone is obvious. Radius is the cheap answer to the visible
 * half of the problem.
 */
import * as THREE from 'three';

/** A thing with mass and extent that other things should not sit inside. */
export interface Bulk {
  readonly id: string;
  /** Its position, WRITTEN here when it is pushed. */
  readonly at: THREE.Vector3;
  /** How far it reaches from that centre. */
  readonly radius: number;
  /** What it weighs. The only thing that decides who gives way. */
  readonly massMg: number;
  /**
   * Held or planted: it takes no push at all and gives its whole share to
   * whatever hit it. A carried seed must not be knocked out of her jaws by
   * the beetle she is walking past.
   */
  readonly anchored?: boolean;
}

const GAP = new THREE.Vector3();

/**
 * How much of a correction each of two bodies takes, lighter first.
 *
 * Pulled out because it IS the design, and a rule buried in a loop is a rule
 * nobody can check. Returns the share for `a`; `b` takes the rest.
 *
 * An anchored body takes none and hands over its whole share. Two anchored
 * bodies take none each — they are both planted, and shoving one would be
 * inventing a winner where the situation has none.
 */
export function pushShare(a: Bulk, b: Bulk): number {
  if (a.anchored) return 0;
  if (b.anchored) return 1;
  const total = a.massMg + b.massMg;
  if (!(total > 0)) return 0.5;
  /* The OTHER's fraction: heavy `b` means `a` does the moving. */
  return b.massMg / total;
}

/**
 * Push every overlapping pair apart, once.
 *
 * ONE PASS, not solved to convergence. Three things in a corner will still
 * overlap slightly after this and be tidied next frame, which is invisible;
 * iterating instead would spend the frame budget of a physics engine on a
 * pebble nobody is looking at. The one thing a single pass must not do is
 * oscillate, and it cannot: every correction strictly reduces overlap.
 *
 * Quadratic in the body count and that is fine at this scale — a handful of
 * props, a few insects and her. If a colony of two hundred ever shares this
 * list, the fix is a grid, not a cleverer inner loop.
 */
export function resolveBulk(bodies: readonly Bulk[]): number {
  let moved = 0;
  for (let i = 0; i < bodies.length; i += 1) {
    const a = bodies[i]!;
    for (let j = i + 1; j < bodies.length; j += 1) {
      const b = bodies[j]!;
      if (a.anchored && b.anchored) continue;
      GAP.subVectors(b.at, a.at);
      const want = a.radius + b.radius;
      const d2 = GAP.lengthSq();
      if (d2 >= want * want) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        /* Exactly co-located — no direction to separate along, so pick one
         * rather than dividing by nothing. Sideways, because two things at
         * the same spot are usually on the same floor. */
        GAP.set(1, 0, 0);
        d = 1e-6;
      } else {
        GAP.multiplyScalar(1 / d);
      }
      const overlap = want - d;
      const share = pushShare(a, b);
      if (share > 0) a.at.addScaledVector(GAP, -overlap * share);
      if (share < 1) b.at.addScaledVector(GAP, overlap * (1 - share));
      moved += 1;
    }
  }
  return moved;
}
