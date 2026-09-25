"""Regenerate CREDITS.md and the viewer's third-party licence file from installed metadata.

    uv run python scripts/credits.py

Reads (no network): Python distribution metadata in the project venv, package.json and
licence files under viewer/node_modules and desktop/node_modules, and `cargo metadata`
(already-resolved Cargo.lock; falls back gracefully when cargo is absent). Writes:

- CREDITS.md                                  human-readable credits, all layers
- viewer/public/licenses/THIRD-PARTY.txt      full licence texts of what the viewer build
                                              ships (served same-origin, shown in-app)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tomllib
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LICENSE_FILES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.LESSER", "LICENCE")

# What each direct dependency does here (credits should say why we are grateful).
ROLE = {
    "librosa": "constant-Q transform, audio analysis",
    "soundfile": "reading WAV/FLAC (libsndfile)",
    "numpy": "arrays behind every analysis step",
    "pyloudnorm": "EBU R128 / ITU-R BS.1770 loudness",
    "pydantic": "bundle manifest schema and validation",
    "typer": "command-line interface",
    "fastapi": "local read-only dev server",
    "uvicorn": "ASGI server for `orchspec serve`",
    "pyyaml": "instrument range data",
    "defusedxml": "safe MusicXML parsing",
    "torch": "GPU constant-Q transform (optional)",
    "ruff": "linting and formatting",
    "pyright": "static type checking",
    "pytest": "tests",
    "pytest-socket": "proving tests never touch the network",
    "hypothesis": "property-based tests",
    "httpx": "HTTP test client",
    "three": "WebGL rendering of the spectral surface",
    "verovio": "music engraving of the score view",
    "vite": "viewer build and dev server",
    "typescript": "viewer language",
    "vitest": "viewer unit tests",
    "eslint": "viewer linting",
    "typescript-eslint": "TypeScript lint rules",
    "@eslint/js": "ESLint core rules",
    "@playwright/test": "end-to-end browser tests",
    "@types/node": "Node type definitions",
    "@types/three": "three.js type definitions",
    "@tauri-apps/cli": "desktop app build tooling",
    "tauri": "desktop app shell",
    "tauri-build": "desktop app build script",
    "tauri-plugin-dialog": "native folder picker",
    "serde": "(de)serialization in Rust",
    "serde_json": "JSON in Rust",
    "flate2": "gzip tiles in Rust",
}


def _pkg_name(req: str) -> str:
    return re.split(r"[ <>=!~;\[]", req, maxsplit=1)[0].strip()


def py_license(name: str) -> tuple[str, str, str]:
    try:
        d = distribution(name)
    except PackageNotFoundError:
        return "", "(not installed)", ""
    m = d.metadata
    lic = m.get("License-Expression") or ""
    if not lic:
        classifiers = [
            c.split("::")[-1].strip()
            for c in m.get_all("Classifier") or []
            if c.startswith("License ::")
        ]
        raw = (m.get("License") or "").strip()
        lic = (
            classifiers[0] if classifiers else (raw.splitlines()[0][:60] if raw else "see project")
        )
    url = m.get("Home-page") or ""
    for u in m.get_all("Project-URL") or []:
        label, _, link = u.partition(",")
        if not url or label.strip().lower() in ("homepage", "source", "repository"):
            url = link.strip()
            if label.strip().lower() in ("homepage", "source", "repository"):
                break
    return d.version, lic, url


def python_section() -> list[str]:
    proj = tomllib.loads((REPO / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    groups = {"runtime": proj["dependencies"], **proj.get("optional-dependencies", {})}
    out = [
        "## Python (analysis core)",
        "",
        "| package | version | licence | used for |",
        "| --- | --- | --- | --- |",
    ]
    for group, reqs in groups.items():
        for r in reqs:
            n = _pkg_name(r)
            ver, lic, url = py_license(n)
            label = f"[{n}]({url})" if url else n
            extra = "" if group == "runtime" else f" ({group})"
            out.append(f"| {label} | {ver} | {lic} | {ROLE.get(n, '')}{extra} |")
    out += [
        "",
        "Through librosa and soundfile the analysis also relies on SciPy, scikit-learn, numba,",
        "soxr (LGPL-2.1+) and libsndfile (LGPL-2.1+, bundled in the soundfile wheel). These are",
        "installed as separate packages from PyPI and not redistributed by orchspec.",
        "",
    ]
    return out


def npm_pkg(root: Path, name: str) -> dict:
    p = root / "node_modules" / name / "package.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def npm_url(pkg: dict) -> str:
    url = pkg.get("homepage") or ""
    repo = pkg.get("repository")
    if not url and isinstance(repo, dict):
        url = repo.get("url", "")
    elif not url and isinstance(repo, str):
        url = repo
    return re.sub(r"^git\+|\.git$", "", url)


def npm_section(root: Path, title: str) -> list[str]:
    pj = json.loads((root / "package.json").read_text(encoding="utf-8"))
    out = [
        f"## {title}",
        "",
        "| package | version | licence | used for |",
        "| --- | --- | --- | --- |",
    ]
    for group in ("dependencies", "devDependencies"):
        for n in sorted(pj.get(group, {})):
            pkg = npm_pkg(root, n)
            url = npm_url(pkg)
            label = f"[{n}]({url})" if url else n
            tag = " (shipped in the app)" if group == "dependencies" else ""
            out.append(
                f"| {label} | {pkg.get('version', '')} | {pkg.get('license', '')} "
                f"| {ROLE.get(n, '')}{tag} |"
            )
    out.append("")
    return out


def cargo_section() -> list[str]:
    cargo = shutil.which("cargo")
    if not cargo:
        return ["## Rust (desktop app)", "", "_cargo not found; section not regenerated._", ""]
    meta = json.loads(
        subprocess.run(  # noqa: S603 - fixed argv, cargo from PATH, no shell
            [cargo, "metadata", "--format-version", "1", "--locked"],
            cwd=REPO,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
            timeout=120,
        ).stdout
    )
    ours = {p["id"] for p in meta["packages"] if p["source"] is None}
    direct: dict[str, dict] = {}
    for p in meta["packages"]:
        if p["id"] in ours:
            for d in p["dependencies"]:
                direct.setdefault(d["name"], {})
    pkgs = [p for p in meta["packages"] if p["source"] is not None]
    by_lic: dict[str, int] = {}
    for p in pkgs:
        by_lic[p.get("license") or "unspecified"] = (
            by_lic.get(p.get("license") or "unspecified", 0) + 1
        )
    out = [
        "## Rust (desktop app and bundle core)",
        "",
        "| crate | version | licence | used for |",
        "| --- | --- | --- | --- |",
    ]
    seen = set()
    for p in sorted(pkgs, key=lambda p: p["name"]):
        if p["name"] in direct and p["name"] not in seen:
            seen.add(p["name"])
            url = p.get("repository") or p.get("homepage") or ""
            label = f"[{p['name']}]({url})" if url else p["name"]
            out.append(
                f"| {label} | {p['version']} | {p.get('license', '')} | {ROLE.get(p['name'], '')} |"
            )
    out += [
        "",
        f"All {len(pkgs)} crates in Cargo.lock by licence "
        "(all platforms; each build uses a subset):",
        "",
    ]
    out += [f"- {lic}: {n}" for lic, n in sorted(by_lic.items(), key=lambda kv: -kv[1])]
    out.append("")
    return out


def shipped_licence_text() -> str:
    """Full texts for what viewer/dist ships: three.js and Verovio (+ the LGPL/GPL texts)."""
    v = REPO / "viewer"
    parts = [
        "orchspec viewer: licences of orchspec and of the software it ships",
        "=" * 66,
        "",
        "",
        (REPO / "LICENSE")
        .read_text(encoding="utf-8")
        .strip()
        .replace("MIT License", "orchspec — MIT License", 1),
        "",
    ]
    for name in ("three", "verovio"):
        pkg = npm_pkg(v, name)
        parts += [
            "-" * 72,
            f"{name} {pkg.get('version', '')} — {pkg.get('license', '')} — {npm_url(pkg)}",
            "-" * 72,
            "",
        ]
        found = [f for f in LICENSE_FILES if (v / "node_modules" / name / f).exists()]
        for f in found:
            parts += [(v / "node_modules" / name / f).read_text(encoding="utf-8").strip(), ""]
        if name == "verovio":
            parts += [
                "Verovio is used unmodified as a separate, replaceable file (the",
                "verovio.worker-*.js chunk in the build, loaded on demand), which is how the",
                "LGPL-3.0 terms are met: you may replace it with a modified Verovio build.",
                "Source: https://github.com/rism-digital/verovio",
                "",
            ]
            for f in ("LGPL-3.0.txt", "GPL-3.0.txt"):
                t = REPO / "docs" / "licenses" / f
                if t.exists():
                    parts += [t.read_text(encoding="utf-8").strip(), ""]
                else:
                    print(f"warning: docs/licenses/{f} missing", file=sys.stderr)
    return "\n".join(parts) + "\n"


def main() -> None:
    lines = [
        "# Credits",
        "",
        "orchspec stands on a lot of generous open-source work. Thank you to everyone who builds",
        "and maintains the projects below. orchspec itself is released under the MIT licence",
        "(see [LICENSE](LICENSE)).",
        "",
        "_Generated by `uv run python scripts/credits.py` from installed package metadata; the",
        "licence column is what each project declares._",
        "",
    ]
    lines += python_section()
    lines += npm_section(REPO / "viewer", "Viewer (TypeScript / WebGL)")
    if (REPO / "desktop" / "node_modules").exists():
        lines += npm_section(REPO / "desktop", "Desktop tooling")
    lines += cargo_section()
    lines += [
        "## Data and references",
        "",
        "- Instrument ranges in `data/instruments/ranges.yaml` are compiled from standard",
        "  orchestration references (S. Adler, *The Study of Orchestration*, 4th ed.;",
        "  A. Blatter, *Instrumentation and Orchestration*), cited per entry.",
        "- Loudness follows ITU-R BS.1770 / EBU R128.",
        "- Score exchange uses MusicXML (W3C Music Notation Community Group) and MIDI.",
        "",
    ]
    (REPO / "CREDITS.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")
    out = REPO / "viewer" / "public" / "licenses"
    out.mkdir(parents=True, exist_ok=True)
    (out / "THIRD-PARTY.txt").write_text(shipped_licence_text(), encoding="utf-8", newline="\n")
    print("wrote CREDITS.md and viewer/public/licenses/THIRD-PARTY.txt")


if __name__ == "__main__":
    main()
