"""Deterministic synthetic test signals.

Run as a script to (re)write WAV fixtures + a JSON sidecar into tests/fixtures/synthetic/
(git-ignored, since *.wav never goes into git). Tests import the generator functions
directly, so nothing depends on files existing.

    uv run python tests/fixtures/make_synthetic.py [out_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

SR = 48_000
SEED = 20260924

SWEEP_F0 = 55.0  # A1 (MIDI 33)
SWEEP_F1 = 3520.0  # A7 (MIDI 93)
SWEEP_SECONDS = 10.0
CLICK_TIMES = (0.5, 1.0, 1.37, 2.0, 2.71, 3.3, 3.95)
CLICK_SECONDS = 4.5


def midi_to_hz(m: float) -> float:
    return 440.0 * 2.0 ** ((m - 69.0) / 12.0)


def log_sweep(
    sr: int = SR,
    seconds: float = SWEEP_SECONDS,
    f0: float = SWEEP_F0,
    f1: float = SWEEP_F1,
    amp: float = 0.5,
) -> np.ndarray:
    """Exponential sine sweep; instantaneous freq f0 * (f1/f0) ** (t / seconds)."""
    t = np.arange(round(sr * seconds)) / sr
    rate = np.log(f1 / f0)
    phase = 2 * np.pi * f0 * seconds / rate * (np.exp(t / seconds * rate) - 1.0)
    return (amp * np.sin(phase)).astype(np.float32)


def sweep_midi_at(t: np.ndarray | float, seconds: float = SWEEP_SECONDS) -> np.ndarray:
    """Expected MIDI pitch of log_sweep() at time t."""
    m0 = 69 + 12 * np.log2(SWEEP_F0 / 440.0)
    m1 = 69 + 12 * np.log2(SWEEP_F1 / 440.0)
    return np.asarray(m0 + (m1 - m0) * np.asarray(t) / seconds)


def tone(midi: float, sr: int = SR, seconds: float = 3.0, amp: float = 0.5) -> np.ndarray:
    t = np.arange(round(sr * seconds)) / sr
    return (amp * np.sin(2 * np.pi * midi_to_hz(midi) * t)).astype(np.float32)


def click_train(
    sr: int = SR,
    seconds: float = CLICK_SECONDS,
    times: tuple[float, ...] = CLICK_TIMES,
    amp: float = 0.9,
) -> np.ndarray:
    y = np.zeros(round(sr * seconds), dtype=np.float32)
    for t in times:
        y[round(t * sr)] = amp
    return y


def pink_noise(
    sr: int = SR, seconds: float = 5.0, rms: float = 0.1, seed: int = SEED
) -> np.ndarray:
    """1/f power spectrum noise via FFT shaping (deterministic for a given seed)."""
    rng = np.random.default_rng(seed)
    n = round(sr * seconds)
    spec = rng.standard_normal(n // 2 + 1) + 1j * rng.standard_normal(n // 2 + 1)
    f = np.fft.rfftfreq(n, 1 / sr)
    f[0] = f[1]
    spec /= np.sqrt(f)
    y = np.fft.irfft(spec, n)
    y *= rms / np.sqrt(np.mean(y**2))
    return y.astype(np.float32)


def all_fixtures(sr: int = SR) -> dict[str, np.ndarray]:
    return {
        "sweep_a1_a7": log_sweep(sr),
        "tone_a4": tone(69, sr),
        "tone_c4": tone(60, sr),
        "clicks": click_train(sr),
        "pink": pink_noise(sr),
    }


def write_fixtures(out_dir: Path, sr: int = SR) -> dict[str, Path]:
    import soundfile as sf

    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, Path] = {}
    for name, y in all_fixtures(sr).items():
        p = out_dir / f"{name}.wav"
        sf.write(str(p), y, sr, subtype="FLOAT")
        paths[name] = p
    meta = {
        "sr": sr,
        "seed": SEED,
        "sweep": {"f0": SWEEP_F0, "f1": SWEEP_F1, "seconds": SWEEP_SECONDS},
        "click_times": list(CLICK_TIMES),
        "tones_midi": {"tone_a4": 69, "tone_c4": 60},
    }
    (out_dir / "synthetic.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return paths


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "synthetic"
    for k, v in write_fixtures(target).items():
        print(f"{k}: {v}")
