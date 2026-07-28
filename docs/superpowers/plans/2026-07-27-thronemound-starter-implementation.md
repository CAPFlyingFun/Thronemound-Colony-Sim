# Thronemound Colony Sim Starter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a mobile-friendly Phaser 3 and TypeScript starter featuring a polished main menu, a large 2.5D surface world, independent ant agents, caste differences, food gathering, local alarm propagation, pheromone fields, and a simple hostile insect.

**Architecture:** Phaser scenes own presentation and lifecycle while pure TypeScript simulation modules own caste data, memory, perception, decision scoring, pheromone decay, and colony state. Each ant owns its own mind and memory, and shared systems only provide local observations and world services. Vitest covers pure logic while Playwright-style browser automation is intentionally deferred in favor of build checks and focused manual smoke testing for the first milestone.

**Tech Stack:** TypeScript, Phaser 3, Vite, Vitest, ESLint, GitHub Actions, GitHub Pages

## Global Constraints

- Deploy under the exact Vite base path `/Thronemound-Colony-Sim/`.
- Support iPhone-sized screens down to 320 CSS pixels wide.
- Use procedural placeholder visuals with no required external art or audio assets.
- Keep each ant's memory, target, decision cooldown, and behavior state independent.
- Use staggered AI updates and spatial queries rather than evaluating every ant against every entity each frame.
- Support minor, standard, major, and super-major caste data immediately.
- Include food, home, and alarm pheromone types with decay.
- Include only simple placeholder combat in this milestone.
- Do not implement direct scout possession, underground chambers, brood simulation, weather, rival colonies, or multiple playable species yet.

---

## Planned File Map

```text
.github/workflows/deploy.yml        Build, test, and GitHub Pages deployment
index.html                          Vite entry document
package.json                        Scripts and dependencies
tsconfig.json                       TypeScript configuration
vite.config.ts                      Repository subpath build configuration
vitest.config.ts                    Unit-test configuration
src/main.ts                         Phaser startup
src/styles.css                      Responsive host-page styling
src/game/config.ts                  Phaser game configuration
src/game/constants.ts               Shared dimensions and timing values
src/game/GameState.ts               Persistent colony state
src/data/antCastes.ts               Caste definitions and stats
src/data/behaviorWeights.ts         AI scoring weights
src/data/resources.ts               Food and threat definitions
src/simulation/types.ts             Shared simulation interfaces
src/simulation/AntMemory.ts         Per-ant timed observations
src/simulation/AntMind.ts           Independent decision scoring
src/world/SpatialHash.ts            Nearby-entity lookup
src/world/WorldGenerator.ts         Procedural surface layout data
src/entities/Ant.ts                 Ant sprite, movement, carrying, and health
src/entities/FoodSource.ts          Harvestable food entity
src/entities/NestEntrance.ts        Deposit and home location
src/entities/Threat.ts              Simple hostile insect entity
src/systems/PerceptionSystem.ts     Local observations for one ant
src/systems/PheromoneSystem.ts      Signal storage, decay, merge, and sampling
src/systems/ThreatSystem.ts         Hostile movement and contact damage
src/systems/AntAISystem.ts          Staggered independent decision updates
src/systems/ColonySystem.ts         Shared colony totals and alert state
src/systems/DepthSystem.ts          2.5D y-based depth ordering
src/systems/DayNightSystem.ts       Surface tint and time progression
src/scenes/BootScene.ts             Procedural texture generation
src/scenes/MainMenuScene.ts         Animated menu and overlays
src/scenes/SurfaceScene.ts          World and simulation orchestration
src/scenes/UIScene.ts               Responsive HUD
src/ui/Hud.ts                       HUD rendering and updates
src/tests/*.test.ts                 Pure simulation unit tests
README.md                           Setup, controls, architecture, deployment
```

---

