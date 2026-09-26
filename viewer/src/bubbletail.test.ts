import { describe, expect, it } from "vitest";
import { intersect, tailShape } from "./bubbletail";

const bubble = { x0: 100, y0: 100, x1: 300, y1: 260 };

describe("chord pop-up pointer", () => {
  it("leaves the edge facing the selection and stops just short of it", () => {
    const t = tailShape(bubble, { x0: 20, y0: 150, x1: 60, y1: 200 })!;
    expect(t.base.every(([x]) => x === 101)).toBe(true); // left edge
    expect(t.tip).toEqual([64, 175]);
    const r = tailShape(bubble, { x0: 400, y0: 150, x1: 450, y1: 200 })!;
    expect(r.base.every(([x]) => x === 299)).toBe(true); // right edge
    expect(r.tip[0]).toBe(396);
  });

  it("points up or down when the selection is mostly above or below", () => {
    const t = tailShape(bubble, { x0: 150, y0: 500, x1: 200, y1: 540 })!;
    expect(t.base.every(([, y]) => y === 259)).toBe(true);
    expect(t.tip).toEqual([175, 496]);
    const u = tailShape(bubble, { x0: 150, y0: 0, x1: 200, y1: 40 })!;
    expect(u.base.every(([, y]) => y === 101)).toBe(true);
  });

  it("stays on the pop-up's edge even when the selection is far past a corner", () => {
    const t = tailShape(bubble, { x0: 600, y0: 900, x1: 650, y1: 950 })!;
    for (const [x, y] of t.base) {
      expect(x).toBeGreaterThanOrEqual(bubble.x0 + 6);
      expect(x).toBeLessThanOrEqual(bubble.x1 - 6);
      expect(y).toBe(259);
    }
    expect(t.tip[0]).toBeGreaterThanOrEqual(600);
  });

  it("widens with distance, and is absent when the pop-up covers the selection", () => {
    const near = tailShape(bubble, { x0: 320, y0: 150, x1: 340, y1: 200 })!;
    const far = tailShape(bubble, { x0: 700, y0: 150, x1: 740, y1: 200 })!;
    const w = (t: typeof near): number => Math.abs(t.base[1][1] - t.base[0][1]);
    expect(w(far)).toBeGreaterThan(w(near));
    expect(tailShape(bubble, { x0: 150, y0: 150, x1: 200, y1: 200 })).toBeNull();
  });

  it("clips the selected area to what is visible", () => {
    expect(intersect({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 5, y0: 5, x1: 20, y1: 20 })).toEqual({ x0: 5, y0: 5, x1: 10, y1: 10 });
    expect(intersect({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 20, y0: 0, x1: 30, y1: 10 })).toBeNull();
  });
});
