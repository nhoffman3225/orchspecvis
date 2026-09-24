import numpy as np
import pytest

from orchspec.dsp.cqt import CQTSpec, LibrosaBackend, calibrated_db, get_backend
from tests.conftest import TORCH_DEVICE
from tests.fixtures.make_synthetic import SR, all_fixtures

pytestmark = [
    pytest.mark.gpu,
    pytest.mark.skipif(TORCH_DEVICE is None, reason="needs torch with CUDA"),
]

# Median over everything above the display floor; the tail check only over cells within
# 60 dB of full scale (decimation-filter stopband differences live far below that).
FLOOR = -90.0
TAIL_FLOOR = -60.0


@pytest.mark.parametrize("k", [1, 3])
@pytest.mark.parametrize("name", list(all_fixtures().keys()))
def test_median_db_diff(name: str, k: int) -> None:
    y = all_fixtures()[name]
    spec = CQTSpec(sr=SR, hop=512, k=k)
    ref = calibrated_db(LibrosaBackend().magnitude(y, spec), spec)
    got = calibrated_db(get_backend("torch", TORCH_DEVICE).magnitude(y, spec), spec)
    assert got.shape == ref.shape
    mask = np.maximum(ref, got) > FLOOR
    diff = np.abs(ref - got)[mask]
    assert np.median(diff) < 0.5, f"{name}: median {np.median(diff):.3f} dB"
    loud = np.abs(ref - got)[np.maximum(ref, got) > TAIL_FLOOR]
    assert np.percentile(loud, 95) < 1.0, f"{name}: p95 {np.percentile(loud, 95):.3f} dB"
