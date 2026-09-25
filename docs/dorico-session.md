# Preparing a Dorico + NotePerformer 5 session (local only)

Real sessions never go into git. Put each one in its own folder under `session/` at the
repo root (git-ignored, as are `*.wav`, `*.mid`, `*.mxl`). orchspec reads it from there.

```
session/<name>/
  mix.wav                    the full mix
  stems/01_<Player>.wav      one file per player, same start and length as the mix
  stems/02_<Player>.wav
  ...
  render.mid                 MIDI export of the same flow
  score.musicxml             MusicXML export of the same flow (or score.mxl)
  score.pdf                  optional: the engraved score to follow (e.g. condensed)
  render.yaml                optional; `uv run orchspec session-template session/<name>`
```

## What to export from Dorico

Export the **same flow** each time, from the **same project state**, without editing in
between. Menu names differ slightly between Dorico versions; these are the Dorico 5 ones.

1. **Audio, mix** — File ▸ Export ▸ Audio. WAV, 48 kHz (44.1 kHz also works), 24-bit.
   Export the whole flow. Rename the file to `mix.wav`.
2. **Audio, per player** — in the same dialog, export each player/instrument as a
   separate file (the option that writes one file per instrument/player). All files must
   start and end at the same point as the mix; orchspec checks that and reports any
   mismatch. Put them in `stems/` and name them `NN_<Player>.wav` in score order
   (`01_Flute 1.wav`, `02_Oboe.wav`, ...) — or skip the renaming entirely: put Dorico's
   export folder under `session/<name>/` and run
   `uv run orchspec import-dorico "session/<name>"`, which hard-links everything into
   place in score order (no extra disk space; your files are untouched).
   - Leave reverb/room in the mix only if you can; if the per-player files include
     reverb, set `reverb_in_stems: true` in render.yaml.
3. **MIDI** — File ▸ Export ▸ MIDI → `render.mid`. Default options are fine; it must
   include the tempo track.
4. **MusicXML** — File ▸ Export ▸ MusicXML → `score.musicxml` (uncompressed) or
   `score.mxl`. Either transposed or concert pitch works: orchspec converts to sounding
   pitch.
5. **score.pdf** (optional) — File ▸ Export ▸ Graphics, format PDF, one file for the
   whole layout → `score.pdf`. Use the layout you want to read along with (the condensed
   full score shows Dorico's condensing, which MusicXML does not carry). Show bar numbers
   (every system, or every bar) — orchspec reads them from the PDF's text to place bars;
   bars without a printed number continue from the previous one.
6. **render.yaml** (optional):
   ```yaml
   renderer: dorico_noteperformer5
   preroll_sec: 0.0   # leave 0: the ~0.5 s NotePerformer lead-in is measured automatically
   mix_edited: false
   notes: "Dorico 5.x, NotePerformer 5.x, default playback template"
   ```

## Good first test pieces

- 1-3 minutes is plenty to start; a full 20-minute piece is welcome afterwards.
- Ideally includes: transposing instruments (clarinets, horns, trumpets), a tempo change,
  a repeat with 1st/2nd endings, and something sustained in the low brass or basses.
- Avoid D.C./D.S./segno/coda for now (orchspec stops with a message); write jumps out.

## Then

```
uv run orchspec validate session/<name>
uv run orchspec bundle session/<name> -o out/ --backend torch
uv run orchspec report out/<name>.bundle          # alignment, pitch check, stems, weak f0
uv run pytest -m real -s                          # local-only checks on everything in session/
uv run orchspec serve out/<name>.bundle
```

`orchspec report` writes `report.md` / `report.json` next to the bundle. Those contain no
audio, but they do contain part names and timings; share them only if you are comfortable.
