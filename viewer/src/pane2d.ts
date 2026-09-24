// Linked 2D CQT pane (Canvas2D, not a second WebGL context) with a MIDI / pitch-name axis,
// and the LUFS overview strip. Both are click-to-seek.

import { midiName, u8ToDb, type Manifest } from "./bundle";

export const AXIS_W = 44;

export class Pane2D {
  private page: HTMLCanvasElement = document.createElement("canvas");
  private pageStart = 0;
  private winStart = 0;
  private winFrames = 1;
  private level = 0;
  private playFrame = -1;
  private hover: { x: number; y: number } | null = null;
  private pageData: Uint8Array | null = null;
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
    return this.canvas.clientWidth - AXIS_W;
  }

  private xToSeconds(x: number): number | null {
    if (x < AXIS_W) return null;
    const f = this.winStart + ((x - AXIS_W) / this.plotW) * this.winFrames;
    return (f * this.m.hop * 2 ** this.level) / this.m.sr;
  }

  private yToBin(y: number): number {
    return (1 - y / this.canvas.clientHeight) * this.m.n_bins - 0.5;
  }

  /** Colors a page once (frame-major u8 -> image with time on x, high pitch on top). */
  setPage(data: Uint8Array, frames: number, pageStart: number, level: number, lut: Uint8Array,
          dominant: Uint8Array | null, palette: Uint8Array | null): void {
    const nb = this.m.n_bins;
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
      ctx.drawImage(this.page, sx, 0, this.winFrames, this.m.n_bins, AXIS_W, 0, this.plotW, h);
    }
    // pitch axis: every C, plus A0 and C8 bounds
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const k = this.m.bins_per_octave / 12;
    for (let midi = 24; midi <= 108; midi += 12) {
      const b = (midi - this.m.fmin_midi) * k;
      const y = h * (1 - (b + 0.5) / this.m.n_bins);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(AXIS_W, Math.round(y), this.plotW, 1);
      ctx.fillStyle = "#aab";
      ctx.fillText(`${midiName(midi)} ${midi}`, 2, y);
    }
    // playhead
    const u = (this.playFrame - this.winStart) / this.winFrames;
    if (u >= 0 && u <= 1) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(AXIS_W + u * this.plotW, 0, 1.5, h);
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
    const frame = Math.floor(this.winStart + ((this.hover.x - AXIS_W) / this.plotW) * this.winFrames);
    const rel = frame - this.pageStart;
    const nb = this.m.n_bins;
    if (bin < 0 || bin >= nb || rel < 0 || rel * nb >= this.pageData.length) return;
    const midi = this.m.fmin_midi + bin / (this.m.bins_per_octave / 12);
    const cents = Math.round((midi - Math.round(midi)) * 100);
    const db = u8ToDb(this.m, this.pageData[rel * nb + bin]!);
    this.tooltip.hidden = false;
    this.tooltip.textContent = `${t.toFixed(2)} s · ${midiName(midi)}${cents ? (cents > 0 ? "+" : "") + cents + "¢" : ""} (MIDI ${midi.toFixed(2)}) · ${db.toFixed(1)} dB`;
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
