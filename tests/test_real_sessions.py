"""LOCAL ONLY: bundle + report every real session in session/ (git-ignored).

    uv run pytest -m real -s

Never runs in CI or in a plain `pytest` (see conftest.py). Asserts only what must hold
for any valid session; the report's PASS/WARN checks are printed for review rather than
asserted, because they are what we are trying to learn from real data.
"""

from pathlib import Path

import pytest

from orchspec.bundle.schema import Manifest
from orchspec.bundle.writer import BundleOptions, build_bundle, inputs_from_session
from orchspec.io.session import load_session
from orchspec.report import build_report, to_markdown
from tests.conftest import TORCH_DEVICE

REPO = Path(__file__).resolve().parents[1]
SESSIONS = sorted(p for p in (REPO / "session").glob("*") if p.is_dir() and any(p.glob("mix.*")))

pytestmark = pytest.mark.real


@pytest.mark.skipif(not SESSIONS, reason="no real sessions in session/")
@pytest.mark.parametrize("sess", SESSIONS, ids=[p.name for p in SESSIONS])
def test_real_session(sess: Path, tmp_path: Path) -> None:
    s = load_session(sess)  # raises with a clear message on layout problems
    out = tmp_path / f"{sess.name}.bundle"
    backend = "torch" if TORCH_DEVICE else "librosa"
    rep = build_bundle(
        inputs_from_session(s), out, BundleOptions(backend=backend, device=TORCH_DEVICE)
    )
    m = Manifest.model_validate_json((out / "manifest.json").read_text(encoding="utf-8"))
    assert m.n_frames == 1 + m.n_samples // m.hop
    assert len(m.stems) == len(s.stems)
    report = build_report(out)
    print(f"\n{to_markdown(report)}\nphases: {rep.seconds}")
    if m.score is not None:
        assert m.score.notes.n > 0