### Task 1: Project Scaffold and Deployment Foundation

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `src/main.ts`
- Create: `src/styles.css`
- Create: `src/game/config.ts`
- Create: `.github/workflows/deploy.yml`
- Create: `README.md`

**Interfaces:**
- Produces: `createGameConfig(): Phaser.Types.Core.GameConfig`
- Produces scripts: `dev`, `build`, `typecheck`, `test`, `test:run`

- [ ] **Step 1: Create package and compiler configuration**

Use Phaser 3, Vite, TypeScript, Vitest, and ESLint-compatible scripts. Configure strict TypeScript, DOM libraries, no emit, and Vite module resolution.

- [ ] **Step 2: Configure the GitHub Pages base path**

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Thronemound-Colony-Sim/',
});
```

- [ ] **Step 3: Add the Phaser bootstrap**

```ts
// src/main.ts
import Phaser from 'phaser';
import './styles.css';
import { createGameConfig } from './game/config';

new Phaser.Game(createGameConfig());
```

- [ ] **Step 4: Add GitHub Actions deployment**

Configure `actions/checkout`, `actions/setup-node`, `npm ci`, `npm run test:run`, `npm run typecheck`, `npm run build`, `actions/upload-pages-artifact`, and `actions/deploy-pages` with `pages: write` and `id-token: write` permissions.

- [ ] **Step 5: Verify the empty shell**

Run:

```bash
npm install
npm run test:run
npm run typecheck
npm run build
```

Expected: all commands pass and `dist/index.html` exists.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "chore: scaffold Phaser TypeScript project"
```

---

### Task 2: Caste Data and Colony State

**Files:**
- Create: `src/data/antCastes.ts`
- Create: `src/game/GameState.ts`
- Create: `src/simulation/types.ts`
- Create: `src/tests/antCastes.test.ts`
- Create: `src/tests/gameState.test.ts`

**Interfaces:**
- Produces: `type AntCasteId = 'minor' | 'standard' | 'major' | 'superMajor'`
- Produces: `interface AntCasteDefinition`
- Produces: `ANT_CASTES: Record<AntCasteId, AntCasteDefinition>`
- Produces: `class GameState`
- Produces: `GameState.createNewColony(): void`
- Produces: `GameState.depositFood(amount: number): void`

- [ ] **Step 1: Write failing caste tests**

Test that all four caste IDs exist, visual scale increases by caste, speed generally decreases, and health, attack, and carrying capacity increase.

- [ ] **Step 2: Run the tests and confirm failure**

```bash
npm run test:run -- src/tests/antCastes.test.ts
```

Expected: FAIL because `ANT_CASTES` does not exist.

- [ ] **Step 3: Implement immutable caste definitions**

Each definition must include `scale`, `speed`, `maxHealth`, `attackPower`, `carryingCapacity`, `energyUse`, `foodUpkeep`, `awarenessRadius`, `alarmSensitivity`, `bravery`, and task weights.

- [ ] **Step 4: Write failing colony-state tests**

Verify a new colony starts with one queen, mixed workers, zero or configured starter food, full colony health, daytime, and no active alert. Verify deposits add only positive amounts.

- [ ] **Step 5: Implement `GameState`**

Use explicit fields for population by caste, total food, colony health, normalized day time, active alert strength, and save version.

- [ ] **Step 6: Run tests and type checking**

```bash
npm run test:run
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/data src/game src/simulation src/tests
git commit -m "feat: add caste definitions and colony state"
```

---

### Task 3: Individual Memory and Decision Engine

**Files:**
- Create: `src/data/behaviorWeights.ts`
- Create: `src/simulation/AntMemory.ts`
- Create: `src/simulation/AntMind.ts`
- Create: `src/tests/antMemory.test.ts`
- Create: `src/tests/antMind.test.ts`

