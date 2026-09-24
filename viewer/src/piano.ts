// Full-screen piano view: a real 88-key keyboard across the width, a live per-key spectrum
// strip, and an in-moment falling-notes roll (time runs down into the keys; "now" is the
// keyboard edge). Canvas2D only.

import { NOTE_COLUMNS, midiName, type NotesTable, type ScoreMeasure, type ScorePart } from "./bundle";
import { colormapLut } from "./colormap";
import { N_KEYS, KEY0 } from "./heat";
import type { NoteIndex } from "./notes";

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (midi: number): boolean => BLACK.has(((midi % 12) + 12) % 12);

export interface KeyGeom {
  midi: number;
  x: number;
  w: number;
  black: boolean;
}

/** Piano geometry for MIDI 21..108 across `width` px: 52 equal white keys, black keys
 * 0.6 of a white key wide, centered on the boundary between their white neighbours. */
export function keyLayout(width: number): KeyGeom[] {
  const ww = width / 52;
  const bw = ww * 0.6;
  const out: KeyGeom[] = [];
  let white = 0;
  for (let midi = KEY0; midi < KEY0 + N_KEYS; midi++) {
    if (isBlack(midi)) {
      out.push({ midi, x: white * ww - bw / 2, w: bw, black: true });
    } else {
      out.push({ midi, x: white * ww, w: ww, black: false });
      white++;
    }
  }
  return out;
}

/**
 * Audio-only fallback: turn per-stem f0 tracks (rows x frames, Hz, 0 = unvoiced) into
 * note events by grouping consecutive frames that round to the same key.
 * part = stem row. Segments shorter than minDur seconds are dropped.
 */
export function notesFromF0(f0: Float32Array, rows: number, frames: number, frameSec: number,
                            minDur = 0.08): NotesTable {
  const segs: [number, number, number, number][] = []; // row, midi, on, off
  for (let r = 0; r < rows; r++) {
    let cur = -1;
    let start = 0;
    for (let f = 0; f <= frames; f++) {
      const hz = f < frames ? f0[r * frames + f]! : 0;
      const key = hz > 0 ? Math.round(69 + 12 * Math.log2(hz / 440)) : -1;
      if (key !== cur) {
        if (cur >= 0 && (f - start) * frameSec >= minDur) {
          segs.push([r, cur, start * frameSec, f * frameSec]);
        }
        cur = key;
        start = f;
      }
    }
  }
  segs.sort((a, b) => a[2] - b[2]);
  const n = segs.length;
  const t = { n } as NotesTable;
  for (const c of NOTE_COLUMNS) t[c] = new Float32Array(n);
  segs.forEach(([r, midi, on, off], i) => {
    t.part[i] = r;
    t.midi[i] = midi;
    t.onset_s[i] = on;
    t.offset_s[i] = off;
    t.staff[i] = 1;
    t.voice[i] = 1;
    t.f0_ok[i] = 1;
  });
  return t;
}

export interface PianoState {
  t: number;
  lookahead: number; // seconds shown above the keys
  notes: NotesTable | null;
  index: NoteIndex | null;
  parts: ScorePart[];
  measures: ScoreMeasure[];
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  focus: number | null;
  heat: Float32Array | null; // 0..1 per key
  levels: Float32Array | null; // 0..1 per key (live spectrum)
  keyScale: number; // keyboard height stretch (1 = default)
}

export class PianoView {
  private heatLut = colormapLut("inferno");
  private specLut = colormapLut("magma");

  constructor(private canvas: HTMLCanvasElement) {}

  draw(s: PianoState): void {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, W, H);

    const pad = 8;
    const keysW = W - 2 * pad;
    const keys = keyLayout(keysW).map((k) => ({ ...k, x: k.x + pad }));
    const keyH = Math.min(H * 0.6, Math.min(H * 0.24, (keysW / 52) * 5.5) * s.keyScale);
    const keyTop = H - keyH - pad;
    const specH = Math.min(70, H * 0.1);
    const specTop = keyTop - specH;
    const rollBottom = specTop - 2;
    const rollTop = 4;

