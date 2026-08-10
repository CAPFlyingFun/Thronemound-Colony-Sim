# Bark

One of these is picked per tree, by a seed taken from where the tree stands —
so a given tree wears the same bark on every load.

## Adding one

1. Drop a square JPEG in here, around **1024×1024**.
2. Add its name (without `.jpg`) to `BARKS` in `src/world/tree.ts`.

Nothing else changes. The mesh derives its tiling from the trunk's own
girth, so the image does not need to know how big the tree is.

## Depth maps (optional)

A bark may ship `<name>_normal.jpg` and `<name>_rough.jpg` beside the colour.
List it in `PBR_BARKS` in `src/world/tree.ts` as well as `BARKS`; a test checks
the two agree.

Two rules come with them, and both are forced rather than chosen:

- **Use the OpenGL normal map, not DirectX.** Library sets ship both. Three.js
  reads the GL convention; the DX one has its green channel inverted, which
  lights every ridge as a groove.
- **It has to tile on its own edges.** The flat photographs are mirrored, and a
  mirrored tile runs its U backwards — a tangent-space normal read backwards
  has its X inverted, so alternate tiles would light back to front. A bark with
  a normal map is therefore wrapped with plain repeat, and has to earn it.

Non-square is fine: the V repeat is scaled by the image's own aspect, so a
512x1024 tile keeps square texels instead of a squashed grain.

Displacement maps are ignored. They need a trunk tessellated far past what
this one is, and at this scale the normal map is doing that work already.

## What makes a good one

- **Square.** It is wrapped several times round the trunk, so a portrait
  photograph gets centre-cropped and the rest is wasted.
- **It does not need to tile.** Both wraps are mirrored, so every join is
  continuous whatever the edges do. (Healing a non-tiling image by blending
  its edges together was tried and is worse — it trades a hard seam for a
  blurred stripe down the middle of every tile.)
- **It does not need depth maps either.** `scripts/makePbr.py` derives a
  normal and a roughness from the colour, in GL convention and wrapping, so
  a new bark gets relief without anyone painting one:
  `python3 scripts/makePbr.py public/tree-tex --only <name>`. Add the name
  to `PBR_BARKS`; add it to `TILING_BARKS` only if its edges genuinely meet.
- **Evenly lit.** A photograph with the sun down one side tiles into stripes.
- **1024 is plenty.** The tiling puts about half a millimetre of trunk on a
  texel already; a larger image mostly costs download.

## What to avoid

Two barks — `bark-oak` and `bark-pale` — were removed from this folder for
carrying a stock seller's watermark: tiled across the image at low opacity,
invisible in a thumbnail and perfectly legible on a trunk an ant is standing
on. Check any candidate at full size before adding it, including the corners,
where the marks usually sit.

The *names* are free. It was the images that were the problem, and they are
gone; new art of our own may take either name without ceremony.
