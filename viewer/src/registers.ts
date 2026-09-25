// Register distribution: which part of the pitch range each section occupies over time.
// Pure functions (tested in registers.test.ts); drawing lives in registerview.ts.
//
// Source "sound": each stem's coarse LOD tiles (max-pooled windows of ~0.3 s), folded from
// k bins per semitone to 88 semitones (max). Source "notes": the score's sounding notes.
// Grids are u8, layout [group][frame][88]; a cell is the level (sound, u8 dB) or 255
// (notes) of that semitone in that window.

import type { NotesTable } from "./bundle";

export const KEYS = 88;
export const MIDI0 = 21;

export type Family = "woodwinds" | "brass" | "percussion" | "keyboards" | "strings" | "voices" | "other";
export const FAMILIES: readonly Family[] = ["woodwinds", "brass", "percussion", "keyboards", "strings", "voices", "other"];
export const FAMILY_COLORS: Record<Family, string> = {
  woodwinds: "#6fcf97", brass: "#f2c94c", percussion: "#bb86fc", keyboards: "#56ccf2",
  strings: "#eb5757", voices: "#f2994a", other: "#9aa0a6",
};

// Instrument words first (checked in order), then voice-type words: "Bass Trombone" is
// brass, "Contrabassoon" a woodwind, "Bass" alone a string bass. Mirrors the families in
// data/instruments/ranges.yaml (harp counts as strings there).
const FAMILY_RULES: [Family, RegExp][] = [
  ["woodwinds", /piccolo|flute|\bfl\b|oboe|\bob\b|english horn|cor anglais|clarinet|\bcl\b|bassoon|fagott|\bbsn\b|sax|recorder/],
  ["brass", /horn|\bhn\b|\bcor\b|trumpet|\btpt\b|cornet|trombone|\btbn\b|tuba|euphonium|flugel/],
  ["percussion", /timpani|\btimp\b|kettledrum|percussion|drum|cymbal|glock|xylo|marimba|vibraphone|vibes|triangle|tam-?tam|gong|chimes|tubular|bells/],
  ["keyboards", /piano|\bpno\b|celest|harpsichord|organ|keyboard/],
  ["strings", /violin|\bvln\b|\bvn\b|viola|\bvla\b|\bva\b|cello|\bvc\b|\bvlc\b|contrabass|double bass|kontrabass|\bdb\b|\bcb\b|harp|string|\bbass(es)?\b/],
  ["voices", /soprano|\bsop\b|mezzo|contralto|\balto\b|tenor|baritone|choir|chorus|voice|vocal/],
];

export function familyOf(name: string): Family {
  const n = name.toLowerCase().replace(/[_\-.]+/g, " ");
  for (const [f, re] of FAMILY_RULES) if (re.test(n)) return f;
  return "other";
}

/** Coarsest-enough LOD level: the first whose frames span >= minSec (default 0.25 s). */
export function registerLevel(hop: number, sr: number, nLevels: number, minSec = 0.25): number {
  let level = 0;
  while (level < nLevels - 1 && (hop * 2 ** level) / sr < minSec) level++;
  return level;
}

/** Frame-major page (frames x nBins, k bins per semitone from MIDI 21) -> frames x 88, max. */
export function foldSemitones(page: Uint8Array, nBins: number, frames: number, k: number): Uint8Array {
  const out = new Uint8Array(frames * KEYS);
  const half = Math.floor(k / 2);
  for (let f = 0; f < frames; f++) {
    const row = f * nBins;
    for (let s = 0; s < KEYS; s++) {
      let v = 0;
      // bin s*k is the semitone centre; +-half bins round to the same semitone
      for (let b = Math.max(0, s * k - half); b <= Math.min(nBins - 1, s * k + half); b++) {
        const x = page[row + b]!;
        if (x > v) v = x;
      }
      out[f * KEYS + s] = v;
    }
  }
  return out;
}

/** Per-stem folded grids ([frame][88] each) -> [group][frame][88], max over the group. */
export function combineGroups(perStem: Uint8Array[], groupOf: number[], nGroups: number, frames: number): Uint8Array {
  const out = new Uint8Array(nGroups * frames * KEYS);
  perStem.forEach((g, s) => {
    const grp = groupOf[s] ?? -1;
    if (grp < 0) return;
    const o = grp * frames * KEYS;
    for (let i = 0; i < frames * KEYS; i++) if (g[i]! > out[o + i]!) out[o + i] = g[i]!;
  });
  return out;
}

