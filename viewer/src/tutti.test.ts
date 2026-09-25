import { describe, expect, it } from "vitest";
import type { NotesTable } from "./bundle";
import { chordOf, ledgerSteps, pitchName, preferFlats, sameGrid, spell, staffStep, summarize } from "./tutti";

const table = (rows: { part: number; midi: number; on: number; beat: number }[]): NotesTable => {
  const col = (f: (r: (typeof rows)[number]) => number): Float32Array => Float32Array.from(rows, f);
  return {
    n: rows.length, part: col((r) => r.part), midi: col((r) => r.midi), onset_s: col((r) => r.on),
    offset_s: col((r) => r.on + 0.5), beat: col((r) => r.beat),
  } as unknown as NotesTable;
};

describe("spelling and staff positions", () => {
  it("spells with flats or sharps and maps to diatonic steps", () => {
    expect(pitchName(60, false)).toBe("C4");
    expect(pitchName(63, true)).toBe("E♭4");
    expect(pitchName(63, false)).toBe("D♯4");
    expect(pitchName(21, true)).toBe("A0");
    expect(staffStep(spell(60, true))).toBe(28); // middle C
    expect(staffStep(spell(64, true))).toBe(30); // E4: bottom treble line
    expect(staffStep(spell(43, true))).toBe(18); // G2: bottom bass line
    expect(staffStep(spell(63, true))).toBe(30); // Eb4 sits on the E line
    expect(staffStep(spell(63, false))).toBe(29); // D#4 on the D space
  });

  it("chooses flats for flat-key material", () => {
    expect(preferFlats([60, 63, 67, 70, 68])).toBe(true); // C minor: Eb Bb Ab
    expect(preferFlats([62, 66, 69, 61])).toBe(false); // D major: F# C#
  });

  it("adds ledger lines only outside the staves (and for middle C)", () => {
    expect(ledgerSteps(34)).toEqual([]);
    expect(ledgerSteps(28)).toEqual([28]);
    expect(ledgerSteps(42)).toEqual([40, 42]); // A5 +: C6 needs two
    expect(ledgerSteps(14)).toEqual([16, 14]);
  });
});

describe("selection", () => {
  const t = table([
    { part: 0, midi: 75, on: 1.0, beat: 1 },
    { part: 1, midi: 63, on: 1.01, beat: 1 },
    { part: 2, midi: 51, on: 1.0, beat: 1 },
    { part: 0, midi: 74, on: 1.5, beat: 1.5 },
    { part: 1, midi: 63, on: 2.0, beat: 2 },
    { part: 2, midi: 55, on: 3.5, beat: 1.5 },
  ]);
  const all = [0, 1, 2, 3, 4, 5];

  it("takes the vertical sonority at a note's onset", () => {
    expect(chordOf(t, all, 1)).toEqual([0, 1, 2]);
  });

  it("takes every note on the same beat position", () => {
    expect(sameGrid(t, all, 3)).toEqual([3, 5]);
  });

  it("summarizes pitches, doublings and pitch classes", () => {
    const s = summarize(t, [0, 1, 2, 4], true);
    expect(s.rows.map((r) => r.name)).toEqual(["E♭5", "E♭4", "E♭3"]);
    expect(s.rows[1]).toMatchObject({ parts: [1], count: 2 });
    expect(s.pitchClasses).toEqual([{ name: "E♭", count: 4 }]);
    expect(s).toMatchObject({ notes: 4, parts: 3 });
  });
});
