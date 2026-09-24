// Keyboard heat map: per-key activity with exponential decay (time constant tau).
//
// heat_k(t) = integral over s <= t of input_k(s) * exp(-(t - s) / tau) ds
//
// Computed directly from data around time t (no running state), so seeking and scrubbing
// give the same picture as playing through.
//
//   notes: input = 1 while a note sounds on key k  ->  "how many notes, recently"
//   sound: input = measured power in key k's semitone band (from the displayed page, so
//          the fundamentals/harmonics filter applies) -> fades as the sound decays

import type { NotesTable } from "./bundle";
import type { NoteIndex } from "./notes";
import { powerTables } from "./tiles";

export const N_KEYS = 88;
export const KEY0 = 21; // A0

/** Exact decayed note-time per key (seconds). */
export function heatFromNotes(notes: NotesTable, index: NoteIndex, t: number, tau: number,
                              visible: (part: number) => boolean = () => true): Float32Array {
  const out = new Float32Array(N_KEYS);
  const horizon = 8 * tau;
  for (const i of index.inRange(t - horizon, t + 1e-9)) {
    if (!visible(notes.part[i]!)) continue;
    const key = Math.round(notes.midi[i]!) - KEY0;
    if (key < 0 || key >= N_KEYS) continue;
    const on = notes.onset_s[i]!;
    if (on > t) continue;
    const end = Math.min(notes.offset_s[i]!, t);
    // integral_{on}^{end} exp(-(t - s)/tau) ds
    out[key]! += tau * (Math.exp(-(t - end) / tau) - Math.exp(-(t - on) / tau));
  }
  return out;
}

export interface PageRef {
  data: Uint8Array; // frame-major u8 (frames x nBins)
  nBins: number;
  start: number; // first frame of the page (at its level)
  frames: number;
  frameSec: number; // seconds per frame at the page's level
}

/** Decayed power-seconds per key from the page (bins of each semitone summed in power). */
export function heatFromPage(page: PageRef, k: number, fminMidi: number, t: number,
                             tau: number, dbMin: number, dbMax: number): Float32Array {
  const out = new Float32Array(N_KEYS);
  const { toPow } = powerTables(dbMin, dbMax);
  const fNow = Math.floor(t / page.frameSec) - page.start;
  const fFrom = Math.max(0, fNow - Math.ceil((8 * tau) / page.frameSec));
  const fTo = Math.min(page.frames - 1, fNow);
  const half = (k - 1) / 2; // bins of a semitone are centered on its key
  for (let f = fFrom; f <= fTo; f++) {
    const w = Math.exp(-(t - (page.start + f) * page.frameSec) / tau) * page.frameSec;
    const row = f * page.nBins;
    for (let key = 0; key < N_KEYS; key++) {
      const c = (key + KEY0 - fminMidi) * k;
      let p = 0;
      for (let b = Math.round(c - half); b <= Math.round(c + half); b++) {
        if (b >= 0 && b < page.nBins) p += toPow[page.data[row + b]!]!;
      }
      out[key]! += w * p;
    }
  }
  return out;
}

/**
 * Heat -> 0..1 for display.
 * `notes`: linear relative to the hottest key, but never scaled up beyond "half of one
 *          sustained note" (0.5 * tau), so a single short note does not saturate.
 * `sound`: dB, the hottest key at 1 and rangeDb below at 0.
 */
export function normalizeHeat(h: Float32Array, mode: "notes" | "sound", tau: number,
                              rangeDb = 40): Float32Array {
  const out = new Float32Array(h.length);
  if (mode === "notes") {
    let max = 0;
    for (const v of h) max = Math.max(max, v);
    const scale = Math.max(max, 0.5 * tau);
    for (let i = 0; i < h.length; i++) out[i] = h[i]! / scale;
    return out;
  }
  let max = 0;
  for (const v of h) max = Math.max(max, v);
  if (max <= 0) return out;
  const top = 10 * Math.log10(max);
  for (let i = 0; i < h.length; i++) {
    const v = h[i]!;
    out[i] = v > 0 ? Math.max(0, Math.min(1, (10 * Math.log10(v) - (top - rangeDb)) / rangeDb)) : 0;
  }
  return out;
}

/** Live per-key level (0..1) at time t: max over the key's semitone bins in the page,
 * mapped from [db_min, db_max] quantization (u8 / 255). */
export function keyLevelsAt(page: PageRef, k: number, fminMidi: number, t: number): Float32Array {
  const out = new Float32Array(N_KEYS);
  const f = Math.floor(t / page.frameSec + 0.5) - page.start;
  if (f < 0 || f >= page.frames) return out;
  const row = f * page.nBins;
  const half = (k - 1) / 2;
  for (let key = 0; key < N_KEYS; key++) {
    const c = (key + KEY0 - fminMidi) * k;
    let v = 0;
    for (let b = Math.round(c - half); b <= Math.round(c + half); b++) {
      if (b >= 0 && b < page.nBins) v = Math.max(v, page.data[row + b]!);
    }
    out[key] = v / 255;
  }
  return out;
}
