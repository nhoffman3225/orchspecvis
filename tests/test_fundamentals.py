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


def _reference_levels(db, spec, midi, onset_s, offset_s):  # type: ignore[no-untyped-def]
    """The original per-note loop (kept as the reference for the vectorized version)."""
    from orchspec.dsp.cqt import A0_MIDI
    from orchspec.dsp.fundamentals import FLOOR_DB, WEAK_DB

    def band(center, f0, f1):  # type: ignore[no-untyped-def]
        b = round(center)
        lo, hi = max(0, b - 1), min(db.shape[0], b + 2)
        return db[lo:hi, f0:f1].max(axis=0)

    n = len(midi)
    f0_db = np.full(n, FLOOR_DB, dtype=np.float32)
    ok = np.zeros(n, dtype=np.float32)
    fps = spec.sr / spec.hop
    for i in range(n):
        dur = offset_s[i] - onset_s[i]
        t0 = onset_s[i] + max(0.1 * dur, 0.03)
        a, b = int(np.ceil(t0 * fps)), int(np.floor(offset_s[i] * fps)) + 1
        a, b = max(0, a), min(db.shape[1], b)
        if b <= a:
            a = max(0, min(db.shape[1] - 1, round(onset_s[i] * fps)))
            b = a + 1
        base = (midi[i] - A0_MIDI) * spec.k
        if base < -0.5 or base > spec.n_bins - 0.5:
            continue
        lvl = float(np.median(band(base, a, b)))
        harm = [
            float(np.median(band(base + 12 * spec.k * np.log2(h), a, b)))
            for h in (2, 3, 4)
            if base + 12 * spec.k * np.log2(h) < spec.n_bins - 0.5
        ]
        f0_db[i] = max(lvl, FLOOR_DB)
        ok[i] = float(lvl > FLOOR_DB and lvl >= (max(harm) if harm else -np.inf) - WEAK_DB)
    return f0_db, ok


def test_vectorized_levels_equal_the_reference_loop() -> None:
    from orchspec.dsp.cqt import CQTSpec

    spec = CQTSpec(sr=22050, hop=512, k=3)
    rng = np.random.default_rng(3)
    db = (rng.random((spec.n_bins, 900)) * 90 - 95).astype(np.float32)
    n = 700
    midi = rng.integers(15, 115, n).astype(np.float64)  # includes out-of-range pitches
    on = rng.random(n) * 22
    off = on + rng.choice([0.0, 0.005, 0.05, 0.4, 3.0], n)  # empty, tiny and long notes
    off[:5] = on[:5] + 40  # past the end
    got = note_fundamental_levels(db, spec, midi, on, off)
    ref = _reference_levels(db, spec, midi, on, off)
    np.testing.assert_array_equal(got[0], ref[0])
    np.testing.assert_array_equal(got[1], ref[1])
