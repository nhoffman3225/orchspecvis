# orchspec — plan

Status legend: `[x]` done, `[ ]` open, `[~]` partial. Dates are ISO (YYYY-MM-DD).

## Goal

Input: a session folder per render (Dorico+NotePerformer 5 or Cubase+BBC SO Pro):
`mix.wav`, `stems/NN_<Player>.wav` (dry, same start/length), `render.mid` (tempo track),
`score.musicxml`, `render.yaml`. `mix.wav` alone must also work. Scores: solo .. ~100
staves / 20 min. Output: interactive viewer — 3D CQT surface (time x pitch x dB) with synced
playback; later score overlays, 88-key keyboard with ranges + sounding notes, register
distribution, MusicXML<->MIDI<->audio alignment with Verovio highlighting, realism check
against measured live-orchestra balance.

## Architecture (fixed; deviations need a dated reason here)

- Python >=3.12 core `src/orchspec/` (uv, ruff, pyright, pytest) writes a versioned
  **session bundle** (docs/bundle-format.md). The bundle is the only contract.
- Viewer `viewer/`: Vite + TS + three.js, WebGL2 only (WKWebView portability), one WebGL
  context, heightmap texture displacing a ~2048 x n_bins grid in the vertex shader for the
  visible window. AudioContext is the master clock (getOutputTimestamp when available).
- `orchspec serve`: dev-only read-only FastAPI on 127.0.0.1 (replaced by Tauri 2 in 3b).
- Phase 3b: `rust/orchspec-core` (bundle io, LOD, xcorr) + PyO3; `desktop/` Tauri 2 app
  (Windows + macOS).

## Dependencies (approved list; ask before adding others)

Runtime: librosa, soundfile, numpy, pyloudnorm, pydantic, typer, fastapi (+ uvicorn as
its server), pyyaml, defusedxml. Extra `gpu`: torch (cu130 index on non-darwin).
Extra `dev`: ruff, pyright, pytest, pytest-socket, hypothesis, httpx (FastAPI TestClient).
Viewer: three, vite, typescript, vitest, eslint (+ typescript-eslint), @types/three.
Deferred until approved: pyarrow (Parquet side tables), verovio, Playwright.

## Phases

### Phase 0 — scaffold  (branch `phase-0-scaffold`)
- [x] CLAUDE.md, PLAN.md, git init, .gitignore, .gitattributes, first commit, private GitHub repo
- [x] uv package: pinned .python-version, extras gpu/dev, cu130 index, uv.lock committed
- [x] Layout: cli.py, io/, dsp/, bundle/, score/, timeline/, viewer/, tests/,
      data/instruments/ranges.yaml (schema comment), rust/ + desktop/ READMEs, SECURITY.md
- [x] io/session.py: RenderConfig (render.yaml) pydantic model; validate stems same
      sr/length/channels-compat as mix; clear errors; `orchspec session-template`
