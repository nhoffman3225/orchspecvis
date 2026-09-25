"""The torch onset envelope equals librosa's (the alignment's detector bias and thresholds
were measured on the librosa one). Skipped when torch (the `gpu` extra) is absent."""

import numpy as np
import pytest

from orchspec.timeline.align import onset_envelope_fine

torch = pytest.importorskip("torch")


def _attacks(sr: int) -> np.ndarray:
    rng = np.random.default_rng(1)
    y = np.zeros(sr * 3, dtype=np.float32)
    t = np.arange(int(0.2 * sr)) / sr
    for k, start in enumerate(np.arange(0.1, 2.7, 0.23)):
        i = int(start * sr)
        tone = np.sin(2 * np.pi * (220 * 2 ** (k / 12)) * t) * np.exp(-t * 18)
        y[i : i + len(t)] += 0.3 * tone.astype(np.float32)
    return y + 1e-4 * rng.standard_normal(y.shape).astype(np.float32)


def _check(device: str, sr: int) -> None:
    y = _attacks(sr)
    a, fa = onset_envelope_fine(y, sr)
    b, fb = onset_envelope_fine(y, sr, device)
    assert fa == fb and a.shape == b.shape
    assert np.max(np.abs(a - b)) <= 1e-4 * np.max(a)
    # the same onset peaks
    top = set(np.argsort(a)[-12:])
    assert top == set(np.argsort(b)[-12:])


@pytest.mark.parametrize("sr", [22050, 48000])
def test_torch_cpu_matches_librosa(sr: int) -> None:
    _check("cpu", sr)


@pytest.mark.gpu
def test_torch_cuda_matches_librosa() -> None:
    if not torch.cuda.is_available():
        pytest.skip("no CUDA device")
    _check("cuda", 48000)


def test_torch_centroid_matches_librosa() -> None:
    from orchspec.dsp.features import spectral_centroid

    sr = 48000
    y = _attacks(sr)
    y[: sr // 4] = 0.0  # silent frames: both give 0
    a = spectral_centroid(y, sr, 512)
    b = spectral_centroid(y, sr, 512, device="cpu")
    assert a.shape == b.shape
    np.testing.assert_allclose(b, a, rtol=1e-3, atol=0.5)  # Hz