**Interfaces:**
- Produces: `type AntBehaviorState = 'idle' | 'wander' | 'scout' | 'investigate' | 'seekFood' | 'carryFood' | 'returnToNest' | 'alert' | 'defend' | 'assistAlly' | 'retreat' | 'flee' | 'recover'`
- Produces: `class AntMemory`
- Produces: `AntMemory.remember(observation: MemoryObservation): void`
- Produces: `AntMemory.prune(nowMs: number): void`
- Produces: `class AntMind`
- Produces: `AntMind.decide(context: DecisionContext): AntDecision`

- [ ] **Step 1: Write memory expiration tests**

Verify food, threat, and pheromone observations belong to one memory instance and expire independently according to `expiresAt`.

- [ ] **Step 2: Implement bounded `AntMemory`**

Store a maximum number of observations by category, replace stale observations for the same target, and prune expired entries.

- [ ] **Step 3: Write decision tests**

Include these exact scenarios:

```text
minor + large nearby threat + no allies -> flee
major + nearby threat + healthy -> defend
standard + threatened ally + sufficient allied strength -> assistAlly
injured major + overwhelming threat away from nest -> retreat
carrying food + no urgent threat -> returnToNest
hungry colony + remembered food -> seekFood
```

- [ ] **Step 4: Implement deterministic weighted decisions**

`AntMind.decide` must score valid states from local context, apply caste weights, reject impossible actions, and return the highest score with a target ID or position when needed. Randomness may only break equal scores and must accept an injectable random function for tests.

- [ ] **Step 5: Run focused tests**

```bash
npm run test:run -- src/tests/antMemory.test.ts src/tests/antMind.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data/behaviorWeights.ts src/simulation src/tests
git commit -m "feat: add independent ant memory and decision logic"
```

---

### Task 4: Spatial Hash and Pheromone Field

**Files:**
- Create: `src/world/SpatialHash.ts`
- Create: `src/systems/PheromoneSystem.ts`
- Create: `src/tests/spatialHash.test.ts`
- Create: `src/tests/pheromoneSystem.test.ts`

**Interfaces:**
- Produces: `class SpatialHash<T extends SpatialEntity>`
- Produces: `SpatialHash.insert(entity: T): void`
- Produces: `SpatialHash.update(entity: T): void`
- Produces: `SpatialHash.remove(id: string): void`
- Produces: `SpatialHash.queryRadius(x: number, y: number, radius: number): T[]`
- Produces: `type PheromoneType = 'food' | 'home' | 'alarm'`
- Produces: `class PheromoneSystem`
- Produces: `PheromoneSystem.emit(signal: PheromoneEmission): void`
- Produces: `PheromoneSystem.sample(x: number, y: number, radius: number, type?: PheromoneType): PheromoneSample[]`
- Produces: `PheromoneSystem.update(deltaMs: number): void`

- [ ] **Step 1: Write spatial-query tests**

Verify radius queries return nearby entities, exclude distant entities, and reflect move and removal operations.

- [ ] **Step 2: Implement fixed-cell spatial hashing**

Use string cell keys derived from floored coordinates. Query only cells touched by the search circle, then distance-filter candidates.

- [ ] **Step 3: Write pheromone tests**

Verify signals decay, expire, remain type-specific, and merge when the same type is emitted within a configured merge radius.

- [ ] **Step 4: Implement pheromone storage and sampling**

Cap strength, merge nearby emissions, decay by elapsed seconds, remove expired signals, and return samples sorted strongest-first.

- [ ] **Step 5: Run tests and type checking**

```bash
npm run test:run
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/world/SpatialHash.ts src/systems/PheromoneSystem.ts src/tests
git commit -m "feat: add spatial queries and pheromone fields"
```

---

### Task 5: Procedural Art, Menu, and Responsive Overlays

**Files:**
- Create: `src/game/constants.ts`
- Create: `src/scenes/BootScene.ts`
- Create: `src/scenes/MainMenuScene.ts`
- Modify: `src/game/config.ts`
- Modify: `src/styles.css`

