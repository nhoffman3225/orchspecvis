"""Session -> bundle writer.

Writes into a temporary sibling directory and renames it into place at the end, so a
crashed run never leaves a half-written bundle that looks valid.
"""

from __future__ import annotations

import datetime as dt
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from orchspec import __version__
from orchspec.bundle.schema import (
    MANIFEST_NAME,
    CqtInfo,
    DominantStem,
    Manifest,
    Offsets,
    Series,
    SourceInfo,
    Stem,
)
from orchspec.dsp.cqt import CQTBackend, CQTSpec, TorchBackend, calibrated_db, get_backend
from orchspec.dsp.features import onset_envelope, short_term_lufs, spectral_centroid
from orchspec.dsp.tiles import (
    DominantAccumulator,
    lod_frame_counts,
    pyramid,
    quantize,
    write_level,
    write_pyramid,
)
from orchspec.io.audio import load_audio, sha256_file, to_mono
from orchspec.io.session import Session

AudioLoader = Callable[[], np.ndarray]  # -> (channels, n) float32


@dataclass(frozen=True)
class BundleOptions:
    k: int = 3
    hop: int = 512
    backend: str = "librosa"
    device: str | None = None
    db_min: float = -96.0
    db_max: float = 6.0
    tile_frames: int = 1024
    dominant_floor_db: float = -60.0
    energy_min_seconds: float = 0.05  # stem energy table at the first level >= this hop
    lufs_hop_seconds: float = 0.1


@dataclass
class StemInput:
    id: str
    name: str
    source_file: str
    load: AudioLoader


@dataclass
class BundleInputs:
    name: str
    sr: int
    mix_load: AudioLoader
    mix_audio_file: Path  # copied byte-for-byte into the bundle
    stems: list[StemInput] = field(default_factory=list)
    source: SourceInfo | None = None
    offsets: Offsets = field(default_factory=Offsets)


@dataclass
class BundleReport:
    path: Path
    manifest: Manifest
    seconds: dict[str, float]


def inputs_from_session(s: Session) -> BundleInputs:
    def loader(p: Path) -> AudioLoader:
        return lambda: load_audio(p)[0]

    cfg = s.config
    return BundleInputs(
        name=s.name,
        sr=s.mix.sr,
        mix_load=loader(s.mix.path),
        mix_audio_file=s.mix.path,
        stems=[
            StemInput(
                id=st.stem_id,
                name=st.player,
                source_file=st.info.path.name,
                load=loader(st.info.path),
            )
            for st in s.stems
        ],
        source=SourceInfo(
            kind="session" if s.root else "wav",
            name=s.name,
            renderer=str(cfg.renderer) if s.root else None,
            render_config=cfg.model_dump(mode="json") if s.root else None,
        ),
        offsets=Offsets(preroll_sec=cfg.preroll_sec),
    )


def resolve_output(out: Path, name: str) -> Path:
    """`-o out/` -> out/<name>.bundle ; `-o x.bundle` -> x.bundle."""
    return out if out.suffix == ".bundle" else out / f"{name}.bundle"


def _energy_level(spec: CQTSpec, min_seconds: float, n_levels: int) -> int:
    lv = 0
    while lv < n_levels - 1 and spec.hop * 2**lv / spec.sr < min_seconds:
        lv += 1
    return lv


