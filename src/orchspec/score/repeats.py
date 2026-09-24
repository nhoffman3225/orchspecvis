"""Playback order of measures: repeat barlines + numbered endings only.

Jumps (segno, coda, D.C., D.S., fine, to coda) are detected by the MusicXML parser and
rejected with UnsupportedRepeatError before this runs.
"""

from __future__ import annotations

from dataclasses import dataclass


class UnsupportedRepeatError(ValueError):
    """The score uses a repeat construct orchspec does not unroll. Message is for users."""


@dataclass(frozen=True)
class RepeatInfo:
    number: str  # displayed measure number (for messages)
    forward: bool = False  # repeat sign at the start of the measure
    backward: bool = False  # repeat sign at the end of the measure
    times: int = 2  # total passes for a backward repeat (MusicXML `times`)
    ending: tuple[int, ...] | None = None  # passes this measure is played on (endings)
    ending_group: int | None = None  # identifies one ending bracket (its extent)


def parse_ending_numbers(text: str) -> tuple[int, ...]:
    """'1, 2' / '1.' / '1-3' -> (1, 2) / (1,) / (1, 2, 3)."""
    out: list[int] = []
    for part in text.replace(";", ",").replace(" ", ",").split(","):
        part = part.strip().rstrip(".")
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    if not out:
        raise UnsupportedRepeatError(f"ending number {text!r} is not a list of pass numbers")
    return tuple(out)


def playback_order(info: list[RepeatInfo], max_factor: int = 50) -> list[tuple[int, int]]:
    """Measures in playback order as (source_index, pass_number)."""
    n = len(info)
    order: list[tuple[int, int]] = []
    i = 0
    section_start = 0
    pass_no = 1
    jumped = False
    done_jumps: dict[int, int] = {}
    limit = max_factor * max(n, 1) + 1000
    while i < n:
        if len(order) > limit:
            raise UnsupportedRepeatError(
                "repeat structure does not terminate (inconsistent repeat barlines?)"
            )
        m = info[i]
        if m.forward and not jumped:
            section_start = i
            pass_no = 1
        jumped = False
        if m.ending is not None and pass_no not in m.ending:
            j = i
            while j < n and info[j].ending_group == m.ending_group:
                j += 1
            i = j
            continue
        order.append((i, pass_no))
        if m.backward:
            done = done_jumps.get(i, 0)
            if done < m.times - 1:
                done_jumps[i] = done + 1
                pass_no += 1
                i = section_start
                jumped = True
                continue
            done_jumps[i] = 0
            section_start = i + 1
            pass_no = 1
        elif m.ending is not None and (i + 1 >= n or info[i + 1].ending is None):
            # left the final ending bracket: the repeated section is over
            section_start = i + 1
            pass_no = 1
        i += 1
    return order
