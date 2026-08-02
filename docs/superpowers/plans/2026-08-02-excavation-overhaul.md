# Excavation Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate excavation locomotion and path system so active digging no longer depends on the changing terrain surface for ant pose or camera placement.

**Architecture:** Keep the current DensityField, Surface Nets terrain, and six-face crawler. Add a pure tunnel-path layer and excavation-state controller first, then wire BlockScene so DIG owns locomotion/camera while active and hands control back to the existing crawler on exit.

**Tech Stack:** TypeScript 5.8, Three.js 0.180, Vitest 3.2, Vite 7.

## Global Constraints

- Do not change normal surface crawling behavior.
- Camera may pass through terrain only while excavation mode is active.
- Manual and preset excavation must share one centerline representation.
- Physical dimensions are expressed in millimetres at the path layer.
- Existing DensityField remains authoritative for solid/air terrain.

---

### Task 1: Tunnel path primitives

**Files:**
- Create: `src/scenes/excavationPath.ts`
- Create: `tests/excavationPath.test.ts`

**Interfaces:**
- Produces `ExcavationPath`, `PathBranch`, `PathPoint`, `DigFrame`, `advanceManualFrame()`, and `buildPresetPath()`.

- [ ] Write tests for straight, elbow, tee, chamber, and manual steering.
- [ ] Run `npm test -- tests/excavationPath.test.ts` and verify RED.
- [ ] Implement deterministic path geometry.
- [ ] Run the focused test and verify GREEN.

### Task 2: Excavation ownership state

**Files:**
- Create: `src/scenes/ExcavationController.ts`
- Create: `tests/excavationController.test.ts`

**Interfaces:**
- Consumes a captured `DigFrame`.
- Produces a stable current frame, excavation centerline samples, camera-pass-through state, x-ray mix, and enter/exit events.

- [ ] Write tests proving terrain normals cannot change an active dig frame.
- [ ] Write tests proving camera collision is disabled only while active.
- [ ] Implement enter/step/exit state transitions.
- [ ] Run focused tests.

### Task 3: Density carving adapter

**Files:**
- Create: `src/scenes/excavationCarver.ts`
- Create: `tests/excavationCarver.test.ts`

**Interfaces:**
- Consumes an `ExcavationPath` and a tube radius.
- Produces deterministic subtraction samples and estimated removed volume for pellet accounting.

- [ ] Test sampling distance and branch coverage.
- [ ] Implement segment and connector sampling without coupling to ant pose.
- [ ] Run focused tests.

### Task 4: BlockScene integration

**Files:**
- Modify: `src/scenes/BlockScene.ts`
- Modify: `src/scenes/FollowCamera.ts`
- Modify: `src/scenes/DensityTerrainLabScene.css`

**Interfaces:**
- DIG enter captures the current ant frame.
- Active DIG skips normal `hold()`/rail ownership and advances through `ExcavationController`.
- Camera clearance/cut logic is bypassed while excavation mode is active.
- Exiting DIG restores normal crawler ownership and reacquires the nearest surface.

- [ ] Add a regression probe for straight excavation with bounded body/camera rotation.
- [ ] Wire excavation ownership into the main step loop.
- [ ] Wire x-ray presentation state and terrain-pass-through camera behavior.
- [ ] Verify surface walking probes remain unchanged.

### Task 5: Preset builder UI

**Files:**
- Modify: `src/scenes/BlockScene.ts`
- Modify: `src/scenes/DensityTerrainLabScene.css`

**Interfaces:**
- Presets generate the same `ExcavationPath` used by manual digging.

- [ ] Add Straight, Elbow, Tee, and Chamber selections.
- [ ] Preview before committing.
- [ ] Progressively excavate committed paths instead of instantly deleting terrain.

### Task 6: Verification

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run existing model/mobility smoke probes.
- [ ] Run new excavation smoke probe at 0°, -30°, -60°, and -90°.
- [ ] Confirm no automatic first/third-person cut occurs during active excavation.
