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


KERNEL = np.exp(-0.5 * (np.arange(-3, 4) / 1.0) ** 2)  # onset impulse, +-3 frames


def _prep(env: np.ndarray) -> np.ndarray:
    """Onset envelope with its median removed and negatives clipped."""
    return np.maximum(env - np.median(env), 0.0)


def _lag_scores(e: np.ndarray, frames: np.ndarray, lags: np.ndarray) -> np.ndarray:
    """Score of each lag (frames): sum of the kernel-weighted envelope at onset + lag."""
    n = len(e)
    idx = frames[None, :] + lags[:, None]  # (L, E)
    out = np.zeros(len(lags))
    for k, w in zip(range(-3, 4), KERNEL, strict=True):
        j = idx + k
        ok = (j >= 0) & (j < n)
        out += w * np.where(ok, e[np.clip(j, 0, n - 1)], 0.0).sum(axis=1)
    return out


def _peak(scores: np.ndarray) -> tuple[int, float]:
    """Index of the maximum and its parabolic sub-step correction in [-0.5, 0.5]."""
    best = int(np.argmax(scores))
    frac = 0.0
    if 0 < best < len(scores) - 1:
        a, b, c = scores[best - 1], scores[best], scores[best + 1]
        den = a - 2 * b + c
        if den < 0:
            frac = float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    return best, frac


_BIAS_CACHE: dict[int, float] = {}


def detector_bias(sr: int) -> float:
    """Measured lag of onset_envelope_fine's peak behind a sharp attack (seconds).

    Self-calibration instead of a constant: render a 5 ms-attack harmonic tone at a known
    time, find the envelope peak (parabolic), return peak - true onset. Slow attacks
    (bowed strings, pads) peak later; this corrects only the detector's own lag.
    """
    if sr not in _BIAS_CACHE:
        n = sr
        t = np.arange(n) / sr
        at = 0.5
        y = np.zeros(n, dtype=np.float32)
        tt = t[t >= at] - at
        tone = sum(np.sin(2 * np.pi * h * 330.0 * tt) / h for h in (1, 2, 3, 4))
        y[t >= at] = (0.3 * np.minimum(1.0, tt / 0.005) * tone).astype(np.float32)
        env, fs = onset_envelope_fine(y, sr)
        best, frac = _peak(env)
        _BIAS_CACHE[sr] = (best + frac) * fs - at
    return _BIAS_CACHE[sr]


def estimate_offset(
    env: np.ndarray, frame_sec: float, onsets_sec: np.ndarray, prior: float, search: float = 1.5
) -> OffsetEstimate:
    """Find offset d maximizing correlation of the audio onset envelope with note onsets
    shifted by d, for d in [prior - search, prior + search]."""
    warn: list[str] = []
    if len(onsets_sec) == 0 or not np.any(env > 0):
        return OffsetEstimate(prior, 0.0, "preroll_only", ["no onsets to align; using preroll"])
    e = _prep(env)
    norm_e = np.sqrt(np.sum(e**2)) or 1.0
    lags = np.arange(round((prior - search) / frame_sec), round((prior + search) / frame_sec) + 1)
    frames = np.unique(np.round(onsets_sec / frame_sec).astype(np.int64))
    scores = _lag_scores(e, frames, lags)
    norm_n = np.sqrt(len(frames) * float(np.sum(KERNEL**2)))
    best, frac = _peak(scores)
    if best in (0, len(lags) - 1):
        warn.append("offset estimate hit the edge of the search window")
    offset = (lags[best] + frac) * frame_sec
    conf = float(scores[best] / (norm_e * norm_n))
    if conf < 0.2:
        warn.append(f"low alignment confidence ({conf:.2f}); check preroll_sec or pass --offset")
    return OffsetEstimate(offset, conf, "xcorr", warn)


# --------------------------------------------------------------------------- warping


