// Engraved score view. Verovio (LGPL-3.0, bundled wasm) runs in a Web Worker
// (verovio.worker.ts) and is started lazily on first open. Per-frame work (which page,
// which notes sound) is answered locally from the layout result — no worker round trips.

import { bundleUrl, type Manifest } from "./bundle";
import { fetchSameOrigin } from "./net";
import { ScoreClock, SoundingTracker } from "./scoremap";
import type { LayoutOptions, LayoutResult } from "./verovioCore";
import type { ScoreRequest } from "./verovio.worker";

export interface ScoreViewDeps {
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  onSeek: (seconds: number) => void;
  now: () => number;
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
  scale = 38;
  follow = true;
  condense = false;

  constructor(
    private host: HTMLElement,
    private info: HTMLElement,
    private base: string,
    private m: Manifest,
    private deps: ScoreViewDeps,
  ) {
    for (const p of m.score?.parts ?? []) {
      for (let s = 0; s < Math.max(1, p.staves); s++) this.staffToPart.push(p.index);
    }
    host.addEventListener("click", (e) => void this.onClick(e));
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
    const sc = this.m.score;
    if (!sc?.score_file) throw new Error("this bundle has no engraved score (score_file)");
    this.info.textContent = "reading score…";
    const r = await fetchSameOrigin(bundleUrl(this.base, sc.score_file));
    if (!r.ok) throw new Error(`${sc.score_file}: HTTP ${r.status}`);
    const data = sc.score_file.endsWith(".mxl") ? await r.arrayBuffer() : await r.text();
    this.info.textContent = "engraving (in the background)…";
    this.accept(await this.call<LayoutResult>({ op: "load", data, opts: this.opts() }));
    this.info.textContent = "";
  }

  private accept(lay: LayoutResult): void {
    this.lay = lay;
    this.clock = new ScoreClock(this.m.score?.measures ?? [], lay.measures, lay.endMs);
    this.sounding = new SoundingTracker(lay.events);
    this.page = 0;
    this.litKey = "";
  }

  /** Re-layout after a size, zoom or condense change (in the worker). */
  async relayout(): Promise<void> {
    if (!this.lay) return;
    this.info.textContent = "re-engraving…";
    this.accept(await this.call<LayoutResult>({ op: "relayout", opts: this.opts() }));
    this.info.textContent = "";
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
    if (!Number.isFinite(ms)) return;
    const target = this.follow ? this.pageAt(ms) : this.page || 1;
    if (target !== this.page) void this.show(target);
    if (this.rendering) return;
    const ids = this.sounding ? this.sounding.at(ms) : [];
    const key = `${this.page}|${ids.join(",")}`;
    if (key === this.litKey) return;
    this.litKey = key;
    for (const el of this.lit) {
      el.classList.remove("playing");
      el.removeAttribute("fill");
      el.removeAttribute("color");
    }
    this.lit = [];
    for (const id of ids) {
      const el = this.host.querySelector<SVGElement>(`[id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const part = this.partOf(el);
      if (part !== null && !this.deps.visible(part)) continue;
      const color = part === null ? "#e6c07b" : this.deps.partColor(part);
      el.classList.add("playing");
      el.setAttribute("fill", color); // presentation attributes (allowed by the CSP)
      el.setAttribute("color", color);
      this.lit.push(el);
    }
    if (this.follow && this.lit[0]) this.keepVisible(this.lit[0]);
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
