/**
 * THE ISLAND'S NUMBERS, AND ITS SCRATCH POOL.
 *
 * Lifted out of `IslandScene.ts` unchanged — every constant, every comment,
 * in the same order it was declared in. Nothing here was retuned on the way
 * across; this is a move, not an edit, so a `git log -p` on any one of these
 * numbers still reaches the measurement that chose it.
 *
 * It earns its own file because it is REFERENCE rather than behaviour: eight
 * hundred lines of tuning that the scene reads and never writes, sitting
 * between the imports and the first line of actual code. Most of the volume
 * is the notes, and the notes are the point — nearly every number in here
 * was measured rather than picked, and the measurement is written down beside
 * it so the next person does not re-guess it.
 *
 * The scratch vectors travel with them deliberately. They are shared mutable
 * singletons, and the one bug they have ever caused (v0.1.2, the camera
 * standing in the ocean) came from two call sites believing they owned the
 * same `S_TARGET`. Keeping the whole pool visible in one place is the cheapest
 * defence against a third site quietly borrowing a fourth one.
 */

import * as THREE from 'three';

import {
  CAP_PLANES, CELLS_Y, CELL_MM, CELL_SIZE, MM, TILE_CELLS, WINDOW_CELLS,
} from '../world/worldScape';



/** The island: 56 km of Kauai at 1:1000. Real metres ARE in-world mm. */
export const SPAN_MM = 56000;

/** The baked grid: 1025² int16 decimetres (see scripts/bakeKauai.py). */
export const N = 1025;
export const STEP_MM = SPAN_MM / (N - 1);

/** The rendered grid: every second sample — 513², 64 sections of 65². */
export const MESH_N = 513;
export const SECTIONS = 8;
export const SEC_VERTS = (MESH_N - 1) / SECTIONS + 1;

/** 15 mm/s — an unhurried queen. The first cut copied the world room's
 *  40 mm/s sprint and the island blurred past; playtest said so. Shift (or
 *  full stick) sprints at three times that for covering ground. */
/*
 * HALVED, and the gait halves with it.
 *
 * The legs cycle at a rate proportional to how fast she travels, so there
 * is no separate animation speed to turn down — slowing the animation by
 * half means slowing HER by half, which is the only way to do it with her
 * feet still landing where they touch. Three world units a second was 15
 * mm/s walking and 45 sprinting, near double the block room's pace on an
 * animal a third the size of its stride.
 */
/*
 * 9 mm/s WALKING, 16 SPRINTING — Joshua's numbers, and close to where this
 * already was (7.5 and 15).
 *
 * THESE ARE THE QUEEN'S. A founding Solenopsis queen is around 9 mm and is
 * carrying a gaster full of eggs on flight muscle she is in the middle of
 * digesting; she is built for one flight and then a lifetime of laying. Her
 * workers are 2-6 mm and are the ones built to travel, and they should end
 * up FASTER than her in absolute terms despite being smaller — which is why
 * this wants to become a caste row alongside `STRENGTH` and `CASTE_COMBAT`
 * the moment a second ant is playable.
 *
 * GAME TUNING against a real range, not a measured figure. Ants of this size
 * move on the order of centimetres a second and fire-ant foragers sit around
 * the low end of that; 16 mm/s is a defensible sprint for a laden queen and
 * would be slow for a worker. Nothing here is a citation and it should not
 * be read as one — see the note in CLAUDE.md about not letting a research
 * comment become permanent truth.
 */
export const WALK_SPEED = 1.8;

/*
 * SPRINT AND CRAWL ARE MULTIPLES OF THE WALK, not speeds — and reading them
 * as speeds is a mistake worth leaving a sign on.
 *
 * `paceScale` returns `SPRINT` or `CRAWL` and the result multiplies
 * WALK_SPEED, so the absolute pace is `WALK_SPEED * this * MM` mm/s. Taking
 * SPRINT = 3 to mean 3 world units — 15 mm/s — is out by the walk itself:
 * it is 3 x 1.5 = 4.5 units, 22.5 mm/s. `probe:gait` measured 21.5 and that
 * is what tripped it up.
 *
 * 2.5x THE WALK — 22.5 mm/s, and chosen as a multiple rather than derived
 * from a millimetre figure because that is what this number IS.
 *
 * It went to 16/9 for one version, which cut the sprint 29% from where it
 * had been, and the cut was accidental: the old SPRINT of 3 was read as
 * "3 world units, 15 mm/s" when it actually meant 3 x the walk, 22.5. Put
 * back deliberately, with the reasoning stated: "gives the player a
 * noticeable and satisfying burst when burning stamina".
 *
 * 2.5 body lengths a second on a 9 mm queen. That is slow for an ant and
 * meant to be — a worker is 2-6 mm and runs at 9-10 BL/s, so she is roughly
 * a quarter of a worker's pace in body lengths while being only about half
 * of it in absolute mm/s. Heavy and deliberate, which is what a gravid
 * founding queen is.
 */
export const SPRINT = 2.5;
/*
 * CRAWL — the third pace, and the one the wave gait was written for.
 *
 * 4 mm/s, up from 2.25 — and like SPRINT this is a MULTIPLE OF THE WALK,
 * not a speed. 4 against a 9 mm/s walk is 4/9.
 *
 * It is therefore the same number `GAIT_WAVE_BELOW` compares against, which
 * is what makes the coupling exact rather than approximate: the old 0.3 sat
 * under the old 0.35 threshold with almost nothing to spare, and 4/9 = 0.44
 * steps straight over it. Raising the crawl without moving the threshold
 * costs the crawl its gait and leaves the pace a label on a slower tripod —
 * measured, `probe:gait` went from "1 foot up" to "3". The two numbers
 * change together or not at all.
 */
export const CRAWL = 4 / 9;
export const PACE_NAMES = ['CRAWL', 'WALK', 'RUN'] as const;

/**
 * How much of her attitude comes from her FEET rather than from the ground
 * under her belly. See the blend at the `settle` call for the measurements.
 */
export const SUPPORT_SHARE = 0.5;

/**
 * HOW HARD THE FLOOR OF A TUNNEL PULLS HER BACK DOWN, as a share of her
 * attitude goal.
 *
 * Reported from the device: "the Queen... doesn't like to walk seamlessly
 * underground like above ground and maybe because it doesn't know what to
 * grab to, but should be obvious in a small tube." The last clause is the
 * whole diagnosis. Above ground the soil's gradient has exactly one answer
 * for which way is up. Inside a bore it has a full circle of them, all
 * equally true, so she rolls around the pipe — measured by `probe:tube`,
 * 374 of 900 frames UPSIDE DOWN on the ceiling, walking back the way she
 * came.
 *
 * What is missing is not a rail. It is gravity's opinion. A tunnel has a
 * floor because things fall to it, and nothing in a density gradient says
 * so. This is that preference, and it goes in as one more attitude hint to
 * the same `walker.settle` every other postural correction goes through —
 * NOT as a second movement system. See the note at the head of `simulate`:
 * the island once had a rail owning tunnels, a bore travel owning digging
 * and the walker owning the surface, and nearly every movement bug for a
 * week lived in the hand-offs between them rather than inside any one.
 *
 * Ranked BELOW the corner's pre-tilt, which is a deliberate turn and must
 * not be argued with, and ABOVE the foot polygon, which in this exact case
 * is the fault reinforcing itself: her six feet are planted on the wall she
 * should not be standing on, so they vote confidently for staying there.
 */
