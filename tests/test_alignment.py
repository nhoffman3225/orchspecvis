import numpy as np
import pytest

from orchspec.score.match import match_parts_to_stems, normalize
from orchspec.score.musicxml import parse_musicxml
from orchspec.timeline.align import (
    TempoMap,
    _group_medians,
    estimate_offset,
    onset_envelope_fine,
    pitch_agreement,
    quarter_clock,
)
from orchspec.timeline.midi import parse_midi_bytes
from tests.fixtures import make_score_session as fx

FRAME = 512 / fx.SR  # bundle hop at the fixture rate


def test_tempo_map() -> None:
    tm = TempoMap([(0.0, 120.0), (16.0, 90.0)])
    assert tm.seconds(16) == pytest.approx(8.0)
    assert tm.seconds(19) == pytest.approx(10.0)
    assert TempoMap([]).seconds(2) == pytest.approx(1.0)  # default 120


def test_midi_and_score_clocks_agree(tmp_path) -> None:  # type: ignore[no-untyped-def]
    p = tmp_path / "s.musicxml"
    p.write_text(fx.musicxml(), encoding="utf-8")
    score = parse_musicxml(p)
    midi = parse_midi_bytes(fx.render_mid())
    by_midi, src = quarter_clock(score, midi)
    by_score, src2 = quarter_clock(score, None)
    assert (src, src2) == ("midi", "score_tempo")
    for q in (0, 5, 16, 21.5, 24):
        assert by_midi(q) == pytest.approx(fx.q_to_seconds(q))
        assert by_score(q) == pytest.approx(fx.q_to_seconds(q))


def test_pitch_agreement_detects_written_pitch_midi(tmp_path) -> None:  # type: ignore[no-untyped-def]
    p = tmp_path / "s.musicxml"
    p.write_text(fx.musicxml(), encoding="utf-8")
    score = parse_musicxml(p)
    good = pitch_agreement(score, parse_midi_bytes(fx.render_mid()))
    assert good.agreement == 1.0 and good.compared == len(score.notes)
    # a MIDI file one octave off (e.g. written-pitch export) is reported with its shift
    from tests.fixtures.smf import write_smf

    shifted = write_smf(
        fx.PPQ,
        [(0, 120.0)],
        [
            (
                "all",
                [
                    (
                        round(n.onset_q * fx.PPQ),
                        round((n.onset_q + n.dur_q) * fx.PPQ),
                        0,
                        int(n.midi) + 12,
                        90,
                    )
                    for n in score.notes
                ],
            )
        ],
    )
    bad = pitch_agreement(score, parse_midi_bytes(shifted))
    # a few notes still match by coincidence (octave doublings between parts)
    assert bad.agreement < 0.5 and bad.shift_mode == 12


def test_offset_recovered_within_one_frame() -> None:
    mix, _ = fx.render_audio()
    env, fsec = onset_envelope_fine(mix, fx.SR)
    onsets = np.array([t["onset_s"] for t in fx.truth_notes()])
    est = estimate_offset(env, fsec, onsets, prior=fx.PREROLL)
    assert est.method == "xcorr" and est.confidence > 0.3
    assert abs(est.offset_sec - fx.OFFSET) < FRAME, est


def test_offset_with_wrong_prior_is_still_found_inside_window() -> None:
    mix, _ = fx.render_audio()
    env, fsec = onset_envelope_fine(mix, fx.SR)
    onsets = np.array([t["onset_s"] for t in fx.truth_notes()])
    est = estimate_offset(env, fsec, onsets, prior=0.0, search=1.5)
    assert abs(est.offset_sec - fx.OFFSET) < FRAME


def test_no_onsets_falls_back_to_prior() -> None:
    est = estimate_offset(np.zeros(100), 0.01, np.array([]), prior=0.25)
    assert est.offset_sec == 0.25 and est.method == "preroll_only" and est.warnings


def test_name_matching() -> None:
    assert normalize("Clarinet in B♭ 1") == "clarinet 1"
    assert normalize("01_Violins I") == normalize("Violin 1")
    m = match_parts_to_stems(
        ["Violin I", "Horn in F 1", "Timpani"], ["03_Timp", "01_Violins I", "02_Horn 1"]
    )
    assert [(x.stem_index, x.method) for x in m] == [(1, "name"), (2, "name"), (0, "order")]
    # Dorico spellings: key in parentheses, instrument changes joined with "&"
    assert normalize("Clarinet (B Flat) 1") == normalize("Clarinet (Bb) 1") == "clarinet 1"
    assert normalize("Horn (E♭) 2") == "horn 2"
    m3 = match_parts_to_stems(
        ["Horn (E Flat) 1", "Horn (E Flat) 2", "Trumpet (C) 1"],
        ["Trumpet (C) 1", "Horn (Eb) 2 & Horn (C) 2", "Horn (Eb) 1 & Horn (C) 1"],
    )
    assert [x.stem_index for x in m3] == [2, 1, 0]
    m2 = match_parts_to_stems(["Flute", "Oboe"], ["01_Tuba"])
    assert [x.method for x in m2] == ["none", "none"]


def test_fft_pitch_scores_equal_the_gather_version() -> None:
    from orchspec.timeline.align import ONSET_TAU, SUSTAIN_W, _pitch_scores, _pitch_scores_fft

    rng = np.random.default_rng(7)
    act = rng.random((88, 900))
    flux = rng.random((88, 900))
    k = 4000
    sem = rng.integers(0, 88, k)
    frm = rng.integers(0, 1000, k)  # some cells beyond the audio: must count as 0
    rel = rng.random(k) * 0.3
    sus = (rng.random(k) > 0.5).astype(float)
    lags = np.arange(-120, 140)
    ref = _pitch_scores(act, flux, sem, frm, rel, sus, lags)
    got = _pitch_scores_fft(act, flux, sem, frm, np.exp(-rel / ONSET_TAU), SUSTAIN_W * sus, lags)
    np.testing.assert_allclose(got, ref, rtol=1e-9, atol=1e-9 * float(np.abs(ref).max()))


def test_group_medians_match_numpy() -> None:
    rng = np.random.default_rng(3)
    g = rng.integers(0, 50, 1000)
    x = rng.normal(size=1000)
    out = _group_medians(g, x, 60)
    for k in range(60):
        want = np.median(x[g == k]) if np.any(g == k) else np.nan
        assert out[k] == want or (np.isnan(want) and np.isnan(out[k]))
    assert np.isnan(_group_medians(g[:0], x[:0], 3)).all()
