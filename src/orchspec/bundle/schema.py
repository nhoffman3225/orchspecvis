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

SCHEMA_VERSION = 1
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


class Manifest(_Model):
    schema_version: Literal[1] = SCHEMA_VERSION
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

    @model_validator(mode="after")
    def _consistent(self) -> Manifest:
        if self.bins_per_octave % 12:
            raise ValueError("bins_per_octave must be a multiple of 12")
        if self.db_max <= self.db_min:
            raise ValueError("db_max must exceed db_min")
        if self.n_frames != 1 + self.n_samples // self.hop:
            raise ValueError("n_frames must equal 1 + n_samples // hop (centered frames)")
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
