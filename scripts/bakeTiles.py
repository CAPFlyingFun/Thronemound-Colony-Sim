#!/usr/bin/env python3
"""Bake the photographic soil tiles from one seamless soil photograph.

One source photo, three materials. The photo carries the STRUCTURE — grain,
clods, pores — and each material recipe in tileTextures.ts carries the COLOUR.
Baking means: normalise the photo's mean colour to the recipe base so the
lighting balance the procedural tiles established survives the swap, then
derive normal and roughness maps from the same luminance field so relief and
shading agree, exactly as the procedural generator does.

Stone is NOT baked: rock is not soil, and recolouring dirt grey reads as dirty
concrete. The runtime keeps stone procedural.

Output: antgame/public/tiles/{topsoil,clay,sand}_{albedo,normal,rough}.png
at 512 px — the "real tiles are 512" target tileTextures.ts documents.

Usage: python3 scripts/bakeTiles.py <photo> [outdir]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 512

# The photo IS the colour now. The first bake normalised the photo's mean to
# the procedural recipe bases, and those were authored as bright placeholder
# dirt — the ground came out far lighter than the soil that was photographed.
# So topsoil keeps the photo's own tone untouched, and clay/sand are small
# multiplicative tints of it: what you dig looks like what you photographed.
RECIPES = {
    'topsoil': {'tint': (1.00, 1.00, 1.00), 'rough': 0.95},
    'clay': {'tint': (1.12, 0.94, 0.90), 'rough': 0.72},
    'sand': {'tint': (1.18, 1.10, 0.92), 'rough': 0.99},
}


def wrap_blur(a: np.ndarray, passes: int = 2) -> np.ndarray:
    """3x3 box blur with wrapped edges, so the derived maps stay seamless."""
    for _ in range(passes):
        acc = np.zeros_like(a)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += np.roll(np.roll(a, dy, axis=0), dx, axis=1)
        a = acc / 9.0
    return a


def main() -> None:
    photo_path = Path(sys.argv[1])
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('public/tiles')
    outdir.mkdir(parents=True, exist_ok=True)

    img = Image.open(photo_path).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
    rgb = np.asarray(img, dtype=np.float64)

    # Luminance is the shared field every derived map reads. The photo is lit
    # from above, so bright = raised is roughly true, which is all a soil
    # normal map needs to sell relief.
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    lum = (lum - lum.min()) / max(1e-9, lum.max() - lum.min())

    # Height: lightly blurred so the normal reads as clods, not sensor noise.
    height = wrap_blur(lum.copy(), passes=2)

    # Normal from central differences with wrapped sampling. 512 px resolves
    # 4x finer gradients than the 128 px procedural tiles, so the strength is
    # scaled up to keep the same physical relief (2.2 * 4 ≈ 9, backed off a
    # touch because photographic luminance has more mid-frequency energy).
    scale = 7.0
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * scale
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * scale
    nx, ny, nz = -dx, -dy, np.ones_like(dx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([
        (nx / length * 0.5 + 0.5) * 255,
        (ny / length * 0.5 + 0.5) * 255,
        (nz / length * 0.5 + 0.5) * 255,
    ], axis=-1)

    mean = rgb.reshape(-1, 3).mean(axis=0)
    for name, recipe in RECIPES.items():
        tint = np.array(recipe['tint'], dtype=np.float64)
        # Multiplicative tint of the photo itself, so shadows stay shadows
        # and the overall tone stays the photograph's, not a recipe's.
        albedo = np.clip(rgb * tint, 0, 255)
        Image.fromarray(albedo.astype(np.uint8), 'RGB').save(outdir / f'{name}_albedo.png')
        Image.fromarray(normal.astype(np.uint8), 'RGB').save(outdir / f'{name}_normal.png')
        # Raised grains catch a little more light; recesses stay matte — the
        # same 0.08 swing the procedural roughness uses.
        rough = np.clip((recipe['rough'] - height * 0.08) * 255, 0, 255)
        Image.fromarray(rough.astype(np.uint8), 'L').save(outdir / f'{name}_rough.png')

    # Seam self-check: opposite edges of every derived field must already
    # match, or the photo was not as tileable as advertised.
    edge = float(np.abs(height[:, 0] - height[:, -1]).mean()
                 + np.abs(height[0, :] - height[-1, :]).mean())
    print(f'baked {SIZE}px tiles -> {outdir}  (edge mismatch {edge:.4f}, '
          f'photo mean {mean.round(1)})')


if __name__ == '__main__':
    main()
