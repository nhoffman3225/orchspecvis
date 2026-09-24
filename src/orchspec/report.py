"""`orchspec report <bundle>`: a human-readable check of a bundle's score alignment.

Turns the Phase 2 "Unverified assumptions" (PLAN.md) into explicit PASS/WARN checks so a
real session can confirm or refute them. Reads only the bundle (no audio).
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from orchspec.bundle.schema import MANIFEST_NAME, NOTE_COLUMNS, Manifest

TAIL_SEC = 0.5  # release/reverb allowance after a note when judging stem silence


@dataclass
class Check:
    name: str
    status: str  # PASS | WARN | INFO
    detail: str


@dataclass
class PartRow:
    index: int
    name: str
    stem: str | None
    stem_match: str
    notes: int
    weak_f0_pct: float
    median_f0_db: float | None
    out_of_range: int
    range: str
    separation_db: float | None  # stem level while playing minus while silent


@dataclass
class Report:
    bundle: str
    duration_s: float
    kind: str | None
    alignment: dict[str, object] = field(default_factory=dict)
    checks: list[Check] = field(default_factory=list)
    parts: list[PartRow] = field(default_factory=list)


def _notes(root: Path, m: Manifest) -> dict[str, np.ndarray]:
    assert m.score is not None
    raw = np.frombuffer((root / m.score.notes.path).read_bytes(), "<f4")
    return dict(zip(NOTE_COLUMNS, raw.reshape(len(NOTE_COLUMNS), m.score.notes.n), strict=True))


def _separation(
    root: Path, m: Manifest, stem_row: int, on: np.ndarray, off: np.ndarray
) -> float | None:
    tbl = next((t for t in m.tables if t.name == "stem_energy_db"), None)
    if tbl is None or len(on) == 0:
        return None
    e = np.frombuffer((root / tbl.path).read_bytes(), "<f4").reshape(tbl.shape)[stem_row]
    t = tbl.t0_seconds + np.arange(e.shape[0]) * tbl.hop_seconds
    active = np.zeros(e.shape[0], bool)
    for a, b in zip(on, off, strict=True):
        active |= (t >= a) & (t <= b + TAIL_SEC)
    if active.all() or not active.any():
        return None
    return float(np.median(e[active]) - np.median(e[~active]))


def build_report(bundle: Path) -> Report:
    root = bundle.resolve()
    m = Manifest.model_validate_json((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    rep = Report(
        bundle=root.name, duration_s=m.duration_seconds, kind=m.score.kind if m.score else None
    )
    if m.score is None:
        rep.checks.append(Check("score", "INFO", "bundle has no score/MIDI section"))
        return rep
    s = m.score
    a = s.alignment
    rep.alignment = a.model_dump()
    cols = _notes(root, m)

    # 1. MIDI exported at sounding pitch
    if a.pitch_agreement is None:
        rep.checks.append(
            Check(
                "midi_sounding_pitch",
                "INFO",
                "only one of MusicXML / render.mid present; not checked",
            )
        )
    elif a.pitch_agreement >= 0.95:
        rep.checks.append(
            Check(
                "midi_sounding_pitch",
                "PASS",
                f"{a.pitch_agreement:.1%} of MusicXML notes match render.mid",
            )
        )
    else:
        rep.checks.append(
            Check(
                "midi_sounding_pitch",
                "WARN",
                f"only {a.pitch_agreement:.1%} match; most common difference "
                f"{a.pitch_shift_mode:+d} semitones"
                if a.pitch_shift_mode is not None
                else f"only {a.pitch_agreement:.1%} match",
            )
        )

    # 2. time origin / renderer latency
    resid = a.offset_sec - a.preroll_sec
    status = "PASS" if a.method != "preroll_only" and a.confidence >= 0.3 else "WARN"
    rep.checks.append(
        Check(
            "time_origin",
            status,
            f"offset {a.offset_sec * 1000:.1f} ms = preroll {a.preroll_sec * 1000:.1f} ms + "
            f"residual {resid * 1000:+.1f} ms ({a.method}, confidence {a.confidence:.2f}); "
            "a residual of a few tens of ms is expected from the renderer",
        )
    )

    # 3. notes fit inside the audio
    last = float(cols["offset_s"].max()) if s.notes.n else 0.0
    first = float(cols["onset_s"].min()) if s.notes.n else 0.0
    ok = first >= 0 and last <= m.duration_seconds + 0.05
    rep.checks.append(
        Check(
            "notes_inside_audio",
            "PASS" if ok else "WARN",
            f"notes span {first:.3f}-{last:.3f} s, audio is {m.duration_seconds:.3f} s",
        )
    )

    # per part
    stem_row = {st.id: st.index for st in m.stems}
    total_oor = 0
    for p in s.parts:
        sel = cols["part"] == p.index
        n = int(sel.sum())
        midi = cols["midi"][sel]
        oor = 0
        if p.range_low is not None and p.range_high is not None:
            oor = int(((midi < p.range_low) | (midi > p.range_high)).sum())
        total_oor += oor
        sep = None
        if p.stem_id is not None:
            sep = _separation(
                root, m, stem_row[p.stem_id], cols["onset_s"][sel], cols["offset_s"][sel]
            )
        f0 = cols["f0_db"][sel]
        rep.parts.append(
            PartRow(
                index=p.index,
                name=p.name,
                stem=p.stem_id,
                stem_match=p.stem_match,
                notes=n,
                weak_f0_pct=float(100 * (1 - cols["f0_ok"][sel].mean())) if n else 0.0,
                median_f0_db=float(np.median(f0)) if n else None,
                out_of_range=oor,
                range=f"{p.range_low}-{p.range_high}" if p.range_low is not None else "?",
                separation_db=sep,
            )
        )

    # 4. transposition sanity: notes outside the instrument's sounding range
    rep.checks.append(
        Check(
            "notes_in_instrument_range",
            "PASS" if total_oor == 0 else "WARN",
            "all notes inside the instruments' sounding ranges"
            if total_oor == 0
            else f"{total_oor} notes outside their instrument's sounding range "
            "(transposition / octave-change handling, or an unusual extension)",
        )
    )

    # 5. stems cleanly separated
    seps = [r.separation_db for r in rep.parts if r.separation_db is not None]
    unmatched = [r.name for r in rep.parts if r.stem is None]
    if seps:
        worst = min(seps)
        rep.checks.append(
            Check(
                "stem_separation",
                "PASS" if worst >= 30 else "WARN",
                f"stem level while playing vs silent: worst {worst:.1f} dB, median "
                f"{float(np.median(seps)):.1f} dB (< 30 dB suggests bleed or reverb in stems)",
            )
        )
    if unmatched:
        rep.checks.append(
            Check("stem_matching", "WARN", f"parts without a stem: {', '.join(unmatched)}")
        )
    for w in a.warnings:
        rep.checks.append(Check("alignment_warning", "WARN", w))
    return rep


def to_markdown(rep: Report) -> str:
    lines = [
        f"# orchspec report — {rep.bundle}",
        "",
        f"Audio {rep.duration_s:.2f} s · score source: {rep.kind or 'none'}",
        "",
        "## Checks",
        "",
        "| check | status | detail |",
        "| --- | --- | --- |",
    ]
    lines += [f"| {c.name} | {c.status} | {c.detail} |" for c in rep.checks]
    if rep.parts:
        lines += [
            "",
            "## Parts",
            "",
            "| # | part | stem (match) | notes | weak f0 | median f0 dB | range | "
            "out of range | stem separation |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for r in rep.parts:
            sep = f"{r.separation_db:.1f} dB" if r.separation_db is not None else "—"
            f0 = f"{r.median_f0_db:.1f}" if r.median_f0_db is not None else "—"
            lines.append(
                f"| {r.index} | {r.name} | {r.stem or '—'} ({r.stem_match}) | "
                f"{r.notes} | {r.weak_f0_pct:.0f}% | {f0} | {r.range} | "
                f"{r.out_of_range} | {sep} |"
            )
    return "\n".join(lines) + "\n"


def write_report(bundle: Path) -> tuple[Report, Path, Path]:
    rep = build_report(bundle)
    md = bundle / "report.md"
    js = bundle / "report.json"
    md.write_text(to_markdown(rep), encoding="utf-8", newline="\n")
    js.write_text(
        json.dumps(asdict(rep), indent=2, default=str) + "\n", encoding="utf-8", newline="\n"
    )
    return rep, md, js
