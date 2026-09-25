// The tutti view (proofreading): the score's engraved reductions (schema v5+, one chord per
// bar or per beat, for all parts or by section) rendered by Verovio. A selection condenses
// into one chord plus its pitch-class set; the keyboard strip shows what sounds now and
// what is selected. Bundles without MusicXML reductions have no tutti view.

import type { Manifest } from "./bundle";
import { bundleUrl } from "./bundle";
import { busy } from "./busy";
import { chordXml, condense, ink, pitchClassSet, scaleXml, toHex, type MapNote } from "./condense";
import { fetchSameOrigin } from "./net";
import { keyLayout } from "./piano";
import { FAMILY_COLORS, familyOf } from "./registers";
import { ScoreView } from "./scoreview";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const TUTTI_LABELS: Record<string, string> = {
  "chords": "One Chord per Bar", "beat-chords": "One Chord per Beat",
  "section-chords": "Per Bar, by Section", "section-beat-chords": "Per Beat, by Section",
};

export interface TuttiDeps {
  m: Manifest;
  base: string;
  partColor: (part: number) => string;
  seek: (s: number) => void;
  now: () => number;
  /** initial mode and colouring (URL parameters) */
  mode?: string | null;
  color?: string | null;
}

export class TuttiPanel {
  /** Full-rhythm reductions (v5-v6 bundles) are not offered: ties and voices made them
   * unreadable. */
  readonly reductions;
  private color: "section" | "part";
  private maps = new Map<string, Record<string, MapNote>>();
  private views = new Map<string, ScoreView>();
  private tv: ScoreView | null = null;
  private tMode = "";
  private selMidis = new Map<number, number>(); // midi -> parts selected (keyboard strip)
  private condenseGen = 0;
  private modeSel = $<HTMLSelectElement>("tutti-mode");

  constructor(private d: TuttiDeps) {
    this.reductions = (d.m.score?.reductions ?? []).filter((r) => r.mode in TUTTI_LABELS);
    this.color = d.color === "part" ? "part" : "section";
    if (!this.available) return;
    const tm = this.modeSel;
    tm.replaceChildren(...this.reductions.map((r) => new Option(TUTTI_LABELS[r.mode]!, r.mode)));
    tm.value = this.reductions.some((r) => r.mode === d.mode) ? d.mode! : this.reductions[0]!.mode;
    tm.addEventListener("change", () => this.run(this.activate(tm.value)));
    const tc = $<HTMLSelectElement>("tutti-color");
    tc.value = this.color;
    tc.addEventListener("change", () => {
      this.color = tc.value as "section" | "part";
      for (const v of this.views.values()) v.recolor();
      if (this.tv) void this.showCondensed(this.tv.selection);
    });
    $("tutti-zoomin").addEventListener("click", () => this.zoom(1.15));
    $("tutti-zoomout").addEventListener("click", () => this.zoom(1 / 1.15));
    $("tutti-score").addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    $<HTMLInputElement>("tutti-follow").addEventListener("change", (e) => {
      if (this.tv) this.tv.follow = (e.target as HTMLInputElement).checked;
    });
  }

  get available(): boolean {
    return this.reductions.length > 0;
  }

  /** Loads the current reduction on first open. */
  opened(): void {
    if (this.available && !this.tv) this.run(this.activate(this.modeSel.value));
  }

  /** Per frame while open: playhead, sounding notes and the keyboard strip. */
  frame(t: number): void {
    this.tv?.update(t);
    this.drawKb();
  }

  relayout(): void {
    if (this.tv) void busy.while("tutti", this.tv.relayout());
  }

  /** Clears the selection; false if there was none. */
  clearSelection(): boolean {
    return this.tv?.clearSelection() ?? false;
  }

  private run(p: Promise<void>): void {
    void busy.while("tutti", p).catch((e: unknown) => {
      $("tutti-info").textContent = `tutti error: ${e instanceof Error ? e.message : String(e)}`;
    });
  }

  private zoom(f: number): void {
    if (!this.tv) return;
    this.tv.scale = Math.min(120, Math.max(10, Math.round(this.tv.scale * f)));
    this.relayout();
  }

  private uiColorOf(p: number): string {
    const part = this.d.m.score?.parts[p];
    return this.color === "part" ? toHex(this.d.partColor(p))
      : FAMILY_COLORS[familyOf(part?.instrument || part?.name || "")];
  }

  private colorOfParts = (ps: number[]): string => ink(this.uiColorOf(ps[0] ?? 0)); // ink on paper

  private partChip(pi: number): HTMLElement {
    const part = this.d.m.score?.parts[pi];
    const chip = document.createElement("span");
    chip.className = "chip";
    const dot = document.createElement("i");
    dot.style.setProperty("--c", this.uiColorOf(pi));
    chip.append(dot, part?.abbreviation || part?.name || `part ${pi + 1}`);
    return chip;
  }

