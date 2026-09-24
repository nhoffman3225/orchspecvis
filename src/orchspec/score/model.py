"""Score data model. Times are in quarter notes along the PLAYBACK timeline (repeats
unrolled) until the timeline module maps them to audio seconds.

Part, staff and voice are never collapsed (invariant).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Part:
    index: int
    id: str  # MusicXML part id, e.g. "P1"
    name: str  # part-name, e.g. "Clarinet in B♭ 1"
    instrument: str  # score-instrument/instrument-name (or part-name)
    abbreviation: str = ""
    staves: int = 1
    transpose_chromatic: int = 0  # written -> sounding semitones (without octave change)
    transpose_octave: int = 0  # octave-change
    midi_channel: int | None = None
    midi_program: int | None = None


@dataclass(frozen=True)
class PlayedMeasure:
    play_index: int
    source_index: int
    number: str  # displayed number
    start_q: float  # playback quarter notes
    dur_q: float
    beats: int
    beat_type: int
    pass_no: int


@dataclass(frozen=True)
class Note:
    part: int
    staff: int
    voice: int
    midi: float  # sounding pitch (may be fractional for microtones)
    written_midi: float
    onset_q: float  # playback quarter notes
    dur_q: float
    play_measure: int
    beat: float  # 1-based beat within the measure (in beat-type units)
    unpitched: bool = False


@dataclass
class Score:
    parts: list[Part]
    played: list[PlayedMeasure]
    notes: list[Note]
    tempos: list[tuple[float, float]] = field(default_factory=list)  # (onset_q, quarter bpm)
    source: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def total_q(self) -> float:
        return self.played[-1].start_q + self.played[-1].dur_q if self.played else 0.0