export const TUBE_FLOOR_SHARE = 0.85;

/**
 * Below this much world-up left after the tunnel's own direction is taken
 * out, the bore is too close to plumb for "down" to mean anything across
 * it, and the hint stands aside.
 *
 * It is not a special case for vertical shafts so much as the arithmetic
 * admitting where it stops: the pull is world up with the along-tunnel
 * component removed, which shrinks to nothing exactly as the tunnel stands
 * on end. A 30 mm entrance shaft is climbed with no opinion from this at
 * all, which is right — there is no floor in a chimney.
 */
export const TUBE_PLUMB_MIN = 0.25;

/*
 * SHE LEANS INTO IT — the body pitching on planted feet, which is the one
 * thing the robot rigs do that this does not.
 *
 * A hexapod's body is not welded to its legs: it can pitch over feet that
 * stay exactly where they are, and the legs absorb it. The robot literature
 * calls it body orientation control, and it is why those machines read as
 * animals leaning rather than tables sliding.
 *
 * It costs nothing here because it is PURELY THE DRAWN POSE. `at` — the
 * physics root the walker seats, the corner scheduler reasons about and the
 * chase camera follows — is untouched; only the model's own quaternion is
 * turned, and her feet are IK'd to WORLD anchors, so tilting the body moves
 * her hips and the legs take up the difference exactly as the real machine's
 * do. Nothing else has to be told about it at all.
 *
 * Two terms, because they read differently. ACCELERATION is the one an eye
 * notices: nose down as she takes off, nose up as she pulls up. SPEED adds a
 * small steady set forward, the attitude of an animal actually travelling.
 */
export const LEAN_PER_ACCEL = 0.035;
export const LEAN_AT_SPRINT = (4.5 * Math.PI) / 180;
export const LEAN_MAX = (9 * Math.PI) / 180;
/** Fast enough to read as a lean, slow enough to still be a body. */
export const LEAN_RATE = 6;
/*
 * THE SPEED IS SMOOTHED BEFORE IT IS DIFFERENTIATED, and that is what makes
 * the braking lean exist at all.
 *
 * Her drive stops her in a frame or two, so a raw per-frame acceleration is
 * a single enormous negative spike — and a lean with a 170 ms constant moves
 * about a tenth of the way toward a target held for 40 ms. Measured: nose
 * down 3.9 degrees taking off, and 0.0 pulling up, because the spike was
 * over before the body could answer it.
 *
 * Smoothing the SPEED first spreads that same change over the window, so the
 * deceleration is a signal the body has time to lean against. It also takes
 * the frame-pacing noise out of a number that is a difference of differences.
 */
export const LEAN_SPEED_RATE = 14;

/*
 * AND SHE BANKS INTO THE TURN — the same trick on the other axis.
 *
 * The rig's own diagram is a full roll-pitch-yaw on the body: R(-γ) roll,
 * R(-ψ) pitch, R(-α) yaw, applied to every foot's start position. It is
 * written negated there because they rotate the FOOT TARGETS into the
 * rotated body frame; rotating the body and leaving the feet in the world
 * is the same rotation the other way round, and it is the cheaper half
 * here because her feet are already anchored in the world.
 *
 * Pitch was the half that shows when she sets off. Roll is the half that
 * shows when she turns: the inside of the turn drops, which is what any
 * legged animal does with a body it can move over its feet.
 */
export const BANK_PER_TURN = 0.16;
export const BANK_MAX = (7 * Math.PI) / 180;
/*
 * HOW FAST SHE TURNS, ALL IN — and until now there was no such number.
 *
 * The stick was integrated TWICE: `BoreControl` swings the heading at its
 * own `YAW_RATE` of 1.5 rad/s and the island rotates her nose by that
 * change, and then `LegDrive` was handed the same stick and spun her again
 * at 2.4. Measured: 223 degrees a second out of a control that was set to
 * ask for 137. That is the turn feeling twitchy, and no amount of tuning
 * either constant alone could have found it.
 *
 * One owner now — the rig — and one number here, which is what the rig is
 * scaled to deliver. 2.53 rad/s is 145 deg/s: 35% below the 223 that was
 * actually happening, which is what was asked for.
 */
export const TURN_RATE = 2.53;

/**
 * THE CAMERA MOVES THE CAMERA. It used to move HER.
 *
 * A pan was read as a side step every frame — `strafe = -lookYaw * gain` —
 * which meant you could not look at anything without travelling toward it,
 * and letting go left her gliding while the view swung home. It went
 * through three rounds of gating (idle stick, finger down) and each one made
 * it less wrong without making it right, because the premise was wrong:
 * looking is not moving.
 *
 * A deliberate GESTURE moves her instead — see `dodge.ts`. Nothing here
 * reads `lookYaw` for movement any more.
 */

/**
 * THE AIR UNDER HER FEET — a floor, not a fudge.
 *
 * She used to ride a calibrated 1.4 mm above the wood's collision because
 * the collision was the limb's CIRCLE while the mesh was a polygon tangent
 * to it: the drawn bark stood proud by up to a facet's sagitta, 7 mm at the
 * landmark's foot, and she seated on the circle. A lift tuned to the
 * average could only ever be right on average, which is why she was still
 * half in the trunk from some angles.
 *
 * The collision is now built at the DRAWN ring radius and the near level is
 * tessellated finely enough that the ring is barely wider than the wood, so
 * there is nothing left to calibrate. This is only the last hundredth: the
 * ring MITRE where two sections meet at a bend still puts the drawn skin up
 * to 0.035 mm outside the collision, and a floor under that is not a floor.
 *
 * IT IS DELIBERATELY SMALL, and raising it does not buy what it looks like
 * it would. Measured on soil, where a rear claw reads about 0.15 mm under
 * the drawn hillside: 0.05 mm of floor gave -0.19, 0.25 gave -0.12, and
 * 0.60 gave -0.09 while pushing a swing foot to 1.96 mm of daylight. That
 * residual is not seating — it is the terrain's MESHER and the density
 * field it is built from disagreeing by about that much, so the anchor the
 * leg reaches for is not quite on the triangle that gets drawn. Lifting her
 * body cannot close it; referencing the leg anchors to the drawn mesh
 * would, and that is a different job.
 */
export const FOOT_AIR = 0.05 / MM;

/**
 * THE STICK'S RESPONSE, which is not the same thing as her top speed.
 *
 * The throw is 48 px — about half an inch of thumb — and the reading was
 * LINEAR past a 12% dead zone, so a quarter of that throw was already a
 * quarter of full pelt. Measured: 12 px out ran her at 1.87 mm/s, which is
 * a fifth of her body length every second from the smallest deliberate
 * nudge a thumb can make. Fine positioning — lining a dig up, stepping onto
 * a trunk — was all in the first few pixels.
 *
 * Squaring the deflection past the dead zone spends the throw where it is
 * wanted: the bottom half of the stick gets a quarter of the speed it used
 * to, the top of the stick is untouched, and the curve is smooth so there
 * is no step to feel. Keys are unaffected — a key is already all or
 * nothing, and squaring one is squaring one.
 */
export function stickCurve(raw: number): number {
  const size = Math.abs(raw);
  if (size < 0.12) return 0;
  /* Re-based off the dead zone, so the first pixel PAST it is a crawl and
   * not a jump to 12% — a dead zone that does not rebase is a step. */
  const t = Math.min(1, (size - 0.12) / (1 - 0.12));
  return Math.sign(raw) * t * t;
}
export const RIDE = 1.3 / MM;

