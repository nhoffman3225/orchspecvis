import { describe, expect, it } from "vitest";
import { progressOf, type ImportStatus } from "./importview";

const st = (p: Partial<ImportStatus>): ImportStatus => ({
  state: "running", session: "s", lines: [], stems_done: 0, stems_total: 0, bundle: null, error: null, ...p,
});

describe("import progress", () => {
  it("moves through mix, stems and done", () => {
    expect(progressOf(st({}))).toBeLessThan(0.05);
    expect(progressOf(st({ lines: ["mix: 372.8 s, 2 ch"] }))).toBeCloseTo(0.1);
    expect(progressOf(st({ stems_done: 11, stems_total: 22 }))).toBeCloseTo(0.5);
    expect(progressOf(st({ state: "done" }))).toBe(1);
  });
});
