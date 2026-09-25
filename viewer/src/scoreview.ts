// Engraved score view. Verovio (LGPL-3.0, bundled wasm) runs in a Web Worker
// (verovio.worker.ts) and is started lazily on first open. Per-frame work (which page,
// which notes sound) is answered locally from the layout result — no worker round trips.

import { bundleUrl, type Manifest } from "./bundle";
import { fetchSameOrigin } from "./net";
import { ScoreClock, SoundingTracker } from "./scoremap";
import { notatedId, type LayoutOptions, type LayoutResult } from "./verovioCore";
import type { ScoreRequest } from "./verovio.worker";

export interface ScoreViewDeps {
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  onSeek: (seconds: number) => void;
  now: () => number;
}

/** Options for engraving something other than the bundle's score (e.g. a reduction). */
export interface ScoreViewOptions {
  file?: string; // bundle-relative MusicXML (default: score.score_file)
  noteColor?: (id: string) => string | null; // persistent notehead colour
  selectable?: boolean; // click/box selection (double-click seeks)
  onSelect?: (ids: string[]) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Req = ScoreRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export class ScoreView {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private lay: LayoutResult | null = null;
  private clock: ScoreClock | null = null;
  private sounding: SoundingTracker | null = null;
  private page = 0;
  private wantPage = 0;
  private rendering = false;
  private lit: SVGElement[] = [];
  private litKey = "";
  private staffToPart: number[] = []; // staff number n (1-based) -> part, index n-1
  private loading: Promise<void> | null = null;
  // playhead line: onset events (Verovio ms + note ids) and their x on the current page
  private onsets: { ms: number; ids: string[] }[] = [];
  private xCache = new Map<number, number | null>();
  private line = document.createElement("div");
  scale = 38;
  private lastMs: number | null = null; // Verovio time at the last update
  follow = true;
  condense = false;
  active = true; // several views may share a host; only the active one reacts
  // selection (selectable views)
  private selected = new Set<string>();
  private idToEvent = new Map<string, number>();
  private box0: { x: number; y: number } | null = null;
  private boxEl = document.createElement("div");
  private dragged = false;
  private lastSounding: string[] = [];

  constructor(
    private host: HTMLElement,
    private info: HTMLElement,
    private base: string,
    private m: Manifest,
    private deps: ScoreViewDeps,
    private vo: ScoreViewOptions = {},
  ) {
    for (const p of m.score?.parts ?? []) {
      for (let s = 0; s < Math.max(1, p.staves); s++) this.staffToPart.push(p.index);
    }
    this.line.className = "score-line";
    this.line.hidden = true;
    this.boxEl.className = "score-box";
    this.boxEl.hidden = true;
    if (vo.selectable) {
      host.addEventListener("pointerdown", (e) => this.active && this.onDown(e));
      host.addEventListener("pointermove", (e) => this.active && this.onMove(e));
      host.addEventListener("pointerup", (e) => this.active && this.onUp(e));
      host.addEventListener("dblclick", (e) => this.active && void this.onClick(e));
    } else {
      host.addEventListener("click", (e) => this.active && void this.onClick(e));
    }
  }

  /** Force a re-render of the current page (after switching which view owns the host). */
  reset(): void {
    this.page = 0;
    this.litKey = "";
  }

  /** Engrave a small MusicXML snippet (sanitized SVG), independent of this view's score. */
  engrave(xml: string, scale = 36): Promise<string> {
    return this.call<string>({ op: "engrave", xml, scale });
  }

  get soundingIds(): string[] {
    return this.lastSounding;
  }

  get selection(): string[] {
    return [...this.selected];
  }

  clearSelection(): boolean {
    if (!this.selected.size) return false;
    this.selected.clear();
    this.paintSelection();
    this.vo.onSelect?.([]);
    return true;
  }

  private setSelection(ids: string[], add: boolean): void {
    if (!add) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.paintSelection();
    this.vo.onSelect?.(this.selection);
  }

  private paintSelection(): void {
    for (const el of this.host.querySelectorAll("g.note.sel")) el.classList.remove("sel");
    for (const id of this.selected) {
      this.host.querySelector(`[id="${CSS.escape(id)}"]`)?.classList.add("sel");
    }
  }

  private paintColors(): void {
    const f = this.vo.noteColor;
    if (!f) return;
    for (const el of this.host.querySelectorAll<SVGElement>("g.note")) {
      const c = f(el.id);
      if (c) {
        el.setAttribute("fill", c);
        el.setAttribute("color", c);
      }
    }
  }

  /** Re-apply note colours (e.g. after switching section/part colouring). */
  recolor(): void {
    this.paintColors();
    this.litKey = "";
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const h = this.host.getBoundingClientRect();
    return { x: e.clientX - h.left + this.host.scrollLeft, y: e.clientY - h.top + this.host.scrollTop };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.lay) return;
    this.box0 = this.local(e);
    this.dragged = false;
  }

