#!/usr/bin/env python3
"""
Convert 16-color indexed PNG back to soccer-js .bin sprite banks (recursive).

Expected PNG (sprite-manager compatible):
  - Mode P (palette / indexed)
  - Up to 16 colors used (indices 0–15)
  - Slot 0 = transparent (tRNS preferred)
  - Tiles laid out left→right in a horizontal strip
    (width=tile_w*tile_count, height=tile_h)
  - Legacy vertical strips (height=tile_h*tile_count) still accepted when
    metadata or dimensions clearly indicate that layout

.bin layout (little-endian):
  uint16 width, height, tile_count, palette_count (=16)
  16 * 3 RGB bytes
  zlib-compressed 4-bit packed pixels (high nibble = even pixel)

Tile geometry resolution order:
  1. CLI --tile-width / --tile-height / --tile-count / --layout
  2. PNG text metadata TileWidth / TileHeight / TileCount / TileLayout
  3. Infer from image size (prefer horizontal; fall back to vertical)
  4. Whole image as a single tile

Output .bin is written next to the source .png.
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image

PALETTE_SLOTS = 16


def pack_nibbles(indices: bytes | bytearray) -> bytes:
    out = bytearray((len(indices) + 1) // 2)
    for i, idx in enumerate(indices):
        v = idx & 0x0F
        if (i & 1) == 0:
            out[i >> 1] = v << 4
        else:
            out[i >> 1] |= v
    return bytes(out)


def normalize_palette(img: Image.Image) -> list[tuple[int, int, int]]:
    """Return 16 RGB triples from a mode-P image; slot 0 kept as stored RGB."""
    raw = img.getpalette() or []
    # Pillow may return 768 bytes (256*3) or fewer.
    palette: list[tuple[int, int, int]] = []
    for i in range(PALETTE_SLOTS):
        o = i * 3
        if o + 2 < len(raw):
            palette.append((raw[o], raw[o + 1], raw[o + 2]))
        else:
            palette.append((0, 0, 0))
    return palette


def extract_tiles_horizontal(
    indices: bytes | bytearray, img_w: int, img_h: int, tile_w: int, tile_h: int, count: int
) -> bytearray:
    """Extract left→right tiles from a horizontal strip into per-tile row-major."""
    out = bytearray(tile_w * tile_h * count)
    for t in range(count):
        for y in range(tile_h):
            src = y * img_w + t * tile_w
            dst = t * (tile_w * tile_h) + y * tile_w
            out[dst : dst + tile_w] = indices[src : src + tile_w]
    return out


def extract_tiles_vertical(
    indices: bytes | bytearray, img_w: int, img_h: int, tile_w: int, tile_h: int, count: int
) -> bytearray:
    """Extract top→bottom tiles from a vertical strip into per-tile row-major."""
    out = bytearray(tile_w * tile_h * count)
    for t in range(count):
        src0 = t * tile_w * tile_h
        dst0 = t * tile_w * tile_h
        out[dst0 : dst0 + tile_w * tile_h] = indices[src0 : src0 + tile_w * tile_h]
    return out


def resolve_tiles(
    img: Image.Image,
    tile_w: int | None,
    tile_h: int | None,
    tile_count: int | None,
    layout: str | None,
) -> tuple[int, int, int, str]:
    """
    Resolve tile geometry and layout.

    Returns (tile_w, tile_h, tile_count, layout) where layout is
    'horizontal' or 'vertical'.
    """
    meta_w = img.info.get("TileWidth")
    meta_h = img.info.get("TileHeight")
    meta_c = img.info.get("TileCount")
    meta_layout = img.info.get("TileLayout")

    w = tile_w if tile_w is not None else (int(meta_w) if meta_w is not None else None)
    h = tile_h if tile_h is not None else (int(meta_h) if meta_h is not None else None)
    c = tile_count if tile_count is not None else (int(meta_c) if meta_c is not None else None)

    lay = (layout or meta_layout or "").strip().lower() or None
    if lay not in (None, "horizontal", "vertical", "h", "v"):
        raise ValueError(f"invalid layout {lay!r} (use horizontal or vertical)")
    if lay in ("h",):
        lay = "horizontal"
    elif lay in ("v",):
        lay = "vertical"

    # Fully specified geometry
    if w is not None and h is not None and c is not None:
        if lay is None:
            if img.width == w * c and img.height == h:
                lay = "horizontal"
            elif img.width == w and img.height == h * c:
                lay = "vertical"
            else:
                # Default to sprite-manager convention
                lay = "horizontal"
        _validate_dims(img, w, h, c, lay)
        return w, h, c, lay

    # Partial geometry + layout inference
    if lay is None:
        # Prefer horizontal when only one interpretation fits, else horizontal default
        # when fully unconstrained.
        if w is not None and h is not None:
            if img.width == w * (img.width // w) and img.height == h and img.width % w == 0:
                c = img.width // w
                lay = "horizontal"
            elif img.width == w and img.height % h == 0:
                c = img.height // h
                lay = "vertical"
            else:
                raise ValueError(
                    f"image {img.width}x{img.height} does not match tile {w}x{h} "
                    f"(horizontal or vertical strip)"
                )
        elif w is not None:
            # Known tile width: if height equals something we don't know…
            if img.width % w != 0:
                raise ValueError(f"image width {img.width} not divisible by tile width {w}")
            c = c if c is not None else (img.width // w)
            h = h if h is not None else img.height
            lay = "horizontal"
        elif h is not None and c is not None:
            # Known height + count — could be either orientation
            if img.height == h and img.width % c == 0:
                w = img.width // c
                lay = "horizontal"
            elif img.width % 1 == 0 and img.height == h * c:
                w = img.width
                lay = "vertical"
            else:
                raise ValueError(
                    f"cannot infer tile width from {img.width}x{img.height} "
                    f"with tile_h={h} count={c}"
                )
        elif h is not None:
            if img.height == h:
                # Horizontal strip of unknown tile width/count
                if c is not None:
                    if img.width % c != 0:
                        raise ValueError(
                            f"image width {img.width} not divisible by tile_count {c}"
                        )
                    w = img.width // c
                else:
                    # Single-tile fallback along strip
                    w = img.width
                    c = 1
                lay = "horizontal"
            elif img.height % h == 0:
                c = c if c is not None else (img.height // h)
                w = img.width
                lay = "vertical"
            else:
                raise ValueError(
                    f"image height {img.height} not divisible by tile height {h}"
                )
        elif c is not None:
            # Only count known — assume horizontal strip
            if img.width % c != 0:
                raise ValueError(
                    f"image width {img.width} not divisible by tile_count {c}"
                )
            w = img.width // c
            h = img.height
            lay = "horizontal"
        else:
            # No geometry at all → single tile
            w, h, c = img.width, img.height, 1
            lay = "horizontal"
    else:
        # Layout forced; fill missing fields
        if lay == "horizontal":
            if h is None:
                h = img.height
            if w is None and c is not None:
                if img.width % c != 0:
                    raise ValueError(
                        f"image width {img.width} not divisible by tile_count {c}"
                    )
                w = img.width // c
            elif c is None and w is not None:
                if img.width % w != 0:
                    raise ValueError(
                        f"image width {img.width} not divisible by tile width {w}"
                    )
                c = img.width // w
            elif w is None and c is None:
                w, c = img.width, 1
        else:  # vertical
            if w is None:
                w = img.width
            if h is None and c is not None:
                if img.height % c != 0:
                    raise ValueError(
                        f"image height {img.height} not divisible by tile_count {c}"
                    )
                h = img.height // c
            elif c is None and h is not None:
                if img.height % h != 0:
                    raise ValueError(
                        f"image height {img.height} not divisible by tile height {h}"
                    )
                c = img.height // h
            elif h is None and c is None:
                h, c = img.height, 1

    assert w is not None and h is not None and c is not None and lay is not None
    if w <= 0 or h <= 0 or c <= 0:
        raise ValueError(f"invalid tile geometry: {w}x{h} x {c}")
    _validate_dims(img, w, h, c, lay)
    return w, h, c, lay


def _validate_dims(img: Image.Image, w: int, h: int, c: int, layout: str) -> None:
    if layout == "horizontal":
        if img.width != w * c:
            raise ValueError(
                f"image width {img.width} != tile_width*tile_count ({w}*{c}={w * c})"
            )
        if img.height != h:
            raise ValueError(f"image height {img.height} != tile height {h}")
    else:
        if img.width != w:
            raise ValueError(f"image width {img.width} != tile width {w}")
        if img.height != h * c:
            raise ValueError(
                f"image height {img.height} != tile_height*tile_count ({h}*{c}={h * c})"
            )


def png_to_bin(
    png_path: Path,
    force: bool = False,
    tile_w: int | None = None,
    tile_h: int | None = None,
    tile_count: int | None = None,
    layout: str | None = None,
) -> Path:
    out_path = png_path.with_suffix(".bin")
    if out_path.exists() and not force:
        raise FileExistsError(f"refusing to overwrite {out_path} (use --force)")

    img = Image.open(png_path)
    img.load()

    if img.mode != "P":
        raise ValueError(f"expected indexed mode P, got {img.mode}")

    # Ensure we see raw palette indices (not remapped).
    if img.palette is None:
        raise ValueError("missing palette")

    extrema = img.getextrema()
    max_idx = extrema[1] if isinstance(extrema, tuple) else extrema
    if max_idx > 15:
        raise ValueError(f"palette index {max_idx} exceeds 15 (need 16-color image)")

    w, h, tiles, lay = resolve_tiles(img, tile_w, tile_h, tile_count, layout)
    palette = normalize_palette(img)
    raw = img.tobytes()
    if len(raw) != img.width * img.height:
        raise ValueError(
            f"pixel buffer size mismatch: {len(raw)} vs {img.width * img.height}"
        )

    if lay == "horizontal":
        indices = extract_tiles_horizontal(raw, img.width, img.height, w, h, tiles)
    else:
        indices = extract_tiles_vertical(raw, img.width, img.height, w, h, tiles)

    pixels_per_tile = w * h
    if len(indices) != pixels_per_tile * tiles:
        raise ValueError(
            f"pixel buffer size mismatch: {len(indices)} vs {pixels_per_tile * tiles}"
        )

    # Pack each tile independently so odd pixel counts pad on a per-tile
    # boundary (matches the engine loader: bytesPerTile = ceil(w*h/2)).
    packed_parts = []
    for t in range(tiles):
        start = t * pixels_per_tile
        packed_parts.append(pack_nibbles(indices[start : start + pixels_per_tile]))
    packed = b"".join(packed_parts)
    compressed = zlib.compress(packed, level=9)

    header = struct.pack("<HHHH", w, h, tiles, PALETTE_SLOTS)
    pal_bytes = bytearray()
    for r, g, b in palette:
        pal_bytes.extend((r, g, b))

    out_path.write_bytes(header + bytes(pal_bytes) + compressed)
    return out_path


def collect_pngs(root: Path) -> list[Path]:
    if root.is_file():
        if root.suffix.lower() != ".png":
            raise ValueError(f"not a .png file: {root}")
        return [root]
    if not root.is_dir():
        raise ValueError(f"path not found: {root}")
    return sorted(root.rglob("*.png"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Convert 16-color indexed PNG to soccer-js .bin (recursive). "
            "Default layout is horizontal strip (sprite-manager compatible); "
            "legacy vertical strips are still accepted when dimensions/metadata match."
        )
    )
    parser.add_argument(
        "path",
        type=Path,
        help="File or folder. Folders are scanned recursively for *.png",
    )
    parser.add_argument(
        "--force",
        "-f",
        action="store_true",
        help="Overwrite existing .bin files",
    )
    parser.add_argument(
        "--tile-width",
        type=int,
        default=None,
        help="Override tile width (default: PNG metadata or inferred)",
    )
    parser.add_argument(
        "--tile-height",
        type=int,
        default=None,
        help="Override tile height (default: PNG metadata or full height)",
    )
    parser.add_argument(
        "--tile-count",
        type=int,
        default=None,
        help="Override tile count (default: PNG metadata or 1)",
    )
    parser.add_argument(
        "--layout",
        choices=("horizontal", "vertical", "h", "v"),
        default=None,
        help="Tile strip layout (default: metadata or auto-detect; prefer horizontal)",
    )
    args = parser.parse_args(argv)

    try:
        pngs = collect_pngs(args.path.resolve())
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if not pngs:
        print(f"no .png files under {args.path}")
        return 0

    ok = 0
    failed = 0
    for png_path in pngs:
        try:
            out = png_to_bin(
                png_path,
                force=args.force,
                tile_w=args.tile_width,
                tile_h=args.tile_height,
                tile_count=args.tile_count,
                layout=args.layout,
            )
            print(f"OK  {png_path} -> {out}")
            ok += 1
        except Exception as e:
            print(f"ERR {png_path}: {e}", file=sys.stderr)
            failed += 1

    print(f"done: {ok} converted, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
