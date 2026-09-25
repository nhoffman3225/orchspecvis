// Tutti view (Canvas2D): all sounding notes reduced onto a grand staff — or one grand
// staff per section (a short score) — scrolling with the playhead, with a keyboard strip
// underneath. For proofreading doublings and voicing:
//   click a note         -> the vertical sonority at that onset
//   Alt+click            -> every note in view on the same beat position of the bar
//   drag                 -> box selection;  Shift/Ctrl adds to the selection
//   double-click         -> seek;  wheel -> time zoom;  Shift+wheel -> pan (follow off)
// Selected notes are outlined on the staff and lit on the keyboard; the summary goes to
// deps.onSelect. Pure helpers are in tutti.ts.

import type { NotesTable, ScoreMeasure, ScorePart } from "./bundle";
import type { NoteIndex } from "./notes";
import { keyLayout } from "./piano";
import { FAMILIES, familyOf, type Family } from "./registers";
import {
  BASS_LINES, MIDDLE_C_STEP, TREBLE_LINES, chordOf, ledgerSteps, preferFlats, sameGrid, spell,
  staffStep, summarize, type SelectionSummary,
} from "./tutti";

export interface TuttiDeps {
  notes: NotesTable;
  index: NoteIndex;
  parts: ScorePart[];
  measures: ScoreMeasure[];
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  onSeek: (seconds: number) => void;
  onSelect: (summary: SelectionSummary | null, selected: number[]) => void;
}

interface Head {
  i: number;
  x: number;
  y: number;
}

const LEFT = 64; // clef + label gutter
const RIGHT = 12;
const KB_H = 84;
const INK = "#c9ccd1";
const STAFF = "#3a3f4b";

export class TuttiView {
  windowSec = 8;
  mode: "grand" | "sections" = "grand";
  follow = true;
  readonly flats: boolean;
  private ctx: CanvasRenderingContext2D;
  private selected = new Set<number>();
  private heads: Head[] = [];
  private gap = 10;
  private start = 0; // window start (seconds) when not following
  private lastT0 = 0;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private partFamily: Family[];

