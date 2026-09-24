// Spectral gaps of the full ensemble: pitch regions below a level that lie INSIDE the
// sounding span of a frame (between its lowest and highest bin above the level). Empty
// register above the top voice or below the bass is not a gap.

import { midiName } from "./bundle";
import { powerTables } from "./tiles";

/**
 * Per-frame sounding span of a frame-major u8 page.
 * Returns Float32Array [lo0, hi0, lo1, hi1, ...] in bins; lo = hi = -1 when nothing sounds.
 */
export function frameSpans(page: Uint8Array, nBins: number, frames: number, thr: number): Float32Array {
  const out = new Float32Array(frames * 2).fill(-1);
  for (let f = 0; f < frames; f++) {
    const row = f * nBins;
    let lo = -1;
    let hi = -1;
    for (let b = 0; b < nBins; b++) {
      if (page[row + b]! > thr) {
        if (lo < 0) lo = b;
        hi = b;
      }
    }
    out[f * 2] = lo;
    out[f * 2 + 1] = hi;
  }
  return out;
}

export interface Gap {
  loBin: number; // first quiet bin
  hiBin: number; // last quiet bin
  semitones: number;
  label: string;
}

/** Gaps (runs of bins <= thr strictly inside the span) of at least `minSemitones`. */
export function frameGaps(row: Uint8Array, thr: number, k: number, fminMidi: number, minSemitones = 1): Gap[] {
  let lo = -1;
  let hi = -1;
  for (let b = 0; b < row.length; b++) {
    if (row[b]! > thr) {
      if (lo < 0) lo = b;
      hi = b;
    }
  }
  const gaps: Gap[] = [];
  if (lo < 0) return gaps;
  let start = -1;
  for (let b = lo; b <= hi + 1; b++) {
    const quiet = b <= hi && row[b]! <= thr;
    if (quiet && start < 0) start = b;
    if (!quiet && start >= 0) {
      const semis = (b - start) / k;
      if (semis >= minSemitones) {
        const m0 = fminMidi + start / k;
        const m1 = fminMidi + (b - 1) / k;
        gaps.push({ loBin: start, hiBin: b - 1, semitones: semis, label: `${midiName(m0)}–${midiName(m1)}` });
      }
      start = -1;
    }
  }
  return gaps.sort((a, b) => b.semitones - a.semitones);
}

function gaussKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-0.5 * i * i) / (sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i]! /= sum;
  return k;
}

/**
 * Separable Gaussian blur of a frame-major u8 page in the POWER domain (u8 -> power,
 * blur, -> u8), edges clamped. sigmaBins along pitch, sigmaFrames along time; a sigma
 * < 0.05 skips that axis. This is the "smooth" view: it spreads each partial's energy
 * into the ensemble's overall spectral envelope, so register gaps (not the spaces between
 * harmonics) stand out, while loud regions keep roughly their level.
 */
export function smoothPage(page: Uint8Array, nBins: number, frames: number, sigmaBins: number,
                           sigmaFrames: number, dbMin: number, dbMax: number): Uint8Array {
  if (sigmaBins < 0.05 && sigmaFrames < 0.05) return page;
  const { toPow, fromPow } = powerTables(dbMin, dbMax);
  let src = new Float32Array(page.length);
  for (let i = 0; i < page.length; i++) src[i] = toPow[page[i]!]!;
  if (sigmaBins >= 0.05) {
    const k = gaussKernel(sigmaBins);
    const r = (k.length - 1) / 2;
    const dst = new Float32Array(src.length);
    for (let f = 0; f < frames; f++) {
      const row = f * nBins;
      for (let b = 0; b < nBins; b++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const bb = b + i < 0 ? 0 : b + i >= nBins ? nBins - 1 : b + i;
          acc += k[i + r]! * src[row + bb]!;
        }
        dst[row + b] = acc;
      }
    }
    src = dst;
  }
  if (sigmaFrames >= 0.05) {
    const k = gaussKernel(sigmaFrames);
    const r = (k.length - 1) / 2;
    const dst = new Float32Array(src.length);
    for (let f = 0; f < frames; f++) {
      for (let i = -r; i <= r; i++) {
        const ff = f + i < 0 ? 0 : f + i >= frames ? frames - 1 : f + i;
        const w = k[i + r]!;
        const so = ff * nBins, d = f * nBins;
        for (let b = 0; b < nBins; b++) dst[d + b]! += w * src[so + b]!;
      }
    }
    src = dst;
  }
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = fromPow(src[i]!);
  return out;
}
