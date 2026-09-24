"""Audio file access. Filesystem paths only (never URLs)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

AUDIO_SUFFIXES = {".wav", ".flac", ".aif", ".aiff"}


@dataclass(frozen=True)
class AudioInfo:
    path: Path
    sr: int
    n_samples: int
    channels: int

    @property
    def duration(self) -> float:
        return self.n_samples / self.sr


def require_local_path(p: str | Path) -> Path:
    """Reject anything that looks like a URL; return a resolved local Path."""
    s = str(p)
    if "://" in s or s.lower().startswith(("http:", "https:", "ftp:", "file:")):
        raise ValueError(f"only local filesystem paths are accepted, got {s!r}")
    return Path(s).expanduser().resolve()


def audio_info(path: Path) -> AudioInfo:
    path = require_local_path(path)
    info = sf.info(str(path))
    return AudioInfo(
        path=path, sr=int(info.samplerate), n_samples=int(info.frames), channels=int(info.channels)
    )


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    """Load audio as float32 array of shape (channels, n_samples)."""
    path = require_local_path(path)
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data.T), int(sr)


def to_mono(y: np.ndarray) -> np.ndarray:
    """(channels, n) or (n,) -> (n,) float32 mean over channels."""
    if y.ndim == 1:
        return y.astype(np.float32, copy=False)
    return y.mean(axis=0, dtype=np.float32)


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(chunk):
            h.update(block)
    return h.hexdigest()
