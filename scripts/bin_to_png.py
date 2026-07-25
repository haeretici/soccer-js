#!/usr/bin/env python3
"""
Convert soccer-js .bin sprite banks to 16-color indexed PNG (recursive).

.bin layout (little-endian):
  uint16 width, height, tile_count, palette_count
  palette_count * 3 RGB bytes
  zlib-compressed 4-bit packed pixels (high nibble = even pixel)

PNG output (sprite-manager compatible):
  - Mode P, exactly 16 palette slots
  - Slot 0 = transparent (tRNS)
  - Tiles laid out left→right in a horizontal strip
    (width=w*tile_count, height=h)
  - Metadata: TileWidth, TileHeight, TileCount, TileLayout=horizontal
    (for png_to_bin round-trip)

Output .png is written next to the source .bin.
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

PALETTE_SLOTS = 16


def unpack_nibbles(packed: bytes, pixel_count: int) -> bytearray:
    out = bytearray(pixel_count)
    for i in range(pixel_count):
        b = packed[i >> 1]
        out[i] = (b >> 4) if (i & 1) == 0 else (b & 0x0F)
    return out


def tiles_to_horizontal_strip(
    indices: bytearray | bytes, w: int, h: int, tile_count: int
) -> bytearray:
    """Pack per-tile row-major indices into a horizontal strip (left→right)."""
    strip_w = w * tile_count
    out = bytearray(strip_w * h)
    for t in range(tile_count):
        for y in range(h):
            src = t * (w * h) + y * w
            dst = y * strip_w + t * w
            out[dst : dst + w] = indices[src : src + w]
    return out


def read_bin(path: Path) -> tuple[int, int, int, list[tuple[int, int, int]], bytearray]:
    data = path.read_bytes()
    if len(data) < 8:
        raise ValueError(f"file too small: {path}")

    w, h, tile_count, palette_count = struct.unpack_from("<HHHH", data, 0)
    if w == 0 or h == 0 or tile_count == 0:
        raise ValueError(f"invalid dimensions in {path}: {w}x{h} tiles={tile_count}")
    if palette_count == 0 or palette_count > 256:
        raise ValueError(f"invalid palette_count={palette_count} in {path}")

    header_size = 8 + palette_count * 3
    if len(data) < header_size:
        raise ValueError(f"truncated header in {path}")

    palette: list[tuple[int, int, int]] = []
    for i in range(palette_count):
        o = 8 + i * 3
        palette.append((data[o], data[o + 1], data[o + 2]))

    # Pad / trim to 16 slots for the indexed PNG convention.
    while len(palette) < PALETTE_SLOTS:
        palette.append((0, 0, 0))
    palette = palette[:PALETTE_SLOTS]

    packed = zlib.decompress(data[header_size:])
    pixels_per_tile = w * h
    bytes_per_tile = (pixels_per_tile + 1) // 2
    expected = bytes_per_tile * tile_count
    if len(packed) < expected:
        raise ValueError(
            f"packed data short in {path}: got {len(packed)}, need {expected}"
        )

    indices = bytearray()
    for t in range(tile_count):
        off = t * bytes_per_tile
        indices.extend(unpack_nibbles(packed[off : off + bytes_per_tile], pixels_per_tile))

    return w, h, tile_count, palette, indices


def bin_to_png(bin_path: Path, force: bool = False) -> Path:
    out_path = bin_path.with_suffix(".png")
    if out_path.exists() and not force:
        raise FileExistsError(f"refusing to overwrite {out_path} (use --force)")

    w, h, tile_count, palette, indices = read_bin(bin_path)
    strip = tiles_to_horizontal_strip(indices, w, h, tile_count)

    # Flat RGB triples for 256 entries (Pillow expects full table for mode P).
    flat = []
    for r, g, b in palette:
        flat.extend((r, g, b))
    while len(flat) < 256 * 3:
        flat.extend((0, 0, 0))

    img = Image.frombytes("P", (w * tile_count, h), bytes(strip))
    img.putpalette(flat)

    meta = PngInfo()
    meta.add_text("TileWidth", str(w))
    meta.add_text("TileHeight", str(h))
    meta.add_text("TileCount", str(tile_count))
    meta.add_text("TileLayout", "horizontal")
    meta.add_text("SourceFormat", "soccer-js-bin")

    # Slot 0 is alpha / transparent.
    img.save(out_path, format="PNG", transparency=0, pnginfo=meta)
    return out_path


def collect_bins(root: Path) -> list[Path]:
    if root.is_file():
        if root.suffix.lower() != ".bin":
            raise ValueError(f"not a .bin file: {root}")
        return [root]
    if not root.is_dir():
        raise ValueError(f"path not found: {root}")
    return sorted(root.rglob("*.bin"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert .bin sprite banks to 16-color indexed PNG (recursive). "
            "Tiles are laid out left→right (sprite-manager compatible)."
        )
    )
    parser.add_argument(
        "path",
        type=Path,
        help="File or folder. Folders are scanned recursively for *.bin",
    )
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Overwrite existing .png files",
    )
    args = parser.parse_args(argv)

    try:
        bins = collect_bins(args.path.resolve())
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if not bins:
        print(f"no .bin files under {args.path}")
        return 0

    ok = 0
    failed = 0
    for bin_path in bins:
        try:
            out = bin_to_png(bin_path, force=args.force)
            print(f"OK  {bin_path} -> {out}")
            ok += 1
        except Exception as e:
            print(f"ERR {bin_path}: {e}", file=sys.stderr)
            failed += 1

    print(f"done: {ok} converted, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
