// Tile cache and page assembly. A "page" is a contiguous run of frames at one LOD level,
// frame-major uint8 (frames x n_bins), uploaded as one texture.

import type { Lod, Manifest, Tile } from "./bundle";

export type TrackId = "mix" | "dominant" | `stem:${string}`;

export function lodsFor(m: Manifest, track: TrackId): Lod[] {
  if (track === "mix") return m.lods;
  if (track === "dominant") {
    if (!m.dominant) throw new Error("bundle has no dominant-stem tiles");
    return m.dominant.lods;
  }
  const id = track.slice("stem:".length);
  const s = m.stems.find((x) => x.id === id);
  if (!s) throw new Error(`unknown stem ${id}`);
  return s.lods;
}

/** Smallest level whose frame count for `windowFrames0` level-0 frames fits `maxFrames`. */
export function chooseLevel(windowFrames0: number, maxFrames: number, nLevels: number): number {
  let level = 0;
  while (level < nLevels - 1 && windowFrames0 / 2 ** level > maxFrames) level++;
  return level;
}

export type TileLoader = (tile: Tile) => Promise<Uint8Array>;

export class TileCache {
  private map = new Map<string, Promise<Uint8Array>>();
  constructor(
    private load: TileLoader,
    private capacity = 400,
  ) {}

  get(tile: Tile): Promise<Uint8Array> {
    const key = tile.path;
    let p = this.map.get(key);
    if (p) {
      this.map.delete(key); // refresh LRU order
    } else {
      const q = this.load(tile);
      // a failed load is retried next time; only if it is still the cached entry (it may
      // have been evicted and reloaded meanwhile)
      q.catch(() => {
        if (this.map.get(key) === q) this.map.delete(key);
      });
      p = q;
    }
    this.map.set(key, p);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    return p;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Copies frames [start, start + count) of `lod` into a new frame-major buffer.
 * Frames outside the level are left as `fill`.
 */
export async function assemblePage(
  cache: TileCache,
  lod: Lod,
  nBins: number,
  start: number,
  count: number,
  fill = 0,
): Promise<Uint8Array> {
  const out = new Uint8Array(count * nBins);
  if (fill) out.fill(fill);
  const end = start + count;
  const jobs = lod.tiles
    .filter((t) => t.start_frame < end && t.start_frame + t.n_frames > start)
    .map(async (t) => {
      const data = await cache.get(t);
      const a = Math.max(start, t.start_frame);
      const b = Math.min(end, t.start_frame + t.n_frames);
      out.set(data.subarray((a - t.start_frame) * nBins, (b - t.start_frame) * nBins), (a - start) * nBins);
    });
  await Promise.all(jobs);
  return out;
}

/** 256-entry tables: u8 -> linear power and back, for summing stems in the power domain. */
export function powerTables(dbMin: number, dbMax: number): { toPow: Float32Array; fromPow: (p: number) => number } {
  const step = (dbMax - dbMin) / 255;
  const toPow = new Float32Array(256);
  for (let v = 0; v < 256; v++) toPow[v] = v === 0 ? 0 : 10 ** ((dbMin + v * step) / 10);
  const fromPow = (p: number): number => {
    if (p <= 0) return 0;
    const v = Math.round((10 * Math.log10(p) - dbMin) / step);
    return v < 0 ? 0 : v > 255 ? 255 : v;
  };
  return { toPow, fromPow };
}

/** Power-sum of several u8 pages (same shape) -> u8 page. */
export function sumPages(pages: Uint8Array[], dbMin: number, dbMax: number): Uint8Array {
  if (pages.length === 1) return pages[0]!;
  const n = pages[0]?.length ?? 0;
  const out = new Uint8Array(n);
  const { toPow, fromPow } = powerTables(dbMin, dbMax);
  const acc = new Float32Array(n);
  for (const p of pages) for (let i = 0; i < n; i++) acc[i]! += toPow[p[i]!]!;
  for (let i = 0; i < n; i++) out[i] = fromPow(acc[i]!);
  return out;
}
