#!/usr/bin/env python3
"""One-shot placeholder icon generator for Feed Blur.

Writes icons/icon16.png, icon48.png and icon128.png using only the Python
standard library (no PIL, no ImageMagick, no network). Not part of the
extension runtime — run once from the repo root:

    python3 tools/make_icons.py
"""
import os
import struct
import zlib


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(size, path):
    # Solid indigo square with a translucent white horizontal band across the
    # middle — a crude "frosted glass" hint. Placeholder quality on purpose.
    base = (74, 95, 193)  # #4a5fc1
    band_top, band_bot = size * 2 // 5, size * 3 // 5
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")  # PNG filter type 0 (None) per scanline
        for _x in range(size):
            r, g, b = base
            if band_top <= y < band_bot:
                r = int(r * 0.6 + 255 * 0.4)
                g = int(g * 0.6 + 255 * 0.4)
                b = int(b * 0.6 + 255 * 0.4)
            row += bytes((r, g, b, 255))
        rows.append(bytes(row))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
    os.makedirs(out, exist_ok=True)
    for s in (16, 48, 128):
        make_png(s, os.path.join(out, f"icon{s}.png"))
