# Thronemound Colony Sim Starter Design

Date: 2026-07-27
Status: Approved

## 1. Project Goal

Create a browser-playable, mobile-friendly 2.5D ant colony simulator using TypeScript, Phaser 3, and Vite. The first release will establish a polished main menu, a scalable project architecture, a living top-down surface scene, and the first automatic colony simulation loop.

The long-term game will combine colony management with optional direct control of a scout ant. The initial implementation will prioritize automatic colony behavior, then reserve direct scout possession for the next milestone.

## 2. Core Experience

The player manages a living ant colony in a large miniature ecosystem. Every ant is an independent agent with its own caste, needs, memory, current task, awareness radius, and decision state. Colony-wide coordination emerges from local observations, nearby ants, alarm behavior, and pheromone signals rather than from one controller directly puppeteering every ant.

The visual style will be 2D top-down gameplay with 3D-inspired presentation:

- Depth-sorted scenery
- Soft directional shadows
- Layered grass, stones, leaves, roots, and nest structures
- Camera zoom and smooth panning
- Day and night lighting changes
- Large readable ants rather than tiny realistic dots
- Procedural placeholder art that requires no external asset packs

## 3. First Milestone Scope

### 3.1 Main Menu

The main menu will include:

- New Colony
- Continue, disabled until a save exists
- Settings
- About

The menu background will feel alive through lightweight ambient animation such as wandering ants, drifting leaves, moving grass shadows, and gradual color shifts.

### 3.2 Surface Scene

The first playable surface map will include:

- A large scrolling meadow and dirt environment
- One visible nest mound and entrance
- Rocks, grass clumps, flowers, sticks, leaves, and food sources
- Camera drag or edge movement on desktop
- Touch drag on mobile
- Mouse wheel and pinch-style zoom where practical
- Automatic depth sorting so ants can pass behind and in front of scenery

### 3.3 Initial Colony Simulation

The first playable colony will contain:

- One queen represented in colony state
- A small mixed-caste worker population
- Food storage
- Colony health
- Population count
- A simple time-of-day value

Worker ants will initially be able to:

- Wander near the nest
- Search for food
- Detect nearby food
- Travel to food
- Collect a load based on caste carrying capacity
- Return to the nest
- Deposit food into colony storage
- Resume searching
- Detect a nearby threat
- Enter alert, defend, assist, retreat, or flee states according to caste and local conditions
- Emit and follow short-lived food and alarm pheromone signals

### 3.4 HUD

The top HUD will display:

- Population
- Stored food
- Colony health
- Time of day
- Current alert state when the colony is threatened

The HUD must remain readable on narrow iPhone screens and scale cleanly to desktop.

## 4. Ant Size and Caste System

Ant size differences are a foundational gameplay system, not a cosmetic variation.

The initial data model will support at least four physical classes:

### Minor Worker

- Smallest body size
- Fast movement
- Low carrying capacity
- Low health and combat strength
- Efficient for scouting, nursing, and small food collection

### Standard Worker

- Balanced body size
- Average movement speed
- Average carrying capacity
- General-purpose colony labor

### Major Worker

- Larger body size
- Slower movement
- Higher carrying capacity
- Higher health and attack strength
- Useful for heavy food, excavation, and defense

### Super Major

- Rare, visually imposing caste
- Largest body scale
- Highest strength and carrying capacity
- Slow movement and higher food upkeep
- Intended for dangerous combat, large-object transport, and special colony tasks

Each ant class will expose configurable values for:

- Visual scale
- Movement speed
- Maximum health
- Attack power
- Carrying capacity
- Energy use
- Food upkeep
- Awareness radius
- Alarm sensitivity
- Bravery
- Preferred task weights

The starter milestone may spawn minors, standard workers, and majors, while the super-major class can remain uncommon or gated. The architecture must support all four immediately.

## 5. Independent Ant Intelligence and Emergent Coordination

Each ant owns an individual runtime state rather than receiving frame-by-frame movement orders from a colony controller.

An ant tracks:

- Unique identifier
- Caste and statistics
- Health and energy
- Current task
- Current behavior state
- Target entity or world position
- Recently observed food, threats, nest, and pheromones
- Short-term memory with expiration times
- Personal decision cooldown
- Local confidence, danger, and urgency values

