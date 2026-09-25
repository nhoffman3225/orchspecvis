// Web Worker hosting Verovio, so score layout (seconds for a full orchestral movement)
// never blocks the main thread. Thin wrapper around verovioCore; no network access
// (the score arrives in the "load" message).

import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { sanitizeSvg } from "./scoremap";
import { elementTimes, layout, renderPage, type LayoutOptions } from "./verovioCore";

export type ScoreRequest =
  | { id: number; op: "load"; data: string | ArrayBuffer; opts: LayoutOptions }
  | { id: number; op: "relayout"; opts: LayoutOptions }
  | { id: number; op: "render"; page: number }
  | { id: number; op: "times"; element: string }
  | { id: number; op: "engrave"; xml: string; scale: number };

let tk: VerovioToolkit | null = null;
let mod: unknown = null;
let small: VerovioToolkit | null = null; // one-off snippets (condensed chords), own state
const progress = (text: string): void => self.postMessage({ progress: text });

async function toolkit(): Promise<VerovioToolkit> {
  if (!tk) {
    const t0 = performance.now();
    progress("starting the notation engine…");
    // elapsed-time ticks: if they stop, the worker is busy; if they continue, it is waiting
    const tick = setInterval(() => {
      progress(`starting the notation engine… ${Math.round((performance.now() - t0) / 1000)} s`);
    }, 1000);
    try {
      mod = await createVerovioModule({
        printErr: (text: string) => progress(`notation engine: ${text}`),
        onAbort: (what: unknown) => progress(`notation engine aborted: ${String(what)}`),
      });
      tk = new VerovioToolkit(mod);
    } finally {
      clearInterval(tick);
    }
    progress(`notation engine ready (${Math.round(performance.now() - t0)} ms); laying out…`);
  }
  return tk;
}

function engrave(xml: string, scale: number): string {
  small ??= new VerovioToolkit(mod!);
  small.setOptions({
    scale, adjustPageWidth: true, adjustPageHeight: true, breaks: "none", footer: "none",
    header: "none", pageMarginLeft: 20, pageMarginRight: 20, pageMarginTop: 10, pageMarginBottom: 10,
  });
  if (!small.loadData(xml)) throw new Error(`could not engrave: ${small.getLog()}`);
  return sanitizeSvg(small.renderToSVG(1));
}

self.onmessage = async (ev: MessageEvent<ScoreRequest>) => {
  const req = ev.data;
  try {
    const tk = await toolkit();
    let result: unknown;
    if (req.op === "load") result = layout(tk, req.opts, req.data);
    else if (req.op === "relayout") result = layout(tk, req.opts);
    else if (req.op === "render") result = renderPage(tk, req.page);
    else if (req.op === "engrave") result = engrave(req.xml, req.scale);
    else result = elementTimes(tk, req.element);
    self.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
