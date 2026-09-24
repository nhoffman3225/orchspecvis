"""Dorico export folder -> session layout (synthetic files named like Dorico 5 exports)."""

import os
from pathlib import Path

import numpy as np
import soundfile as sf
from typer.testing import CliRunner

from orchspec.cli import app
from orchspec.io.dorico import apply_import, plan_import
from orchspec.io.session import load_session
from tests.fixtures import make_score_session as fx


def _dorico_export(root: Path) -> Path:
    flow = root / "Flows from Demo" / "01 - Allegro"
    flow.mkdir(parents=True)
    y = np.zeros((800, 2), np.float32)
    sf.write(flow / "Demo - Allegro.wav", y, 8000)
    # player names as Dorico writes them (key in parentheses, instrument changes with &)
    for player in ["Piano", "Double Bass", "Clarinet (Bb)", "Flute", "Piccolo"]:
        sf.write(flow / f"Demo - Allegro {player}.wav", y, 8000)
    (root / "Demo - Full score - 01 Allegro.musicxml").write_text(fx.musicxml(), encoding="utf-8")
    (root / "Demo - Full score - Allegro.mid").write_bytes(fx.render_mid())
    return root


def test_plan_orders_stems_by_score_and_flags_extras(tmp_path: Path) -> None:
    plan = plan_import(_dorico_export(tmp_path / "export"))
    assert plan.mix.name == "Demo - Allegro.wav"
    # score part order: Flute, Clarinet in Bb, Double Bass, Piano; Piccolo is not in the score
    assert [n for n, _ in plan.stems] == [
        "Flute",
        "Clarinet (Bb)",
        "Double Bass",
        "Piano",
        "Piccolo",
    ]
    assert plan.midi is not None and plan.score is not None
    assert any("Piccolo" in w for w in plan.warnings)


def test_apply_links_in_place_and_is_rerunnable(tmp_path: Path) -> None:
    src = _dorico_export(tmp_path / "export")
    plan = plan_import(src)
    log = apply_import(plan, src)
    assert any(line.startswith(("linked", "copied")) for line in log)
    s = load_session(src)
    assert [st.player for st in s.stems] == [
        "Flute",
        "Clarinet (Bb)",
        "Double Bass",
        "Piano",
        "Piccolo",
    ]
    assert s.midi_path is not None and s.score_path is not None
    assert s.config.renderer == "dorico_noteperformer5"
    # hard link (same file) when the filesystem allows it; originals untouched
    if (src / "mix.wav").stat().st_nlink > 1:
        assert os.path.samefile(src / "mix.wav", plan.mix)
    # running again changes nothing and does not pick up its own output
    again = plan_import(src)
    assert [n for n, _ in again.stems] == [n for n, _ in plan.stems]
    assert all("exists" in line or "render.yaml" not in line for line in apply_import(again, src))


def test_cli_dry_run(tmp_path: Path) -> None:
    src = _dorico_export(tmp_path / "export")
    r = CliRunner().invoke(app, ["import-dorico", str(src), "--dry-run"])
    assert r.exit_code == 0, r.output
    assert "stem 01: Flute" in r.output and not (src / "mix.wav").exists()
