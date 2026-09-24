"""orchspec command line."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from orchspec.io.session import RENDER_YAML_TEMPLATE, SessionError, load_input

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    help="Score-aware orchestral spectral visualizer (local-only).",
)


@app.command("session-template")
def session_template(
    session_dir: Annotated[Path | None, typer.Argument(help="write render.yaml here")] = None,
    force: bool = typer.Option(False, help="overwrite an existing render.yaml"),
) -> None:
    """Print a render.yaml template, or write it into SESSION_DIR."""
    if session_dir is None:
        typer.echo(RENDER_YAML_TEMPLATE, nl=False)
        return
    target = session_dir / "render.yaml"
    if target.exists() and not force:
        raise typer.BadParameter(f"{target} exists (use --force to overwrite)")
    target.write_text(RENDER_YAML_TEMPLATE, encoding="utf-8")
    typer.echo(f"wrote {target}")


@app.command()
def validate(path: Path) -> None:
    """Validate a session folder (or a single audio file) and print a summary."""
    try:
        s = load_input(path)
    except SessionError as e:
        typer.echo(f"error: {e}", err=True)
        raise typer.Exit(2) from e
    typer.echo(
        f"session {s.name}: mix {s.mix.sr} Hz, {s.mix.channels} ch, "
        f"{s.mix.duration:.2f} s, {len(s.stems)} stems, renderer={s.config.renderer}"
    )
    for st in s.stems:
        typer.echo(f"  [{st.number:02d}] {st.player} ({st.info.channels} ch)")


@app.command()
def bundle(
    input_path: Annotated[Path, typer.Argument(help="session folder or audio file")],
    out: Annotated[Path, typer.Option("-o", "--out", help="output dir or x.bundle path")],
    k: Annotated[int, typer.Option(help="bins per semitone (1 or 3)")] = 3,
    hop: Annotated[int, typer.Option(help="CQT hop in samples")] = 512,
    backend: Annotated[str, typer.Option(help="librosa | torch")] = "librosa",
    device: Annotated[str | None, typer.Option(help="torch device (cuda, mps, cpu)")] = None,
    db_min: float = -96.0,
    db_max: float = 6.0,
    tile_frames: int = 1024,
    overwrite: Annotated[bool, typer.Option(help="replace an existing bundle")] = False,
    offset: Annotated[
        float | None,
        typer.Option(help="score/MIDI -> audio offset in seconds (skips automatic alignment)"),
    ] = None,
    align: Annotated[
        bool, typer.Option(help="estimate the offset from note onsets around preroll_sec")
    ] = True,
    f0: Annotated[
        str,
        typer.Option(help="per-stem f0 tracks: auto (only without score/MIDI) | yin | pyin | off"),
    ] = "auto",
) -> None:
    """Analyse a session (mix + stems, optional score.musicxml / render.mid) or a WAV."""
    from orchspec.bundle.writer import (
        BundleOptions,
        build_bundle,
        inputs_from_session,
        resolve_output,
    )

    try:
        s = load_input(input_path)
    except SessionError as e:
        typer.echo(f"error: {e}", err=True)
        raise typer.Exit(2) from e
    target = resolve_output(out, s.name)
    opts = BundleOptions(
        k=k,
        hop=hop,
        backend=backend,
        device=device,
        db_min=db_min,
        db_max=db_max,
        tile_frames=tile_frames,
        offset=offset,
        align=align,
        f0=f0,
    )
    try:
        rep = build_bundle(
            inputs_from_session(s), target, opts, overwrite=overwrite, log=typer.echo
        )
    except (FileExistsError, ValueError, RuntimeError) as e:  # incl. score/MIDI errors
        typer.echo(f"error: {e}", err=True)
        raise typer.Exit(2) from e
    times = ", ".join(f"{key} {v:.1f}s" for key, v in rep.seconds.items())
    typer.echo(
        f"wrote {rep.path} ({rep.manifest.n_frames} frames x {rep.manifest.n_bins} "
        f"bins, {len(rep.manifest.stems)} stems; {times})"
    )


@app.command()
def serve(
    bundle_dir: Annotated[Path, typer.Argument(help="a .bundle directory")],
    viewer_dist: Annotated[Path | None, typer.Option(help="built viewer (viewer/dist)")] = None,
) -> None:
    """Serve a bundle + the built viewer on 127.0.0.1 (random port, tokenized URL)."""
    from orchspec.server import REPO_VIEWER_DIST
    from orchspec.server import serve as run

    target = bundle_dir.expanduser().resolve()
    if not (target / "manifest.json").is_file():
        hint = ""
        if not target.exists():
            hint = f"\n  (resolved relative to the current directory: {Path.cwd()})"
        typer.echo(f"error: {target} is not a bundle directory (no manifest.json){hint}", err=True)
        raise typer.Exit(2)
    dist = viewer_dist or REPO_VIEWER_DIST
    if not (dist / "index.html").is_file():
        typer.echo(
            f"warning: no built viewer at {dist}; run `npm --prefix viewer run build`", err=True
        )
    run(target, viewer_dist)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
