"""Packs a portable desktop build: the app next to its analysis runtime, in one .7z.

For builds too large for an installer: NSIS stops at 2 GB, and the CUDA torch runtime is
~3.5 GB installed. Unpacked anywhere, `orchspec-desktop.exe` finds `python/` beside it (the
app's resource folder when not installed). Windows 11 opens .7z natively.

    npm --prefix desktop run dist:gpu        # runtime --gpu, viewer, app, then this

Needs 7-Zip (`7z`) on PATH. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 2 * 2**30 - 1  # one GitHub release file

README = """orchspec {version} ({variant}), portable

Run orchspec-desktop.exe. Keep the python folder next to it: it is the analysis runtime
used by File > Import Session. Nothing is installed; delete the folder to remove it.
Imported bundles go to Documents\\orchspec\\bundles.

The GPU build needs an NVIDIA driver supporting CUDA 13; without one the analysis runs on
the CPU. Source, licence and credits: LICENSE.txt, CREDITS.md, and python\\RUNTIME.txt for
the bundled Python packages.
"""


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--variant", default="gpu-cuda")
    ap.add_argument("--version", default="dev")
    ap.add_argument("--out", type=Path, default=ROOT / "dist")
    a = ap.parse_args()

    exe = ROOT / "target" / "release" / "orchspec-desktop.exe"
    runtime = ROOT / "desktop" / "runtime" / "python"
    for need in (exe, runtime / "python.exe"):
        if not need.is_file():
            sys.exit(f"missing {need}: build the runtime and the app first")

    name = f"orchspec-{a.version}-Windows-{a.variant}"
    stage = a.out / name
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    shutil.copy2(exe, stage / exe.name)
    shutil.copytree(runtime, stage / "python")
    shutil.copy2(ROOT / "LICENSE", stage / "LICENSE.txt")
    shutil.copy2(ROOT / "CREDITS.md", stage / "CREDITS.md")
    (stage / "README.txt").write_text(
        README.format(version=a.version, variant=a.variant), encoding="utf-8"
    )

    archive = a.out / f"{name}.7z"
    archive.unlink(missing_ok=True)
    subprocess.run(  # noqa: S603
        ["7z", "a", "-t7z", "-mx=5", "-mmt=on", "-bso0", str(archive), name],  # noqa: S607
        cwd=a.out,
        check=True,
    )
    shutil.rmtree(stage)
    size = archive.stat().st_size
    print(f"{archive} ({size / 1e9:.2f} GB) sha256 {sha256(archive)}")
    if size > MAX_BYTES:
        sys.exit(f"{archive.name} is over 2 GiB: too large for one GitHub release file")


if __name__ == "__main__":
    main()
