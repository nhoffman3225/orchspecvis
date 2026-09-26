// Engraved-score sync: map between bundle audio time and Verovio's own time base through
// measures, and sanitize Verovio's SVG before it enters the DOM.
//
// Verovio's timemap (includeMeasures) lists measures in PLAYBACK order, repeats expanded
// ("-rend2" ids for later passes) — the same order as the bundle's score.measures. We
// align the two sequences by measure number (LCS, robust to a missing or extra measure)
// and interpolate linearly inside each measure.

import type { ScoreMeasure } from "./bundle";

export interface VrvMeasure {
  id: string; // Verovio measure id (possibly an expansion id like "abc-rend2")
  n: string; // notated measure number
  ms: number; // Verovio time of the measure start
  q?: number; // quarter-note position of the measure start (playback order)
}

/** LCS alignment by measure number: result[i] = index into `theirs` or -1. */
export function alignMeasures(ours: string[], theirs: string[]): number[] {
  const n = ours.length, m = theirs.length;
  // DP on a (n+1)x(m+1) table; sizes are measure counts (hundreds to a few thousand)
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = ours[i] === theirs[j]
        ? dp[at(i + 1, j + 1)]! + 1
        : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!);
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ours[i] === theirs[j]) {
      out[i] = j;
      i++;
      j++;
    } else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) i++;
    else j++;
  }
  return out;
}

/** Bidirectional audio-seconds <-> Verovio-ms map through matched measure starts. */
export class ScoreClock {
  private audio: number[] = [];
  private vrv: number[] = [];

  constructor(measures: ScoreMeasure[], vrvMeasures: VrvMeasure[], vrvEndMs: number) {
    const match = alignMeasures(measures.map((x) => x.number), vrvMeasures.map((x) => x.n));
    for (let i = 0; i < measures.length; i++) {
      const j = match[i]!;
      if (j < 0) continue;
      if (this.vrv.length && vrvMeasures[j]!.ms <= this.vrv[this.vrv.length - 1]!) continue;
      this.audio.push(measures[i]!.start_s);
      this.vrv.push(vrvMeasures[j]!.ms);
    }
    const last = measures[measures.length - 1];
    if (last && this.audio.length) {
      this.audio.push(last.end_s);
      this.vrv.push(Math.max(vrvEndMs, this.vrv[this.vrv.length - 1]! + 1));
    }
  }

  get anchors(): number {
    return this.audio.length;
  }

  private static interp(x: number, xs: number[], ys: number[]): number {
    if (xs.length === 0) return NaN;
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const f = (x - xs[lo]!) / (xs[hi]! - xs[lo]! || 1);
    return ys[lo]! + f * (ys[hi]! - ys[lo]!);
  }

  audioToVrv(t: number): number {
    return ScoreClock.interp(t, this.audio, this.vrv);
  }

  vrvToAudio(ms: number): number {
    return ScoreClock.interp(ms, this.vrv, this.audio);
  }
}

/**
 * Remove anything active or style-bearing from Verovio SVG before inserting it:
 * <style>, <script>, <foreignObject>, on* attributes, and hrefs that are not local (#id).
 * (The CSP also blocks scripts and inline styles; this keeps the DOM clean regardless.)
 */
export function sanitizeSvg(svg: string): string {
  // attribute values: quoted, or unquoted up to whitespace / tag end
  const val = String.raw`("[^"]*"|'[^']*'|[^\s"'>]+)`;
  const tag = (names: string): RegExp[] => [
    new RegExp(String.raw`<(\w+:)?(${names})\b[\s\S]*?<\/(\w+:)?\2\s*>`, "gi"),
    new RegExp(String.raw`<\/?(\w+:)?(${names})\b[^>]*>`, "gi"), // self-closing or stray
  ];
  let out = svg.replace(/<\?xml[^>]*>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  // <set>/<animate*> can rewrite an href after sanitizing, so they go too
  for (const re of tag("style|script|foreignObject|iframe|embed|object|set|animate\\w*")) {
    out = out.replace(re, "");
  }
  return out
    .replace(new RegExp(String.raw`\s+on[a-z]+\s*=\s*${val}`, "gi"), "")
    .replace(new RegExp(String.raw`\s+style\s*=\s*${val}`, "gi"), "")
    .replace(/\s+(xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?!["'#])[^\s>]+)/gi, "");
}

export interface TimemapEvent {
  tstamp: number;
  qstamp?: number; // quarter notes from the start (playback order)
  on?: string[];
  off?: string[];
}

/**
 * Notes sounding at a Verovio time, from the timemap's on/off lists. Verovio's own
 * getElementsAtTime only reports notes near their onsets, so we sweep the timemap:
 * incrementally while time moves forward, from the start again after a backward seek.
 */
export class SoundingTracker {
  private i = 0;
  private t = -Infinity;
  private set = new Set<string>();

  constructor(private events: TimemapEvent[]) {}

  at(ms: number): string[] {
    if (ms < this.t) {
      this.i = 0;
      this.set.clear();
    }
    while (this.i < this.events.length && this.events[this.i]!.tstamp <= ms) {
      const e = this.events[this.i]!;
      for (const id of e.off ?? []) this.set.delete(id);
      for (const id of e.on ?? []) this.set.add(id);
      this.i++;
    }
    this.t = ms;
    return [...this.set];
  }
}
