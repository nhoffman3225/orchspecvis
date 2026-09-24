// TS half of the cross-language schema test: parse the manifest written by the Python
// writer (tests/fixtures/make_tiny_bundle.py -> public/tiny-bundle/manifest.json).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BundleError, binToMidi, midiName, midiToBin, notesFromBuffer, parseManifest } from "./bundle";

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8"));

const TINY = "../public/tiny-bundle/manifest.json";

describe("manifest v1/v2", () => {
  it("parses the Python-written tiny bundle", () => {
    const m = parseManifest(read(TINY));
    expect(m.schema_version).toBe(2);
    expect(m.lods[0]!.n_frames).toBe(m.n_frames);
    expect(midiToBin(m, 69)).toBe(48);
    expect(binToMidi(m, 48)).toBe(69);
    expect(midiName(69)).toBe("A4");
    expect(midiName(60)).toBe("C4");
    expect(midiName(21)).toBe("A0");
  });

  // Written by tests/test_bundle_writer.py (Phase 1) when present: a real CQT bundle.
  const real = fileURLToPath(new URL("../test-data/py-bundle/manifest.json", import.meta.url));
  it.skipIf(!existsSync(real))("parses a Python CQT-writer bundle with stems", () => {
    const m = parseManifest(JSON.parse(readFileSync(real, "utf-8")));
    expect(m.stems.length).toBeGreaterThan(0);
    expect(m.dominant).not.toBeNull();
    expect(m.features.map((f) => f.name)).toContain("lufs_short_term");
  });

  const score = fileURLToPath(new URL("../test-data/py-score-bundle/manifest.json", import.meta.url));
  it.skipIf(!existsSync(score))("parses a Python-written v2 bundle with a score", () => {
    const m = parseManifest(JSON.parse(readFileSync(score, "utf-8")));
    expect(m.schema_version).toBe(2);
    expect(m.score?.parts.map((p) => p.range_id)).toEqual(["flute", "clarinet_bb", "double_bass", "piano"]);
    expect(m.score?.measures.map((x) => x.number)).toEqual(["1", "2", "3", "2", "4", "5"]);
    const file = fileURLToPath(new URL(`../test-data/py-score-bundle/${m.score!.notes.path}`, import.meta.url));
    const b = readFileSync(file);
    const notes = notesFromBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, m.score!.notes.n);
    expect(notes.n).toBe(m.score!.notes.n);
    expect(Array.from(notes.part).every((p) => p >= 0 && p < 4)).toBe(true);
    // onsets are audio seconds (offset applied): the first note comes after the ~0.537 s offset
    expect(Math.min(...notes.onset_s)).toBeGreaterThan(0.5);
  });

  const bad: [string, (d: Record<string, unknown>) => void, RegExp][] = [
    ["traversal", (d) => (d.audio_path = "../x.wav"), /inside the bundle/],
    ["absolute", (d) => (d.audio_path = "/etc/passwd"), /inside the bundle/],
    ["drive", (d) => (d.audio_path = "C:/x.wav"), /inside the bundle/],
    ["unknown key", (d) => (d.surprise = 1), /unknown field 'surprise'/],
    ["version", (d) => (d.schema_version = 3), /unsupported version/],
    ["frames", (d) => (d.n_frames = (d.n_frames as number) + 1), /n_frames/],
  ];
  for (const [name, mutate, re] of bad) {
    it(`rejects ${name}`, () => {
      const d = read(TINY) as Record<string, unknown>;
      mutate(d);
      expect(() => parseManifest(d)).toThrow(BundleError);
      expect(() => parseManifest(d)).toThrow(re);
    });
  }
});
