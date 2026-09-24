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
    assert m2.schema_version == 2 and m2.score is not None
    s = m2.score
    assert s.kind == "musicxml" and s.source_files == ["score.musicxml", "render.mid"]
    assert [p.stem_match for p in s.parts] == ["name"] * 4
    assert [p.stem_id for p in s.parts] == [st.id for st in m2.stems]
    assert [x.number for x in s.measures] == ["1", "2", "3", "2", "4", "5"]
    assert s.alignment.method == "xcorr" and s.alignment.time_source == "midi"
    assert s.alignment.pitch_agreement == 1.0
    assert s.notes.n == len(fx.truth_notes())


def test_every_note_within_one_frame(bundle) -> None:  # type: ignore[no-untyped-def]
    root, m = bundle
    cols = _notes(root, m)
    frame = m.hop / m.sr
    truth = sorted(fx.truth_notes(), key=lambda t: (t["onset_s"], t["part"], t["midi"]))
    order = np.lexsort((cols["midi"], cols["part"], cols["onset_s"]))
    for t, i in zip(truth, order, strict=True):
        assert cols["part"][i] == t["part"] and cols["midi"][i] == t["midi"]
        assert abs(cols["onset_s"][i] - (t["onset_s"] + fx.OFFSET)) < frame
        assert abs(cols["offset_s"][i] - (t["offset_s"] + fx.OFFSET)) < frame
    assert abs(m.score.alignment.offset_sec - fx.OFFSET) < frame  # type: ignore[union-attr]


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
