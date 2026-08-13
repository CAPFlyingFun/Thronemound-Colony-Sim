# Working on Thronemound

A browser-based 3D ant colony game — three.js + TypeScript + Vite, deployed to
GitHub Pages, played on an iPhone. One queen, one island, a founding, and a
colony that grows.

## The board is the plan; the repo is the reasoning

**https://trello.com/b/QJjGK6yH/thronemound-colony-sim**

Both Claude and ChatGPT are connected to it, and cards arrive from either
side between sessions.

**Scan the board BEFORE starting work and AGAIN after finishing.** Not a
nicety — the other half of this collaboration writes cards while you are
mid-task, and a plan read once at the start of a long session is a plan that
was true an hour ago. The after-scan is where you find what arrived while you
were building.

Lists, and what they mean:

- **Now** — holds ONE thing. If it holds three, nothing is actually in flight.
- **Next** — queued and specified enough to start.
- **Backlog — salvaged from Micro Battle** — design lifted from the 2022–24
  ant game on the same Trello account. Every card names and links the original.
  The old boards are a record: read them, do not edit them.
- **Shipped** — append-only. A card per release, never an edit to an old one.
- **Not doing — decided** — carries the REASONING, so a decision is not
  re-argued in three weeks.

Detailed reasoning lives in code comments and commit messages, not on cards.
A card says what and why-at-a-glance; the file says why-in-full.

## The rule the survival systems are built around

**A bar may only move if there is a way to move it back.** A meter that can
only fall is a countdown to a state the player cannot leave, which is worse
than an honest empty frame.

Corollaries, all load-bearing:

- A button wired to nothing is a lie. Unbuilt abilities are drawn **dimmed**
  (`is-soon`), never hidden — dimmed says "coming", absent says nothing.
- `built` lives on the ABILITY (does the GAME do this?); the ability list
  lives on the KIND (does THIS ANT do this?). See `src/scenes/antKinds.ts`.
- A plate flips to `built: true` in the same commit as the thing it does.
  `tests/antKinds.test.ts` asserts the exact list and is designed to fail
  until the flag matches reality.
- Nothing drains during the founding, and that is BIOLOGY rather than a stub:
  a claustral fire ant queen eats nothing until her first workers eclose.

## Research

Cite the actual literature. Two constants in this repo came from
pest-control blog pages and had to be pulled; the corrections are recorded in
the header of `src/scenes/antKinds.ts` because the next person deserves to
know which numbers were measured and which were designed.

Where a number is game tuning wearing a research finding's clothes, **say so
in the comment**.

## Verifying

- `npx vitest run` — the unit suite. Pure logic (vitals, combat, dodge,
  posture, ant table) is tested; scene wiring is not.
- `npm run probe:boot` — menu, START, island, and she walks 14.91 mm.
- `scratch-*.mjs` in the repo root are throwaway Playwright probes, gitignored.
  They must live in the root for module resolution.

**Measure rather than assume.** Bugs found only by measuring, this session:
DIG rendering at 78px instead of 86 (a media query winning on file order),
plates silently squashed by flex, the camera at world origin from a scratch
vector aliased between two callers.

**The probe environment runs at about 1 fps** under SwiftShader, and `animate`
clamps `dt` to 0.05 — so a wall second buys ~0.04s of game time. Any rate
read off the wall clock will look ~20x too slow. Measure the frame rate
before retuning anything per-second.

## Git

Work on `claude/tcs-architecture-audit-nan3ie`, then push to `main` as well —
Joshua tests from the live GitHub Pages build, so unpushed work is invisible.

Bump `package.json` version every release; it shows on the main menu and the
STATS chip, and it is how a screenshot gets dated.

Run the tests and the boot probe before pushing. Do not open pull requests
unless asked.
