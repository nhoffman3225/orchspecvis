"""Synthetic score session: MusicXML + render.mid + rendered audio with a known offset.

    uv run python -m tests.fixtures.make_score_session [session/score-demo]

Four parts (Flute; Clarinet in Bb, chromatic -2; Double Bass, octave-change -1 and
rendered WITHOUT its fundamental; Piano, 2 staves with chords and a 2nd voice), a repeat
with 1st/2nd endings, a tie across a barline, a grace note, and a tempo change 120 -> 90.

Playback order is 1 2 3 2 4 5 (hard-coded here, independent of the repeat unroller), so
the ground truth below does not reuse orchspec's own logic.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

from tests.fixtures.smf import write_smf

SR = 22_050
PPQ = 480
PREROLL = 0.5  # declared in render.yaml
RESIDUAL = 0.037  # renderer latency the aligner must find
OFFSET = PREROLL + RESIDUAL
PLAY_ORDER = [0, 1, 2, 1, 3, 4]  # source measure indices
TEMPO_CHANGE_Q = 16.0  # playback quarter where 90 bpm starts (measure 4)
STEP_NAMES = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"]
STEP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]


@dataclass(frozen=True)
class N:
    written: int  # written MIDI pitch
    off: float  # quarters from measure start
    dur: float
    staff: int = 1
    voice: int = 1
    chord: bool = False
    tie: str = ""  # "", "start", "stop", "both"
    grace: bool = False


# part id, name, instrument, transpose (chromatic, octave_change), staves, missing_f0
PARTS = [
    ("P1", "Flute", "Flute", (0, 0), 1, False),
    ("P2", "Clarinet in B♭", "Clarinet in B♭", (-2, 0), 1, False),
    ("P3", "Double Bass", "Contrabass", (0, -1), 1, True),
    ("P4", "Piano", "Piano", (0, 0), 2, False),
]

# MEASURES[source][part] -> notes (written pitch)
MEASURES: list[list[list[N]]] = [
    [  # m1
        [N(72, 0, 1), N(74, 1, 1), N(76, 2, 2)],
        [N(74, 0, 2), N(76, 2, 2)],
        [N(55 + 12, 0, 4)],
        [
            N(60, 0, 2),
            N(64, 0, 2, chord=True),
            N(67, 0, 2, chord=True),
            N(48, 0, 4, staff=2, voice=5),
        ],
    ],
    [  # m2 (forward repeat)
        [N(77, 0, 4)],
        [N(79, 0, 4)],
        [N(60 + 12, 0, 4)],
        [N(69, 0, 2), N(65, 2, 2, voice=2), N(53, 0, 4, staff=2, voice=5)],
    ],
    [  # m3 (1st ending, backward repeat)
        [N(79, 0, 2), N(79, 2, 2)],
        [N(81, 0, 4)],
        [N(62 + 12, 0, 4)],
        [N(55, 0, 4, staff=2, voice=5)],
    ],
    [  # m4 (2nd ending), tempo 90
        [N(76, 0, 4)],
        [N(78, 0, 2), N(78, 2, 2, tie="start")],
        [N(60 + 12, 0, 4)],
        [N(72, 0, 4), N(48, 0, 4, staff=2, voice=5)],
    ],
    [  # m5
        [N(71, 0, 0, grace=True), N(72, 0, 4)],
        [N(78, 0, 2, tie="stop"), N(74, 2, 2)],
        [N(55 + 12, 0, 4)],
        [N(60, 0, 4), N(48, 0, 4, staff=2, voice=5)],
    ],
]


def q_to_seconds(q: float) -> float:
    if q <= TEMPO_CHANGE_Q:
        return q * 0.5
    return TEMPO_CHANGE_Q * 0.5 + (q - TEMPO_CHANGE_Q) * (60.0 / 90.0)


def truth_notes() -> list[dict[str, float]]:
    """Sounding notes in playback order with ties merged: part, staff, midi, onset_q, dur_q,
    onset_s, offset_s (MIDI time; audio time = + OFFSET)."""
    out: list[dict[str, float]] = []
    for pi, (_pid, _n, _i, (chrom, octv), _st, _mf) in enumerate(PARTS):
        pend: dict[tuple[int, int], int] = {}
        for play_i, src in enumerate(PLAY_ORDER):
            for n in MEASURES[src][pi]:
                if n.grace:
                    continue
                sound = n.written + chrom + 12 * octv
                onset = play_i * 4 + n.off
                key = (n.staff, sound)
                if n.tie in ("stop", "both") and key in pend:
                    out[pend[key]]["dur_q"] = onset + n.dur - out[pend[key]]["onset_q"]
                    if n.tie == "stop":
                        del pend[key]
                    continue
                out.append(
                    {"part": pi, "staff": n.staff, "midi": sound, "onset_q": onset, "dur_q": n.dur}
                )
                if n.tie in ("start", "both"):
                    pend[key] = len(out) - 1
    for t in out:
        t["onset_s"] = q_to_seconds(t["onset_q"])
        t["offset_s"] = q_to_seconds(t["onset_q"] + t["dur_q"])
    out.sort(key=lambda t: (t["onset_q"], t["part"], t["midi"]))
    return out


# ------------------------------------------------------------------------ MusicXML


def _pitch_xml(midi: int) -> str:
    step, alter, octave = STEP_NAMES[midi % 12], STEP_ALTER[midi % 12], midi // 12 - 1
    a = f"<alter>{alter}</alter>" if alter else ""
    return f"<pitch><step>{step}</step>{a}<octave>{octave}</octave></pitch>"


def _note_xml(n: N, div: int) -> str:
    parts = ["<note>"]
    if n.grace:
        parts.append("<grace/>")
    if n.chord:
        parts.append("<chord/>")
    parts.append(_pitch_xml(n.written))
    if not n.grace:
        parts.append(f"<duration>{round(n.dur * div)}</duration>")
    for t in (
        ["start"]
        if n.tie == "start"
        else ["stop"]
        if n.tie == "stop"
        else ["stop", "start"]
        if n.tie == "both"
        else []
    ):
        parts.append(f'<tie type="{t}"/>')
    parts.append(f"<voice>{n.voice}</voice><type>quarter</type><staff>{n.staff}</staff>")
    if n.tie:
        parts.append(
            "<notations>"
            + "".join(f'<tied type="{t}"/>' for t in (["start"] if n.tie == "start" else ["stop"]))
            + "</notations>"
        )
    parts.append("</note>")
    return "".join(parts)


def musicxml() -> str:
    div = 4
    out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
        '"http://www.musicxml.org/dtds/partwise.dtd">',
        '<score-partwise version="4.0"><part-list>',
    ]
    for pid, name, inst, _t, _s, _m in PARTS:
        out.append(
            f'<score-part id="{pid}"><part-name>{name}</part-name>'
            f'<score-instrument id="{pid}-I1"><instrument-name>{inst}</instrument-name>'
            f"</score-instrument></score-part>"
        )
    out.append("</part-list>")
    for pi, (pid, _n, _i, (chrom, octv), staves, _m) in enumerate(PARTS):
        out.append(f'<part id="{pid}">')
        for mi in range(len(MEASURES)):
            out.append(f'<measure number="{mi + 1}">')
            if mi == 1:
                out.append('<barline location="left"><repeat direction="forward"/></barline>')
            if mi == 2:
                out.append('<barline location="left"><ending number="1" type="start"/></barline>')
            if mi == 3:
                out.append('<barline location="left"><ending number="2" type="start"/></barline>')
            if mi == 0:
                tr = ""
                if chrom or octv:
                    tr = (
                        f"<transpose><diatonic>{-1 if chrom == -2 else 0}</diatonic>"
                        f"<chromatic>{chrom}</chromatic>"
                        + (f"<octave-change>{octv}</octave-change>" if octv else "")
                        + "</transpose>"
                    )
                out.append(
                    f"<attributes><divisions>{div}</divisions><key><fifths>0</fifths>"
                    f"</key><time><beats>4</beats><beat-type>4</beat-type></time>"
                    f"<staves>{staves}</staves>{tr}</attributes>"
                )
                if pi == 0:
                    out.append(
                        '<direction placement="above"><direction-type><metronome>'
                        "<beat-unit>quarter</beat-unit><per-minute>120</per-minute>"
                        '</metronome></direction-type><sound tempo="120"/></direction>'
                    )
            if mi == 3 and pi == 0:
                out.append(
                    "<direction><direction-type><words>Meno mosso</words>"
                    '</direction-type><sound tempo="90"/></direction>'
                )
            notes = MEASURES[mi][pi]
            by_staff: dict[int, list[N]] = {}
            for n in notes:
                by_staff.setdefault(n.staff, []).append(n)
            for si, staff in enumerate(sorted(by_staff)):
                if si:
                    out.append(f"<backup><duration>{4 * div}</duration></backup>")
                voices: dict[int, list[N]] = {}
                for n in by_staff[staff]:
                    voices.setdefault(n.voice, []).append(n)
                for vi, v in enumerate(sorted(voices)):
                    if vi:
                        out.append(f"<backup><duration>{4 * div}</duration></backup>")
                    cursor = 0.0
                    for n in voices[v]:
                        if not n.chord and not n.grace and n.off > cursor:
                            out.append(
                                f"<forward><duration>{round((n.off - cursor) * div)}"
                                f"</duration></forward>"
                            )
                            cursor = n.off
                        out.append(_note_xml(n, div))
                        if not n.chord and not n.grace:
                            cursor += n.dur
            if mi == 2:
                out.append(
                    '<barline location="right"><ending number="1" type="stop"/>'
                    '<repeat direction="backward"/></barline>'
                )
            if mi == 3:
                out.append(
                    '<barline location="right"><ending number="2" type="discontinue"/></barline>'
                )
            out.append("</measure>")
        out.append("</part>")
    out.append("</score-partwise>")
    return "\n".join(out)


# ------------------------------------------------------------------------ MIDI + audio


def render_mid() -> bytes:
    tracks = []
    truth = truth_notes()
    for pi, (_pid, name, _i, _t, _s, _m) in enumerate(PARTS):
        ev = [
            (
                round(t["onset_q"] * PPQ),
                round((t["onset_q"] + t["dur_q"]) * PPQ),
                pi,
                int(t["midi"]),
                90,
            )
            for t in truth
            if t["part"] == pi
        ]
        tracks.append((name, ev))
    return write_smf(PPQ, [(0, 120.0), (round(TEMPO_CHANGE_Q * PPQ), 90.0)], tracks)


def _tone(midi: float, dur: float, harmonics: list[int], amp: float) -> np.ndarray:
    t = np.arange(round(dur * SR)) / SR
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    y = sum(np.sin(2 * np.pi * h * f0 * t) / h for h in harmonics if h * f0 < SR / 2 * 0.9)
    atk = np.minimum(1.0, t / 0.005)  # sharp attack so onsets are well defined
    rel = np.minimum(1.0, np.maximum(0.0, dur - t) / 0.03)
    return (amp * atk * rel * y).astype(np.float32)


def render_audio() -> tuple[np.ndarray, dict[str, np.ndarray]]:
    truth = truth_notes()
    n = round((OFFSET + q_to_seconds(24.0) + 1.0) * SR)
    stems: dict[str, np.ndarray] = {}
    for pi, (_pid, name, _i, _t, _s, missing_f0) in enumerate(PARTS):
        y = np.zeros(n, np.float32)
        harm = [2, 3, 4, 5] if missing_f0 else [1, 2, 3, 4]
        for t in (t for t in truth if t["part"] == pi):
            seg = _tone(t["midi"], t["offset_s"] - t["onset_s"], harm, 0.08)
            i = round((t["onset_s"] + OFFSET) * SR)
            y[i : i + len(seg)] += seg[: n - i]
        stems[f"{pi + 1:02d}_{name.replace(chr(0x266D), 'b')}"] = y
    mix = np.sum(list(stems.values()), axis=0).astype(np.float32)
    return mix, stems


def make(dest: Path) -> Path:
    (dest / "stems").mkdir(parents=True, exist_ok=True)
    (dest / "score.musicxml").write_text(musicxml(), encoding="utf-8")
    (dest / "render.mid").write_bytes(render_mid())
    mix, stems = render_audio()
    sf.write(dest / "mix.wav", mix, SR, subtype="FLOAT")
    for name, y in stems.items():
        sf.write(dest / "stems" / f"{name}.wav", y, SR, subtype="FLOAT")
    (dest / "render.yaml").write_text(
        f"renderer: dorico_noteperformer5\npreroll_sec: {PREROLL}\n", encoding="utf-8"
    )
    return dest


if __name__ == "__main__":
    here = Path(__file__).resolve().parents[2]
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "session" / "score-demo"
    print(f"wrote {make(target)}")
