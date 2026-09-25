// Web Worker for per-page CPU work: tile fetch + gunzip + assembly, power-domain stem sums
// (ensemble / selected stems) and the smoothing blur. Keeps the main thread (render loop,
// input, audio feeding) free. Owns the tile cache. Same-origin fetches only (net.ts).

import { loadTile, type Lod, type Manifest } from "./bundle";
import { smoothPage } from "./gaps";
import { KEYS, foldSemitones } from "./registers";
import { initToken } from "./net";
import { TileCache, assemblePage, sumPages } from "./tiles";

export interface PageInit {
  base: string; // absolute bundle URL (ends with '/')
  search: string; // page query string (carries the serve token)
  manifest: Manifest;
}

export type PagesRequest =
  | { id: number; op: "init"; init: PageInit }
  | { id: number; op: "page"; lods: Lod[]; dom: Lod | null; start: number; count: number }
  | { id: number; op: "smooth"; page: Uint8Array; frames: number; sigmaBins: number; sigmaFrames: number }
  | { id: number; op: "registers"; lods: Lod[] };

export interface PageResult {
  height: Uint8Array;
  dom: Uint8Array | null;
}

let m: Manifest | null = null;
let cache: TileCache | null = null;
let base = "";

function handle(req: PagesRequest): Promise<[unknown, Transferable[]]> | [unknown, Transferable[]] {
  if (req.op === "init") {
    m = req.init.manifest;
    base = req.init.base;
    initToken(req.init.search);
    const mm = m;
    cache = new TileCache((t) => loadTile(base, mm, t));
    return [null, []];
  }
  if (!m || !cache) throw new Error("pages worker used before init");
  if (req.op === "page") return page(m, cache, req);
  if (req.op === "registers") return registers(m, cache, req.lods);
  const out = smoothPage(req.page, m.n_bins, req.frames, req.sigmaBins, req.sigmaFrames, m.db_min, m.db_max);
  return [out, out === req.page ? [] : [out.buffer]];
}

async function page(mm: Manifest, c: TileCache, req: Extract<PagesRequest, { op: "page" }>
                    ): Promise<[PageResult, Transferable[]]> {
  const pages = await Promise.all(req.lods.map((l) => assemblePage(c, l, mm.n_bins, req.start, req.count)));
  const height = pages.length ? sumPages(pages, mm.db_min, mm.db_max) : new Uint8Array(req.count * mm.n_bins);
  const dom = req.dom
    ? await assemblePage(c, req.dom, mm.n_bins, req.start, req.count, mm.dominant?.none_value ?? 255)
    : null;
  // assemblePage/sumPages return fresh buffers (tile data stays in the cache): safe to transfer
  return [{ height, dom }, dom ? [height.buffer, dom.buffer] : [height.buffer]];
}

/** Whole coarse level of each stem, folded to 88 semitones: [stem][frame][88] u8. */
async function registers(mm: Manifest, c: TileCache, lods: Lod[]): Promise<[Uint8Array, Transferable[]]> {
  const frames = lods[0]?.n_frames ?? 0;
  const out = new Uint8Array(lods.length * frames * KEYS);
  const k = mm.bins_per_octave / 12;
  await Promise.all(lods.map(async (l, i) => {
    const pg = await assemblePage(c, l, mm.n_bins, 0, frames);
    out.set(foldSemitones(pg, mm.n_bins, frames, k), i * frames * KEYS);
  }));
  return [out, [out.buffer]];
}

self.onmessage = async (ev: MessageEvent<PagesRequest>) => {
  const req = ev.data;
  try {
    const [result, transfer] = await handle(req);
    self.postMessage({ id: req.id, ok: true, result }, { transfer });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
