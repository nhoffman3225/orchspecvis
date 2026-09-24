import { describe, expect, it } from "vitest";
import type { Lod, Tile } from "./bundle";
import { Transport, type TimeSource } from "./clock";
import { colormapLut, stemPalette } from "./colormap";
import { frameGaps, frameSpans, smoothPage } from "./gaps";
import { TileCache, assemblePage, chooseLevel, powerTables, sumPages } from "./tiles";

function fakeLod(nFrames: number, tileFrames: number, nBins: number): { lod: Lod; data: Map<string, Uint8Array> } {
  const tiles: Tile[] = [];
  const data = new Map<string, Uint8Array>();
  for (let s = 0, i = 0; s < nFrames; s += tileFrames, i++) {
    const n = Math.min(tileFrames, nFrames - s);
    const path = `t/${i}.u8`;
    const d = new Uint8Array(n * nBins);
    for (let f = 0; f < n; f++) for (let b = 0; b < nBins; b++) d[f * nBins + b] = (s + f) % 256;
    data.set(path, d);
    tiles.push({ index: i, start_frame: s, n_frames: n, path });
  }
  return { lod: { level: 0, hop_factor: 1, n_frames: nFrames, tiles }, data };
}

describe("tiles", () => {
  it("chooses the coarsest-needed level", () => {
    expect(chooseLevel(1000, 2048, 8)).toBe(0);
    expect(chooseLevel(2049, 2048, 8)).toBe(1);
    expect(chooseLevel(112501, 2048, 8)).toBe(6);
    expect(chooseLevel(1e9, 2048, 3)).toBe(2);
  });

  it("assembles pages across tile boundaries with fill outside", async () => {
    const { lod, data } = fakeLod(100, 32, 3);
    let loads = 0;
    const cache = new TileCache(async (t) => (loads++, data.get(t.path)!));
    const page = await assemblePage(cache, lod, 3, 90, 20, 7);
    for (let f = 0; f < 10; f++) expect(page[f * 3]).toBe(90 + f);
    expect(page[10 * 3]).toBe(7); // beyond the end
    const p2 = await assemblePage(cache, lod, 3, 30, 4);
    expect(Array.from(p2.filter((_, i) => i % 3 === 0))).toEqual([30, 31, 32, 33]);
    await assemblePage(cache, lod, 3, 30, 4);
    expect(loads).toBe(4); // tiles 2,3 (first page) + 0,1 (p2); the repeat is cached
  });

  it("evicts least recently used", async () => {
    const { lod, data } = fakeLod(100, 10, 1);
    const cache = new TileCache(async (t) => data.get(t.path)!, 3);
    for (const t of lod.tiles) await cache.get(t);
    expect(cache.size).toBe(3);
  });

  it("sums stems in the power domain", () => {
    const dbMin = -96, dbMax = 6;
    const { fromPow, toPow } = powerTables(dbMin, dbMax);
    const v = 200;
    // two equal stems -> +3.01 dB = +7.5 LSB (0.4 dB/LSB)
    const s = sumPages([Uint8Array.of(v), Uint8Array.of(v)], dbMin, dbMax)[0]!;
    expect(s).toBe(fromPow(2 * toPow[v]!));
    expect(s - v).toBeGreaterThanOrEqual(7);
    expect(s - v).toBeLessThanOrEqual(8);
    expect(sumPages([Uint8Array.of(0), Uint8Array.of(0)], dbMin, dbMax)[0]).toBe(0);
  });
});

describe("transport", () => {
  it("derives position from the time source", () => {
    let now = 100;
    const src: TimeSource = { now: () => now, scheduleNow: () => now };
    const tr = new Transport(src, 10);
    expect(tr.position()).toBe(0);
    tr.play();
    now = 102.5;
    expect(tr.position()).toBeCloseTo(2.5);
    tr.seek(7);
    now = 103.5;
    expect(tr.position()).toBeCloseTo(8);
    now = 110;
    expect(tr.tick()).toBe(true);
    expect(tr.isPlaying).toBe(false);
    expect(tr.position()).toBe(10);
    tr.play(); // restarts from 0 at the end
    expect(tr.position()).toBe(0);
    tr.pause();
    now = 200;
    expect(tr.position()).toBe(0);
  });
});

describe("colormaps", () => {
  it("builds 256-entry LUTs", () => {
    const lut = colormapLut("magma");
    expect(lut.length).toBe(1024);
    expect(lut[0]! + lut[1]! + lut[2]!).toBeLessThan(40); // dark at the bottom
    expect(lut[255 * 4]! + lut[255 * 4 + 1]!).toBeGreaterThan(400); // bright at the top
    const pal = stemPalette(3, (i) => i !== 1);
    expect(pal[1 * 4]).toBe(90);
  });
});


describe("spectral gaps", () => {
  // k = 1, fmin = 21 (A0); a row of 24 bins = A0..G#2
  const row = new Uint8Array(24);
  row[2] = 200; // B0
  row[3] = 200;
  row[10] = 150; // G1
  row[20] = 90; // F2
  it("finds quiet runs inside the sounding span only", () => {
    const g = frameGaps(row, 100, 1, 21, 1);
    // 90 <= thr, so the span is bins 2..10 and the only gap is 4..9
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ loBin: 4, hiBin: 9, semitones: 6, label: "C#1–F#1" });
    const g2 = frameGaps(row, 80, 1, 21, 1);
    expect(g2.map((x) => [x.loBin, x.hiBin])).toEqual([[11, 19], [4, 9]]); // widest first
    expect(frameGaps(row, 80, 1, 21, 8).map((x) => x.loBin)).toEqual([11]);
    expect(frameGaps(new Uint8Array(24), 10, 1, 21)).toEqual([]);
  });
  it("computes per-frame spans", () => {
    const page = new Uint8Array(48);
    page.set(row, 0);
    const s = frameSpans(page, 24, 2, 100);
    expect(Array.from(s)).toEqual([2, 10, -1, -1]);
  });
});

describe("smoothing", () => {
  it("is identity at radius 0 and preserves a constant page", () => {
    const p = Uint8Array.from({ length: 40 }, (_, i) => i);
    expect(smoothPage(p, 8, 5, 0, 0, -96, 6)).toBe(p);
    const c = new Uint8Array(64).fill(123);
    expect(Array.from(smoothPage(c, 8, 8, 2, 3, -96, 6))).toEqual(Array.from(c));
  });
  it("fills the space between partials so it no longer reads as a gap", () => {
    const nBins = 36, frames = 3;
    const page = new Uint8Array(nBins * frames);
    for (let f = 0; f < frames; f++) for (const b of [4, 8, 12, 30]) page[f * nBins + b] = 220;
    const thr = 150; // ~ -36 dB
    const raw = frameGaps(page.subarray(nBins, 2 * nBins), thr, 1, 21, 2);
    expect(raw.length).toBe(3); // between every partial
    const sm = smoothPage(page, nBins, frames, 2, 0, -96, 6);
    // energy smoothing keeps a lone partial within a few dB of its level (0.4 dB/LSB)
    expect(sm[nBins + 30]!).toBeGreaterThan(220 - 25);
    const g = frameGaps(sm.subarray(nBins, 2 * nBins), thr, 1, 21, 2);
    expect(g.length).toBe(1); // only the real register hole remains
    expect(g[0]!.loBin).toBeGreaterThan(13);
    expect(g[0]!.hiBin).toBeLessThan(29);
  });
});
