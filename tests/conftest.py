from __future__ import annotations

import pytest

from orchspec.dsp.cqt import get_backend


def _torch_device() -> str | None:
    try:
        import torch
    except ImportError:
        return None
    return "cuda" if torch.cuda.is_available() else None


TORCH_DEVICE = _torch_device()

BACKEND_PARAMS = [
    pytest.param("librosa", id="librosa"),
    pytest.param(
        "torch",
        id="torch-cuda",
        marks=[
            pytest.mark.gpu,
            pytest.mark.skipif(TORCH_DEVICE is None, reason="needs torch with CUDA"),
        ],
    ),
]


@pytest.fixture(params=BACKEND_PARAMS)
def backend(request: pytest.FixtureRequest):  # type: ignore[no-untyped-def]
    return get_backend(request.param, device=TORCH_DEVICE)
