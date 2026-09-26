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
import { CHART_ORDER, chartNotes, layoutChart, mixColors, renderChart, type ChartPart } from "./orchchart";
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
  split?: boolean;
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
  private split = false; // doubled pitches: split (each section's colour) or mixed
  private bubbleBox: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private bubbleChords: string[][] = []; // the selection, one entry per chord
  private bubblePage = 0; // the chord shown when they do not all fit

  constructor(private d: TuttiDeps) {
    this.reductions = (d.m.score?.reductions ?? []).filter((r) => r.mode in TUTTI_LABELS);
    this.color = d.color === "part" ? "part" : "section";
    if (!this.available) return;
    const tm = this.modeSel;
    tm.replaceChildren(...this.reductions.map((r) => new Option(TUTTI_LABELS[r.mode]!, r.mode)));
    // default: one chord per beat (when the bundle has it), else the first reduction
    const has = (mode: string | null | undefined): boolean => this.reductions.some((r) => r.mode === mode);
    tm.value = has(d.mode) ? d.mode! : has("beat-chords") ? "beat-chords" : this.reductions[0]!.mode;
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
    const sp = $<HTMLInputElement>("tutti-split");
    sp.checked = this.split = d.split === true;
    sp.addEventListener("change", () => {
      this.split = sp.checked;
      for (const v of this.views.values()) v.recolor();
      if (this.tv) void this.showCondensed(this.tv.selection);
      if (this.bubbleBox) this.renderBubble(); // same chords and page, re-drawn
    });
    $("tutti-bubble-close").addEventListener("click", () => this.hideBubble());
    $("tutti-bubble-prev").addEventListener("click", () => this.turn(-1));
    $("tutti-bubble-next").addEventListener("click", () => this.turn(1));
    // ← / → page the chords while the pop-up shows one at a time (before playback seeks)
    addEventListener("keydown", (e) => {
      if ($("tutti-bubble").hidden || $("tutti-bubble-nav").hidden) return;
      if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.turn(e.code === "ArrowLeft" ? -1 : 1);
    }, true);
    $("tutti-score").addEventListener("pointerdown", () => this.hideBubble());
    $("tutti-score").addEventListener("scroll", () => this.placeBubble(), { passive: true });
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

  /** Esc: closes the chord pop-up, else clears the selection; false if neither was open. */
  clearSelection(): boolean {
    if (this.hideBubble()) return true;
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

  private familyOfPart(p: number): string {
    const part = this.d.m.score?.parts[p];
    return familyOf(part?.instrument || part?.name || "");
  }

  /** The colours of the parts on one notehead: distinct section (or part) colours, in the
   * charts' order, with how many parts carry each. */
  private shares(ps: number[]): { colors: string[]; weights: number[] } {
    const key = (p: number): string => (this.color === "part" ? String(p) : this.familyOfPart(p));
    const n = new Map<string, number>();
    for (const p of ps) n.set(key(p), (n.get(key(p)) ?? 0) + 1);
    const keys = [...n.keys()].sort((a, b) => CHART_ORDER.indexOf(a) - CHART_ORDER.indexOf(b));
    const colorOfKey = (k: string): string =>
      this.color === "part" ? this.uiColorOf(Number(k)) : FAMILY_COLORS[k as keyof typeof FAMILY_COLORS] ?? "#888888";
    return { colors: keys.map((k) => toHex(colorOfKey(k))), weights: keys.map((k) => n.get(k)!) };
  }

  /** One colour for a pitch: doubled pitches mix their sections' colours, weighted by the
   * number of parts of each (ink on paper). */
  private colorOfParts = (ps: number[]): string => {
    const { colors, weights } = this.shares(ps.length ? ps : [0]);
    return ink(colors.length > 1 ? mixColors(colors, weights) : colors[0]!);
  };

  /** A notehead's fill: mixed, or with "split doublings" one band per section's colour. */
  private noteFill = (ps: number[]): string | string[] => {
    const { colors } = this.shares(ps.length ? ps : [0]);
    return this.split && colors.length > 1 ? colors.map(ink) : this.colorOfParts(ps);
  };

  private chartParts(): ChartPart[] {
    return (this.d.m.score?.parts ?? []).map((p, i) => ({
      name: p.name, abbreviation: p.abbreviation ?? undefined, family: this.familyOfPart(i),
    }));
  }

  /** The chord pop-up (an orchestration chart) beside a box selection. */
  private showBubble(ids: string[], box: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.maps.get(this.tMode) || !ids.length) {
      this.hideBubble();
      return;
    }
    // several chords: portions side by side, or one at a time with ◀ ▶ if they do not fit
    this.bubbleChords = (this.tv?.chords(ids) ?? [ids]).filter((g) => g.length);
    this.bubblePage = 0;
    this.bubbleBox = box;
    this.renderBubble();
  }

  private barNum(bi: number): string {
    return this.d.m.score?.measures.find((x) => x.source_index === bi)?.number ?? String(bi + 1);
  }

  private renderBubble(): void {
    const map = this.maps.get(this.tMode);
    const box = this.bubbleBox;
    if (!map || !box) return;
    const colorOf = (f: string): string => ink(toHex(FAMILY_COLORS[f as keyof typeof FAMILY_COLORS] ?? "#888888"));
    // clefs and accidentals: the SMuFL glyphs the engraved reduction already defines
    const glyph = (code: string): string | null =>
      code ? document.querySelector(`#tutti-score [id^="${code}-"]`)?.id ?? null : null;
    const perBar = new Map<number, number>();
    const panes = this.bubbleChords.map((g) => {
      const notes = chartNotes(g, map);
      const chart = layoutChart(notes, this.chartParts(), colorOf, this.split ? "split" : "mix");
      const bar = map[g[0]!]?.bar ?? -1;
      const nth = (perBar.get(bar) ?? 0) + 1;
      perBar.set(bar, nth);
      const secs = new Set(notes.flatMap((n) => n.parts.map((p) => this.familyOfPart(p))));
      return { chart, bar, nth, pitches: new Set(notes.map((n) => n.midi)).size, secs: secs.size,
        svg: renderChart(chart, "#1b1b1b", glyph) }; // labels escaped
    });
    const several = (bar: number): boolean => (perBar.get(bar) ?? 0) > 1;
    const caption = (p: (typeof panes)[number]): string =>
      `m. ${this.barNum(p.bar)}${several(p.bar) ? ` · chord ${p.nth}` : ""} · ${p.pitches} pitches · ${p.secs} section${p.secs === 1 ? "" : "s"}`;
    const main = $("tutti-bubble").parentElement!;
    const avail = main.clientWidth * 0.95 - 24;
    const total = panes.reduce((w, p) => w + p.chart.width + 14, 0);
    const paged = panes.length > 1 && total > avail;
    this.bubblePage = Math.min(Math.max(0, this.bubblePage), panes.length - 1);
    const shown = paged ? [panes[this.bubblePage]!] : panes;
    const esc = (t: string): string => t.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
    $("tutti-bubble-chart").innerHTML = shown.map((p) =>
      `<figure class="bubble-pane">${panes.length > 1 ? `<figcaption>${esc(caption(p))}</figcaption>` : ""}${p.svg}</figure>`).join("");
    $("tutti-bubble-nav").hidden = !paged;
    $("tutti-bubble-page").textContent = `${this.bubblePage + 1} / ${panes.length}`;
    if (panes.length === 1) {
      $("tutti-bubble-title").textContent = caption(panes[0]!);
    } else {
      const bars = [...new Set(panes.map((p) => p.bar))];
      const range = bars.length === 1 ? `m. ${this.barNum(bars[0]!)}` : `m. ${this.barNum(bars[0]!)}–${this.barNum(bars.at(-1)!)}`;
      $("tutti-bubble-title").textContent = `${range} · ${panes.length} chords`;
    }
    $("tutti-bubble").hidden = false;
    this.placeBubble();
    document.documentElement.dataset.tuttiBubble = String(shown.reduce((n, p) => n + p.chart.heads.length, 0)); // tests
    document.documentElement.dataset.tuttiBubblePanes = `${shown.length}/${panes.length}`;
  }

  /** ◀ ▶: the previous / next chord when they are shown one at a time. */
  private turn(d: number): void {
    const n = this.bubbleChords.length;
    if (n < 2) return;
    this.bubblePage = (this.bubblePage + d + n) % n;
    this.renderBubble();
  }

  /** Beside the selection (right if it fits, else left), its tail at the box's middle. */
  private placeBubble(): void {
    const box = this.bubbleBox;
    const el = $("tutti-bubble");
    if (!box || el.hidden) return;
    const host = $("tutti-score");
    const main = el.parentElement!;
    const ox = host.offsetLeft - host.scrollLeft, oy = host.offsetTop - host.scrollTop;
    const w = el.offsetWidth, h = el.offsetHeight;
    const right = box.x1 + ox + 22;
    const onRight = right + w <= main.clientWidth - 8;
    const x = onRight ? right : Math.max(8, box.x0 + ox - 22 - w);
    const mid = (box.y0 + box.y1) / 2 + oy;
    const y = Math.min(Math.max(8, mid - h / 2), Math.max(8, main.clientHeight - h - 8));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.classList.toggle("tail-left", onRight);
    el.classList.toggle("tail-right", !onRight);
    el.style.setProperty("--tail-y", `${Math.round(Math.min(Math.max(mid - y, 18), h - 18))}px`);
  }

  /** Closes the pop-up; false if it was not open. */
  private hideBubble(): boolean {
    const el = $("tutti-bubble");
    if (el.hidden) return false;
    el.hidden = true;
    this.bubbleBox = null;
    document.documentElement.dataset.tuttiBubble = "0";
    return true;
  }

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
          return n ? this.noteFill(n.parts) : null;
        },
        onSelect: (ids) => void this.showCondensed(ids),
        onBox: (ids, box) => this.showBubble(ids, box),
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
