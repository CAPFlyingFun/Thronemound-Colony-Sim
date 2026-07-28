# Thronemound Colony Sim Starter Design

Date: 2026-07-27
Status: Approved for specification review

## 1. Project Goal

Create a browser-playable, mobile-friendly 2.5D ant colony simulator using TypeScript, Phaser 3, and Vite. The first release will establish a polished main menu, a scalable project architecture, a living top-down surface scene, and the first automatic colony simulation loop.

The long-term game will combine colony management with optional direct control of a scout ant. The initial implementation will prioritize automatic colony behavior, then reserve direct scout possession for the next milestone.

## 2. Core Experience

The player manages a living ant colony in a large miniature ecosystem. Ants act independently according to colony needs, while the player influences priorities, expansion, and survival.

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
- A small worker population
- Food storage
- Colony health
- Population count
- A simple time-of-day value

Worker ants will initially be able to:

- Wander near the nest
- Search for food
- Detect nearby food
- Travel to food
- Collect one load
- Return to the nest
- Deposit food into colony storage
- Resume searching

### 3.4 HUD

The top HUD will display:

- Population
- Stored food
- Colony health
- Time of day

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
- Preferred task weights

The starter milestone may spawn minors, standard workers, and majors, while the super-major class can remain uncommon or gated. The architecture must support all four immediately.

## 5. Hybrid Play Direction

The selected long-term play model is Hybrid.

### Colony Mode

The player observes and manages the colony. Ants choose tasks automatically using colony priorities and local conditions.

### Scout Mode

In a later milestone, the player may temporarily possess one scout ant for direct exploration, discovery, and interaction.

### Starter Constraint

Direct scout control will not be required in the first implementation. The starter will include the architectural seams needed to add it later without replacing the automatic AI system.

## 6. Technical Architecture

The project will use:

- TypeScript
- Phaser 3
- Vite
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
    FoodSource.ts
    NestEntrance.ts
  systems/
    AntAISystem.ts
    ColonySystem.ts
    DepthSystem.ts
    DayNightSystem.ts
    SaveSystem.ts
  data/
    antCastes.ts
    resources.ts
  world/
    SurfaceWorld.ts
    WorldGenerator.ts
  ui/
    Hud.ts
```

Responsibilities will remain separated:

- Scenes coordinate gameplay states and presentation.
- Entities represent individual world objects.
- Systems update behavior shared by many entities.
- Data files define castes, resources, and balance values.
- GameState owns persistent colony data.

## 7. Data Flow

1. The player starts a new colony from the main menu.
2. GameState creates initial colony values and a mixed worker population.
3. SurfaceScene creates the world and visible entities.
4. AntAISystem assigns and updates worker states.
5. Ants collect food and report deposits to ColonySystem.
6. ColonySystem updates shared food and health values.
7. UIScene reads GameState and refreshes the HUD.
8. SaveSystem stores supported state locally once saving is enabled.

## 8. Performance Strategy

The starter will be designed for dozens of visible ants, while preserving a path toward much larger colonies.

Initial performance rules:

- Reuse generated textures
- Avoid one physics body per decorative object where unnecessary
- Update AI at controlled intervals rather than every frame
- Use simple steering before expensive pathfinding
- Keep environmental decoration separate from simulation logic
- Reserve distant-ant statistical simulation for a later milestone

## 9. Error Handling

The game will fail gracefully when optional features are unavailable.

- Missing saves leave Continue disabled.
- Corrupt local save data falls back to a new colony and logs a clear warning.
- Missing optional audio or texture assets do not prevent startup.
- Scene transitions validate required state before continuing.
- GitHub Actions will fail clearly when build or type checking fails.

## 10. Testing Strategy

The starter will include:

- TypeScript type checking
- Production build verification
- Unit-test-ready pure data and colony logic
- Manual smoke checks for menu navigation, mobile layout, camera controls, ant food collection, and GitHub Pages routing

Important behaviors to verify:

- Each caste receives the correct scale and statistics.
- Larger ants visibly differ from smaller ants.
- Ants can find food, collect it, and deposit it.
- Food totals increase only when an ant reaches the nest.
- Main menu buttons enter the intended scenes.
- The game loads correctly from the repository subpath on GitHub Pages.

## 11. GitHub Deployment

A GitHub Actions workflow will:

1. Install dependencies.
2. Run type checking.
3. Build the Vite project.
4. Upload the generated `dist` artifact.
5. Deploy the artifact to GitHub Pages.

The Vite base path will be configured for `/Thronemound-Colony-Sim/` so assets resolve correctly from the project site.

## 12. Explicitly Deferred Features

The following are intentionally deferred until the starter is stable:

- Underground chamber construction
- Eggs, larvae, and pupae simulation
- Direct scout possession
- Combat and predators
- Pheromone trails
- Weather hazards
- Rival colonies
- Genetics and queen traits
- Multiple ant species
- Statistical simulation of thousands of distant ants
- Full save-slot interface
- External artwork and sound packs

## 13. Starter Success Criteria

The milestone is successful when:

- The repository builds without errors.
- GitHub Actions deploys a playable GitHub Pages build.
- The main menu looks intentional and works on mobile and desktop.
- Starting a colony opens a large camera-controlled surface world.
- Multiple visibly different ant castes move around the nest.
- Worker ants discover food, carry it home, and increase colony storage.
- The architecture is organized enough to add underground nests and direct scout control without restructuring the entire project.
