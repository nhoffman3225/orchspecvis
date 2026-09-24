"""Minimal, bounded Standard MIDI File reader (format 0/1, PPQ timing).

Reads only what orchspec needs: the tempo map, time signatures, track names and notes.
Written from the SMF 1.0 spec to avoid a dependency; every length is bounds-checked
because render.mid is untrusted input.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from pathlib import Path

from orchspec.io.audio import require_local_path

MAX_BYTES = 64 * 1024 * 1024
MAX_TRACKS = 1024
MAX_EVENTS = 5_000_000
DEFAULT_TEMPO = 500_000  # us per quarter (120 bpm)


class MidiError(ValueError):
    """render.mid could not be read. Message is for users."""


@dataclass(frozen=True)
class MidiNote:
    track: int
    channel: int
    pitch: int
    velocity: int
    on_tick: int
    off_tick: int


@dataclass
class MidiFile:
    fmt: int
    ppq: int
    tempos: list[tuple[int, int]]  # (tick, us per quarter), sorted, starts at tick 0
    time_sigs: list[tuple[int, int, int]]  # (tick, numerator, denominator)
    track_names: list[str]
    notes: list[MidiNote]
    _sec_at: list[float] = field(default_factory=list, repr=False)

    def __post_init__(self) -> None:
        acc = 0.0
        self._sec_at = []
        for i, (tick, _us) in enumerate(self.tempos):
            if i:
                pt, pus = self.tempos[i - 1]
                acc += (tick - pt) * pus / 1e6 / self.ppq
            self._sec_at.append(acc)

    def tick_to_seconds(self, tick: float) -> float:
        i = bisect.bisect_right([t for t, _ in self.tempos], tick) - 1
        i = max(i, 0)
        t0, us = self.tempos[i]
        return self._sec_at[i] + (tick - t0) * us / 1e6 / self.ppq

    def quarters_to_seconds(self, q: float) -> float:
        return self.tick_to_seconds(q * self.ppq)

    @property
    def end_tick(self) -> int:
        return max((n.off_tick for n in self.notes), default=0)


class _Reader:
    def __init__(self, data: bytes, start: int, end: int) -> None:
        self.d, self.i, self.end = data, start, end

    def byte(self) -> int:
        if self.i >= self.end:
            raise MidiError("render.mid: truncated track")
        b = self.d[self.i]
        self.i += 1
        return b

    def take(self, n: int) -> bytes:
        if n < 0 or self.i + n > self.end:
            raise MidiError("render.mid: event length runs past the end of the track")
        b = self.d[self.i : self.i + n]
        self.i += n
        return b

    def vlq(self) -> int:
        v = 0
        for _ in range(4):
            b = self.byte()
            v = (v << 7) | (b & 0x7F)
            if not b & 0x80:
                return v
        raise MidiError("render.mid: variable-length quantity longer than 4 bytes")


def parse_midi_bytes(data: bytes) -> MidiFile:
    if len(data) > MAX_BYTES:
        raise MidiError("render.mid: file too large")
    if len(data) < 14 or data[:4] != b"MThd":
        raise MidiError("render.mid: not a Standard MIDI File (missing MThd)")
    hlen = int.from_bytes(data[4:8], "big")
    if hlen < 6 or 8 + hlen > len(data):
        raise MidiError("render.mid: bad header length")
    fmt = int.from_bytes(data[8:10], "big")
    ntrks = int.from_bytes(data[10:12], "big")
    division = int.from_bytes(data[12:14], "big")
    if fmt not in (0, 1):
        raise MidiError(f"render.mid: MIDI format {fmt} is not supported (use format 0 or 1)")
    if division & 0x8000:
        raise MidiError(
            "render.mid: SMPTE time division is not supported; export with ticks per quarter note"
        )
    if division == 0 or ntrks > MAX_TRACKS:
        raise MidiError("render.mid: bad header (division or track count)")
    ppq = division

    pos = 8 + hlen
    tempos: list[tuple[int, int]] = []
    sigs: list[tuple[int, int, int]] = []
    names: list[str] = []
    notes: list[MidiNote] = []
    n_events = 0
    for trk in range(ntrks):
        # skip unknown chunks
        while pos + 8 <= len(data) and data[pos : pos + 4] != b"MTrk":
            clen = int.from_bytes(data[pos + 4 : pos + 8], "big")
            pos += 8 + clen
        if pos + 8 > len(data):
            raise MidiError(f"render.mid: expected {ntrks} tracks, found {trk}")
        tlen = int.from_bytes(data[pos + 4 : pos + 8], "big")
        start, end = pos + 8, pos + 8 + tlen
        if end > len(data):
            raise MidiError("render.mid: track chunk runs past the end of the file")
        pos = end
        r = _Reader(data, start, end)
        tick = 0
        status = 0
        name = ""
        open_notes: dict[tuple[int, int], list[tuple[int, int]]] = {}
        while r.i < end:
            n_events += 1
            if n_events > MAX_EVENTS:
                raise MidiError("render.mid: too many events")
            tick += r.vlq()
            b = r.byte()
            if b == 0xFF:
                mtype = r.byte()
                payload = r.take(r.vlq())
                if mtype == 0x51 and len(payload) == 3:
                    tempos.append((tick, int.from_bytes(payload, "big")))
                elif mtype == 0x58 and len(payload) >= 2:
                    sigs.append((tick, payload[0], 2 ** payload[1]))
                elif mtype == 0x03 and not name:
                    name = payload.decode("utf-8", errors="replace").strip()
                elif mtype == 0x2F:
                    break
                continue
            if b in (0xF0, 0xF7):
                r.take(r.vlq())
                continue
            if b & 0x80:
                status = b
                d1 = r.byte()
            else:
                if not status:
                    raise MidiError("render.mid: running status without a status byte")
                d1 = b
            kind, ch = status & 0xF0, status & 0x0F
            if kind in (0xC0, 0xD0):
                continue
            d2 = r.byte()
            if kind == 0x90 and d2 > 0:
                open_notes.setdefault((ch, d1), []).append((tick, d2))
            elif kind == 0x80 or (kind == 0x90 and d2 == 0):
                stack = open_notes.get((ch, d1))
                if stack:
                    on, vel = stack.pop(0)
                    notes.append(
                        MidiNote(
                            track=trk, channel=ch, pitch=d1, velocity=vel, on_tick=on, off_tick=tick
                        )
                    )
        for (ch, p), stack in open_notes.items():  # unterminated notes end at track end
            for on, vel in stack:
                notes.append(
                    MidiNote(
                        track=trk, channel=ch, pitch=p, velocity=vel, on_tick=on, off_tick=tick
                    )
                )
        names.append(name)

    tempos.sort()
    if not tempos or tempos[0][0] != 0:
        tempos.insert(0, (0, DEFAULT_TEMPO))
    # keep the last tempo at a given tick
    dedup: dict[int, int] = {}
    for t, us in tempos:
        dedup[t] = us
    notes.sort(key=lambda n: (n.on_tick, n.track, n.pitch))
    return MidiFile(
        fmt=fmt,
        ppq=ppq,
        tempos=sorted(dedup.items()),
        time_sigs=sorted(sigs),
        track_names=names,
        notes=notes,
    )


def parse_midi(path: str | Path) -> MidiFile:
    p = require_local_path(path)
    if p.stat().st_size > MAX_BYTES:
        raise MidiError(f"{p.name}: file too large")
    return parse_midi_bytes(p.read_bytes())
