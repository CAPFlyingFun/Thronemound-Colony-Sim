# Source art

Original, full-resolution texture sets as they came out of the tools that
made them. Nothing in here ships: the game loads from `public/`, and a set
graduates there by being converted to JPG and registered in whatever list
owns its surface type. Keeping the originals here means a re-export or a
retune never depends on a phone still having the file.

## How big should a shipped texture be

Not a fixed number. What decides it is TEXELS PER MILLIMETRE OF GROUND,
which is the resolution divided by how many millimetres one tile covers —
and that second number is different for every surface.

The ground's tile scales live in `src/world/islandBiome.ts`: sand 4.5 mm,
grass 5.5 mm, jungle 6.5 mm, rock 9 mm, mountain 11 mm. Rock's nine
millimetres is the queen's whole body length. At the 512 the biome set
currently ships that is 57 texels per millimetre, and the ground within a
few millimetres of her head — which is most of a first-person frame — comes
out MAGNIFIED, one texel stretched across more than one pixel. That is why
the ground reads soft up close, and no amount of filtering fixes a texture
that has run out of texels.

So ground wants more than bark, not less, and the player's instinct to
export at 1536 was right: 171 texels per millimetre over a 9 mm tile, which
is properly sampled in the near field instead of magnified. The cost, base
colour at quality 82: 79 KB at 512, 288 KB at 1024, 563 KB at 1536.

Bark is a different sum and keeps its own note in
`public/tree-tex/README.md` — a trunk tile covers far more surface per
texel, so 1024 genuinely is plenty there.

The other half of sharpness is anisotropy, and it is free: everything the
ant stands on is seen at a grazing angle, so the biome textures now take
the renderer's own ceiling (16) rather than the 4 they were pinned at.
Anisotropy rescues the DISTANCE; resolution rescues the near field. They
fix different halves of the same picture and neither substitutes for the
other.

## rocky-ground-1

Rocky dirt ground set, player-made with `tools/local-texture-lab.html`
(ChatGPT-built, runs entirely offline in the browser). Five maps at
1536 × 1536, square, seamless-blended edges:

- `IMG_2872_BaseColor.png`
- `IMG_2872_Height.png`
- `IMG_2872_Normal_OpenGL.png` — GL convention, which is what three.js
  reads; no green-channel flip needed.
- `IMG_2872_Roughness.png`
- `IMG_2872_AO.png`

Deliberately 1536 rather than 1024 — see the sum above; this is a surface
seen from a few millimetres away by something nine millimetres long.

Checked at full size, corners included: no watermarks. Intended for the
island's ground/rock biome once the ground material grows the same
normal/roughness support the trees got in v0.0.52 — the biome shader is a
six-way elevation/slope splat and today samples colour only.
