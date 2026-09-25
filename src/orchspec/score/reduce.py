"""Chord reductions of a MusicXML score, for proofreading harmony and doublings.

All pitched notes of a group of parts are merged at CONCERT pitch onto one grand staff
(treble above middle C, bass below), keeping the score's own spelling (each part's
<transpose> diatonic/chromatic/octave-change applied), its bars, time and key
signatures, repeat barlines and endings. Groups: every part on one grand staff, or one
grand staff per section (short score). Each staff holds one chord per bar, or one per
beat (every pitch sounding during the beat), with no ties; exact unisons merge into one
notehead, and a bar or beat with nothing sounding is a rest. (Full-rhythm reductions,
with voices and ties, proved unreadable and were removed in schema v7.)

Every output note has id "t-<n>"; the sidecar maps it to its source parts and sounding
MIDI (Verovio keeps MusicXML note ids on the SVG elements), so the viewer can say which
parts play a selected note. Grace and cue notes, unpitched notes, lyrics, dynamics and
articulations are dropped: this is a proofreading aid, not an edition.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring  # output only (no parsing)

from orchspec.score.musicxml import load_musicxml_root
from orchspec.score.ranges import find_range

STEPS = "CDEFGAB"
STEP_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
FAMILY_ORDER = ["woodwinds", "brass", "percussion", "keyboards", "strings", "voices", "other"]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _txt(el: Element | None, default: str = "") -> str:
    return (el.text or default).strip() if el is not None else default


def _int(el: Element | None, default: int) -> int:
    try:
        return int(_txt(el, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Spelled:
    step: int  # 0..6
    alter: int
    octave: int

    @property
    def midi(self) -> int:
        return (self.octave + 1) * 12 + STEP_PC[STEPS[self.step]] + self.alter

    @property
    def name(self) -> str:
        acc = {-2: "𝄫", -1: "♭", 0: "", 1: "♯", 2: "𝄪"}.get(self.alter, "?")
        return f"{STEPS[self.step]}{acc}{self.octave}"


def transpose_spelled(s: Spelled, diatonic: int, chromatic: int, octave_change: int) -> Spelled:
    """Written -> sounding spelling: move `diatonic` letter steps (+7 per octave-change),
    then choose the alteration that lands on written + chromatic + 12 * octave-change."""
    target = s.midi + chromatic + 12 * octave_change
    idx = s.step + diatonic + 7 * octave_change
    octave = s.octave + idx // 7
    step = idx % 7
    natural = (octave + 1) * 12 + STEP_PC[STEPS[step]]
    return Spelled(step, target - natural, octave)


@dataclass
class _Note:
    onset: Fraction  # quarters from bar start
    dur: Fraction
    pitch: Spelled


@dataclass
class _Stream:  # one source voice in one bar
    part: int
    notes: list[_Note] = field(default_factory=list)


@dataclass
class _Bar:
    number: str
    length: Fraction = Fraction(0)
    attrs: dict[str, object] = field(default_factory=dict)  # key/time changes (from part 0)
    barlines: list[Element] = field(default_factory=list)  # repeats/endings (from part 0)
    streams: list[_Stream] = field(default_factory=list)


def _parse(root: Element) -> tuple[list[dict[str, str]], list[_Bar]]:
    parts_meta: dict[str, dict[str, str]] = {}
    pl = root.find("part-list")
    if pl is not None:
        for sp in pl.findall("score-part"):
            inst = sp.find("score-instrument")
            parts_meta[sp.get("id", "")] = {
                "name": _txt(sp.find("part-name")),
                "instrument": _txt(inst.find("instrument-name")) if inst is not None else "",
            }
    part_els = root.findall("part")
    bars: list[_Bar] = []
    meta: list[dict[str, str]] = []
    for pi, pel in enumerate(part_els):
        meta.append(parts_meta.get(pel.get("id", ""), {"name": "", "instrument": ""}))
        divisions = 1
        tr = (0, 0, 0)  # diatonic, chromatic, octave-change
        for bi, mel in enumerate(pel.findall("measure")):
            if pi == 0:
                bars.append(_Bar(number=mel.get("number", str(bi + 1))))
            if bi >= len(bars):
                break
            bar = bars[bi]
            streams: dict[str, _Stream] = {}
            cursor = last = Fraction(0)
            high = Fraction(0)
            for el in mel:
                tag = _local(el.tag)
                if tag == "attributes":
                    d = el.find("divisions")
                    if d is not None:
                        divisions = max(1, _int(d, 1))
                    t = el.find("transpose")
                    if t is not None:
                        tr = (
                            _int(t.find("diatonic"), 0),
                            _int(t.find("chromatic"), 0),
                            _int(t.find("octave-change"), 0),
                        )
                    if pi == 0:
                        k, ti = el.find("key"), el.find("time")
                        if k is not None and k.find("fifths") is not None:
                            bar.attrs["fifths"] = _int(k.find("fifths"), 0)
                            bar.attrs["mode"] = _txt(k.find("mode"))
                        if ti is not None and ti.find("beats") is not None:
                            bar.attrs["time"] = (_txt(ti.find("beats")), _txt(ti.find("beat-type")))
                    if pi == 0 or "concert_key" not in bar.attrs:
                        k = el.find("key")
                        if k is not None and tr[1] == 0 and k.find("fifths") is not None:
                            bar.attrs["concert_key"] = _int(k.find("fifths"), 0)
                elif tag == "note":
                    dur = Fraction(_int(el.find("duration"), 0), divisions)
                    chord = el.find("chord") is not None
                    if el.find("grace") is not None:
                        continue
                    onset = last if chord else cursor
                    if not chord:
                        last = cursor
                        cursor += dur
                        high = max(high, cursor)
                    p = el.find("pitch")
                    if p is None or el.find("cue") is not None:
                        continue
                    written = Spelled(
                        STEPS.index(_txt(p.find("step"), "C").upper()),
                        round(float(_txt(p.find("alter"), "0") or 0)),
                        _int(p.find("octave"), 4),
                    )
                    s = streams.setdefault(_txt(el.find("voice"), "1"), _Stream(part=pi))
                    s.notes.append(_Note(onset, dur, transpose_spelled(written, *tr)))
                elif tag == "backup":
                    cursor = max(
                        Fraction(0), cursor - Fraction(_int(el.find("duration"), 0), divisions)
                    )
                elif tag == "forward":
                    cursor += Fraction(_int(el.find("duration"), 0), divisions)
                    high = max(high, cursor)
                elif tag == "barline" and pi == 0:
                    bar.barlines.append(el)
            bar.length = max(bar.length, high)
            bar.streams += [s for s in streams.values() if s.notes]
    return meta, bars


def _family(meta: dict[str, str]) -> str:
    hit = find_range(meta.get("instrument", ""), meta.get("name", ""))
    return hit[1].family if hit else "other"


def _fifths_for(bar: _Bar, prev: int) -> int:
    return int(bar.attrs.get("concert_key", prev))  # type: ignore[call-overload]


@dataclass
class _Event:  # one chord in one voice of one staff
    onset: Fraction
    dur: Fraction
    rhythm: tuple[str, int]  # (note type, dots)
    pitches: dict[int, tuple[Spelled, set[int]]] = field(default_factory=dict)


# length of a bar in quarters -> (note type, dots) for a whole-bar chord
_BAR_TYPE = {
    Fraction(4): ("whole", 0),
    Fraction(6): ("whole", 1),
    Fraction(3): ("half", 1),
    Fraction(2): ("half", 0),
    Fraction(3, 2): ("quarter", 1),
    Fraction(1): ("quarter", 0),
    Fraction(8): ("breve", 0),
    Fraction(5, 2): ("half", 0),
    Fraction(9, 2): ("whole", 0),
}

# one chord per bar or per beat, all parts or per section
MODES = ("chords", "beat-chords", "section-chords", "section-beat-chords")
_PER_BEAT = ("beat-chords", "section-beat-chords")
_BY_SECTION = ("section-chords", "section-beat-chords")

# writable single durations in quarters -> (note type, dots)
_DUR_TYPE = {
    Fraction(8): ("breve", 0),
    Fraction(6): ("whole", 1),
    Fraction(4): ("whole", 0),
    Fraction(3): ("half", 1),
    Fraction(2): ("half", 0),
    Fraction(3, 2): ("quarter", 1),
    Fraction(1): ("quarter", 0),
    Fraction(3, 4): ("eighth", 1),
    Fraction(1, 2): ("eighth", 0),
    Fraction(3, 8): ("16th", 1),
    Fraction(1, 4): ("16th", 0),
    Fraction(1, 8): ("32nd", 0),
}


def beat_length(time: tuple[str, str] | None) -> Fraction:
    """One beat in quarters: the beat-type note, or a dotted beat in compound time
    (6/8, 9/8, 12/8, 6/16 ...: beats divisible by 3, beat type 8 or shorter)."""
    if time is None:
        return Fraction(1)
    try:
        beats, beat_type = int(time[0].split("+")[0]), int(time[1])
    except ValueError:
        return Fraction(1)
    unit = Fraction(4, beat_type) if beat_type > 0 else Fraction(1)
    if beat_type >= 8 and beats % 3 == 0 and beats > 3:
        return unit * 3
    return unit


def _pieces(length: Fraction) -> list[Fraction]:
    """`length` as writable durations, longest first (greedy)."""
    out: list[Fraction] = []
    rest = length
    for d in _DUR_TYPE:  # descending
        while rest >= d:
            out.append(d)
            rest -= d
    return out


def _beat_chords(
    streams: list[_Stream], staff: int, length: Fraction, beat: Fraction
) -> list[list[_Event]]:
    """One chord per beat: every pitch sounding during the beat on this staff (also notes
    held over from earlier), no ties; a beat where nothing sounds is a rest."""
    spans: list[tuple[Fraction, Fraction]] = []
    pos = Fraction(0)
    while pos < length:
        pieces = _pieces(min(beat, length - pos))  # a short last beat (pickup) splits
        if not pieces:  # remainder shorter than a 32nd: not writable
            break
        for d in pieces:
            spans.append((pos, d))
            pos += d
    events = []
    for start, dur in spans:
        ev = _Event(start, dur, _DUR_TYPE[dur])
        for s in streams:
            for n in s.notes:
                if (n.pitch.midi >= 60) != (staff == 1):
                    continue
                if n.onset < start + dur and n.onset + max(n.dur, Fraction(1, 64)) > start:
                    key = n.pitch.midi
                    if key in ev.pitches:
                        ev.pitches[key][1].add(s.part)
                    else:
                        ev.pitches[key] = (n.pitch, {s.part})
        events.append(ev)
    return [events] if any(e.pitches for e in events) else []


def _bar_chord(streams: list[_Stream], staff: int, length: Fraction) -> list[list[_Event]]:
    """Every distinct pitch sounding in the bar on this staff, as one whole-bar chord
    (no rhythm, no ties): a harmonic reduction that stays readable."""
    ev = _Event(Fraction(0), length, _BAR_TYPE.get(length, ("whole", 0)))
    for s in streams:
        for n in s.notes:
            if (n.pitch.midi >= 60) != (staff == 1):
                continue
            key = n.pitch.midi
            if key in ev.pitches:
                ev.pitches[key][1].add(s.part)
            else:
                ev.pitches[key] = (n.pitch, {s.part})
    return [[ev]] if ev.pitches else []


def reduce_score(path: str | Path, mode: str = "chords") -> tuple[str, dict[str, object]]:
    """MusicXML reduction (string) and its sidecar {"notes": {id: {"parts", "midi", "name",
    "group", "bar"}}, "groups", "parts"}.

    mode: "chords" (one chord per bar, all parts on one grand staff), "beat-chords" (one
    chord per beat), "section-chords" / "section-beat-chords" (the same per section).
    """
    if mode not in MODES:
        raise ValueError(f"unknown reduction mode {mode!r}")
    root = load_musicxml_root(path)
    meta, bars = _parse(root)
    fams = [_family(m) for m in meta]
    if mode in _BY_SECTION:
        groups = [(f, {i for i, x in enumerate(fams) if x == f}) for f in FAMILY_ORDER]
        groups = [(f, g) for f, g in groups if g]
    else:
        groups = [("tutti", set(range(len(meta))))]
    divisions = 1
    for bar in bars:
        for s in bar.streams:
            for n in s.notes:
                divisions = math.lcm(divisions, n.onset.denominator, n.dur.denominator)
        divisions = math.lcm(divisions, bar.length.denominator)
    sp = Element("score-partwise", version="4.0")
    plist = SubElement(sp, "part-list")
    ids: dict[str, dict[str, object]] = {}
    n_id = 0
    for gi, (label, _members) in enumerate(groups):
        spart = SubElement(plist, "score-part", id=f"G{gi + 1}")
        SubElement(spart, "part-name").text = label
    for gi, (_label, members) in enumerate(groups):
        part = SubElement(sp, "part", id=f"G{gi + 1}")
        fifths = 0
        time: tuple[str, str] | None = None
        for bi, bar in enumerate(bars):
            if "time" in bar.attrs:
                time = bar.attrs["time"]  # type: ignore[assignment]
            mel = SubElement(part, "measure", number=bar.number)
            new_fifths = _fifths_for(bar, fifths)
            if bi == 0 or new_fifths != fifths or "time" in bar.attrs:
                at = SubElement(mel, "attributes")
                if bi == 0:
                    SubElement(at, "divisions").text = str(divisions)
                if bi == 0 or new_fifths != fifths:
                    k = SubElement(at, "key")
                    SubElement(k, "fifths").text = str(new_fifths)
                if "time" in bar.attrs:
                    beats, beat_type = bar.attrs["time"]  # type: ignore[misc]
                    t = SubElement(at, "time")
                    SubElement(t, "beats").text = beats
                    SubElement(t, "beat-type").text = beat_type
                if bi == 0:
                    SubElement(at, "staves").text = "2"
                    for num, (sign, line) in ((1, ("G", "2")), (2, ("F", "4"))):
                        c = SubElement(at, "clef", number=str(num))
                        SubElement(c, "sign").text = sign
                        SubElement(c, "line").text = line
            fifths = new_fifths
            keep = [
                b
                for b in bar.barlines
                if b.find("repeat") is not None or b.find("ending") is not None
            ]
            for bl in keep:  # left barlines (forward repeats, ending starts) open the bar
                if bl.get("location") == "left":
                    mel.append(bl)
            length = bar.length
            streams = [s for s in bar.streams if s.part in members]
            first = True
            for staff in (1, 2):
                if mode in _PER_BEAT:
                    voices = _beat_chords(streams, staff, length, beat_length(time))
                else:
                    voices = _bar_chord(streams, staff, length)
                if not first:
                    back = SubElement(mel, "backup")
                    SubElement(back, "duration").text = str(int(length * divisions))
                first = False
                if not voices:
                    rest = SubElement(mel, "note")
                    SubElement(rest, "rest", measure="yes")
                    SubElement(rest, "duration").text = str(max(1, int(length * divisions)))
                    SubElement(rest, "voice").text = str((staff - 1) * 4 + 1)
                    SubElement(rest, "staff").text = str(staff)
                    continue
                for vi, evs in enumerate(voices):
                    voice = str((staff - 1) * 4 + vi + 1)
                    if vi:
                        back = SubElement(mel, "backup")
                        SubElement(back, "duration").text = str(int(length * divisions))
                    pos = Fraction(0)
                    for e in evs:
                        if e.onset > pos:
                            fw = SubElement(mel, "forward")
                            SubElement(fw, "duration").text = str(int((e.onset - pos) * divisions))
                            SubElement(fw, "voice").text = voice
                            SubElement(fw, "staff").text = str(staff)
                        if not e.pitches:  # an empty beat
                            rn = SubElement(mel, "note")
                            SubElement(rn, "rest")
                            SubElement(rn, "duration").text = str(int(e.dur * divisions))
                            SubElement(rn, "voice").text = voice
                            SubElement(rn, "type").text = e.rhythm[0]
                            for _ in range(e.rhythm[1]):
                                SubElement(rn, "dot")
                            SubElement(rn, "staff").text = str(staff)
                        for ci, (midi, (pitch, parts_)) in enumerate(sorted(e.pitches.items())):
                            n_id += 1
                            nid = f"t-{n_id}"
                            ids[nid] = {
                                "parts": sorted(parts_),
                                "midi": midi,
                                "name": pitch.name,
                                "group": gi,
                                "bar": bi,
                            }
                            ne = SubElement(mel, "note", id=nid)
                            if ci:
                                SubElement(ne, "chord")
                            pe = SubElement(ne, "pitch")
                            SubElement(pe, "step").text = STEPS[pitch.step]
                            if pitch.alter:
                                SubElement(pe, "alter").text = str(pitch.alter)
                            SubElement(pe, "octave").text = str(pitch.octave)
                            SubElement(ne, "duration").text = str(int(e.dur * divisions))
                            SubElement(ne, "voice").text = voice
                            typ, dots = e.rhythm
                            SubElement(ne, "type").text = typ
                            for _ in range(dots):
                                SubElement(ne, "dot")
                            SubElement(ne, "staff").text = str(staff)
                        pos = e.onset + e.dur
            for bl in keep:  # right barlines (backward repeats, ending stops) close it
                if bl.get("location") != "left":
                    mel.append(bl)
    xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + tostring(sp, encoding="unicode")
    sidecar = {
        "mode": mode,
        "groups": [g for g, _ in groups],
        "parts": [
            m.get("name") or m.get("instrument") or f"part {i + 1}" for i, m in enumerate(meta)
        ],
        "notes": ids,
    }
    return xml, sidecar


def write_reductions(
    path: str | Path, root: Path, rel_dir: str = "score"
) -> list[tuple[str, str, str]]:
    """Write the bundle reductions (MODES: chords per bar and per beat, for all
    parts and per section) and their sidecars under root/rel_dir.

    Returns [(mode, musicxml rel path, sidecar rel path)].
    """
    (root / rel_dir).mkdir(parents=True, exist_ok=True)
    out = []
    for mode, stem in (
        ("chords", "chords"),
        ("beat-chords", "beat-chords"),
        ("section-chords", "short-chords"),
        ("section-beat-chords", "short-beat-chords"),
    ):
        xml, side = reduce_score(path, mode)
        x, j = f"{rel_dir}/{stem}.musicxml", f"{rel_dir}/{stem}.json"
        (root / x).write_text(xml, encoding="utf-8")
        (root / j).write_text(json.dumps(side, separators=(",", ":")), encoding="utf-8")
        out.append((mode, x, j))
    return out
