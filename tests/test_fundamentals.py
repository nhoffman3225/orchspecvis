import numpy as np
import pytest

from orchspec.dsp.cqt import CQTSpec, LibrosaBackend, calibrated_db
from orchspec.dsp.fundamentals import f0_track, note_fundamental_levels
from tests.fixtures import make_score_session as fx
from tests.fixtures.make_synthetic import SR, log_sweep, sweep_midi_at, tone


@pytest.fixture(scope="module")
def stems_db() -> tuple[CQTSpec, dict[int, np.ndarray]]:
    _, stems = fx.render_audio()
    spec = CQTSpec(sr=fx.SR, hop=512, k=3)
    lb = LibrosaBackend()
    return spec, {
        i: calibrated_db(lb.magnitude(y, spec), spec) for i, y in enumerate(stems.values())
    }


def test_weak_fundamental_flagged_only_for_the_bass(stems_db) -> None:  # type: ignore[no-untyped-def]
    spec, dbs = stems_db
    truth = fx.truth_notes()
    for part, db in dbs.items():
        notes = [t for t in truth if t["part"] == part]
        midi = np.array([t["midi"] for t in notes])
        on = np.array([t["onset_s"] for t in notes]) + fx.OFFSET
        off = np.array([t["offset_s"] for t in notes]) + fx.OFFSET
        lvl, ok = note_fundamental_levels(db, spec, midi, on, off)
        if fx.PARTS[part][5]:  # rendered without a fundamental
            assert not ok.any(), (part, lvl)
            assert (lvl < -40).all()
        else:
            assert ok.all(), (part, lvl, ok)
            # tones are 0.08 * sin at the fundamental -> about -22 dB (chords add a little)
            assert np.median(lvl) == pytest.approx(20 * np.log10(0.08), abs=3.0)


def test_f0_track_follows_tones_and_sweep() -> None:
    hop = 512
    y = np.concatenate(
        [
            tone(69, seconds=1.0, amp=0.3),
            np.zeros(SR // 2, np.float32),
            tone(45, seconds=1.0, amp=0.3),
        ]
    )
    n = 1 + len(y) // hop
    f0 = f0_track(y, SR, hop, n)
    fps = SR / hop
    mid_a4 = f0[int(0.3 * fps) : int(0.7 * fps)]
    mid_a2 = f0[int(1.8 * fps) : int(2.2 * fps)]
    silent = f0[int(1.15 * fps) : int(1.35 * fps)]
    assert np.median(mid_a4) == pytest.approx(440, rel=0.01)
    assert np.median(mid_a2) == pytest.approx(110, rel=0.01)
    assert (silent == 0).all()
    s = log_sweep()
    fs = f0_track(s, SR, hop, 1 + len(s) // hop)
    t = np.arange(len(fs)) / fps
    keep = (t > 0.5) & (t < 9.5)
    midi = 69 + 12 * np.log2(fs[keep] / 440)
    assert np.percentile(np.abs(midi - sweep_midi_at(t[keep])), 95) < 1 / 3  # within a bin
