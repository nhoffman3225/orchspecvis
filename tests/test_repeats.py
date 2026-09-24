import pytest

from orchspec.score.repeats import (
    RepeatInfo,
    UnsupportedRepeatError,
    parse_ending_numbers,
    playback_order,
)


def _order(info: list[RepeatInfo]) -> list[int]:
    return [i for i, _ in playback_order(info)]


def R(**kw) -> RepeatInfo:  # type: ignore[no-untyped-def]
    return RepeatInfo(number="?", **kw)


def test_no_repeats() -> None:
    assert _order([R(), R(), R()]) == [0, 1, 2]


def test_simple_repeat_from_start() -> None:
    assert _order([R(), R(backward=True), R()]) == [0, 1, 0, 1, 2]


def test_forward_backward_and_times() -> None:
    info = [R(), R(forward=True), R(backward=True, times=3), R()]
    assert _order(info) == [0, 1, 2, 1, 2, 1, 2, 3]


def test_first_and_second_endings() -> None:
    # | 0 |: 1 | 2 |1. 3 :|2. 4 | 5 ||
    info = [
        R(),
        R(forward=True),
        R(),
        R(ending=(1,), ending_group=1, backward=True),
        R(ending=(2,), ending_group=2),
        R(),
    ]
    got = playback_order(info)
    assert [i for i, _ in got] == [0, 1, 2, 3, 1, 2, 4, 5]
    assert [p for _, p in got] == [1, 1, 1, 1, 2, 2, 2, 1]


def test_multi_measure_endings_and_shared_numbers() -> None:
    # |: 0 |1.,2. 1 2 :|3. 3 ||  played three times
    info = [
        R(forward=True),
        R(ending=(1, 2), ending_group=1),
        R(ending=(1, 2), ending_group=1, backward=True, times=3),
        R(ending=(3,), ending_group=2),
    ]
    assert _order(info) == [0, 1, 2, 0, 1, 2, 0, 3]


def test_two_repeat_sections() -> None:
    # |0 :|: 1 2 3 :| 4
    info = [R(backward=True), R(forward=True), R(), R(backward=True), R()]
    assert _order(info) == [0, 0, 1, 2, 3, 1, 2, 3, 4]


def test_ending_numbers_parse() -> None:
    assert parse_ending_numbers("1, 2") == (1, 2)
    assert parse_ending_numbers("1.") == (1,)
    assert parse_ending_numbers("1-3") == (1, 2, 3)
    with pytest.raises(UnsupportedRepeatError):
        parse_ending_numbers("")
