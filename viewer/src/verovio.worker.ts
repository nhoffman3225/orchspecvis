// Web Worker hosting Verovio, so score layout (seconds for a full orchestral movement)
// never blocks the main thread. Thin wrapper around verovioCore; no network access
// (the score arrives in the "load" message).

import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { elementTimes, layout, renderPage, type LayoutOptions } from "./verovioCore";

export type ScoreRequest =
  | { id: number; op: "load"; data: string | ArrayBuffer; opts: LayoutOptions }
  | { id: number; op: "relayout"; opts: LayoutOptions }
  | { id: number; op: "render"; page: number }
  | { id: number; op: "times"; element: string };

let tk: VerovioToolkit | null = null;
const progress = (text: string): void => self.postMessage({ progress: text });

async function toolkit(): Promise<VerovioToolkit> {
  if (!tk) {
    const t0 = performance.now();
    progress("starting the notation engine…");
    const mod = await createVerovioModule();
    tk = new VerovioToolkit(mod);
    progress(`notation engine ready (${Math.round(performance.now() - t0)} ms); laying out…`);
  }
  return tk;
}

self.onmessage = async (ev: MessageEvent<ScoreRequest>) => {
  const req = ev.data;
  try {
    const tk = await toolkit();
    let result: unknown;
    if (req.op === "load") result = layout(tk, req.opts, req.data);
    else if (req.op === "relayout") result = layout(tk, req.opts);
    else if (req.op === "render") result = renderPage(tk, req.page);
    else result = elementTimes(tk, req.element);
    self.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