Initial behavior states include:

- Idle
- Wander
- Scout
- Investigate
- Seek food
- Carry food
- Return to nest
- Alert
- Defend
- Assist ally
- Retreat
- Flee
- Recover

Decisions use local information and weighted priorities. For example, a minor worker near a large hostile insect may flee and release an alarm signal, while a major may defend immediately. A standard worker may assist when enough nearby allies are already committed.

### 5.1 Local Alarm Cascade

When an ant detects or is attacked by a threat:

1. It evaluates whether to defend, retreat, or flee using caste, health, bravery, threat size, and nearby ally strength.
2. It enters an alert state and releases an alarm pheromone pulse.
3. Ants inside direct awareness range react immediately.
4. Those ants may emit their own weaker alarm pulse, extending the signal outward without instantly informing the entire map.
5. Responders travel toward the last known threat position, reevaluate upon arrival, and stop responding when the signal expires or the danger is gone.

This creates a believable spreading response instead of magical global awareness.

### 5.2 Cooperative Combat Intent

Ants do not all attack every threat blindly.

- Minors favor warning, harassment, rescue, or escape.
- Standard workers defend when local allied strength is sufficient.
- Majors and super majors receive stronger defense and intercept weights.
- Injured ants retreat unless protecting the nest or queen.
- Nearby ants can assist an attacked ally.
- Ants avoid overcrowding one target by reserving approach positions around it.
- The group disengages when the threat leaves, dies, or becomes overwhelmingly dangerous.

The starter may use a simple placeholder hostile insect and contact-based damage. The architecture must allow later attack animations, hit reactions, venom, grappling, dismemberment, and species-specific tactics without replacing the decision system.

### 5.3 Pheromone Fields

Pheromones are world signals, not permanent paths.

The starter supports:

- Food pheromone
- Alarm pheromone
- Home pheromone

Each signal has:

- Position
- Type
- Strength
- Radius
- Creation time
- Decay rate
- Optional source ant or source target

Ants sample nearby signals at controlled intervals. They may follow a useful gradient, reinforce a successful trail, ignore a weak or stale signal, or abandon it when firsthand information becomes more urgent.

## 6. Hybrid Play Direction

The selected long-term play model is Hybrid.

### Colony Mode

The player observes and manages the colony. Ants choose tasks automatically using colony priorities and local conditions.

### Scout Mode

In a later milestone, the player may temporarily possess one scout ant for direct exploration, discovery, and interaction.

### Starter Constraint

Direct scout control will not be required in the first implementation. The starter will include the architectural seams needed to add it later without replacing the automatic AI system.

## 7. Technical Architecture

The project will use:

- TypeScript
- Phaser 3
- Vite
- Vitest
- GitHub Actions
- GitHub Pages deployment

Planned structure:

```text
src/
  main.ts
  game/
    config.ts
    constants.ts
    GameState.ts
  scenes/
    BootScene.ts
    MainMenuScene.ts
    SurfaceScene.ts
    UIScene.ts
  entities/
    Ant.ts
    Threat.ts
    FoodSource.ts
    NestEntrance.ts
  simulation/
    AntMind.ts
    AntMemory.ts
    DecisionContext.ts
    BehaviorState.ts
  systems/
    AntAISystem.ts
    PerceptionSystem.ts
    PheromoneSystem.ts
    ThreatSystem.ts
    ColonySystem.ts
    DepthSystem.ts
    DayNightSystem.ts
    SaveSystem.ts
  data/
    antCastes.ts
    behaviorWeights.ts
    resources.ts
  world/
    SurfaceWorld.ts
    WorldGenerator.ts
    SpatialHash.ts
  ui/
    Hud.ts
```

Responsibilities will remain separated:

- Scenes coordinate gameplay states and presentation.
- Entities represent individual world objects.
- Each Ant owns an AntMind and AntMemory.
- PerceptionSystem gathers only nearby observations.
- AntAISystem evaluates individual decisions at staggered intervals.
- PheromoneSystem stores, decays, and samples local signals.
- ThreatSystem controls hostile insect behavior and damage resolution.
- Systems update behavior shared by many entities.
- Data files define castes, behavior weights, resources, and balance values.
- GameState owns persistent colony data.

