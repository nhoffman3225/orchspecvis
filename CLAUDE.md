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
uv run orchspec session-template [session_dir]   # print (or write) a render.yaml template
uv run orchspec validate <session_dir | file.wav>
uv run orchspec import-dorico "session/<name>" [--dry-run]   # Dorico export -> session layout
uv run orchspec report out/<name>.bundle     # assumption checks -> report.md/.json
uv run pytest -m real -s                     # LOCAL ONLY: bundle+report every session/ folder
uv run python tests/fixtures/make_demo_session.py  # 30 s, 4-stem demo in session/demo
uv run python -m tests.fixtures.make_score_session  # score+MIDI+stems demo in session/score-demo
uv run orchspec bundle <session> -o out/ [--offset S] [--no-align] [--f0 auto|yin|pyin|off]
ORCHSPEC_PERF_MINUTES=2 ORCHSPEC_PERF_STEMS=4 uv run pytest -m slow -s   # quick perf smoke
uv run python -c "import torch; print(torch.cuda.get_device_name(0), torch.version.cuda)"
```

Viewer (`viewer/`, npm with committed package-lock.json):

```
npm ci
npm run dev        # Vite dev server on 127.0.0.1 (tiny-bundle by default)
npm run build      # -> viewer/dist (served by `orchspec serve`)
npm run lint       # eslint + tsc --noEmit
npm test           # vitest (includes schema cross-check + no-network check)
npm run e2e        # Playwright (needs viewer/test-data from `uv run pytest`); PW_CHANNEL=msedge locally
E2E_URL="<orchspec serve URL>" PW_CHANNEL=msedge npx playwright test real   # LOCAL real session
```

`npm run dev` shows viewer/public/tiny-bundle; add `?bundle=/path/` for another bundle
served by Vite, or use `orchspec serve` for a real one. `?mode=mix|stems|dominant` sets the
initial view; also `style=surface|terrain|fabric`, `smooth=<semitones>`, `gaps=<dB>`
(e.g. `&mode=ensemble&style=terrain&smooth=4&gaps=-45`); with a score also `notes=0`,
`fund=1`, `fundw=25|50|100` (fundamentals-only band in cents), `harm=<dB>` (overtones
that loud pass too), `heat=off|sound|notes`, `tau=<s>`, `t=<s>` (start position),
`view=piano|score|registers`, `regsrc=notes`, `regby=each`, `lookahead=<s>`, `keyh=<x>`, `pitch=<lo>-<hi>` (2D pane MIDI range),
`window=<s>` (one of the window choices). Keys: P piano, S score, Space, arrows, Esc. The cross-language test reads viewer/test-data/py-bundle, written by
`uv run pytest tests/test_bundle_writer.py` (git-ignored) — run pytest before vitest.

On this Windows box Node comes from Scoop `nodejs-lts`, which is added to PATH by the
installer rather than shimmed; new shells pick it up.

## Layout

```
src/orchspec/
  cli.py            typer app: bundle, serve, validate, session-template
  io/               audio + session folder loading (session.py, audio.py)
  dsp/              cqt.py (CQTSpec + backends), tiles.py, features.py
  bundle/           schema.py (pydantic manifest, v4)
  score/            musicxml.py (safe parser), repeats.py, match.py (part<->stem), ranges.py
  timeline/         midi.py (bounded SMF reader), align.py (tempo maps, pitch-aware warp,
                    per-stem onset snapping, detector self-calibration)
  io/dorico.py      Dorico export importer; report.py: `orchspec report`
  dsp/fundamentals.py  per-note fundamental level/weak flag, yin/pyin f0 tracks
  bundle/score_stage.py  score/MIDI -> audio-timed notes table for the bundle
  server.py         read-only FastAPI for `orchspec serve`
  bundle/writer.py  session -> bundle (atomic temp-dir + rename)
viewer/             Vite + TS + three.js (WebGL2 only)
  src/bundle.ts     strict manifest parser (mirror of schema.py)
  src/net.ts        the only network I/O (same-origin guard)
  src/tiles.ts      tile LRU cache, page assembly, stem power-sum
  src/surface.ts    heightmap shader surface; src/pane2d.ts 2D pane + LUFS strip
  src/notes.ts      note index, note/f0 rasterization (overlay + fundamentals mask), bar/beat
  src/scoreview.ts  engraved score view; Verovio runs in src/verovio.worker.ts (verovioCore.ts)
  src/scoremap.ts   measure sync (score <-> audio), sounding tracker, SVG sanitizer
  e2e/              Playwright specs (guard.ts fails tests on off-origin requests)
  src/piano.ts      full-screen piano view (keyboard, live spectrum, falling-notes roll)
  src/presets.ts    harmonics-slider preset stops
  src/heat.ts       keyboard heat map (decayed per-key activity from sound or notes)
  src/gaps.ts       energy-domain smoothing, sounding spans, spectral-gap detection
  src/clock.ts      Transport (AudioContext master clock); src/player.ts Web Audio
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
3. Add it to `BACKEND_PARAMS` in `tests/conftest.py` (drives `tests/test_cqt_axes.py` and
   `tests/test_click_alignment.py`), and add a comparison against librosa like
   `tests/test_torch_vs_librosa.py` (median |dB diff| < 0.5 on the fixtures).
   Skip cleanly when the backend's dependency or device is absent.
4. Document it in PLAN.md (decision log) and here.
