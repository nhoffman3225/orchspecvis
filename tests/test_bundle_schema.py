"""Python half of the cross-language schema test.

The committed viewer/public/tiny-bundle/manifest.json is produced by the Python writer;
viewer/src/bundle.test.ts parses the same file with the TypeScript loader.
"""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from orchspec.bundle.schema import Manifest
from tests.fixtures.make_tiny_bundle import DEFAULT_OUT, build

COMMITTED = DEFAULT_OUT / "manifest.json"


def test_committed_tiny_bundle_is_current(tmp_path: Path) -> None:
    m = build(tmp_path)
    assert json.loads(COMMITTED.read_text(encoding="utf-8")) == json.loads(m.model_dump_json()), (
        "run: uv run python tests/fixtures/make_tiny_bundle.py"
    )
    for lod in m.lods:
        for t in lod.tiles:
            assert (DEFAULT_OUT / t.path).read_bytes() == (tmp_path / t.path).read_bytes()


def test_manifest_roundtrip() -> None:
    raw = COMMITTED.read_text(encoding="utf-8")
    m = Manifest.model_validate_json(raw)
    assert Manifest.model_validate_json(m.model_dump_json()) == m
    assert m.bin_to_midi((69 - 21) * m.k) == 69


@pytest.mark.parametrize(
    ("mutate", "err"),
    [
        (lambda d: d.update(audio_path="../secret.wav"), "inside the bundle"),
        (lambda d: d.update(audio_path="C:/x.wav"), "inside the bundle"),
        (lambda d: d["lods"][0]["tiles"][0].update(path="/etc/passwd"), "inside the bundle"),
        (lambda d: d.update(n_frames=d["n_frames"] + 1), "n_frames"),
        (lambda d: d.update(schema_version=4), "schema_version"),
        (lambda d: d.update(surprise=1), "surprise"),
        (lambda d: d["lods"][1].update(n_frames=999), "level 1"),
    ],
)
def test_manifest_rejects(mutate, err: str) -> None:  # type: ignore[no-untyped-def]
    d = json.loads(COMMITTED.read_text(encoding="utf-8"))
    mutate(d)
    with pytest.raises(ValidationError, match=err):
        Manifest.model_validate(d)
