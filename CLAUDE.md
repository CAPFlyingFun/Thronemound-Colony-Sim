# Working on Thronemound

Thronemound Colony Sim is a browser-based 3D ant colony game built with
three.js + TypeScript + Vite, deployed to GitHub Pages and primarily tested
on mobile.

THE PLAYER IS THE KEEPER, NOT THE ANT (decided 2026-08-19). You build a
habitat, introduce a Queen and watch an autonomous colony dig, forage and
grow. The player does not normally steer a worker, dig a tunnel by hand or
carry anything.

The direct-control island build is FROZEN, not deleted. It is still the
whole of `IslandScene` and the `island*` modules, still playable at
`?scene=menu` and `?scene=island`, and still the reference for how the ant's
body works — but it is not what the game opens as any more, and it is not
where new work goes. The colony simulator lives in `src/sim` on the voxel
formicarium stack and is what the bare URL serves.

Treat old cards, old commits and older sections of this file that assume
"you are the queen, dig your nest" as history rather than as the plan.

---

## Trello is the living source of truth

**Trello board:**
https://trello.com/b/qhKcDzLi/thronemound-colony-sim

The board moved (2026-08-19). The old `QJjGK6yH` board is now a DIFFERENT
GAME — it became "Trail of Ants" and then TRADDOMIUM: Micro Battle, which
has its own repo. Anything read there is another project's plan. If a link
in an old card or an old instruction points at `QJjGK6yH`, it is stale.

Trello is the authoritative source for CURRENT:

- roadmap and priorities
- UI / HUD direction
- gameplay design decisions
- active bugs and diagnoses
- screenshots and visual references
- acceptance criteria
- feature sequencing
- work ownership
- decisions made by Joshua, ChatGPT, Claude, or other collaborators

Both Claude and ChatGPT may update the board between sessions.

**Scan Trello BEFORE starting substantial work and AGAIN before finishing.**

Do not assume a plan read at the beginning of a long session is still the
current plan at the end.

### CLAUDE.md is not automatically current game-design truth

This file is a STABLE OPERATING GUIDE, not a frozen design bible.

It can become stale.

Unless the current agent is actively keeping a section synchronized with
Trello, do NOT treat design details in this file as higher authority than:

1. Joshua's current explicit instruction
2. the active Trello card and its attachments/comments
3. current approved visual references / blueprints
4. current repository behavior and tests
5. this file

If this file conflicts with a newer Trello card, image, card comment, or
explicit instruction, assume this file is outdated for that topic.

**Flag the conflict, then follow the newer source. Do not silently let stale
CLAUDE.md wording override current design.**

Useful engineering invariants may remain here, but current feature/UI/gameplay
decisions belong on Trello.

---

## Trello list meanings

- **Now** - active work. Keep this intentionally small.
- **Next** - ready or nearly ready work.
- **Backlog** - valid future ideas that are not current implementation work.
- **Shipped** - completed work / release history.
- **Not doing** - decisions intentionally rejected or deferred, with reasoning.

Old cards and old boards are historical evidence, not automatically the
current plan.

---

## Contextual HUD rule

**The gameplay HUD is contextual, not a permanent inventory of every possible
action.**

Different gameplay modes may expose different controls and information.

Examples include:

- Normal / exploration
- Digging
- Combat
- Carrying / dragging
- Founding
- Interaction
- future colony-management or species-specific modes

The active mode should show the controls relevant to what the player can
reasonably do NOW.

### Unbuilt abilities

An unavailable action must never look functional.

However, an unbuilt or irrelevant ability does **not** need to remain visible
on the gameplay HUD merely to advertise that it exists.

Depending on the approved current UI design, an ability may be:

- shown normally when relevant and built
- shown dimmed when intentionally previewing a future feature
- reduced / demoted when secondary
- hidden when irrelevant to the current mode
- omitted entirely from a clean gameplay composition

The current Trello UI card, attached screenshots, and blueprint decide which
treatment is appropriate.

Do not apply an old global rule such as "all unbuilt plates must always stay
visible" if it conflicts with the current contextual HUD design.

`built` still describes whether the GAME implements the ability.

The ability list on an ant kind still describes whether THAT ANT can possess
the ability.

A control must not appear enabled until the mechanic actually exists.

---

## UI / visual-source rule

For visual work, screenshots and approved visual references attached to the
active Trello card outrank prose written earlier.

If a card says to match a particular rendered layout or blueprint:

