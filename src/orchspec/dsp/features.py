"""Time-series features: short-term loudness, spectral centroid, onset envelope."""

from __future__ import annotations

import librosa
import numpy as np
import pyloudnorm

LUFS_FLOOR = -120.0


def _k_weight(x: np.ndarray, sr: int) -> np.ndarray:
    """BS.1770 K-weighting (pre-filter shelf + RLB high-pass), pyloudnorm's parameters."""
    shelf = pyloudnorm.IIRfilter(4.0, 1 / np.sqrt(2), 1500.0, sr, "high_shelf")
    hp = pyloudnorm.IIRfilter(0.0, 0.5, 38.0, sr, "high_pass")
    return hp.apply_filter(shelf.apply_filter(x))


def _channel_weights(n_ch: int) -> np.ndarray:
    # BS.1770: L, R, C = 1.0; Ls, Rs = 1.41 (5.0/5.1 order L R C [LFE] Ls Rs)
    if n_ch <= 3:
        return np.ones(n_ch)
    w = np.ones(n_ch)
    if n_ch in (5, 6):
        w[-2:] = 1.41
    if n_ch == 6:
        w[3] = 0.0  # LFE
    return w


def short_term_lufs(
    y: np.ndarray, sr: int, hop_seconds: float = 0.1, window_seconds: float = 3.0
) -> np.ndarray:
    """(channels, n) or (n,) -> short-term loudness in LUFS at t = i * hop_seconds.

    Window of `window_seconds` centered on each time (zero-padded at the ends).
    Ungated, as in EBU R128 short-term loudness. Silence is clamped to LUFS_FLOOR.
    """
    y2 = np.atleast_2d(y).astype(np.float64)
    n = y2.shape[1]
    w = _channel_weights(y2.shape[0])
    power = np.zeros(n, dtype=np.float64)
    for c in range(y2.shape[0]):
        if w[c]:
            power += w[c] * _k_weight(y2[c], sr) ** 2
    win = round(window_seconds * sr)
    csum = np.concatenate([[0.0], np.cumsum(power)])
    n_out = 1 + int(np.floor(n / sr / hop_seconds))
    centers = np.round(np.arange(n_out) * hop_seconds * sr).astype(np.int64)
    lo = np.clip(centers - win // 2, 0, n)
    hi = np.clip(centers + (win - win // 2), 0, n)
    ms = (csum[hi] - csum[lo]) / win
    with np.errstate(divide="ignore"):
        lufs = -0.691 + 10.0 * np.log10(ms)
    return np.maximum(lufs, LUFS_FLOOR).astype(np.float32)


def spectral_centroid(y: np.ndarray, sr: int, hop: int, n_fft: int = 4096) -> np.ndarray:
    """Mono (n,) -> centroid in Hz per centered frame, shape (1 + n // hop,)."""
    c = librosa.feature.spectral_centroid(
        y=y.astype(np.float32), sr=sr, n_fft=n_fft, hop_length=hop, center=True
    )[0]
    return _fit(c.astype(np.float32), 1 + len(y) // hop)


def onset_envelope(y: np.ndarray, sr: int, hop: int) -> np.ndarray:
    """Mono (n,) -> librosa onset strength per centered frame, shape (1 + n // hop,)."""
    o = librosa.onset.onset_strength(y=y.astype(np.float32), sr=sr, hop_length=hop, center=True)
    return _fit(o.astype(np.float32), 1 + len(y) // hop)


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    if len(x) >= n:
        return x[:n]
    return np.pad(x, (0, n - len(x)), mode="edge")
