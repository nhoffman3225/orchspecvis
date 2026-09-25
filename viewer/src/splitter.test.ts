import { describe, expect, it } from "vitest";
import { clampSize } from "./splitter";

describe("splitter", () => {
  it("clamps sizes so no panel collapses", () => {
    expect(clampSize(50, 80, 400)).toBe(80);
    expect(clampSize(500, 80, 400)).toBe(400);
    expect(clampSize(123.6, 80, 400)).toBe(124);
    // a window too small for both limits: the minimum wins
    expect(clampSize(300, 80, 20)).toBe(80);
  });
});
