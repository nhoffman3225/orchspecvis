"""Fundamentals: measured level at each note's fundamental, and audio-only f0 tracks.

Score-informed: for a note with sounding MIDI pitch m, the fundamental bin is
b = (m - 21) * k. Its level is the per-frame max over bins b-1..b+1 (+-1/3 semitone at
k=3), median over the note's sustain (skipping the first 10 % and 30 ms of attack).
A note's fundamental is "weak" when it is more than WEAK_DB below the strongest of
harmonics 2..4, or below the floor.

Audio-only fallback (no score/MIDI): librosa yin/pyin f0 per stem (monophonic stems).
"""

from __future__ import annotations

import librosa
import numpy as np

from orchspec.dsp.cqt import A0_MIDI, CQTSpec

WEAK_DB = 12.0
FLOOR_DB = -80.0


def _band_level(db: np.ndarray, center: float, f0: int, f1: int) -> np.ndarray:
    b = round(center)
    lo, hi = max(0, b - 1), min(db.shape[0], b + 2)
    if lo >= hi:
        return np.full(max(0, f1 - f0), -np.inf, dtype=np.float32)
    return db[lo:hi, f0:f1].max(axis=0)


def note_fundamental_levels(
    db: np.ndarray, spec: CQTSpec, midi: np.ndarray, onset_s: np.ndarray, offset_s: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """db: calibrated (n_bins, n_frames). Returns (f0_db, f0_ok) per note, float32."""
    n = len(midi)
    f0_db = np.full(n, FLOOR_DB, dtype=np.float32)
    ok = np.zeros(n, dtype=np.float32)
    fps = spec.sr / spec.hop
    for i in range(n):
        dur = offset_s[i] - onset_s[i]
        t0 = onset_s[i] + max(0.1 * dur, 0.03)
        a, b = int(np.ceil(t0 * fps)), int(np.floor(offset_s[i] * fps)) + 1
        a, b = max(0, a), min(db.shape[1], b)
        if b <= a:
            a = max(0, min(db.shape[1] - 1, round(onset_s[i] * fps)))
            b = a + 1
        base = (midi[i] - A0_MIDI) * spec.k
        if base < -0.5 or base > spec.n_bins - 0.5:
            continue
        lvl = float(np.median(_band_level(db, base, a, b)))
        harm = [
            float(np.median(_band_level(db, base + 12 * spec.k * np.log2(h), a, b)))
            for h in (2, 3, 4)
            if base + 12 * spec.k * np.log2(h) < spec.n_bins - 0.5
        ]
        f0_db[i] = max(lvl, FLOOR_DB)
        strongest = max(harm) if harm else -np.inf
        ok[i] = float(lvl > FLOOR_DB and lvl >= strongest - WEAK_DB)
    return f0_db, ok


def f0_track(
    y: np.ndarray,
    sr: int,
    hop: int,
    n_frames: int,
    method: str = "yin",
    fmin: float = 27.5,
    fmax: float = 4186.0,
    voiced_db: float = -50.0,
) -> np.ndarray:
    """Mono stem -> f0 in Hz per centered frame (0 = unvoiced), shape (n_frames,)."""
    frame_length = 4096 if sr > 32000 else 2048
    fmin = max(fmin, 2.0 * sr / frame_length)  # yin needs two periods in the frame
    y = y.astype(np.float32)
    if method == "pyin":
        f0, voiced, _ = librosa.pyin(
            y, fmin=fmin, fmax=fmax, sr=sr, frame_length=frame_length, hop_length=hop, center=True
        )
        f0 = np.where(voiced, f0, 0.0)
    else:
        f0 = librosa.yin(
            y, fmin=fmin, fmax=fmax, sr=sr, frame_length=frame_length, hop_length=hop, center=True
        )
        rms = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop, center=True)[0]
        f0 = np.where(20 * np.log10(np.maximum(rms, 1e-10)) > voiced_db, f0, 0.0)
    f0 = np.nan_to_num(f0, nan=0.0).astype(np.float32)
    if len(f0) >= n_frames:
        return f0[:n_frames]
    return np.pad(f0, (0, n_frames - len(f0)))