- [x] bundle/schema.py: manifest v1 (+ docs/bundle-format.md)
- [x] tests/fixtures/make_synthetic.py: sweep A1->A7 10 s, A4, C4, click train, pink noise
- [x] Viewer skeleton: loads hand-made tiny bundle, renders flat surface
- [x] CI workflow (windows-latest + macos-latest)
- [x] PR for Phase 0 (#1)

Acceptance: `uv sync --locked --extra dev` + `uv run pytest` green on Windows; `npm ci &&
npm test && npm run build` green; CI green on both OSes.

### Phase 1 — MVP  (branch `phase-1-mvp`)
- [x] dsp/cqt.py: CQTSpec; librosa backend (fmin A0, bpo 12k, k in {1,3}, A0..C8);
      torch backend (hand-written kernel CQT) behind `--backend torch`
- [x] dsp/tiles.py: dB, clamp, uint8 quantize, LOD pyramid, tile writer
- [x] dsp/features.py: short-term LUFS (BS.1770 K-weighting via pyloudnorm filters),
      spectral centroid, onset envelope
- [x] `orchspec bundle <wav|session_dir> -o out/x.bundle`: mix + stems on one axis,
      per-stem low-LOD energy table, dominant-stem tiles
- [x] `orchspec serve`: hardened (token, TrustedHost, 127.0.0.1, random port, no CORS,
      read-only, root confinement)
- [x] Viewer: heightmap shader, colormap, orbit camera, playhead plane, linked 2D CQT pane
      with MIDI/pitch-name axis, play/pause/seek, LUFS strip, stem toggles,
      color-by-dominant-stem
- [x] Viewer extras (2026-09-24, user request): smoothing (energy-domain Gaussian, 0-12
      semitones), styles surface / terrain (hillshade + 3 dB contours, 15 dB index) /
      fabric (glowing mesh), "full ensemble (all stems)" view, spectral-gap detection
      (quiet regions inside the frame's sounding span) with lakes in terrain, tint in 2D,
      and a readout of the widest gaps at the playhead
- [x] Required tests (see "Exit gate") + perf smoke numbers recorded below
- [x] PR for Phase 1 (#2, stacked on #1; CI green on windows + macos)

Exit gate tests: test_cqt_axes, test_click_alignment, test_tiles_roundtrip,
test_torch_vs_librosa (gpu/torch), test_bundle_schema (py writer -> vitest parse),
test_session_validation, test_no_network (pytest-socket + vitest request guard),
test_serve_hardening, perf smoke (slow): 20 min 48 kHz mix + 30 stems, CPU and CUDA wall
time (target < 2 min CUDA) + peak VRAM.

### Phase 2 — score & timeline  (branch `phase-2-score`)
- [x] score/: MusicXML (+ .mxl with zip size/path checks) via defusedxml safe parser;
      parts/staves/voices kept distinct; ties merged; grace/cue notes skipped;
      transposition to sounding pitch (`<transpose>` chromatic + octave-change, `<double>`)
- [x] score/repeats.py: repeat barlines (incl. times="n") + n-th endings unrolled;
      segno/coda/D.C./D.S./fine/to-coda detected -> stop with a clear message
- [x] timeline/midi.py: minimal bounded SMF parser (format 0/1, PPQ, running status,
      tempo map); no new dependency
- [x] timeline/: score quarter-notes -> MIDI ticks -> seconds via the render.mid tempo map
      (score `<sound tempo>` when there is no MIDI); MIDI-only sessions use MIDI notes
- [x] Offset estimation audio<->MIDI (onset-envelope cross-correlation around
      preroll_sec, parabolic peak) with synthetic tests; manual `--offset` override
- [x] MusicXML vs MIDI pitch cross-check (tests the "Dorico MIDI = sounding pitch"
      assumption); agreement ratio recorded in the bundle
- [x] Part <-> stem matching (normalized names, then order), recorded in the bundle
- [x] Bundle schema v2: `score` section; notes table (column-major f32:
      part, staff, voice, midi, onset_s, offset_s, measure_index, beat, velocity, f0_db,
      f0_ok), score.json (parts, playback-order measures, alignment report)
- [x] **Fundamentals only** (2026-09-24 request): per note, measured level at its
      fundamental (from its stem when matched, else the mix) and a weak-fundamental flag;
      score-informed fundamentals view in the viewer (keep ± width around each sounding
      note's fundamental, hide overtones); audio-only fallback for sessions without
      score/MIDI: per-stem f0 tracks (librosa yin/pyin) stored as a table
- [x] Viewer: note overlays (surface + 2D pane, colored by part), hover shows
      part/measure/beat; 88-key keyboard with sounding notes at the playhead and the
      selected part's range (data/instruments/ranges.yaml); bar/beat readout
- [x] data/instruments/ranges.yaml populated for the standard orchestra
- [x] Harmonics filter (2026-09-24 request, branch `phase-2b-harmonics-heat`): with
      fundamentals on, overtones 2..16 of each note (or f0 track) pass where >= X dB
- [x] Keyboard heat map: per-key activity with exponential decay tau; sources "sound"
      (decay-weighted power in the key's semitone band from the displayed, filtered page)
      and "notes" (exact decayed note-time); stateless, so seeking/scrubbing is exact
- [x] Full-screen piano view (branch `phase-2c-piano-view`): 88-key keyboard with part
      colors + heat, live per-key spectrum strip, in-moment falling-notes roll with bar
      lines (score notes, or notes derived from per-stem f0 tracks without a score)
- [x] Harmonics slider: off, then 0 dB going down; presets off/0/-6/-12/-20/-30/-40/-60 dB
      (ticks, snap within 1 dB, menu)
- [x] Y-axis stretch: 2D pane pitch zoom (wheel) / pan (shift+wheel) / reset (dbl-click),
      piano-view time stretch (wheel = lookahead) and key height; 3D height up to 3x
- [x] PR for Phase 2 (#3, stacked on #2; CI green on windows + macos)
Acceptance (met 2026-09-24, tests/test_score_bundle.py + viewer screenshots): synthetic MusicXML+MIDI+rendered audio fixture aligns within +-1 frame;
fundamentals view keeps only the notated fundamentals on a synthetic harmonic fixture.

### Phase 3 — alignment & score view  (branch `phase-3-alignment`)
0. Real-session validation (gate for the rest; needs a Dorico+NP5 and a Cubase+BBCSO
   session in git-ignored session/):
- [ ] Bundle both; record alignment offset/confidence, pitch agreement + shift, stem
      matches, weak-fundamental rate per section; resolve or re-scope each Phase 2
      "Unverified assumption" in this file
1. Drift-aware alignment
- [ ] Synthetic drift fixtures first: gradual tempo drift, rubato, per-part latency
      (e.g. +60 ms legato brass), pickup bar, missing/extra notes
- [ ] Score-informed DTW: synthesize a chroma/CQT template from the notes, DTW against the
      audio's CQT (GPU-friendly), onset-refined; piecewise-linear warp map
- [ ] Per-part (per-stem) latency estimate against its own stem (BBCSO articulation delays)
- [ ] Schema v3: `score.alignment.warp` [(score_s, audio_s)] + per-part offsets; notes
      stay in audio seconds; viewer shows alignment confidence over time
  Acceptance: synthetic drift fixtures align every note within +-1 frame (hop 512 @ 48k)
2. Engraved score view
- [ ] Verovio (bundled wasm via Vite; LGPL-3.0 — needs approval) renders the MusicXML;
      follows the playhead (page/system turns), highlights sounding notes by part color,
      click a note/measure -> seek; part filter shared with the piano view
- [ ] Map Verovio element ids <-> bundle notes (part/staff/voice/measure/beat), incl.
      repeats (pass number)
  Acceptance: highlight stays within one beat over a 20-min fixture
3. Register-distribution views
- [ ] Per-section/stem pitch-energy histograms over sliding windows (from tiles or notes),
      register "center of mass" and spread over time, per-family stacks
- [ ] Bundle table `register_hist` [n_stems, 88, n_windows] (f32) or computed in viewer
4. Scale & playback
- [ ] Streaming playback (AudioWorklet + chunked decode) so 20-min stereo does not need
      ~460 MB of decoded audio
- [ ] Compressed tiles (gzip + DecompressionStream) and/or stems from LOD 1 (schema v3)
- [ ] Viewer page assembly, smoothing, stem sums in a Web Worker
- [ ] Playwright E2E smoke + network check (needs approval as a dev dependency)

### Phase 3b — Rust core + Tauri desktop
- [ ] rust/orchspec-core: bundle read/write (docs/bundle-format.md), LOD build, xcorr;
      PyO3 bindings; cross-check against Python writer byte-for-byte
- [ ] desktop/: Tauri 2 app replacing `orchspec serve` (custom protocol, same CSP),
      Windows + macOS builds
Acceptance: same bundle opens identically in Tauri on Windows and macOS.

### Phase 4 — realism check
- [ ] Balance model from measured live-orchestra data (per section level/spectral balance)
- [ ] Compare mockup stems/sections vs reference; report deviations over time
Acceptance: synthetic "overbalanced brass" fixture is flagged.

### Phase 5 — polish
- [ ] Performance for 100 staves / 20 min; accessibility; docs; packaging
- [ ] Perf candidates (see perf discussion 2026-09-24): batch stems through the torch CQT
      (B x n), overlap decode/CQT/tile-writing with a thread pool, compressed tiles
      (gzip + DecompressionStream, or zstd in the Rust core), stems stored from LOD 1,
      viewer page assembly + smoothing + stem sums in a Web Worker (OffscreenCanvas for
      the 2D pane) or on the GPU (texture array), AudioWorklet streaming playback

## Unverified assumptions

- (Phase 2) MusicXML `<pitch>` is written pitch and `<octave-shift>` is display-only;
  sounding = written + chromatic + 12*octave-change; `<double>` sounds an extra octave.
  Dorico's per-staff `<transpose number=...>` is applied to all staves of a part.
- (Phase 2) Dorico/Cubase render.mid tick 0 coincides with the score's first beat
  (pickup bars included) and uses the same repeat expansion as the MusicXML.
- (Phase 2) Instrument ranges in ranges.yaml are approximate textbook values.

- Dorico audio export and MIDI export share time origin (sample 0 == MIDI tick 0)?
  Preroll handling via render.yaml `preroll_sec`.
- Dorico MIDI export writes sounding pitch (not written pitch) for transposing instruments.
- MusicXML `<transpose>` / `<concert-score>` / `<octave-change>` semantics as exported by
  Dorico (concert vs transposed score export).
- NotePerformer ~1 s lookahead is compensated in exported audio; ~25 ms residual offset.
- nnAudio2 agreement with librosa (not used; hand-written torch CQT instead).
- NotePerformer 5 per-player export gives clean per-player separation (no bleed, no shared
  reverb tail) when `reverb_in_stems: false`.
- Dorico condensing/divisi MusicXML export: is the 2nd divisi staff blank in unison?
- Cubase MIDI export preserves Dorico's tempo map.
- BBC SO per-articulation onset delays (sample start offsets) — magnitude and whether
  Cubase compensates.
- Stems sum approximately to mix when `mix_edited: false` (used later for balance checks).

## Decision log

- 2026-09-24: PyTorch index `pytorch-cu130` (uv guide's current recommendation; >= cu128
  required for sm_120 Blackwell). Mapped via [tool.uv.sources] with
  `sys_platform != 'darwin'`; macOS gets PyPI torch (MPS/CPU).
- 2026-09-24: Python pinned to 3.13 in .python-version (requires-python >=3.12): widest
  wheel coverage for torch/soundfile/soxr on both OSes; 3.14 is newer than needed.
- 2026-09-24: n_bins = 88*k covering MIDI 21 .. 108+(k-1)/k (A0..C8 inclusive, top bins
  at C8 and above it for k=3). Keeps "88 keys" == 88 semitone rows.
- 2026-09-24: Frame convention: centered frames, frame t is centered at sample t*hop;
  n_frames = 1 + floor(n_samples / hop). Default hop 512 @ 48 kHz (~10.7 ms); hop must be
  a multiple of 2^(n_octaves-1)=128 for multirate CQT.
- 2026-09-24: Side tables: Phase 1 uses JSON (metadata) + little-endian float32 raw
  arrays (`.f32`, shape in manifest) instead of Parquet, to avoid adding pyarrow and to keep
  the format trivially readable from TS/Rust. Parquet can come later with approval.
- 2026-09-24: Manifest extends the required v1 fields with `stems[]` (each with its own
  `lods`), `dominant` (per-LOD uint8 stem-index tiles), `features[]`, `offsets`, `source`.
  Top-level `lods` is always the mix track. Reason: stems must share axis/time base with the
  mix, and "color by dominant stem" needs per-cell argmax that is cheap in Python and
  expensive in the browser.
- 2026-09-24: `orchspec serve` auth: token in `?token=` on first load sets an HttpOnly
  SameSite=Strict cookie; subsequent requests may use cookie, `X-Orchspec-Token` header or
  query param. Needed because `<script src>` cannot send custom headers.
- 2026-09-24: Viewer tiny test bundle is committed at viewer/public/tiny-bundle/ (manifest
  + tiles only; its WAV is git-ignored and regenerated by tests/fixtures/make_tiny_bundle.py).
  Named without the `.bundle` suffix because `*.bundle/` is git-ignored.
- 2026-09-24: Mix audio is copied into the bundle (`audio/mix.<ext>`) so the bundle is
  self-contained and `serve` never reads outside the bundle root.

- 2026-09-24: Torch CQT backend reuses librosa's public `filters.wavelet` /
  `wavelet_lengths` / `util.sparsify_rows` for kernels and mirrors `vqt`'s multirate loop;
  only the x2 decimator differs (161-tap Kaiser(12) half-band FIR vs soxr_hq). Median
  |dB diff| on fixtures <= 0.02 dB (spec: < 0.5); differences > 1 dB only below -60 dB.
- 2026-09-24: Calibration: dB re full-scale sine per bin = 20 log10(|C| / (sqrt(L_b)/2)),
  L_b = librosa filter length at the input sr (verified: amp 0.5 sine -> -6.02 dB in
  every tested bin).
- 2026-09-24: Defaults: db range [-96, +6] dB (0.4 dB/LSB), tile_frames 1024, dominant
  floor -60 dB, stem energy table at the first level with hop >= 50 ms (L3 = 85 ms @ 48k).
- 2026-09-24: Viewer paging: pages of min(4096, MAX_TEXTURE_SIZE) frames at the level
  where the window fits in 2048 frames; the playhead/window move via uniforms and a page
  is re-assembled only when the window leaves it. 2D pane is Canvas2D (one WebGL context).
- 2026-09-24: Transport: sources start at ctx.currentTime (anchor); playhead =
  offset + max(0, getOutputTimestamp().contextTime - anchor), falling back to
  currentTime - outputLatency.

- 2026-09-24: Smoothing runs on the CPU per page in the POWER domain (u8 -> power -> blur
  -> u8), not in dB and not in the vertex shader. dB-domain blur dragged sparse partials
  below the floor (surface went flat, no gaps); a 7x7 GPU blur cost 49 texture reads per
  vertex. The surface, 2D pane and gap analysis all use the same smoothed page.
- 2026-09-24: Spectral gap = run of bins <= threshold strictly between the frame's lowest
  and highest bin above threshold (empty register above the top voice / below the bass is
  not a gap). Computed on whatever is displayed (mix, full ensemble, selected stems).
- 2026-09-24: Fixed Phase 1 bug: surface triangles were wound clockwise seen from above,
  so top faces were back-face culled; only ridge flanks were visible. Unnoticed because the
  flat floor is near-black in magma.

- 2026-09-24: MIDI parsing is a ~200-line bounded SMF reader (timeline/midi.py) instead of
  mido: render.mid is untrusted input and the dependency list is closed.
- 2026-09-24: Score time -> audio: MusicXML quarters -> render.mid tempo map (MIDI tick 0
  = first beat) -> + offset. Offset = xcorr of note onsets vs an onset envelope with a
  ~23 ms window at ~3 ms hop, searched +-1.5 s around preroll_sec, parabolic peak.
  Measured on the synthetic fixture: +8 ms bias (spectral-flux lag) at 22.05 kHz, well
  inside +-1 frame (23 ms); not corrected, to avoid a magic constant.
- 2026-09-24: Notes are stored with AUDIO-second times (offset applied) so viewers never
  do alignment math; the offset is recorded in score.alignment.
- 2026-09-24: Fundamentals: score-informed (band around each sounding note's fundamental)
  is the primary method; per-stem yin tracks are the fallback only when there is no
  score/MIDI (pyin is ~20x slower; available via --f0 pyin). Weak = more than 12 dB below
  the strongest of harmonics 2-4. Viewer applies the fundamentals mask before smoothing,
  so smoothing + gaps can run on fundamentals only.
- 2026-09-24: Instrument ranges travel inside the bundle (score.parts[].range_*), so the
  viewer never parses ranges.yaml. ranges.yaml is read from the repo (not packaged yet).

- 2026-09-24: Harmonics filter uses an absolute dB threshold (same scale as the display)
  rather than "within X dB of the fundamental", so weak-fundamental instruments (low
  brass, basses) still show their strong upper partials.
- 2026-09-24: Heat map is computed per frame from the data around the playhead
  (integral of input * exp(-(t-s)/tau) over the last 8 tau), not accumulated during
  playback: identical result for play, seek and scrub. "sound" is normalized to the
  hottest key (40 dB range), "notes" linearly to the hottest key (floor 0.5 tau).

## API drift

(Record here whenever an installed library differs from what the original prompt assumed.)

- 2026-09-24: uv's PyTorch guide now leads with `pytorch-cu130` (cu128 still exists);
  torch 2.14.0+cu130 installed, `get_device_name(0)` = RTX 5070 Ti, CUDA 13.0, capability (12, 0).
- 2026-09-24: librosa 1.0.0 `cqt`/`vqt` are keyword-only after `y`; default
  `res_type='soxr_hq'`; docstrings reference `librosa.loadx` (not used). Internals
  (`__vqt_filter_fft`, `__cqt_response`, `__early_downsample`) unchanged in structure from 0.10.
- 2026-09-24: typescript-eslint 8.70 supports TypeScript `<6.1`, so the viewer pins
  TypeScript 6.0.3 (TS 7 native compiler is out but lacks the JS API typescript-eslint needs).
- 2026-09-24: Starlette warns that using `httpx` with `TestClient` is deprecated in favour
  of `httpx2`; still works. Revisit when httpx2 is stable (dependency change needs approval).
- 2026-09-24: pytest-socket raises `SocketConnectBlockedError` (not `SocketBlockedError`)
  when `--allow-hosts` is set.
- 2026-09-24: the `pyright` PyPI wrapper downloads its own Node if none is on PATH (dev
  tooling only; runtime is unaffected). Put Node on PATH to avoid it.

## Perf numbers

2026-09-24, Windows 11, RTX 5070 Ti, `uv run pytest -m slow -s tests/test_perf_smoke.py`
(20 min, 48 kHz, 30 stems + stereo-summed mix, k=3, hop 512, tile_frames 1024):

| backend | wall | load* | cqt | tiles (pyramid + write + dominant) | features | peak VRAM | bundle |
| --- | --- | --- | --- | --- | --- | --- | --- |
| torch (CUDA) | 163.5 s | 130.6 s | 7.3 s | 18.4 s | 6.9 s | 1.44 GiB | 1.87 GiB |
| librosa (CPU) | 299.7 s | 126.1 s | 148.8 s | 17.9 s | 6.6 s | – | 1.87 GiB |

\* "load" in the perf test is dominated by the test **synthesizing** each 20-min stem in
float64 (measured 4.6 s/stem). Decoding a real 20-min stereo 24-bit WAV with soundfile
takes 0.3 s, so with real files the projected end-to-end is **~43 s on CUDA** (target
< 2 min: met) and **~180 s on CPU**. The raw measured CUDA wall (163.5 s) misses the
target only because of test-side synthesis. Single-track 20-min CQT: torch 0.14 s,
librosa 4.9 s.

## Open issues

- Bundle size: 20 min x 31 tracks at k=3 = 1.87 GiB of raw u8 tiles. Options: gzip
  tiles + `DecompressionStream` in the viewer (Safari 16.4+/WebView2 OK), or store stems
  from LOD 1 upward. Needs a schema bump; deferred.
- Viewer decodes the whole mix with `decodeAudioData` (20-min stereo ≈ 460 MB float32 in
  memory). Phase 3 task "streaming playback (AudioWorklet)" addresses it.
- "Selected stems" view power-sums stems on the CPU per page (4096 x 264 cells x n);
  fine for tens of stems, may stutter at ~100 when paging during playback. Could move
  to a texture array + shader sum.
- Dominant-stem tiles are argmax over *quantized* stem values (0.4 dB resolution);
  ties go to the lower stem index.
- Viewer rendering verified only with headless Edge (SwiftShader WebGL) screenshots and
  vitest; audio playback/sync not verified by ear. Please check in a real browser.
- The viewer no-network check is a vitest unit test (fetch stub + source scan + CSP
  check), not a Playwright end-to-end run (Playwright needs approval as a dependency).
- CI runs neither `gpu` nor `slow` tests (no CUDA runners); run them locally.

- The built-in Claude browser pane has WebGL disabled (sandboxed GPU), so visual checks of
  the viewer there are limited to loading/DOM; rendering is verified in a normal browser.
- Viewer dev deps added beyond the prompt's list: @eslint/js, @types/node (types for tests
  reading fixtures). Python: uvicorn (FastAPI server) and httpx (FastAPI TestClient) —
  both are FastAPI's own companions; flagging for approval.

