"""End-to-end bundle writer on a synthetic session; also emits the fixture that the
viewer's vitest cross-language test parses (viewer/test-data/py-bundle, git-ignored)."""

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from typer.testing import CliRunner

from orchspec.bundle.schema import NONE_STEM, Manifest
from orchspec.bundle.writer import BundleOptions, build_bundle, inputs_from_session
from orchspec.cli import app
from orchspec.dsp.tiles import dequantize, read_level
from orchspec.io.session import load_session
from tests.fixtures.make_synthetic import SR, tone

VIEWER_FIXTURE = Path(__file__).resolve().parents[1] / "viewer" / "test-data" / "py-bundle"


@pytest.fixture(scope="module")
def session_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    d = tmp_path_factory.mktemp("session")
    n = SR * 3
    a4 = np.zeros(n, np.float32)
    a4[: SR * 2] = tone(69, seconds=2.0, amp=0.5)
    c4 = np.zeros(n, np.float32)
    c4[SR:] = tone(60, seconds=2.0, amp=0.25)
    (d / "stems").mkdir()
    sf.write(d / "stems" / "01_Oboe.wav", a4, SR, subtype="FLOAT")
    sf.write(d / "stems" / "02_Viola.wav", c4, SR, subtype="FLOAT")
    sf.write(d / "mix.wav", np.stack([a4 + c4, a4 + c4], axis=1), SR, subtype="FLOAT")
    (d / "render.yaml").write_text("renderer: dorico_noteperformer5\npreroll_sec: 0.5\n")
    return d


@pytest.fixture(scope="module")
def bundle(session_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("out") / "s.bundle"
    build_bundle(
        inputs_from_session(load_session(session_dir)), out, BundleOptions(k=3, tile_frames=64)
    )
    VIEWER_FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    shutil.rmtree(VIEWER_FIXTURE, ignore_errors=True)
    shutil.copytree(out, VIEWER_FIXTURE)
    return out


def test_manifest_valid_and_axes_shared(bundle: Path) -> None:
    m = Manifest.model_validate_json((bundle / "manifest.json").read_text(encoding="utf-8"))
    assert m.n_bins == 264 and m.n_frames == 1 + SR * 3 // 512
    assert [s.id for s in m.stems] == ["01_Oboe", "02_Viola"]
    for s in m.stems:
        assert [lod.n_frames for lod in s.lods] == [lod.n_frames for lod in m.lods]
    assert m.offsets.preroll_sec == 0.5
    assert m.source.kind == "session" and m.source.renderer == "dorico_noteperformer5"
    assert {f.name for f in m.features} == {
        "lufs_short_term",
        "spectral_centroid",
        "onset_envelope",
    }
    assert (bundle / m.audio_path).read_bytes()[:4] == b"RIFF"


def test_tiles_have_expected_peaks(bundle: Path) -> None:
    m = Manifest.model_validate_json((bundle / "manifest.json").read_text(encoding="utf-8"))
    mix = dequantize(read_level(bundle, m.lods[0], m.n_bins), m.db_min, m.db_max)
    f_early, f_late = round(0.7 * SR / 512), round(2.5 * SR / 512)
    assert int(mix[f_early].argmax()) == (69 - 21) * 3
    assert int(mix[f_late].argmax()) == (60 - 21) * 3
    # A4 at amp 0.5 -> -6 dB; C4 at amp 0.25 -> -12 dB (within 1 LSB + leakage)
    assert mix[f_early, 144] == pytest.approx(-6.02, abs=0.5)
    assert mix[f_late, 117] == pytest.approx(-12.04, abs=0.5)


def test_dominant_and_energy(bundle: Path) -> None:
    m = Manifest.model_validate_json((bundle / "manifest.json").read_text(encoding="utf-8"))
    assert m.dominant is not None
    dom = read_level(bundle, m.dominant.lods[0], m.n_bins)
    f_early, f_late = round(0.7 * SR / 512), round(2.5 * SR / 512)
    assert dom[f_early, 144] == 0 and dom[f_late, 117] == 1
    assert dom[f_early, 5] == NONE_STEM  # nothing near A0
    tbl = next(t for t in m.tables if t.name == "stem_energy_db")
    # stems without a score/MIDI -> automatic per-stem f0 tracks
    assert {t.name for t in m.tables} == {"stem_energy_db", "f0_hz"}
    e = np.frombuffer((bundle / tbl.path).read_bytes(), "<f4").reshape(tbl.shape)
    assert tbl.row_labels == ["01_Oboe", "02_Viola"]
    t = np.arange(tbl.shape[1]) * tbl.hop_seconds
    early, late = (t > 0.5) & (t < 0.9), (t > 2.2) & (t < 2.8)
    assert e[0, early].mean() > e[1, early].mean() + 30
    assert e[1, late].mean() > e[0, late].mean() + 30


def test_overwrite_protection(bundle: Path, session_dir: Path, tmp_path: Path) -> None:
    with pytest.raises(FileExistsError):
        build_bundle(inputs_from_session(load_session(session_dir)), bundle)
    not_bundle = tmp_path / "precious.bundle"
    not_bundle.mkdir()
    (not_bundle / "notes.txt").write_text("keep me")
    with pytest.raises(FileExistsError, match="not a bundle"):
        build_bundle(inputs_from_session(load_session(session_dir)), not_bundle, overwrite=True)
    assert (not_bundle / "notes.txt").exists()


def test_cli_bundle_single_wav(tmp_path: Path) -> None:
    wav = tmp_path / "solo.wav"
    sf.write(wav, tone(69, seconds=1.0), SR)
    r = CliRunner().invoke(app, ["bundle", str(wav), "-o", str(tmp_path / "out"), "--k", "1"])
    assert r.exit_code == 0, r.output
    man = json.loads((tmp_path / "out" / "solo.bundle" / "manifest.json").read_text())
    assert man["n_bins"] == 88 and man["stems"] == [] and man["dominant"] is None
    assert not any(p.name.startswith(".") for p in (tmp_path / "out").iterdir())
