# Prompt: an architecture for Thronemound's ant AI

Joshua asked for a prompt he can hand to ChatGPT so it can design the ant AI
properly, and bring the design back here to build. Everything below the line
is that prompt. It is written to be pasted whole — the context is deliberate,
because the last few AI problems in this project were caused by a designer
(me) not knowing a constraint rather than by a bad idea.

Keep this file up to date when the facts in it change. A stale brief will
produce a confidently wrong architecture.

---

You are designing the agent architecture for **Thronemound Colony Sim**, a
browser 3D ant-colony game. I will hand your design to a coding agent that
has the repository, so write for an engineer, not for a pitch deck. Be
specific, be opinionated, and where you are guessing, say you are guessing.

## The game

The player is the **keeper, not the ant**. You build a glass formicarium,
introduce a Queen, and watch an autonomous colony dig, forage and grow. The
player does not steer a worker, dig a tunnel by hand, or carry anything. The
entire appeal is that the ants are convincing on their own. This means agent
behaviour is not a supporting system — it *is* the product.

Target platform is a phone browser (PWA), landscape, 60 fps, three.js +
TypeScript + Vite, no game engine and no AI/ML libraries. It must run with a
CPU budget measured in a couple of milliseconds per frame for all ants
combined, and it must be deterministic enough that a headless probe can
replay it.

## The world the ants live in

- **Scale is real.** One world unit is 5 mm. A Queen is 9 mm long. The tank
  is 128 x 96 x 128 mm, with about 53 mm of soil in it.
- **Soil is a signed density field**, not voxels or a mesh: positive is
  inside solid, iso 0 is the surface, meshed with SurfaceNets in chunks.
  Digging is `field = min(field, -bore)` — a boolean subtraction of a swept
  capsule. Any shape can be removed at any angle; there is no grid to follow
  and no tile to snap to. Queries available: `solidAt(x,y,z)` and
  `surfaceAt(x, z, fromY)`.
- **There is no navmesh, no pathfinder and no graph.** Nothing in the game
  currently knows that a tunnel exists as a *place*. The tunnel is a hole in
  a scalar field and that is all.
- Cost note: carving is ~2 ms and a local remesh is ~3-18 ms. Field queries
  are cheap; remeshes are not free.

## What exists today

The ownership chain is strict and I want to keep it:

    ANT AI          decides what she wants     -> `antStroll`, `digBrain`
    MOVEMENT        moves her                  -> `AntBody`
    IK / ANIMATION  poses her                  -> `LegDrive`, `QueenModel`

The AI's whole output is an intent: `{ walk: -1..1, turn: -1..1, dig: 0..1 }`.
It never moves her and never touches a bone. The legs displace her body, so
gait and travel cannot disagree.

Two brains exist, both for a single ant:

1. **`antStroll`** — wander. Picks a bearing, holds it for 0.35-1.1 s, senses
   ground ahead and turns away from a bad answer. Deterministic: randomness
   is injected as a function.
2. **`digBrain`** — a four-state machine: `walking -> facing -> closing ->
   digging`, each with a patience timer (14 / 4 / 9 / 8 s) that dumps her
   back to an earlier state when it expires. It picks a single work site,
   walks to it, turns to face it, creeps in, then runs a `DigJob` that chews
   a 9 mm segment as overlapping spheres over several seconds.

## What is wrong with it, honestly

- **It is one ant, once.** There is no colony, no second agent, no task
  allocation, no notion of who should be doing what.
- **It has no memory.** She does not know where she dug, where the entrance
  is, or where she has already been. Each site is picked fresh and forgotten.
- **There is no plan, only a bite.** A tunnel is whatever a sequence of
  independent bores happened to leave behind. Nothing chooses where the
  nest goes, what a chamber is, or when a shaft should turn.
- **Patience timers are doing the job of a planner.** When she cannot reach a
  face she waits, gives up and re-arms somewhere else. That reads as
  confusion, not intent.
- **She cannot fit her own tunnel.** Her stance is 7.22 mm wide; the bore is
  6 mm. She gets stuck at the mouth of a hole she dug.
- **No spoil.** Excavated soil vanishes. Real ants carry it out and pile it.

## What I want from you

Design the agent architecture. Specifically:

1. **The layer stack.** How many levels of decision are there between "the
   colony needs a deeper nest" and "turn 0.3 left this frame"? Name each
   layer, say what it owns, what it reads, and at what rate it runs. I
   expect something like colony-level task generation, per-ant task
   selection, and a per-frame steering layer, but argue for your split
   rather than accepting mine.

2. **Spatial memory.** What does an ant know about the nest, and what does
   the *colony* know? The world is a density field with no graph. Propose
   the representation that gets built as they dig — nodes, a skeleton,
   something else — what writes it, what reads it, what it costs, and how an
   ant navigates on it without a general pathfinder. Say explicitly how it
   stays consistent when a later bore reshapes something already recorded.

3. **Task allocation.** How does work get chosen when there are 5 ants, and
   still work when there are 200? Response-threshold models are the standard
   from the literature — say whether you would use one, with what stimuli
   and what thresholds, or something simpler, and why. It must not need a
   central scheduler that is O(ants x tasks) every frame.

4. **Digging as a plan, not a reflex.** What decides where a tunnel goes and
   what shape the nest takes? Real nests have entrance shafts, branching
   galleries and chambers at depth. Propose how a shaft is planned, how a
   chamber is decided on, and how a plan survives contact with a bore that
   only removes capsules. Include how an ant recovers when the plan and the
   soil disagree — which is the failure the patience timers are papering over
   now.

5. **Stigmergy.** Ants coordinate through the environment, not by messaging.
   What should be written into the world — pheromone, spoil piles, tunnel
   wear — how is it stored cheaply at this scale, and what reads it? Be
   concrete about decay and about memory cost.

6. **Legibility.** The player is watching, not commanding, so an ant that is
   *thinking* has to look like it. Say which parts of the design exist to be
   readable at a glance and which are purely mechanical.

7. **The build order.** Give me a sequence of increments where each one is
   independently testable and each one leaves the game playable. For each,
   name the observable that proves it works — a number a headless probe could
   measure, not "it looks better".

## Constraints to respect

- Keep the intent-based ownership chain. The AI outputs wants; it does not
  move bodies or pose legs.
- Deterministic given a seed. No `Math.random` inside behaviour.
- Everything must be measurable by a headless probe that ticks the sim and
  reads numbers. If a behaviour cannot be reduced to an observable, say so —
  that is useful information, not a failure.
- No new runtime dependencies.
- Millimetres for design numbers; the code converts at the edges. Three unit
  systems have already caused real bugs here.
- Where you cite ant biology, cite the actual finding and distinguish it from
  game tuning you invented. I would rather have "this is tuning" than a
  plausible fake citation.

## What not to give me

Not a survey of options with no recommendation, not a class diagram with no
behaviour, and not a plan that assumes a navmesh, a physics engine, an ECS
rewrite or a behaviour-tree library. Assume the coding agent will push back
on anything unmeasurable, so pre-empt that.