/* Scratch space for the per-frame hot paths (rail, pose, camera) —
 * allocated once and reused, so a minute of riding feeds the garbage
 * collector nothing (the GC pauses read as hitches on the playtest PC). */
export const S_PERP = new THREE.Vector3();
export const S_RAD = new THREE.Vector3();
export const S_CENTER = new THREE.Vector3();
/** The aim debug's own scratches. It runs at the very end of the frame,
 *  after every other consumer of the S_ pool has finished. */
/** The jaw, while `biteRay` measures how far along the aim it sits. */
export const S_BITE_JAW = new THREE.Vector3();
export const S_DBG_CENTRE = new THREE.Vector3();
export const S_DBG_DIR = new THREE.Vector3();
export const S_DBG_END = new THREE.Vector3();
export const S_DBG_JAW = new THREE.Vector3();
export const S_DBG_HEAD = new THREE.Vector3();
export const S_DBG_UP = new THREE.Vector3();
export const S_DBG_RIGHT = new THREE.Vector3();
export const S_DBG_REL = new THREE.Vector3();

/** How many frames of camera look the aim debug keeps, to measure how far
 *  the head's own facing trails the view. Twelve is a fifth of a second at
 *  60 Hz — longer than any easing here should ever lag. */
export const AIM_DBG_LAG = 12;

/** The lens guard's own scratches: it runs inside the camera pass, after
 *  the pose has finished with the S_ pool but while `S_TARGET` is live. */
export const S_LENS_FWD = new THREE.Vector3();
export const S_LENS_UP = new THREE.Vector3();
export const S_LENS_RIGHT = new THREE.Vector3();
export const S_LENS_CORNER = new THREE.Vector3();
export const S_LENS_STEP = new THREE.Vector3();
/**
 * The soil normal the lens guard escapes along — and it needs a scratch OF
 * ITS OWN, which is the whole of a nasty bug.
 *
 * It used to borrow `S_TARGET`. That was safe while the guard only ever
 * worked on `camera.position`, and stopped being safe the moment it learned
 * to guard an arbitrary point (v0.0.82, "guard the target, smooth the
 * lens") — because the point first person hands it IS `S_TARGET`, the eye
 * target built a few lines earlier. So `S_TARGET.set(0, 1, 0)` inside the
 * guard did not initialise a spare vector; it overwrote the caller's eye
 * target with (0, 1, 0), and the lens was then eased toward the WORLD
 * ORIGIN — 39.6 metres away, in open ocean, while she stood on the summit.
 *
 * That is the blue: sea in front, sky behind, from a camera at 0,0,0. And
 * the shake is the same thing at frame rate, because the guard only trips
 * when soil is in the picture, so the lens flipped between her eyes and the
 * origin as she cut. Both symptoms, one aliased vector.
 */
export const S_LENS_OUT = new THREE.Vector3();

/** Head-clearance and bone-follow scratches — theirs alone, read across
 *  frames of the pose and never shared with the S_ pool. */
export const HEAD_PROBE_AT = new THREE.Vector3();
export const HEAD_PROBE_DIR = new THREE.Vector3();
export const HEAD_PROBE_RIGHT = new THREE.Vector3();
export const BONE_FWD = new THREE.Vector3();

/** The first-person lens's roll axis. Its OWN scratch: it is read after
 *  `S_UP` has been filled with her surface normal in the same block, and
 *  sharing one would have quietly clobbered the other. */
export const S_ROLL = new THREE.Vector3();
export const S_TARGET = new THREE.Vector3();
/** The ghost's own, so it cannot be trampled by whatever the cameras are
 *  doing with the shared scratch in the same frame. */
export const S_SPOT = new THREE.Vector3();
export const S_LEAN = new THREE.Vector3();
export const S_SUPPORT = new THREE.Vector3();
export const S_TUBE = new THREE.Vector3();

/**
 * The LEAST fold the tail believes while the rear feet are still crossing a
 * corner — about 23 degrees of lift at the sting once staggered through
 * `posture`. Enough, measured, to carry the gaster over the crease sweep it
 * was sitting down into; released the frame the corner completes, and the
 * gaster's own slow follow rate turns that release into a settle.
 */
export const TAIL_HOLD_RAD = 1.5;

/**
 * The first-person lens's own flinch: how much camera-only up-tilt the view
 * gains as her head's measured clearance closes from `SOFT` to `HARD`
 * millimetres, and how fast the tilt eases in and out. Five degrees was the
 * player's own estimate from the device, and it reads right: enough to lift
 * the terrain off the bottom third of the frame, small enough that the
 * horizon never visibly tips. See its use where the view pitch is built.
 */
export const FPV_LIFT_RAD = (5 * Math.PI) / 180;
export const FPV_LIFT_SOFT_MM = 2.5;
export const FPV_LIFT_HARD_MM = 0.5;
export const FPV_LIFT_RATE = 6;

/** The orbit arm's own, so it can be asked to write into any of the others
 *  without quietly aliasing its working vector. */
export const S_NOSE = new THREE.Vector3();

/** Where the load rides — her mouth, read off the rig. See `carryTick`. */
export const S_JAW = new THREE.Vector3();

/**
 * The chase camera's fan, in radians off where it would like to be.
 *
 * Swing is across her, rise is over her. Wide enough to find its way round
 * a trunk (a metre of it, from a hand's breadth away, is most of the sky),
 * and biased upward because the one direction that is nearly always open is
 * off her own back.
 */
export const FAN_SWING = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35] as const;
export const FAN_RISE = [0, 0.4, 0.8, -0.3] as const;

/** A ray that got less than this found no room worth having. */
export const CHASE_MIN = 4 / MM;

/** What is behind an unbuilt chunk once she is under the ground: packed
 *  earth in shadow, rather than the void. */
export const SOIL_DARK = new THREE.Color(0x140f0a);

/**
 * THE TREE. Three feet through and eighty feet up, in the game's own
 * millimetres — a metre of girth and twenty-six of height.
 *
 * It is planted a hand's breadth from where she starts (700 mm, far enough
 * to see the whole thing lean away overhead and near enough to walk to),
 * and its foot is sunk a hundred millimetres INTO the ground. That burial
 * is not decoration: the island's drawn surface is a 109 mm mesh and the
 * fine soil window redraws the ground underneath it as she moves, so a tree
 * seated exactly on the surface would be left hanging in the air the moment
 * the ground beneath it resolved to something lower. Sunk deep enough to
 * swallow that difference, the base stays buried whatever the terrain does.
 */
export const TREE_GIRTH_MM = 1000;
export const TREE_HEIGHT_MM = 26000;
export const TREE_FROM_HER_MM = 700;
export const TREE_BURIED_MM = 100;

/**
 * How far around her the small tiers are grown, in millimetres.
 *
 * The landmarks and the canopy are few enough to plant over the whole
 * island at once — a hundred and forty of them. Saplings and bushes run to
 * thousands, and thousands of anything is worth generating only where she
 * can see it. Twelve metres is far enough that the edge of the window is
 * past anything she can make out at her size, and near enough that the
 * regrow costs a few milliseconds.
 */
export const SCRUB_WINDOW_MM = 9000;

/** She has to walk this far before the scrub is grown again. */
export const SCRUB_REGROW_MM = 3000;

