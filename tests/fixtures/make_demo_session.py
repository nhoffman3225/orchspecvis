"""Synthetic multi-stem demo session for trying the viewer (not used by tests).

    uv run python tests/fixtures/make_demo_session.py [session/demo]
    uv run orchspec bundle session/demo -o out/

Writes into git-ignored session/ by default: 30 s, 48 kHz, four "players" with harmonic
tones (cello line, violin melody, horn chords, timpani hits) and a stereo mix.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48_000
SECONDS = 30.0
REPO = Path(__file__).resolve().parents[2]


def _note(midi: float, dur: float, amp: float, n_harm: int, decay: float, rng) -> np.ndarray:  # type: ignore[no-untyped-def]
    t = np.arange(round(dur * SR)) / SR
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    vib = 1 + 0.003 * np.sin(2 * np.pi * 5.5 * t + rng.uniform(0, 6.28))
    phase = 2 * np.pi * f0 * np.cumsum(vib) / SR
    y = sum(np.sin(h * phase) * h**-decay for h in range(1, n_harm + 1) if h * f0 < 20_000)
    env = np.minimum(1, t / 0.04) * np.minimum(1, (dur - t) / 0.08)
    return (amp * env * y).astype(np.float32)


def _line(
    notes: list[tuple[float, float, float]], amp: float, n_harm: int, decay: float, seed: int
) -> np.ndarray:
    rng = np.random.default_rng(seed)
    out = np.zeros(round(SECONDS * SR), np.float32)
    for start, midi, dur in notes:
        seg = _note(midi, dur, amp, n_harm, decay, rng)
        i = round(start * SR)
        out[i : i + len(seg)] += seg[: len(out) - i]
    return out


def make(dest: Path) -> None:
    (dest / "stems").mkdir(parents=True, exist_ok=True)
    cello = _line(
        [
            (i * 2.0, m, 1.9)
            for i, m in enumerate([36, 43, 41, 38, 36, 45, 43, 36, 41, 43, 48, 36, 43, 38, 36])
        ],
        0.05,
        16,
        1.0,
        1,
    )
    scale = [72, 74, 76, 79, 81, 79, 76, 74, 72, 76, 79, 84, 83, 81, 79, 77, 76, 74, 72, 71]
    violin = _line([(1.0 + i * 1.4, m, 1.3) for i, m in enumerate(scale)], 0.04, 20, 0.8, 2)
    chords = [(60, 64, 67), (57, 60, 64), (62, 65, 69), (55, 59, 62)] * 2
    horn = _line(
        [(4.0 * i + 0.5, m, 3.6) for i, ch in enumerate(chords[:7]) for m in ch], 0.02, 10, 1.4, 3
    )
    rng = np.random.default_rng(4)
    timp = np.zeros(round(SECONDS * SR), np.float32)
    for t0 in np.arange(0.0, SECONDS - 1, 3.0):
        seg = _note(41, 1.0, 0.15, 6, 1.5, rng) * np.exp(-np.arange(SR) / (0.25 * SR)).astype(
            np.float32
        )
        noise = rng.standard_normal(2400).astype(np.float32) * np.exp(-np.arange(2400) / 300) * 0.1
        i = round(t0 * SR)
        timp[i : i + SR] += seg
        timp[i : i + 2400] += noise
    stems = {"01_Cello": cello, "02_Violin I": violin, "03_Horn in F": horn, "04_Timpani": timp}
    for name, y in stems.items():
        sf.write(dest / "stems" / f"{name}.wav", y, SR, subtype="FLOAT")
    mix = sum(stems.values())
    pan = np.stack([mix * 0.95, mix], axis=1)
    sf.write(dest / "mix.wav", pan, SR, subtype="FLOAT")
    (dest / "render.yaml").write_text(
        "renderer: other\nnotes: synthetic demo from tests/fixtures/make_demo_session.py\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "session" / "demo"
    make(target)
    print(f"wrote {target}")
