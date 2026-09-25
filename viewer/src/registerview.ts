// Full-screen register view (Canvas2D). Left: the whole piece, time across, pitch up; per
// group a translucent band over its 10-90 % register span and a line at its centroid.
// Right: "now" — per group, how strongly each semitone sounds in the current window.
// Click the timeline to seek. The timeline is drawn once per data/size change into an
// offscreen canvas; each frame only blits it and draws the playhead and the now panel.

import { KEYS, MIDI0, axisLabel, smoothStats, type AxisMode, type RegisterStats } from "./registers";

export interface RegisterGroup {
  label: string;
  color: string;
}

export interface RegisterData {
  groups: RegisterGroup[];
  grid: Uint8Array; // [group][frame][88]
  frames: number;
  frameSec: number;
  stats: RegisterStats[]; // per frame (the now panel)
  smoothSec: number; // overview smoothing (moving average), 0 = off
  thrU8: number;
  duration: number;
  // optional: [group][frame][88] > 0 where a score note of the group has its fundamental;
  // other levels are drawn as partials (patterned) in the now panel
  fund?: Uint8Array;
  partials?: "stripes" | "dots" | "solid";
  axis?: AxisMode;
}

const AXIS_W = 58;
const PAD = 8;

export class RegisterView {
  private data: RegisterData | null = null;
  private bg: HTMLCanvasElement | null = null;
  private bgKey = "";
  private ctx: CanvasRenderingContext2D;
  private patterns = new Map<string, CanvasPattern>();

