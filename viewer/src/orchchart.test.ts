import { describe, expect, it } from "vitest";
import { layoutChart, mixColors, parseName, partLabel, renderChart, shortName, type Chart, type ChartPart } from "./orchchart";

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

/** Label pills on one side never overlap vertically (estimated boxes). */
function noLabelOverlap(c: Chart): void {
  const ls = [...c.labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < ls.length; i++) {
    if (Math.abs(ls[i]!.x - ls[i - 1]!.x) < 60) expect(ls[i]!.y - ls[i - 1]!.y).toBeGreaterThanOrEqual(16);
  }
}

describe("orchestration chart", () => {
  it("names instruments and their desks", () => {
    expect(parts.map(shortName)).toEqual(["fl.", "ob.", "clar.", "trp.", "trp.", "vln.", "vc."]);
    expect(parts.map(partLabel)).toEqual(["fl. 1", "ob. 1", "clar. 1", "trp. 1", "trp. 2", "vln. I", "vc."]);
    expect(shortName({ name: "English Horn", family: "woodwinds" })).toBe("e.h.");
    expect(partLabel({ name: "Horn (E Flat) 1 & Horn (C) 1", family: "brass" })).toBe("hrn. 1");
    expect(shortName({ name: "Contrabassoon", family: "woodwinds" })).toBe("cbn.");
  });

  it("parses spelled names to staff steps", () => {
    expect(parseName("C4")).toEqual({ step: 28, acc: "" });
    expect(parseName("B♭3")).toEqual({ step: 27, acc: "♭" });
    expect(parseName("F♯5")).toEqual({ step: 38, acc: "♯" });
  });

  const chord = [
    { midi: 72, name: "C5", parts: [0, 1, 3, 4] }, // fl + ob + 2 trp in unison
    { midi: 64, name: "E4", parts: [2] },
    { midi: 48, name: "C3", parts: [5, 6] },
  ];

  it("every section in its own block, in chart order, never overlapping", () => {
    for (const mode of ["mix", "split"] as const) {
      const c = layoutChart(chord, parts, colorOf, mode);
      expect(c.sections.map((s) => s.title)).toEqual(["Strings", "Woodwinds", "Brass"]);
      for (let i = 1; i < c.sections.length; i++) expect(c.sections[i]!.x0).toBeGreaterThan(c.sections[i - 1]!.x1);
      for (const h of c.heads) {
        const s = c.sections.find((sec) => h.x >= sec.x0 && h.x <= sec.x1)!;
        expect(s.title.toLowerCase()).toBe(h.family);
      }
    }
  });

  it("split: each notehead belongs to one instrument, named over its own sub-column", () => {
    const c = layoutChart(chord, parts, colorOf, "split");
    expect(c.heads.every((h) => h.parts.length === 1)).toBe(true);
    expect(c.headers.map((h) => h.text)).toEqual(["vln. I", "vc.", "fl. 1", "ob. 1", "clar. 1", "trp. 1", "trp. 2"]);
    // a header stands over exactly its instrument's noteheads
    for (const [i, hd] of c.headers.entries()) {
      const partIdx = [5, 6, 0, 1, 2, 3, 4][i]!;
      const xs = c.heads.filter((h) => h.parts[0] === partIdx).map((h) => h.x + 6.5);
      for (const x of xs) expect(Math.abs(x - hd.x)).toBeLessThanOrEqual(14);
    }
    expect(new Set(c.headers.map((h) => Math.round(h.x))).size).toBe(c.headers.length);
    expect(c.labels).toEqual([]);
  });

  it("mix: one notehead per pitch per section, labelled in a lane beside it", () => {
    const c = layoutChart(chord, parts, colorOf, "mix");
    expect(c.heads.filter((h) => h.family === "brass")).toHaveLength(1); // trp 1 + 2 unison
    expect(c.labels.map((l) => l.text).sort()).toEqual(["clar.", "fl. & ob.", "trp.", "vln. & vc."]);
    for (const l of c.labels) {
      const lane = c.heads.filter((h) => h.family === Object.keys(COL).find((k) => COL[k] === l.color));
      expect(l.x).toBeLessThan(Math.min(...lane.map((h) => h.x))); // left of its notes
    }
    noLabelOverlap(c);
  });

  it("crowded labels are pushed apart, get leader lines, and the chart grows to fit", () => {
    const ps: ChartPart[] = ["Flute", "Oboe", "Clarinet", "Bassoon", "English Horn"].map((n) => ({ name: n, family: "woodwinds" }));
    const notes = [72, 71, 69, 67, 65].map((m, i) => ({ midi: m, name: ["C5", "B4", "A4", "G4", "F4"][i]!, parts: [i] }));
    const c = layoutChart(notes, ps, colorOf, "mix");
    noLabelOverlap(c);
    expect(c.labels.some((l) => l.leaders.length > 0)).toBe(true);
    const lowest = Math.max(...c.labels.map((l) => l.y));
    expect(c.height).toBeGreaterThan(lowest + 10);
    const svg = renderChart(c);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/<script|http/);
  });

  it("uses the page's engraved glyphs for clefs and accidentals when given", () => {
    const c = layoutChart([{ midi: 58, name: "B♭3", parts: [6] }], parts, colorOf, "mix");
    const svg = renderChart(c, "#111111", (code) => ({ E050: "E050-x", E062: "E062-x", E260: "E260-x" })[code] ?? null);
    expect(svg).toContain('href="#E050-x"');
    expect(svg).toContain('href="#E062-x"');
    expect(svg).toContain('href="#E260-x"');
    // the F clef's origin sits on the F line (F3): one staff space below the bass top line
    expect(c.fLine - c.staves[1]!.top).toBe(10);
    expect(c.gLine - c.staves[0]!.top).toBe(30); // G4: the second line from the bottom
  });

  it("colour mixing is weighted and exact for a single colour", () => {
    expect(mixColors(["#ff0000"], [3])).toBe("#ff0000");
    expect(mixColors(["#ff0000", "#0000ff"], [1, 1])).toBe("#bc00bc");
    expect(mixColors(["#ff0000", "#0000ff"], [3, 1])).not.toBe(mixColors(["#ff0000", "#0000ff"], [1, 3]));
  });
});

