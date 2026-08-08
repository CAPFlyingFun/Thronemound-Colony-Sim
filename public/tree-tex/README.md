# Bark

One of these is picked per tree, by a seed taken from where the tree stands —
so a given tree wears the same bark on every load.

## Adding one

1. Drop a square JPEG in here, around **1024×1024**.
2. Add its name (without `.jpg`) to `BARKS` in `src/world/tree.ts`.

Nothing else changes. The mesh derives its tiling from the trunk's own
girth, so the image does not need to know how big the tree is.

## What makes a good one

- **Square.** It is wrapped several times round the trunk, so a portrait
  photograph gets centre-cropped and the rest is wasted.
- **It does not need to tile.** Both wraps are mirrored, so every join is
  continuous whatever the edges do. (Healing a non-tiling image by blending
  its edges together was tried and is worse — it trades a hard seam for a
  blurred stripe down the middle of every tile.)
- **Evenly lit.** A photograph with the sun down one side tiles into stripes.
- **1024 is plenty.** The tiling puts about half a millimetre of trunk on a
  texel already; a larger image mostly costs download.

## What to avoid

Two barks were removed from this folder for carrying a stock seller's
watermark — tiled across the image at low opacity, invisible in a thumbnail
and perfectly legible on a trunk an ant is standing on. Check any candidate
at full size before adding it, including the corners, where the marks
usually sit.
