# Density Terrain Lab Design

## Purpose

Create an isolated map that proves whether signed-density terrain is a better foundation for Thronemound than the current combination of voxel columns, partial surface cells, smoothing sheets, gap bands, and detached clod sizing.

The experiment must not replace or modify the production terrain path. It is selected explicitly with `?map=densityterrainlab` and may also be opened with `?scene=density`.

## Terrain representation

The lab stores a scalar density at regular grid samples. Positive values mean packed soil, negative values mean air, and the visible surface is the zero crossing. The initial soil body is surrounded by air on every side so its generated mesh can be verified as closed.

One world unit remains five millimetres. The first experiment uses half-unit density cells, giving a 2.5 mm sampling interval while preserving a five-millimetre spherical digging brush.

## Meshing

A surface-nets mesher places one representative vertex in every mixed-sign cell and emits quads around sign-changing grid edges. The resulting terrain is one continuous mesh rather than a voxel surface plus a second smoothing sheet.

The first laboratory rebuilds the complete small field after every scoop. Chunk-local remeshing is intentionally postponed until the visual and gameplay concept is proven.

## Digging and soil accounting

The center crosshair raycasts against the generated terrain. A press places a five-millimetre-radius signed-distance brush slightly inside the struck surface and subtracts it from the density field.

The same subtraction estimates removed volume from occupancy change around the zero crossing. That volume scales one eight-sided loose dirt pellet. Terrain removal and pellet size therefore originate from the same operation rather than from separate visual and voxel measurements.

## Test interface

The lab provides orbit, zoom, a center crosshair, a large mobile DIG button, keyboard Space for digging, and RESET. A readout reports removed volume and full-mesh rebuild time.

This is a terrain laboratory, not the final controller integration. Its purpose is to answer four questions before production migration:

1. Do curved hills and scoops remain visibly closed?
2. Does repeated digging create smooth excavations without sheet or band gaps?
3. Does the spawned pellet remain proportional to the removed material?
4. Is remeshing fast enough on the target phone to justify chunking the approach?

## Acceptance criteria

- The default game and existing `scene=queen` and `scene=hex` routes remain unchanged.
- `?map=densityterrainlab` opens only the new laboratory.
- A five-millimetre scoop modifies the terrain and spawns one eight-sided pellet.
- Closed terrain remains free of boundary edges before and after a surface scoop in unit tests.
- Core density and meshing code has no Three.js dependency.
