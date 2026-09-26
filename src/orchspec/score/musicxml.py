"""Safe MusicXML (score-partwise) reader: .musicxml / .xml / .mxl.

Security: parsed with defusedxml (no entity expansion, no external DTD/entity fetch);
.mxl archives are checked for member count, per-member and total uncompressed size, and
path traversal before anything is read.

Semantics (see PLAN.md "Unverified assumptions"):
- <pitch> is the written pitch; sounding = written + transpose chromatic
  + 12 * octave-change. In concert scores Dorico only emits octave transpositions, so the
  same rule holds. <double> adds a note an octave below (above="yes": above).
- <octave-shift> (8va) is display-only in MusicXML (pitch data is already true pitch).
- Grace notes are skipped (no duration). Cue notes advance time but do not sound.
- Ties (<tie type="start|stop">) are merged into one sounding note.
- Jumps (segno, coda, D.C., D.S., fine, to coda) raise UnsupportedRepeatError.
"""

from __future__ import annotations

import contextlib
import re
import zipfile
from dataclasses import dataclass, field, replace
from fractions import Fraction
from pathlib import Path, PurePosixPath
from typing import Any

import defusedxml.ElementTree as SafeET

from orchspec.io.audio import require_local_path
from orchspec.score.model import Note, Part, PlayedMeasure, Score
from orchspec.score.repeats import (
    RepeatInfo,
    UnsupportedRepeatError,
    parse_ending_numbers,
    playback_order,
)

MAX_XML_BYTES = 200 * 1024 * 1024
MAX_MXL_MEMBERS = 2000
MAX_MXL_TOTAL = 300 * 1024 * 1024
MAX_BPM = 10_000.0  # <sound tempo> beyond this is not a tempo

STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
JUMP_WORDS = re.compile(
    r"^\s*(d\.?\s*c\.?|d\.?\s*s\.?|da\s+capo|dal\s+segno|to\s+coda|fine)\b", re.IGNORECASE
)
JUMP_SOUND_ATTRS = ("segno", "coda", "dacapo", "dalsegno", "fine", "tocoda")

Element = Any  # xml.etree Element (defusedxml returns stdlib elements)


class ScoreError(ValueError):
    """MusicXML could not be read. Message is for users."""


# ----------------------------------------------------------------------------- loading


def _read_mxl(path: Path) -> bytes:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise ScoreError(f"{path.name}: not a valid .mxl (zip) file") from e
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MXL_MEMBERS:
            raise ScoreError(f"{path.name}: too many archive members ({len(infos)})")
        total = 0
        for zi in infos:
            name = PurePosixPath(zi.filename)
            if zi.filename.startswith(("/", "\\")) or ".." in name.parts or ":" in zi.filename:
                raise ScoreError(f"{path.name}: unsafe member path {zi.filename!r}")
            total += zi.file_size
            if zi.file_size > MAX_XML_BYTES or total > MAX_MXL_TOTAL:
                raise ScoreError(f"{path.name}: archive too large when uncompressed")
        names = {zi.filename for zi in infos}
        root_name = None
        if "META-INF/container.xml" in names:
            container = SafeET.fromstring(_read_member(zf, "META-INF/container.xml"))
            for rf in container.iter():
                if _local(rf.tag) == "rootfile" and rf.get("full-path"):
                    root_name = rf.get("full-path")
                    break
        if root_name is None:
            cands = sorted(
                n
                for n in names
                if n.lower().endswith((".musicxml", ".xml")) and not n.startswith("META-INF/")
            )
            if not cands:
                raise ScoreError(f"{path.name}: no MusicXML document inside the archive")
            root_name = cands[0]
        if root_name not in names:
            raise ScoreError(f"{path.name}: rootfile {root_name!r} missing from archive")
        return _read_member(zf, root_name)


def _read_member(zf: zipfile.ZipFile, name: str) -> bytes:
    with zf.open(name) as f:
        data = f.read(MAX_XML_BYTES + 1)
    if len(data) > MAX_XML_BYTES:
        raise ScoreError(f"archive member {name!r} too large")
    return data


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def load_musicxml_root(path: str | Path) -> Element:
    p = require_local_path(path)
    if p.suffix.lower() == ".mxl":
        data = _read_mxl(p)
    else:
        if p.stat().st_size > MAX_XML_BYTES:
            raise ScoreError(f"{p.name}: file too large")
        data = p.read_bytes()
    try:
        root = SafeET.fromstring(data)
    except SafeET.ParseError as e:
        raise ScoreError(f"{p.name}: malformed XML ({e})") from e
    tag = _local(root.tag)
    if tag == "score-timewise":
        raise ScoreError(
            f"{p.name}: score-timewise MusicXML is not supported; "
            "export score-partwise (the default in Dorico/Sibelius/MuseScore)"
        )
    if tag != "score-partwise":
        raise ScoreError(f"{p.name}: not a MusicXML score (root <{tag}>)")
    return root