/** How far out plants are SOLID — comfortably past the regrow distance, so
 *  she can never outrun her own collision between rebuilds. */
export const STAND_REACH_MM = 5000;
export const S_FWD = new THREE.Vector3();
export const S_UP = new THREE.Vector3();
export const S_RIGHT = new THREE.Vector3();
export const S_MAT = new THREE.Matrix4();
/* The lean is about her OWN right, so the axis is local +x, always. */
export const S_QLEAN = new THREE.Quaternion();
export const S_LEAN_AXIS = new THREE.Vector3(1, 0, 0);
export const S_BANK_AXIS = new THREE.Vector3(0, 0, 1);
export const S_BANK = new THREE.Vector3();

/*
 * A ledge she may step up, and the rate she scaled a wall at, both gone.
 * They were the heightfield walker's whole theory of vertical: a wall was a
 * thing to refuse and then creep up by a special case. She stands ON walls
 * now, so there is nothing left for either number to decide.
 */

/** How far below the drawn island counts as "underground" for the camera. */
export const UNDER_MM = 5;

/*
 * HOW DEEP SHE MUST BE BEFORE THE SENSE TAKES OVER — a bigger number than
 * the camera's, and the whole of the fix for "the sky went dark while I was
 * still at the surface".
 *
 * Reported with a screenshot: a shallow scoop turned the sky night-dark and
 * washed the near soil blue while the quest readout still said 9 mm down.
 * `underground` was driving the camera's algorithm AND the sense shader off
 * one 5 mm threshold, and 5 mm is right for the camera and far too eager
 * for a way of SEEING — an open-topped scrape clears it while her head is
 * still above the rim in full daylight. The sense was written for being
 * shut inside a bore ("a first-person camera in a 7 mm bore has no
 * landmarks" — `undergroundSense.ts`), which a scoop with the sky over it
 * is not.
 *
 * WHY THIS IS A DEPTH AND NOT A CAST, which is the interesting part.
 *
 * The honest test is "can she see sky straight up", and two casts were
 * written and both were thrown away MEASURED rather than reasoned about:
 *
 *   1. along her own up — wrong axis. Her up is the surface normal she
 *      stands on, so in a 22 mm chamber it points across open air, finds no
 *      roof, and reads as daylight INSIDE the nest.
 *   2. world-vertical, up to the grade — right answer, wrong cost. The
 *      chunk mesher's budget breaks on `performance.now()`, so ANY extra
 *      per-frame terrain probing changes how many chunks land that frame,
 *      which changes the soil the lens guard is tested against. Measured
 *      over three runs each: baseline 0/0/0 frames with soil in the
 *      picture, with the cast 0/25/5. The cast's logic was fine; merely
 *      asking the questions broke something else.
 *
 * So the sense gets a threshold instead, and the threshold is free — one
 * comparison against a height this frame already sampled for the camera.
 * It cannot perturb the mesher because it asks nothing new.
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX: a roofed tunnel running shallower
 * than this stays lit rather than sensed. That is a real gap and a much
 * smaller one than the bug it replaces — you reach it by digging along
 * just under the surface, where there is still plenty to see by. A true
 * sky test belongs with the tri-state solid/air/unavailable query work,
 * where it can be answered without a per-frame march.
 */
/*
 * SUPERSEDED BY THE RAMP BELOW, and kept because the reasoning above is
 * still the reasoning: the sense may not afford a cast of its own, so it
 * reads a height this frame already sampled. What changed is that ONE
 * comparison became a slope, which costs nothing extra and fixes what the
 * threshold got wrong.
 */
export const ENCLOSED_MM = 16;

/**
 * HOW CLOSE A NESTMATE HAS TO BE to hand her a crop-load, in world units,
 * and how fast it goes across.
 *
 * Generous on the reach — mouth-to-mouth in the game means "beside her",
 * not a docking manoeuvre — and slow enough on the rate that a top-up is
 * a pause rather than a tap: a full bar takes about twelve seconds
 * standing with a worker, against the 48 minutes it took to empty.
 */
export const TROPHALLAXIS_REACH = 4 / MM;
export const TROPHALLAXIS_RATE = 8;

/*
 * HOW CLOSE TO HOME IS HOME, for something carried back.
 *
 * Wider than the trophallaxis reach on purpose. That one is a mouth
 * meeting a mouth; this is arriving at the nest with a beetle, and an
 * arrival that has to be aimed at a point is an arrival the player misses
 * and walks past while wondering why nothing happened.
 *
 * Handing it over is AMBIENT rather than a button, for the same reason
 * being fed is: an ant coming home with prey does not decide to give it
 * up, and a DELIVER key would be a chore bolted onto the end of a trip
 * the player has already made.
 */
export const CARRY_DELIVER_REACH = 9 / MM;

/*
 * WHEN THE SENSE COMES UP, and how fast.
 *
 * 16 mm was chosen as a stand-in for "there is a roof over her", and as a
 * stand-in it was far too deep: the wireframe stayed off through the whole
 * of the entrance dig and snapped on near the bottom of it. Reported from
 * the phone at seventeen millimetres down, which is exactly the threshold
 * doing its job and the job being the wrong one.
 *
 * A depth RAMP instead, because that is what a player actually experiences
 * — the light going as she sinks, not a switch at a magic number. On at
 * one millimetre, full by five.
 *
 * This is depth below her own ORIGINAL grade, not below whatever she is
 * standing on, so a slope does not trigger it and a pit she dug herself
 * does. `uSense` still eases toward this rather than tracking it exactly,
 * so a step in the height sample cannot make the picture jump.
 */
export const SENSE_ON_MM = 1;
export const SENSE_FULL_MM = 5;

/**
 * How much sensed view a given depth asks for, 0..1.
 *
 * A function rather than four lines inline, because it is the whole of
 * what changed and the whole of what can be wrong: the shape of the fade
 * is the feature, and a shape is a thing worth pinning in a test.
 */