  constructor(private canvas: HTMLCanvasElement, private deps: TuttiDeps) {
    this.ctx = canvas.getContext("2d")!;
    this.flats = preferFlats(deps.notes.midi);
    this.partFamily = deps.parts.map((p) => familyOf(p.instrument || p.name));
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("dblclick", (e) => {
      const x = this.local(e).x;
      const w = canvas.clientWidth - LEFT - RIGHT;
      deps.onSeek(Math.max(0, this.lastT0 + ((x - LEFT) / w) * this.windowSec));
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.shiftKey && !this.follow) {
        this.start += (e.deltaY > 0 ? 0.15 : -0.15) * this.windowSec;
      } else {
        this.windowSec = Math.min(60, Math.max(2, this.windowSec * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
      }
    }, { passive: false });
  }

  get selection(): number[] {
    return [...this.selected];
  }

  clearSelection(): boolean {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.emit();
    return true;
  }

  /** Select notes by index (e.g. from a URL or a test). */
  select(indices: number[], add = false): void {
    if (!add) this.selected.clear();
    for (const i of indices) this.selected.add(i);
    this.emit();
  }

  private emit(): void {
    const sel = this.selection;
    this.deps.onSelect(sel.length ? summarize(this.deps.notes, sel, this.flats) : null, sel);
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.local(e);
    if (p.y > this.canvas.clientHeight - KB_H) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.local(e);
    this.drag.x1 = p.x;
    this.drag.y1 = p.y;
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) < 5) {
      // click: nearest notehead
      let best: Head | null = null;
      let bd = (this.gap * 1.3) ** 2;
      for (const h of this.heads) {
        const dd = (h.x - d.x0) ** 2 + (h.y - d.y0) ** 2;
        if (dd < bd) {
          bd = dd;
          best = h;
        }
      }
      if (!best) {
        if (!add) this.clearSelection();
        return;
      }
      const inView = this.heads.map((h) => h.i);
      const pick = e.altKey ? sameGrid(this.deps.notes, inView, best.i) : chordOf(this.deps.notes, inView, best.i);
      this.select(pick, add);
      return;
    }
    const [xa, xb] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
    const [ya, yb] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
    this.select(this.heads.filter((h) => h.x >= xa && h.x <= xb && h.y >= ya && h.y <= yb).map((h) => h.i), add);
  }

  /** Staff blocks: one grand staff, or one per section present among visible parts. */
  private groups(): { label: string; parts: Set<number> }[] {
    const vis = this.deps.parts.map((p) => p.index).filter((p) => this.deps.visible(p));
    if (this.mode === "grand") return [{ label: "tutti", parts: new Set(vis) }];
    return FAMILIES.map((f) => ({ label: f, parts: new Set(vis.filter((p) => this.partFamily[p] === f)) }))
      .filter((g) => g.parts.size);
  }

  draw(t: number): void {
    const dpr = devicePixelRatio || 1;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0b0c10";
    g.fillRect(0, 0, w, h);
    const { notes, index } = this.deps;
    if (this.follow) this.start = t - 0.25 * this.windowSec;
    const t0 = (this.lastT0 = this.start), t1 = t0 + this.windowSec;
    const xw = w - LEFT - RIGHT;
    const xOf = (s: number): number => LEFT + ((s - t0) / this.windowSec) * xw;
    const groups = this.groups();
    const staffH = h - KB_H - 8;
    const blockH = staffH / Math.max(1, groups.length);
    // steps 10..46 (E1..E6 region) fit a block; outside notes get ledger lines, clipped
    const gap = (this.gap = Math.max(4, Math.min(18, blockH / 26)));
    const split = gap * 3; // extra space between treble and bass staves (middle C: treble side)
    const inView = index.inRange(t0, t1);
    const heads: Head[] = [];
    const selKeys = new Map<number, number>(); // midi -> selected count
    const now = new Map<number, number>(); // midi -> part sounding at t (last wins)
    g.save();
    g.beginPath();
    g.rect(0, 0, w, staffH);
    g.clip();
    groups.forEach((grp, gi) => {
      const mid = gi * blockH + blockH / 2 + gap; // between the staves
      const yOf = (step: number): number =>
        mid - ((step - MIDDLE_C_STEP) * gap) / 2 + (step >= MIDDLE_C_STEP ? -split / 2 : split / 2);
      // staves
      g.strokeStyle = STAFF;
      g.lineWidth = 1;
      for (const s of [...TREBLE_LINES, ...BASS_LINES]) {
        g.beginPath();
        g.moveTo(LEFT - 40, Math.round(yOf(s)) + 0.5);
        g.lineTo(w - RIGHT, Math.round(yOf(s)) + 0.5);
        g.stroke();
      }
      g.fillStyle = INK;
      g.font = `${gap * 4.2}px "Segoe UI Symbol", "Noto Music", serif`;
      g.textBaseline = "alphabetic";
      g.fillText("𝄞", LEFT - 38, yOf(30) + gap * 0.6);
      g.font = `${gap * 3.2}px "Segoe UI Symbol", "Noto Music", serif`;
      g.fillText("𝄢", LEFT - 38, yOf(26) + gap * 1.9);
      g.font = "11px system-ui, sans-serif";
      g.fillStyle = "#8a8f98";
      g.fillText(grp.label, 6, gi * blockH + 14);
      const top = yOf(38), bottom = yOf(18);
      // bars and beats
      for (const m of this.deps.measures) {
        if (m.end_s < t0 || m.start_s > t1) continue;
        const beats = Math.max(1, m.beats);
        for (let b = 1; b < beats; b++) {
          const x = xOf(m.start_s + ((m.end_s - m.start_s) * b) / beats);
          g.strokeStyle = "#1f232b";
          g.beginPath();
          g.moveTo(x, top);
          g.lineTo(x, bottom);
          g.stroke();
        }
        const x = Math.round(xOf(m.start_s)) + 0.5;
        g.strokeStyle = "#59606d";
        g.beginPath();
        g.moveTo(x, top);
        g.lineTo(x, bottom);
        g.stroke();
        g.fillStyle = "#8a8f98";
        g.fillText(m.number, x + 3, top - gap * 1.2);
      }
      // notes: duration bars first, heads on top
      const mine = inView.filter((i) => grp.parts.has(notes.part[i]!));
      const stack = new Map<string, number>();
      for (const i of mine) {
        const s = spell(notes.midi[i]!, this.flats);
        const y = yOf(staffStep(s));
        const xa = xOf(notes.onset_s[i]!), xb = xOf(notes.offset_s[i]!);
        g.globalAlpha = 0.28;
        g.fillStyle = this.deps.partColor(notes.part[i]!);
        g.fillRect(xa, y - gap * 0.22, Math.max(1, xb - xa), gap * 0.44);
        g.globalAlpha = 1;
        const key = `${Math.round(notes.onset_s[i]! * 50)}:${Math.round(notes.midi[i]!)}`;
        stack.set(key, (stack.get(key) ?? 0) + 1);
      }
      const drawn = new Set<string>();
      for (const i of mine) {
        const midi = Math.round(notes.midi[i]!);
        const s = spell(midi, this.flats);
        const step = staffStep(s);
        const y = yOf(step), x = xOf(notes.onset_s[i]!);
        const key = `${Math.round(notes.onset_s[i]! * 50)}:${midi}`;
        const first = !drawn.has(key);
        drawn.add(key);
        g.strokeStyle = STAFF;
        for (const ls of ledgerSteps(step)) {
          g.beginPath();
          g.moveTo(x - gap * 1.1, yOf(ls));
          g.lineTo(x + gap * 1.1, yOf(ls));
          g.stroke();
        }
        if (first && s.acc) {
          g.fillStyle = INK;
          g.font = `${gap * 1.6}px "Segoe UI Symbol", serif`;
          g.fillText(s.acc > 0 ? "♯" : "♭", x - gap * 1.9, y + gap * 0.5);
        }
        g.fillStyle = this.deps.partColor(notes.part[i]!);
        g.beginPath();
        g.ellipse(x, y, gap * 0.62, gap * 0.45, -0.35, 0, Math.PI * 2);
        g.fill();
        const sel = this.selected.has(i);
        if (sel) {
          g.strokeStyle = "#ffffff";
          g.lineWidth = 2;
          g.stroke();
          g.lineWidth = 1;
          selKeys.set(midi, (selKeys.get(midi) ?? 0) + 1);
        }
        const n = stack.get(key)!;
        if (first && n > 1) {
          g.fillStyle = "#ffd23f";
          g.font = "10px system-ui, sans-serif";
          g.fillText(`×${n}`, x + gap * 0.8, y - gap * 0.5);
        }
        heads.push({ i, x, y });
        if (notes.onset_s[i]! <= t && notes.offset_s[i]! > t) now.set(midi, notes.part[i]!);
      }
    });
    g.restore();
    // selected notes outside the view still light the keyboard
    for (const i of this.selected) {
      const midi = Math.round(notes.midi[i]!);
      if (!heads.some((hh) => hh.i === i)) selKeys.set(midi, (selKeys.get(midi) ?? 0) + 1);
    }
    this.heads = heads;
    // playhead
    const px = xOf(t);
    if (px >= LEFT && px <= w - RIGHT) {
      g.fillStyle = "rgba(214, 60, 60, 0.9)";
      g.fillRect(px - 1, 0, 2, staffH);
    }
    // box selection
    if (this.drag) {
      const d = this.drag;
      g.strokeStyle = "#ffd23f";
      g.setLineDash([4, 3]);
      g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
    }
    this.drawKeyboard(w, h - KB_H, KB_H, now, selKeys);
  }

  private drawKeyboard(w: number, y0: number, kh: number, now: Map<number, number>,
                       sel: Map<number, number>): void {
    const g = this.ctx;
    const keys = keyLayout(w);
    for (const black of [false, true]) {
      for (const k of keys) {
        if (k.black !== black) continue;
        const kh2 = black ? kh * 0.6 : kh;
        const part = now.get(k.midi);
        g.fillStyle = sel.has(k.midi) ? "#ffd23f"
          : part !== undefined ? this.deps.partColor(part) : black ? "#15171c" : "#d8d9dd";
        g.fillRect(k.x + 0.5, y0, k.w - 1, kh2);
        if (!black) {
          g.strokeStyle = "#0b0c10";
          g.strokeRect(k.x + 0.5, y0, k.w - 1, kh2);
        }
        const n = sel.get(k.midi);
        if (n) {
          g.fillStyle = "#0b0c10";
          g.font = "bold 10px system-ui, sans-serif";
          g.textAlign = "center";
          g.fillText(String(n), k.x + k.w / 2, y0 + kh2 - 6);
          g.textAlign = "start";
        }
      }
    }
  }
}
