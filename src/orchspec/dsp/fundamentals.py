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


def note_fundamental_levels(
    db: np.ndarray, spec: CQTSpec, midi: np.ndarray, onset_s: np.ndarray, offset_s: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """db: calibrated (n_bins, n_frames). Returns (f0_db, f0_ok) per note, float32.

    Vectorized: a 3-bin max over the whole spectrogram once, then per-note medians over
    each note's frames computed in length-sorted batches (padding masked with NaN).
    Equal to the per-note loop (_band_level + np.median; tests/test_fundamentals.py).
    """
    n = len(midi)
    f0_db = np.full(n, FLOOR_DB, dtype=np.float32)
    ok = np.zeros(n, dtype=np.float32)
    if n == 0:
        return f0_db, ok
    nb, nf = db.shape
    fps = spec.sr / spec.hop
    on = np.asarray(onset_s, dtype=np.float64)
    off = np.asarray(offset_s, dtype=np.float64)
    t0 = on + np.maximum(0.1 * (off - on), 0.03)
    a = np.maximum(0, np.ceil(t0 * fps).astype(np.int64))
    b = np.minimum(nf, np.floor(off * fps).astype(np.int64) + 1)
    empty = b <= a
    a[empty] = np.clip(np.round(on[empty] * fps).astype(np.int64), 0, nf - 1)
    b[empty] = a[empty] + 1
    base = (np.asarray(midi, dtype=np.float64) - A0_MIDI) * spec.k
    valid = (base >= -0.5) & (base <= nb - 0.5)
    # bm[c] = max over bins c-1..c+1 (clipped to the spectrogram), for c = 0..nb
    pad = np.full((1, nf), -np.inf, dtype=db.dtype)
    padded = np.vstack([pad, db, pad, pad])
    bm = np.maximum(np.maximum(padded[:-2], padded[1:-1]), padded[2:])[: nb + 1]

    def medians(center: np.ndarray, sel: np.ndarray) -> np.ndarray:
        out = np.full(n, -np.inf)
        idx = np.flatnonzero(sel)
        if not len(idx):
            return out
        rows = np.round(center[idx]).astype(np.int64)  # half to even, like round()
        lens = b[idx] - a[idx]
        order = np.argsort(lens, kind="stable")
        i = 0
        while i < len(order):  # 512 notes of similar length per batch: little padding
            j = i + 512
            chunk = order[i:j]
            lmax = int(lens[chunk].max())
            cols = a[idx[chunk], None] + np.arange(lmax)[None, :]
            vals = bm[rows[chunk, None], np.minimum(cols, nf - 1)]  # float32 like the loop
            vals[np.arange(lmax)[None, :] >= lens[chunk, None]] = np.nan
            out[idx[chunk]] = np.nanmedian(vals, axis=1)
            i = j
        return out

    lvl = medians(base, valid)
    strongest = np.full(n, -np.inf)
    for h in (2, 3, 4):
        c = base + 12 * spec.k * np.log2(h)
        strongest = np.maximum(strongest, medians(c, valid & (c < nb - 0.5)))
    f0_db[valid] = np.maximum(lvl[valid], FLOOR_DB)
    ok[valid] = ((lvl > FLOOR_DB) & (lvl >= strongest - WEAK_DB))[valid]
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
