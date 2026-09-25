// Main-thread side of pages.worker.ts: promise RPC with transferable results.

import type { Lod, Manifest } from "./bundle";
import type { PageResult, PagesRequest } from "./pages.worker";

type Req = PagesRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export class PagesClient {
  private worker = new Worker(new URL("./pages.worker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(base: string, m: Manifest) {
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result);
      else p.reject(new Error(ev.data.error));
    };
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || "pages worker failed"));
      this.pending.clear();
    };
    void this.call({ op: "init", init: { base: new URL(base, location.href).href, search: location.search, manifest: m } });
  }

  private call<T>(req: Req): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  /** Power-summed height page of `lods` (one per track) and optional dominant-stem page. */
  page(lods: Lod[], dom: Lod | null, start: number, count: number): Promise<PageResult> {
    return this.call<PageResult>({ op: "page", lods, dom, start, count });
  }

  /** smoothPage in the worker (the input is copied, not transferred). */
  smooth(page: Uint8Array, frames: number, sigmaBins: number, sigmaFrames: number): Promise<Uint8Array> {
    if (sigmaBins < 0.05 && sigmaFrames < 0.05) return Promise.resolve(page);
    return this.call<Uint8Array>({ op: "smooth", page, frames, sigmaBins, sigmaFrames });
  }
}
