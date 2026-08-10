#!/usr/bin/env python3
"""
COLOUR IN, DEPTH OUT — the Local Texture Lab's convert step, in batch.

`tools/local-texture-lab.html` turns one image into a PBR set in the
browser, which is the right shape for making art on a phone and the wrong
shape for the twelve textures already in this repo. This is the same maths
with the same defaults, run over a folder, so an existing library can be
given depth without re-uploading any of it.

Faithful to the lab in the parts that matter:

  * HEIGHT is luminance, split into a broad form and the fine detail on top
    of it, recombined with the lab's own weights, contrast-stretched about
    the middle, then levelled between the low and high knobs. Deriving it
    from brightness is an approximation — a white pebble is not a tall one —
    but on bark and soil, where light means facing up and dark means a
    crevice, it is a good one.

  * NORMAL is the central difference of that height with the lab's 2.2
    gain, written in GL convention (+Y up), which is what three.js reads.
    A DirectX map here would light every ridge as a trench.

  * ROUGHNESS is the average knob biased by height: high ground a little
    rougher than the hollows.

Everything wraps. The blurs, the differences and the AO all sample with
modular arithmetic rather than clamping at the border, so a texture that
already tiles still tiles afterwards and a normal map never carries a seam
its colour map does not have.

    python3 scripts/makePbr.py public/tree-tex --only bark-grey bark-mossy
    python3 scripts/makePbr.py public/kauai-tex --size 1024 --ao
"""
from __future__ import annotations

import argparse
import pathlib
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:  # pragma: no cover - a developer's first run
    sys.exit('needs numpy and pillow:  pip install numpy pillow')


# The lab's defaults, by the names its sliders use.
LARGE_FORM = 0.62
FINE_DETAIL = 0.35
HEIGHT_CONTRAST = 1.25
LEVEL_LOW = 0.04
LEVEL_HIGH = 0.96
NORMAL_STRENGTH = 1.25
ROUGH_AVERAGE = 0.78
ROUGH_VARIATION = 0.22
AO_STRENGTH = 0.55
AO_RADIUS = 4


def box_blur_wrap(a: np.ndarray, radius: int) -> np.ndarray:
    """Separable box blur that WRAPS, so the result tiles like its input."""
    if radius <= 0:
        return a.copy()
    k = radius * 2 + 1
    out = a
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for shift in range(-radius, radius + 1):
            acc += np.roll(out, shift, axis=axis)
        out = acc / k
    return out


def luminance(img: Image.Image) -> np.ndarray:
    rgb = np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def height_from(lum: np.ndarray) -> np.ndarray:
    """The lab's `generateFromImage`, wrapped and vectorised."""
    radius = max(2, round(lum.shape[1] / 128))
    broad = box_blur_wrap(lum, radius)
    fine = lum - broad
    h = lum * (1 - LARGE_FORM * 0.72) + broad * (LARGE_FORM * 0.72)
    h = h + fine * FINE_DETAIL * 1.3
    h = (h - 0.5) * HEIGHT_CONTRAST + 0.5
    h = np.clip(h, 0.0, 1.0)
    return np.clip((h - LEVEL_LOW) / (LEVEL_HIGH - LEVEL_LOW), 0.0, 1.0)


def normal_from(height: np.ndarray, strength: float) -> np.ndarray:
    """
    GL convention: +Y is up the image. three.js reads GL; a DirectX map
    inverts green and lights every ridge as the groove beside it.
    """
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * strength * 2.2
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * strength * 2.2
    nx, ny, nz = -dx, -dy, np.ones_like(height)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx * inv * 0.5 + 0.5,
                     ny * inv * 0.5 + 0.5,
                     nz * inv * 0.5 + 0.5], axis=-1)


def rough_from(height: np.ndarray) -> np.ndarray:
    return np.clip(ROUGH_AVERAGE + (height - 0.5) * ROUGH_VARIATION * 0.55, 0.0, 1.0)


def ao_from(height: np.ndarray) -> np.ndarray:
    """Cavity: how far below its own neighbourhood a point sits."""
    cavity = np.maximum(0.0, box_blur_wrap(height, AO_RADIUS) - height)
    return np.clip(1.0 - cavity * AO_STRENGTH * 5.5, 0.0, 1.0)


def gray_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8), mode='L')


def rgb_image(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8), mode='RGB')


def convert(path: pathlib.Path, size: int | None, quality: int,
            want_ao: bool, want_height: bool, strength: float) -> list[str]:
    img = Image.open(path)
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    height = height_from(luminance(img))
    stem = path.with_suffix('')
    written = []

    def save(image: Image.Image, suffix: str) -> None:
        out = stem.with_name(f'{stem.name}{suffix}.jpg')
        image.save(out, quality=quality, optimize=True)
        written.append(f'{out.name} ({out.stat().st_size // 1024} KB)')

    save(rgb_image(normal_from(height, strength)), '_normal')
    save(gray_image(rough_from(height)), '_rough')
    if want_ao:
        save(gray_image(ao_from(height)), '_ao')
    if want_height:
        save(gray_image(height), '_height')
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder', type=pathlib.Path)
    ap.add_argument('--only', nargs='*', default=None,
                    help='stems to convert; default is every image without a map suffix')
    ap.add_argument('--size', type=int, default=None, help='resize square before deriving')
    ap.add_argument('--quality', type=int, default=88)
    ap.add_argument('--strength', type=float, default=NORMAL_STRENGTH)
    ap.add_argument('--ao', action='store_true', help='also write _ao')
    ap.add_argument('--height', action='store_true', help='also write _height')
    args = ap.parse_args()

    suffixes = ('_normal', '_rough', '_ao', '_height')
    sources = sorted(
        p for p in args.folder.iterdir()
        if p.suffix.lower() in {'.jpg', '.jpeg', '.png'}
        and not p.stem.endswith(suffixes)
        and (args.only is None or p.stem in args.only)
    )
    if not sources:
        sys.exit(f'nothing to convert in {args.folder}')

    for src in sources:
        made = convert(src, args.size, args.quality, args.ao, args.height, args.strength)
        print(f'{src.name:28} -> {", ".join(made)}')


if __name__ == '__main__':
    main()
