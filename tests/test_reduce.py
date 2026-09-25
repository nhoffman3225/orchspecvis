"""Score reduction (score/reduce.py) on the synthetic score session: concert pitch with
the score's spelling, unisons merged, ids mapping back to parts, bars kept."""

import json
from fractions import Fraction
from pathlib import Path

import pytest
from defusedxml import ElementTree as DET

from orchspec.score.reduce import (
    Spelled,
    beat_length,
    reduce_score,
    transpose_spelled,
    write_reductions,
)
from tests.fixtures import make_score_session as fx


def test_transposed_spelling() -> None:
    d = Spelled(step=1, alter=0, octave=4)  # written D4
    # clarinet in Bb: diatonic -1, chromatic -2 -> C4
    assert transpose_spelled(d, -1, -2, 0) == Spelled(0, 0, 4)
    # horn in F: -4 / -7 -> G3
    assert transpose_spelled(d, -4, -7, 0) == Spelled(4, 0, 3)
    # written E4 on Bb clarinet -> D4; written F#4 -> E4
    assert transpose_spelled(Spelled(3, 1, 4), -1, -2, 0).name == "E4"
    # double bass sounds an octave lower
    assert transpose_spelled(d, 0, 0, -1) == Spelled(1, 0, 3)
    assert Spelled(6, -1, 3).name == "B♭3"


@pytest.fixture(scope="module")
def session(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return fx.make(tmp_path_factory.mktemp("sess") / "score-session")


def test_tutti_reduction(session: Path) -> None:
    xml, side = reduce_score(session / "score.musicxml", "tutti")
    root = DET.fromstring(xml)
    parts = root.findall("part")
    assert len(parts) == 1
    measures = parts[0].findall("measure")
    src_root = DET.parse(session / "score.musicxml").getroot()
    assert src_root is not None
    src = src_root.find("part")
    assert src is not None
    assert [m.get("number") for m in measures] == [m.get("number") for m in src.findall("measure")]
    notes = side["notes"]
    assert isinstance(notes, dict)
    xml_ids = {n.get("id") for n in root.iter("note") if n.get("id")}
    assert xml_ids == set(notes)  # every pitched note is mapped, nothing else
    # every sounding pitch of the fixture appears, at concert pitch
    truth = {round(t["midi"]) for t in fx.truth_notes()}
    assert {v["midi"] for v in notes.values()} == truth
    for v in notes.values():
        assert v["parts"] and all(0 <= p < 4 for p in v["parts"])


def test_sections_and_files(session: Path, tmp_path: Path) -> None:
    out = write_reductions(session / "score.musicxml", tmp_path)
    assert [m for m, _, _ in out] == [
        "chords",
        "beat-chords",
        "section-chords",
        "section-beat-chords",
    ]
    side = json.loads((tmp_path / out[2][2]).read_text(encoding="utf-8"))
    # fixture: flute + clarinet (woodwinds), piano (keyboards), bass (strings)
    assert side["groups"] == ["woodwinds", "keyboards", "strings"]


def test_chord_per_bar(session: Path) -> None:
    xml, side = reduce_score(session / "score.musicxml", "chords")
    root = DET.fromstring(xml)
    assert "<tie" not in xml and "<tied" not in xml
    notes = side["notes"]
    assert isinstance(notes, dict)
    for m in root.find("part").findall("measure"):  # type: ignore[union-attr]
        # at most one chord per staff: every pitched note after the first on a staff is
        # a chord member
        for staff in ("1", "2"):
            on_staff = [n for n in m.findall("note") if n.findtext("staff") == staff]
            pitched = [n for n in on_staff if n.find("pitch") is not None]
            assert sum(1 for n in pitched if n.find("chord") is None) <= 1
    # every bar index in the map is a real bar
    n_bars = len(root.find("part").findall("measure"))  # type: ignore[union-attr]
    assert all(0 <= int(v["bar"]) < n_bars for v in notes.values())


def test_beat_length() -> None:
    assert beat_length(("4", "4")) == 1
    assert beat_length(("2", "2")) == 2
    assert beat_length(("3", "8")) == Fraction(1, 2)  # simple triple: eighth beats
    assert beat_length(("6", "8")) == Fraction(3, 2)  # compound: dotted quarter
    assert beat_length(("12", "8")) == Fraction(3, 2)
    assert beat_length(None) == 1


def test_chord_per_beat(session: Path) -> None:
    """One chord (or rest) per beat on each staff, no ties, and every sounding pitch of
    the score appears; a note held across beats is repeated in each beat it sounds."""
    xml, side = reduce_score(session / "score.musicxml", "beat-chords")
    root = DET.fromstring(xml)
    assert "<tie" not in xml and "<tied" not in xml
    part = root.find("part")
    assert part is not None
    divisions = int(root.findtext(".//divisions") or 1)
    beats = None
    for m in part.findall("measure"):
        beats = int(m.findtext(".//time/beats") or beats or 4)
        for staff in ("1", "2"):
            on = [n for n in m.findall("note") if n.findtext("staff") == staff]
            heads = [n for n in on if n.find("chord") is None]  # one per beat, or a bar rest
            if len(heads) == 1 and heads[0].find("rest") is not None:
                continue
            assert all(int(n.findtext("duration") or 0) == divisions for n in heads)
            assert len(heads) == beats
    notes = side["notes"]
    assert isinstance(notes, dict)
    truth = {round(t["midi"]) for t in fx.truth_notes()}
    assert {v["midi"] for v in notes.values()} == truth
    per_bar, _ = reduce_score(session / "score.musicxml", "chords")
    assert len(notes) >= per_bar.count("<pitch>")  # held notes repeat per beat
