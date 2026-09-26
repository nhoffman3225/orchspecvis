import { describe, expect, it } from "vitest";
import { buildRequest, featuresFor, suggestName, type Picks } from "./home";

const none: Picks = { musicxml: null, midi: null, stems: [], mix: null, pdf: null };

describe("bundle wizard", () => {
  it("needs the stems or a mix", () => {
    expect(buildRequest("x", none)).toEqual({ error: "Choose the stems, the mix, or both." });
    const r = buildRequest(" My Piece ", { ...none, mix: "C:/a/mix.wav", midi: "C:/a/render.mid" });
    expect(r).toEqual({ body: { name: "My Piece", stems: [], mix: "C:/a/mix.wav", midi: "C:/a/render.mid" } });
  });

  it("suggests a name from the score, else the stems' session folder", () => {
    expect(suggestName({ ...none, musicxml: "D:/scores/Beethoven 5.musicxml" })).toBe("Beethoven 5");
    expect(suggestName({ ...none, stems: ["D:\\Renders\\Bolero\\stems\\01_Flute.wav"] })).toBe("Bolero");
    expect(suggestName({ ...none, mix: "D:/Renders/Take 3/mix.wav" })).toBe("Take 3");
    expect(suggestName(none)).toBe("Untitled");
    // an unnamed build falls back to the suggestion
    const r = buildRequest("  ", { ...none, musicxml: "x/Ravel.mxl", stems: ["y/01_A.wav"] });
    expect("body" in r && r.body.name).toBe("Ravel");
  });
});

describe("wizard feature summary", () => {
  const on = (p: Picks): string[] => featuresFor(p).filter((f) => f.on).map((f) => f.name);
  it("stems only: spectrum and per-instrument views, no notes or score views", () => {
    const got = on({ ...none, stems: ["a/01_A.wav"] });
    expect(got).toContain("Per-instrument views");
    expect(got).not.toContain("Engraved score view");
    expect(got).not.toContain("Notes on the spectrum, piano notes");
  });
  it("MIDI gives notes but no engraved score or tutti; MusicXML gives both", () => {
    expect(on({ ...none, mix: "m.wav", midi: "r.mid" })).toContain("Notes on the spectrum, piano notes");
    expect(on({ ...none, mix: "m.wav", midi: "r.mid" })).not.toContain("Tutti view");
    const full = on({ musicxml: "s.musicxml", midi: "r.mid", stems: ["01_A.wav"], mix: null, pdf: "s.pdf" });
    expect(full).toHaveLength(featuresFor(none).length); // everything
  });
  it("nothing chosen: not even the spectrum", () => {
    expect(on(none)).toEqual([]);
  });
});
