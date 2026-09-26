import { describe, expect, it } from "vitest";
import { buildRequest, suggestName, type Picks } from "./home";

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
