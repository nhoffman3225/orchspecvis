import numpy as np
import pytest

from orchspec.dsp.cqt import CQTSpec, calibrated_db
from tests.fixtures.make_synthetic import SR, log_sweep, sweep_midi_at, tone

EDGE = 0.6  # seconds ignored at each end (longest filters are ~0.9 s at A1)


@pytest.mark.parametrize("k", [1, 3])
def test_sweep_tracks_midi(backend, k: int) -> None:  # type: ignore[no-untyped-def]
    spec = CQTSpec(sr=SR, hop=512, k=k)
    db = calibrated_db(backend.magnitude(log_sweep(), spec), spec)
    t = np.arange(db.shape[1]) * spec.hop / SR
    keep = (t > EDGE) & (t < 10.0 - EDGE)
    expected_bin = (sweep_midi_at(t[keep]) - 21) * k
    got = db[:, keep].argmax(axis=0)
    err = np.abs(got - expected_bin)
    assert err.max() <= 1.0 + 1e-9, f"max bin error {err.max():.2f} at k={k}"


@pytest.mark.parametrize("k", [1, 3])
@pytest.mark.parametrize("midi", [69, 60])
def test_tone_peaks_at_expected_bin(backend, k: int, midi: int) -> None:  # type: ignore[no-untyped-def]
    spec = CQTSpec(sr=SR, hop=512, k=k)
    db = calibrated_db(backend.magnitude(tone(midi, amp=0.5), spec), spec)
    mid = db[:, db.shape[1] // 4 : 3 * db.shape[1] // 4]
    assert int(mid.mean(axis=1).argmax()) == (midi - 21) * k
    # calibration: amplitude 0.5 sine reads -6.02 dB re full-scale sine
    assert mid[(midi - 21) * k].mean() == pytest.approx(-6.02, abs=0.1)


def test_axis_definition() -> None:
    spec = CQTSpec(sr=SR, k=3)
    assert spec.n_bins == 264 and spec.bins_per_octave == 36
    assert spec.midi[(69 - 21) * 3] == 69
    assert spec.freqs[(69 - 21) * 3] == pytest.approx(440.0)
    assert spec.freqs[0] == pytest.approx(27.5)
    assert spec.n_frames(48000) == 1 + 48000 // 512


def test_bad_hop_rejected() -> None:
    with pytest.raises(ValueError, match="multiple of"):
        CQTSpec(sr=SR, hop=100, k=3)
