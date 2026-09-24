import numpy as np

from orchspec.dsp.cqt import CQTSpec, calibrated_db
from tests.fixtures.make_synthetic import CLICK_TIMES, SR, click_train


def _peaks(x: np.ndarray, height: float) -> np.ndarray:
    """Local maxima above `height` (strict on the left so plateaus count once)."""
    i = np.arange(1, len(x) - 1)
    ok = (x[i] > x[i - 1]) & (x[i] >= x[i + 1]) & (x[i] >= height)
    return i[ok]


def test_clicks_land_in_expected_frames(backend) -> None:  # type: ignore[no-untyped-def]
    spec = CQTSpec(sr=SR, hop=512, k=3)
    db = calibrated_db(backend.magnitude(click_train(), spec), spec)
    # top octave has the shortest filters (~12 ms): best time resolution
    level = 10 * np.log10((10.0 ** (db[-spec.bins_per_octave :] / 10.0)).sum(axis=0))
    # clicks between frame centers read a few dB lower; silence is ~150 dB down
    peaks = _peaks(level, level.max() - 20.0)
    expected = np.round(np.array(CLICK_TIMES) * SR / spec.hop).astype(int)
    assert len(peaks) == len(expected), (peaks, expected)
    assert np.all(np.abs(peaks - expected) <= 1), (peaks, expected)


def test_click_centered_frame_convention(backend) -> None:  # type: ignore[no-untyped-def]
    """A click exactly on sample f*hop peaks at frame f (centered frames)."""
    spec = CQTSpec(sr=SR, hop=512, k=1)
    y = np.zeros(SR * 2, dtype=np.float32)
    y[100 * spec.hop] = 1.0
    db = calibrated_db(backend.magnitude(y, spec), spec)
    power = (10.0 ** (db[-12:] / 10.0)).sum(axis=0)
    assert int(power.argmax()) == 100
