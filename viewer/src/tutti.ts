// Tutti / short-score reduction for proofreading: every sounding note on a grand staff
// (or one grand staff per section), plus selection helpers. Pure functions here (tested
// in tutti.test.ts); drawing and interaction live in tuttiview.ts.
//
// Pitches come from the bundle's notes table (sounding MIDI), so spelling is inferred:
// flats or sharps for the whole piece from its pitch-class usage.

import type { NotesTable } from "./bundle";

export const LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
// pitch class -> [letter index, accidental] with sharps / with flats
const SHARP: [number, number][] = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
const FLAT: [number, number][] = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];

export interface Spelled {
  letter: number; // 0..6 = C..B
  acc: -1 | 0 | 1;
  octave: number; // scientific: C4 = middle C
}

/**
 * Flats or sharps for the piece: black keys that are usually flats (Bb, Eb, Ab) against
 * those usually sharps (F#, C#). Beethoven 5 (C minor) -> flats.
 */
export function preferFlats(midi: ArrayLike<number>): boolean {
  let score = 0;
  for (let i = 0; i < midi.length; i++) {
    const pc = ((Math.round(midi[i]!) % 12) + 12) % 12;
    if (pc === 10 || pc === 3 || pc === 8) score++;
    else if (pc === 6 || pc === 1) score--;
  }
  return score > 0;
}

export function spell(midi: number, flats: boolean): Spelled {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const [letter, acc] = (flats ? FLAT : SHARP)[pc]!;
  return { letter, acc: acc as -1 | 0 | 1, octave: Math.floor(m / 12) - 1 };
}

/** Diatonic staff step: C4 = 28 (7 per octave, letter within). */
export const staffStep = (s: Spelled): number => (s.octave * 7 + s.letter) as number;
export const MIDDLE_C_STEP = 28;
export const TREBLE_LINES = [30, 32, 34, 36, 38]; // E4 G4 B4 D5 F5
export const BASS_LINES = [18, 20, 22, 24, 26]; // G2 B2 D3 F3 A3

export function pitchName(midi: number, flats: boolean): string {
  const s = spell(midi, flats);
  return `${LETTERS[s.letter]}${s.acc > 0 ? "♯" : s.acc < 0 ? "♭" : ""}${s.octave}`;
}

/** Ledger-line steps needed for a note at `step` on a grand staff (even steps only). */
export function ledgerSteps(step: number): number[] {
  const out: number[] = [];
  if (step >= 40) for (let s = 40; s <= step; s += 2) out.push(s); // above the treble
  else if (step <= 16) for (let s = 16; s >= step; s -= 2) out.push(s); // below the bass
  else if (step === MIDDLE_C_STEP) out.push(MIDDLE_C_STEP);
  return out;
}

/** All notes starting within `tol` seconds of note i's onset (a vertical sonority). */
export function chordOf(notes: NotesTable, candidates: number[], i: number, tol = 0.03): number[] {
  const t = notes.onset_s[i]!;
  return candidates.filter((j) => Math.abs(notes.onset_s[j]! - t) <= tol);
}

/**
 * Notes on the same rhythmic grid position as note i: same beat position within the
 * bar (e.g. every note on beat 2.5), among `candidates` (typically what is in view).
 */
export function sameGrid(notes: NotesTable, candidates: number[], i: number, tol = 0.01): number[] {
  const b = notes.beat[i]!;
  return candidates.filter((j) => Math.abs(notes.beat[j]! - b) <= tol);
}

export interface PitchRow {
  midi: number;
  name: string;
  parts: number[]; // part indices playing this pitch in the selection (unique, in order)
  count: number; // notes (a part can repeat a pitch in a longer selection)
}

export interface SelectionSummary {
  rows: PitchRow[]; // highest pitch first
  pitchClasses: { name: string; count: number }[]; // by count, then pitch class
  notes: number;
  parts: number;
}

export function summarize(notes: NotesTable, sel: Iterable<number>, flats: boolean): SelectionSummary {
  const byMidi = new Map<number, PitchRow>();
  const pcs = new Map<number, number>();
  const partSet = new Set<number>();
  let n = 0;
  for (const i of sel) {
    n++;
    const m = Math.round(notes.midi[i]!);
    const p = notes.part[i]!;
    partSet.add(p);
    let row = byMidi.get(m);
    if (!row) byMidi.set(m, (row = { midi: m, name: pitchName(m, flats), parts: [], count: 0 }));
    row.count++;
    if (!row.parts.includes(p)) row.parts.push(p);
    pcs.set(((m % 12) + 12) % 12, (pcs.get(((m % 12) + 12) % 12) ?? 0) + 1);
  }
  const rows = [...byMidi.values()].sort((a, b) => b.midi - a.midi);
  const pitchClasses = [...pcs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([pc, count]) => ({ name: pitchName(pc + 60, flats).replace(/\d+$/, ""), count }));
  return { rows, pitchClasses, notes: n, parts: partSet.size };
}
