# Micro Battle models

Joshua's, made in 2022 for Micro Battle and handed over for Thronemound.
Originals, exactly as they came out of the zip — nothing here has been
resized, recompressed or re-exported.

## Why this folder is not `public/`

Everything under `public/` is copied into the build and downloaded by every
player. These three JPEGs are **5 MB between them**, which is more than the
queen, worker and major GLBs put together. The originals live here so they
are never lost and can be re-derived from; the versions the game actually
loads belong in `public/models/`, converted and sized for a phone.

The `.obj` files are small and text, so those are in both places: the copy in
`public/models/` is what the game loads, and it is byte-identical.

## What each one is

| model | verts | faces | bounds | texture |
|---|---|---|---|---|
| `anthill.obj` | 37 | 37 | 0.38 x 0.14 x 0.38 | `anthill-soil.jpeg` |
| `blade-of-grass.obj` | 8 | 6 quads | 0.33 x 4.97 x 0.19 | `grass.jpeg` |
| `marker.obj` | 14 | 24 tris | 0.91 x 2.21 x 0.91 | `marker-white.jpeg` |

Model and texture were paired by their file timestamps, which match to within
two seconds in each case. The `.txt` files that came with them said only
"This model has been created with 3D Modeling App", so they are not kept.

**The anthill is not a cone.** Three rings: a 13-vertex base, a rim at
y=0.14, and a third ring at y=0.10 sitting *inside and below* the rim. That
is a crater with a mouth — a nest entrance, already modelled.

**The marker is a proper plumbob.** A twelve-sided ring with a LONG point
below (1.63) and a short one above (0.58). That asymmetry is what makes the
Sims shape read; a symmetric diamond does not.

**The marker's texture is blank white.** Not a mistake and not a missing
bake — it is a tint surface, so the plumbob takes its colour from the
material. It does not need to ship at all.

## Before any of this is used

- **The scales disagree**, with each other and with the game. The grass is
  4.97 units tall and the anthill 0.38 across. Each needs its own factor
  against `MM`, not one shared one.
- **No materials.** The OBJs carry UVs but no `mtllib` or `usemtl`, so what
  they are made of is ours to choose.
- **The grass texture is a LAWN**, not a single blade — a seamless photo of
  many blades. On one blade at its own UV scale it reads as green with fine
  variation, which is usable, but it is not a bake of this model.
- **The soil texture may be redundant.** The island already has its own
  ground material; this is a separate photographic dirt tile and the two
  should be compared before both ship.
