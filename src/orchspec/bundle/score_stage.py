"""Score/MIDI -> audio-timed note table, measures and alignment for the bundle."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal, cast

import numpy as np

from orchspec.bundle.schema import (
    NOTE_COLUMNS,
    Alignment,
    NotesTable,
    ScoreInfo,
    ScoreMeasure,
    ScorePart,
)
from orchspec.dsp.cqt import CQTSpec
from orchspec.dsp.fundamentals import note_fundamental_levels
from orchspec.score.match import match_parts_to_stems
from orchspec.score.musicxml import parse_musicxml
from orchspec.score.ranges import find_range
from orchspec.timeline.align import (
    estimate_offset,
    onset_envelope_fine,
    pitch_agreement,
    quarter_clock,
)
from orchspec.timeline.midi import MidiFile, parse_midi


@dataclass(frozen=True)
class PartMeta:
    index: int
    id: str
    name: str
    instrument: str
    abbreviation: str = ""
    staves: int = 1
    transpose_chromatic: int = 0
    transpose_octave: int = 0


AlignMethod = Literal["xcorr", "manual", "preroll_only"]


@dataclass
class ScorePlan:
    kind: Literal["musicxml", "midi"]
    source_files: list[str]
    parts: list[ScorePart]
    measures: list[ScoreMeasure]
    alignment: Alignment
    cols: dict[str, np.ndarray]  # NOTE_COLUMNS -> float arrays (audio seconds)
    part_stem: dict[int, int] = field(default_factory=dict)  # part index -> stem index

    @property
    def n(self) -> int:
        return len(self.cols["midi"])

    def measure_fundamentals(self, db: np.ndarray, spec: CQTSpec, stem_index: int | None) -> None:
        """Fill f0_db / f0_ok for notes of parts matched to `stem_index`, or for unmatched
        parts when stem_index is None (measured on the mix)."""
        parts = (
            [p for p, s in self.part_stem.items() if s == stem_index]
            if stem_index is not None
            else [p.index for p in self.parts if p.index not in self.part_stem]
        )
        if not parts:
            return
        sel = np.isin(self.cols["part"].astype(np.int64), parts)
        if not sel.any():
            return
        lvl, ok = note_fundamental_levels(
            db, spec, self.cols["midi"][sel], self.cols["onset_s"][sel], self.cols["offset_s"][sel]
        )
        self.cols["f0_db"][sel] = lvl
        self.cols["f0_ok"][sel] = ok

    def write(self, root: Path, rel: str = "score/notes.f32") -> ScoreInfo:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        table = (
            np.stack([self.cols[c].astype("<f4") for c in NOTE_COLUMNS])
            if self.n
            else np.zeros((len(NOTE_COLUMNS), 0), "<f4")
        )
        (root / rel).write_bytes(np.ascontiguousarray(table, dtype="<f4").tobytes())
        return ScoreInfo(
            kind=self.kind,
            source_files=self.source_files,
            parts=self.parts,  # type: ignore[arg-type]
            measures=self.measures,
            alignment=self.alignment,
            notes=NotesTable(path=rel, n=self.n, columns=list(NOTE_COLUMNS)),
        )


def _empty_cols(n: int) -> dict[str, np.ndarray]:
    return {c: np.zeros(n, dtype=np.float64) for c in NOTE_COLUMNS}


def _from_musicxml(score_path: Path, midi: MidiFile | None):  # type: ignore[no-untyped-def]
    score = parse_musicxml(score_path)
    clock, source = quarter_clock(score, midi)
    n = len(score.notes)
    cols = _empty_cols(n)
    vel: dict[tuple[int, int], int] = {}
    if midi is not None:
        for mn in midi.notes:
            vel.setdefault((mn.on_tick, mn.pitch), mn.velocity)
    for i, nt in enumerate(score.notes):
        cols["part"][i] = nt.part
        cols["staff"][i] = nt.staff
        cols["voice"][i] = nt.voice
        cols["midi"][i] = nt.midi
        cols["onset_s"][i] = clock(nt.onset_q)
        cols["offset_s"][i] = clock(nt.onset_q + nt.dur_q)
        cols["measure"][i] = nt.play_measure
        cols["beat"][i] = nt.beat
        if midi is not None:
            cols["velocity"][i] = vel.get((round(nt.onset_q * midi.ppq), round(nt.midi)), 0)
    measures = [
        (m.number, clock(m.start_q), clock(m.start_q + m.dur_q), m.beats, m.beat_type, m.pass_no)
        for m in score.played
    ]
    parts = [
        PartMeta(
            p.index,
            p.id,
            p.name,
            p.instrument,
            p.abbreviation,
            p.staves,
            p.transpose_chromatic,
            p.transpose_octave,
        )
        for p in score.parts
    ]
    check = pitch_agreement(score, midi) if midi is not None else None
    return cols, measures, parts, source, check


def _from_midi(midi: MidiFile):  # type: ignore[no-untyped-def]
    tracks = sorted({n.track for n in midi.notes})
    index = {t: i for i, t in enumerate(tracks)}
    n = len(midi.notes)
    cols = _empty_cols(n)
    # measures from time signatures
    sigs = midi.time_sigs or [(0, 4, 4)]
    end = max(midi.end_tick, 1)
    bars: list[tuple[int, int, int, int]] = []  # start tick, end tick, num, den
    t = 0
    while t < end and len(bars) < 100_000:
        cur = [s for s in sigs if s[0] <= t][-1] if any(s[0] <= t for s in sigs) else sigs[0]
        length = round(cur[1] * midi.ppq * 4 / cur[2])
        bars.append((t, t + length, cur[1], cur[2]))
        t += max(length, 1)
    starts = [b[0] for b in bars]
    for i, mn in enumerate(midi.notes):
        bi = max(0, int(np.searchsorted(starts, mn.on_tick, side="right")) - 1)
        b = bars[bi]
        cols["part"][i] = index[mn.track]
        cols["staff"][i] = 1
        cols["voice"][i] = mn.channel + 1
        cols["midi"][i] = mn.pitch
        cols["onset_s"][i] = midi.tick_to_seconds(mn.on_tick)
        cols["offset_s"][i] = midi.tick_to_seconds(mn.off_tick)
        cols["measure"][i] = bi
        cols["beat"][i] = 1 + (mn.on_tick - b[0]) / (midi.ppq * 4 / b[3])
        cols["velocity"][i] = mn.velocity
    measures = [
        (str(i + 1), midi.tick_to_seconds(a), midi.tick_to_seconds(z), num, den, 1)
        for i, (a, z, num, den) in enumerate(bars)
    ]
    parts = sorted(
        (
            PartMeta(
                i, f"T{t}", midi.track_names[t] or f"Track {t}", midi.track_names[t] or f"Track {t}"
            )
            for t, i in index.items()
        ),
        key=lambda p: p.index,
    )
    return cols, measures, parts


def _range_fields(p: PartMeta) -> dict[str, object]:
    hit = find_range(p.instrument, p.name)
    if hit is None:
        return {}
    key, r = hit
    pr = r.practical_range
    return {
        "range_id": key,
        "range_low": r.sounding_range[0],
        "range_high": r.sounding_range[1],
        "practical_low": pr[0] if pr else None,
        "practical_high": pr[1] if pr else None,
    }


def prepare_score(
    score_path: Path | None,
    midi_path: Path | None,
    mono: np.ndarray,
    sr: int,
    preroll: float,
    stem_names: list[str],
    stem_ids: list[str],
    offset: float | None = None,
    align: bool = True,
    search: float = 1.5,
    log: Callable[[str], None] = lambda _m: None,
) -> ScorePlan | None:
    if score_path is None and midi_path is None:
        return None
    midi = parse_midi(midi_path) if midi_path is not None else None
    check = None
    if score_path is not None:
        cols, measures, parts, source, check = _from_musicxml(score_path, midi)
        kind: Literal["musicxml", "midi"] = "musicxml"
    else:
        assert midi is not None
        cols, measures, parts = _from_midi(midi)
        source, kind = "midi", "midi"
    files = [p.name for p in (score_path, midi_path) if p is not None]
    log(
        f"score: {len(parts)} parts, {len(cols['midi'])} notes, {len(measures)} measures "
        f"(time from {source})"
    )

    warnings: list[str] = []
    if check is not None and check.agreement < 0.9:
        warnings.append(
            f"only {check.agreement:.0%} of MusicXML notes match render.mid pitches "
            f"(most common difference {check.shift_mode:+d} semitones); check that "
            "MIDI was exported at sounding pitch"
            if check.shift_mode is not None
            else f"only {check.agreement:.0%} of MusicXML notes match render.mid"
        )
    if offset is not None:
        est_offset, conf, method = offset, 1.0, "manual"
    elif align and len(cols["onset_s"]):
        env, fsec = onset_envelope_fine(mono, sr)
        est = estimate_offset(env, fsec, np.asarray(cols["onset_s"]), prior=preroll, search=search)
        est_offset, conf, method = est.offset_sec, est.confidence, est.method
        warnings += est.warnings
    else:
        est_offset, conf, method = preroll, 0.0, "preroll_only"
    log(
        f"alignment: offset {est_offset:.3f} s ({method}, preroll {preroll:.3f} s, "
        f"confidence {conf:.2f})"
    )
    for w in warnings:
        log(f"warning: {w}")

    cols["onset_s"] = cols["onset_s"] + est_offset
    cols["offset_s"] = cols["offset_s"] + est_offset
    cols["f0_db"][:] = -120.0  # filled by measure_fundamentals
    matches = match_parts_to_stems([p.name for p in parts], stem_names)
    part_models = []
    part_stem: dict[int, int] = {}
    for p, mt in zip(parts, matches, strict=True):
        if mt.stem_index is not None:
            part_stem[p.index] = mt.stem_index
        part_models.append(
            ScorePart.model_validate(
                {
                    **asdict(p),
                    "stem_id": None if mt.stem_index is None else stem_ids[mt.stem_index],
                    "stem_match": mt.method,
                    **_range_fields(p),
                }
            )
        )
    measures_m = [
        ScoreMeasure(
            play_index=i,
            number=num,
            start_s=a + est_offset,
            end_s=z + est_offset,
            beats=b,
            beat_type=bt,
            pass_no=pn,
        )
        for i, (num, a, z, b, bt, pn) in enumerate(measures)
    ]
    alignment = Alignment(
        method=cast(AlignMethod, method),
        offset_sec=est_offset,
        preroll_sec=preroll,  # type: ignore[arg-type]
        confidence=conf,
        time_source=source,  # type: ignore[arg-type]
        pitch_agreement=None if check is None else check.agreement,
        pitch_shift_mode=None if check is None else check.shift_mode,
        warnings=warnings,
    )
    return ScorePlan(
        kind=kind,
        source_files=files,
        parts=part_models,
        measures=measures_m,
        alignment=alignment,
        cols=cols,
        part_stem=part_stem,
    )
