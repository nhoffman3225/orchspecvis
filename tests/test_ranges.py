import pytest

from orchspec.score.ranges import find_range, load_ranges


def test_ranges_yaml_is_valid_and_complete() -> None:
    r = load_ranges()
    assert len(r) >= 25
    for key in ("flute", "clarinet_bb", "horn_f", "violin", "double_bass", "piano", "timpani"):
        assert key in r
    assert r["piano"].sounding_range == (21, 108)


@pytest.mark.parametrize(
    ("name", "want"),
    [
        ("Flute 1", "flute"),
        ("Piccolo", "piccolo"),
        ("Clarinet in B♭ 2", "clarinet_bb"),
        ("Bass Clarinet in B♭", "bass_clarinet"),
        ("Horn in F 3", "horn_f"),
        ("Violins I", "violin"),
        ("Violoncello", "cello"),
        ("Double Bass", "double_bass"),
        ("Contrabass", "double_bass"),
        ("Bass Trombone", "bass_trombone"),
        ("02_Viola", "viola"),
    ],
)
def test_find_range(name: str, want: str) -> None:
    got = find_range(name)
    assert got is not None and got[0] == want


def test_no_match() -> None:
    assert find_range("Theremin") is None
