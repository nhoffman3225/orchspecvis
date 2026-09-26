# orchspecvis — Orchestral Spectrum Visualizer

**See how an orchestral render fills the pitch spectrum, next to the score that made it.**

orchspecvis (`orchspec` for short: the name of its command line and packages) analyses a
render session (the mix, one audio file per player, the tempo MIDI and the MusicXML score)
into a bundle. A viewer then plays it back:

- a **3D spectrogram** (time × pitch × loudness), with each stem selectable and the
  score's notes outlined;
- the **engraved score** or your **score PDF**, following playback;
- a **tutti reduction** for proofreading: condense a selection into one chord and its
  pitch-class set;
- **register distribution** by section, a **piano** view and keyboard heat.

It runs entirely on your machine, with **no network access at run time**
([SECURITY.md](SECURITY.md)).

## Get it

- **Desktop app**: installers for Windows and macOS (Apple silicon) are on the
  [Releases](https://github.com/nhoffman3225/orchspecvis/releases) page. Import a session
  with *File › Import Session…*; no Python install is needed.
- **From source**: the command line, the browser viewer, or your own desktop build,
  including the NVIDIA GPU edition. See [docs/development.md](docs/development.md).

```
uv sync --locked --extra dev
uv run orchspec bundle path/to/session -o out/
npm --prefix viewer ci && npm --prefix viewer run build
uv run orchspec serve "out/<name>.bundle"    # prints a tokenized http://127.0.0.1:<port>/
```

## Documentation

| | |
|---|---|
| [User guide](docs/user-guide.md) | Sessions, importing, every view and control, keys, troubleshooting |
| [Dorico sessions](docs/dorico-session.md) | Exporting stems, MIDI, MusicXML and the score PDF from Dorico |
| [Architecture](docs/architecture.md) | Code overview with diagrams: how the Python analysis, the bundle, the viewer and the desktop app fit together |
| [Development](docs/development.md) | Setup, checks, desktop builds, releases |
| [Bundle format](docs/bundle-format.md) | The versioned bundle specification |
| [Desktop app](desktop/README.md) | The Tauri shell, the bundled runtime, build variants |
| [Security](SECURITY.md) | Local-only guarantees, untrusted inputs, supply chain |
| [PLAN.md](PLAN.md) | Roadmap and decisions |

## Licence and credits

orchspec is released under the [MIT licence](LICENSE). It is built on a lot of generous
open-source work; see [CREDITS.md](CREDITS.md). The credits are also shown in the viewer
under **ⓘ credits**, together with the full licence texts of everything the viewer ships.
The score view bundles [Verovio](https://www.verovio.org) (LGPL-3.0-or-later) unmodified,
as a separate, replaceable file.

## Note

This is a personal project created to experiment with Agentic Coding. Feel free to use or fork
it with that in mind.
