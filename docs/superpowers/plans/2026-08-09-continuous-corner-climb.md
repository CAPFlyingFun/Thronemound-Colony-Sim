# Continuous Corner Climb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sharp floor-to-wall transitions continuous after real front-foot grips, with no pre-contact body hop and no lingering post-transition gait slowdown.

**Architecture:** Keep `CornerTurn` as the contact scheduler, `LegDrive` as foot/constraint authority, and `SurfaceWalker` as body-seat/attitude authority. Expose a read-only corner target from `LegDrive`; after two new-surface front contacts, let `IslandScene` feed that target into the walker's existing rate-limited `aimUp()` before normal `settle()`. Replace the fixed handoff timer with a condition that keeps one-foot cleanup only while anchors remain outside a safe new-frame gait workspace.

**Tech Stack:** TypeScript, Three.js, Vitest, Vite.

## Global Constraints
- Start from v0.0.40 / commit `0289dacd139c904e431bac20f0ff21d36131618c`.
- No tree-specific code.
- No transition speed multiplier.
- No root teleport or scripted body jump.
- Preserve v0.0.39 first-person/spine fixes and v0.0.40 one-foot corner queue.
- Use `npm run typecheck`, not `npx tsc --noEmit`.

---

### Task 1: Pin the jump and handoff regressions

**Files:**
- Modify: `tests/cornerTurn.test.ts`

**Interfaces:**
- Consumes: `LegDrive.step`, `DriveReport.corner`, `SurfaceWalker`.
- Produces: regression expectations for body attitude, penetration, and post-handoff travel.

- [ ] Add a deterministic coupled floor/wall test that records the frame of the second front contact and asserts body tilt is still essentially old-surface before that frame.
- [ ] Add a test that after the second front contact, body `up` progresses monotonically toward the wall without the body probe entering the wall half-space.
- [ ] Add a post-handoff test comparing average displacement before the corner and after establishment; after settling, commanded walk speed must recover instead of remaining in a transition-only slowdown.
- [ ] Run `npm test -- tests/cornerTurn.test.ts` and confirm at least the new jump/continuity assertions fail on v0.0.40.

### Task 2: Expose a bounded corner attitude guide

**Files:**
- Modify: `src/anim/legDrive.ts`
- Modify: `tests/cornerTurn.test.ts`

**Interfaces:**
- Produces: `cornerGuide(into: THREE.Vector3): { active: boolean; weight: number }` or equivalent read-only API. It must return inactive until at least two contacts are planted on the target surface and must copy `CornerTurn.target` into caller-owned scratch storage.

- [ ] Add tests proving the guide is inactive at arming and after the first grip, then active after the second front grip.
- [ ] Implement the smallest read-only API using `this.corner.target` plus the current corner report/contact count. Do not mutate body pose inside `LegDrive`.
- [ ] Weight the guide from contact progress, beginning gently at two new contacts and reaching full authority only as the majority of feet transfer.
- [ ] Re-run focused tests.

### Task 3: Guide SurfaceWalker before penetration

**Files:**
- Modify: `src/scenes/IslandScene.ts`
- Test: `tests/cornerTurn.test.ts` or a focused new pure helper test if scene coupling makes direct unit testing impractical.

**Interfaces:**
- Consumes: `LegDrive.cornerGuide`, `SurfaceWalker.aimUp`, current `this.up/this.fwd`.

- [ ] Add a named transition-attitude rate/weight helper, expressed in radians per second or through `SurfaceWalker.aimUp()`'s existing rate cap.
- [ ] In `moveSurface()`, after `drive.step()` and only when two-or-more new-surface contacts are established, aim the existing body frame toward the target normal before `walker.settle()`.
- [ ] Do not change `this.at` directly. Let `walker.squareForward()` convert the new frame into a curved forward direction naturally.
- [ ] Ensure dig/dodge vetoes and ordinary flat walking never activate the guide.
- [ ] Verify the deterministic corner no longer needs to enter the solid half-space to turn.

### Task 4: Remove fixed post-corner slowdown

**Files:**
- Modify: `src/anim/legDrive.ts`
- Modify: `tests/cornerTurn.test.ts`

**Interfaces:**
- Replace fixed `HANDOFF_GRACE` behavior with a condition-driven cleanup gate based on actual anchor excursion in the new body frame.

- [ ] Add a failing test showing v0.0.40 keeps the normal tripod trigger suppressed for the entire fixed grace even when all planted anchors are already within safe workspace.
- [ ] Implement `needsHandoffCleanup(body, input)` or equivalent. Keep one-foot cleanup only while any planted foot is outside the safe gait budget; when all are inside, immediately restore the normal tripod scheduler.
- [ ] Keep a very short one-frame handoff guard only if required to prevent same-frame three-foot release; it must not be a speed/cadence timer.
- [ ] Verify ordinary tripod 3+3 stepping resumes and commanded travel continues after establishment.

### Task 5: Full verification and PR

**Files:**
- Update docs/comments only where behavior changed.

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run/inspect the existing landmark corner probe if available and record: first grip, second grip, first body tilt, maximum root penetration, minimum planted count, handoff frame, and post-handoff speed.
- [ ] Compare branch against `main` and confirm only the approved climb-continuity scope changed.
- [ ] Open a PR from `chatgpt/continuous-corner-climb` to `main` with the diagnosis, design, test evidence, and manual iPhone checks requested.