    this.drawRoll(ctx, s, keys, rollTop, rollBottom);
    this.drawSpectrum(ctx, s, keys, specTop, specH);
    this.drawKeys(ctx, s, keys, keyTop, keyH);
  }

  private drawRoll(ctx: CanvasRenderingContext2D, s: PianoState, keys: KeyGeom[],
                   top: number, bottom: number): void {
    const span = bottom - top;
    const yOf = (time: number): number => bottom - ((time - s.t) / s.lookahead) * span;
    // lanes: faint guides for C and F
    for (const k of keys) {
      if (k.black) continue;
      const pc = k.midi % 12;
      if (pc === 0 || pc === 5) {
        ctx.fillStyle = pc === 0 ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.04)";
        ctx.fillRect(k.x, top, 1, span);
      }
    }
    // bar lines with numbers
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    for (const ms of s.measures) {
      if (ms.start_s < s.t || ms.start_s > s.t + s.lookahead) continue;
      const y = yOf(ms.start_s);
      ctx.fillStyle = "rgba(230,192,123,0.35)";
      ctx.fillRect(0, y, ctx.canvas.clientWidth, 1);
      ctx.fillStyle = "#e6c07b";
      ctx.fillText(`m. ${ms.number}${ms.pass_no > 1 ? ` (${ms.pass_no})` : ""}`, 4, y - 1);
    }
    // notes: upcoming ones fall toward the keys; sounding ones touch the "now" line
    const n = s.notes, ix = s.index;
    if (n && ix) {
      const byMidi = new Map(keys.map((k) => [k.midi, k]));
      ctx.lineWidth = 1;
      for (const i of ix.inRange(s.t, s.t + s.lookahead)) {
        const part = n.part[i]!;
        if (!s.visible(part)) continue;
        const k = byMidi.get(Math.round(n.midi[i]!));
        if (!k) continue;
        const y0 = yOf(Math.min(n.offset_s[i]!, s.t + s.lookahead));
        const y1 = yOf(Math.max(n.onset_s[i]!, s.t));
        const inset = k.black ? 0.5 : Math.max(1, k.w * 0.12);
        const color = s.partColor(part);
        const sounding = n.onset_s[i]! <= s.t;
        ctx.globalAlpha = sounding ? 1 : 0.8;
        ctx.fillStyle = color;
        ctx.fillRect(k.x + inset, y0, k.w - 2 * inset, Math.max(2, y1 - y0));
        if (n.f0_ok[i]! < 0.5) {
          ctx.globalAlpha = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = "#fff";
          ctx.strokeRect(k.x + inset + 0.5, y0 + 0.5, k.w - 2 * inset - 1, Math.max(1, y1 - y0 - 1));
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;
    }
    // "now" line
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillRect(0, bottom, ctx.canvas.clientWidth, 1.5);
  }

  private drawSpectrum(ctx: CanvasRenderingContext2D, s: PianoState, keys: KeyGeom[],
                       top: number, h: number): void {
    ctx.fillStyle = "#111318";
    ctx.fillRect(0, top, ctx.canvas.clientWidth, h);
    if (!s.levels) return;
    // draw white-key bars first, then black, so narrow bars stay visible
    for (const pass of [false, true]) {
      for (const k of keys) {
        if (k.black !== pass) continue;
        const v = s.levels[k.midi - KEY0]!;
        if (v <= 0.01) continue;
        const li = Math.min(255, Math.round(40 + v * 215)) * 4;
        ctx.fillStyle = `rgb(${this.specLut[li]},${this.specLut[li + 1]},${this.specLut[li + 2]})`;
        const bh = v * (h - 2);
        ctx.fillRect(k.x + 1, top + h - bh, Math.max(1, k.w - 2), bh);
      }
    }
  }

  private drawKeys(ctx: CanvasRenderingContext2D, s: PianoState, keys: KeyGeom[],
                   top: number, h: number): void {
    const sounding = new Map<number, number[]>(); // midi -> parts
    if (s.notes && s.index) {
      for (const i of s.index.activeAt(s.t)) {
        const part = s.notes.part[i]!;
        if (!s.visible(part)) continue;
        const midi = Math.round(s.notes.midi[i]!);
        const list = sounding.get(midi) ?? [];
        if (!list.includes(part)) list.push(part);
        sounding.set(midi, list);
      }
    }
    const paint = (k: KeyGeom, kh: number): void => {
      const base = k.black ? "#15171b" : "#e8e9ec";
      ctx.fillStyle = base;
      ctx.fillRect(k.x, top, k.w, kh);
      const hv = s.heat ? s.heat[k.midi - KEY0]! : 0;
      if (hv > 0.01) {
        const li = Math.min(255, Math.round(70 + hv * 185)) * 4;
        ctx.globalAlpha = 0.35 + 0.65 * hv;
        ctx.fillStyle = `rgb(${this.heatLut[li]},${this.heatLut[li + 1]},${this.heatLut[li + 2]})`;
        ctx.fillRect(k.x, top, k.w, kh);
        ctx.globalAlpha = 1;
      }
      const parts = sounding.get(k.midi);
      if (parts) {
        // pressed key: lower part of the key in the part colors (split if shared)
        const sw = k.w / parts.length;
        parts.forEach((p, j) => {
          ctx.fillStyle = s.partColor(p);
          ctx.fillRect(k.x + j * sw, top + kh * 0.45, sw, kh * 0.55);
        });
      }
      ctx.strokeStyle = "#0b0c10";
      ctx.lineWidth = 1;
      ctx.strokeRect(k.x + 0.5, top + 0.5, k.w - 1, kh - 1);
    };
    for (const k of keys) if (!k.black) paint(k, h);
    for (const k of keys) if (k.black) paint(k, h * 0.62);
    // C labels
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#555a64";
    for (const k of keys) {
      if (k.midi % 12 === 0) ctx.fillText(midiName(k.midi), k.x + 2, top + h - 3);
    }
    // focused part's range above the keys
    const fp = s.focus !== null ? s.parts[s.focus] : undefined;
    if (fp && fp.range_low !== null && fp.range_high !== null) {
      const at = (m: number): KeyGeom | undefined => keys.find((k) => k.midi === m);
      const bar = (lo: number, hi: number, y: number, alpha: number): void => {
        const a = at(Math.max(KEY0, lo)), b = at(Math.min(KEY0 + N_KEYS - 1, hi));
        if (!a || !b) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.partColor(fp.index);
        ctx.fillRect(a.x, y, b.x + b.w - a.x, 3);
        ctx.globalAlpha = 1;
      };
      bar(fp.range_low, fp.range_high, top - 5, 0.45);
      if (fp.practical_low !== null && fp.practical_high !== null) {
        bar(fp.practical_low, fp.practical_high, top - 5, 1);
      }
      ctx.fillStyle = s.partColor(fp.index);
      ctx.textBaseline = "bottom";
      ctx.fillText(`${fp.name} range`, 4, top - 7);
    }
  }
}