  private selHint(): void {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Click a chord or a bar (Shift/drag for more) to condense it into one chord and its pitch-class set.";
    $("tutti-sel").replaceChildren(p);
    $("tutti-chord").replaceChildren();
    $("tutti-scale").replaceChildren();
  }

  private async showCondensed(ids: string[]): Promise<void> {
    const gen = ++this.condenseGen;
    const map = this.maps.get(this.tMode);
    const tv = this.tv;
    if (!ids.length || !map || !tv) {
      this.selMidis = new Map();
      document.documentElement.dataset.tuttiSel = "0";
      return this.selHint();
    }
    const pitches = condense(ids, map, this.colorOfParts);
    this.selMidis = new Map(pitches.map((p) => [p.midi, p.parts.length]));
    const bars = [...new Set(ids.map((i) => map[i]?.bar).filter((b): b is number => b !== undefined))]
      .sort((x, y) => x - y);
    const barNum = (bi: number): string =>
      this.d.m.score?.measures.find((x) => x.source_index === bi)?.number ?? String(bi + 1);
    const where = !bars.length ? "" : bars.length === 1 ? ` · m. ${barNum(bars[0]!)}`
      : ` · m. ${barNum(bars[0]!)}–${barNum(bars[bars.length - 1]!)}`;
    const partSet = new Set(pitches.flatMap((p) => p.parts));
    const set = pitchClassSet(pitches);
    const [chordSvg, scaleSvg] = await Promise.all([
      tv.engrave(chordXml(pitches), 32),
      tv.engrave(scaleXml(set), 32),
    ]);
    if (gen !== this.condenseGen) return; // a newer selection won
    $("tutti-chord").innerHTML = chordSvg; // sanitized in the worker (sanitizeSvg)
    $("tutti-scale").innerHTML = scaleSvg;
    const h = document.createElement("h3");
    h.textContent = `${pitches.length} pitches · ${set.length} pitch classes · ${partSet.size} parts${where}`;
    const table = document.createElement("table");
    for (const p of [...pitches].reverse()) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.className = "pitch";
      td1.textContent = p.name;
      const td2 = document.createElement("td");
      td2.append(...p.parts.map((pi) => this.partChip(pi)));
      tr.append(td1, td2);
      table.append(tr);
    }
    const pcs = document.createElement("div");
    pcs.className = "pcs";
    pcs.textContent = `set: ${set.map((x) => x.name).join(" ")}`;
    $("tutti-sel").replaceChildren(h, table, pcs);
    document.documentElement.dataset.tuttiSel = String(pitches.length); // tests
  }

  private async activate(mode: string): Promise<void> {
    const red = this.reductions.find((r) => r.mode === mode) ?? this.reductions[0]!;
    if (!this.maps.has(red.mode)) {
      const r = await fetchSameOrigin(bundleUrl(this.d.base, red.map));
      if (!r.ok) throw new Error(`${red.map}: HTTP ${r.status}`);
      this.maps.set(red.mode, ((await r.json()) as { notes: Record<string, MapNote> }).notes);
    }
    let v = this.views.get(red.mode);
    if (!v) {
      v = new ScoreView($("tutti-score"), $("tutti-info"), this.d.base, this.d.m, {
        partColor: this.d.partColor, visible: () => true, onSeek: this.d.seek, now: this.d.now,
      }, {
        file: red.musicxml,
        selectable: true,
        noteColor: (id) => {
          const n = this.maps.get(red.mode)?.[id];
          return n ? this.colorOfParts(n.parts) : null;
        },
        onSelect: (ids) => void this.showCondensed(ids),
      });
      v.scale = 34;
      this.views.set(red.mode, v);
    }
    for (const o of this.views.values()) o.active = o === v;
    this.tv = v;
    this.tMode = red.mode;
    v.follow = $<HTMLInputElement>("tutti-follow").checked;
    v.reset();
    this.selHint();
    await v.load();
  }

  private drawKb(): void {
    const c = $<HTMLCanvasElement>("tutti-kb");
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth, hh = c.clientHeight;
    if (!w || !hh) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(hh * dpr)) c.height = Math.round(hh * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const map = this.maps.get(this.tMode);
    const now = new Map<number, string>();
    for (const id of this.tv?.soundingIds ?? []) {
      const n = map?.[id];
      if (n) now.set(n.midi, this.colorOfParts(n.parts));
    }
    for (const black of [false, true]) {
      for (const k of keyLayout(w)) {
        if (k.black !== black) continue;
        const kh = black ? hh * 0.6 : hh;
        g.fillStyle = this.selMidis.has(k.midi) ? "#ffd23f" : now.get(k.midi) ?? (black ? "#15171c" : "#d8d9dd");
        g.fillRect(k.x + 0.5, 0, k.w - 1, kh);
        if (!black) {
          g.strokeStyle = "#0b0c10";
          g.strokeRect(k.x + 0.5, 0, k.w - 1, kh);
        }
      }
    }
  }
}