/** Score notes -> [group][frame][88]: 255 where a note of that group sounds in the window. */
export function notesGrid(notes: NotesTable, groupOfPart: (part: number) => number, nGroups: number,
                          frames: number, frameSec: number): Uint8Array {
  const out = new Uint8Array(nGroups * frames * KEYS);
  for (let i = 0; i < notes.n; i++) {
    const g = groupOfPart(notes.part[i]!);
    const s = Math.round(notes.midi[i]!) - MIDI0;
    if (g < 0 || s < 0 || s >= KEYS) continue;
    const a = Math.max(0, Math.floor(notes.onset_s[i]! / frameSec));
    const b = Math.min(frames - 1, Math.floor(Math.max(notes.onset_s[i]!, notes.offset_s[i]! - 1e-6) / frameSec));
    for (let f = a; f <= b; f++) out[(g * frames + f) * KEYS + s] = 255;
  }
  return out;
}

export interface RegisterStats {
  centroid: Float32Array; // MIDI; NaN = silent
  lo: Float32Array; // 10th percentile (MIDI)
  hi: Float32Array; // 90th percentile (MIDI)
}

/**
 * Per group and frame: weighted centroid and 10-90 % span of the occupied range; cells at
 * or below the threshold are ignored. `dbPerStep` > 0 weights cells by linear POWER
 * (10^(dB/10)), so the strongest partials — usually the fundamentals — dominate and weak
 * overtones barely move the centre; 0 gives every cell above the threshold equal weight
 * (score notes).
 */
export function registerStats(grid: Uint8Array, nGroups: number, frames: number, thrU8: number,
                              dbPerStep = 0): RegisterStats[] {
  const wOf = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    wOf[v] = v <= thrU8 ? 0 : dbPerStep > 0 ? 10 ** (((v - 255) * dbPerStep) / 10) : 1;
  }
  const out: RegisterStats[] = [];
  for (let g = 0; g < nGroups; g++) {
    const st = { centroid: new Float32Array(frames), lo: new Float32Array(frames), hi: new Float32Array(frames) };
    for (let f = 0; f < frames; f++) {
      const o = (g * frames + f) * KEYS;
      let sw = 0, sp = 0;
      for (let s = 0; s < KEYS; s++) {
        const w = wOf[grid[o + s]!]!;
        sw += w;
        sp += w * s;
      }
      if (sw <= 0) {
        st.centroid[f] = st.lo[f] = st.hi[f] = NaN;
        continue;
      }
      st.centroid[f] = MIDI0 + sp / sw;
      let acc = 0, lo = NaN, hi = NaN;
      for (let s = 0; s < KEYS; s++) {
        const w = wOf[grid[o + s]!]!;
        if (w <= 0) continue;
        acc += w;
        if (Number.isNaN(lo) && acc >= 0.1 * sw) lo = s;
        if (Number.isNaN(hi) && acc >= 0.9 * sw) hi = s;
      }
      st.lo[f] = MIDI0 + lo;
      st.hi[f] = MIDI0 + hi;
    }
    out.push(st);
  }
  return out;
}

/** Moving average over +-radius frames, skipping silent (NaN) frames; silence stays NaN. */
export function smoothStats(st: RegisterStats, radius: number): RegisterStats {
  if (radius < 1) return st;
  const sm = (a: Float32Array): Float32Array => {
    const out = new Float32Array(a.length);
    for (let f = 0; f < a.length; f++) {
      if (Number.isNaN(a[f]!)) { out[f] = NaN; continue; }
      let s = 0, n = 0;
      for (let i = Math.max(0, f - radius); i <= Math.min(a.length - 1, f + radius); i++) {
        if (!Number.isNaN(a[i]!)) { s += a[i]!; n++; }
      }
      out[f] = s / n;
    }
    return out;
  };
  return { centroid: sm(st.centroid), lo: sm(st.lo), hi: sm(st.hi) };
}
