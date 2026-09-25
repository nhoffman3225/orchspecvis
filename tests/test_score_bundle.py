"""Phase 2 acceptance: synthetic MusicXML + MIDI + rendered audio -> bundle; every note
lands within +-1 frame of the truth. Also emits viewer/test-data/py-score-bundle."""

import shutil
from pathlib import Path

import numpy as np
import pytest

from orchspec.bundle.schema import NOTE_COLUMNS, Manifest
from orchspec.bundle.writer import BundleOptions, build_bundle, inputs_from_session
from orchspec.io.session import load_session
from tests.fixtures import make_score_session as fx

VIEWER_FIXTURE = Path(__file__).resolve().parents[1] / "viewer" / "test-data" / "py-score-bundle"


@pytest.fixture(scope="module")
def bundle(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Manifest]:
    sess = fx.make(tmp_path_factory.mktemp("sess") / "score-session")
    out = tmp_path_factory.mktemp("out") / "score.bundle"
    rep = build_bundle(
        inputs_from_session(load_session(sess)), out, BundleOptions(k=3, tile_frames=256)
    )
    VIEWER_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(VIEWER_FIXTURE, ignore_errors=True)
    shutil.copytree(out, VIEWER_FIXTURE)
    return out, rep.manifest


def _notes(root: Path, m: Manifest) -> dict[str, np.ndarray]:
    assert m.score is not None
    raw = np.frombuffer((root / m.score.notes.path).read_bytes(), "<f4")
    t = raw.reshape(len(NOTE_COLUMNS), m.score.notes.n)
    return dict(zip(NOTE_COLUMNS, t, strict=True))


def test_manifest_v2_score_section(bundle) -> None:  # type: ignore[no-untyped-def]
    root, _ = bundle
    m2 = Manifest.model_validate_json((root / "manifest.json").read_text(encoding="utf-8"))
    assert m2.schema_version == 5 and m2.score is not None
    # engravable reductions (tutti grand staff + short score) with their note maps
    assert [r.mode for r in m2.score.reductions] == [
        "chords",
        "section-chords",
        "tutti",
        "sections",
    ]
    for r in m2.score.reductions:
        assert (root / r.musicxml).read_text(encoding="utf-8").startswith("<?xml")
        assert (root / r.map).exists()
    assert m2.tile_encoding == "gzip"
    assert m2.lods[0].tiles[0].path.endswith(".u8.gz")
    s = m2.score
    assert s.kind == "musicxml" and s.source_files == ["score.musicxml", "render.mid"]
    assert [p.stem_match for p in s.parts] == ["name"] * 4
    assert [p.stem_id for p in s.parts] == [st.id for st in m2.stems]
    assert [p.range_id for p in s.parts] == ["flute", "clarinet_bb", "double_bass", "piano"]
    assert (s.parts[2].range_low, s.parts[2].range_high) == (24, 67)
    assert [x.number for x in s.measures] == ["1", "2", "3", "2", "4", "5"]
    assert [x.source_index for x in s.measures] == [0, 1, 2, 1, 3, 4]
    assert s.score_file == "score/score.musicxml"
    assert (root / s.score_file).read_bytes().startswith(b"<?xml")
    assert s.alignment.method == "warp" and s.alignment.time_source == "midi"
    assert s.alignment.snapped == 1.0 and len(s.alignment.warp) > 5
    assert s.alignment.pitch_agreement == 1.0
    assert s.notes.n == len(fx.truth_notes())


FRAME_48K = 512 / 48_000  # PLAN acceptance: +-1 frame at hop 512 @ 48 kHz


def _check_notes(root: Path, m: Manifest, drift) -> None:  # type: ignore[no-untyped-def]
    cols = _notes(root, m)
    for t in fx.audio_notes(drift):
        cand = np.flatnonzero((cols["part"] == t["part"]) & (cols["midi"] == t["midi"]))
        i = cand[np.argmin(np.abs(cols["onset_s"][cand] - t["audio_on"]))]
        assert abs(cols["onset_s"][i] - t["audio_on"]) < FRAME_48K, (t, cols["onset_s"][i])
        assert abs(cols["offset_s"][i] - t["audio_off"]) < 3 * FRAME_48K, t


def test_every_note_within_one_frame(bundle) -> None:  # type: ignore[no-untyped-def]
    root, m = bundle
    _check_notes(root, m, None)


