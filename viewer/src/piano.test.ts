import { describe, expect, it } from "vitest";
import { keyLevelsAt } from "./heat";
import { isBlack, keyLayout, notesFromF0 } from "./piano";
import { HARM_PRESETS, harmSliderValue, snapHarm } from "./presets";

describe("keyboard layout", () => {
  const keys = keyLayout(520);
  it("has 88 keys, 52 white, 36 black", () => {
    expect(keys).toHaveLength(88);
    expect(keys.filter((k) => !k.black)).toHaveLength(52);
    expect(keys.filter((k) => k.black)).toHaveLength(36);
    expect(keys[0]).toMatchObject({ midi: 21, x: 0, w: 10, black: false }); // A0
    expect(keys[87]).toMatchObject({ midi: 108, black: false }); // C8
    expect(keys[87]!.x + keys[87]!.w).toBeCloseTo(520);
  });
  it("puts black keys on the boundary between their white neighbours", () => {
    const at = (m: number) => keys.find((k) => k.midi === m)!;
    const c4 = at(60), cs4 = at(61), d4 = at(62);
    expect(cs4.black && !c4.black && !d4.black).toBe(true);
    expect(cs4.x + cs4.w / 2).toBeCloseTo(d4.x);
    expect(isBlack(70) && !isBlack(71)).toBe(true); // A#4, B4
  });
});

describe("f0 tracks -> notes", () => {
  it("groups frames by key and drops blips", () => {
    // 2 rows x 10 frames at 0.1 s: row 0 A4 x4 then C5 x3; row 1 one-frame blip
    const f0 = new Float32Array(20);
    f0.fill(440, 0, 4);
    f0.fill(523.25, 4, 7);
    f0[15] = 220;
    const n = notesFromF0(f0, 2, 10, 0.1, 0.15);
    expect(n.n).toBe(2);
    expect(Array.from(n.midi)).toEqual([69, 72]);
    expect(n.onset_s[0]).toBeCloseTo(0);
    expect(n.offset_s[0]).toBeCloseTo(0.4);
    expect(n.onset_s[1]).toBeCloseTo(0.4);
    expect(Array.from(n.part)).toEqual([0, 0]);
  });
});

describe("live key levels", () => {
  it("reads the frame at t for each key", () => {
    const nBins = 88, frames = 10;
    const data = new Uint8Array(frames * nBins);
    data[3 * nBins + (69 - 21)] = 255;
    const page = { data, nBins, start: 0, frames, frameSec: 0.1 };
    const lv = keyLevelsAt(page, 1, 21, 0.3);
    expect(lv[69 - 21]).toBe(1);
    expect(lv[60 - 21]).toBe(0);
    expect(keyLevelsAt(page, 1, 21, 5)[69 - 21]).toBe(0); // outside the page
  });
});

describe("harmonics slider presets", () => {
  it("maps off/0 dB/-96 dB to slider values 0/1/97", () => {
    expect(harmSliderValue(null)).toBe(0);
    expect(harmSliderValue(0)).toBe(1);
    expect(harmSliderValue(-96)).toBe(97);
    expect(HARM_PRESETS[0]).toBeNull();
    expect(HARM_PRESETS[1]).toBe(0); // off first, then 0 dB, going down
  });
  it("snaps near presets but not off", () => {
    expect(snapHarm(12)).toBe(13); // -11 dB -> -12 dB preset
    expect(snapHarm(16)).toBe(16); // -15 dB: no preset nearby
    expect(snapHarm(2)).toBe(1); // -1 dB -> 0 dB
    expect(snapHarm(1)).toBe(1);
    expect(snapHarm(0)).toBe(0);
  });
});
