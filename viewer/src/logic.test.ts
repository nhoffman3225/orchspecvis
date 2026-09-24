import { describe, expect, it } from "vitest";
import type { Lod, Tile } from "./bundle";
import { Transport, type TimeSource } from "./clock";
import { colormapLut, stemPalette } from "./colormap";
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
