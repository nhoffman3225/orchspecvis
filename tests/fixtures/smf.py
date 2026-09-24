"""Tiny Standard MIDI File writer for tests (format 1, PPQ)."""

from __future__ import annotations


def _vlq(v: int) -> bytes:
    out = [v & 0x7F]
    v >>= 7
    while v:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    return bytes(reversed(out))


def _track(events: list[tuple[int, bytes]], running_status: bool = False) -> bytes:
    body = b""
    last = 0
    prev_status = None
    for tick, ev in sorted(events, key=lambda e: (e[0], e[1][0] & 0xF0 == 0x90)):
        body += _vlq(tick - last)
        last = tick
        if running_status and ev[0] < 0xF0 and ev[0] == prev_status:
            body += ev[1:]
        else:
            body += ev
        prev_status = ev[0] if ev[0] < 0xF0 else prev_status
    body += b"\x00\xff\x2f\x00"
    return b"MTrk" + len(body).to_bytes(4, "big") + body


def write_smf(
    ppq: int,
    tempos: list[tuple[int, float]],
    tracks: list[tuple[str, list[tuple[int, int, int, int, int]]]],
    running_status: bool = True,
) -> bytes:
    """tempos: (tick, bpm); tracks: (name, [(on_tick, off_tick, channel, pitch, vel)])."""
    t0: list[tuple[int, bytes]] = []
    for tick, bpm in tempos:
        us = round(60_000_000 / bpm)
        t0.append((tick, b"\xff\x51\x03" + us.to_bytes(3, "big")))
    t0.append((0, b"\xff\x58\x04\x04\x02\x18\x08"))
    chunks = [_track(t0)]
    for name, notes in tracks:
        evs: list[tuple[int, bytes]] = [(0, b"\xff\x03" + _vlq(len(name.encode())) + name.encode())]
        for on, off, ch, p, v in notes:
            evs.append((on, bytes([0x90 | ch, p, v])))
            # note-off as note-on with velocity 0 (common in exporters; exercises that path)
            evs.append((off, bytes([0x90 | ch, p, 0])))
        chunks.append(_track(evs, running_status))
    header = (
        b"MThd"
        + (6).to_bytes(4, "big")
        + (1).to_bytes(2, "big")
        + len(chunks).to_bytes(2, "big")
        + ppq.to_bytes(2, "big")
    )
    return header + b"".join(chunks)
