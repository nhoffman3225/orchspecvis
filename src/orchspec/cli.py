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


def main() -> None:
    app()


if __name__ == "__main__":
    main()
