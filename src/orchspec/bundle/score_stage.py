"""Score/MIDI -> audio-timed note table, measures and alignment for the bundle."""

from __future__ import annotations

import shutil
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
from orchspec.dsp.tiles import dequantize, read_level
from orchspec.score.match import match_parts_to_stems
from orchspec.score.musicxml import parse_musicxml
from orchspec.score.ranges import find_range
from orchspec.timeline.align import (
    Warp,
    align_notes,
    detector_bias,
    estimate_warp,
    onset_envelope_fine,
    pitch_agreement,
    quarter_clock,
    semitone_activity,
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


# number, start, end (score s), beats, beat_type, pass, source measure index
MeasureRow = tuple[str, float, float, int, int, int, int | None]
AlignMethod = Literal["warp", "xcorr", "manual", "preroll_only"]


@dataclass
class ScorePlan:
    """Score/MIDI notes on their way into the bundle.

    Created after the mix is analysed (coarse, pitch-aware warp); stems add their onset
    envelopes while they are analysed; finalize() computes onset-accurate times per note
    (snapping each part to its own stem); fundamentals are then measured from the written
    tiles, so no stem CQT has to stay in memory.
    """

    kind: Literal["musicxml", "midi"]
    source_files: list[str]
    parts: list[ScorePart]
    measure_src: list[MeasureRow]
    alignment: Alignment
    cols: dict[str, np.ndarray]  # NOTE_COLUMNS; onset_s/offset_s become audio seconds
    score_on: np.ndarray  # score/MIDI seconds per note
    score_off: np.ndarray
    part_stem: dict[int, int] = field(default_factory=dict)  # part index -> stem index
    coarse: Warp | None = None  # None -> constant offset (manual / preroll / --no-align)
    mix_env: np.ndarray | None = None
    env_frame_sec: float = 0.0
    sr: int = 0
    stem_envs: dict[int, np.ndarray] = field(default_factory=dict)  # stem index -> env
    measures: list[ScoreMeasure] = field(default_factory=list)
    log: Callable[[str], None] = lambda _m: None

    @property
    def n(self) -> int:
        return len(self.cols["midi"])

    def add_stem(self, stem_index: int, y: np.ndarray) -> None:
        if self.coarse is not None and stem_index in self.part_stem.values():
            self.stem_envs[stem_index] = onset_envelope_fine(y, self.sr)[0]

    def finalize(self) -> None:
        a = self.alignment
        if self.coarse is None:
            off = a.offset_sec
            self.cols["onset_s"] = self.score_on + off
            self.cols["offset_s"] = self.score_off + off
            warp = Warp(np.array([0.0]), np.array([off]))
        else:
            assert self.mix_env is not None
            envs = {p: self.stem_envs[s] for p, s in self.part_stem.items() if s in self.stem_envs}
            na = align_notes(
                self.coarse,
                self.cols["part"].astype(np.int64),
                self.score_on,
                self.score_off,
                envs,
                self.mix_env,
                self.env_frame_sec,
                bias=detector_bias(self.sr),
            )
            self.cols["onset_s"] = na.onsets
            self.cols["offset_s"] = na.offsets
            warp = na.warp
            self.parts = [
                p.model_copy(
                    update={
                        "latency_sec": na.latency.get(p.index),
                        "snapped": na.part_snapped.get(p.index),
                    }
                )
                for p in self.parts
            ]
            self.alignment = a.model_copy(
                update={
                    "warp": warp.pairs(),
                    "snapped": na.snapped,
                    "offset_sec": float(warp(0.0)),
                }
            )
            lat = ", ".join(
                f"{p.name} {1000 * (p.latency_sec or 0):+.0f} ms"
                for p in self.parts
                if p.latency_sec is not None
            )
            self.log(
                f"alignment: warp over {len(warp.src)} events, {na.snapped:.0%} of notes "
                f"snapped to onsets; part latency: {lat}"
            )
        self.measures = [
            ScoreMeasure(
                play_index=i,
                number=num,
                start_s=float(warp(st)),
                end_s=float(warp(en)),
                beats=bt,
                beat_type=btt,
                pass_no=pn,
                source_index=si,
            )
            for i, (num, st, en, bt, btt, pn, si) in enumerate(self.measure_src)
        ]

    def measure_fundamentals_from_tiles(
        self,
        root: Path,
        spec: CQTSpec,
        mix_lod0: object,
        stem_lod0: dict[int, object],
        db_min: float,
        db_max: float,
    ) -> None:
        """f0_db / f0_ok per note, from the part's stem tiles (mix tiles when unmatched)."""
        groups: dict[int | None, list[int]] = {}
        for p in self.parts:
            s = self.part_stem.get(p.index)
            groups.setdefault(s if s in stem_lod0 else None, []).append(p.index)
        for s, parts in groups.items():
            sel = np.isin(self.cols["part"].astype(np.int64), parts)
            if not sel.any():
                continue
            lod = stem_lod0[s] if s is not None else mix_lod0
            db = dequantize(read_level(root, lod, spec.n_bins), db_min, db_max).T  # type: ignore[arg-type]
            lvl, ok = note_fundamental_levels(
                db,
                spec,
                self.cols["midi"][sel],
                self.cols["onset_s"][sel],
                self.cols["offset_s"][sel],
            )
            self.cols["f0_db"][sel] = lvl
            self.cols["f0_ok"][sel] = ok

    score_path: Path | None = None  # MusicXML to ship inside the bundle (for engraving)

    def write(self, root: Path, rel: str = "score/notes.f32") -> ScoreInfo:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        score_file = None
        if self.score_path is not None:
            ext = ".mxl" if self.score_path.suffix.lower() == ".mxl" else ".musicxml"
            score_file = f"score/score{ext}"
            shutil.copyfile(self.score_path, root / score_file)
        table = (
            np.stack([self.cols[c].astype("<f4") for c in NOTE_COLUMNS])
            if self.n
            else np.zeros((len(NOTE_COLUMNS), 0), "<f4")
        )
        (root / rel).write_bytes(np.ascontiguousarray(table, dtype="<f4").tobytes())
        return ScoreInfo(
            kind=self.kind,
            source_files=self.source_files,
            parts=self.parts,
            measures=self.measures,
            alignment=self.alignment,
            notes=NotesTable(path=rel, n=self.n, columns=list(NOTE_COLUMNS)),
            score_file=score_file,
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
    measures: list[MeasureRow] = [
        (
            m.number,
            clock(m.start_q),
            clock(m.start_q + m.dur_q),
            m.beats,
            m.beat_type,
            m.pass_no,
            m.source_index,
        )
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
    measures: list[MeasureRow] = [
        (str(i + 1), midi.tick_to_seconds(a), midi.tick_to_seconds(z), num, den, 1, None)
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
    mix_db: np.ndarray,
    spec: CQTSpec,
    preroll: float,
    stem_names: list[str],
    stem_ids: list[str],
    offset: float | None = None,
    align: bool = True,
    search: float = 1.5,
    log: Callable[[str], None] = lambda _m: None,
) -> ScorePlan | None:
    """Parse score/MIDI, match parts to stems, and compute the coarse pitch-aware warp
    from the mix. Call add_stem() per stem, then finalize()."""
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
    score_on = np.asarray(cols["onset_s"], dtype=np.float64).copy()
    score_off = np.asarray(cols["offset_s"], dtype=np.float64).copy()
    coarse: Warp | None = None
    mix_env: np.ndarray | None = None
    env_fs = 0.0
    if offset is not None:
        g, conf, method = offset, 1.0, "manual"
    elif align and len(score_on):
        act = semitone_activity(mix_db, spec.k)
        wr = estimate_warp(
            act, spec.hop / spec.sr, cols["midi"], score_on, score_off, prior=preroll, search=search
        )
        coarse, g, conf, method = wr.warp, wr.global_offset, wr.confidence, "warp"
        mix_env, env_fs = onset_envelope_fine(mono, spec.sr)
        warnings += wr.warnings
    else:
        g, conf, method = preroll, 0.0, "preroll_only"
    log(
        f"alignment: global offset {g:.3f} s ({method}, preroll {preroll:.3f} s, "
        f"confidence {conf:.2f})"
    )
    for w in warnings:
        log(f"warning: {w}")

    cols["f0_db"][:] = -120.0  # filled by measure_fundamentals_from_tiles
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
    alignment = Alignment(
        method=cast(AlignMethod, method),
        offset_sec=g,
        preroll_sec=preroll,
        confidence=conf,
        time_source=cast(Literal["midi", "score_tempo"], source),
        pitch_agreement=None if check is None else check.agreement,
        pitch_shift_mode=None if check is None else check.shift_mode,
        warnings=warnings,
    )
    return ScorePlan(
        kind=kind,
        source_files=files,
        parts=part_models,
        measure_src=measures,
        score_path=score_path,
        alignment=alignment,
        cols=cols,
        score_on=score_on,
        score_off=score_off,
        part_stem=part_stem,
        coarse=coarse,
        mix_env=mix_env,
        env_frame_sec=env_fs,
        sr=spec.sr,
        log=log,
    )
