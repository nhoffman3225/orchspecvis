from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from typer.testing import CliRunner

from orchspec.cli import app
from orchspec.io.session import RenderConfig, SessionError, load_input, load_session

SR = 8000


def _wav(p: Path, n: int, sr: int = SR, ch: int = 1) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(p), np.zeros((n, ch), dtype=np.float32), sr, subtype="PCM_16")
    return p


def test_valid_session(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 1000, ch=2)
    _wav(tmp_path / "stems" / "01_Flute 1.wav", 1000)
    _wav(tmp_path / "stems" / "02_Violins I.wav", 1000, ch=2)
    (tmp_path / "render.yaml").write_text("renderer: dorico_noteperformer5\npreroll_sec: 1.5\n")
    s = load_session(tmp_path)
    assert [st.stem_id for st in s.stems] == ["01_Flute-1", "02_Violins-I"]
    assert s.config.preroll_sec == 1.5
    assert s.config.renderer == "dorico_noteperformer5"


def test_mix_only_file(tmp_path: Path) -> None:
    s = load_input(_wav(tmp_path / "anything.wav", 500))
    assert s.stems == [] and s.mix.n_samples == 500 and s.config == RenderConfig()


def test_mismatched_length_rejected(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 1000)
    _wav(tmp_path / "stems" / "01_Oboe.wav", 999)
    with pytest.raises(SessionError) as e:
        load_session(tmp_path)
    msg = str(e.value)
    assert "01_Oboe.wav" in msg and "999 samples" in msg and "1000 samples" in msg
    assert "same start and length" in msg


def test_mismatched_sr_rejected(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 1000)
    _wav(tmp_path / "stems" / "03_Horn.wav", 1000, sr=16000)
    with pytest.raises(SessionError, match=r"03_Horn\.wav: sample rate 16000 Hz != mix 8000 Hz"):
        load_session(tmp_path)


def test_all_problems_reported_together(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 1000)
    _wav(tmp_path / "stems" / "01_A.wav", 10)
    _wav(tmp_path / "stems" / "badname.wav", 1000)
    with pytest.raises(SessionError) as e:
        load_session(tmp_path)
    assert "01_A.wav" in str(e.value) and "badname.wav" in str(e.value)


def test_missing_mix_and_stems(tmp_path: Path) -> None:
    with pytest.raises(SessionError, match=r"no mix.wav and no stems"):
        load_session(tmp_path)


def test_mix_summed_from_stems(tmp_path: Path) -> None:
    """Without mix.wav the stems are summed (mono stems into every channel) into a temp
    mix; the session folder is not written to."""
    t = np.arange(1000) / SR
    flute = (0.25 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    strings = np.stack([0.5 * np.sin(2 * np.pi * 220 * t), 0.1 * np.ones_like(t)], 1)
    (tmp_path / "stems").mkdir()
    sf.write(str(tmp_path / "stems" / "01_Flute.wav"), flute, SR, subtype="FLOAT")
    st = strings.astype(np.float32)
    sf.write(str(tmp_path / "stems" / "02_Strings.wav"), st, SR, subtype="FLOAT")
    before = sorted(p.name for p in tmp_path.rglob("*"))
    s = load_session(tmp_path)
    assert s.mix_summed and s.mix.channels == 2 and s.mix.n_samples == 1000
    assert s.mix.path.parent != tmp_path and sorted(p.name for p in tmp_path.rglob("*")) == before
    mix, _ = sf.read(str(s.mix.path), dtype="float32", always_2d=True)
    np.testing.assert_allclose(mix[:, 0], flute + strings[:, 0], atol=1e-6)
    np.testing.assert_allclose(mix[:, 1], flute + strings[:, 1], atol=1e-6)


def test_stems_without_mix_must_match_each_other(tmp_path: Path) -> None:
    _wav(tmp_path / "stems" / "01_A.wav", 1000)
    _wav(tmp_path / "stems" / "02_B.wav", 900)
    with pytest.raises(SessionError, match=r"02_B\.wav: length 900 samples .* != the first stem"):
        load_session(tmp_path)


def test_bad_render_yaml_mentions_template(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 100)
    (tmp_path / "render.yaml").write_text("renderer: dorico\nunknown_key: 1\n")
    with pytest.raises(SessionError, match="session-template"):
        load_session(tmp_path)


def test_urls_rejected() -> None:
    with pytest.raises(ValueError, match="local filesystem"):
        load_input("https://example.com/mix.wav")


def test_template_roundtrips(tmp_path: Path) -> None:
    r = CliRunner().invoke(app, ["session-template", str(tmp_path)])
    assert r.exit_code == 0, r.output
    _wav(tmp_path / "mix.wav", 100)
    assert load_session(tmp_path).config.renderer == "dorico_noteperformer5"


def test_cli_validate_error_exit(tmp_path: Path) -> None:
    _wav(tmp_path / "mix.wav", 1000)
    _wav(tmp_path / "stems" / "01_Oboe.wav", 5)
    r = CliRunner().invoke(app, ["validate", str(tmp_path)])
    assert r.exit_code == 2


def test_unreadable_mix_is_a_session_error(tmp_path: Path) -> None:
    (tmp_path / "mix.wav").write_bytes(b"not a wav file")
    with pytest.raises(SessionError, match="unreadable audio"):
        load_session(tmp_path)
    with pytest.raises(SessionError, match="unreadable audio"):
        load_input(tmp_path / "mix.wav")
    r = CliRunner().invoke(app, ["validate", str(tmp_path)])
    assert r.exit_code == 2 and "unreadable audio" in r.output
