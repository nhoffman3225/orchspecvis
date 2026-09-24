# orchspec — agent guide

Score-aware orchestral spectral visualizer. Python analysis core writes a versioned
**session bundle**; a three.js viewer reads it. The bundle is the only contract between
them. See PLAN.md for phases, decisions, and open assumptions; SECURITY.md for the
local-only threat model; `docs/bundle-format.md` for the exact on-disk format.

## Commands

Python (always through uv; never pip, never bare `python`):

```
uv sync --locked --extra dev            # CPU / macOS
uv sync --locked --extra dev --extra gpu   # Windows/Linux with CUDA torch (cu130 index)
uv run pytest -m "not gpu and not slow"    # default test run (what CI runs)
uv run pytest -m gpu                       # CUDA tests (5070 Ti)
uv run pytest -m slow -s                   # perf smoke, prints timings
uv run ruff check . && uv run ruff format --check .
uv run pyright
uv run python tests/fixtures/make_synthetic.py   # regenerate synthetic WAV fixtures
uv run orchspec bundle <input.wav | session_dir> -o out/<name>.bundle [--k 3] [--backend librosa|torch]
uv run orchspec serve out/<name>.bundle          # 127.0.0.1, random port, prints tokenized URL
uv run orchspec session-template <session_dir>   # print a render.yaml template
uv run python -c "import torch; print(torch.cuda.get_device_name(0), torch.version.cuda)"
```

Viewer (`viewer/`, npm with committed package-lock.json):

```
npm ci
npm run dev        # Vite dev server; loads viewer/public/sample.bundle by default
npm run build      # -> viewer/dist (served by `orchspec serve`)
npm run lint       # eslint + tsc --noEmit
npm test           # vitest (includes schema cross-check + no-network check)
```

On this Windows box Node comes from Scoop `nodejs-lts`, which is added to PATH by the
installer rather than shimmed; new shells pick it up.

## Layout

```
src/orchspec/
  cli.py            typer app: bundle, serve, session-template
  io/               audio + session folder loading (session.py, audio.py)
  dsp/              cqt.py (CQTSpec + backends), tiles.py, features.py
  bundle/           schema.py (pydantic manifest v1), writer.py, reader.py
  score/            (Phase 2) MusicXML parsing
  timeline/         (Phase 2) tempo map, alignment
  server.py         read-only FastAPI for `orchspec serve`
viewer/             Vite + TS + three.js (WebGL2 only)
data/instruments/   ranges.yaml (schema documented in-file)
tests/              pytest; fixtures/make_synthetic.py; fixtures/real/ is git-ignored
docs/               bundle-format.md (language-neutral spec, Rust must match)
rust/, desktop/     Phase 3b placeholders (README only)
session/            git-ignored real session folders
```

## Invariants (never violate)

- Frequency axis is ALWAYS expressed as MIDI pitch: bin b <-> midi 21 + b/k
  (k = bins_per_octave / 12; fmin = A0 = MIDI 21).
- All times inside the bundle are audio seconds from sample 0; offsets (preroll etc.)
  live in the manifest.
- Never collapse part/staff/voice when later phases add score events.
- Every new analysis function gets a synthetic-signal test before real-audio use.
- Runtime code never opens an outbound network connection; the only listener is 127.0.0.1.
- Mix and stems always share one time base and one frequency axis inside a bundle.
- The bundle is the only contract between analysis and viewers; any format change bumps
  `schema_version` and updates docs/bundle-format.md, schema.py, and viewer/src/bundle.ts
  together, with the cross-language test (tests/test_bundle_schema.py + vitest) passing.

## Security rules (see SECURITY.md)

- Loaders accept filesystem paths only, never URLs. No librosa.example(), torch.hub,
  or anything that downloads.
- XML via defusedxml / lxml(resolve_entities=False, no_network=True). np.load(allow_pickle=False).
  No pickle/torch.load of inputs. subprocess: shell=False + timeout.
- Viewer: no CDNs/fonts/analytics; everything bundled by Vite; CSP in index.html.
- Never commit audio, session/, bundles, or secrets. Before every push run
  `git status` and `git diff --cached --stat` and abort if any would be included.

## Code style

- Python >=3.12, full type hints, pyright basic-strict clean, ruff (line length 100).
- pathlib only; no os.path string juggling; no shell-specific scripts (use Python or npm
  scripts) so Windows and macOS both work. No case-only filename differences.
- numpy arrays: document shape as `(n_bins, n_frames)` etc. in docstrings.
- dataclasses for internal specs, pydantic only at I/O boundaries (manifest, render.yaml).
- Tests: synthetic, deterministic (seeded). GPU tests `@pytest.mark.gpu`, long ones
  `@pytest.mark.slow`.
- Conventional commits (feat:/fix:/test:/docs:/chore:), small, tests passing. Branch per phase.
- Ask before adding a dependency not listed in PLAN.md "Dependencies".

## How to add a CQT backend

1. Implement `class MyBackend` in `src/orchspec/dsp/cqt.py` (or a sibling module) that
   satisfies the `CQTBackend` protocol: `name: str` and
   `magnitude(y: np.ndarray, spec: CQTSpec) -> np.ndarray` returning float32 magnitude of
   shape `(spec.n_bins, n_frames)` with `n_frames == 1 + len(y) // spec.hop`
   (centered frames; frame t is centered on sample t*hop).
2. Register it in `BACKENDS` / `get_backend()`; import heavy deps lazily inside the backend
   so the core imports without them.
3. Add it to the parametrization of `tests/test_cqt_axes.py` and
   `tests/test_click_alignment.py`, and add a comparison against librosa like
   `tests/test_torch_vs_librosa.py` (median |dB diff| < 0.5 on the fixtures).
   Skip cleanly when the backend's dependency or device is absent.
4. Document it in PLAN.md (decision log) and here.
