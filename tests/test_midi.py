import pytest

from orchspec.timeline.midi import MidiError, parse_midi_bytes
from tests.fixtures.smf import write_smf


def test_tempo_map_and_notes() -> None:
    ppq = 480
    data = write_smf(
        ppq,
        [(0, 120.0), (4 * ppq, 60.0)],
        [
            ("Flute", [(0, ppq, 0, 72, 90), (4 * ppq, 5 * ppq, 0, 74, 80)]),
            ("Horn", [(ppq, 3 * ppq, 1, 60, 70)]),
        ],
    )
    m = parse_midi_bytes(data)
    assert m.ppq == 480 and m.fmt == 1
    assert m.track_names == ["", "Flute", "Horn"]
    assert [(n.pitch, n.on_tick, n.off_tick, n.track) for n in m.notes] == [
        (72, 0, 480, 1),
        (60, 480, 1440, 2),
        (74, 1920, 2400, 1),
    ]
    # 4 quarters at 120 bpm = 2 s, then 60 bpm: 1 quarter = 1 s
    assert m.quarters_to_seconds(4) == pytest.approx(2.0)
    assert m.quarters_to_seconds(5) == pytest.approx(3.0)
    assert m.tick_to_seconds(240) == pytest.approx(0.25)


def test_default_tempo_when_missing() -> None:
    data = write_smf(96, [], [("x", [(0, 96, 0, 60, 64)])])
    assert parse_midi_bytes(data).quarters_to_seconds(1) == pytest.approx(0.5)


@pytest.mark.parametrize(
    ("mutate", "msg"),
    [
        (lambda d: b"RIFF" + d[4:], "MThd"),
        (lambda d: d[:10] + (5).to_bytes(2, "big") + d[12:], "expected 5 tracks"),
        (lambda d: d[:8] + (2).to_bytes(2, "big") + d[10:], "format 2"),
        (lambda d: d[:12] + (0xE728).to_bytes(2, "big") + d[14:], "SMPTE"),
        (lambda d: d[:-6], None),  # truncated
    ],
)
def test_malformed_rejected(mutate, msg) -> None:  # type: ignore[no-untyped-def]
    good = write_smf(96, [(0, 100.0)], [("x", [(0, 96, 0, 60, 64)])])
    bad = mutate(good)
    with pytest.raises(MidiError, match=msg):
        parse_midi_bytes(bad)


def test_huge_vlq_rejected() -> None:
    good = write_smf(96, [(0, 100.0)], [("x", [(0, 96, 0, 60, 64)])])
    # corrupt the first delta time of track 2 into an endless VLQ
    i = good.rindex(b"MTrk") + 8
    bad = good[:i] + b"\xff\xff\xff\xff\xff" + good[i:]
    with pytest.raises(MidiError):
        parse_midi_bytes(bad)
