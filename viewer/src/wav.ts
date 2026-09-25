// Minimal RIFF/WAVE reader for streaming playback: parse the header, then convert byte
// ranges of the data chunk to planar Float32 (what Web Audio plays). Bundles copy the mix
// byte-identically, so this covers PCM 8/16/24/32-bit and IEEE float 32/64.

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  float: boolean;
  blockAlign: number; // bytes per frame (all channels)
  dataOffset: number; // byte offset of the first sample
  frames: number; // frames in the data chunk
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * Parses the header from the first bytes of a WAV file. Returns null when the data chunk
 * header is not inside `head` yet (read more and retry); throws on non-WAV / unsupported.
 */
export function parseWavHeader(head: Uint8Array, fileSize?: number): WavInfo | null {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (o: number): string => String.fromCharCode(head[o]!, head[o + 1]!, head[o + 2]!, head[o + 3]!);
  if (head.length < 12) return null;
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let fmt: Omit<WavInfo, "dataOffset" | "frames"> | null = null;
  let o = 12;
  while (o + 8 <= head.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      if (body + 16 > head.length) return null;
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      const blockAlign = v.getUint16(body + 12, true);
      const bits = v.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE) {
        if (body + 26 > head.length) return null;
        format = v.getUint16(body + 24, true); // first two bytes of the SubFormat GUID
      }
      const float = format === WAVE_FORMAT_IEEE_FLOAT;
      if (!(format === WAVE_FORMAT_PCM || float)) throw new Error(`unsupported WAV format ${format}`);
      if (float ? !(bits === 32 || bits === 64) : ![8, 16, 24, 32].includes(bits)) {
        throw new Error(`unsupported WAV sample size ${bits}`);
      }
      if (!channels || blockAlign !== (channels * bits) / 8) throw new Error("inconsistent WAV fmt chunk");
      fmt = { sampleRate, channels, bits, float, blockAlign };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data chunk before fmt chunk");
      // streaming writers leave 0 or 0xFFFFFFFF; then the data runs to the end of the file
      let bytes = size;
      if ((size === 0 || size === 0xffffffff) && fileSize !== undefined) bytes = fileSize - body;
      if (fileSize !== undefined) bytes = Math.min(bytes, fileSize - body);
      return { ...fmt, dataOffset: body, frames: Math.floor(bytes / fmt.blockAlign) };
    }
    o = body + size + (size & 1); // chunks are word-aligned
  }
  return null;
}

/** Interleaved sample bytes (whole frames) -> planar Float32, at most `maxChannels`. */
export function toPlanar(bytes: Uint8Array, info: WavInfo, maxChannels = 2): Float32Array[] {
  const n = Math.floor(bytes.length / info.blockAlign);
  const ch = Math.min(info.channels, maxChannels);
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = info.bits / 8;
  const read: (o: number) => number = info.float
    ? info.bits === 32 ? (o) => v.getFloat32(o, true) : (o) => v.getFloat64(o, true)
    : info.bits === 8 ? (o) => (v.getUint8(o) - 128) / 128
    : info.bits === 16 ? (o) => v.getInt16(o, true) / 32768
    : info.bits === 24 ? (o) => ((v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getInt8(o + 2) << 16)) / 8388608)
    : (o) => v.getInt32(o, true) / 2147483648;
  for (let f = 0; f < n; f++) {
    const base = f * info.blockAlign;
    for (let c = 0; c < ch; c++) out[c]![f] = read(base + c * bps);
  }
  return out;
}