# ----------------------------------------------------------------------------- parsing


def _text(el: Element | None, default: str = "") -> str:
    return el.text.strip() if el is not None and el.text else default


def _int(el: Element | None, default: int) -> int:
    try:
        return int(float(_text(el)))
    except ValueError:
        return default


@dataclass
class _RawNote:
    offset: Fraction  # quarters from measure start
    dur: Fraction
    staff: int
    voice: str
    written: float
    unpitched: bool
    tie_start: bool
    tie_stop: bool
    transpose: int  # semitones written -> sounding
    double: int  # 0, -12 or +12


@dataclass
class _Measure:
    number: str
    dur: Fraction = Fraction(0)
    beats: int = 4
    beat_type: int = 4
    notes: list[_RawNote] = field(default_factory=list)
    tempos: list[tuple[Fraction, float]] = field(default_factory=list)
    forward: bool = False
    backward: bool = False
    times: int = 2
    ending_start: tuple[int, ...] | None = None  # an ending bracket starts here
    ending_stop: bool = False  # an ending bracket stops/discontinues here
    jumps: list[str] = field(default_factory=list)


def _pitch_midi(el: Element) -> tuple[float, bool] | None:
    pitch = el.find("pitch")
    if pitch is not None:
        step = _text(pitch.find("step")).upper()
        if step not in STEP:
            return None
        alter = float(_text(pitch.find("alter"), "0") or 0)
        octave = _int(pitch.find("octave"), 4)
        return (octave + 1) * 12 + STEP[step] + alter, False
    unp = el.find("unpitched")
    if unp is not None:
        step = _text(unp.find("display-step"), "E").upper()
        octave = _int(unp.find("display-octave"), 4)
        return (octave + 1) * 12 + STEP.get(step, 4), True
    return None