@dataclass
class Warp:
    """Monotonic piecewise-linear map from score/MIDI seconds to audio seconds.
    Outside the anchors it continues with the local tempo ratio (slope over the last or
    first ~2 s of anchors, clamped to [0.5, 2])."""

    src: np.ndarray
    dst: np.ndarray

    def _end_slope(self, first: bool, span: float = 2.0) -> float:
        src, dst = (self.src, self.dst) if not first else (self.src[::-1], self.dst[::-1])
        k = len(src) - 1
        j = k
        while j > 0 and abs(src[k] - src[j - 1]) < span:
            j -= 1
        if j == k:
            j = max(0, k - 1)
        ds = src[k] - src[j]
        return float(np.clip((dst[k] - dst[j]) / ds, 0.5, 2.0)) if ds else 1.0

    def __call__(self, t: np.ndarray | float) -> np.ndarray:
        t = np.asarray(t, dtype=np.float64)
        if len(self.src) == 1:
            return t + (self.dst[0] - self.src[0])
        inside = np.interp(t, self.src, self.dst)
        before = self.dst[0] + (t - self.src[0]) * self._end_slope(first=True)
        after = self.dst[-1] + (t - self.src[-1]) * self._end_slope(first=False)
        return np.where(t < self.src[0], before, np.where(t > self.src[-1], after, inside))

    def pairs(self, max_points: int = 2000) -> list[tuple[float, float]]:
        step = max(1, len(self.src) // max_points)
        idx = list(range(0, len(self.src), step))
        if idx[-1] != len(self.src) - 1:
            idx.append(len(self.src) - 1)
        return [(float(self.src[i]), float(self.dst[i])) for i in idx]


def _median_filter(x: np.ndarray, size: int) -> np.ndarray:
    if len(x) < size or size < 2:
        return x.copy()
    h = size // 2
    pad = np.concatenate([np.full(h, x[0]), x, np.full(h, x[-1])])
    return np.array([np.median(pad[i : i + size]) for i in range(len(x))])


def semitone_activity(db: np.ndarray, k: int) -> np.ndarray:
    """Calibrated CQT dB (n_bins, n_frames) -> (88, n_frames) pitch activity in [0, 1]:
    max over each semitone's k bins, per-frame median removed (whitening against broadband
    energy), clipped at 0, scaled by the frame maximum."""
    n_semi = db.shape[0] // k
    s = db[: n_semi * k].reshape(n_semi, k, -1).max(axis=1)
    s = s - np.median(s, axis=0, keepdims=True)
    s = np.maximum(s, 0.0)
    peak = s.max(axis=0, keepdims=True)
    return (s / np.where(peak > 0, peak, 1.0)).astype(np.float32)


def _note_cells(
    midi: np.ndarray,
    on: np.ndarray,
    off: np.ndarray,
    frame_sec: float,
    key0: int = 21,
    n_semi: int = 88,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Sparse template: (semitone, frame, seconds since onset, sustain weight) for every
    frame a note sounds, frames in score time."""
    ss, ff, tt, ww = [], [], [], []
    for m, a, b in zip(midi, on, off, strict=True):
        s = round(m) - key0
        if not 0 <= s < n_semi:
            continue
        f0, f1 = round(a / frame_sec), int(np.floor(b / frame_sec))
        if f1 < f0:
            f1 = f0
        fr = np.arange(f0, f1 + 1)
        ss.append(np.full(len(fr), s))
        ff.append(fr)
        tt.append(fr * frame_sec - a)
        # each note's sustained cells together weigh about as much as ~0.25 s of cells,
        # so long notes do not drown out the onsets of short ones
        ww.append(np.full(len(fr), min(1.0, 0.25 / max(b - a, 1e-3))))
    if not ss:
        e = np.zeros(0, np.int64)
        return e, e, np.zeros(0), np.zeros(0)
    return np.concatenate(ss), np.concatenate(ff), np.concatenate(tt), np.concatenate(ww)


ONSET_TAU = 0.08  # s; how fast a cell's weight on the flux feature decays after onset
SUSTAIN_W = 0.2  # weight of sustained pitch activity relative to pitch onsets


def pitch_flux(act: np.ndarray) -> np.ndarray:
    """Per-semitone positive change of pitch activity (a pitch-specific onset feature)."""
    f = np.zeros_like(act)
    f[:, 1:] = np.maximum(act[:, 1:] - act[:, :-1], 0.0)
    f[:, 1:-1] = np.maximum(f[:, 1:-1], 0.5 * (f[:, :-2] + f[:, 2:]))  # tolerate 1-frame smear
    return f


def _pitch_scores(
    act: np.ndarray,
    flux: np.ndarray,
    sem: np.ndarray,
    frm: np.ndarray,
    rel: np.ndarray,
    sus: np.ndarray,
    lags: np.ndarray,
    wts: np.ndarray | None = None,
) -> np.ndarray:
    """Per lag: sum over template cells of onset-weighted pitch flux plus a little
    sustained pitch activity at (semitone, frame + lag)."""
    n = act.shape[1]
    j = frm[None, :] + lags[:, None]
    ok = (j >= 0) & (j < n)
    jj = np.clip(j, 0, n - 1)
    w_on = np.exp(-rel / ONSET_TAU)[None, :]
    w_sus = (SUSTAIN_W * sus)[None, :]
    val = np.where(ok, w_on * flux[sem[None, :], jj] + w_sus * act[sem[None, :], jj], 0.0)
    if wts is not None:
        val = val * wts[None, :]
    return val.sum(axis=1)


@dataclass
class WarpResult:
    warp: Warp  # coarse score -> audio map (pitch-aware)
    global_offset: float
    confidence: float  # mean normalized pitch match at the anchors (0..1)
    warnings: list[str]


def estimate_warp(
    act: np.ndarray,
    act_frame_sec: float,
    midi: np.ndarray,
    on: np.ndarray,
    off: np.ndarray,
    prior: float,
    search: float = 1.5,
    anchor_step: float = 0.5,
    sigma: float = 0.75,
    track: float = 0.1,
) -> WarpResult:
    """Pitch-aware coarse warp from score/MIDI seconds to audio seconds.

    1. global: correlate the whole note template with the audio pitch activity over
       prior +- search (breaks the beat-periodic ambiguity of onset-only correlation)
    2. anchors every `anchor_step` s of score time; each correlates the template cells
       Gaussian-weighted around it (sigma), searching +-track around the previous anchor
       (sequential tracking, so gradual drift accumulates correctly)
    3. median-smoothed anchor offsets -> monotonic piecewise-linear warp
    Onset-accurate timing comes afterwards from snap_onsets().
    """
    warn: list[str] = []
    sem, frm, rel, sus = _note_cells(midi, on, off, act_frame_sec)
    if len(sem) == 0:
        w = Warp(np.array([0.0]), np.array([prior]))
        return WarpResult(w, prior, 0.0, ["no pitched notes to align; using preroll"])
    flux = pitch_flux(act)
    lags = np.arange(
        round((prior - search) / act_frame_sec), round((prior + search) / act_frame_sec) + 1
    )
    sc = _pitch_scores(act, flux, sem, frm, rel, sus, lags)
    best, frac = _peak(sc)
    g = (lags[best] + frac) * act_frame_sec
    if best in (0, len(lags) - 1):
        warn.append("global offset hit the edge of the search window; check preroll_sec")

    t_first, t_last = float(on.min()), float(off.max())
    anchors = np.arange(t_first, t_last + 1e-9, anchor_step)
    cell_t = frm * act_frame_sec
    tr = max(1, round(track / act_frame_sec))
    offs, confs = [], []
    prev = g
    for t in anchors:
        sel = np.abs(cell_t - t) <= 3 * sigma
        if sel.sum() < 3:
            offs.append(prev)
            confs.append(0.0)
            continue
        wts = np.exp(-0.5 * ((cell_t[sel] - t) / sigma) ** 2)
        c0 = round(prev / act_frame_sec)
        lg = np.arange(c0 - tr, c0 + tr + 1)
        s2 = _pitch_scores(act, flux, sem[sel], frm[sel], rel[sel], sus[sel], lg, wts)
        b2, f2 = _peak(s2)
        o = (lg[b2] + f2) * act_frame_sec
        offs.append(o)
        w_on = np.exp(-rel[sel] / ONSET_TAU) + SUSTAIN_W * sus[sel]
        confs.append(float(s2[b2] / float((wts * w_on).sum())))
        prev = o
    offs_a = _median_filter(np.array(offs), 3)
    dst = anchors + offs_a
    for i in range(1, len(dst)):
        dst[i] = max(dst[i], dst[i - 1] + 1e-4)
    conf = float(np.mean(confs)) if confs else 0.0
    # threshold from the first real Dorico + NotePerformer session (dense tutti: 0.23 and
    # visually correct); sparse synthetic material scores 0.6-0.8
    if conf < 0.1:
        warn.append(f"low pitch-match confidence ({conf:.2f}) while aligning")
    return WarpResult(Warp(anchors, dst), g, conf, warn)


def snap_onsets(
    env: np.ndarray, frame_sec: float, predicted: np.ndarray, snap: float | np.ndarray = 0.06
) -> tuple[np.ndarray, np.ndarray]:
    """Move each predicted onset (audio seconds) to the nearest strong onset-envelope peak
    within +-snap (proximity-weighted). Use the part's OWN stem envelope when available so
    other parts cannot capture the snap. Returns (times, snapped mask)."""
    e = _prep(env)
    n = len(e)
    out = np.asarray(predicted, dtype=np.float64).copy()
    hit = np.zeros(len(out), dtype=bool)
    if n < 3 or not np.any(e > 0):
        return out, hit
    # a peak must stand out both from the typical positive envelope and from the loudest
    # onsets (stems are mostly silent, so the median alone admits noise)
    strong = max(float(np.median(e[e > 0]) * 2), 0.15 * float(e.max()))
    peaks = np.flatnonzero((e[1:-1] >= e[:-2]) & (e[1:-1] >= e[2:]) & (e[1:-1] > strong)) + 1
    if len(peaks) == 0:
        return out, hit
    sns = np.broadcast_to(np.asarray(snap, dtype=np.float64) / frame_sec, out.shape)
    for i, t in enumerate(out):
        sn = float(sns[i])
        c = t / frame_sec
        lo, hi = np.searchsorted(peaks, c - sn), np.searchsorted(peaks, c + sn, side="right")
        if lo >= hi:
            continue
        cand = peaks[lo:hi]
        score = e[cand] * np.exp(-0.5 * ((cand - c) / (sn / 2)) ** 2)
        j = int(cand[int(np.argmax(score))])
        a, b, cc = e[j - 1], e[j], e[j + 1]
        den = a - 2 * b + cc
        fr = float(np.clip(0.5 * (a - cc) / den, -0.5, 0.5)) if den < 0 else 0.0
        out[i] = (j + fr) * frame_sec
        hit[i] = True
    return out, hit


@dataclass
class NoteAlignment:
    onsets: np.ndarray  # audio seconds per note
    offsets: np.ndarray
    warp: Warp  # refined score -> audio warp (common to all parts)
    latency: dict[int, float]  # per part: median lag of its notes vs the common warp
    snapped: float  # fraction of notes snapped to an onset peak in the final pass
    part_snapped: dict[int, float]  # per part fraction snapped in the final pass


def _adaptive_windows(pred: np.ndarray, cap: float) -> np.ndarray:
    """Per note: min(cap, 0.45 * gap to the nearest other onset time of the same part)."""
    order = np.argsort(pred)
    t = pred[order]
    uniq = np.unique(np.round(t, 4))
    out = np.full(len(pred), cap)
    if len(uniq) < 2:
        return out
    pos = np.searchsorted(uniq, np.round(t, 4))
    prev_gap = np.where(pos > 0, uniq[np.maximum(pos - 1, 0)], -np.inf)
    next_gap = np.where(pos < len(uniq) - 1, uniq[np.minimum(pos + 1, len(uniq) - 1)], np.inf)
    gap = np.minimum(np.round(t, 4) - prev_gap, next_gap - np.round(t, 4))
    out[order] = np.minimum(cap, 0.45 * gap)
    return out


def align_notes(
    coarse: Warp,
    part: np.ndarray,
    on: np.ndarray,
    off: np.ndarray,
    envs: dict[int, np.ndarray],
    mix_env: np.ndarray,
    frame_sec: float,
    passes: tuple[float, ...] = (0.12, 0.12, 0.04),
    bias: float = 0.0,
) -> NoteAlignment:
    """Onset-accurate note times from a coarse warp.

    Each pass: per part, snap its notes (predicted = warp + that part's latency) to onset
    peaks in the part's OWN stem envelope (mix envelope when it has no stem), with a
    per-note window never wider than 45 % of the gap to the part's neighbouring onsets;
    update the part latency (median residual); then rebuild the common warp from the
    snapped onsets (per score event: median of snapped - latency). Later passes use a
    tighter window. `bias` (see detector_bias) is subtracted from snapped onsets.
    """
    parts = np.unique(part.astype(np.int64))
    warp = coarse
    lat = {int(p_): 0.0 for p_ in parts}
    final = warp(on).astype(np.float64)
    frac = 0.0
    hits = np.zeros(len(on), dtype=bool)
    for win in passes:
        base = warp(on)
        final = base.copy()
        hits = np.zeros(len(on), dtype=bool)
        for p_ in parts:
            idx = np.flatnonzero(part == p_)
            pred = base[idx] + lat[int(p_)]
            env = envs.get(int(p_), mix_env)
            snapped, hit = snap_onsets(env, frame_sec, pred + bias, _adaptive_windows(pred, win))
            snapped = snapped - bias
            final[idx] = snapped
            hits[idx] = hit
            if hit.sum() >= 3:
                lat[int(p_)] = float(np.median(snapped[hit] - base[idx][hit]))
        frac = float(hits.mean()) if len(hits) else 0.0
        # rebuild the common warp from snapped onsets
        ev = np.unique(np.round(on, 4))
        key = np.round(on, 4)
        dst = np.empty(len(ev))
        for i, t in enumerate(ev):
            sel = (key == t) & hits
            if sel.any():
                dst[i] = float(np.median(final[sel] - np.array([lat[int(q)] for q in part[sel]])))
            else:
                dst[i] = float(warp(t))
        for i in range(1, len(dst)):
            dst[i] = max(dst[i], dst[i - 1] + 1e-4)
        warp = Warp(ev, dst)
    # report latencies relative to the typical part: fold their median into the warp
    common = float(np.median(list(lat.values()))) if lat else 0.0
    warp = Warp(warp.src, warp.dst + common)
    lat = {k: v - common for k, v in lat.items()}
    lat_arr = np.array([lat[int(q)] for q in part])
    offsets = np.maximum(warp(off) + lat_arr, final + 0.01)
    part_snapped = {int(p_): float(hits[part == p_].mean()) for p_ in parts}
    return NoteAlignment(final, offsets, warp, lat, frac, part_snapped)
