# Architecture

orchspec has three parts joined by one file format.

```
session folder ──► Python analysis ──► bundle (versioned folder) ──► viewer (TS + three.js)
 mix, stems,        src/orchspec          manifest.json + tiles          in a browser (orchspec serve)
 MIDI, MusicXML,                          + tables + score files         or the desktop app (Tauri + Rust)
 score.pdf
```

- **The bundle** is the contract between the parts ([bundle-format.md](bundle-format.md)).
  It is written once by Python and read by TypeScript and Rust. The schema is defined in
  three places that must change together: `src/orchspec/bundle/schema.py` (normative),
  `viewer/src/bundle.ts` and `rust/orchspec-core/src/manifest.rs`. Tests cross-check
  them.
- **Local-only by construction**: no network at run time, a strict CSP, loaders that take
  paths only, and localhost-only serving with a token. [SECURITY.md](../SECURITY.md) lists
  the guarantees and the tests that enforce them.

## Repository layout

```
src/orchspec/          Python analysis core (package `orchspec`, CLI `orchspec`)
viewer/                TypeScript viewer (Vite, three.js, Verovio in a worker)
rust/orchspec-core/    Rust: manifest, tiles, serving rules, session import helpers
desktop/               Tauri 2 desktop shell (src-tauri/) embedding viewer/dist
scripts/               credits generation, desktop runtime build and packaging
tests/                 pytest suites + fixture generators (synthetic sessions, PDFs)
docs/                  format and user documentation
data/instruments/      instrument ranges (ranges.yaml)
PLAN.md                roadmap, decisions, approved dependencies
CLAUDE.md              commands and invariants for contributors (and coding agents)
```

## Python analysis (`src/orchspec`)

`orchspec bundle` (`cli.py`) runs `bundle/writer.py:build_bundle`:

1. **Load** (`io/session.py`, `io/audio.py`): validate the session and read the audio.
   Stems must match the mix's sample rate and length.
2. **Score stage** (`bundle/score_stage.py`):
   - read MusicXML safely with defusedxml (`score/musicxml.py`) or the MIDI
     (`timeline/midi.py`), and unroll repeats (`score/repeats.py`);
   - match parts to stems by name (`score/match.py`) and add instrument ranges
     (`score/ranges.py`);
   - **align** score time to audio seconds (`timeline/align.py`): MIDI tempo map, then a
     global offset from onset cross-correlation, then a warp over snapped onsets, with
     per-part latency.
3. **Spectra** (`dsp/cqt.py`): a constant-Q transform on a MIDI-aligned axis, k bins per
   semitone from A0. It has two backends: librosa (CPU) and torch (CUDA/MPS/CPU; the
   same axis within tolerance, see `tests/test_torch_vs_librosa.py`).
4. **Tiles** (`dsp/tiles.py`): quantise dB to uint8, build a level-of-detail (LOD)
   pyramid, and write gzip tiles on a thread pool.
5. **Features** (`dsp/features.py`, `dsp/fundamentals.py`): short-term loudness, spectral
   centroid, onset envelopes, and the level at each note's fundamental (or audio-only f0
   tracks when there is no score).
6. **Score extras**:
   - engravable reductions for the tutti view (`score/reduce.py`);
   - the score PDF rendered to page images, with bar boxes found by staff and barline
     detection plus the PDF's text layer (`score/pdf.py`).
   On the CPU backend, worker threads analyse several stems at once (CQT, onset
   envelopes); results are taken in stem order, so the output is identical
   (`test_cpu_workers_build_equals_single_thread`).
7. **Write** the manifest, then move the finished bundle into place. An existing bundle is
   renamed aside first, so a failure never leaves a half-written one.

With torch, the score stage and features run in background threads alongside the stem
loop. The output is byte-identical to the sequential build
(`test_parallel_build_equals_sequential`).

`orchspec report` (`report.py`) turns the alignment's assumptions into PASS/WARN checks.
`orchspec serve` (`server.py`) serves one bundle and the built viewer on 127.0.0.1 with a
random port and token (for development; the desktop app replaces it).

## Viewer (`viewer/src`)

`main.ts` wires the UI. The main pieces:

| Module | Role |
|---|---|
| `bundle.ts` | Parse and validate the manifest (the TS side of the schema). |
| `tiles.ts`, `pagesclient.ts`, `pages.worker.ts` | Fetch and decompress tiles off the main thread, and build the visible time window ("page") with stem sums, smoothing and register folding. |
| `surface.ts`, `colormap.ts` | The 3D surface (three.js, WebGL2). |
| `pane2d.ts`, `notes.ts`, `gaps.ts` | The 2D pane, note outlines, spectral gaps. |
| `player.ts`, `stream.feeder.ts`, `stream.worklet.ts`, `streamqueue.ts`, `clock.ts`, `wav.ts` | Streaming playback. A worker fetches 1 s audio chunks with HTTP range requests and feeds an AudioWorklet over a MessageChannel. The worklet's position is the clock. |
| `scoreview.ts`, `verovio.worker.ts`, `verovioCore.ts`, `scoremap.ts` | The engraved score (Verovio in a worker) and the score↔audio time map. |
| `pdfview.ts` | Following a score PDF (page images and bar boxes). |
| `tuttipanel.ts`, `condense.ts` | The tutti view (the score's engraved chord reductions), selection, condensing and pitch-class sets. |
| `registers.ts`, `registerview.ts` | Register distribution. |
| `piano.ts`, `heat.ts` | Piano view and keyboard heat. |
| `importview.ts` | The desktop import progress screen. |
| `busy.ts` | Spinners next to slow controls. |
| `toolbar.ts`, `splitter.ts`, `hovertip.ts`, `help.ts` | Folding toolbar groups, resizable panels, hover help and the Help view. |
| `net.ts` | The same-origin fetch guard (no network beyond the page's own origin). |

Unit tests are `*.test.ts` (vitest), and `e2e/viewer.spec.ts` runs Playwright against a
real build.

## Rust (`rust/orchspec-core`, `desktop/`)

- `manifest.rs`: the manifest (schema v1–6) with the same rules as `schema.py`.
- `tiles.rs`: tile read/write and the LOD pyramid. It is cross-checked against
  Python-written bundles.
- `serve.rs`: the serving rules as pure functions: path confinement, no hidden files,
  GET/HEAD only, byte ranges, and the security headers.
- `session_import.rs`: import status, parsing the CLI's progress lines, and locating the
  analysis (`find_cli`).

The desktop app (`desktop/src-tauri/src/main.rs`):
- **Serving:** one custom protocol serves the embedded viewer and the opened bundle from
  the same origin, so the viewer's CSP and fetch guard work unchanged.
- **Isolation:** there are no IPC capabilities, and navigation is locked to that origin.
- **Import:** runs the analysis CLI as a subprocess, with no shell. Installed builds use
  the bundled Python runtime; see [development.md](development.md#desktop-builds).

## Tests and CI

| Workflow | Runs |
|---|---|
| `ci.yml` | Ruff, pyright and pytest on Windows (plus macOS on main); viewer lint, unit tests and build; Playwright E2E on Linux; Rust fmt, clippy and tests. |
| `desktop.yml` | Clippy for the desktop shell on Windows (a full build on main). |
| `supply-chain.yml` | pip-audit, npm audit, cargo-deny. |
| `release.yml` | Installers on version tags. |

pytest markers: `gpu` (needs CUDA), `slow` (performance), and `real` (your own sessions
in the git-ignored `session/`).