def _parse_part(part_el: Element, part_name: str) -> list[_Measure]:
    divisions = 1
    beats, beat_type = 4, 4
    transpose = 0
    double = 0
    out: list[_Measure] = []
    for m_el in part_el.findall("measure"):
        m = _Measure(number=m_el.get("number", str(len(out) + 1)), beats=beats, beat_type=beat_type)
        cursor = Fraction(0)
        high = Fraction(0)
        last_onset = Fraction(0)
        for el in m_el:
            tag = _local(el.tag)
            if tag == "attributes":
                d = el.find("divisions")
                if d is not None:
                    divisions = max(1, _int(d, 1))
                t = el.find("time")
                if t is not None and t.find("beats") is not None:
                    try:
                        b = int(_text(t.find("beats")).split("+")[0])
                        bt = int(_text(t.find("beat-type"), "4"))
                        if b >= 1 and bt >= 1:  # 0 would divide by zero downstream
                            beats, beat_type = b, bt
                    except ValueError:
                        pass
                    m.beats, m.beat_type = beats, beat_type
                tr = el.find("transpose")
                if tr is not None:
                    transpose = _int(tr.find("chromatic"), 0) + 12 * _int(
                        tr.find("octave-change"), 0
                    )
                    dbl = tr.find("double")
                    double = 0 if dbl is None else (12 if dbl.get("above") == "yes" else -12)
            elif tag == "note":
                dur = Fraction(_int(el.find("duration"), 0), divisions)
                is_chord = el.find("chord") is not None
                if el.find("grace") is not None:
                    continue
                onset = last_onset if is_chord else cursor
                if not is_chord:
                    last_onset = cursor
                    cursor += dur
                    high = max(high, cursor)
                if el.find("rest") is not None or el.find("cue") is not None:
                    continue
                pm = _pitch_midi(el)
                if pm is None:
                    continue
                ties = [t.get("type") for t in el.findall("tie")]
                m.notes.append(
                    _RawNote(
                        offset=onset,
                        dur=dur,
                        staff=_int(el.find("staff"), 1),
                        voice=_text(el.find("voice"), "1"),
                        written=pm[0],
                        unpitched=pm[1],
                        tie_start="start" in ties,
                        tie_stop="stop" in ties,
                        transpose=transpose,
                        double=double,
                    )
                )
            elif tag == "backup":
                cursor -= Fraction(_int(el.find("duration"), 0), divisions)
                cursor = max(cursor, Fraction(0))
            elif tag == "forward":
                cursor += Fraction(_int(el.find("duration"), 0), divisions)
                high = max(high, cursor)
            elif tag in ("direction", "sound"):
                sounds = [el] if tag == "sound" else el.findall("sound")
                for snd in sounds:
                    if snd.get("tempo"):
                        with contextlib.suppress(ValueError):
                            bpm = float(snd.get("tempo"))
                            if 0 < bpm <= MAX_BPM:  # also rejects nan / inf
                                m.tempos.append((cursor, bpm))
                    for a in JUMP_SOUND_ATTRS:
                        if snd.get(a):
                            m.jumps.append(a)
                if tag == "direction":
                    for dt in el.findall("direction-type"):
                        for child in dt:
                            ct = _local(child.tag)
                            if ct in ("segno", "coda"):
                                m.jumps.append(ct)
                            elif ct == "words" and child.text and JUMP_WORDS.match(child.text):
                                m.jumps.append(child.text.strip())
            elif tag == "barline":
                rep = el.find("repeat")
                if rep is not None:
                    if rep.get("direction") == "forward":
                        m.forward = True
                    elif rep.get("direction") == "backward":
                        m.backward = True
                        m.times = _int_attr(rep.get("times"), 2)
                for child in el:
                    if _local(child.tag) in ("segno", "coda"):
                        m.jumps.append(_local(child.tag))
                end = el.find("ending")
                if end is not None:
                    if end.get("type") == "start":
                        try:
                            m.ending_start = parse_ending_numbers(end.get("number", ""))
                        except ValueError as e:
                            raise UnsupportedRepeatError(
                                f"{part_name}, measure {m.number}: unreadable ending number "
                                f"{end.get('number')!r}"
                            ) from e
                    elif end.get("type") in ("stop", "discontinue"):
                        m.ending_stop = True
        m.dur = high
        out.append(m)
    return out


