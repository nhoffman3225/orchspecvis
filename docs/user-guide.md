# User guide

orchspec shows how an orchestral render fills the pitch spectrum over time, next to the
score that produced it. You give it a **session** (the mix, one audio file per player,
the tempo MIDI and the MusicXML score); it analyses the audio once into a **bundle**, and
the viewer plays the bundle back with a 3D spectrogram, the score, a piano, register
charts and a tutti reduction for proofreading.

Everything runs on your machine. The app never connects to the network.

## 1. Install

**Desktop app (recommended).** Download the installer from the repository's Releases
page:

- Windows: `orchspec-<version>-Windows-cpu.exe`. It installs per user and needs no admin
  rights.
- macOS on Apple silicon: `orchspec-<version>-macOS-mps.dmg`. It includes GPU (MPS)
  acceleration for imports.

The builds are not code-signed yet. Windows SmartScreen and macOS Gatekeeper warn the
first time you start the app, so choose *More info → Run anyway* on Windows, or
right-click the app and choose *Open* on macOS.

The Windows download analyses on the CPU: a 6-minute symphony movement with 23 stems
takes about a minute to import. With an NVIDIA GPU, build the GPU edition yourself for
imports of about 13 s (see [development.md](development.md#desktop-builds)).

**From source.** See [development.md](development.md). You then use the `orchspec`
command line and `orchspec serve` in a browser, or build the desktop app.

## 2. Prepare a session

A session is a folder:

```
My Piece/
  mix.wav                 the full render
  stems/01_Flute-1.wav    one file per player: same sample rate and length as the mix
  stems/02_Oboe-1.wav     ...
  render.mid              the MIDI the audio was rendered from (tempo map, timing)
  score.musicxml          the score (or score.mxl)
  score.pdf               optional: the engraved score to read along with
  render.yaml             optional: settings (`orchspec session-template` prints one)
```

You need the mix, the stems, or both: without `mix.wav` the stems are summed into the mix
(the session folder is not changed). Stems make per-instrument views possible. With the MIDI and
MusicXML, notes, bars and parts are aligned to the audio. Dorico users can export the
whole set in one go: see [dorico-session.md](dorico-session.md), which also has
`orchspec import-dorico`, a command that lays a Dorico export out as a session.

## 3. Import

The app starts on its **home screen** (File › Home, Ctrl/Cmd+H):

- **Open Bundle** opens a bundle folder; your bundles are listed below it, recently
  opened ones first. Click one to open it.
- **New Bundle from Files** (Ctrl/Cmd+N) is a wizard: choose the score (MusicXML), the
  tempo MIDI, the stems, the mix and the score PDF (each optional except that you need
  the stems or the mix), name it, and **Build Bundle**. The app lays the files out as a
  session in `Documents/orchspec/sessions/<name>` (hard links, so no extra space on the
  same drive) and analyses it.
  Each optional input says what is lost without it, and **This Bundle Will Have** lists
  the views the files allow: no MusicXML means no engraved score or tutti view (a MIDI
  still gives the notes), no PDF means no score PDF view, no stems means no
  per-instrument views.
- **Import Session Folder** (Ctrl/Cmd+I) analyses a folder already laid out as above.

A progress screen shows each stem as it is analysed, then the result opens. Bundles are
saved in `Documents/orchspec/bundles/<name>.bundle`; building or importing the same
session again replaces its bundle. Closing the app during an import stops the analysis.

From the command line:

```
orchspec bundle "My Piece" -o out/
orchspec report "out/My Piece.bundle"   # checks the score alignment; writes report.md
```

## 4. The main view

| Area | What it shows |
|---|---|
| 3D surface (top) | time × pitch × loudness. Drag to orbit, wheel to zoom. |
| 2D pane (middle) | The same data from above, with the score's notes outlined in part colours. Wheel stretches the pitch axis, Shift+wheel pans, double-click resets. Hover for time, pitch, level, bar and beat. |
| Loudness strip | Short-term loudness (LUFS). |
| Stems list (right) | Show or hide stems and parts. The section chips select woodwinds, brass, percussion or strings in one click (Ctrl/Shift+click adds a section). |

The toolbar is grouped. Playback and the view buttons are always visible. The
**Spectrum**, **Surface**, **Score** and **Keys** groups start folded: click a group's
coloured tag to slide it open (the choice is remembered). Hover any control to see what
it does, or open **Help** (H) for a list of every control.

The controls:

- **window**: seconds of music in view.
- **view**: *mix*; *full ensemble* (the sum of all stems); *selected stems*; or *colour by
  dominant stem*.
- **colors, style**: colour map, and *surface*, *terrain* (hillshade with 3 dB contours)
  or *fabric* (mesh).
- **smooth**: blurs across pitch (in semitones) so the ensemble's spectral envelope and its
  register gaps stand out.
- **notes**: outlines the score's notes. A dashed outline means a weak fundamental.
- **fundamentals ±**: keeps only a narrow band around each sounding note's fundamental.
  **+ harmonics ≥** lets louder overtones back in.
- **key heat**: colours the keyboard by recent activity, from *notes* (the score) or
  *sound* (the measured energy). **τ** sets how fast it fades.
- **gaps ≤**: marks quiet pitch regions inside the sounding range.
- **floor, height**: the surface's floor level and vertical scale.
- **follow**: keeps the playhead in view. **C lines**: octave guides.

## 5. Other views

Open each with its toolbar button or key. A view the bundle lacks the inputs for is
greyed out; hovering it (or pressing its key) says what it needs. Each view opens below the toolbar, which
stays usable. Drag the view's top edge to see the spectrum above it, and drag the bars
between panels to resize them (double-click resets). Esc closes the view.

- **Score (S).** The engraved score (Verovio) follows playback; click a note to jump there.
  Zoom with +/− or Ctrl+wheel, turn pages with PgUp/PgDn, and use *hide empty staves* to
  hide staves that only rest in a system. If the session had a `score.pdf`, switch the
  source to **PDF** to follow the engraved layout (for example Dorico's condensed score),
  with the current bar highlighted.
- **Tutti (T).** Needs the session's MusicXML score. A reduction of the whole orchestra
  at concert pitch for proofreading:
  one chord per bar or per beat, for all parts or by section, coloured by section or by
  part. Click a chord or bar, Alt+click every note on the same
  beat, or drag a box (Shift/Ctrl adds). The selection condenses into one chord plus its
  pitch-class set, shown as a scale, and appears on the piano below.
- **Registers (R).** How each section (or stem) spreads over the pitch range. It uses
  either the *sound*, where fundamentals are solid and partials striped or dotted, or the
  *notes* of the score. The axis can show notes, Hz or both.
- **Piano (P).** Falling notes onto a keyboard with a live spectrum, adjustable lookahead
  and key height.
- **ⓘ credits.** The open-source projects orchspec is built on, with their full licence
  texts.

## 6. Keys

| Key | Action |
|---|---|
| Space | play / pause |
| ← / → | back / forward 5 s (Shift: 1 s) |
| Home | back to the start |
| S, T, R, P | score, tutti, registers, piano |
| H or ? | help: every control and the keys |
| F11 | full screen (desktop app) |
| PgUp / PgDn | score pages |
| + / − | score zoom |
| Esc | clear the tutti selection, or close the open view |

## 7. Troubleshooting

- **"Not a session folder"**: the folder needs a `mix.wav`.
- **Import fails at the end**: the error and the last lines of the analysis are on the
  progress screen. `orchspec validate <session>` checks a session without analysing it.
- **Notes don't line up with the audio**: run `orchspec report` on the bundle. It checks
  that the MIDI is at sounding pitch, the time origin, the note ranges and the stem
  separation.
- **Score PDF bars are misplaced**: bar numbers must be printed in the PDF (every system,
  or every bar); see [dorico-session.md](dorico-session.md).
