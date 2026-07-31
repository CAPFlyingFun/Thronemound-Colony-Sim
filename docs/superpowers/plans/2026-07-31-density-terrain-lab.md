# Density Terrain Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated signed-density terrain map with a five-millimetre subtraction brush and volume-matched loose dirt pellet.

**Architecture:** Pure TypeScript density and surface-net modules own terrain data and mesh arrays. A lazily loaded Three.js scene renders the mesh, performs crosshair raycasts, invokes the brush, and visualizes the resulting pellet. The production voxel map is not imported or changed.

**Tech Stack:** TypeScript 5.8, Three.js 0.180, Vite 7, Vitest 3.2.

## Global Constraints

- One world unit equals five millimetres.
- Dig brush radius is one world unit, or five millimetres.
- The prototype is opened with `?map=densityterrainlab`.
- `main` and the default DigScene behavior remain untouched by routing unless the explicit lab query is present.
- Core density and meshing modules must not import Three.js.

---

### Task 1: Scalar density field and subtraction brush

**Files:**
- Create: `src/density/DensityField.ts`
- Test: `tests/densityTerrain.test.ts`

**Interfaces:**
- Produces: `DensityField`, `DensityField.fill`, `DensityField.fillFromHeight`, `DensityField.sample`, and `DensityField.subtractSphere(center, radius)`.
- `subtractSphere` returns `BrushResult` with `removedVolume`, `changedSamples`, and changed sample bounds.

- [x] Write tests for density sign, local subtraction, untouched samples, and positive removed volume.
- [x] Verify the tests fail before the module exists.
- [x] Implement the scalar field and signed-distance sphere subtraction.
- [x] Run the core test harness and verify the brush tests pass.

### Task 2: Watertight surface-net mesher

**Files:**
- Create: `src/density/SurfaceNets.ts`
- Modify: `tests/densityTerrain.test.ts`

**Interfaces:**
- Consumes: `DensityField`.
- Produces: `buildSurfaceNets(field, isoLevel?)` returning typed position and index arrays.

- [x] Add tests that count mesh boundary edges before and after a surface scoop.
- [x] Verify the tests fail before the mesher exists.
- [x] Implement mixed-cell vertices and quads around sign-changing grid edges.
- [x] Run the core test harness and verify closed meshes have zero boundary edges.

### Task 3: Interactive Three.js laboratory

**Files:**
- Create: `src/scenes/DensityTerrainLabScene.ts`
- Create: `src/scenes/DensityTerrainLabScene.css`

**Interfaces:**
- Consumes: `DensityField` and `buildSurfaceNets`.
- Produces: `DensityTerrainLabScene(host: HTMLElement)` and `dispose()`.

- [x] Build a closed soil mound in a small half-unit density field.
- [x] Render the generated mesh with terrain lighting and orbit controls.
- [x] Raycast from the center crosshair and subtract a one-unit brush.
- [x] Rebuild the terrain and spawn an eight-sided pellet scaled from removed volume.
- [x] Add mobile DIG and RESET controls plus a remesh-time readout.
- [x] Type-check the isolated scene against strict TypeScript stubs.

### Task 4: Isolated route

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: URL query parameters.
- Produces: lazy route for `?map=densityterrainlab`, `?scene=density`, and the legacy-shaped `?=densityterrainlab` form.

- [x] Parse route parameters once.
- [x] Load the density lab before the existing queen, hex, and default branches.
- [x] Keep all existing routes unchanged when the density lab flag is absent.

### Task 5: Branch verification

**Files:**
- Verify all files above.

- [ ] Run repository `npm test`.
- [ ] Run repository `npm run typecheck`.
- [ ] Run repository `npm run build`.
- [ ] Open the branch deployment at `?map=densityterrainlab` and test on iPhone.