  private onMove(e: PointerEvent): void {
    if (!this.box0) return;
    const p = this.local(e);
    if (!this.dragged && Math.abs(p.x - this.box0.x) + Math.abs(p.y - this.box0.y) < 6) return;
    if (!this.dragged) {
      this.dragged = true;
      this.host.setPointerCapture(e.pointerId);
      this.host.append(this.boxEl);
    }
    const st = this.boxEl.style;
    this.boxEl.hidden = false;
    st.transform = `translate(${Math.min(p.x, this.box0.x)}px, ${Math.min(p.y, this.box0.y)}px)`;
    st.width = `${Math.abs(p.x - this.box0.x)}px`;
    st.height = `${Math.abs(p.y - this.box0.y)}px`;
  }

  private onUp(e: PointerEvent): void {
    const b0 = this.box0;
    this.box0 = null;
    if (!b0) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (this.dragged) {
      this.boxEl.hidden = true;
      const p = this.local(e);
      const [xa, xb] = [Math.min(p.x, b0.x), Math.max(p.x, b0.x)];
      const [ya, yb] = [Math.min(p.y, b0.y), Math.max(p.y, b0.y)];
      const ids: string[] = [];
      for (const el of this.host.querySelectorAll("g.note")) {
        const bx = this.box(el.querySelector(".notehead") ?? el);
        const cx = (bx.left + bx.right) / 2, cy = (bx.top + bx.bottom) / 2;
        if (cx >= xa && cx <= xb && cy >= ya && cy <= yb) ids.push(el.id);
      }
      this.setSelection(ids, add);
      return;
    }
    this.pick(e, add);
  }

