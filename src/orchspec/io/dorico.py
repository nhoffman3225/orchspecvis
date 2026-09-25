"""Import a Dorico export folder into the orchspec session layout.

Dorico (5.x) writes, for audio export of a flow with "one file per player":

    <Project> - <Flow>.wav              the mix
    <Project> - <Flow> <Player>.wav     one per player (possibly in a sub-folder per flow)

plus whatever MIDI / MusicXML files were exported. The importer builds

    mix.wav, stems/NN_<Player>.wav, render.mid, score.musicxml, render.yaml

in the destination using hard links (no extra disk space; originals untouched), falling
back to copies across volumes. Stems are numbered in the MusicXML part order.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from orchspec.io.session import RENDER_YAML_TEMPLATE, SessionError
from orchspec.score.match import match_parts_to_stems

AUDIO = {".wav", ".flac", ".aif", ".aiff"}


@dataclass
class ImportPlan:
    mix: Path
    stems: list[tuple[str, Path]]  # (player name, file) in score order
    midi: Path | None
    score: Path | None
    warnings: list[str] = field(default_factory=list)


def _part_names(score: Path) -> list[str]:
    from orchspec.score.musicxml import load_musicxml_root

    root = load_musicxml_root(score)
    pl = root.find("part-list")
    if pl is None:
        return []
    names = []
    for sp in pl.findall("score-part"):
        el = sp.find("part-name")
        names.append((el.text or "").strip() if el is not None else "")
    return names


def plan_import(src: Path) -> ImportPlan:
    src = src.resolve()
    files = [p for p in src.rglob("*") if p.is_file() and not p.name.startswith(".")]

    # ignore anything already in the orchspec layout inside src (re-running is safe)
    def own(p: Path) -> bool:
        rel = p.relative_to(src).parts
        return rel[0] == "stems" or (len(rel) == 1 and p.stem.lower() in ("mix", "render", "score"))

    files = [p for p in files if not own(p)]
    audio = sorted(
        (p for p in files if p.suffix.lower() in AUDIO), key=lambda p: (len(p.stem), p.name)
    )
    if not audio:
        raise SessionError(f"{src}: no audio files found")
    mix = audio[0]
    prefix = mix.stem + " "
    players = [(p.stem[len(prefix) :].strip(), p) for p in audio[1:] if p.stem.startswith(prefix)]
    stray = [p.name for p in audio[1:] if not p.stem.startswith(prefix)]
    warn = [f"ignored audio not named '{prefix}<Player>': {', '.join(stray)}"] if stray else []

    mids = sorted(p for p in files if p.suffix.lower() in (".mid", ".midi"))
    xmls = sorted(p for p in files if p.suffix.lower() in (".musicxml", ".mxl", ".xml"))
    if len(mids) > 1:
        warn.append(f"several MIDI files, using {mids[0].name}")
    if len(xmls) > 1:
        warn.append(f"several MusicXML files, using {xmls[0].name}")
    score = xmls[0] if xmls else None

    ordered = players
    if score is not None and players:
        names = _part_names(score)
        matches = match_parts_to_stems(names, [n for n, _ in players])
        used: list[int] = []
        for m in matches:
            if m.stem_index is not None and m.stem_index not in used:
                used.append(m.stem_index)
        rest = [i for i in range(len(players)) if i not in used]
        ordered = [players[i] for i in used] + [players[i] for i in rest]
        if rest:
            warn.append(
                "players not matched to a score part (placed last): "
                + ", ".join(players[i][0] for i in rest)
            )
    return ImportPlan(
        mix=mix, stems=ordered, midi=mids[0] if mids else None, score=score, warnings=warn
    )


def _link(src: Path, dst: Path) -> str:
    if dst.exists():
        if dst.samefile(src):
            return "exists"
        raise SessionError(f"{dst} already exists and is a different file")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(src, dst)
        return "linked"
    except OSError:
        shutil.copy2(src, dst)
        return "copied"


def apply_import(
    plan: ImportPlan, dest: Path, renderer: str = "dorico_noteperformer5"
) -> list[str]:
    """Create the session layout in `dest`. Returns a log of actions."""
    dest.mkdir(parents=True, exist_ok=True)
    log = [f"{_link(plan.mix, dest / ('mix' + plan.mix.suffix.lower()))}: mix <- {plan.mix.name}"]
    for i, (player, path) in enumerate(plan.stems, start=1):
        safe = "".join(c for c in player if c not in '<>:"/\\|?*').strip() or f"Player {i}"
        target = dest / "stems" / f"{i:02d}_{safe}{path.suffix.lower()}"
        log.append(f"{_link(path, target)}: {target.name}")
    if plan.midi is not None:
        log.append(f"{_link(plan.midi, dest / 'render.mid')}: render.mid <- {plan.midi.name}")
    if plan.score is not None:
        name = "score.mxl" if plan.score.suffix.lower() == ".mxl" else "score.musicxml"
        log.append(f"{_link(plan.score, dest / name)}: {name} <- {plan.score.name}")
    ry = dest / "render.yaml"
    if not ry.exists():
        text = RENDER_YAML_TEMPLATE.replace(
            "renderer: dorico_noteperformer5", f"renderer: {renderer}"
        )
        text = text.replace('notes: ""', f'notes: "imported from {plan.mix.parent.name}"')
        ry.write_text(text, encoding="utf-8", newline="\n")
        log.append("wrote render.yaml")
    return log
