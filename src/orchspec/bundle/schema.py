"""Session bundle manifest, schema version 1.

This pydantic model is the normative Python side of docs/bundle-format.md. The viewer's
TypeScript loader (viewer/src/bundle.ts) and the future Rust reader must accept exactly
what this model accepts. Any change here bumps SCHEMA_VERSION and updates both.

All relative paths are POSIX-style, relative to the bundle root, and may not escape it.
All times are audio seconds from sample 0 of the mix.
"""

from __future__ import annotations

import itertools
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = 7  # v2 score; v3 warp; v4 gzip tiles; v5 reductions; v6 score pdf;
# v7 chord-per-beat reductions
TileEncoding = Literal["raw", "gzip"]
MANIFEST_NAME = "manifest.json"
NONE_STEM = 255  # value in dominant-stem tiles meaning "no stem above the floor"


def _check_rel_path(p: str) -> str:
    pp = PurePosixPath(p)
    if not p or "\\" in p or pp.is_absolute() or ".." in pp.parts or ":" in p:
        raise ValueError(f"bundle path must be relative POSIX inside the bundle: {p!r}")
    return p


RelPath = Annotated[str, AfterValidator(_check_rel_path)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Tile(_Model):
    """One uint8 tile: frame-major, `n_frames * n_bins` bytes, byte = frame * n_bins + bin."""

    index: int = Field(ge=0)
    start_frame: int = Field(ge=0)
    n_frames: int = Field(ge=1)
    path: RelPath


class Lod(_Model):
    """One pyramid level. Level L frame f covers level-0 frames [f*2^L, (f+1)*2^L)."""

    level: int = Field(ge=0)
    hop_factor: int = Field(ge=1)
    n_frames: int = Field(ge=1)
    tiles: list[Tile]

    @model_validator(mode="after")
    def _consistent(self) -> Lod:
        if self.hop_factor != 2**self.level:
            raise ValueError("hop_factor must equal 2**level")
        expect = 0
        for i, t in enumerate(self.tiles):
            if t.index != i or t.start_frame != expect:
                raise ValueError(f"level {self.level}: tiles must be contiguous and ordered")
            expect += t.n_frames
        if expect != self.n_frames:
            raise ValueError(f"level {self.level}: tiles cover {expect} != n_frames")
        return self


class Stem(_Model):
    id: str = Field(pattern=r"^[A-Za-z0-9_.-]+$")
    index: int = Field(ge=0, lt=NONE_STEM)
    name: str
    source_file: str  # original filename (informational only; never opened by viewers)
    lods: list[Lod]


class DominantStem(_Model):
    """Per-cell argmax over stems, uint8 tiles with the same geometry as the mix."""

    none_value: int = NONE_STEM
    floor_db: float
    lods: list[Lod]


class Series(_Model):
    """A little-endian float32 array stored raw (`.f32`), C order, given `shape`."""

    name: str
    unit: str
    description: str = ""
    path: RelPath
    shape: list[int]
    dtype: Literal["f32le"] = "f32le"
    t0_seconds: float = 0.0  # time of the first sample along the last axis
    hop_seconds: float = Field(gt=0)  # spacing along the last axis
    row_labels: list[str] | None = None  # for 2-D tables (e.g. stem ids)


class CqtInfo(_Model):
    backend: str
    k: int = Field(ge=1)
    filter_scale: float = 1.0
    window: str = "hann"
    tuning: float = 0.0
    frame_convention: Literal["centered"] = "centered"


class Offsets(_Model):
    preroll_sec: float = 0.0


class SourceInfo(_Model):
    kind: Literal["wav", "session"]
    name: str
    renderer: str | None = None
    render_config: dict[str, object] | None = None


NOTE_COLUMNS = (
    "part",
    "staff",
    "voice",
    "midi",
    "onset_s",
    "offset_s",
    "measure",
    "beat",
    "velocity",
    "f0_db",
    "f0_ok",
)


class ScorePart(_Model):
    index: int = Field(ge=0)
    id: str
    name: str
    instrument: str
    abbreviation: str = ""
    staves: int = Field(ge=1, default=1)
    transpose_chromatic: int = 0
    transpose_octave: int = 0
    stem_id: str | None = None
    stem_match: Literal["name", "fuzzy", "order", "none"] = "none"
    # sounding range from data/instruments/ranges.yaml (MIDI), when the instrument matched
    range_id: str | None = None
    range_low: int | None = None
    range_high: int | None = None
    practical_low: int | None = None
    practical_high: int | None = None
    # v3: this part's onset lag relative to the common warp (seconds), when measured
    latency_sec: float | None = None
    snapped: float | None = None  # v3: fraction of this part's notes snapped to an onset


class ScoreMeasure(_Model):
    """One measure in PLAYBACK order (repeats unrolled). Times are audio seconds."""

    play_index: int = Field(ge=0)
    number: str
    start_s: float
    end_s: float
    beats: int
    beat_type: int
    pass_no: int = Field(ge=1, default=1)
    source_index: int | None = None  # v3: measure index in the notated score (repeats undone)


class Alignment(_Model):
    method: Literal["warp", "xcorr", "manual", "preroll_only"]
    offset_sec: float  # audio seconds = score/MIDI seconds + offset_sec
    preroll_sec: float
    confidence: float
    time_source: Literal["midi", "score_tempo"]
    pitch_agreement: float | None = None  # MusicXML vs MIDI (None if only one exists)
    pitch_shift_mode: int | None = None
    warnings: list[str] = []
    # v3: piecewise-linear score/MIDI seconds -> audio seconds (monotonic), common to all
    # parts; each part adds its latency_sec. Empty = constant offset_sec.
    warp: list[tuple[float, float]] = []
    snapped: float | None = None  # fraction of notes snapped to an audio onset


class NotesTable(_Model):
    """Column-major f32le table: column c is n float32 values at byte offset 4*c*n.

    Columns: see NOTE_COLUMNS. Times are audio seconds; `measure` indexes `measures`;
    `f0_ok` is 1.0 when the note's fundamental is not weak (see dsp/fundamentals.py).
    """

    path: RelPath
    n: int = Field(ge=0)
    columns: list[str]
    dtype: Literal["f32le"] = "f32le"
    layout: Literal["column_major"] = "column_major"


class Reduction(_Model):
    """v5: an engravable reduction of the score (score/reduce.py) and its note map."""

    # chords: one chord per bar on one grand staff; section-chords: per section;
    # v7 beat-chords / section-beat-chords: one chord per beat; tutti / sections: full
    # rhythm (voices, ties), written by v5-v6 bundles only
    mode: Literal[
        "chords", "section-chords", "tutti", "sections", "beat-chords", "section-beat-chords"
    ]
    musicxml: RelPath
    map: RelPath  # JSON: {"notes": {note id: {"parts", "midi", "name", "group"}}, ...}


class PdfPageInfo(_Model):
    path: RelPath  # grayscale PNG of the page
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class PdfBarInfo(_Model):
    """A bar found on a page (pixels of that page's image)."""

    page: int = Field(ge=0)
    number: str  # printed / continued bar number, as in score.measures[].number
    x0: int
    y0: int
    x1: int
    y1: int


class PdfScoreInfo(_Model):
    """v6: the score as a PDF (e.g. Dorico's condensed layout), rendered to images."""

    dpi: int = Field(gt=0)
    pages: list[PdfPageInfo]
    bars: list[PdfBarInfo]


def pdf_info(s: object) -> PdfScoreInfo:
    """From score.pdf.PdfScore (kept duck-typed so schema.py has no rendering deps)."""
    return PdfScoreInfo(
        dpi=s.dpi,  # type: ignore[attr-defined]
        pages=[PdfPageInfo(path=p.path, width=p.width, height=p.height) for p in s.pages],  # type: ignore[attr-defined]
        bars=[
            PdfBarInfo(page=b.page, number=b.number, x0=b.x0, y0=b.y0, x1=b.x1, y1=b.y1)
            for b in s.bars  # type: ignore[attr-defined]
        ],
    )


class ScoreInfo(_Model):
    kind: Literal["musicxml", "midi"]
    source_files: list[str]
    parts: list[ScorePart]
    measures: list[ScoreMeasure]
    notes: NotesTable
    alignment: Alignment
    score_file: RelPath | None = None  # v3: copy of the MusicXML/.mxl for engraving
    reductions: list[Reduction] = []  # v5
    pdf: PdfScoreInfo | None = None  # v6

    @model_validator(mode="after")
    def _consistent(self) -> ScoreInfo:
        if [p.index for p in self.parts] != list(range(len(self.parts))):
            raise ValueError("score part indices must be 0..n-1 in order")
        if [m.play_index for m in self.measures] != list(range(len(self.measures))):
            raise ValueError("score measures must be in playback order")
        if tuple(self.notes.columns) != NOTE_COLUMNS:
            raise ValueError(f"notes columns must be {list(NOTE_COLUMNS)}")
        return self


class Manifest(_Model):
    schema_version: Literal[1, 2, 3, 4, 5, 6, 7] = SCHEMA_VERSION
    created_by: str
    created_at: str  # ISO 8601 UTC

    # time / frequency axes (shared by mix and all stems)
    sr: int = Field(gt=0)
    hop: int = Field(gt=0)
    n_samples: int = Field(gt=0)
    duration_seconds: float = Field(gt=0)
    fmin_midi: float = 21.0
    bins_per_octave: int = Field(gt=0)
    n_bins: int = Field(gt=0)
    n_frames: int = Field(gt=0)

    # quantization: value v in [0,255] <-> db_min + v * (db_max - db_min) / 255
    db_min: float
    db_max: float
    db_reference: Literal["full_scale_sine_per_bin"] = "full_scale_sine_per_bin"
    lod_reduce: Literal["max"] = "max"
    tile_frames: int = Field(gt=0)
    tile_layout: Literal["frame_major_u8"] = "frame_major_u8"
    # v4: "gzip" = each tile file is a gzip member (RFC 1952) of the raw tile bytes, *.u8.gz
    tile_encoding: TileEncoding = "raw"

    lods: list[Lod]  # the mix
    audio_path: RelPath
    audio_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    cqt: CqtInfo
    offsets: Offsets = Offsets()
    source: SourceInfo
    stems: list[Stem] = []
    dominant: DominantStem | None = None
    features: list[Series] = []
    tables: list[Series] = []
    score: ScoreInfo | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Manifest:
        if self.bins_per_octave % 12:
            raise ValueError("bins_per_octave must be a multiple of 12")
        if self.db_max <= self.db_min:
            raise ValueError("db_max must exceed db_min")
        if self.n_frames != 1 + self.n_samples // self.hop:
            raise ValueError("n_frames must equal 1 + n_samples // hop (centered frames)")
        if self.tile_encoding != "raw" and self.schema_version < 4:
            raise ValueError("tile_encoding other than raw requires schema_version 4")
        for name, lods in self._all_lods():
            if not lods or lods[0].level != 0 or lods[0].n_frames != self.n_frames:
                raise ValueError(f"{name}: level 0 must exist and span n_frames")
            for prev, cur in itertools.pairwise(lods):
                if cur.level != prev.level + 1 or cur.n_frames != -(-prev.n_frames // 2):
                    raise ValueError(f"{name}: level {cur.level} frame count wrong")
            for lod in lods:
                if any(t.n_frames > self.tile_frames for t in lod.tiles):
                    raise ValueError(f"{name}: tile larger than tile_frames")
        ids = [s.id for s in self.stems]
        if len(set(ids)) != len(ids):
            raise ValueError("stem ids must be unique")
        if [s.index for s in self.stems] != list(range(len(self.stems))):
            raise ValueError("stem indices must be 0..n-1 in order")
        if self.score is not None:
            if self.schema_version < 2:
                raise ValueError("a score section requires schema_version 2")
            if self.score.reductions and self.schema_version < 5:
                raise ValueError("score reductions require schema_version 5")
            per_beat = {"beat-chords", "section-beat-chords"}
            if any(r.mode in per_beat for r in self.score.reductions) and self.schema_version < 7:
                raise ValueError("chord-per-beat reductions require schema_version 7")
            if self.score.pdf is not None:
                if self.schema_version < 6:
                    raise ValueError("a score pdf requires schema_version 6")
                n = len(self.score.pdf.pages)
                if any(b.page >= n for b in self.score.pdf.bars):
                    raise ValueError("score pdf bar refers to a missing page")
            known = set(ids)
            for p in self.score.parts:
                if p.stem_id is not None and p.stem_id not in known:
                    raise ValueError(f"score part {p.name!r} refers to unknown stem {p.stem_id!r}")
        return self

    def _all_lods(self) -> list[tuple[str, list[Lod]]]:
        out = [("mix", self.lods)]
        out += [(f"stem {s.id}", s.lods) for s in self.stems]
        if self.dominant is not None:
            out.append(("dominant", self.dominant.lods))
        return out

    @property
    def k(self) -> int:
        return self.bins_per_octave // 12

    def bin_to_midi(self, b: float) -> float:
        return self.fmin_midi + b / self.k

    def frame_to_seconds(self, f: float, level: int = 0) -> float:
        return f * self.hop * (2**level) / self.sr
