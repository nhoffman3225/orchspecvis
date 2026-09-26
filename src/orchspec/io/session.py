"""Session folder loading and validation.

Layout::

    <session>/
      mix.wav                  the full render; optional when there are stems (then the
                               stems are summed into the mix)
      stems/NN_<Player>.wav    optional, dry, same sr and length as mix (and each other)
      render.mid               optional (tempo track; Phase 2)
      score.musicxml | .mxl    optional (Phase 2)
      score.pdf                optional: the engraved (e.g. condensed) score to follow
      render.yaml              optional; see RenderConfig

A bare WAV file is also accepted (``load_input``) and becomes a session with no stems.
"""

from __future__ import annotations

import atexit
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

import numpy as np
import soundfile as sf
import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from orchspec.io.audio import AUDIO_SUFFIXES, AudioInfo, audio_info, load_audio, require_local_path

STEM_RE = re.compile(r"^(?P<num>\d{2,3})_(?P<player>.+)$")
MAX_STEMS = 254


class SessionError(ValueError):
    """A session folder is malformed. The message is meant for the user."""


class Renderer(StrEnum):
    dorico_noteperformer5 = "dorico_noteperformer5"
    cubase_bbcso_pro = "cubase_bbcso_pro"
    other = "other"


class RenderConfig(BaseModel):
    """Contents of render.yaml."""

    model_config = ConfigDict(extra="forbid")

    renderer: Renderer = Renderer.other
    mic_mix: str | None = Field(default=None, description="e.g. 'Mix 1', 'Tree+Outriggers'")
    reverb_in_stems: bool = False
    preroll_sec: float = Field(default=0.0, ge=0.0, description="silence before bar 1")
    mix_edited: bool = Field(default=False, description="mix was processed after stem export")
    players_per_section: dict[str, int] = Field(default_factory=dict)
    notes: str = ""


RENDER_YAML_TEMPLATE = """\
# render.yaml — describes how this session was rendered (all fields optional)
renderer: dorico_noteperformer5   # dorico_noteperformer5 | cubase_bbcso_pro | other
mic_mix: null                     # mic/mix preset name, e.g. "Mix 1"
reverb_in_stems: false            # true if stems include reverb/room
preroll_sec: 0.0                  # seconds of audio before bar 1 (audio time of score t=0)
mix_edited: false                 # true if mix.wav was processed after exporting stems
players_per_section: {}           # section -> number of players, e.g.
                                  #   {violins_1: 16, horns: 4}
notes: ""
"""


@dataclass(frozen=True)
class StemFile:
    number: int
    player: str
    stem_id: str
    info: AudioInfo


@dataclass(frozen=True)
class Session:
    root: Path | None
    mix: AudioInfo
    stems: list[StemFile] = field(default_factory=list)
    config: RenderConfig = field(default_factory=RenderConfig)
    midi_path: Path | None = None
    score_path: Path | None = None
    pdf_path: Path | None = None
    mix_summed: bool = False  # no mix file: `mix` is the sum of the stems (a temp file)

    @property
    def name(self) -> str:
        return self.root.name if self.root else self.mix.path.stem


def _audio_info_or_error(p: Path) -> AudioInfo:
    try:
        return audio_info(p)
    except Exception as e:  # soundfile raises various errors for unreadable files
        raise SessionError(f"{p}: unreadable audio ({e})") from e


def _find_mix(root: Path) -> Path | None:
    hits = [
        p
        for p in root.iterdir()
        if p.is_file() and p.stem.lower() == "mix" and p.suffix.lower() in AUDIO_SUFFIXES
    ]
    if not hits:
        return None
    if len(hits) > 1:
        raise SessionError(f"{root}: several mix files found: {sorted(h.name for h in hits)}")
    return hits[0]


def _load_config(root: Path) -> RenderConfig:
    p = root / "render.yaml"
    if not p.exists():
        return RenderConfig()
    try:
        raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise SessionError(f"{p}: invalid YAML: {e}") from e
    if not isinstance(raw, dict):
        raise SessionError(f"{p}: expected a mapping at top level")
    try:
        return RenderConfig.model_validate(raw)
    except ValidationError as e:
        raise SessionError(
            f"{p}: invalid render.yaml:\n{e}\n"
            "Run `orchspec session-template` to print a valid template."
        ) from e