export function senseAt(depthMm: number): number {
  const t = (depthMm - SENSE_ON_MM) / (SENSE_FULL_MM - SENSE_ON_MM);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Soil mesh chunks: the slide tile IS the chunk, the world room's trick. */
export const CH = TILE_CELLS;
export const CHUNKS_XZ = WINDOW_CELLS / CH;
export const CHUNKS_Y = CELLS_Y / CH;
export const MESH_BUDGET = 3;

/** Recentre lead and thrash guards, straight from the world room. */
export const LEAD_S = 0.45;
export const LEAD_MAX = 24 / MM;
/* Longer than one scroll's own measured cost, so two can never overlap. */
export const SCROLL_COOLDOWN_MS = 600;

/**
 * THE SHOVEL 🪏 — dig mode's mouthful, sized for making progress.
 *
 * 6 mm wide, 6 mm tall, 9 mm deep per stroke: a bore she can walk straight
 * into, not a mandible-true nibble. The 1.75 mm bite was honest and it also
 * took all day, and a passage barely her own width made walking a squeeze —
 * so dig mode trades the biology for a tunnel that opens at playable speed
 * with clearance to move in. Cut as three 3 mm-radius spheres stepped along
 * the aim, because spheres are what the field subtracts.
 */
/**
 * ONE MOUTHFUL, AND IT IS A BALL — 6 mm across, as asked.
 *
 * Asked directly: "what is the dig radius and is it a round shape? I was
 * thinking make it a 6x6x6mm ball/sphere." The honest answer to the first
 * half was that it was NOT round — it was an ellipsoid 10 wide, 5 tall and
 * 3 deep, wide and low on the reasoning that a walking tunnel wants a floor
 * broader than her stride and a roof just clear of her back.
 *
 * A ball is the better shape for a reason that reasoning missed, and the
 * measurement is worse than the argument: the brush is drawn in HER frame,
 * so its 3 mm DEPTH axis is the one that points where she is digging.
 * Aimed straight down, one stroke of the old brush opened a saucer 6.8 by
 * 7.2 mm across and TWO MILLIMETRES deep — a scrape, not a shaft. The ball
 * opens 6.0 x 6.4 x 7.2, and 2024 samples against 603: three and a half
 * times the soil, for the one direction the founding spends its whole
 * first act digging.
 *
 * (Both measured in the running game by sampling the density field either
 * side of a single stroke, not computed from these numbers. The naive
 * volume ratio — 113 mm³ against 79 — badly understates it, because it
 * averages over directions rather than looking at the one that matters.)
 *
 * ONE NUMBER, THREE NAMES. The field subtracts ellipsoids and the thrown
 * charge shares this brush, so the three axes stay as separate exports and
 * every call site is unchanged — but they are now derived rather than
 * typed, so the brush cannot go quietly non-spherical again by somebody
 * editing one line of three.
 *
 * Walking level it is narrower across the floor (6 against 10) and taller
 * under the roof (6 against 5). Both still clear her comfortably —
 * `BODY_HALF_TALL` is 1.6 mm and `BORE_HUG_WIDE` 2.4 — so the passage she
 * walks in loses nothing that matters and the shaft she sinks gains a
 * great deal.
 */
export const SCOOP_BALL_MM = 6;
export const SCOOP_WIDE_MM = SCOOP_BALL_MM;
export const SCOOP_TALL_MM = SCOOP_BALL_MM;
export const SCOOP_DEEP_MM = SCOOP_BALL_MM;

/*
 * THE CYLINDER DIG — Joshua's blueprint, 2026-08-18, drawn: "a cylinder
 * starting at the Thorax down the ant's head out x distance." One stroke
 * cuts a bore ONE BODY LENGTH long; its diameter comes off HER OWN RIG,
 * so a small ant digs a small tunnel and the tunnels grow with the ants —
 * no per-caste constants to go stale.
 *
 * The WIDEN and FLOOR are game tuning, said plainly: a bore exactly her
 * standing height leaves no room for the antenna sweep or the gait's
 * lift, and the worker's honest 1.1 mm is below the carve field's own
 * resolution — voxel noise, not a tunnel. Half again her height, never
 * under four millimetres, keeps every bore a place an ant and a camera
 * can actually be.
 *
 * PACING is Joshua's formula verbatim: seconds = cylinder volume over
 * RATE, ROUNDED UP to a whole second so the chip-away lands on a clean
 * beat — "143/30=4.767 seconds it should take... round up to the closest
 * whole number so the animation can work maybe every 0.5s." Small ants
 * dig fast and big ants slow, automatically: queen ~5 s, major ~3 s,
 * worker ~2 s per body length, measured off the real rigs. The duration
 * IS the cooldown — one bore at a time, nothing extra after.
 */
/* Arming DIG drops into first person at this wide working lens so the
 * tunnel mouth and the instruments share the frame — a tool requirement,
 * deliberately NOT the player's FOV preference. `lensTick` owns applying
 * it and handing the lens back on disarm. */
export const DIG_LENS_DEG = 100;

export const DIG_RATE_MM3_S = 30;
export const DIG_BEAT_S = 0.5;
export const BORE_WIDEN = 1.5; //   of her standing height, diameter
export const BORE_MIN_MM = 4; //    the floor no bore goes under

/**
 * THE THROWN CHARGE 🧨 — what an out-of-reach press becomes.
 *
 * A press that found no soil inside her jaws used to end at a note saying
 * so. The note stays honest, but the press now DOES something: she lobs a
 * mini dig charge down the aim line, a visible arc that pops a scoop-sized
 * pocket wherever it lands, and fizzles — note and all — when it lands
 * nowhere.
 *
 * The numbers are theatre, not physics. Real gravity at ant scale would
 * end the flight before a second frame drew it, so the arc is tuned to
 * READ: fast enough to feel thrown, bent enough to be a lob rather than a
 * laser. The range and the cooldown are the guardrails — one mouthful
 * every so often can open a pocket at distance but cannot outrun jaws
 * that cut every stroke, so walking up and biting stays the fast way to
 * move soil.
 */
/*
 * THE ARC HAS TO COMPLETE INSIDE THE WINDOW, which is what set these.
 *
 * They were 260 mm/s and 480 mm/s², a ballistic pair whose maximum range —
 * v²/g at 45 degrees — is 141 mm. The carvable world reaches 64 (see
 * `CHARGE_REACH_MM`), so the throw was tuned to more than twice the world
 * it could affect, and two throws in three carved nothing at all.
 *
 * Capping the RANGE alone made it worse rather than better, which is worth
 * recording: with the path cut to fit the window but the arc unchanged,
 * every charge expired in mid-air before it could come down, and all three
 * test pitches carved nothing. A range cap is not a substitute for
 * ballistics that fit — the flight has to finish inside the world.
 *
 * So the pair is solved against the window instead: 170 and 600 give a
 * maximum range of 48 mm and a path at 45 degrees of about 55, which lands
 * inside `CHARGE_RANGE_MM` with the rim to spare. Still a lob — slower and
 * heavier than before, which at ant scale reads as MORE thrown, not less.
 */
export const CHARGE_SPEED_MM = 170; //    mm/s down the aim line
export const CHARGE_GRAVITY_MM = 600; //  mm/s² of stage gravity, world down

/**
 * HOW FAR A CHARGE MAY FLY — AND IT IS THE STREAMER'S NUMBER, NOT TASTE.
 *
 * This was 150 mm, chosen as a feel. Measured in the running game, the
 * fine density field stops answering **64 mm** from her: the carvable
 * window is `WINDOW_MM` (192) across and she is held in a middle tile, so
 * the guaranteed clearance to its rim is two tiles either way. A charge
 * flying 150 mm was therefore capable of landing more than twice as far
 * out as the game can cut anything.
 *
 * It showed exactly as you would expect and as nothing in the code said:
 * `probe:chargesave` threw at three pitches and TWO OF THEM CARVED
 * NOTHING — a bead that arcs, lands, pops and leaves the soil untouched.
 * Not a miss the player can learn from; a silent hole in the feature.
 *
 * There is a second, quieter failure past the same edge.
 * `TerrainStream.remember()` refuses to record edits within `CAP_PLANES`
 * of the window rim, and justifies it with "the rim is at least sixteen
 * millimetres from any bite" — true only while digging is jaw-range. A
 * charge landing out there would carve a pocket that is never SAVED, so
 * the hole would vanish on reload.
 *
 * So the range is derived rather than typed, and it stays honest if the
 * window is ever retuned. Two tiles of clearance, less the rim the stream
 * will not record, less a bore's margin so a pocket's own radius cannot
 * push it over the line. It is a PATH length, so a flat throw and a lobbed
 * one are both bounded by it.
 */
export const CHARGE_REACH_MM = (TILE_CELLS * CELL_SIZE * MM) * 2;
/*
 * PATH BUDGET, not reach — see the two-limit note in `digCharge.step`. A
 * lob's path is longer than the ground it covers, so this has to allow a
 * full arc; what stops a charge leaving the carvable world is
 * `CHARGE_REACH_MM`, checked separately against her own position.
 */
export const CHARGE_RANGE_MM = Math.round(CHARGE_REACH_MM * 1.6);
export const CHARGE_RADIUS_MM = 1.2; //   the bead the eye follows
/*
 * SLOWER THAN THE JAWS, ON PURPOSE — and retuned when the charge caught
 * fire. A fireball is worth the pop plus `BURN_TICKS` smoulder scoops
 * (four in all), and at the old 1.1 s that out-dug a held jaw stroke
 * (0.42 s a scoop — the very thing the throw must not do. 2.4 s keeps
 * the fireball's four under the jaws' cadence, and reads as her catching
 * her breath after a throw. It also outlives a burn (three beats of
 * `BURN_TICK_S`), so one thrower can never stack two fires.
 */
export const CHARGE_COOLDOWN_S = 2.4;
export const CHARGES_MAX = 3; //          in flight at once, held press or not
export const CHARGE_POP_GRIT = 18; //     spoil chips in the landing pop

/**
 * THE CHARGE IS A FIREBALL 🔥 — she is, after all, some kind of fire ant.
 *
 * PARKED, NOT DEAD — v0.1.98. The fireball no longer fires from the DIG
 * miss path: Joshua's call was "hot but it goes too far and not very
 * antlike" as a digging tool, and fire is being remade as the fire ant's
 * COMBAT signature (see the species-abilities card on Trello). Nothing
 * below is wired to digging any more; `digCharge.ts` and `digBurn.ts`
 * keep the flight and the fire, and these numbers keep the tuned feel
 * the combat ability starts from.
 *
 * Three ideas, all theatre and one of them mechanical:
 *
 * THE BEAD BURNS. The flat yellow dot reads as a pebble; a bead that
 * flickers between a hot core and a flare colour, swelling and shrinking
 * a fraction as it flies, reads as something ALIGHT. The flicker is keyed
 * off path flown, not wall-clock, so a probe stepping the sim by hand
 * sees the same fire a player does.
 *
 * IT SHEDS SPARKS. Every few millimetres of flight an ember chip is
 * thrown backwards off the bead — the same instanced-chip machinery as
 * the spoil, in ember orange, so the whole trail is one extra draw call.
 *
 * AND IT SMOULDERS. The mechanical part: a landing does not spend the
 * whole charge at once. After the landing pop the fire keeps eating —
 * a few more scoop-ticks, each a beat apart, each burrowing one step
 * further along the line of flight — so the fireball's total hole is a
 * short burnt bore, not a single pocket. The fire goes out on its own
 * when the ticks are spent, or EARLY the moment a tick meets nothing it
 * can burn (bark, air, the streamed window's edge): fire without fuel is
 * not an error, it is just out. Totals: the pop plus three ticks is four
 * scoops per cooldown — see the note on `CHARGE_COOLDOWN_S`, which was
 * lengthened for exactly this arithmetic so the throw stays the slower
 * way to move soil. And the fire obeys the same edge the flight does:
 * a tick that would cut past `CHARGE_REACH_MM` from HER — she may have
 * walked; the window follows her — is fuel the world cannot hold, and
 * the scene answers it with zero. See the smoulder wiring in
 * `IslandScene`.
 */
export const BURN_TICKS = 3; //           extra scoops after the landing pop
export const BURN_TICK_S = 0.55; //       beat between them — legible, not a drumroll
export const BURN_STEP_FRAC = 0.75; //    how far each tick burrows, in scoop-depths
export const BURN_EMBERS = 6; //          ember chips puffed out per tick
export const EMBER_TRAIL_GAP_MM = 5; //   flight millimetres between shed sparks
export const EMBER_COLOR = 0xff7a2a; //   the chips — ember orange, unlit
export const FIRE_CORE = 0xffd23f; //     the bead's hot centre
export const FIRE_FLARE = 0xff4f1f; //    what it flickers towards

/*
 * THE ROUTE TRACE forgets a tunnel once she has clearly LEFT it: this much
 * travel spent above grade. Travel rather than seconds, so a slow probe
 * frame cannot wipe it, and long enough that crossing a vent's daylight
 * does not cost her the map of the dig she is still in. See `routeTrace.ts`.
 */
export const ROUTE_FORGET_MM = 60;

/**
 * How hard each stroke's own hole is relaxed afterwards, and how often.
 *
 * Halfway to the neighbourhood mean, twice — one gentle pass took the
 * worst off the ridge between two overlapping scoops and still left
 * enough to catch a foot on. Two passes at a half is roughly a wider
 * kernel without the cost of actually widening one.
 */
export const SMOOTH_STRENGTH = 0.5;
export const SMOOTH_PASSES = 2;

/**
 * The smoothing brush's reach, in mm.
 *
 * This used to be a slider running four to thirty, defaulting to ten.
 * Played, thirty was better everywhere — so it is thirty, and the slider
 * that only ever wanted pushing to its end is gone.
 */
export const SMOOTH_RADIUS_MM = 30;

/**
 * The most any one sample may move per pass, in field units.
 *
 * A blur cannot tell the tunnel's air from the sky's, so a slab of soil
 * between the two averages with the OUTSIDE and thins — near the surface
 * it thinned right through, and the roof came down. A third of a cell
 * still relaxes the shallow ridges a foot catches on, and refuses the
 * large correction that a one-sample roof would need to collapse.
 */
export const SMOOTH_MAX_SHIFT = CELL_SIZE / 3;

/**
 * How far OUTSIDE the cut the relaxation reaches, in samples.
 *
 * The ridge that matters is not inside this stroke's hole — it is the
 * seam where this stroke meets the last one, which by definition lies on
 * the boundary of the box the brush just touched. Smoothing only what was
 * cut leaves exactly the join that trips her.
 */
export const SMOOTH_GROW = 2;

/** How much soil the lens keeps off itself, so the eye never sits in a
 *  wall — the near plane is tiny, but a camera INSIDE soil renders the
 *  whole world inside-out. */
export const EYE_SKIN = 0.5 / MM;

/**
 * How far clear of the dirt every drawn bone is kept, and the step the
 * guard searches in. Small on purpose: this is a fail-safe for the parts
 * no solver owns, and a big lift would carry six correctly planted feet
 * off the ground with it.
 */
export const BONE_CLEARANCE = 0.02 / MM;

/**
 * How far above the ground the camera is never allowed below.
 *
 * The asked-for number is 0.05 mm; the near plane is 0.1 mm, so a
 * clearance under that still lets the ground poke through the lens. The
 * floor is whichever is larger, which honours the intent — the camera is
 * never under the dirt — and actually shows nothing through it.
 */
export const CAMERA_SKIN = Math.max(0.05 / MM, 0.02 * 1.5);

/** How far forward of her centre the eye rides, along the AIM. */
export const EYE_FORWARD = 1.3 / MM;

/**
 * How far ABOVE her centre the eye rides, along her own up.
 *
 * There was no rise at all: the lens sat on her centre-line, which is the
 * middle of her thorax, and the view read as low and close to the floor
 * ("a little taller"). Her head is the top of her, so the eye goes there.
 */
export const EYE_RISE = 1.1 / MM;

/**
 * HOW THE FIRST-PERSON LENS FOLLOWS HER HEAD.
 *
 * Rates in hertz, turned into an exponential rate below. Position follows
 * faster than roll because a lag in WHERE the lens is reads as swimming,
 * while a lag in which way is up reads as nothing at all — the surface
 * normal only changes when she crosses onto something new.
 *
 * These filter LOCOMOTION only. The look direction is taken straight off
 * the aim and never smoothed, so turning has no lag whatever these are set
 * to. That split is deliberate: filter the body, never the intent.
 */
/*
 * MEASURED, then set. The first pass used 15 and 10 "hertz" turned into
 * exponential rates by 2*pi, and at 60 fps that is 79% of the way to the
 * target every frame — very nearly a pass-through. It cut the lens's own
 * jitter from 0.099 mm to 0.081, which is 18%, and the player still saw
 * shake.
 *
 * Time constants in MILLISECONDS instead, because that is the number this
 * can be reasoned about in: at 60 fps a 45 ms constant moves 31% a frame
 * and a 70 ms one 21%. Slow enough to eat lattice noise, far too fast to
 * feel as lag on something the size of a head.
 */
export const EYE_FOLLOW_MS = 45;
export const EYE_AIM_MS = 70;
export const EYE_FOLLOW_RATE = 1000 / EYE_FOLLOW_MS;
export const EYE_ROLL_RATE = 1000 / EYE_AIM_MS;

/**
 * Past this, the lens SNAPS instead of chasing.
 *
 * A filter is for noise. A respawn, a rail grab or an embed rescue moves
 * her metres in a frame, and easing across that would fly the camera
 * through the island. Three millimetres is a third of her body — far more
 * than any step, far less than any teleport.
 */
export const EYE_SNAP = 3 / MM;

/**
 * How finely the eye's retreat from a wall is resolved.
 *
 * Ten halvings of `EYE_FORWARD` is about a thousandth of it, which is well
 * under anything visible. The number that mattered was that it is a
 * BISECTION at all: the five fixed steps it replaced were the shake.
 */
export const EYE_BISECTIONS = 10;
/*
 * The march that keeps the eye on HER side of every wall: EYE_FORWARD is
 * 1.3 mm, so eight steps test roughly every 0.16 mm — finer than any crust
 * the surface nets can build, so a wall cannot fit between two samples.
 */
export const EYE_MARCH_STEPS = 8;

/**
 * THE PAN COMES HOME.
 *
 * A swipe moves the view off neutral and, three seconds after the finger
 * lifts, it eases back — behind her in third person, along her nose in
 * first. The hold is what makes it usable rather than fidgety: long enough
 * to look at something, short enough that you never have to put the camera
 * away by hand.
 *
 * Held indefinitely while DIGGING, because there the look is the aim and an
 * aim that drifts home on its own is a shovel that will not stay pointed.
 */
export const LOOK_HOLD_S = 3;
export const LOOK_RETURN_RATE = 2.4;

/**
 * Where the chase arm sits when nothing is asking otherwise: a little above
 * her, directly off her tail. It used to be `0.28 - aimPitch`, which is why
 * the third-person view could not be brought behind her — see `orbitBack`.
 */
export const CHASE_PITCH = 0.28;
/*
 * The FULL dial again: down past her flank to nearly under her, up to
 * nearly overhead. The 0.06 floor was the reported limiter — the orbit
 * could never drop below a polite hover, so "swing around and look UP at
 * her on the trunk" was unreachable. What keeps the lens out of the dirt
 * is not this clamp; it is the ground ride below (`chaseCamera`) and
 * `liftCameraClear`, which are made for exactly that job.
 */
export const CHASE_PITCH_MIN = -1.35;
export const CHASE_PITCH_MAX = 1.35;

/** Third person never sits closer to the ground than this, in wu — the
 *  classic chase-camera floor: when terrain rises into the shot, the lens
 *  rides a fixed height over it and slides in toward her instead. */
export const CHASE_GROUND_CLEAR = 1.6;

/** The arm lengths the chase tries, longest first — full distance unless
 *  a ridge blocks the sight line, then progressively closer to her. */
export const CHASE_REACH = [1, 0.75, 0.55, 0.4, 0.25, 0.14] as const;

/**
 * How far a shell clearance probe looks before calling it clear.
 *
 * A body length. Past that the answer cannot matter to a body this size,
 * and the march is the only per-frame cost the spine's proximity half has.
 */
export const SHELL_REACH = 2;

/** How much of a segment's widest radius actually hangs below it. See
 *  `shellClearance` for the measurement this comes from. */
export const SHELL_SHARE = 0.5;

/** How fast the terrain rises are low-passed, per second. Slow enough to
 *  swallow a lattice step, fast enough to meet a real slope. */
export const RISE_RATE = 9;

/** How far past her centre the jaws reach when the model has not loaded. */
export const NOSE_REACH = 4.5 / MM;

/**
 * HOW CLOSE A LIVING BEETLE HAS TO BE before the HUD calls it a fight and
 * puts the weapons up.
 *
 * Deliberately WIDER than her jaws — about four body lengths — because the
 * plates have to be there BEFORE she is in range, not at the same instant.
 * A control that appears on the frame the beetle reaches her is a control
 * being read while she is being bitten.
 *
 * GAME TUNING, not biology. Real Solenopsis recruit by trail and alarm
 * pheromone at ranges this model has no representation of; this is a
 * legibility number for a HUD, chosen against `NOSE_REACH` so the weapons
 * arrive roughly a second of walking before they are usable.
 */
export const FIGHT_NOTICE = 20 / MM;

/**
 * Her half-WIDTH in a bore. The measured oval's 4.4 mm half-width is her
 * LEG SPAN — wider than the whole 6 mm tube — but an ant in a tunnel walks
 * with her feet ON the wall, legs flexed to its curve, not sticking out to
 * her open-ground stance. So the tube fit uses a tucked body-core width;
 * the open-ground oval keeps the full span.
 */
export const BORE_HUG_WIDE = 2.4 / MM;

/** The collision oval wears the measured body 20% small — legs are not
 *  walls, and a shell-sized fit perched her on every rim and pedestal. */
export const BODY_FIT_SCALE = 0.8;

/*
 * THE FOUNDING QUESTS — the prologue's spine, straight from the design
 * brief: the queen finds a spot, digs an entrance, hollows her chamber,
 * and the first worker emerges. Three beats, each read off what she has
 * ACTUALLY done to the soil, never off a checkbox.
 */
/** Deep enough that the entrance counts as an entrance, in mm. */
export const QUEST_DEPTH_MM = 25;
/** Soil samples carved OUT while deep — the chamber, measured in work.
 *  Calibrated against the rig: ~10 s of held digging at depth. */
export const QUEST_CHAMBER_SAMPLES = 30000;

/**
 * How far PAST HER NOSE the jaws close — not how far past her centre.
 *
 * This was 1.4 mm from her middle, on a body whose half-length is 4.5 mm,
 * which put her mandibles inside her own thorax. She could only ever chew a
 * pocket she was already standing in, and never the slab of soil in front
 * that she has to move into, so digging deadlocked: measured, 637 of 643
 * strokes cut nothing at all and she advanced 0.00 mm in five minutes.
 *
 * Her mouth is at the front of her, so the reach is measured from there.
 */
export const JAW_PAST_NOSE = 0.6 / MM;
export const BODY_HALF_TALL = 1.6 / MM;

/**
 * Where the oval is tested, as fractions of its half-extents: nose, tail,
 * both shoulders, back and belly, and the four diagonals of her waist. Her
 * outline, in eleven questions.
 */
/** How far clear of her own feet the oval's belly rides. */
export const BODY_FLOOR_MARGIN = 0.3 / MM;

/** How far up or down she may point: not quite the poles, where a heading
 *  stops meaning anything. */
/**
 * How far up and down she may point: a QUARTER TURN, exactly.
 *
 * It was 1.4 radians — eighty degrees — and the gauge sat there pegged.
 * That is fine while the world is a hill and wrong the moment there is a
 * tree in it: going up a trunk IS ninety degrees, and a dial that cannot
 * reach it cannot look where she is going. The degenerate case at the poles
 * is already handled — the first-person eye rotates its own up by the same
 * pitch, so its up and its look stay perpendicular at every angle including
 * this one.
 */
export const AIM_LIMIT = Math.PI / 2;

/** The room camera starts blending in at norm 1.25 (~3 mm out) and is all
 *  the way in by 0.75 — distance-driven, so walking pace sets the feel. */
export const CHAMBER_CAM_FAR = 1.25;
export const CHAMBER_CAM_NEAR = 0.75;


/** How fast a colonist walks, and how fast she comes round. */
export const COLONIST_SPEED = 1.1;
export const COLONIST_TURN = 1.6;
/** Close enough to a wander target to call it arrived, in world units. */
export const COLONIST_ARRIVE = 1.2;
/** How far from her birthplace a colonist will wander, in world units. */
export const COLONIST_ROAM = 12;

/*
 * THE QUEEN, WALKING AGAIN — asked for from the device: "I would like the
 * Queen able to move... randomly move around in a 2mm radius around that
 * point so that way it doesn't look too fake."
 *
 * The 2 mm is HIS number and the wander leash honours it exactly. Her pace
 * is game tuning: physogastric queens barely walk at all, and half a
 * worker's stride reads as heavy without reading as broken. The standoff
 * is roughly one queen length, so following she walks BEHIND the player
 * instead of standing in the player's mandibles. The tap radius is
 * deliberately generous — she is twelve millimetres long and a thumb on a
 * phone is not a cursor.
 */
export const QUEEN_ROAM = 2 / 5; //        his 2 mm, in world units (MM = 5)
export const QUEEN_PACE = 0.5; //          of COLONIST_SPEED
export const QUEEN_STANDOFF = 12 / 5; //   one queen length back, in wu
export const QUEEN_TAP_WU = 3; //          how near a tap ray must pass
export const TAP_MS = 300; //              longer is a hold, not a tap
export const TAP_TRAVEL_PX = 12; //        further is a drag, not a tap
export const DOUBLE_TAP_MS = 400; //       between the two taps
export const DOUBLE_TAP_PX = 48; //        how far apart they may land

/**
 * WHAT A COLONIST MAY WALK ONTO, and what she does when it is not there.
 *
 * Needed only since colonists started reading the SOIL rather than the
 * original heightfield: the heightfield has no cliffs at an ant's stride
 * and dug soil is nothing but cliffs.
 *
 * A first cut made both directions a RATE, and that was wrong in the way
 * that shows: "the other ants aren't sticking and walking through the dirt
 * sometimes." A cap on rising ground is a cap on the one direction that
 * cannot lag — ground coming up faster than the cap leaves her inside it.
 *
 * STEP_UP is therefore not a speed, it is a REFUSAL: more than this and it
 * is a wall she does not walk onto. STEP_DOWN is how big a drop she simply
 * takes, which is what keeps her stuck to ordinary undulation. Past that
 * she FALLS, and accelerates, so a shaft reads as a shaft. All four are
 * game tuning; the two step sizes are close to the beetle's, which were
 * chosen against the same terrain.
 */
/**
 * HOW FAR THE ZIGZAG STEPS ACROSS, in CSS pixels — the FLOOR, not the
 * whole answer. See `CLUSTER_AIR` and `fanCluster`.
 *
 * A whole plate (56) plus the cluster's own air (6), so a plate never
 * touches the one below it whichever side it is on. A first cut used 52 and
 * the cluster read as a heap rather than a diagonal — see `fanCluster`.
 */
export const CLUSTER_STEP = 62;

/**
 * THE AIR BETWEEN A STEPPED PLATE AND THE ONE IT STEPS PAST.
 *
 * Reported from the device: "the SCOOP button is just a little too close to
 * the DIG button." Measured at the design canvas, it was worse than close —
 * their touch boxes OVERLAPPED by 22 x 18 px, which is a mis-tap waiting to
 * happen on the one control pair you hold together.
 *
 * The cause is that 62 above is a whole plate plus air for a 56 px plate,
 * and the HERO is 84. In every mode where DIG is the hero, DIG is the
 * plate that steps ACROSS and clears its 56 px neighbour fine. In DIG mode
 * the hero is SCOOP, so DIG becomes the flush one — and a 62 px step
 * cannot clear an 84 px plate. It poked 22 px through, exactly the
 * difference.
 *
 * So `fanCluster` now measures the neighbour it actually has to clear and
 * adds this, with 62 kept as the floor so a uniform row is unchanged.
 * Encoding the hero's width here instead would be a second copy of a number
 * the stylesheet already owns, and the stylesheet changes it per screen.
 */
export const CLUSTER_AIR = 6;

export const COLONIST_STEP_UP = 1.1 / MM;
export const COLONIST_STEP_DOWN = 1.4 / MM;
export const COLONIST_FALL = 9;
export const COLONIST_FALL_MAX = 6;



/**
 * HER FACE'S REACH — how far ahead of her neck the head clamp asks whether
 * there is soil. Roughly a head-and-neck length on the queen, which is the
 * thing being kept out of the dirt.
 */
export const HEAD_PROBE_REACH = 0.5;

/**
 * How finely the head clamp resolves the steepest pitch she can hold.
 *
 * Eight halvings of a look is a fraction of a degree. The number that
 * matters is that it is a BISECTION: the four fixed halvings it replaced
 * gave her neck four legal angles, so a hair of terrain movement swung her
 * head by tens of degrees, which the first-person lens rides.
 */
export const HEAD_PROBE_BISECTIONS = 8;

/**
 * How fast her neck may turn, in radians per second — the damper on the
 * head clamp. About 170 degrees a second, so a full look-down arrives in
 * under half a second and reads as a head turning, while a sudden change
 * in what the soil allows can no longer land in one frame.
 *
 * GAME TUNING for how a neck should read on screen, not measured biology.
 */
export const HEAD_PITCH_RATE = 3;

/**
 * HOW FAR DOWN A LOOSE THING LOOKS FOR ITS FLOOR, and how finely.
 *
 * 12 mm of reach: enough to find the bottom of a chamber she has hollowed
 * out under a pebble, and short enough that a prop over a genuine void is
 * told so in one frame rather than probing the whole island. See
 * `IslandScene.floorUnder`.
 */
export const PROP_FLOOR_REACH = 12 / MM;
export const PROP_FLOOR_STEPS = 8;
export const PROP_FLOOR_BISECT = 6;

/** The prop ground query's own scratch — see `IslandScene.soilNormal`. */
export const S_PROP_AT = new THREE.Vector3();

/** The macro effect's own scratch — the camera's forward, for its strength. */
export const S_TILT_FWD = new THREE.Vector3();

/** Her position projected to the screen, for the macro effect's focus. */
export const S_TILT_AT = new THREE.Vector3();
