import { describe, expect, it } from "vitest";
import type { PdfScore, ScoreMeasure } from "./bundle";
import { barIndex, seekTarget } from "./pdfview";

const bar = (page: number, number: string) => ({ page, number, x0: 0, y0: 0, x1: 10, y1: 10 });
const meas = (number: string, start_s: number): ScoreMeasure => ({
  play_index: 0, number, start_s, end_s: start_s + 2, beats: 4, beat_type: 4, pass_no: 1, source_index: null,
});

describe("pdf view helpers", () => {
  it("indexes the first printed bar per number", () => {
    const pdf: PdfScore = { dpi: 150, pages: [], bars: [bar(0, "1"), bar(0, "2"), bar(1, "2")] };
    const idx = barIndex(pdf);
    expect(idx.get("2")!.page).toBe(0);
    expect(idx.size).toBe(2);
  });

  it("seeks to the repeat pass nearest the playhead", () => {
    const ms = [meas("1", 0), meas("2", 2), meas("1", 4), meas("2", 6)];
    expect(seekTarget(ms, "2", 1)).toBe(2);
    expect(seekTarget(ms, "2", 7)).toBe(6);
    expect(seekTarget(ms, "9", 1)).toBeNull();
  });
});
