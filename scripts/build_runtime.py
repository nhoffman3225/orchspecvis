"""Builds the self-contained analysis runtime that ships inside the desktop app.

A copy of uv's standalone CPython (python-build-standalone, relocatable) with orchspec
and its locked runtime dependencies installed into it, hash-checked, so the installed
app can import sessions without a Python install. The desktop app runs
`<resources>/python/python -P -m orchspec.cli bundle ...` (session_import::find_cli).

    uv run python scripts/build_runtime.py            # -> desktop/runtime/python
    uv run python scripts/build_runtime.py --gpu      # + torch (the `gpu` extra)
    uv run python scripts/build_runtime.py --check    # also run the CLI on a test session

Without `--gpu` the analysis uses the numpy / librosa backend (`--backend auto` falls
back to it). With `--gpu` it adds the locked torch: CUDA 13 on Windows/Linux (~2.9 GB
installed; needs an NVIDIA driver, falls back to CPU torch otherwise), Apple-silicon MPS
on macOS (small, so the default there). Standard library only.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "desktop" / "runtime" / "python"
WIN = sys.platform == "win32"

# Not needed at run time: test suites, GUI toolkits, headers, docs. (site-packages test
# folders are the bulk: scipy, numpy, sklearn.)
SKIP_STDLIB = {"test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "venv"}
SKIP_TOP = {"include", "tcl", "Tools", "share", "Doc"}
# only `tests` folders: `testing` / `test` modules are imported at run time by some
# packages (torch.testing by torch.autograd, numpy.testing by scipy)
SKIP_PKG_DIRS = {"tests", "__pycache__"}
# every runtime import the analysis relies on; checked after the build
IMPORTS = [
    "numpy",
    "scipy.signal",
    "librosa",
    "soundfile",
    "sklearn",
    "numba",
    "pypdfium2",
    "pydantic",
    "typer",
    "defusedxml",
    "yaml",
    "orchspec.cli",
    "orchspec.bundle.writer",
]


def run(*args: str | Path, **kw: object) -> str:
    print("+", " ".join(str(a) for a in args), flush=True)
    r = subprocess.run([str(a) for a in args], text=True, capture_output=True, **kw)  # type: ignore[call-overload]  # noqa: S603
    if r.returncode:
        sys.exit(f"failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return str(r.stdout)


def python_of(root: Path) -> Path:
    return root / "python.exe" if WIN else root / "bin" / "python3"


def base_python(version: str) -> Path:
    run("uv", "python", "install", version)
    # --no-project and no VIRTUAL_ENV: the standalone interpreter itself, not a venv
    env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
    exe = Path(
        run(
            "uv", "python", "find", version, "--managed-python", "--no-project", "--system", env=env
        ).strip()
    )
    if (exe.parent.parent / "pyvenv.cfg").exists() or (exe.parent / "pyvenv.cfg").exists():
        sys.exit(f"expected a standalone interpreter, got a venv: {exe}")
    # Windows: <root>/python.exe; Unix: <root>/bin/python3.x
    return exe.parent if WIN else exe.parent.parent


def copy_base(src: Path, dst: Path) -> None:
    def skipped(here: Path, n: str) -> bool:
        stdlib = here.name == "Lib" or here.name.startswith("python3")
        return (
            (here == src and n in SKIP_TOP)
            or (stdlib and (n in SKIP_STDLIB or n == "site-packages"))
            or n in ("__pycache__", "EXTERNALLY-MANAGED")
        )

    shutil.copytree(
        src, dst, symlinks=True, ignore=lambda d, names: {n for n in names if skipped(Path(d), n)}
    )
    site_packages(dst).mkdir(parents=True, exist_ok=True)


def site_packages(root: Path) -> Path:
    if WIN:
        return root / "Lib" / "site-packages"
    lib = next((root / "lib").glob("python3.*"))
    return lib / "site-packages"


def prune(sp: Path) -> int:
    removed = 0
    for d in sorted(sp.rglob("*"), key=lambda p: -len(p.parts)):
        if not d.is_dir() or d.name not in SKIP_PKG_DIRS:
            continue
        shutil.rmtree(d, ignore_errors=True)
        removed += 1
    return removed


def size_mb(p: Path) -> float:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6


def main() -> None:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--python", default=(ROOT / ".python-version").read_text().strip())
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--check", action="store_true", help="bundle a synthetic session with it")
    gpu = ap.add_mutually_exclusive_group()
    mac = sys.platform == "darwin"
    gpu.add_argument("--gpu", action="store_true", default=mac, help="include torch")
    gpu.add_argument("--no-gpu", dest="gpu", action="store_false")
    a = ap.parse_args()

    out: Path = a.out
    shutil.rmtree(out, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    copy_base(base_python(a.python), out)
    py = python_of(out)

    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        # the locked runtime dependencies as PEP 751 pylock.toml: exact wheel URLs (torch
        # too, from the PyTorch CUDA index) with hashes, checked on install
        extra = ["--extra", "gpu"] if a.gpu else []
        export = ["export", "--frozen", "--no-dev", *extra, "--no-emit-project"]
        run("uv", *export, "--format", "pylock.toml", "-o", t / "pylock.toml", cwd=ROOT)
        install = ["pip", "install", "--python", py, "--link-mode", "copy"]
        run("uv", *install, "-r", t / "pylock.toml")
        run("uv", "build", "--wheel", "--out-dir", t, cwd=ROOT)
        run("uv", *install, "--no-deps", next(t.glob("orchspec-*.whl")))

    n = prune(site_packages(out))
    # console-script launchers embed the build machine's path; the app uses `-m`
    scripts = out / "Scripts" if WIN else None
    if scripts and scripts.is_dir():
        shutil.rmtree(scripts)
    # precompile: the installed app's folder is read-only, so bytecode cannot be cached
    # there at run time and every import would recompile
    run(py, "-m", "compileall", "-q", "-j", "0", out)
    (out / "RUNTIME.txt").write_text(
        "orchspec analysis runtime: python-build-standalone CPython "
        f"{run(py, '-c', 'import sys; print(sys.version)').strip()}\n\n"
        + run("uv", "pip", "freeze", "--python", py),
        encoding="utf-8",
    )
    print(f"runtime: {out} ({size_mb(out):.0f} MB, {n} test folders pruned)")

    mods = IMPORTS + (["torch"] if a.gpu else [])
    run(py, "-P", "-c", f"import {', '.join(mods)}")
    run(py, "-P", "-m", "orchspec.cli", "--help")
    if a.check:
        check(py)


def check(py: Path) -> None:
    """Bundles the synthetic test session with the runtime (`--backend auto`)."""
    sys.path.insert(0, str(ROOT))
    from tests.fixtures import make_score_session as fx

    with tempfile.TemporaryDirectory() as tmp:
        sess = fx.make(Path(tmp) / "session")
        env = {**os.environ, "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8"}
        cmd = ["-P", "-m", "orchspec.cli", "bundle", sess, "-o", Path(tmp) / "out"]
        print(run(py, *cmd, "--backend", "auto", env=env))


if __name__ == "__main__":
    main()
