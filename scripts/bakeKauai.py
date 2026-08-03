#!/usr/bin/env python3
"""Bake Beyond Extinction's Kauai into one height grid for the ant island.

Source: BE ships the island as an 8x8 chessboard of 513-square Terrarium RGB
height tiles (A1..H8; A1 north-west, columns west->east, rows north->south),
7 km per tile, baked from real USGS/Terrarium elevation. Tiles overlap by one
pixel, so the global grid is exactly 8*512+1 = 4097 samples square.

This bake decodes every tile (elev = r*256 + g + b/256 - 32768, nodata floored
at -6000 m), assembles the 4097-square global grid, downsamples it by STRIDING
(never by resampling: interpolating Terrarium R/G/B channels independently
corrupts heights across the 256-wraps, and striding keeps tile-edge samples
bit-exact) to 1025-square, and writes little-endian int16 DECIMETRES.

At the ant world's 1:1000 scale, one real metre is one in-world millimetre —
so the scene reads a sample, divides by ten, and has millimetres. 1025 samples
over 56,000 mm is one sample every 54.7 mm.

Usage:  python3 scripts/bakeKauai.py <BE-repo>/artifacts/beyond-extinction
Writes: public/kauai-1025.bin (~2.1 MB)
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE_PX = 513
COLS = "ABCDEFGH"
OUT = Path(__file__).resolve().parents[1] / "public" / "kauai-1025.bin"


def decode(path: Path) -> np.ndarray:
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    if rgb.shape[0] != TILE_PX or rgb.shape[1] != TILE_PX:
        raise SystemExit(f"{path} is {rgb.shape}, expected {TILE_PX} square")
    elev = rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
    return np.maximum(elev, -6000)


def main() -> None:
    base = Path(sys.argv[1]) / "public" / "assets" / "terrain" / "kauai" / "height"
    full = np.zeros((4097, 4097), dtype=np.float64)
    for row in range(8):  # row 0 = "1" = north
        for col in range(8):
            tile = decode(base / COLS[col] / f"{COLS[col]}{row + 1}.png")
            full[row * 512 : row * 512 + 513, col * 512 : col * 512 + 513] = tile
    small = full[::4, ::4]  # 4097 -> 1025, borders kept
    assert small.shape == (1025, 1025)
    dm = np.clip(np.round(small * 10), -32768, 32767).astype("<i2")
    OUT.write_bytes(dm.tobytes())
    centre = small[512, 512]
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    print(f"elevation min {small.min():.0f} m, max {small.max():.0f} m, "
          f"centre {centre:.0f} m, land {100 * (small > 0).mean():.0f}%")


if __name__ == "__main__":
    main()