**Interfaces:**
- Produces texture keys: `ant-minor`, `ant-standard`, `ant-major`, `ant-super-major`, `nest`, `food`, `threat`, `grass`, `rock`, `leaf`
- Produces scene keys: `BootScene`, `MainMenuScene`, `SurfaceScene`, `UIScene`

- [ ] **Step 1: Register scene order and responsive scaling**

Use Phaser `Scale.FIT`, `CENTER_BOTH`, a logical size of 1280 by 720, and a transparent or dark page background.

- [ ] **Step 2: Generate procedural textures in `BootScene`**

Create readable ant silhouettes with head, thorax, abdomen, and legs. Create simple painterly circles, ellipses, and polygons for terrain props. Reuse generated textures.

- [ ] **Step 3: Build the animated menu**

Add title, subtitle, New Colony, Continue, Settings, and About. Keep Continue visibly disabled until save detection exists. Add ambient ants, drifting leaves, and slow tint changes.

- [ ] **Step 4: Add modal overlays**

Settings must expose master volume and reduced-motion toggles in memory. About must explain the hybrid colony-manager and future scout-control direction.

- [ ] **Step 5: Verify desktop and mobile layouts manually**

Check widths of 320, 390, 768, and 1280 CSS pixels. Ensure no controls clip and touch targets remain usable.

- [ ] **Step 6: Commit**

```bash
git add src/game src/scenes src/styles.css
git commit -m "feat: add procedural art and animated main menu"
```

---

### Task 6: Surface World, Entities, Camera, and Depth

**Files:**
- Create: `src/world/WorldGenerator.ts`
- Create: `src/entities/NestEntrance.ts`
- Create: `src/entities/FoodSource.ts`
- Create: `src/entities/Ant.ts`
- Create: `src/entities/Threat.ts`
- Create: `src/systems/DepthSystem.ts`
- Create: `src/scenes/SurfaceScene.ts`

**Interfaces:**
- Produces: `generateSurfaceWorld(seed: number): SurfaceWorldData`
- Produces: `class Ant extends Phaser.GameObjects.Container`
- Produces: `Ant.setDestination(position: Vector2Like): void`
- Produces: `Ant.applyDamage(amount: number, sourceId: string): void`
- Produces: `Ant.pickUpFood(amount: number, sourceId: string): number`
- Produces: `Ant.depositCarriedFood(): number`
- Produces: `class FoodSource`
- Produces: `FoodSource.harvest(requested: number): number`
- Produces: `class Threat`

- [ ] **Step 1: Generate a deterministic meadow layout**

Create world bounds larger than the viewport, a central nest, food clusters, decorative props, and one threat spawn area. Decoration must not require physics bodies.

- [ ] **Step 2: Implement entities with clear simulation-facing state**

Ants expose ID, caste, health, energy, carried food, behavior state, target, memory, and mind. Food exposes remaining amount. Threat exposes health, attack power, target, and alive state.

- [ ] **Step 3: Implement smooth steering and camera controls**

Support mouse or touch drag panning, wheel zoom, keyboard panning, zoom clamping, and camera bounds. Do not move an ant by teleporting between AI ticks.

- [ ] **Step 4: Add depth sorting**

Set depth from world Y plus small offsets so ants pass behind and in front of scenery. Refresh only moving or changed objects.

- [ ] **Step 5: Manually verify world navigation**

Confirm the player can pan and zoom without escaping world bounds and that caste scales are clearly visible.

- [ ] **Step 6: Commit**

```bash
git add src/world src/entities src/systems/DepthSystem.ts src/scenes/SurfaceScene.ts
git commit -m "feat: add surface world entities and camera"
```

---

### Task 7: Perception, Food Loop, and Colony Systems

**Files:**
- Create: `src/systems/PerceptionSystem.ts`
- Create: `src/systems/ColonySystem.ts`
- Create: `src/systems/AntAISystem.ts`
- Modify: `src/scenes/SurfaceScene.ts`
- Create: `src/tests/perceptionSystem.test.ts`
- Create: `src/tests/colonySystem.test.ts`

