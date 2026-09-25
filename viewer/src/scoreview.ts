// Engraved score view (Verovio, LGPL-3.0, bundled wasm; loaded lazily on first open).
// Follows the playhead page by page, highlights sounding notes in part colours, and seeks
// on click (to the repeat pass nearest the playhead).

import { bundleUrl, type Manifest } from "./bundle";
import { fetchSameOrigin } from "./net";
import { ScoreClock, SoundingTracker, sanitizeSvg, type VrvMeasure } from "./scoremap";
import type { VerovioToolkit } from "verovio/esm";

export interface ScoreViewDeps {
  partColor: (part: number) => string;
  visible: (part: number) => boolean;
  onSeek: (seconds: number) => void;
  now: () => number;
}

export class ScoreView {
  private tk: VerovioToolkit | null = null;
  private clock: ScoreClock | null = null;
  private sounding: SoundingTracker | null = null;
  private page = 0;
  private pageCount = 0;
  private lit: SVGElement[] = [];
  private litKey = "";
  private staffToPart: number[] = [];
  private loading: Promise<void> | null = null;
  scale = 38;
  follow = true;

  constructor(
    private host: HTMLElement,
    private info: HTMLElement,
    private base: string,
    private m: Manifest,
    private deps: ScoreViewDeps,
  ) {
    // staff ordinal (top to bottom in a system) -> part index, from each part's staff count
    for (const p of m.score?.parts ?? []) {
      for (let s = 0; s < Math.max(1, p.staves); s++) this.staffToPart.push(p.index);
    }
    host.addEventListener("click", (e) => this.onClick(e));
  }

  get ready(): boolean {
    return this.tk !== null && this.clock !== null;
  }

  /** Load Verovio and the bundle's score (once). */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const sc = this.m.score;
    if (!sc?.score_file) throw new Error("this bundle has no engraved score (score_file)");
    this.info.textContent = "loading notation engine…";
    const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
      import("verovio/wasm"), import("verovio/esm"),
    ]);
    const tk = new VerovioToolkit(await createVerovioModule());
    this.info.textContent = "reading score…";
    const r = await fetchSameOrigin(bundleUrl(this.base, sc.score_file));
    if (!r.ok) throw new Error(`${sc.score_file}: HTTP ${r.status}`);
    this.applyOptions(tk);
    const ok = sc.score_file.endsWith(".mxl")
      ? tk.loadZipDataBuffer(await r.arrayBuffer())
      : tk.loadData(await r.text());
    if (!ok) throw new Error(`Verovio could not read the score: ${tk.getLog()}`);
    this.tk = tk;
    this.buildClock();
    this.pageCount = tk.getPageCount();
    this.info.textContent = "";
  }

  private applyOptions(tk: VerovioToolkit): void {
    const w = Math.max(400, this.host.clientWidth - 24);
    tk.setOptions({
      scale: this.scale,
      // pages hold whole systems, up to ~3 viewports tall (a full orchestral system can be
      // taller than the panel); the panel scrolls to keep the playing notes in view. One
      // page per movement would be several MB of SVG, so pages stay bounded.
      pageWidth: Math.round((w * 100) / this.scale),
      pageHeight: Math.round((3 * Math.max(300, this.host.clientHeight - 24) * 100) / this.scale),
      adjustPageHeight: true,
      breaks: "auto",
      footer: "none",
      header: "none",
    });
  }

  private buildClock(): void {
    const tk = this.tk!;
    const tm = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
    const vm: VrvMeasure[] = [];
    for (const e of tm) {
      if (!e.measureOn) continue;
      const notated = e.measureOn.replace(/-rend\d+$/, "");
      vm.push({ id: e.measureOn, n: tk.getElementAttr(notated).n ?? "", ms: e.tstamp });
    }
    const end = tm.length ? tm[tm.length - 1]!.tstamp : 0;
    this.clock = new ScoreClock(this.m.score?.measures ?? [], vm, end);
    this.sounding = new SoundingTracker(tm);
  }

  /** Re-layout after a size or zoom change. */
  relayout(): void {
    if (!this.tk) return;
    this.applyOptions(this.tk);
    this.tk.redoLayout();
    this.buildClock();
    this.pageCount = this.tk.getPageCount();
    this.page = 0;
    this.litKey = "";
  }

  private show(page: number): void {
    if (!this.tk || page === this.page || page < 1) return;
    this.host.innerHTML = sanitizeSvg(this.tk.renderToSVG(page));
    this.page = page;
    this.lit = [];
    this.litKey = "";
    this.host.scrollTop = 0;
  }

  pageLabel(): string {
    return this.pageCount ? `page ${this.page} / ${this.pageCount}` : "";
  }

  step(delta: number): void {
    this.show(Math.min(this.pageCount, Math.max(1, (this.page || 1) + delta)));
  }

  /** Per animation frame while open. */
  update(t: number): void {
    if (!this.tk || !this.clock) return;
    const ms = this.clock.audioToVrv(t);
    if (!Number.isFinite(ms)) return;
    const at = this.tk.getElementsAtTime(Math.round(ms));
    if (this.follow && at.page && at.page !== this.page) this.show(at.page);
    else if (!this.page) this.show(1);
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
    for (const raw of ids) {
      const el = this.find(raw);
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

  private find(id: string): SVGElement | null {
    const q = (x: string): SVGElement | null =>
      this.host.querySelector<SVGElement>(`[id="${CSS.escape(x)}"]`);
    return q(id) ?? (this.tk ? q(this.tk.getNotatedIdForElement(id)) : null);
  }

  /** Part of a note: its staff's position within the measure -> part via staff counts. */
  private partOf(el: Element): number | null {
    const staff = el.closest("g.staff");
    const measure = staff?.closest("g.measure");
    if (!staff || !measure) return null;
    const idx = [...measure.querySelectorAll(":scope > g.staff")].indexOf(staff);
    return idx >= 0 && idx < this.staffToPart.length ? this.staffToPart[idx]! : null;
  }

  private keepVisible(el: Element): void {
    const r = el.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    if (r.top < h.top + 40 || r.bottom > h.bottom - 40) {
      this.host.scrollTop += r.top - h.top - h.height / 3;
    }
  }

  private onClick(e: MouseEvent): void {
    if (!this.tk || !this.clock) return;
    const target = (e.target as Element).closest("g.note, g.chord, g.rest, g.measure");
    if (!target?.id) return;
    // all passes of this element (repeats), mapped to audio; take the one nearest "now"
    const ids = this.tk.getExpansionIdsForElement(target.id);
    const cands = (ids.length ? ids : [target.id])
      .map((id) => this.tk!.getTimeForElement(id))
      .filter((ms) => Number.isFinite(ms) && ms >= 0)
      .map((ms) => this.clock!.vrvToAudio(ms));
    if (!cands.length) return;
    const now = this.deps.now();
    cands.sort((a, b) => Math.abs(a - now) - Math.abs(b - now));
    this.deps.onSeek(cands[0]!);
  }
}
