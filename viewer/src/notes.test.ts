import { describe, expect, it } from "vitest";
import { NOTE_COLUMNS, type Manifest, type NotesTable, type ScoreMeasure } from "./bundle";
import { NoteIndex, applyMask, measureAt, overtones, rasterizeF0, rasterizeNotes } from "./notes";

// k = 1, hop/sr = 0.1 s per level-0 frame
const M = { n_bins: 88, bins_per_octave: 12, fmin_midi: 21, hop: 100, sr: 1000 } as Manifest;

function table(rows: [number, number, number, number][]): NotesTable {
  // part, midi, onset, offset
  const n = rows.length;
  const t = { n } as NotesTable;
  for (const c of NOTE_COLUMNS) t[c] = new Float32Array(n);
  rows.forEach(([part, midi, on, off], i) => {
    t.part[i] = part;
    t.midi[i] = midi;
    t.onset_s[i] = on;
    t.offset_s[i] = off;
  });
  return t;
}

describe("note index", () => {
  const t = table([[0, 60, 1.0, 3.0], [1, 64, 0.0, 0.5], [0, 67, 2.0, 2.2], [2, 48, 0.0, 10.0]]);
  const ix = new NoteIndex(t);
  it("finds notes overlapping a range", () => {
    expect(ix.inRange(0.6, 1.5).sort()).toEqual([0, 3]);
    expect(ix.inRange(2.1, 2.15).sort()).toEqual([0, 2, 3]);
  });
  it("finds notes sounding at a time", () => {
    expect(ix.activeAt(0.25).sort()).toEqual([1, 3]);
    expect(ix.activeAt(3.5)).toEqual([3]);
  });
});

describe("rasterize + mask (fundamentals only)", () => {
  const t = table([[0, 69, 0.0, 0.5], [3, 45, 0.2, 0.4]]);
  it("marks +-width bins around each fundamental, valued part+1", () => {
    const mask = rasterizeNotes(t, [0, 1], M, 0, 0, 8, 1);
    const at = (f: number, b: number): number => mask[f * 88 + b]!;
    const a4 = 69 - 21, a2 = 45 - 21;
    expect([at(0, a4 - 1), at(0, a4), at(0, a4 + 1), at(0, a4 + 2)]).toEqual([1, 1, 1, 0]);
    expect(at(4, a4)).toBe(1);
    expect(at(5, a4)).toBe(0); // offset 0.5 s -> frames 0..4
    expect([at(1, a2), at(2, a2), at(4, a2)]).toEqual([0, 4, 0]);
    // the octave (2nd harmonic) of A4 is not part of the mask
    expect(at(0, a4 + 12)).toBe(0);
  });
  it("respects page offsets, levels and part filters", () => {
    const m1 = rasterizeNotes(t, [0, 1], M, 1, 1, 4, 0); // level 1: 0.2 s frames, page from frame 1
    expect(m1[0 * 88 + (69 - 21)]).toBe(1); // frame 1 (0.2-0.4 s)
    expect(m1[0 * 88 + (45 - 21)]).toBe(4);
    const hidden = rasterizeNotes(t, [0, 1], M, 0, 0, 8, 0, (p) => p !== 3);
    expect(hidden.includes(4)).toBe(false);
  });
  it("applyMask removes everything outside the fundamentals", () => {
    const page = new Uint8Array(8 * 88).fill(200);
    const out = applyMask(page, rasterizeNotes(t, [0], M, 0, 0, 8, 0));
    expect(out[0 * 88 + 48]).toBe(200);
    expect(out[0 * 88 + 60]).toBe(0);
    expect(out.filter((v) => v).length).toBe(5); // A4 in frames 0..4
  });
  it("rasterizes f0 tracks (audio-only fallback)", () => {
    const f0 = new Float32Array([440, 440, 0, 220, 0, 0, 110, 110]); // 2 stems x 4 frames
    const mask = rasterizeF0(f0, 2, 4, M, 0, 0, 4, 0);
    expect(mask[0 * 88 + 48]).toBe(1);
    expect(mask[2 * 88 + 48]).toBe(0); // unvoiced
    expect(mask[3 * 88 + 36]).toBe(1); // 220 Hz = A3
    expect(mask[2 * 88 + 24]).toBe(2); // stem 2, 110 Hz = A2
  });
});

describe("bar/beat", () => {
  const ms: ScoreMeasure[] = [
    { play_index: 0, number: "1", start_s: 1, end_s: 3, beats: 4, beat_type: 4, pass_no: 1 },
    { play_index: 1, number: "2", start_s: 3, end_s: 4.5, beats: 3, beat_type: 4, pass_no: 1 },
    { play_index: 2, number: "2", start_s: 4.5, end_s: 6, beats: 3, beat_type: 4, pass_no: 2 },
  ];
  it("looks up bar, pass and beat", () => {
    expect(measureAt(ms, 0.5)).toBeNull();
    expect(measureAt(ms, 2)).toMatchObject({ number: "1", beat: 3 });
    expect(measureAt(ms, 5.0)).toMatchObject({ number: "2", pass: 2 });
    expect(measureAt(ms, 5.0)!.beat).toBeCloseTo(2);
    expect(measureAt(ms, 7)).toBeNull();
  });
});

describe("harmonics filter", () => {
  const t = table([[0, 45, 0.0, 0.5]]); // A2 (bin 24 at k=1)
  it("rasterizes overtone bands at n * f0", () => {
    const h = rasterizeNotes(t, [0], M, 0, 0, 8, 0, () => true, overtones(4));
    const at = (b: number): number => h[0 * 88 + b]!;
    expect([at(24), at(36), at(43), at(48)]).toEqual([0, 1, 1, 1]); // 2f=A3, 3f=E4, 4f=A4
  });
  it("keeps overtones only when loud enough", () => {
    const page = new Uint8Array(8 * 88);
    page[24] = 200; // fundamental
    page[36] = 180; // loud 2nd harmonic
    page[43] = 90; // quiet 3rd harmonic
    page[60] = 250; // unrelated energy (not a harmonic of A2 up to 4)
    const fund = rasterizeNotes(t, [0], M, 0, 0, 8, 0);
    const harm = rasterizeNotes(t, [0], M, 0, 0, 8, 0, () => true, overtones(4));
    const off = applyMask(page, fund);
    expect([off[24], off[36], off[43], off[60]]).toEqual([200, 0, 0, 0]);
    const on = applyMask(page, fund, harm, 150);
    expect([on[24], on[36], on[43], on[60]]).toEqual([200, 180, 0, 0]);
  });
});