@pytest.fixture(scope="module")
def drift_bundle(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Manifest]:
    sess = fx.make(tmp_path_factory.mktemp("sess") / "drift-session", drift=fx.DRIFT)
    out = tmp_path_factory.mktemp("out") / "drift.bundle"
    rep = build_bundle(
        inputs_from_session(load_session(sess)), out, BundleOptions(k=3, tile_frames=256)
    )
    return out, rep.manifest


def test_drift_every_note_within_one_frame(drift_bundle) -> None:  # type: ignore[no-untyped-def]
    """Acceptance (Phase 3A): gradual slow-down, +-40 ms rubato and per-part latency."""
    root, m = drift_bundle
    _check_notes(root, m, fx.DRIFT)


def test_drift_part_latency(drift_bundle) -> None:  # type: ignore[no-untyped-def]
    _, m = drift_bundle
    assert m.score is not None
    lat = [p.latency_sec for p in m.score.parts]
    truth = fx.DRIFT.part_latency
    # reported relative to the typical part (median), so compare differences
    for i in range(len(truth)):
        assert lat[i] is not None
        assert (lat[i] - lat[0]) == pytest.approx(truth[i] - truth[0], abs=0.006), lat


def test_measures_in_audio_seconds(bundle) -> None:  # type: ignore[no-untyped-def]
    _, m = bundle
    frame = m.hop / m.sr
    starts = [x.start_s for x in m.score.measures]  # type: ignore[union-attr]
    want = [fx.q_to_seconds(4 * i) + fx.OFFSET for i in range(6)]
    assert np.allclose(starts, want, atol=frame)


def test_fundamental_flags(bundle) -> None:  # type: ignore[no-untyped-def]
    root, m = bundle
    cols = _notes(root, m)
    bass = cols["part"] == 2
    assert (cols["f0_ok"][bass] == 0).all()
    assert (cols["f0_ok"][~bass] == 1).all()
    assert (cols["f0_db"][~bass] > -30).all()


def test_no_f0_tracks_when_score_present(bundle) -> None:  # type: ignore[no-untyped-def]
    _, m = bundle
    assert "f0_hz" not in {t.name for t in m.tables}


def test_manual_offset_and_f0_tracks_without_score(tmp_path: Path) -> None:
    sess = fx.make(tmp_path / "s")
    (sess / "score.musicxml").unlink()
    out = tmp_path / "midi-only.bundle"
    rep = build_bundle(
        inputs_from_session(load_session(sess)), out, BundleOptions(k=1, offset=0.537, f0="yin")
    )
    s = rep.manifest.score
    assert s is not None and s.kind == "midi" and s.alignment.method == "manual"
    assert s.alignment.offset_sec == pytest.approx(0.537)
    assert [p.name for p in s.parts] == ["Flute", "Clarinet in B♭", "Double Bass", "Piano"]
    f0 = next(t for t in rep.manifest.tables if t.name == "f0_hz")
    arr = np.frombuffer((out / f0.path).read_bytes(), "<f4").reshape(f0.shape)
    # flute plays C5 (523 Hz) at the start: t = offset + 0.2 s
    fr = round((0.537 + 0.2) * m_sr(rep) / rep.manifest.hop)
    assert arr[0, fr] == pytest.approx(523.25, rel=0.02)


def m_sr(rep) -> int:  # type: ignore[no-untyped-def]
    return rep.manifest.sr


def test_report_on_synthetic_session(bundle, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    from orchspec.report import build_report, to_markdown

    root, _ = bundle
    rep = build_report(root)
    status = {c.name: c.status for c in rep.checks}
    assert status["midi_sounding_pitch"] == "PASS"
    assert status["time_origin"] == "PASS"
    assert status["notes_inside_audio"] == "PASS"
    assert status["notes_in_instrument_range"] == "PASS"
    assert status["stem_separation"] == "PASS"  # synthetic stems are perfectly dry
    bass = next(r for r in rep.parts if r.name == "Double Bass")
    assert bass.weak_f0_pct == 100 and bass.stem_match == "name"
    assert all(r.weak_f0_pct == 0 for r in rep.parts if r.name != "Double Bass")
    md = to_markdown(rep)
    assert "| midi_sounding_pitch | PASS |" in md and "Double Bass" in md


def test_cli_report(bundle, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    from typer.testing import CliRunner

    from orchspec.cli import app

    root, _ = bundle
    copy = tmp_path / "copy.bundle"
    shutil.copytree(root, copy)
    r = CliRunner().invoke(app, ["report", str(copy)])
    assert r.exit_code == 0, r.output
    assert "[PASS] midi_sounding_pitch" in r.output
    assert (copy / "report.md").is_file() and (copy / "report.json").is_file()
