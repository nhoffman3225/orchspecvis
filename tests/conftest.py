from __future__ import annotations

import pytest

from orchspec.dsp.cqt import get_backend


def _torch_device() -> str | None:
    try:
        import torch  # pyright: ignore[reportMissingImports]  (optional gpu extra)
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


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """`real` tests touch private local sessions: run them only when asked (-m real)."""
    if "real" in (config.getoption("-m") or ""):
        return
    skip = pytest.mark.skip(reason="local-only real-session test; run with -m real")
    for item in items:
        if "real" in item.keywords:
            item.add_marker(skip)