## 8. Data Flow

1. The player starts a new colony from the main menu.
2. GameState creates initial colony values and a mixed worker population.
3. SurfaceScene creates the world and visible entities.
4. PerceptionSystem gathers nearby food, ants, threats, nest data, and pheromone samples for each ant.
5. Each AntMind evaluates its own context on a staggered decision interval.
6. Ants move and act according to their selected behavior state.
7. Successful foragers deposit food and reinforce food pheromones.
8. Threatened ants create alarm signals and nearby ants independently decide whether to respond.
9. ColonySystem updates shared food, health, population, and alert values.
10. UIScene reads GameState and refreshes the HUD.
11. SaveSystem stores supported state locally once saving is enabled.

## 9. Performance Strategy

The starter will be designed for dozens of visible ants, while preserving a path toward much larger colonies.

Initial performance rules:

- Reuse generated textures
- Avoid one physics body per decorative object where unnecessary
- Update decisions at staggered controlled intervals rather than every frame
- Keep movement steering separate from decision-making
- Use a spatial hash for nearby ant, food, threat, and pheromone queries
- Limit local memory size and expire stale observations
- Decay and merge nearby pheromone markers to prevent unlimited growth
- Use simple steering before expensive pathfinding
- Keep environmental decoration separate from simulation logic
- Reserve distant-ant statistical simulation for a later milestone

## 10. Error Handling

The game will fail gracefully when optional features are unavailable.

- Missing saves leave Continue disabled.
- Corrupt local save data falls back to a new colony and logs a clear warning.
- Missing optional audio or texture assets do not prevent startup.
- Scene transitions validate required state before continuing.
- Invalid or missing AI targets return an ant to reevaluation rather than freezing it.
- Expired pheromones and destroyed threats are removed safely from ant memories.
- GitHub Actions will fail clearly when tests, build, or type checking fails.

## 11. Testing Strategy

The starter will include:

- TypeScript type checking
- Vitest unit tests for pure simulation logic
- Production build verification
- Manual smoke checks for menu navigation, mobile layout, camera controls, food collection, alarm response, and GitHub Pages routing

Important behaviors to verify:

- Each caste receives the correct scale and statistics.
- Larger ants visibly differ from smaller ants.
- Every ant has independent memory, target, and behavior state.
- Ants can find food, collect it, and deposit it.
- Food totals increase only when an ant reaches the nest.
- A threatened ant can emit an alarm pheromone.
- Only ants within local awareness or pheromone range initially respond.
- Alarm propagation spreads locally and expires rather than alerting the entire map permanently.
- Caste and health influence defend, assist, retreat, and flee choices.
- Main menu buttons enter the intended scenes.
- The game loads correctly from the repository subpath on GitHub Pages.

## 12. GitHub Deployment

A GitHub Actions workflow will:

1. Install dependencies.
2. Run unit tests.
3. Run type checking.
4. Build the Vite project.
5. Upload the generated `dist` artifact.
6. Deploy the artifact to GitHub Pages.

The Vite base path will be configured for `/Thronemound-Colony-Sim/` so assets resolve correctly from the project site.

## 13. Explicitly Deferred Features

The following are intentionally deferred until the starter is stable:

- Underground chamber construction
- Eggs, larvae, and pupae simulation
- Direct scout possession
- Advanced combat animation and species-specific attacks
- Weather hazards
- Rival colonies
- Genetics and queen traits
- Multiple playable ant species
- Statistical simulation of thousands of distant ants
- Full save-slot interface
- External artwork and sound packs

## 14. Starter Success Criteria

The milestone is successful when:

- The repository builds without errors.
- GitHub Actions deploys a playable GitHub Pages build.
- The main menu looks intentional and works on mobile and desktop.
- Starting a colony opens a large camera-controlled surface world.
- Multiple visibly different ant castes move around the nest.
- Every ant evaluates its own local information and maintains its own behavior state.
- Worker ants discover food, carry it home, and increase colony storage.
- A nearby threat causes a local alarm cascade and caste-appropriate cooperative response.
- Food and alarm pheromones appear, decay, and influence nearby ant decisions.
- The architecture is organized enough to add underground nests, richer combat, and direct scout control without restructuring the entire project.
