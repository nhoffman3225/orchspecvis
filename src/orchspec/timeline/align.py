"""Score/MIDI time -> audio seconds.

1. Score quarter notes (playback timeline, repeats unrolled) -> MIDI seconds through the
   render.mid tempo map (assumes MIDI tick 0 == the score's first beat; see PLAN.md
   "Unverified assumptions"), or through the score's own <sound tempo> marks.
2. MIDI seconds -> audio seconds by a constant offset: preroll_sec from render.yaml plus a
   residual estimated by cross-correlating note onsets with the audio onset envelope.
"""

from __future__ import annotations

import bisect
from collections import Counter
from dataclasses import dataclass, field

import librosa
import numpy as np

from orchspec.score.model import Score
from orchspec.timeline.midi import MidiFile

DEFAULT_BPM = 120.0


class TempoMap:
    """Quarter notes -> seconds from (quarter, bpm) marks; piecewise constant."""

    def __init__(self, marks: list[tuple[float, float]]) -> None:
        marks = sorted(marks)
        if not marks or marks[0][0] > 0:
            marks.insert(0, (0.0, marks[0][1] if marks else DEFAULT_BPM))
        self.q = [m[0] for m in marks]
        self.bpm = [m[1] for m in marks]
        self.sec = [0.0]
        for i in range(1, len(marks)):
            self.sec.append(self.sec[-1] + (self.q[i] - self.q[i - 1]) * 60.0 / self.bpm[i - 1])

    def seconds(self, q: float) -> float:
        i = max(0, bisect.bisect_right(self.q, q) - 1)
        return self.sec[i] + (q - self.q[i]) * 60.0 / self.bpm[i]


def quarter_clock(score: Score | None, midi: MidiFile | None):  # type: ignore[no-untyped-def]
    """Returns (q -> seconds function, source name)."""
    if midi is not None:
        return midi.quarters_to_seconds, "midi"
    marks = score.tempos if score is not None else []
    return TempoMap(marks).seconds, "score_tempo"


@dataclass
class PitchCheck:
    matched: int
    compared: int
    agreement: float
    shift_mode: int | None  # most common (midi - score) pitch difference among near-onset pairs


def pitch_agreement(score: Score, midi: MidiFile, onset_tol_q: float = 1 / 32) -> PitchCheck:
    """Fraction of pitched score notes with a MIDI note of the same pitch at the same onset."""
    by_tick: dict[int, list[int]] = {}
    for mn in midi.notes:
        by_tick.setdefault(mn.on_tick, []).append(mn.pitch)
    ticks = sorted(by_tick)
    tol = onset_tol_q * midi.ppq
    matched = compared = 0
    shifts: Counter[int] = Counter()
    for n in score.notes:
        if n.unpitched:
            continue
        compared += 1
        t = n.onset_q * midi.ppq
        i = bisect.bisect_left(ticks, t - tol)
        cands: list[int] = []
        while i < len(ticks) and ticks[i] <= t + tol:
            cands.extend(by_tick[ticks[i]])
            i += 1
        if round(n.midi) in cands:
            matched += 1
        elif cands:
            shifts[min(cands, key=lambda p: abs(p - n.midi)) - round(n.midi)] += 1
    mode = shifts.most_common(1)[0][0] if shifts else (0 if matched else None)
    return PitchCheck(matched, compared, matched / compared if compared else 1.0, mode)


@dataclass
class OffsetEstimate:
    offset_sec: float
    confidence: float  # normalized cross-correlation at the peak (0..1)
    method: str
    warnings: list[str] = field(default_factory=list)


def _pow2(x: float) -> int:
    return int(2 ** round(np.log2(max(x, 1.0))))


def align_hop(sr: int) -> int:
    """~3 ms hop (64 @ 22.05 kHz, 128 @ 48 kHz)."""
    return _pow2(0.003 * sr)


def onset_envelope_fine(y: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    """Onset strength with a short (~23 ms) window at a ~3 ms hop, centered frames.

    Returns (envelope, frame period in seconds). Short windows keep the spectral-flux lag
    small (measured ~8 ms late on synthetic attacks; see PLAN.md).
    """
    hop = align_hop(sr)
    env = librosa.onset.onset_strength(
        y=y.astype(np.float32),
        sr=sr,
        hop_length=hop,
        n_fft=_pow2(0.023 * sr),
        n_mels=64,
        center=True,
    )
    return env.astype(np.float64), hop / sr


def estimate_offset(
    env: np.ndarray, frame_sec: float, onsets_sec: np.ndarray, prior: float, search: float = 1.5
) -> OffsetEstimate:
    """Find offset d maximizing correlation of the audio onset envelope with note onsets
    shifted by d, for d in [prior - search, prior + search]."""
    warn: list[str] = []
    if len(onsets_sec) == 0 or not np.any(env > 0):
        return OffsetEstimate(prior, 0.0, "preroll_only", ["no onsets to align; using preroll"])
    n = len(env)
    e = env - np.median(env)
    e = np.maximum(e, 0)
    norm_e = np.sqrt(np.sum(e**2)) or 1.0
    lags = np.arange(round((prior - search) / frame_sec), round((prior + search) / frame_sec) + 1)
    # impulse train of note onsets (unique times), smoothed over +-2 frames
    frames = np.unique(np.round(onsets_sec / frame_sec).astype(np.int64))
    kernel = np.exp(-0.5 * (np.arange(-3, 4) / 1.0) ** 2)
    scores = np.zeros(len(lags))
    for li, lag in enumerate(lags):
        idx = frames + lag
        s = 0.0
        for k, w in zip(range(-3, 4), kernel, strict=True):
            j = idx + k
            j = j[(j >= 0) & (j < n)]
            s += w * e[j].sum()
        scores[li] = s
    norm_n = np.sqrt(len(frames) * float(np.sum(kernel**2)))
    best = int(np.argmax(scores))
    if best in (0, len(lags) - 1):
        warn.append("offset estimate hit the edge of the search window")
    frac = 0.0
    if 0 < best < len(lags) - 1:
        a, b, c = scores[best - 1], scores[best], scores[best + 1]
        den = a - 2 * b + c
        if den < 0:
            frac = float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    offset = (lags[best] + frac) * frame_sec
    conf = float(scores[best] / (norm_e * norm_n))
    if conf < 0.2:
        warn.append(f"low alignment confidence ({conf:.2f}); check preroll_sec or pass --offset")
    return OffsetEstimate(offset, conf, "xcorr", warn)
