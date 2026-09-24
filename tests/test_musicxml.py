import io
import zipfile
from pathlib import Path

import pytest

from orchspec.score.musicxml import ScoreError, parse_musicxml
from orchspec.score.repeats import UnsupportedRepeatError
from tests.fixtures import make_score_session as fx


@pytest.fixture
def xml_path(tmp_path: Path) -> Path:
    p = tmp_path / "score.musicxml"
    p.write_text(fx.musicxml(), encoding="utf-8")
    return p


def _key(n) -> tuple:  # type: ignore[no-untyped-def]
    return (round(n["onset_q"], 6), n["part"], n["midi"], n["staff"], round(n["dur_q"], 6))


def test_notes_match_independent_truth(xml_path: Path) -> None:
    s = parse_musicxml(xml_path)
    got = sorted(
        _key(
            {
                "onset_q": n.onset_q,
                "part": n.part,
                "midi": n.midi,
                "staff": n.staff,
                "dur_q": n.dur_q,
            }
        )
        for n in s.notes
    )
    want = sorted(_key(t) for t in fx.truth_notes())
    assert got == want


def test_parts_transposition_and_structure(xml_path: Path) -> None:
    s = parse_musicxml(xml_path)
    assert [p.name for p in s.parts] == ["Flute", "Clarinet in B\u266d", "Double Bass", "Piano"]
    clar, bass, piano = s.parts[1], s.parts[2], s.parts[3]
    assert (clar.transpose_chromatic, clar.transpose_octave) == (-2, 0)
    assert (bass.transpose_chromatic, bass.transpose_octave) == (0, -1)
    assert piano.staves == 2 and bass.instrument == "Contrabass"
    # written D5 on the clarinet sounds C5
    first_clar = next(n for n in s.notes if n.part == 1)
    assert (first_clar.written_midi, first_clar.midi) == (74, 72)
    # playback order 1 2 3 2 4 5, pass numbers, measure starts
    assert [m.number for m in s.played] == ["1", "2", "3", "2", "4", "5"]
    assert [m.pass_no for m in s.played] == [1, 1, 1, 2, 2, 1]
    assert [m.start_q for m in s.played] == [0, 4, 8, 12, 16, 20]
    assert s.total_q == 24
    assert s.tempos == [(0.0, 120.0), (16.0, 90.0)]


def test_staff_and_voice_kept_distinct(xml_path: Path) -> None:
    s = parse_musicxml(xml_path)
    piano = [n for n in s.notes if n.part == 3]
    assert {n.staff for n in piano} == {1, 2}
    m2 = [n for n in piano if n.play_measure == 1 and n.staff == 1]
    assert len({n.voice for n in m2}) == 2  # voice 1 A4 and voice 2 F4
    f4 = next(n for n in m2 if n.midi == 65)
    assert f4.beat == pytest.approx(3.0)


def test_tie_across_barline_merged(xml_path: Path) -> None:
    s = parse_musicxml(xml_path)
    # clarinet: written F#5 half + F#5 half tied into the next bar -> sounding E5
    e5 = [n for n in s.notes if n.part == 1 and n.midi == 76]
    assert [(n.onset_q, n.dur_q) for n in e5] == [(16.0, 2.0), (18.0, 4.0)]


def _minimal(body: str, extra_measure_xml: str = "") -> str:
    return f"""<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>X</part-name>
</score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1
</divisions></attributes>{body}<note><pitch><step>C</step><octave>4</octave></pitch>
<duration>4</duration></note></measure>{extra_measure_xml}</part></score-partwise>"""


@pytest.mark.parametrize(
    "body",
    [
        "<direction><direction-type><segno/></direction-type></direction>",
        "<direction><direction-type><words>D.S. al Coda</words></direction-type></direction>",
        "<direction><direction-type><words>D.C. al Fine</words></direction-type></direction>",
        '<direction><sound dacapo="yes"/></direction>',
        "<direction><direction-type><coda/></direction-type></direction>",
    ],
)
def test_jumps_stop_with_clear_message(tmp_path: Path, body: str) -> None:
    p = tmp_path / "j.musicxml"
    p.write_text(_minimal(body), encoding="utf-8")
    with pytest.raises(UnsupportedRepeatError, match="measure 1 contains a jump"):
        parse_musicxml(p)


def test_words_that_are_not_jumps_are_fine(tmp_path: Path) -> None:
    p = tmp_path / "w.musicxml"
    p.write_text(
        _minimal("<direction><direction-type><words>dolce</words></direction-type></direction>"),
        encoding="utf-8",
    )
    assert len(parse_musicxml(p).notes) == 1


def test_xxe_and_entity_bombs_rejected(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("TOPSECRET")
    xxe = f"""<?xml version="1.0"?><!DOCTYPE s [<!ENTITY x SYSTEM "file:///{secret.as_posix()}">]>
<score-partwise><part-list/><part id="P1"><measure number="1">&x;</measure></part>
</score-partwise>"""
    bomb = """<?xml version="1.0"?><!DOCTYPE s [<!ENTITY a "aaaaaaaaaa">
<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>
<score-partwise><part-list/><part id="P1"><measure number="1">&c;</measure></part>
</score-partwise>"""
    for i, doc in enumerate([xxe, bomb]):
        p = tmp_path / f"evil{i}.musicxml"
        p.write_text(doc, encoding="utf-8")
        with pytest.raises(Exception) as e:  # defusedxml raises EntitiesForbidden etc.
            parse_musicxml(p)
        assert "TOPSECRET" not in str(e.value)


def _mxl(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_mxl_container(tmp_path: Path) -> None:
    container = (
        b'<?xml version="1.0"?><container><rootfiles>'
        b'<rootfile full-path="music/score.xml"/></rootfiles></container>'
    )
    p = tmp_path / "s.mxl"
    p.write_bytes(
        _mxl({"META-INF/container.xml": container, "music/score.xml": fx.musicxml().encode()})
    )
    assert len(parse_musicxml(p).parts) == 4


@pytest.mark.parametrize("name", ["../evil.xml", "/abs.xml", "C:/x.xml"])
def test_mxl_path_traversal_rejected(tmp_path: Path, name: str) -> None:
    p = tmp_path / "bad.mxl"
    p.write_bytes(_mxl({name: b"<score-partwise/>"}))
    with pytest.raises(ScoreError, match="unsafe member path"):
        parse_musicxml(p)


def test_timewise_rejected(tmp_path: Path) -> None:
    p = tmp_path / "t.musicxml"
    p.write_text('<?xml version="1.0"?><score-timewise/>', encoding="utf-8")
    with pytest.raises(ScoreError, match="score-timewise"):
        parse_musicxml(p)
