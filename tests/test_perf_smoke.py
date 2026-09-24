"""Perf smoke (slow): 20 min 48 kHz mix + 30 stems -> bundle, CPU (librosa) and CUDA (torch).

    uv run pytest -m slow -s tests/test_perf_smoke.py

Audio is synthesized on the fly by each loader (deterministic), so the test does not need
~7 GB of WAVs on disk; only the mix is written (16-bit mono) because the bundle copies it.
Prints wall time per phase and peak VRAM. Target: < 2 min end-to-end on the RTX 5070 Ti.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from orchspec.bundle.writer import BundleInputs, BundleOptions, StemInput, build_bundle
from tests.conftest import TORCH_DEVICE

pytestmark = pytest.mark.slow

SR = 48_000
MINUTES = float(os.environ.get("ORCHSPEC_PERF_MINUTES", "20"))
N_STEMS = int(os.environ.get("ORCHSPEC_PERF_STEMS", "30"))
N = int(SR * 60 * MINUTES)


def _stem(i: int) -> np.ndarray:
    """A few partials of a pitch that moves every 2 s, plus a little noise."""
    rng = np.random.default_rng(1000 + i)
    t = np.arange(N, dtype=np.float64) / SR
    notes = rng.integers(28 + i, 60 + i, size=N // (2 * SR) + 1)
    midi = notes[(t // 2).astype(np.int64)]
    f = 440.0 * 2.0 ** ((midi - 69) / 12)
    phase = 2 * np.pi * np.cumsum(f) / SR
    y = sum(np.sin(h * phase) / h for h in (1, 2, 3))
    y = 0.02 * y + 0.001 * rng.standard_normal(N)
    return y.astype(np.float32)[None, :]


def _mix() -> np.ndarray:
    acc = np.zeros(N, dtype=np.float32)
    for i in range(N_STEMS):
        acc += _stem(i)[0]
    return acc[None, :]


def _inputs(tmp: Path) -> BundleInputs:
    mix_file = tmp / "mix.wav"
    if not mix_file.exists():
        sf.write(mix_file, _mix()[0], SR, subtype="PCM_16")
    return BundleInputs(
        name="perf",
        sr=SR,
        mix_load=lambda: sf.read(mix_file, dtype="float32", always_2d=True)[0].T,
        mix_audio_file=mix_file,
        stems=[
            StemInput(
                id=f"{i:02d}_Player",
                name=f"Player {i}",
                source_file=f"{i:02d}.wav",
                load=lambda i=i: _stem(i),
            )
            for i in range(N_STEMS)
        ],
    )


def _run(tmp: Path, backend: str) -> None:
    inputs = _inputs(tmp)
    peak = ""
    if backend == "torch":
        import torch

        torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    rep = build_bundle(
        inputs,
        tmp / f"{backend}.bundle",
        BundleOptions(backend=backend, device=TORCH_DEVICE),
        overwrite=True,
    )
    wall = time.perf_counter() - t0
    if backend == "torch":
        import torch

        peak = f", peak VRAM {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB"
    size = sum(p.stat().st_size for p in rep.path.rglob("*") if p.is_file()) / 2**30
    phases = ", ".join(f"{k} {v:.1f}s" for k, v in rep.seconds.items())
    print(
        f"\n[perf] {backend}: {MINUTES:g} min x ({N_STEMS} stems + mix) wall {wall:.1f}s "
        f"({phases}){peak}; bundle {size:.2f} GiB"
    )


@pytest.mark.skipif(TORCH_DEVICE is None, reason="needs CUDA")
@pytest.mark.gpu
def test_perf_cuda(tmp_path_factory: pytest.TempPathFactory) -> None:
    _run(tmp_path_factory.getbasetemp(), "torch")


def test_perf_cpu(tmp_path_factory: pytest.TempPathFactory) -> None:
    _run(tmp_path_factory.getbasetemp(), "librosa")