- inspect every attached image
- read the card comments/replies
- follow the latest approved layout closely
- preserve TCS's black/gold ant-art identity unless explicitly changed

Do not reinterpret "cleaner" into a different composition when an exact
blueprint exists.

Measure at the real target viewport, especially the 932 x 430 logical design
canvas and supported smaller landscape sizes.

---

## Survival-system invariant

**A bar may only move if there is a way to move it back.**

A meter that only falls is a countdown to an unavoidable state.

Examples:

- stamina may drain because it can recover
- health should not become a live drain system until healing exists
- food / energy should not actively drain until eating/refill mechanics exist
- water should not actively drain until drinking/refill mechanics exist

Founding exceptions should follow the current biology/design recorded in the
repo and Trello.

---

## Species / ability data

Species-specific behavior belongs in data where practical.

`src/scenes/antKinds.ts` is the current species/ability definition area.

General principle:

- `built` = does the game currently implement this mechanic?
- species ability list = does this ant/species have access to this mechanic?

When a mechanic becomes real, update its implementation, UI behavior, tests,
and `built` state coherently.

Do not duplicate species mechanics in multiple competing tuning systems.

---

## Research

Use primary scientific literature whenever practical.

When a number is measured biology, cite the source.

When a number is GAME TUNING inspired by biology, say so plainly.

Do not let an old research comment become permanent truth if newer primary
research or a current design decision supersedes it.

If research affects current gameplay direction, summarize the decision on
Trello so future agents can find it.

---

## Verification

Measure rather than assume.

Useful commands currently include:

- `npx vitest run`
- `npm run typecheck`
- `npm run build`
- `npm run probe:boot`
- `npm run probe:hud`
- relevant feature-specific probes such as haul, interact, pause, corner, etc.

Read `package.json` for the CURRENT command list instead of assuming this file
contains every new probe.

For visual/UI changes:

- inspect the rendered result at supported landscape sizes
- use screenshots or automated screenshot/probe output where possible
- test the device-visible symptom, not merely internal CSS values

The SwiftShader / automated probe environment may run much slower than real
game time. Do not retune per-second systems from wall-clock observations
without measuring frame rate / simulated dt.

---

## Git and collaboration

Do not assume a branch name written in an old instruction is still current.

Before writing:

1. inspect current main
2. inspect Trello
3. confirm current work ownership
4. use an isolated branch/worktree when appropriate

Do not duplicate work already claimed by another agent.

Worker agents should make narrow, coherent changes.

The lead/integration agent should review, test, and integrate.

Joshua tests from the live GitHub Pages build, so work intended for device
testing must eventually reach the deployed branch.

Bump the package version according to the project's current release practice.

Do not open or merge PRs merely because an old line in this file said to.
Follow the current Trello workflow and the user's instruction.

---

## Trello ownership tags

Work ownership on the board is marked with LABELS, one per collaborator
(Claude, ChatGPT, and the human helpers by name — read the board's label
list for the current roster rather than trusting this sentence).

- Claiming a card = attaching your label to it. Do not take a card that
  wears someone else's label without checking with Joshua.
- When Claude moves a card from **Coding** to **Testing**, attach
  **Joshua's label alongside Claude's** — everything in Testing is
  waiting on his device pass, and the pair of labels says so at a glance.
  (Joshua's standing instruction, 2026-08-18.)
- Trello card COMMENTS do not reach Claude through the current connector.
  Notes meant for Claude belong in the card's DESCRIPTION, or with Joshua
  directly.

---

## Working rule for ambiguity

When two sources disagree:

**Do not invent a compromise solely to satisfy both.**

Instead:

1. identify which source is newer / authoritative
2. flag the contradiction
3. follow the current source
4. update stale documentation when appropriate

Example:

If an old CLAUDE.md rule says every unbuilt action must remain visible, but
the current Trello HUD blueprint calls for mode-specific relevant controls,
the current blueprint wins.

The correct implementation is a contextual HUD, not a permanently crowded HUD.

---

## Keep this file useful

When editing `CLAUDE.md`, prefer stable engineering guidance.

Avoid storing fast-changing items here such as:

- current sprint priorities
- exact active Trello card
- temporary branch names
- one-off bug states
- current UI layout details that already live on Trello
- current release-specific implementation plans

Those belong on Trello, in commits, tests, or focused design docs.

If this file starts contradicting the board, update or simplify it rather than
making future agents reconcile archaeology.
