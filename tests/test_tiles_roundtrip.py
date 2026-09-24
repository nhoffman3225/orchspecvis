from pathlib import Path

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from hypothesis.extra.numpy import arrays

from orchspec.bundle.schema import NONE_STEM
from orchspec.dsp.tiles import (
    DominantAccumulator,
    dequantize,
    lod_frame_counts,
    lsb_db,
    pool_max,
    pyramid,
    quantize,
    read_level,
    write_pyramid,
)

DB_MIN, DB_MAX = -96.0, 6.0


@settings(max_examples=50, deadline=None)
@given(
    arrays(np.float32, st.integers(1, 500), elements=st.floats(-150, 30, allow_nan=False, width=32))
)
def test_quantize_error_at_most_one_lsb(db: np.ndarray) -> None:
    back = dequantize(quantize(db, DB_MIN, DB_MAX), DB_MIN, DB_MAX)
    clipped = np.clip(db, DB_MIN, DB_MAX)
    assert np.max(np.abs(back - clipped)) <= lsb_db(DB_MIN, DB_MAX) + 1e-4


def test_quantize_endpoints() -> None:
    q = quantize(np.array([-200.0, DB_MIN, DB_MAX, 50.0]), DB_MIN, DB_MAX)
    assert q.tolist() == [0, 0, 255, 255]


@pytest.mark.parametrize(
    ("n", "tile", "expect"),
    [
        (1, 64, [1]),
        (64, 64, [64]),
        (65, 64, [65, 33]),
        (1000, 64, [1000, 500, 250, 125, 63]),
        (112501, 1024, [112501, 56251, 28126, 14063, 7032, 3516, 1758, 879]),
    ],
)
def test_lod_frame_counts(n: int, tile: int, expect: list[int]) -> None:
    assert lod_frame_counts(n, tile) == expect


def test_pool_max_odd() -> None:
    a = np.array([[1], [5], [2], [0], [7]], dtype=np.uint8)
    assert pool_max(a)[:, 0].tolist() == [5, 2, 7]


def test_pyramid_roundtrip_on_disk(tmp_path: Path) -> None:
    rng = np.random.default_rng(0)
    level0 = rng.integers(0, 256, size=(1000, 12), dtype=np.uint8)
    lods = write_pyramid(tmp_path, "tiles/mix", level0, tile_frames=64)
    levels = pyramid(level0, 64)
    assert [lod.n_frames for lod in lods] == lod_frame_counts(1000, 64)
    for lod, arr in zip(lods, levels, strict=True):
        assert np.array_equal(read_level(tmp_path, lod, 12), arr)
        assert sum(t.n_frames for t in lod.tiles) == lod.n_frames
        assert all(t.n_frames <= 64 for t in lod.tiles)
    # the top level fits in one tile
    assert len(lods[-1].tiles) == 1
    # byte layout: frame-major
    raw = (tmp_path / lods[0].tiles[0].path).read_bytes()
    assert raw[3 * 12 + 5] == level0[3, 5]


def test_dominant_accumulator() -> None:
    acc = DominantAccumulator(n_frames=4, n_bins=2, tile_frames=2, floor_u8=10)
    a = np.array([[50, 5], [20, 5], [0, 0], [99, 99]], dtype=np.uint8)
    b = np.array([[40, 8], [30, 5], [0, 0], [99, 100]], dtype=np.uint8)
    acc.add(0, pyramid(a, 2))
    acc.add(1, pyramid(b, 2))
    assert acc.idx[0].tolist() == [[0, NONE_STEM], [1, NONE_STEM], [NONE_STEM, NONE_STEM], [0, 1]]
    # level 1 decided from pooled stems, not pooled indices
    assert acc.idx[1].tolist() == [[0, NONE_STEM], [0, 1]]
