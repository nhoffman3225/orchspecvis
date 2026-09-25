import { describe, expect, it } from "vitest";
import { chordXml, condense, ink, parsePitch, pitchClassSet, scaleXml, toHex, type MapNote } from "./condense";

const note = (midi: number, name: string, parts: number[], bar = 0): MapNote => ({ midi, name, parts, group: 0, bar });

describe("condensing a selection", () => {
  const map: Record<string, MapNote> = {
    a: note(63, "E♭4", [0]),
    b: note(63, "E♭4", [1]), // unison, another part
    c: note(55, "G3", [2]),
    d: note(72, "C5", [0]),
    e: note(48, "C3", [3]),
    f: note(70, "B♭4", [1]),
  };
  const color = (parts: number[]): string => ["#ff0000", "#00ff00", "#0000ff", "#888888"][parts[0]!]!;

  it("parses spelled pitch names", () => {
    expect(parsePitch("E♭5")).toEqual({ step: "E", alter: -1, octave: 5 });
    expect(parsePitch("F♯3")).toEqual({ step: "F", alter: 1, octave: 3 });
    expect(parsePitch("C4")).toEqual({ step: "C", alter: 0, octave: 4 });
  });

  it("merges unisons and keeps every part", () => {
    const ch = condense(["a", "b", "c", "d", "missing"], map, color);
    expect(ch.map((p) => p.name)).toEqual(["G3", "E♭4", "C5"]);
    expect(ch[1]).toMatchObject({ parts: [0, 1], color: "#ff0000" });
  });

  it("presents the pitch-class set ascending from the lowest note, one octave", () => {
    const set = pitchClassSet(condense(["a", "c", "d", "e", "f"], map, color));
    expect(set.map((s) => s.name)).toEqual(["C", "E♭", "G", "B♭"]);
    expect(set.map((s) => s.pitch.octave)).toEqual([4, 4, 4, 4]);
    // from G: G B♭ C E♭ climbs into the next octave
    const fromG = pitchClassSet(condense(["c", "f", "d", "a"], map, color));
    expect(fromG.map((s) => `${s.name}${s.pitch.octave}`)).toEqual(["G4", "B♭4", "C5", "E♭5"]);
  });

  it("writes MusicXML Verovio can engrave (colours, accidentals, stemless scale)", () => {
    const ch = condense(["a", "c", "d", "e"], map, color);
    const x = chordXml(ch, "m. 1");
    expect(x).toContain('color="#ff0000"');
    expect(x).toContain("<accidental>flat</accidental>");
    expect((x.match(/<chord\/>/g) ?? []).length).toBe(ch.length - 2); // one chord per staff
    const s = scaleXml(pitchClassSet(ch));
    expect((s.match(/<stem>none<\/stem>/g) ?? []).length).toBe(3);
  });

  it("darkens UI colours into readable ink, keeping the hue", () => {
    const c = ink("#6fcf97"); // pale green (woodwinds)
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r!);
    expect(g).toBeGreaterThan(b!);
    expect(Math.max(r!, g!, b!)).toBeLessThan(170);
  });

  it("converts CSS colours to hex", () => {
    expect(toHex("rgb(255, 16, 0)")).toBe("#ff1000");
    expect(toHex("#abc")).toBe("#aabbcc");
  });
});
