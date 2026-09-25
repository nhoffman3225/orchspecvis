"""dB quantization, LOD pyramid and tile writing (see docs/bundle-format.md).

Arrays here are **frame-major** uint8, shape (n_frames, n_bins), matching the on-disk
tile layout (byte = frame * n_bins + bin).
"""

from __future__ import annotations

import gzip
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from orchspec.bundle.schema import NONE_STEM, Lod, Tile, TileEncoding

GZIP_LEVEL = 3  # ~0.30 of raw on orchestral tiles at ~180 MB/s; 6+ gains < 1 %


def quantize(db: np.ndarray, db_min: float, db_max: float) -> np.ndarray:
    """dB (any shape) -> uint8, v = round((clamp(db) - db_min) * 255 / range)."""
    scale = 255.0 / (db_max - db_min)
    q = np.rint((np.clip(db, db_min, db_max) - db_min) * scale)
    return q.astype(np.uint8)


def dequantize(u8: np.ndarray, db_min: float, db_max: float) -> np.ndarray:
    return (db_min + u8.astype(np.float32) * np.float32((db_max - db_min) / 255.0)).astype(
        np.float32
    )


def lsb_db(db_min: float, db_max: float) -> float:
    return (db_max - db_min) / 255.0


def pool_max(level: np.ndarray) -> np.ndarray:
    """(n, ...) -> (ceil(n/2), ...) elementwise max of frame pairs (last alone if odd)."""
    n = level.shape[0]
    if n % 2:
        level = np.concatenate([level, level[-1:]], axis=0)
    return np.maximum(level[0::2], level[1::2])


def lod_frame_counts(n_frames: int, tile_frames: int) -> list[int]:
    """Frame count per level; levels are generated until one fits in a single tile."""
    counts = [n_frames]
    while counts[-1] > tile_frames:
        counts.append(-(-counts[-1] // 2))
    return counts


def pyramid(level0: np.ndarray, tile_frames: int) -> list[np.ndarray]:
    levels = [level0]
    for _ in lod_frame_counts(level0.shape[0], tile_frames)[1:]:
        levels.append(pool_max(levels[-1]))
    return levels


_POOL: ThreadPoolExecutor | None = None


def _pool() -> ThreadPoolExecutor:
    global _POOL
    if _POOL is None:
        _POOL = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1))
    return _POOL


def encode_tile(raw: bytes, encoding: TileEncoding) -> bytes:
    # mtime=0: byte-identical output for identical input (reproducible bundles)
    return gzip.compress(raw, GZIP_LEVEL, mtime=0) if encoding == "gzip" else raw


def decode_tile(data: bytes, encoding: TileEncoding) -> bytes:
    return gzip.decompress(data) if encoding == "gzip" else data


def tile_suffix(encoding: TileEncoding) -> str:
    return ".u8.gz" if encoding == "gzip" else ".u8"


def write_level(
    root: Path,
    prefix: str,
    level: int,
    data: np.ndarray,
    tile_frames: int,
    encoding: TileEncoding = "gzip",
) -> Lod:
    """Write one level of frame-major uint8 tiles under root/prefix/L<level>/."""
    d = root / prefix / f"L{level}"
    d.mkdir(parents=True, exist_ok=True)

    def one(i: int) -> Tile:
        start = i * tile_frames
        chunk = np.ascontiguousarray(data[start : start + tile_frames], dtype=np.uint8)
        rel = f"{prefix}/L{level}/{i:05d}{tile_suffix(encoding)}"
        (root / rel).write_bytes(encode_tile(chunk.tobytes(), encoding))
        return Tile(index=i, start_frame=start, n_frames=chunk.shape[0], path=rel)

    n = -(-data.shape[0] // tile_frames)
    if encoding == "raw" or n < 4:
        tiles = [one(i) for i in range(n)]
    else:  # zlib releases the GIL: compress tiles in parallel
        tiles = list(_pool().map(one, range(n)))
    return Lod(level=level, hop_factor=2**level, n_frames=data.shape[0], tiles=tiles)


def write_pyramid(
    root: Path,
    prefix: str,
    level0: np.ndarray,
    tile_frames: int,
    encoding: TileEncoding = "gzip",
) -> list[Lod]:
    return [
        write_level(root, prefix, lv, arr, tile_frames, encoding)
        for lv, arr in enumerate(pyramid(level0, tile_frames))
    ]


def read_level(root: Path, lod: Lod, n_bins: int, encoding: TileEncoding = "gzip") -> np.ndarray:
    """Reassemble one level from its tiles -> (n_frames, n_bins) uint8."""
    parts = [
        np.frombuffer(decode_tile((root / t.path).read_bytes(), encoding), dtype=np.uint8).reshape(
            t.n_frames, n_bins
        )
        for t in lod.tiles
    ]
    return np.concatenate(parts, axis=0)


@dataclass
class DominantAccumulator:
    """Running per-cell argmax over stems, for every pyramid level.

    Stems are added one at a time (so all stems never need to be in memory at once). A
    cell's winner is the stem with the highest quantized value; ties keep the earlier stem.
    Cells where every stem is <= floor_u8 get NONE_STEM.
    """

    n_frames: int
    n_bins: int
    tile_frames: int
    floor_u8: int

    def __post_init__(self) -> None:
        counts = lod_frame_counts(self.n_frames, self.tile_frames)
        self.best = [np.zeros((c, self.n_bins), dtype=np.uint8) for c in counts]
        self.idx = [np.full((c, self.n_bins), NONE_STEM, dtype=np.uint8) for c in counts]

    def add(self, stem_index: int, levels: list[np.ndarray]) -> None:
        for best, idx, lv in zip(self.best, self.idx, levels, strict=True):
            win = (lv > best) & (lv > self.floor_u8)
            best[win] = lv[win]
            idx[win] = stem_index

    def write(
        self, root: Path, prefix: str = "tiles/dominant", encoding: TileEncoding = "gzip"
    ) -> list[Lod]:
        return [
            write_level(root, prefix, lv, arr, self.tile_frames, encoding)
            for lv, arr in enumerate(self.idx)
        ]
