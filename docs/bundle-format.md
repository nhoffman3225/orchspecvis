# Session bundle format — schema version 3

A bundle is a directory (conventionally `<name>.bundle/`). It is the only contract
between the analysis core and any viewer. This document is normative; the reference
implementations are `src/orchspec/bundle/schema.py` (pydantic) and
`viewer/src/bundle.ts` (TypeScript). A Rust implementation must match them.

## Directory layout

```
<name>.bundle/
  manifest.json
  audio/mix.<ext>                     copy of the source mix, byte-identical
  tiles/mix/L<level>/<index>.u8       spectrogram tiles, mix
  tiles/stem-<id>/L<level>/<index>.u8 one pyramid per stem
  tiles/dominant/L<level>/<index>.u8  dominant-stem index tiles
  features/<name>.f32                 1-D time series
  tables/<name>.f32                   2-D tables (rows x time)
  score/notes.f32                     note table (v2, when a score or MIDI was given)
```

`<level>` and `<index>` are decimal; `<index>` zero-padded to 5 digits. Readers must use the
paths in the manifest, not reconstruct them.

## Conventions

- **Encoding**: `manifest.json` is UTF-8 JSON. Binary files have no header.
- **Paths** in the manifest are relative POSIX paths inside the bundle; readers must reject
  absolute paths, backslashes, `:` and any `..` component.
- **Time**: all times are audio seconds from sample 0 of the mix. Frame `f` at LOD level
  `L` starts at level-0 frame `f * 2^L`; level-0 frame `t` is **centered** on sample
  `t * hop`, i.e. time `t * hop / sr`. `n_frames = 1 + floor(n_samples / hop)`.
  Offsets that relate audio time to score time (e.g. `offsets.preroll_sec`) live only in
  the manifest.
- **Frequency**: bin `b` (0-based) is MIDI pitch `fmin_midi + b / k` with
  `k = bins_per_octave / 12`, `fmin_midi = 21` (A0), `n_bins = 88 * k`, equal temperament,
  A4 = 440 Hz, tuning 0.
- **Shared axes**: the mix, every stem and the dominant-stem tiles share `sr`, `hop`,
  `n_frames`, `n_bins`, `tile_frames` and the LOD structure.

## Spectrogram tiles (`.u8`)

