"""Hand-made tiny bundle for the viewer skeleton and the cross-language schema test.

Writes viewer/public/tiny-bundle/ (manifest.json + tiles are committed; the audio file is
git-ignored like all audio, so it is regenerated here and the viewer tolerates its absence).

    uv run python tests/fixtures/make_tiny_bundle.py [out_dir]
"""

from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from orchspec.bundle.schema import (
    MANIFEST_NAME,
    CqtInfo,
    Lod,
    Manifest,
    SourceInfo,
    Tile,
)

REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "viewer" / "public" / "tiny-bundle"

SR, HOP, K, TILE_FRAMES = 8000, 128, 1, 64
N_SAMPLES = 2 * SR
N_BINS = 88 * K
DB_MIN, DB_MAX = -96.0, 6.0


def tiny_audio() -> np.ndarray:
    t = np.arange(N_SAMPLES) / SR
    return (0.25 * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)


def tiny_audio_bytes() -> bytes:
    buf = io.BytesIO()
    sf.write(buf, tiny_audio(), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def tiny_level0() -> np.ndarray:
    """(n_frames, n_bins) uint8: floor + A4 ridge + C4 ridge + a rising diagonal."""
    n_frames = 1 + N_SAMPLES // HOP
    a = np.full((n_frames, N_BINS), 20, dtype=np.uint8)
    a[:, (69 - 21) * K] = 230
    a[: n_frames // 2, (60 - 21) * K] = 180
    for f in range(n_frames):
        a[f, int(f * (N_BINS - 1) / (n_frames - 1))] = 255
    return a


def build(out: Path) -> Manifest:
    out.mkdir(parents=True, exist_ok=True)
    level = tiny_level0()
    lods: list[Lod] = []
    lv = 0
    while True:
        tiles: list[Tile] = []
        for i, start in enumerate(range(0, level.shape[0], TILE_FRAMES)):
            chunk = level[start : start + TILE_FRAMES]
            rel = f"tiles/mix/L{lv}/{i:05d}.u8"
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(np.ascontiguousarray(chunk).tobytes())
            tiles.append(Tile(index=i, start_frame=start, n_frames=chunk.shape[0], path=rel))
        lods.append(Lod(level=lv, hop_factor=2**lv, n_frames=level.shape[0], tiles=tiles))
        if level.shape[0] <= TILE_FRAMES:
            break
        if level.shape[0] % 2:
            level = np.concatenate([level, level[-1:]])
        level = np.maximum(level[0::2], level[1::2])
        lv += 1

    audio = tiny_audio_bytes()
    (out / "audio").mkdir(exist_ok=True)
    (out / "audio" / "mix.wav").write_bytes(audio)
    m = Manifest(
        created_by="orchspec tests/fixtures/make_tiny_bundle.py",
        created_at="2026-09-24T00:00:00Z",
        sr=SR,
        hop=HOP,
        n_samples=N_SAMPLES,
        duration_seconds=N_SAMPLES / SR,
        bins_per_octave=12 * K,
        n_bins=N_BINS,
        n_frames=1 + N_SAMPLES // HOP,
        db_min=DB_MIN,
        db_max=DB_MAX,
        tile_frames=TILE_FRAMES,
        lods=lods,
        audio_path="audio/mix.wav",
        audio_sha256=hashlib.sha256(audio).hexdigest(),
        cqt=CqtInfo(backend="hand-made", k=K),
        source=SourceInfo(kind="wav", name="tiny"),
    )
    (out / MANIFEST_NAME).write_text(
        m.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return m


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    build(target)
    print(f"wrote {target}")
