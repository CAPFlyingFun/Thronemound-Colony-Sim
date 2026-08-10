# Source art

Original, full-resolution texture sets as they came out of the tools that
made them. Nothing in here ships: the game loads from `public/`, and a set
graduates there by being downscaled (1024 is plenty — see
`public/tree-tex/README.md`), converted to JPG, and registered in whatever
list owns its surface type. Keeping the originals here means a re-export or
a retune never depends on a phone still having the file.

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

Checked at full size, corners included: no watermarks. Intended for the
island's ground/rock biome once the ground material grows the same
normal/roughness support the trees got in v0.0.52.