- Layout `frame_major_u8`: a tile with `n` frames is exactly `n * n_bins` bytes; byte
  `f * n_bins + b` is frame `f` (relative to the tile's `start_frame`), bin `b`.
- Value `v` (0..255) means `db = db_min + v * (db_max - db_min) / 255`.
  Quantization: `v = round((clamp(db, db_min, db_max) - db_min) * 255 / (db_max - db_min))`.
  `v = 0` is "at or below the floor".
- `db_reference = "full_scale_sine_per_bin"`: each bin is calibrated so that a steady sine
  of amplitude 1.0 (0 dBFS peak) centered on that bin reads 0 dB. Different bins have
  different bandwidths, so broadband noise is not flat (pink noise is approximately flat).
- Tiles within a level are contiguous: tile `i` covers frames
  `[start_frame, start_frame + n_frames)`, all tiles have `n_frames == tile_frames` except
  possibly the last.
- **LOD pyramid**: level 0 is full resolution. Level `L+1` has
  `ceil(n_frames_L / 2)` frames; frame `f` is the elementwise **max** of level-`L` frames
  `2f` and `2f+1` (the last frame alone if the count is odd), applied directly on the
  uint8 values (`lod_reduce = "max"`). Levels are generated until a level fits in one tile.

## Dominant-stem tiles

Same geometry and layout as spectrogram tiles. Byte value is the index (0..n_stems-1) of
the stem with the highest dB in that cell, or `none_value` (255) when every stem is at or
below `floor_db`. Computed per level from the stems' pooled level (not by pooling indices).

## Float series (`.f32`)

Little-endian IEEE-754 float32, C order, shape given by `shape`. The last axis is time:
element `i` is at `t0_seconds + i * hop_seconds`. 2-D tables carry `row_labels`
(e.g. stem ids). NaN is not used; missing values are `-inf` only where documented.

Phase 1 series:

| name | where | shape | unit | meaning |
| --- | --- | --- | --- | --- |
| `lufs_short_term` | features | `[n]` | LUFS | BS.1770 short-term loudness, 3 s window centered on each time, hop 0.1 s; `-inf` clamped to -120 |
| `spectral_centroid` | features | `[n_frames]` | Hz | spectral centroid of the mono mix (STFT, same hop) |
| `onset_envelope` | features | `[n_frames]` | a.u. | librosa onset strength of the mono mix |
| `stem_energy_db` | tables | `[n_stems, n]` | dB | per-stem total CQT power (sum over bins, calibrated scale), mean over `2^L` level-0 frames at `energy_level` |

| `f0_hz` | tables | `[n_stems, n_frames]` | Hz | per-stem fundamental (yin/pyin), 0 = unvoiced; written when there is no score/MIDI (or `--f0 yin|pyin`) |

## Score section (schema v2)

Present when the session had `score.musicxml` / `.mxl` and/or `render.mid`. All times
are **audio seconds**; `alignment.offset_sec` records how score/MIDI time was shifted
(`audio = score_or_midi_seconds + offset_sec`).

- `score.kind`: `musicxml` (notes from MusicXML, timed through the render.mid tempo map or
  the score's tempo marks) or `midi` (notes straight from render.mid).
- `score.parts[]`: `{index, id, name, instrument, abbreviation, staves,
  transpose_chromatic, transpose_octave, stem_id, stem_match, range_id, range_low,
  range_high, practical_low, practical_high}`. `stem_id` refers to `stems[].id`
  (`stem_match` = `name|fuzzy|order|none`). Ranges are sounding MIDI pitches from
  `data/instruments/ranges.yaml`.
- `score.measures[]`: playback order (repeats and endings unrolled):
  `{play_index, number, start_s, end_s, beats, beat_type, pass_no}`.
- `score.alignment`: `{method: xcorr|manual|preroll_only, offset_sec, preroll_sec,
  confidence, time_source: midi|score_tempo, pitch_agreement, pitch_shift_mode, warnings}`.
- `score.notes`: `{path, n, columns, dtype: "f32le", layout: "column_major"}`. The file is
  `len(columns) * n` float32 values; column `c` occupies bytes `[4*c*n, 4*(c+1)*n)`.
  Columns, in order:

| column | meaning |
| --- | --- |
| `part` | index into `score.parts` |
| `staff`, `voice` | 1-based; never collapsed |
| `midi` | **sounding** pitch (fractional for microtones) |
| `onset_s`, `offset_s` | audio seconds |
| `measure` | index into `score.measures` (playback order) |
| `beat` | 1-based beat in the measure (beat-type units) |
| `velocity` | from render.mid when available, else 0 |
| `f0_db` | measured level at the fundamental (dB re full-scale sine), from the part's stem when matched, else the mix |
| `f0_ok` | 1.0 when the fundamental is within 12 dB of the strongest of harmonics 2-4 and above -80 dB, else 0.0 (weak/missing fundamental) |

Schema v3 adds, all optional:
- `score.alignment.warp`: `[[score_s, audio_s], ...]`, monotonic, the common
  score/MIDI-seconds -> audio-seconds map (method `warp`); outside its range it continues
  with the end slope. Each part's notes additionally carry that part's latency.
- `score.alignment.snapped`: fraction of notes whose onset was snapped to an audio onset.
- `score.parts[].latency_sec` (seconds, relative to the typical part) and
  `score.parts[].snapped` (fraction).
- `score.score_file`: bundle-relative copy of the MusicXML (`score/score.musicxml` or
  `score/score.mxl`) for engraving; `score.measures[].source_index`: the notated measure
  a played measure comes from (repeats undone).
Note times in the notes table are final audio times either way.

Readers must accept schema_version 1 (no score), 2 and 3.

## manifest.json fields

| field | type | notes |
| --- | --- | --- |
| `schema_version` | int | `3` (`1`, `2` still accepted) |
| `created_by` | string | e.g. `orchspec 0.1.0` |
| `created_at` | string | ISO 8601 UTC |
| `sr`, `hop`, `n_samples` | int | mix sample rate, CQT hop, mix length |
| `duration_seconds` | float | `n_samples / sr` |
| `fmin_midi` | float | `21.0` |
| `bins_per_octave`, `n_bins`, `n_frames` | int | `12k`, `88k`, `1 + n_samples // hop` |
| `db_min`, `db_max` | float | quantization range |
| `db_reference` | string | `full_scale_sine_per_bin` |
| `lod_reduce` | string | `max` |
| `tile_frames` | int | frames per full tile |
| `tile_layout` | string | `frame_major_u8` |
| `lods` | Lod[] | the mix pyramid |
| `audio_path`, `audio_sha256` | string | copied mix audio and SHA-256 of its bytes |
| `cqt` | object | `{backend, k, filter_scale, window, tuning, frame_convention}` |
| `offsets` | object | `{preroll_sec}` |
| `source` | object | `{kind: wav|session, name, renderer, render_config}` |
| `stems` | Stem[] | `{id, index, name, source_file, lods}`; index = position |
| `dominant` | object\|null | `{none_value, floor_db, lods}` |
| `score` | object\|null | v2; see "Score section" |
| `features`, `tables` | Series[] | `{name, unit, description, path, shape, dtype: "f32le", t0_seconds, hop_seconds, row_labels}` |

`Lod = {level, hop_factor = 2^level, n_frames, tiles: Tile[]}`,
`Tile = {index, start_frame, n_frames, path}`.

Unknown fields are an error in schema v1 (readers are strict so drift is caught early).
