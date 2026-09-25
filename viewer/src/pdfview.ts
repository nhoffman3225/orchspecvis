// Score PDF view (schema v6 score.pdf): the engraved PDF (e.g. Dorico's condensed full
// score) as page images, following playback with a highlight on the current bar and a
// playhead line moving through it. Bars and their numbers were found at import
// (score/pdf.py); the played bar (repeats unrolled) maps to its printed bar by number.
// Click a bar to jump there (the pass nearest the playhead).

import { bundleUrl, type PdfScore, type ScoreMeasure } from "./bundle";
import { measureAt } from "./notes";

export interface PdfViewDeps {
  onSeek: (seconds: number) => void;
  now: () => number;
}

type Bar = PdfScore["bars"][number];

/** First printed bar per bar number (the PDF prints each notated bar once). */
export function barIndex(pdf: PdfScore): Map<string, Bar> {
  const out = new Map<string, Bar>();
  for (const b of pdf.bars) if (!out.has(b.number)) out.set(b.number, b);
  return out;
}

/** Start time of the played measure with this number nearest to `now` (repeat passes). */
export function seekTarget(measures: ScoreMeasure[], number: string, now: number): number | null {
  let best: number | null = null;
  for (const m of measures) {
    if (m.number !== number) continue;
    if (best === null || Math.abs(m.start_s - now) < Math.abs(best - now)) best = m.start_s;
  }
  return best;
}

export class PdfView {
  private img = document.createElement("img");
  private box = document.createElement("div");
  private line = document.createElement("div");
  private page = -1;
  private bars: Map<string, Bar>;
  follow = true;
  zoom = 1; // 1 = fit width

  constructor(
    private host: HTMLElement,
    private base: string,
    private pdf: PdfScore,
    private measures: ScoreMeasure[],
    private deps: PdfViewDeps,
  ) {
    this.bars = barIndex(pdf);
    this.img.alt = "score page";
    this.img.draggable = false;
    this.box.className = "pdf-bar";
    this.line.className = "score-line";
    this.box.hidden = this.line.hidden = true;
    const sheet = document.createElement("div");
    sheet.className = "pdf-sheet";
    sheet.append(this.img, this.box, this.line);
    host.replaceChildren(sheet);
    this.img.addEventListener("click", (e) => this.onClick(e));
    this.show(0);
  }

  get pageCount(): number {
    return this.pdf.pages.length;
  }

  get currentPage(): number {
    return this.page;
  }

  show(page: number): void {
    const p = Math.max(0, Math.min(this.pdf.pages.length - 1, page));
    if (p === this.page) return;
    this.page = p;
    this.img.src = bundleUrl(this.base, this.pdf.pages[p]!.path);
    this.host.scrollTop = 0;
  }

  step(delta: number): void {
    this.follow = false;
    this.show(this.page + delta);
  }

  setZoom(z: number): void {
    this.zoom = Math.min(4, Math.max(0.5, z));
    (this.img.parentElement as HTMLElement).style.width = `${Math.round(this.zoom * 100)}%`;
  }

  /** Displayed pixels per page pixel. */
  private get scale(): number {
    const w = this.pdf.pages[this.page]?.width ?? 1;
    return this.img.clientWidth / w;
  }

  update(t: number): void {
    const bb = measureAt(this.measures, t);
    const bar = bb ? this.bars.get(bb.number) : undefined;
    if (!bb || !bar) {
      this.box.hidden = this.line.hidden = true;
      return;
    }
    if (this.follow && bar.page !== this.page) this.show(bar.page);
    if (bar.page !== this.page || !this.img.complete || !this.img.clientWidth) {
      this.box.hidden = this.line.hidden = true;
      return;
    }
    const s = this.scale;
    const ms = this.measures[bb.index]!;
    const frac = Math.min(1, Math.max(0, (t - ms.start_s) / Math.max(1e-9, ms.end_s - ms.start_s)));
    const [x0, y0, x1, y1] = [bar.x0 * s, bar.y0 * s, bar.x1 * s, bar.y1 * s];
    this.box.hidden = this.line.hidden = false;
    Object.assign(this.box.style, {
      transform: `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`,
      width: `${(x1 - x0).toFixed(1)}px`,
      height: `${(y1 - y0).toFixed(1)}px`,
    });
    Object.assign(this.line.style, {
      transform: `translate(${(x0 + frac * (x1 - x0)).toFixed(1)}px, ${y0.toFixed(1)}px)`,
      height: `${(y1 - y0).toFixed(1)}px`,
    });
    if (this.follow) {
      const top = y0 - 40, bottom = y1 + 40;
      if (top < this.host.scrollTop || bottom > this.host.scrollTop + this.host.clientHeight) {
        this.host.scrollTop = Math.max(0, top);
      }
    }
    this.host.dataset.pdfBar = bb.number; // tests
  }

  private onClick(e: MouseEvent): void {
    const r = this.img.getBoundingClientRect();
    const s = this.scale;
    const x = (e.clientX - r.left) / s, y = (e.clientY - r.top) / s;
    const hit = this.pdf.bars.find((b) => b.page === this.page && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
    if (!hit) return;
    const t = seekTarget(this.measures, hit.number, this.deps.now());
    if (t !== null) this.deps.onSeek(t + 1e-3);
  }
}
