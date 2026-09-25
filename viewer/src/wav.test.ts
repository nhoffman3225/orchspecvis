import { describe, expect, it } from "vitest";
import { parseWavHeader, toPlanar } from "./wav";

/** Builds a WAV file: fmt chunk (optionally extensible), an optional LIST chunk, data. */
function wav(o: { format: number; bits: number; channels: number; sr: number; data: Uint8Array;
  list?: number; extensible?: boolean }): Uint8Array {
  const fmtLen = o.extensible ? 40 : 16;
  const listLen = o.list ?? 0;
  const size = 12 + 8 + fmtLen + (listLen ? 8 + listLen + (listLen & 1) : 0) + 8 + o.data.length;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  const tag = (at: number, s: string): void => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, size - 8, true); tag(8, "WAVE");
  let p = 12;
  tag(p, "fmt "); v.setUint32(p + 4, fmtLen, true);
  const align = (o.channels * o.bits) / 8;
  v.setUint16(p + 8, o.extensible ? 0xfffe : o.format, true);
  v.setUint16(p + 10, o.channels, true); v.setUint32(p + 12, o.sr, true);
  v.setUint32(p + 16, o.sr * align, true); v.setUint16(p + 20, align, true); v.setUint16(p + 22, o.bits, true);
  if (o.extensible) v.setUint16(p + 32, o.format, true);
  p += 8 + fmtLen;
  if (listLen) { tag(p, "LIST"); v.setUint32(p + 4, listLen, true); p += 8 + listLen + (listLen & 1); }
  tag(p, "data"); v.setUint32(p + 4, o.data.length, true);
  b.set(o.data, p + 8);
  return b;
}

describe("wav", () => {
  it("parses 16-bit PCM stereo and converts to planar floats", () => {
    const d = new Uint8Array(8); const dv = new DataView(d.buffer);
    dv.setInt16(0, 16384, true); dv.setInt16(2, -32768, true); dv.setInt16(4, 0, true); dv.setInt16(6, 32767, true);
    const f = wav({ format: 1, bits: 16, channels: 2, sr: 48000, data: d });
    const info = parseWavHeader(f, f.length)!;
    expect(info).toMatchObject({ sampleRate: 48000, channels: 2, bits: 16, float: false, frames: 2, blockAlign: 4 });
    const [l, r] = toPlanar(f.subarray(info.dataOffset), info);
    expect(Array.from(l!)).toEqual([0.5, 0]);
    expect(r![0]).toBe(-1);
    expect(r![1]).toBeCloseTo(1, 4);
  });

  it("handles 24-bit sign extension, extensible float and odd LIST chunks", () => {
    const d24 = Uint8Array.from([0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]); // -1, ~+1 (mono)
    const f24 = wav({ format: 1, bits: 24, channels: 1, sr: 44100, data: d24, list: 3 });
    const i24 = parseWavHeader(f24)!;
    expect(i24.frames).toBe(2);
    const [m] = toPlanar(f24.subarray(i24.dataOffset), i24);
    expect(m![0]).toBe(-1);
    expect(m![1]).toBeCloseTo(1, 5);

    const df = new Uint8Array(8); new DataView(df.buffer).setFloat32(0, 0.25, true);
    const ff = wav({ format: 3, bits: 32, channels: 2, sr: 48000, data: df, extensible: true });
    const inf = parseWavHeader(ff)!;
    expect(inf.float).toBe(true);
    expect(toPlanar(ff.subarray(inf.dataOffset), inf)[0]![0]).toBe(0.25);
  });

  it("asks for more bytes, and rejects non-WAV / unsupported formats", () => {
    const f = wav({ format: 1, bits: 16, channels: 2, sr: 48000, data: new Uint8Array(4), list: 5000 });
    expect(parseWavHeader(f.subarray(0, 1000))).toBeNull();
    expect(() => parseWavHeader(new TextEncoder().encode("ID3xxxxxxxxxxxxx"))).toThrow(/RIFF/);
    const alaw = wav({ format: 6, bits: 8, channels: 1, sr: 8000, data: new Uint8Array(2) });
    expect(() => parseWavHeader(alaw)).toThrow(/format 6/);
  });

  it("keeps at most two channels", () => {
    const f = wav({ format: 1, bits: 16, channels: 6, sr: 48000, data: new Uint8Array(24) });
    const info = parseWavHeader(f)!;
    expect(toPlanar(f.subarray(info.dataOffset), info).length).toBe(2);
  });
});