  /** Click: a note -> its onset's sonority (Alt: same beat position); a bar -> its notes. */
  private pick(e: MouseEvent, add: boolean): void {
    const lay = this.lay;
    if (!lay) return;
    const note = (e.target as Element).closest("g.note");
    if (note) {
      const ei = this.idToEvent.get(note.id);
      if (ei === undefined) return this.setSelection([note.id], add);
      if (!e.altKey) return this.setSelection(this.onPage(lay.events[ei]!.on ?? []), add);
      const pos = this.barPos(ei); // same beat position within the bar, on this page
      const ids: string[] = [];
      lay.events.forEach((ev, i) => {
        if (ev.on?.length && Math.abs(this.barPos(i) - pos) < 1e-3) ids.push(...this.onPage(ev.on));
      });
      return this.setSelection(ids, add);
    }
    const bar = [...this.host.querySelectorAll("g.measure")].find((m) => {
      const r = m.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (bar) return this.setSelection([...bar.querySelectorAll("g.note")].map((n) => n.id), add);
    if (!add) this.clearSelection();
  }

  private onPage(ids: string[]): string[] {
    return ids.filter((id) => this.host.querySelector(`[id="${CSS.escape(id)}"]`));
  }

  /** Quarter-note position of event i within its bar. */
  private barPos(i: number): number {
    const lay = this.lay!;
    const ev = lay.events[i]!;
    let lo = 0, hi = lay.measures.length - 1, mi = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lay.measures[mid]!.ms <= ev.tstamp) {
        mi = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return (ev.qstamp ?? 0) - (lay.measures[mi]?.q ?? 0);
  }

  private call<T>(req: Req): Promise<T> {
    this.worker ??= this.startWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ ...req, id });
    });
  }

  private startWorker(): Worker {
    const w = new Worker(new URL("./verovio.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<{ id?: number; ok?: boolean; result?: unknown;
      error?: string; progress?: string }>) => {
      if (ev.data.progress !== undefined) {
        this.info.textContent = ev.data.progress;
        return;
      }
      const p = this.pending.get(ev.data.id ?? -1);
      if (!p) return;
      this.pending.delete(ev.data.id!);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
    w.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "score worker failed"));
      this.pending.clear();
    };
    return w;
  }

  private opts(): LayoutOptions {
    return { scale: this.scale, widthPx: this.host.clientWidth, heightPx: this.host.clientHeight,
      condense: this.condense };
  }

  get ready(): boolean {
    return this.lay !== null;
  }

  /** Load the bundle's score into the worker (once). */
  load(): Promise<void> {
    this.loading ??= this.doLoad().catch((e: unknown) => {
      this.loading = null; // allow a retry
      throw e;
    });
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const file = this.vo.file ?? this.m.score?.score_file;
    if (!file) throw new Error("this bundle has no engraved score (score_file)");
    this.info.textContent = "reading score…";
    const r = await fetchSameOrigin(bundleUrl(this.base, file));
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    const data = file.endsWith(".mxl") ? await r.arrayBuffer() : await r.text();
    this.info.textContent = "engraving (in the background)…";
    this.accept(await this.call<LayoutResult>({ op: "load", data, opts: this.opts() }));
    this.info.textContent = "";
  }

  private accept(lay: LayoutResult): void {
    this.lay = lay;
    this.clock = new ScoreClock(this.m.score?.measures ?? [], lay.measures, lay.endMs);
    this.sounding = new SoundingTracker(lay.events);
    this.onsets = lay.events.filter((e) => e.on?.length).map((e) => ({ ms: e.tstamp, ids: e.on! }));
    this.idToEvent.clear();
    lay.events.forEach((e, i) => e.on?.forEach((id) => this.idToEvent.has(id) || this.idToEvent.set(id, i)));
    this.xCache.clear();
    this.page = 0;
    this.litKey = "";
    // sync diagnostics (read by the E2E tests and handy in devtools)
    const d = this.host.dataset;
    d.vrvMeasures = String(lay.measures.length);
    d.anchors = String(this.clock.anchors);
    d.pages = String(lay.pageCount);
  }

  /** Re-layout after a size, zoom or condense change (in the worker). */
  async relayout(): Promise<void> {
    if (!this.lay) return;
    // keep the reader's place: the bar at the playhead, else the first bar on screen
    const anchor = this.lastMs ?? this.lay.measures.find((m) => m.page === this.page)?.ms ?? 0;
    this.info.textContent = "re-engraving…";
    this.accept(await this.call<LayoutResult>({ op: "relayout", opts: this.opts() }));
    this.info.textContent = "";
    await this.show(this.pageAt(anchor));
  }

  pageLabel(): string {
    return this.lay ? `page ${this.page || "…"} / ${this.lay.pageCount}` : "";
  }

  step(delta: number): void {
    if (!this.lay) return;
    this.follow = false;
    void this.show(Math.min(this.lay.pageCount, Math.max(1, (this.page || 1) + delta)));
  }

  private async show(page: number): Promise<void> {
    this.wantPage = page;
    if (this.rendering || page === this.page || page < 1) return;
    this.rendering = true;
    try {
      while (this.wantPage !== this.page) {
        const p = this.wantPage;
        const svg = await this.call<string>({ op: "render", page: p });
        this.host.innerHTML = svg; // sanitized in the worker (sanitizeSvg)
        this.host.append(this.line); // innerHTML removed it
        this.paintColors();
        this.paintSelection();
        this.xCache.clear();
        this.page = p;
        this.lit = [];
        this.litKey = "";
        this.host.scrollTop = 0;
      }
    } finally {
      this.rendering = false;
    }
  }

  /** Page holding the measure sounding at Verovio time `ms`. */
  private pageAt(ms: number): number {
    const list = this.lay?.measures ?? [];
    let lo = 0, hi = list.length - 1, found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.ms <= ms) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return list[found]?.page ?? 1;
  }

  /** Per animation frame while open. */
  update(t: number): void {
    if (!this.lay || !this.clock) return;
    const ms = this.clock.audioToVrv(t);
    this.lastMs = Number.isFinite(ms) ? ms : null;
    if (!Number.isFinite(ms)) {
      this.host.dataset.state = "no-sync"; // no measure anchors: score and bundle disagree
      return;
    }
    if (this.host.dataset.state !== "sync") this.host.dataset.state = "sync";
    const target = this.follow ? this.pageAt(ms) : this.page || 1;
    if (target !== this.page) void this.show(target);
    this.placeLine(ms);
    if (this.rendering) return;
    const ids = this.sounding ? this.sounding.at(ms) : [];
    this.lastSounding = ids;
    const key = `${this.page}|${ids.join(",")}`;
    if (key === this.litKey) return;
    this.litKey = key;
    const fixed = this.vo.noteColor;
    for (const el of this.lit) {
      el.classList.remove("playing");
      const c = fixed?.(el.id);
      if (c) {
        el.setAttribute("fill", c); // back to its persistent colour
        el.setAttribute("color", c);
      } else {
        el.removeAttribute("fill");
        el.removeAttribute("color");
      }
    }
    this.lit = [];
    for (const id of ids) {
      const el = this.host.querySelector<SVGElement>(`[id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const part = fixed ? null : this.partOf(el);
      if (part !== null && !this.deps.visible(part)) continue;
      const color = fixed ? "#d63c3c" : part === null ? "#e6c07b" : this.deps.partColor(part);
      el.classList.add("playing");
      el.setAttribute("fill", color); // presentation attributes (allowed by the CSP)
      el.setAttribute("color", color);
      this.lit.push(el);
    }
    if (this.follow && this.lit[0]) this.keepVisible(this.lit[0]);
  }

  /** Box of an element in host-content coordinates (stable while scrolling). */
  private box(el: Element): { left: number; top: number; right: number; bottom: number } {
    const r = el.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    const dx = this.host.scrollLeft - h.left, dy = this.host.scrollTop - h.top;
    return { left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy };
  }

  /** x of onset event i on this page: left edge of its first notehead, or null. */
  private xOf(i: number): number | null {
    let x = this.xCache.get(i);
    if (x !== undefined) return x;
    x = null;
    for (const id of this.onsets[i]?.ids ?? []) {
      const el = this.host.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!el) continue;
      x = this.box(el.querySelector(".notehead") ?? el).left;
      break;
    }
    this.xCache.set(i, x);
    return x;
  }

  /**
   * Vertical playhead through the current system: interpolated between the engraved
   * positions of the surrounding note onsets (so it follows the score's own spacing),
   * falling back to the bar's width when the next onset is on another system or page.
   */
  private placeLine(ms: number): void {
    const lay = this.lay;
    const hide = (): void => void (this.line.hidden = true);
    if (!lay || this.rendering) return hide();
    const ms0 = lay.measures;
    let lo = 0, hi = ms0.length - 1, mi = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ms0[mid]!.ms <= ms) {
        mi = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const meas = ms0[mi];
    if (!meas || meas.page !== this.page) return hide();
    const mel = this.host.querySelector(`[id="${CSS.escape(notatedId(meas.id))}"]`);
    if (!mel) return hide();
    const mb = this.box(mel);
    const mEnd = ms0[mi + 1]?.ms ?? lay.endMs;
    let x = mb.left + ((ms - meas.ms) / Math.max(1, mEnd - meas.ms)) * (mb.right - mb.left);
    // onset events around ms
    lo = 0;
    hi = this.onsets.length - 1;
    let ei = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.onsets[mid]!.ms <= ms) {
        ei = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const x0 = ei >= 0 ? this.xOf(ei) : null;
    if (x0 !== null && x0 >= mb.left - 2 && x0 <= mb.right) {
      const t0 = this.onsets[ei]!.ms;
      const t1 = this.onsets[ei + 1]?.ms ?? mEnd;
      let x1 = ei + 1 < this.onsets.length ? this.xOf(ei + 1) : null;
      if (x1 === null || x1 <= x0 || x1 > mb.right + (mb.right - mb.left)) x1 = mb.right; // next system/page
      x = x0 + ((ms - t0) / Math.max(1, t1 - t0)) * (x1 - x0);
    }
    this.line.hidden = false;
    this.line.style.transform = `translate(${x.toFixed(1)}px, ${mb.top.toFixed(1)}px)`;
    this.line.style.height = `${(mb.bottom - mb.top).toFixed(1)}px`;
  }

  /** Part of a note via its staff's MEI @n (data-n), robust to hidden (condensed) staves. */
  private partOf(el: Element): number | null {
    const n = Number(el.closest("g.staff")?.getAttribute("data-n"));
    return Number.isInteger(n) && n >= 1 && n <= this.staffToPart.length ? this.staffToPart[n - 1]! : null;
  }

  private keepVisible(el: Element): void {
    const r = el.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    if (r.top < h.top + 40 || r.bottom > h.bottom - 40) {
      this.host.scrollTop += r.top - h.top - h.height / 3;
    }
  }

  private async onClick(e: MouseEvent): Promise<void> {
    if (!this.lay || !this.clock) return;
    // glyphs are thin outlines: a click near a note, or on empty staff space, lands on the
    // <svg> itself — fall back to the bar whose on-screen box contains the point
    let target = (e.target as Element).closest("g.note, g.chord, g.rest, g.measure");
    if (!target) {
      target = [...this.host.querySelectorAll("g.measure")].find((m) => {
        const r = m.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }) ?? null;
    }
    if (!target?.id) return;
    const times = await this.call<number[]>({ op: "times", element: target.id });
    // +2 ms: Verovio rounds element times down (bar 5 at 10666 vs 10667 in its own timemap),
    // which would land a bar-start seek at the end of the previous bar
    const cands = times.map((ms) => this.clock!.vrvToAudio(ms + 2)).filter(Number.isFinite);
    if (!cands.length) return;
    const now = this.deps.now();
    cands.sort((a, b) => Math.abs(a - now) - Math.abs(b - now)); // repeat pass nearest now
    this.deps.onSeek(cands[0]!);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
