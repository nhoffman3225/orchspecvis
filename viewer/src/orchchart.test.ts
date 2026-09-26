import { describe, expect, it } from "vitest";
import { layoutChart, mixColors, parseName, renderChart, shortName, type ChartPart } from "./orchchart";

const parts: ChartPart[] = [
  { name: "Flute 1", family: "woodwinds" },
  { name: "Oboe 1", family: "woodwinds" },
  { name: "Clarinet (B Flat) 1", family: "woodwinds" },
  { name: "Trumpet (C) 1", family: "brass" },
  { name: "Trumpet (C) 2", family: "brass" },
  { name: "Violin I", family: "strings" },
  { name: "Violoncello", family: "strings" },
];
const COL: Record<string, string> = { woodwinds: "#2e9e5b", brass: "#d63c3c", strings: "#7a4dff" };
const colorOf = (f: string): string => COL[f] ?? "#000000";

describe("orchestration chart", () => {
  it("short names", () => {
    expect(parts.map(shortName)).toEqual(["fl.", "ob.", "clar.", "trp.", "trp.", "str.", "str."]);
    expect(shortName({ name: "English Horn", family: "woodwinds" })).toBe("e.h.");
    expect(shortName({ name: "Horn (E Flat) 1", family: "brass" })).toBe("hrn.");
    expect(shortName({ name: "Contrabassoon", family: "woodwinds" })).toBe("cbn.");
  });

  it("parses spelled names to staff steps", () => {
    expect(parseName("C4")).toEqual({ step: 28, acc: "" });
    expect(parseName("B♭3")).toEqual({ step: 27, acc: "♭" });
    expect(parseName("F♯5")).toEqual({ step: 38, acc: "♯" });
  });

  it("split: a notehead per part on a doubled pitch, sections in their own columns", () => {
    const notes = [
      { midi: 72, name: "C5", parts: [0, 1, 3, 4] }, // fl + ob + 2 trp in unison
      { midi: 64, name: "E4", parts: [2] },
      { midi: 48, name: "C3", parts: [5, 6] }, // strings collapse to one head
    ];
    const c = layoutChart(notes, parts, colorOf, "split");
    const c5 = c.heads.filter((h) => h.step === parseName("C5").step);
    expect(c5).toHaveLength(4); // fl, ob, trp 1, trp 2: nothing blended
    expect(new Set(c5.map((h) => h.color))).toEqual(new Set([COL.woodwinds, COL.brass]));
    const xsBrass = c5.filter((h) => h.family === "brass").map((h) => h.x);
    expect(new Set(xsBrass).size).toBe(2); // the trumpets' unison side by side
    expect(c.heads.filter((h) => h.family === "strings")).toHaveLength(1);
    // fl. and ob. play exactly the same pitch: one label; the trumpets share "trp."
    expect(c.labels.map((l) => l.text).sort()).toEqual(["clar.", "fl. & ob.", "str.", "trp."]);
  });

  it("mix: one notehead per pitch, coloured by the weighted blend", () => {
    const c = layoutChart([{ midi: 72, name: "C5", parts: [0, 3, 4] }], parts, colorOf, "mix");
    const cols = new Set(c.heads.map((h) => h.color));
    expect(cols.size).toBe(1);
    expect([...cols][0]).toBe(mixColors([COL.woodwinds!, COL.brass!], [1, 2]));
    expect(new Set(c.heads.map((h) => h.x)).size).toBe(1);
  });

  it("colour mixing is weighted and exact for a single colour", () => {
    expect(mixColors(["#ff0000"], [3])).toBe("#ff0000");
    expect(mixColors(["#ff0000", "#0000ff"], [1, 1])).toBe("#bc00bc"); // linear-light average
    expect(mixColors(["#ff0000", "#0000ff"], [3, 1])).not.toBe(mixColors(["#ff0000", "#0000ff"], [1, 3]));
  });

  it("overlapping labels are pushed apart and get a leader line", () => {
    const notes = [
      { midi: 72, name: "C5", parts: [0] }, { midi: 71, name: "B4", parts: [1] }, { midi: 69, name: "A4", parts: [2] },
    ];
    const c = layoutChart(notes, parts, colorOf, "split");
    const ys = c.labels.map((l) => l.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(13);
    expect(c.labels.some((l) => l.leaders.length > 0)).toBe(true);
    const svg = renderChart(c);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script|href=/);
  });
});

describe("orchestration chart, mix mode labels", () => {
  it("labels of different sections on one side never overlap", () => {
    const ps: ChartPart[] = [
      { name: "Bassoon 1", family: "woodwinds" }, { name: "Violoncello", family: "strings" },
      { name: "Oboe 1", family: "woodwinds" },
    ];
    const c = layoutChart([
      { midi: 50, name: "D3", parts: [0] }, { midi: 49, name: "D♭3", parts: [1] }, { midi: 74, name: "D5", parts: [2] },
    ], ps, () => "#333333", "mix");
    const left = c.labels.filter((l) => l.anchor === "end").sort((a, b) => a.y - b.y);
    for (let i = 1; i < left.length; i++) expect(left[i]!.y - left[i - 1]!.y).toBeGreaterThanOrEqual(13);
    expect(new Set(left.map((l) => l.x)).size).toBeLessThanOrEqual(1);
  });
});