**Interfaces:**
- Produces: `PerceptionSystem.observe(ant: AntSnapshot, nowMs: number): DecisionContext`
- Produces: `ColonySystem.depositFood(antId: string, amount: number): void`
- Produces: `ColonySystem.setAlert(sourceId: string, strength: number, expiresAt: number): void`
- Produces: `AntAISystem.update(nowMs: number, deltaMs: number): void`

- [ ] **Step 1: Write local perception tests**

Verify ants only observe entities inside caste awareness radius, firsthand threats outrank memory, and pheromone samples remain local.

- [ ] **Step 2: Implement observation assembly**

Query spatial hashes for ants, food, threats, and pheromones. Convert Phaser entities into immutable decision snapshots before passing them to `AntMind`.

- [ ] **Step 3: Write food-loop tests**

Verify harvested food cannot exceed source amount, carried food cannot exceed caste capacity, and colony totals increase only after a deposit at the nest.

- [ ] **Step 4: Implement staggered AI scheduling**

Assign each ant a decision phase and evaluate only a portion each frame. Movement continues every frame toward the current destination. Reevaluate immediately after damage, target destruction, deposit, or arrival.

- [ ] **Step 5: Connect food behavior states**

Implement wander, seek food, carry food, and return to nest. Emit weak food pheromone while returning successfully and home pheromone near the nest.

- [ ] **Step 6: Run tests and manual simulation**

Expected: mixed castes independently discover food, carry caste-sized loads, return, deposit, and resume work without synchronized identical paths.

- [ ] **Step 7: Commit**

```bash
git add src/systems src/scenes/SurfaceScene.ts src/tests
git commit -m "feat: add independent foraging simulation"
```

---

### Task 8: Threat Response, Alarm Cascade, and Cooperative Defense

**Files:**
- Create: `src/systems/ThreatSystem.ts`
- Modify: `src/systems/AntAISystem.ts`
- Modify: `src/systems/PerceptionSystem.ts`
- Modify: `src/systems/PheromoneSystem.ts`
- Modify: `src/entities/Ant.ts`
- Modify: `src/entities/Threat.ts`
- Modify: `src/scenes/SurfaceScene.ts`
- Create: `src/tests/alarmCascade.test.ts`
- Create: `src/tests/cooperativeDefense.test.ts`

**Interfaces:**
- Produces: `ThreatSystem.update(nowMs: number, deltaMs: number): void`
- Produces: `ThreatSystem.resolveContact(attackerId: string, targetId: string): CombatResult`
- Extends: `AntAISystem` behavior execution for `alert`, `defend`, `assistAlly`, `retreat`, and `flee`

- [ ] **Step 1: Write alarm-cascade tests**

Verify one attacked ant emits an alarm, ants inside range react, distant ants do not react immediately, responding ants may relay weaker signals, and the cascade ends after signals decay.

- [ ] **Step 2: Write caste-response tests**

Test that minors prefer flee or alert against a large threat, healthy majors prefer defend, standards assist when local ally strength is sufficient, and injured ants retreat unless the threat is at the nest.

- [ ] **Step 3: Implement placeholder hostile behavior**

The threat wanders, acquires the nearest ant inside aggro radius, approaches, and deals contact damage on cooldown. It abandons targets beyond a leash radius.

- [ ] **Step 4: Implement alarm emission and relay**

On threat detection or damage, emit an alarm signal at the last known threat position. Relayed signals must use reduced strength and a per-ant relay cooldown to prevent exponential flooding.

- [ ] **Step 5: Implement cooperative approach slots**

Generate a small ring of reservation points around the threat. Defenders claim free slots, preventing every ant from occupying the same point.

- [ ] **Step 6: Implement disengagement**

Clear defense targets when the threat dies, leaves perception and memory expires, or local danger exceeds retreat thresholds. Remove stale reservations.