def _sanitize_id(num: int, player: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", player).strip("-") or "stem"
    return f"{num:02d}_{slug}"


def _load_stems(root: Path, mix: AudioInfo | None) -> list[StemFile]:
    """The stems, checked against the mix (or, without a mix, against the first stem)."""
    d = root / "stems"
    if not d.is_dir():
        return []
    stems: list[StemFile] = []
    problems: list[str] = []
    ref = mix
    for p in sorted(d.iterdir(), key=lambda q: q.name.lower()):
        if not p.is_file() or p.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        m = STEM_RE.match(p.stem)
        if not m:
            problems.append(f"  {p.name}: name must look like NN_<Player>{p.suffix}")
            continue
        try:
            info = audio_info(p)
        except Exception as e:  # soundfile raises various errors for unreadable files
            problems.append(f"  {p.name}: unreadable audio ({e})")
            continue
        ref = ref or info
        what = "mix" if mix is not None else "the first stem"
        if info.sr != ref.sr:
            problems.append(f"  {p.name}: sample rate {info.sr} Hz != {what} {ref.sr} Hz")
        if info.n_samples != ref.n_samples:
            problems.append(
                f"  {p.name}: length {info.n_samples} samples ({info.duration:.3f} s) != "
                f"{what} {ref.n_samples} samples ({ref.duration:.3f} s); stems must be exported "
                "with the same start and length"
            )
        num = int(m["num"])
        stems.append(
            StemFile(
                number=num, player=m["player"], stem_id=_sanitize_id(num, m["player"]), info=info
            )
        )
    if problems:
        raise SessionError(f"{root}: invalid stems:\n" + "\n".join(problems))
    ids = [s.stem_id for s in stems]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise SessionError(f"{root}: duplicate stem ids after sanitizing names: {dupes}")
    if len(stems) > MAX_STEMS:
        raise SessionError(f"{root}: {len(stems)} stems exceeds the maximum of {MAX_STEMS}")
    return stems


def sum_stems(stems: list[StemFile], out: Path) -> AudioInfo:
    """Writes the sum of the stems (float WAV, so nothing clips) as the session's mix.
    Mono stems go to every channel; the mix has as many channels as the widest stem."""
    ch = max(s.info.channels for s in stems)
    acc: np.ndarray | None = None
    for st in stems:
        y, _ = load_audio(st.info.path)
        if acc is None:
            acc = np.zeros((ch, y.shape[1]), dtype=np.float64)
        acc += y if y.shape[0] == ch else np.broadcast_to(y[:1], acc.shape)
    assert acc is not None
    sf.write(str(out), acc.T.astype(np.float32), stems[0].info.sr, subtype="FLOAT")
    return audio_info(out)


def _temp_dir() -> Path:
    d = Path(tempfile.mkdtemp(prefix="orchspec-mix-"))
    atexit.register(shutil.rmtree, d, ignore_errors=True)
    return d


def load_session(path: str | Path) -> Session:
    """Load and validate a session folder. Without a mix file, the stems are summed into
    a temporary mix (the session folder is never written to)."""
    root = require_local_path(path)
    if not root.is_dir():
        raise SessionError(f"{root}: not a directory")
    mix_path = _find_mix(root)
    mix = _audio_info_or_error(mix_path) if mix_path is not None else None
    config = _load_config(root)
    stems = _load_stems(root, mix)
    summed = mix is None
    if mix is None:
        if not stems:
            raise SessionError(f"{root}: no mix.wav and no stems/ (one of them is required)")
        mix = sum_stems(stems, _temp_dir() / "mix.wav")
    midi = root / "render.mid"
    score = next(
        (root / n for n in ("score.musicxml", "score.mxl", "score.xml") if (root / n).is_file()),
        None,
    )
    return Session(
        root=root,
        mix=mix,
        stems=stems,
        config=config,
        midi_path=midi if midi.is_file() else None,
        score_path=score,
        pdf_path=(root / "score.pdf") if (root / "score.pdf").is_file() else None,
        mix_summed=summed,
    )


def load_input(path: str | Path) -> Session:
    """Accept either a session folder or a single audio file (mix only)."""
    p = require_local_path(path)
    if p.is_dir():
        return load_session(p)
    if p.is_file() and p.suffix.lower() in AUDIO_SUFFIXES:
        return Session(root=None, mix=_audio_info_or_error(p))
    raise SessionError(
        f"{p}: expected a session folder or an audio file ({', '.join(sorted(AUDIO_SUFFIXES))})"
    )
