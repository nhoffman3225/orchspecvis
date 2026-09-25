# orchspec

Score-aware orchestral spectral visualizer. **Local-only**: no network at runtime
(see [SECURITY.md](SECURITY.md)).

A Python analysis core turns a render session (mix + per-player stems + tempo MIDI +
MusicXML) into a versioned **session bundle** ([docs/bundle-format.md](docs/bundle-format.md));
a three.js viewer shows a 3D CQT surface (time × pitch × dB) with synced playback.

## Quick start

```
uv sync --locked --extra dev            # add --extra gpu on Windows/Linux for CUDA torch
uv run orchspec validate path/to/session
uv run orchspec bundle path/to/session -o out/
npm --prefix viewer ci && npm --prefix viewer run build
uv run orchspec serve out/<name>.bundle   # prints a tokenized http://127.0.0.1:<port>/ URL
```

A session folder contains `mix.wav`, optional `stems/NN_<Player>.wav` (same sample rate and
length as the mix), `render.mid`, `score.musicxml`, and `render.yaml`
(`uv run orchspec session-template` prints one). A single WAV file also works.

See [CLAUDE.md](CLAUDE.md) for commands and invariants and [PLAN.md](PLAN.md) for the roadmap.

## Licence and credits

orchspec is released under the [MIT licence](LICENSE). It is built on a lot of generous
open-source work — see [CREDITS.md](CREDITS.md) (also shown in the viewer under
**ⓘ credits**, together with the full licence texts of everything the viewer ships).
The score view bundles [Verovio](https://www.verovio.org) (LGPL-3.0-or-later) unmodified,
as a separate, replaceable file.
