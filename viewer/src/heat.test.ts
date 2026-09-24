import { describe, expect, it } from "vitest";
import { NOTE_COLUMNS, type NotesTable } from "./bundle";
import { KEY0, heatFromNotes, heatFromPage, normalizeHeat } from "./heat";
import { NoteIndex } from "./notes";

function table(rows: [number, number, number][]): NotesTable {
  const n = rows.length;
  const t = { n } as NotesTable;
  for (const c of NOTE_COLUMNS) t[c] = new Float32Array(n);
  rows.forEach(([midi, on, off], i) => {
    t.midi[i] = midi;
    t.onset_s[i] = on;
    t.offset_s[i] = off;
  });
  return t;
}

describe("heat from notes", () => {
  const tau = 1;
  const t = table([[60, 0, 2], [60, 3, 3.5], [64, 0, 10]]);
  const ix = new NoteIndex(t);
  it("integrates note time with exponential decay", () => {
    const h = heatFromNotes(t, ix, 2, tau);
    expect(h[60 - KEY0]).toBeCloseTo(1 - Math.exp(-2), 5); // tau * (1 - e^-2)
    // after the note ends, heat decays with tau
    const later = heatFromNotes(t, ix, 2.5, tau);
    expect(later[60 - KEY0]).toBeCloseTo((1 - Math.exp(-2)) * Math.exp(-0.5), 5);
  });
  it("accumulates repeated notes on the same key", () => {
    const a = heatFromNotes(t, ix, 3.5, tau)[60 - KEY0]!;
    const onlySecond = 1 - Math.exp(-0.5);
    expect(a).toBeGreaterThan(onlySecond);
  });
  it("a long sustained note saturates at tau", () => {
    expect(heatFromNotes(t, ix, 9, tau)[64 - KEY0]).toBeCloseTo(1, 3);
  });
  it("respects part visibility", () => {
    expect(heatFromNotes(t, ix, 1, tau, () => false).every((v) => v === 0)).toBe(true);
  });
});

describe("heat from sound", () => {
  it("follows the page's energy and decays after it stops", () => {
    const nBins = 88, frames = 100, frameSec = 0.1;
    const data = new Uint8Array(frames * nBins);
    for (let f = 0; f < 20; f++) data[f * nBins + (69 - 21)] = 255; // A4 for 2 s
    const page = { data, nBins, start: 0, frames, frameSec };
    const at = (t: number): number => heatFromPage(page, 1, 21, t, 0.5, -96, 6)[69 - KEY0]!;
    expect(at(1.9)).toBeGreaterThan(0);
    expect(at(3)).toBeLessThan(at(1.9) * Math.exp(-2) * 1.2); // ~ e^(-1.1/0.5) later
    expect(heatFromPage(page, 1, 21, 1.9, 0.5, -96, 6)[60 - KEY0]).toBe(0);
  });
});

describe("normalize", () => {
  it("sound: hottest key = 1, rangeDb below = 0", () => {
    const n = normalizeHeat(Float32Array.of(1, 0.1, 1e-5, 0), "sound", 1, 40);
    expect(n[0]).toBeCloseTo(1);
    expect(n[1]).toBeCloseTo(0.75);
    expect(n[2]).toBe(0);
    expect(n[3]).toBe(0);
  });
  it("notes: linear relative to the hottest key", () => {
    expect(Array.from(normalizeHeat(Float32Array.of(0, 1, 2), "notes", 1))).toEqual([0, 0.5, 1]);
    // a single short note is not blown up to full heat
    expect(normalizeHeat(Float32Array.of(0, 0.1), "notes", 1)[1]).toBeCloseTo(0.2, 6);
  });
});