- [ ] **Step 7: Run tests and manual battle smoke check**

Expected: a local response visibly spreads, larger castes tend to intercept, smaller ants tend to warn or flee, the entire map is not alerted, and the colony settles after danger ends.

- [ ] **Step 8: Commit**

```bash
git add src/systems src/entities src/scenes/SurfaceScene.ts src/tests
git commit -m "feat: add local alarm cascade and cooperative defense"
```

---

### Task 9: HUD, Day-Night Presentation, and Save Foundation

**Files:**
- Create: `src/ui/Hud.ts`
- Create: `src/scenes/UIScene.ts`
- Create: `src/systems/DayNightSystem.ts`
- Create: `src/systems/SaveSystem.ts`
- Modify: `src/scenes/SurfaceScene.ts`
- Modify: `src/scenes/MainMenuScene.ts`
- Create: `src/tests/saveSystem.test.ts`

**Interfaces:**
- Produces: `Hud.update(snapshot: HudSnapshot): void`
- Produces: `DayNightSystem.update(deltaMs: number): DayNightSnapshot`
- Produces: `SaveSystem.hasValidSave(): boolean`
- Produces: `SaveSystem.save(state: SerializableGameState): SaveResult`
- Produces: `SaveSystem.load(): SerializableGameState | null`

- [ ] **Step 1: Add a responsive HUD**

Show population, food, colony health, time of day, and current alert level. Collapse labels intelligently on narrow screens while retaining icons and values.

- [ ] **Step 2: Implement time progression and surface tint**

Advance normalized day time and blend a lightweight overlay through dawn, day, dusk, and night without expensive dynamic lighting.

- [ ] **Step 3: Write save validation tests**

Verify missing saves return null, malformed JSON returns null with a warning path, wrong versions are rejected, and valid current-version data loads.

- [ ] **Step 4: Implement local save foundation**

Persist colony totals, time, settings, and version. Full ant positions and world persistence may remain out of scope for this starter, but the format must be explicit and versioned.

- [ ] **Step 5: Enable Continue only for valid saves**

Load supported state into a new surface scene and clearly document what is and is not restored.

- [ ] **Step 6: Commit**

```bash
git add src/ui src/scenes src/systems src/tests
git commit -m "feat: add HUD day cycle and save foundation"
```

---

### Task 10: Verification, Polish, and Release Documentation

**Files:**
- Modify: `README.md`
- Modify: any source files found during verification

**Interfaces:**
- No new public interface required.

- [ ] **Step 1: Run the complete automated verification suite**

```bash
npm ci
npm run test:run
npm run typecheck
npm run build
```

Expected: every command exits with status 0.

- [ ] **Step 2: Inspect the production build locally**

```bash
npm run dev -- --host 0.0.0.0
```

Verify menu navigation, overlays, camera controls, caste visuals, food gathering, alarm propagation, threat disengagement, day-night tint, save creation, and Continue behavior.

- [ ] **Step 3: Test mobile interaction**

Use responsive dimensions of 320 by 568, 390 by 844, and 430 by 932. Verify panning, zoom controls, button targets, HUD readability, and no horizontal overflow.

- [ ] **Step 4: Check performance behavior**

With at least 40 visible ants, verify decisions remain staggered, pheromone count stabilizes through decay and merging, and no ant remains frozen after a destroyed target.

- [ ] **Step 5: Complete README documentation**

Document setup, scripts, controls, architecture, independent AI model, pheromone types, caste stats, known starter limitations, GitHub Pages deployment, and next milestone candidates.

- [ ] **Step 6: Commit final verification changes**

```bash
git add .
git commit -m "docs: finalize starter verification and usage guide"
```

- [ ] **Step 7: Confirm GitHub Actions deployment**

Push `main`, inspect the workflow run, and verify the published site loads assets from `/Thronemound-Colony-Sim/` without 404 errors.
