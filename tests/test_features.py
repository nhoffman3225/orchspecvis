import numpy as np
import pyloudnorm
import pytest

from orchspec.dsp.features import onset_envelope, short_term_lufs, spectral_centroid
from tests.fixtures.make_synthetic import CLICK_TIMES, SR, click_train, pink_noise, tone


@pytest.mark.parametrize("sig", ["tone1k", "pink"])
def test_short_term_lufs_matches_pyloudnorm_on_steady_signal(sig: str) -> None:
    y = tone(83.2131, seconds=8.0, amp=0.3) if sig == "tone1k" else pink_noise(seconds=8.0, rms=0.1)
    ref = pyloudnorm.Meter(SR).integrated_loudness(y.astype(np.float64))
    st = short_term_lufs(y, SR)
    t = np.arange(len(st)) * 0.1
    mid = st[(t > 2.0) & (t < 6.0)]
    assert np.all(np.abs(mid - ref) < 0.2), (mid.min(), mid.max(), ref)


def test_short_term_lufs_stereo_sums_channels() -> None:
    y = tone(69, seconds=6.0, amp=0.2)
    mono = short_term_lufs(y, SR)[30]
    stereo = short_term_lufs(np.stack([y, y]), SR)[30]
    assert stereo - mono == pytest.approx(10 * np.log10(2), abs=0.01)


def test_short_term_lufs_silence_floor_and_length() -> None:
    st = short_term_lufs(np.zeros(SR * 2, dtype=np.float32), SR)
    assert len(st) == 21 and np.all(st == -120.0)


def test_centroid_of_sine() -> None:
    y = tone(69, seconds=2.0)
    c = spectral_centroid(y, SR, 512)
    assert len(c) == 1 + len(y) // 512
    assert np.median(c) == pytest.approx(440.0, rel=0.05)


def test_onset_envelope_peaks_at_clicks() -> None:
    y = click_train()
    o = onset_envelope(y, SR, 512)
    assert len(o) == 1 + len(y) // 512
    for t in CLICK_TIMES:
        f = round(t * SR / 512)
        window = o[max(0, f - 3) : f + 4]
        assert abs(int(np.argmax(window)) + max(0, f - 3) - f) <= 1
