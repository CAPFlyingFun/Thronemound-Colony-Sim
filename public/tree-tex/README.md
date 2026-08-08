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
- **Seamless left-to-right.** The wrap closes on itself horizontally, so a
  mismatched edge draws a hard line the full height of the tree. Top and
  bottom do *not* need to match — that wrap is mirrored, which hides it.
- **Evenly lit.** A photograph with the sun down one side tiles into stripes.
- **1024 is plenty.** The tiling puts about half a millimetre of trunk on a
  texel already; a larger image mostly costs download.

## What to avoid

Two barks were removed from this folder for carrying a stock seller's
watermark — tiled across the image at low opacity, invisible in a thumbnail
and perfectly legible on a trunk an ant is standing on. Check any candidate
at full size before adding it, including the corners, where the marks
usually sit.
