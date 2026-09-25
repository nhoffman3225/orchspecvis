import { describe, expect, it } from "vitest";
import type { NotesTable } from "./bundle";
import { KEYS, axisLabel, combineGroups, familyOf, foldSemitones, hzOf, notesGrid, registerLevel, registerStats, smoothStats } from "./registers";

describe("familyOf", () => {
  it.each([
    ["Flute 1", "woodwinds"], ["Contrabassoon", "woodwinds"], ["English Horn", "woodwinds"],
    ["Bass Clarinet", "woodwinds"], ["Horn (E Flat) 1", "brass"], ["Bass Trombone", "brass"],
    ["Alto-Trombone", "brass"], ["Timpani", "percussion"], ["Celesta", "keyboards"],
    ["Violoncello", "strings"], ["Contrabass", "strings"], ["Harp", "strings"], ["Basses", "strings"],
    ["Soprano", "voices"], ["Alto", "voices"], ["Theremin", "other"],
    ["09_Horn-Eb-1-Horn-C-1", "brass"], ["14_Violin-I", "strings"],
  ])("%s -> %s", (name, fam) => expect(familyOf(name)).toBe(fam));
});

describe("register grids", () => {
  it("picks a level whose frames span >= 0.25 s", () => {
    expect(registerLevel(512, 48000, 8)).toBe(5); // 0.34 s
    expect(registerLevel(512, 48000, 3)).toBe(2); // clamped to the coarsest level
  });

  it("folds k bins per semitone onto the semitone centre (max)", () => {
    const k = 3, nBins = KEYS * k;
    const page = new Uint8Array(2 * nBins);
    page[48 * k - 1] = 10; // A4 - 1/3 st
    page[48 * k] = 40; // A4
    page[nBins + 0] = 7; // frame 1, A0
    const f = foldSemitones(page, nBins, 2, k);
    expect(f[48]).toBe(40);
    expect(f[47]).toBe(0);
    expect(f[KEYS + 0]).toBe(7);
  });

  it("combines stems per group and computes centroid and 10-90 % span", () => {
    const a = new Uint8Array(KEYS), b = new Uint8Array(KEYS);
    a[39] = 200; // C4 (MIDI 60)
    b[51] = 200; // C5
    const grid = combineGroups([a, b], [0, 0], 1, 1);
    const [st] = registerStats(grid, 1, 1, 100);
    expect(st!.centroid[0]).toBeCloseTo(66);
    expect(st!.lo[0]).toBe(60);
    expect(st!.hi[0]).toBe(72);
    // power weighting: a partial 10 dB weaker (25 u8 steps of 0.4 dB) weighs 1/10
    b[51] = 175;
    const pw = registerStats(combineGroups([a, b], [0, 0], 1, 1), 1, 1, 100, 0.4)[0]!;
    expect(pw.centroid[0]).toBeCloseTo(60 + 12 / 11, 3);
    const silent = registerStats(new Uint8Array(KEYS), 1, 1, 0)[0]!;
    expect(Number.isNaN(silent.centroid[0]!)).toBe(true);
  });

  it("smooths over time but keeps silence", () => {
    const c = Float32Array.from([60, 70, NaN, 80, 90]);
    const s = smoothStats({ centroid: c, lo: c, hi: c }, 1);
    expect(Array.from(s.centroid.subarray(0, 2))).toEqual([65, 65]);
    expect(Number.isNaN(s.centroid[2]!)).toBe(true);
    expect(s.centroid[3]).toBe(85);
  });

  it("rasterizes score notes per group", () => {
    const col = (xs: number[]): Float32Array => Float32Array.from(xs);
    const notes = { n: 2, part: col([0, 1]), midi: col([60, 72]), onset_s: col([0, 0.5]), offset_s: col([0.6, 1]) } as unknown as NotesTable;
    const g = notesGrid(notes, (p) => p, 2, 4, 0.25);
    expect([0, 1, 2, 3].map((f) => g[f * KEYS + 39])).toEqual([255, 255, 255, 0]);
    expect([0, 1, 2, 3].map((f) => g[(4 + f) * KEYS + 51])).toEqual([0, 0, 255, 255]);
  });
});

describe("pitch axis", () => {
  it("labels notes, frequencies or both", () => {
    expect(hzOf(69)).toBe(440);
    expect(axisLabel(60, "notes")).toBe("C4");
    expect(axisLabel(60, "hz")).toBe("262 Hz");
    expect(axisLabel(96, "both")).toBe("C7 · 2.1k");
    expect(axisLabel(24, "hz")).toBe("33 Hz");
  });
});

describe("fundamentals overlapped by partials", () => {
  it("marks a written pitch that another note's harmonic lands on", async () => {
    const { overlappedFundamentals } = await import("./registerview");
    const keys = 88, frames = 1;
    const fund = new Uint8Array(2 * frames * keys);
    fund[0 * keys + 20] = 1; // group 0: key 20
    fund[1 * keys + 32] = 1; // group 1: key 32 = octave (2nd harmonic) above key 20
    fund[1 * keys + 33] = 1; // key 33: no harmonic of 20 or 32 lands here
    const got = overlappedFundamentals(fund, 2, frames, 0, keys);
    expect([...got]).toEqual([32]);
  });
});