describe("orchestration chart, collisions", () => {
  // a crowded woodwind chord: six instruments on six neighbouring pitches
  const ps: ChartPart[] = ["Piccolo", "Flute", "Oboe", "Clarinet", "Bassoon", "English Horn"].map((n) => ({ name: n, family: "woodwinds" }));
  const names = ["D5", "C5", "B4", "A4", "G4", "F4"];
  const notes = [74, 72, 71, 69, 67, 65].map((m, i) => ({ midi: m, name: names[i]!, parts: [i] }));
  const c = layoutChart(notes, ps, colorOf, "mix");
  type Seg = [[number, number], [number, number]];
  const segs = (pts: [number, number][]): Seg[] => pts.slice(1).map((p, i) => [pts[i]!, p]);
  const cross = ([a, b]: Seg, [p, q]: Seg): boolean => {
    const d = (u: [number, number], v: [number, number], w: [number, number]): number =>
      (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    return d(a, b, p) * d(a, b, q) < 0 && d(p, q, a) * d(p, q, b) < 0; // proper crossing
  };
  const pill = (l: (typeof c.labels)[number]): { x0: number; x1: number; y0: number; y1: number } => {
    const w = [...l.text].length * 10 + 8; // generous estimate
    return { x0: l.x - w, x1: l.x + 4, y0: l.y - 12, y1: l.y + 4 };
  };
  const hit = (a: { x0: number; x1: number; y0: number; y1: number }, b: typeof a): boolean =>
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  it("leader lines never cross each other", () => {
    const all = c.labels.flatMap((l) => l.leaders.flatMap(segs));
    expect(all.length).toBeGreaterThan(0);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(cross(all[i]!, all[j]!)).toBe(false);
  });

  it("label pills clear every notehead and bracket, and each other", () => {
    for (const l of c.labels) {
      const r = pill(l);
      for (const h of c.heads) expect(hit(r, { x0: h.x - 12, x1: h.x + 13, y0: h.y - 5, y1: h.y + 5 })).toBe(false);
      for (const o of c.labels) if (o.bracket) expect(r.x1).toBeLessThan(o.bracket.x);
    }
    for (let i = 0; i < c.labels.length; i++) {
      for (let j = i + 1; j < c.labels.length; j++) expect(hit(pill(c.labels[i]!), pill(c.labels[j]!))).toBe(false);
    }
  });

  it("each leader ends at its notes' height", () => {
    for (const l of c.labels) for (const pts of l.leaders) {
      const [, ty] = pts.at(-1)!;
      expect(c.heads.some((h) => Math.abs(h.y - ty) < 12)).toBe(true);
    }
  });
});


describe("orchestration chart, interleaved pitch sets", () => {
  it("labels sharing a range fan out to their notes; brackets never overlap", () => {
    const ps: ChartPart[] = [{ name: "Violin I", family: "strings" }, { name: "Viola", family: "strings" }];
    const c = layoutChart([
      { midi: 79, name: "G5", parts: [0] }, { midi: 72, name: "C5", parts: [1] },
      { midi: 67, name: "G4", parts: [0] }, { midi: 60, name: "C4", parts: [1] },
    ], ps, colorOf, "mix");
    const brackets = c.labels.filter((l) => l.bracket);
    for (let i = 0; i < brackets.length; i++) for (let j = i + 1; j < brackets.length; j++) {
      const a = brackets[i]!.bracket!, b = brackets[j]!.bracket!;
      expect(a.y1 < b.y0 || b.y1 < a.y0 || a.x !== b.x).toBe(true);
    }
    // each fanned label reaches every one of its notes
    for (const l of c.labels.filter((x) => !x.bracket)) {
      expect(l.leaders.length).toBe(2);
    }
  });
});
