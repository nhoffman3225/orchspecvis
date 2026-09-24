"""Instrument ranges from data/instruments/ranges.yaml, matched to part names."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

from orchspec.score.match import normalize

RANGES_PATH = Path(__file__).resolve().parents[3] / "data" / "instruments" / "ranges.yaml"


class InstrumentRange(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str
    family: str
    sounding_range: tuple[int, int]
    practical_range: tuple[int, int] | None = None
    transposition: int = 0
    aliases: list[str] = Field(min_length=1)
    source: str

    @model_validator(mode="after")
    def _ordered(self) -> InstrumentRange:
        for r in (self.sounding_range, self.practical_range):
            if r is not None and not (0 <= r[0] <= r[1] <= 127):
                raise ValueError(f"{self.name}: range {r} must be 0 <= low <= high <= 127")
        return self


@lru_cache(maxsize=4)
def load_ranges(path: Path = RANGES_PATH) -> dict[str, InstrumentRange]:
    if not path.is_file():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return {k: InstrumentRange.model_validate(v) for k, v in raw.items()}


def find_range(*names: str, path: Path = RANGES_PATH) -> tuple[str, InstrumentRange] | None:
    """Best match over the given names (e.g. instrument name, part name): the longest alias
    that appears as a whole-word sequence in a normalized name."""
    best: tuple[int, str, InstrumentRange] | None = None
    for raw in names:
        words = f" {normalize(raw)} "
        for key, r in load_ranges(path).items():
            for alias in r.aliases:
                a = normalize(alias)
                if a and f" {a} " in words and (best is None or len(a) > best[0]):
                    best = (len(a), key, r)
    return None if best is None else (best[1], best[2])