  constructor(private canvas: HTMLCanvasElement, onSeek: (s: number) => void) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("click", (e) => {
      const d = this.data;
      if (!d) return;
      const r = canvas.getBoundingClientRect();
      const { x0, x1 } = this.layout(r.width, r.height);
      const x = e.clientX - r.left;
      if (x >= x0 && x <= x1) onSeek(((x - x0) / (x1 - x0)) * d.duration);
    });
  }

  set(d: RegisterData): void {
    this.data = d;
    this.bgKey = "";
  }

  private layout(w: number, h: number): { x0: number; x1: number; nx0: number; nx1: number; top: number; bottom: number } {
    const nowW = Math.min(440, Math.max(160, w * 0.34));
    return { x0: AXIS_W, x1: w - nowW - 2 * PAD, nx0: w - nowW - PAD, nx1: w - PAD, top: PAD + 14, bottom: h - PAD - 74 };
  }

  private yOf(midi: number, top: number, bottom: number): number {
    return top + ((MIDI0 + KEYS - 0.5 - midi) / KEYS) * (bottom - top);
  }

  private drawTimeline(g: CanvasRenderingContext2D, w: number, h: number): void {
    const d = this.data!;
    const L = this.layout(w, h);
    g.fillStyle = "#0b0c10";
    g.fillRect(0, 0, w, h);
    // octave grid + C labels
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let m = 24; m <= 108; m += 12) {
      const y = this.yOf(m, L.top, L.bottom);
      g.fillStyle = "#1c1f27";
      g.fillRect(L.x0, y, L.x1 - L.x0, 1);
      g.fillRect(L.nx0, y, L.nx1 - L.nx0, 1);
      g.fillStyle = "#8a8f98";
      g.fillText(axisLabel(m, d.axis ?? "notes"), 4, y);
    }
    const xOf = (f: number): number => L.x0 + ((f + 0.5) * d.frameSec / d.duration) * (L.x1 - L.x0);
    const radius = Math.round(d.smoothSec / d.frameSec / 2);
    d.stats.map((s) => smoothStats(s, radius)).forEach((st, gi) => {
      const color = d.groups[gi]!.color;
      // bands: one polygon per contiguous sounding run
      g.globalAlpha = 0.22;
      g.fillStyle = color;
      let f = 0;
      while (f < d.frames) {
        while (f < d.frames && Number.isNaN(st.centroid[f]!)) f++;
        const a = f;
        while (f < d.frames && !Number.isNaN(st.centroid[f]!)) f++;
        if (f <= a) continue;
        g.beginPath();
        for (let i = a; i < f; i++) g.lineTo(xOf(i), this.yOf(st.hi[i]! + 0.5, L.top, L.bottom));
        for (let i = f - 1; i >= a; i--) g.lineTo(xOf(i), this.yOf(st.lo[i]! - 0.5, L.top, L.bottom));
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.beginPath();
      let pen = false;
      for (let i = 0; i < d.frames; i++) {
        const c = st.centroid[i]!;
        if (Number.isNaN(c)) { pen = false; continue; }
        const x = xOf(i), y = this.yOf(c, L.top, L.bottom);
        if (pen) g.lineTo(x, y); else g.moveTo(x, y);
        pen = true;
      }
      g.stroke();
    });
    // legend
    let lx = L.x0;
    g.textBaseline = "alphabetic";
    for (const grp of d.groups) {
      g.fillStyle = grp.color;
      g.fillRect(lx, h - 16, 10, 10);
      g.fillStyle = "#c9ccd1";
      g.fillText(grp.label, lx + 14, h - 7);
      lx += 22 + g.measureText(grp.label).width;
      if (lx > L.x1 - 60) break;
    }
  }

  /** Stripes or dots in `color` on transparent (partials in the now panel). */
  private pattern(color: string, style: "stripes" | "dots"): CanvasPattern {
    const key = `${style}|${color}`;
    let p = this.patterns.get(key);
    if (p) return p;
    const c = document.createElement("canvas");
    c.width = c.height = 6;
    const g = c.getContext("2d")!;
    g.fillStyle = color;
    g.strokeStyle = color;
    if (style === "dots") {
      g.beginPath();
      g.arc(3, 3, 1.3, 0, Math.PI * 2);
      g.fill();
    } else {
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-1, 7);
      g.lineTo(7, -1);
      g.moveTo(-1, 1);
      g.lineTo(1, -1);
      g.moveTo(5, 7);
      g.lineTo(7, 5);
      g.stroke();
    }
    p = this.ctx.createPattern(c, "repeat")!;
    this.patterns.set(key, p);
    return p;
  }

  /** Draws the frame for playhead time `t` (seconds). */
  draw(t: number): void {
    const d = this.data;
    const dpr = devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!d) {
      g.fillStyle = "#0b0c10";
      g.fillRect(0, 0, w, h);
      return;
    }
    const key = `${w}x${h}@${dpr}`;
    if (!this.bg || this.bgKey !== key) {
      this.bg ??= document.createElement("canvas");
      this.bg.width = Math.round(w * dpr);
      this.bg.height = Math.round(h * dpr);
      const bg = this.bg.getContext("2d")!;
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawTimeline(bg, w, h);
      this.bgKey = key;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.bg, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = this.layout(w, h);
    // playhead
    const px = L.x0 + (t / d.duration) * (L.x1 - L.x0);
    g.fillStyle = "#ffd23f";
    g.fillRect(px - 0.5, L.top, 1.5, L.bottom - L.top);
    // now panel
    const f = Math.min(d.frames - 1, Math.max(0, Math.floor(t / d.frameSec)));
    const n = d.groups.length;
    const colW = (L.nx1 - L.nx0) / Math.max(1, n);
    const rowH = (L.bottom - L.top) / KEYS;
    const span = 255 - d.thrU8;
    g.font = "10px system-ui, sans-serif";
    d.groups.forEach((grp, gi) => {
      const cx = L.nx0 + gi * colW;
      const o = (gi * d.frames + f) * KEYS;
      const style = d.fund && d.partials !== "solid" ? d.partials ?? "stripes" : "solid";
      const partial = style === "solid" ? null : this.pattern(grp.color, style);
      for (let s = 0; s < KEYS; s++) {
        const v = d.grid[o + s]! - d.thrU8;
        if (v <= 0) continue;
        const y = this.yOf(MIDI0 + s, L.top, L.bottom) - rowH / 2;
        const w = Math.max(1, (v / span) * (colW - 3)), h = Math.max(1, rowH - 0.5);
        const isFund = !partial || d.fund![o + s]! > 0;
        g.fillStyle = isFund ? grp.color : partial;
        g.fillRect(cx + 1, y, w, h);
        if (!isFund && h >= 3) {
          g.strokeStyle = grp.color; // outline keeps short patterned bars readable
          g.lineWidth = 0.75;
          g.strokeRect(cx + 1.5, y + 0.5, w - 1, h - 1);
        }
      }
      const c = d.stats[gi]!.centroid[f]!;
      if (!Number.isNaN(c)) {
        g.fillStyle = "#ffffff";
        g.fillRect(cx, this.yOf(c, L.top, L.bottom) - 1, colW - 1, 2);
      }
      // label, vertical under the column
      g.save();
      g.translate(cx + colW / 2 + 3, L.bottom + 4);
      g.rotate(Math.PI / 2);
      g.fillStyle = "#c9ccd1";
      g.fillText(grp.label.slice(0, 12), 0, 0);
      g.restore();
    });
  }
}
