"""The suite runs under pytest-socket (see pyproject addopts); prove it is active."""

import socket

import pytest
from pytest_socket import SocketConnectBlockedError


@pytest.mark.filterwarnings("ignore:A test tried to use socket")
def test_outbound_socket_blocked() -> None:
    with pytest.raises(SocketConnectBlockedError):
        socket.create_connection(("93.184.215.14", 80), timeout=1)


def test_localhost_allowed_to_bind() -> None:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        assert s.getsockname()[0] == "127.0.0.1"
    finally:
        s.close()


def test_no_downloading_helpers_in_source() -> None:
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src"
    banned = (
        "librosa.example(",
        "torch.hub",
        "urllib.request",
        "requests.",
        "http.client",
        "pooch.",
    )
    for p in src.rglob("*.py"):
        text = p.read_text(encoding="utf-8")
        for b in banned:
            assert b not in text, f"{p}: uses {b}"