def parse_musicxml(path: str | Path) -> Score:
    root = load_musicxml_root(path)
    name = Path(str(path)).name
    parts_meta: dict[str, dict[str, Any]] = {}
    pl = root.find("part-list")
    order: list[str] = []
    if pl is not None:
        for sp in pl.findall("score-part"):
            pid = sp.get("id", "")
            inst = sp.find("score-instrument")
            midi = sp.find("midi-instrument")
            parts_meta[pid] = {
                "name": _text(sp.find("part-name"), pid),
                "abbr": _text(sp.find("part-abbreviation")),
                "instrument": _text(inst.find("instrument-name")) if inst is not None else "",
                "channel": _int(midi.find("midi-channel"), 0) if midi is not None else 0,
                "program": _int(midi.find("midi-program"), 0) if midi is not None else 0,
            }
            order.append(pid)

    part_els = root.findall("part")
    if not part_els:
        raise ScoreError(f"{name}: no <part> elements")
    parsed: list[tuple[Part, list[_Measure]]] = []
    for i, pel in enumerate(part_els):
        pid = pel.get("id", f"P{i + 1}")
        meta = parts_meta.get(pid, {})
        pname = meta.get("name") or pid
        # staves and first transposition for the Part record
        staves = 1
        tr_c = tr_o = 0
        for att in pel.iter("attributes"):
            st = att.find("staves")
            if st is not None:
                staves = max(staves, _int(st, 1))
            tr = att.find("transpose")
            if tr is not None and not (tr_c or tr_o):
                tr_c = _int(tr.find("chromatic"), 0)
                tr_o = _int(tr.find("octave-change"), 0)
        measures = _parse_part(pel, pname)
        part = Part(
            index=i,
            id=pid,
            name=pname,
            instrument=meta.get("instrument") or pname,
            abbreviation=meta.get("abbr", ""),
            staves=staves,
            transpose_chromatic=tr_c,
            transpose_octave=tr_o,
            midi_channel=meta.get("channel") or None,
            midi_program=meta.get("program") or None,
        )
        parsed.append((part, measures))

    n = len(parsed[0][1])
    for part, ms in parsed:
        if len(ms) != n:
            raise ScoreError(f"{name}: part {part.name!r} has {len(ms)} measures, expected {n}")
        for m in ms:
            if m.jumps:
                raise UnsupportedRepeatError(
                    f"{name}: {part.name}, measure {m.number} contains a jump "
                    f"({', '.join(sorted(set(m.jumps)))}). orchspec unrolls repeat barlines "
                    "and numbered endings only; export the score with jumps written out "
                    "(or remove D.C./D.S./segno/coda) and re-export MusicXML and MIDI."
                )

    # repeat structure: first part is authoritative; others must agree on repeats
    info = parsed[0][1]
    rinfo = _endings(info)
    order_play = playback_order(rinfo)

    # measure lengths: max over parts (handles pickups / incomplete measures)
    lengths = [max((ms[i].dur for _, ms in parsed), default=Fraction(0)) for i in range(n)]
    played: list[PlayedMeasure] = []
    starts: list[Fraction] = []  # exact start of each played measure
    q = Fraction(0)
    for pi, (si, pass_no) in enumerate(order_play):
        m0 = info[si]
        dur = lengths[si] or Fraction(m0.beats * 4, m0.beat_type)
        played.append(
            PlayedMeasure(
                play_index=pi,
                source_index=si,
                number=m0.number,
                start_q=float(q),
                dur_q=float(dur),
                beats=m0.beats,
                beat_type=m0.beat_type,
                pass_no=pass_no,
            )
        )
        starts.append(q)
        q += dur

    notes: list[Note] = []
    for part, ms in parsed:
        voices: dict[str, int] = {}
        pending: dict[tuple[int, float], int] = {}  # tie start (staff, midi) -> note index
        part_notes: list[Note] = []
        for pm, start in zip(played, starts, strict=True):
            m = ms[pm.source_index]
            beat_len = Fraction(4, max(1, m.beat_type))
            for rn in sorted(m.notes, key=lambda r: r.offset):
                onset = start + rn.offset
                sounding = rn.written + rn.transpose
                vi = voices.setdefault(rn.voice, len(voices) + 1)
                pitches = [sounding] + ([sounding + rn.double] if rn.double else [])
                for s in pitches:
                    key = (rn.staff, s)
                    if rn.tie_stop and key in pending:
                        idx = pending[key]
                        old = part_notes[idx]
                        part_notes[idx] = replace(old, dur_q=float(onset + rn.dur) - old.onset_q)
                        if not rn.tie_start:
                            del pending[key]
                        continue
                    part_notes.append(
                        Note(
                            part=part.index,
                            staff=rn.staff,
                            voice=vi,
                            midi=s,
                            written_midi=rn.written,
                            onset_q=float(onset),
                            dur_q=float(rn.dur),
                            play_measure=pm.play_index,
                            beat=1.0 + float(rn.offset / beat_len),
                            unpitched=rn.unpitched,
                        )
                    )
                    if rn.tie_start:
                        pending[key] = len(part_notes) - 1
        notes.extend(part_notes)
    notes.sort(key=lambda x: (x.onset_q, x.part, x.midi))

    tempos: list[tuple[float, float]] = []
    for pm in played:
        for off, bpm in parsed[0][1][pm.source_index].tempos:
            tempos.append((pm.start_q + float(off), bpm))
    # other parts may carry the tempo marks (Dorico writes them on the top staff only)
    if not tempos:
        for _, ms in parsed[1:]:
            for pm in played:
                for off, bpm in ms[pm.source_index].tempos:
                    tempos.append((pm.start_q + float(off), bpm))
    tempos = sorted(set(tempos))

    return Score(
        parts=[p for p, _ in parsed], played=played, notes=notes, tempos=tempos, source=name
    )


def _int_attr(v: str | None, default: int) -> int:
    try:
        return int(v) if v else default
    except ValueError:
        return default


def _endings(ms: list[_Measure]) -> list[RepeatInfo]:
    """Repeat info per measure, with ending brackets spread over their full extent."""
    info: list[RepeatInfo] = []
    current: tuple[int, ...] | None = None
    group = 0
    for m in ms:
        if m.ending_start is not None:
            current = m.ending_start
            group += 1
        info.append(
            RepeatInfo(
                number=m.number,
                forward=m.forward,
                backward=m.backward,
                times=m.times,
                ending=current,
                ending_group=group if current is not None else None,
            )
        )
        if m.ending_stop:
            current = None
    return info
