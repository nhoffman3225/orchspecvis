// Score notes in the viewer: time index, page rasterization (note overlay and the
// "fundamentals only" mask), and bar/beat lookup. Times are audio seconds.

import type { Manifest, NotesTable, ScoreMeasure } from "./bundle";

export class NoteIndex {
  /** note indices sorted by onset */
  readonly order: Uint32Array;
  private onsets: Float64Array;
  private maxDur = 0;

  constructor(readonly notes: NotesTable) {
    const idx = Array.from({ length: notes.n }, (_, i) => i);
    idx.sort((a, b) => notes.onset_s[a]! - notes.onset_s[b]!);
    this.order = Uint32Array.from(idx);
    this.onsets = Float64Array.from(idx, (i) => notes.onset_s[i]!);
    for (let i = 0; i < notes.n; i++) {
      this.maxDur = Math.max(this.maxDur, notes.offset_s[i]! - notes.onset_s[i]!);
    }
  }

  private lowerBound(t: number): number {
    let lo = 0, hi = this.onsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.onsets[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Notes overlapping [t0, t1). */
  inRange(t0: number, t1: number): number[] {
    const out: number[] = [];
    const end = this.lowerBound(t1);
    for (let k = this.lowerBound(t0 - this.maxDur); k < end; k++) {
      const i = this.order[k]!;
      if (this.notes.offset_s[i]! > t0) out.push(i);
    }
    return out;
  }

  /** Notes sounding at time t. */
  activeAt(t: number): number[] {
    return this.inRange(t, t + 1e-9).filter((i) => this.notes.onset_s[i]! <= t);
  }
}

/** Seconds per frame at a pyramid level. */
export const frameSeconds = (m: Manifest, level: number): number => (m.hop * 2 ** level) / m.sr;

/** Harmonic numbers 2..n. */
export const overtones = (n: number): number[] => Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 2);

/** Bin offset of harmonic h above its fundamental: 12 * k * log2(h). */
const harmonicOffset = (h: number, k: number): number => 12 * k * Math.log2(h);

/**
 * Rasterize notes into a page-aligned mask (frames x n_bins, frame-major):
 * value = part index + 1 (0 = no note) in +-widthBins around each listed harmonic of each
 * note (default: the fundamental only).
 */
export function rasterizeNotes(
  notes: NotesTable, which: number[], m: Manifest, level: number, pageStart: number,
  pageFrames: number, widthBins: number, visible: (part: number) => boolean = () => true,
  harmonics: readonly number[] = [1],
): Uint8Array {
  const nb = m.n_bins;
  const k = m.bins_per_octave / 12;
  const ft = frameSeconds(m, level);
  const out = new Uint8Array(pageFrames * nb);
  for (const i of which) {
    const part = notes.part[i]!;
    if (!visible(part)) continue;
    let f0 = Math.floor(notes.onset_s[i]! / ft + 0.5) - pageStart;
    let f1 = Math.max(f0 + 1, Math.floor(notes.offset_s[i]! / ft + 0.5) - pageStart);
    f0 = Math.max(0, f0);
    f1 = Math.min(pageFrames, f1);
    if (f1 <= f0) continue;
    const v = Math.min(254, part + 1);
    for (const h of harmonics) {
      const c = (notes.midi[i]! - m.fmin_midi) * k + harmonicOffset(h, k);
      const b0 = Math.max(0, Math.round(c - widthBins));
      const b1 = Math.min(nb - 1, Math.round(c + widthBins));
      if (b1 < b0) continue;
      for (let f = f0; f < f1; f++) out.fill(v, f * nb + b0, f * nb + b1 + 1);
    }
  }
  return out;
}

/**
 * Audio-only fallback: rasterize per-stem f0 tracks (rows x level-0 frames, Hz, 0 =
 * unvoiced) into a page mask; value = stem index + 1.
 */
export function rasterizeF0(
  f0: Float32Array, rows: number, frames0: number, m: Manifest, level: number,
  pageStart: number, pageFrames: number, widthBins: number,
  visible: (stem: number) => boolean = () => true, harmonics: readonly number[] = [1],
): Uint8Array {
  const nb = m.n_bins;
  const k = m.bins_per_octave / 12;
  const step = 2 ** level;
  const out = new Uint8Array(pageFrames * nb);
  for (let r = 0; r < rows; r++) {
    if (!visible(r)) continue;
    const v = Math.min(254, r + 1);
    for (let f = 0; f < pageFrames; f++) {
      const g0 = (pageStart + f) * step;
      if (g0 >= frames0) break;
      for (let g = g0; g < Math.min(frames0, g0 + step); g++) {
        const hz = f0[r * frames0 + g]!;
        if (hz <= 0) continue;
        const c0 = (69 + 12 * Math.log2(hz / 440) - m.fmin_midi) * k;
        for (const h of harmonics) {
          const c = c0 + harmonicOffset(h, k);
          const b0 = Math.max(0, Math.round(c - widthBins));
          const b1 = Math.min(nb - 1, Math.round(c + widthBins));
          if (b1 >= b0) out.fill(v, f * nb + b0, f * nb + b1 + 1);
        }
      }
    }
  }
  return out;
}

/**
 * Keep page cells inside `mask` (fundamentals); also keep cells inside `extra`
 * (overtone bands) whose value is >= extraThr (u8). Everything else goes to 0.
 */
export function applyMask(page: Uint8Array, mask: Uint8Array, extra?: Uint8Array | null,
                          extraThr = 256): Uint8Array {
  const out = new Uint8Array(page.length);
  for (let i = 0; i < page.length; i++) {
    const v = page[i]!;
    if (mask[i] || (extra && extra[i] && v >= extraThr)) out[i] = v;
  }
  return out;
}

export interface BarBeat {
  index: number;
  number: string;
  pass: number;
  beat: number;
}

/** Bar and (1-based, fractional) beat at audio time t, or null outside the score. */
export function measureAt(measures: ScoreMeasure[], t: number): BarBeat | null {
  let lo = 0, hi = measures.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measures[mid]!.start_s <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const ms = measures[found]!;
  if (t >= ms.end_s && found === measures.length - 1) return null;
  const frac = (t - ms.start_s) / Math.max(1e-9, ms.end_s - ms.start_s);
  return { index: found, number: ms.number, pass: ms.pass_no, beat: 1 + frac * ms.beats };
}
