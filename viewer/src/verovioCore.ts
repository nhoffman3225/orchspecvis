// Verovio operations as plain-data functions, shared by the score worker and the tests.
// Everything returned is structured-cloneable (crosses the worker boundary as-is).

import type { VerovioToolkit } from "verovio/esm";
import { sanitizeSvg, type TimemapEvent, type VrvMeasure } from "./scoremap";

export interface LayoutOptions {
  scale: number; // Verovio zoom (percent)
  widthPx: number; // panel width
  heightPx: number; // panel height
  condense: boolean; // hide empty staves
}

export interface LayoutResult {
  pageCount: number;
  measures: (VrvMeasure & { page: number })[]; // playback order (repeats expanded)
  events: TimemapEvent[]; // note on/off, ids normalized to notated ids (on the SVG)
  endMs: number;
}

/** "abc-rend2" (repeat expansion) -> "abc", the id present in the rendered SVG. */
export const notatedId = (id: string): string => id.replace(/-rend\d+$/, "");

export function verovioOptions(o: LayoutOptions): Record<string, unknown> {
  const w = Math.max(400, o.widthPx - 24);
  const h = Math.max(300, o.heightPx - 24);
  return {
    scale: o.scale,
    // pages hold whole systems, up to ~3 panels tall (a full orchestral system can be taller
    // than the panel); the panel scrolls. One page per movement would be MBs of SVG.
    pageWidth: Math.round((w * 100) / o.scale),
    pageHeight: Math.round((3 * h * 100) / o.scale),
    adjustPageHeight: true,
    breaks: "auto",
    footer: "none",
    header: "none",
    condense: o.condense ? "auto" : "none",
    condenseFirstPage: o.condense,
    // staff@n -> data-n on each staff <g>: maps staves to parts even when some are hidden
    svgAdditionalAttribute: ["staff@n"],
  };
}

export function layout(tk: VerovioToolkit, o: LayoutOptions, data?: string | ArrayBuffer
                       ): LayoutResult {
  tk.setOptions(verovioOptions(o));
  if (data !== undefined) {
    const ok = typeof data === "string" ? tk.loadData(data) : tk.loadZipDataBuffer(data);
    if (!ok) throw new Error(`Verovio could not read the score: ${tk.getLog()}`);
  } else {
    tk.redoLayout();
  }
  const tm = tk.renderToTimemap({ includeMeasures: true, includeRests: true });
  const measures: LayoutResult["measures"] = [];
  const pageOf = new Map<string, number>();
  const events: TimemapEvent[] = [];
  for (const e of tm) {
    if (e.measureOn) {
      const nid = notatedId(e.measureOn);
      let page = pageOf.get(nid);
      if (page === undefined) {
        page = tk.getPageWithElement(nid);
        pageOf.set(nid, page);
      }
      measures.push({ id: e.measureOn, n: tk.getElementAttr(nid).n ?? "", ms: e.tstamp, page });
    }
    if (e.on?.length || e.off?.length) {
      events.push({ tstamp: e.tstamp, on: e.on?.map(notatedId), off: e.off?.map(notatedId) });
    }
  }
  return {
    pageCount: tk.getPageCount(),
    measures,
    events,
    endMs: tm.length ? tm[tm.length - 1]!.tstamp : 0,
  };
}

export const renderPage = (tk: VerovioToolkit, page: number): string =>
  sanitizeSvg(tk.renderToSVG(page));

/** Verovio times (ms) of every pass of an element (repeats), for click-to-seek. */
export function elementTimes(tk: VerovioToolkit, id: string): number[] {
  const ids = tk.getExpansionIdsForElement(id);
  return (ids.length ? ids : [id])
    .map((x) => tk.getTimeForElement(x))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
}