def _frame_energy_db(db: np.ndarray, level: int) -> np.ndarray:
    """(n_bins, n_frames) calibrated dB -> total power in dB, mean over 2^level frames."""
    p = (10.0 ** (db.astype(np.float64) / 10.0)).sum(axis=0)
    f = 2**level
    n_out = -(-len(p) // f)
    padded = np.concatenate([p, np.full(n_out * f - len(p), p[-1])])
    m = padded.reshape(n_out, f).mean(axis=1)
    return (10.0 * np.log10(np.maximum(m, 1e-20))).astype(np.float32)


def _write_f32(root: Path, rel: str, a: np.ndarray) -> None:
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_bytes(np.ascontiguousarray(a, dtype="<f4").tobytes())


class _Timer:
    def __init__(self) -> None:
        self.t: dict[str, float] = {}

    def add(self, key: str, t0: float) -> None:
        self.t[key] = self.t.get(key, 0.0) + time.perf_counter() - t0


def build_bundle(
    inputs: BundleInputs,
    out: Path,
    opts: BundleOptions | None = None,
    overwrite: bool = False,
    log: Callable[[str], None] = lambda _m: None,
) -> BundleReport:
    opts = opts or BundleOptions()
    out = out.resolve()
    if out.exists():
        if not overwrite:
            raise FileExistsError(f"{out} exists (use --overwrite)")
        if not (out / MANIFEST_NAME).is_file():
            raise FileExistsError(f"{out} exists and is not a bundle; refusing to replace it")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{out.name}.", dir=out.parent))
    try:
        report = _build(inputs, tmp, opts, log)
        if out.exists():
            shutil.rmtree(out)
        tmp.rename(out)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    report.path = out
    return report


def _build(
    inputs: BundleInputs, root: Path, opts: BundleOptions, log: Callable[[str], None]
) -> BundleReport:
    tm = _Timer()
    spec = CQTSpec(sr=inputs.sr, hop=opts.hop, k=opts.k)
    backend: CQTBackend = get_backend(opts.backend, device=opts.device)
    db_min, db_max = opts.db_min, opts.db_max

    def analyse(y_mono: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        t0 = time.perf_counter()
        if isinstance(backend, TorchBackend):
            db, u8 = backend.calibrated_db_u8(y_mono, spec, db_min, db_max)
        else:
            db = calibrated_db(backend.magnitude(y_mono, spec), spec)
            u8 = np.ascontiguousarray(quantize(db, db_min, db_max).T)
        tm.add("cqt", t0)
        return db, u8

    # ---- mix
    t0 = time.perf_counter()
    mix = inputs.mix_load()
    mono = to_mono(mix)
    n_samples = mono.shape[0]
    tm.add("load", t0)
    log(f"mix: {n_samples / spec.sr:.1f} s, {mix.shape[0]} ch")
    mix_db, mix_u8 = analyse(mono)
    t0 = time.perf_counter()
    lods = write_pyramid(root, "tiles/mix", mix_u8, opts.tile_frames)
    tm.add("tiles", t0)

    t0 = time.perf_counter()
    hop_s = spec.hop / spec.sr
    lufs = short_term_lufs(mix, spec.sr, hop_seconds=opts.lufs_hop_seconds)
    features = []
    for fname, unit, arr, hop, desc in [
        (
            "lufs_short_term",
            "LUFS",
            lufs,
            opts.lufs_hop_seconds,
            "BS.1770 short-term loudness, 3 s centered window, floor -120",
        ),
        (
            "spectral_centroid",
            "Hz",
            spectral_centroid(mono, spec.sr, spec.hop),
            hop_s,
            "spectral centroid of the mono mix",
        ),
        (
            "onset_envelope",
            "a.u.",
            onset_envelope(mono, spec.sr, spec.hop),
            hop_s,
            "librosa onset strength of the mono mix",
        ),
    ]:
        rel = f"features/{fname}.f32"
        _write_f32(root, rel, arr)
        features.append(
            Series(
                name=fname, unit=unit, description=desc, path=rel, shape=[len(arr)], hop_seconds=hop
            )
        )
    tm.add("features", t0)
    del mix, mono, mix_db

    # ---- stems
    n_frames = spec.n_frames(n_samples)
    counts = lod_frame_counts(n_frames, opts.tile_frames)
    e_level = _energy_level(spec, opts.energy_min_seconds, len(counts))
    floor_u8 = int(quantize(np.array([opts.dominant_floor_db]), db_min, db_max)[0])
    acc = (
        DominantAccumulator(n_frames, spec.n_bins, opts.tile_frames, floor_u8)
        if inputs.stems
        else None
    )
    stems: list[Stem] = []
    energy = np.zeros((len(inputs.stems), counts[e_level]), dtype=np.float32)
    for i, st in enumerate(inputs.stems):
        t0 = time.perf_counter()
        y = to_mono(st.load())
        tm.add("load", t0)
        if y.shape[0] != n_samples:
            raise ValueError(f"stem {st.id}: {y.shape[0]} samples != mix {n_samples}")
        db, u8 = analyse(y)
        t0 = time.perf_counter()
        levels = pyramid(u8, opts.tile_frames)
        prefix = f"tiles/stem-{st.id}"
        slods = [write_level(root, prefix, lv, a, opts.tile_frames) for lv, a in enumerate(levels)]
        assert acc is not None
        acc.add(i, levels)
        energy[i] = _frame_energy_db(db, e_level)
        tm.add("tiles", t0)
        stems.append(Stem(id=st.id, index=i, name=st.name, source_file=st.source_file, lods=slods))
        log(f"stem {i + 1}/{len(inputs.stems)}: {st.id}")

    tables: list[Series] = []
    dominant = None
    if acc is not None:
        t0 = time.perf_counter()
        dominant = DominantStem(floor_db=opts.dominant_floor_db, lods=acc.write(root))
        _write_f32(root, "tables/stem_energy_db.f32", energy)
        tables.append(
            Series(
                name="stem_energy_db",
                unit="dB",
                path="tables/stem_energy_db.f32",
                shape=list(energy.shape),
                hop_seconds=spec.hop * 2**e_level / spec.sr,
                row_labels=[s.id for s in stems],
                description=f"per-stem total CQT power, mean over 2^{e_level} frames",
            )
        )
        tm.add("tiles", t0)

    # ---- audio copy + manifest
    t0 = time.perf_counter()
    src = inputs.mix_audio_file
    audio_rel = f"audio/mix{src.suffix.lower()}"
    (root / "audio").mkdir(exist_ok=True)
    shutil.copyfile(src, root / audio_rel)
    sha = sha256_file(root / audio_rel)
    tm.add("audio", t0)

    m = Manifest(
        created_by=f"orchspec {__version__}",
        created_at=dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        sr=spec.sr,
        hop=spec.hop,
        n_samples=n_samples,
        duration_seconds=n_samples / spec.sr,
        bins_per_octave=spec.bins_per_octave,
        n_bins=spec.n_bins,
        n_frames=n_frames,
        db_min=db_min,
        db_max=db_max,
        tile_frames=opts.tile_frames,
        lods=lods,
        audio_path=audio_rel,
        audio_sha256=sha,
        cqt=CqtInfo(
            backend=backend.name, k=spec.k, filter_scale=spec.filter_scale, window=spec.window
        ),
        offsets=inputs.offsets,
        source=inputs.source or SourceInfo(kind="wav", name=inputs.name),
        stems=stems,
        dominant=dominant,
        features=features,
        tables=tables,
    )
    (root / MANIFEST_NAME).write_text(
        m.model_dump_json(indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return BundleReport(path=root, manifest=m, seconds=tm.t)
