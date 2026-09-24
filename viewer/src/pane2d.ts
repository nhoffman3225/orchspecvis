// Linked 2D CQT pane (Canvas2D, not a second WebGL context) with a MIDI / pitch-name axis,
// and the LUFS overview strip. Both are click-to-seek.

import { midiName, u8ToDb, type Manifest, type NotesTable, type ScorePart } from "./bundle";
import { frameSpans } from "./gaps";
import { NoteIndex, measureAt } from "./notes";

export const AXIS_W = 44;
/** 2D pane gutter: pitch labels | range bar | 88-key keyboard. */
export const PANE_AXIS_W = 84;
const KEY_X = 42;
const BLACK = new Set([1, 3, 6, 8, 10]);

export interface ScoreOverlay {
  notes: NotesTable;
  index: NoteIndex;
  parts: ScorePart[];
  measures: import("./bundle").ScoreMeasure[];
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  focus: number | null;
  showNotes: boolean;
}

export class Pane2D {
  private page: HTMLCanvasElement = document.createElement("canvas");
  private pageStart = 0;
  private winStart = 0;
  private winFrames = 1;
  private level = 0;
  private playFrame = -1;
  private hover: { x: number; y: number } | null = null;
  private pageData: Uint8Array | null = null;
  private playSec = 0;
  score: ScoreOverlay | null = null;
  onSeek: (seconds: number) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement,
    private m: Manifest,
    private tooltip: HTMLElement,
  ) {
    canvas.addEventListener("click", (e) => {
      const t = this.xToSeconds(e.offsetX);
      if (t !== null) this.onSeek(t);
    });
    canvas.addEventListener("mousemove", (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.updateTooltip();
    });
    canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.tooltip.hidden = true;
    });
  }

  private get plotW(): number {
    return this.canvas.clientWidth - PANE_AXIS_W;
  }

  private xToSeconds(x: number): number | null {
    if (x < PANE_AXIS_W) return null;
    const f = this.winStart + ((x - PANE_AXIS_W) / this.plotW) * this.winFrames;
    return (f * this.m.hop * 2 ** this.level) / this.m.sr;
  }

  private yToBin(y: number): number {
    return (1 - y / this.canvas.clientHeight) * this.m.n_bins - 0.5;
  }

  /** Colors a page once (frame-major u8 -> image with time on x, high pitch on top). */
  setPage(data: Uint8Array, frames: number, pageStart: number, level: number, lut: Uint8Array,
          dominant: Uint8Array | null, palette: Uint8Array | null, gapThr = -1): void {
    const nb = this.m.n_bins;
    const spans = gapThr >= 0 ? frameSpans(data, nb, frames, gapThr) : null;
    this.page.width = frames;
    this.page.height = nb;
    const ctx = this.page.getContext("2d")!;
    const img = ctx.createImageData(frames, nb);
    const px = img.data;
    for (let f = 0; f < frames; f++) {
      for (let b = 0; b < nb; b++) {
        const v = data[f * nb + b]!;
        const o = ((nb - 1 - b) * frames + f) * 4;
        if (dominant && palette) {
          const i = dominant[f * nb + b]! * 4;
          const s = 0.25 + (0.95 * v) / 255;
          px[o] = palette[i]! * s;
          px[o + 1] = palette[i + 1]! * s;
          px[o + 2] = palette[i + 2]! * s;
        } else {
          px[o] = lut[v * 4]!;
          px[o + 1] = lut[v * 4 + 1]!;
          px[o + 2] = lut[v * 4 + 2]!;
        }
        if (spans) {
          const lo = spans[f * 2]!, hi = spans[f * 2 + 1]!;
          if (lo >= 0 && b > lo && b < hi && v <= gapThr) {
            px[o] = px[o]! * 0.35 + 40;
            px[o + 1] = px[o + 1]! * 0.35 + 110;
            px[o + 2] = px[o + 2]! * 0.35 + 230;
          }
        }
        px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.pageData = data;
    this.pageStart = pageStart;
    this.level = level;
    this.draw();
  }

  setWindow(start: number, frames: number, level: number): void {
    this.winStart = start;
    this.winFrames = frames;
    this.level = level;
  }

  setPlayhead(frame: number): void {
    this.playFrame = frame;
    this.playSec = (frame * this.m.hop * 2 ** this.level) / this.m.sr;
  }

  private get frameSec(): number {
    return (this.m.hop * 2 ** this.level) / this.m.sr;
  }

  private midiToY(midi: number, h: number): number {
    const b = (midi - this.m.fmin_midi) * (this.m.bins_per_octave / 12);
    return h * (1 - (b + 0.5) / this.m.n_bins);
  }

  private drawNotes(ctx: CanvasRenderingContext2D, h: number): void {
    const sc = this.score;
    if (!sc || !sc.showNotes) return;
    const t0 = this.winStart * this.frameSec;
    const t1 = (this.winStart + this.winFrames) * this.frameSec;
    const xOf = (t: number): number => PANE_AXIS_W + ((t - t0) / (t1 - t0)) * this.plotW;
    const rowH = (h / this.m.n_bins) * (this.m.bins_per_octave / 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PANE_AXIS_W, 0, this.plotW, h);
    ctx.clip();
    ctx.lineWidth = 1.2;
    for (const i of sc.index.inRange(t0, t1)) {
      const part = sc.notes.part[i]!;
      if (!sc.visible(part)) continue;
      const x0 = xOf(sc.notes.onset_s[i]!), x1 = xOf(sc.notes.offset_s[i]!);
      const y = this.midiToY(sc.notes.midi[i]!, h);
      ctx.strokeStyle = sc.partColor(part);
      ctx.setLineDash(sc.notes.f0_ok[i]! > 0.5 ? [] : [3, 3]); // dashed: weak fundamental
      ctx.strokeRect(x0 + 0.5, y - rowH / 2, Math.max(2, x1 - x0 - 1), rowH);
    }
    ctx.restore();
  }

  private drawKeyboard(ctx: CanvasRenderingContext2D, h: number): void {
    const x0 = KEY_X, w = PANE_AXIS_W - KEY_X - 2;
    const rowH = (h / this.m.n_bins) * (this.m.bins_per_octave / 12);
    for (let midi = 21; midi <= 108; midi++) {
      const y = this.midiToY(midi, h) - rowH / 2;
      const black = BLACK.has(midi % 12);
      ctx.fillStyle = black ? "#1b1d22" : "#c9ccd3";
      ctx.fillRect(x0, y, black ? w * 0.62 : w, rowH);
      if (!black && (midi % 12 === 0 || midi % 12 === 5)) {
        ctx.fillStyle = "#6b6f78"; // B|C and E|F boundaries
        ctx.fillRect(x0, y + rowH - 0.5, w, 0.5);
      }
    }
    const sc = this.score;
    if (!sc) return;
    // sounding notes at the playhead
    for (const i of sc.index.activeAt(this.playSec)) {
      const part = sc.notes.part[i]!;
      if (!sc.visible(part)) continue;
      const y = this.midiToY(Math.round(sc.notes.midi[i]!), h) - rowH / 2;
      ctx.fillStyle = sc.partColor(part);
      ctx.fillRect(x0, y, w, rowH);
    }
    // range bar of the focused part (full range dim, practical range bright)
    const fp = sc.focus !== null ? sc.parts[sc.focus] : undefined;
    if (fp && fp.range_low !== null && fp.range_high !== null) {
      const bar = (lo: number, hi: number, alpha: number): void => {
        const yTop = this.midiToY(hi, h) - rowH / 2, yBot = this.midiToY(lo, h) + rowH / 2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = sc.partColor(fp.index);
        ctx.fillRect(KEY_X - 6, yTop, 4, yBot - yTop);
        ctx.globalAlpha = 1;
      };
      bar(fp.range_low, fp.range_high, 0.45);
      if (fp.practical_low !== null && fp.practical_high !== null) bar(fp.practical_low, fp.practical_high, 1);
    }
  }

  draw(): void {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = this.winFrames < this.plotW;
    const sx = this.winStart - this.pageStart;
    if (this.page.width > 0) {
      ctx.drawImage(this.page, sx, 0, this.winFrames, this.m.n_bins, PANE_AXIS_W, 0, this.plotW, h);
    }
    this.drawNotes(ctx, h);
    ctx.fillStyle = "#0e0f13";
    ctx.fillRect(0, 0, PANE_AXIS_W, h);
    this.drawKeyboard(ctx, h);
    // pitch axis: every C, plus A0 and C8 bounds
    ctx.font = "9px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const k = this.m.bins_per_octave / 12;
    for (let midi = 24; midi <= 108; midi += 12) {
      const b = (midi - this.m.fmin_midi) * k;
      const y = h * (1 - (b + 0.5) / this.m.n_bins);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(PANE_AXIS_W, Math.round(y), this.plotW, 1);
      ctx.fillStyle = "#aab";
      ctx.fillText(`${midiName(midi)}·${midi}`, 1, y);
    }
    // playhead
    const u = (this.playFrame - this.winStart) / this.winFrames;
    if (u >= 0 && u <= 1) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(PANE_AXIS_W + u * this.plotW, 0, 1.5, h);
    }
  }

  private updateTooltip(): void {
    if (!this.hover || !this.pageData) return;
    const t = this.xToSeconds(this.hover.x);
    if (t === null) {
      this.tooltip.hidden = true;
      return;
    }
    const bin = Math.round(this.yToBin(this.hover.y));
    const frame = Math.floor(this.winStart + ((this.hover.x - PANE_AXIS_W) / this.plotW) * this.winFrames);
    const rel = frame - this.pageStart;
    const nb = this.m.n_bins;
    if (bin < 0 || bin >= nb || rel < 0 || rel * nb >= this.pageData.length) return;
    const midi = this.m.fmin_midi + bin / (this.m.bins_per_octave / 12);
    const cents = Math.round((midi - Math.round(midi)) * 100);
    const db = u8ToDb(this.m, this.pageData[rel * nb + bin]!);
    this.tooltip.hidden = false;
    let text = `${t.toFixed(2)} s · ${midiName(midi)}${cents ? (cents > 0 ? "+" : "") + cents + "¢" : ""} (MIDI ${midi.toFixed(2)}) · ${db.toFixed(1)} dB`;
    const sc = this.score;
    if (sc) {
      const bb = measureAt(sc.measures, t);
      if (bb) text += ` · m. ${bb.number}${bb.pass > 1 ? ` (pass ${bb.pass})` : ""} beat ${bb.beat.toFixed(1)}`;
      const hit = sc.index.activeAt(t).filter((i) => sc.visible(sc.notes.part[i]!) && Math.abs(sc.notes.midi[i]! - midi) < 0.6);
      for (const i of hit.slice(0, 3)) {
        const p = sc.parts[sc.notes.part[i]!];
        const weak = sc.notes.f0_ok[i]! > 0.5 ? "" : " (weak fundamental)";
        text += `\n${p?.name ?? "?"}: ${midiName(sc.notes.midi[i]!)} · f0 ${sc.notes.f0_db[i]!.toFixed(1)} dB${weak}`;
      }
    }
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${this.hover.x + 12}px`;
    this.tooltip.style.top = `${this.hover.y - 24}px`;
  }
}

export class LufsStrip {
  private lufs: Float32Array | null = null;
  private hop = 0.1;
  onSeek: (seconds: number) => void = () => {};
  private win: [number, number] = [0, 0];
  private play = 0;
  static readonly LO = -60;
  static readonly HI = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private duration: number,
  ) {
    const seek = (e: MouseEvent): void => {
      const x = e.offsetX - AXIS_W;
      if (x >= 0) this.onSeek((x / (canvas.clientWidth - AXIS_W)) * this.duration);
    };
    canvas.addEventListener("mousedown", (e) => {
      seek(e);
      const move = (ev: MouseEvent): void => seek(ev);
      canvas.addEventListener("mousemove", move);
      addEventListener("mouseup", () => canvas.removeEventListener("mousemove", move), { once: true });
    });
  }

  setData(lufs: Float32Array | null, hopSeconds: number): void {
    this.lufs = lufs;
    this.hop = hopSeconds;
  }

  setView(winStart: number, winEnd: number, play: number): void {
    this.win = [winStart, winEnd];
    this.play = play;
  }

  draw(): void {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0c10";
    ctx.fillRect(0, 0, w, h);
    const pw = w - AXIS_W;
    const x = (t: number): number => AXIS_W + (t / this.duration) * pw;
    const y = (l: number): number => h - ((l - LufsStrip.LO) / (LufsStrip.HI - LufsStrip.LO)) * h;
    ctx.fillStyle = "rgba(120,160,255,0.16)";
    ctx.fillRect(x(this.win[0]), 0, Math.max(1, x(this.win[1]) - x(this.win[0])), h);
    ctx.fillStyle = "#aab";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("LUFS-S", 2, 9);
    for (const l of [-20, -40]) {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(AXIS_W, Math.round(y(l)), pw, 1);
      ctx.fillStyle = "#778";
      ctx.fillText(String(l), 18, y(l));
    }
    if (this.lufs) {
      ctx.strokeStyle = "#8fd3ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const n = this.lufs.length;
      const step = Math.max(1, Math.floor(n / pw));
      for (let i = 0; i < n; i += step) {
        let v = -Infinity;
        for (let j = i; j < Math.min(n, i + step); j++) v = Math.max(v, this.lufs[j]!);
        const px = x(i * this.hop), py = y(Math.max(LufsStrip.LO, v));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#fff";
    ctx.fillRect(x(this.play), 0, 1.5, h);
  }
}
