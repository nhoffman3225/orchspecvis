// Web Audio playback driven by the Transport. The AudioContext exists even when the audio
// file is missing (e.g. the tiny test bundle), so the playhead still runs on its clock.
//
// WAV mixes stream: an AudioWorklet (stream.worklet.ts) plays ~1 s chunks fetched with HTTP
// Range requests a few seconds ahead of the playhead, so memory stays at a few MB instead
// of the whole decoded file (~460 MB for 20 min of stereo). Anything else (other formats,
// a server without Range support, a sample-rate mismatch) is decoded whole as before.

import { bundleUrl } from "./bundle";
import { Transport, audioContextTime } from "./clock";
import { fetchSameOrigin } from "./net";
import type { StreamMessage } from "./stream.worklet";
import workletUrl from "./stream.worklet.ts?worker&url";
import { parseWavHeader, toPlanar, type WavInfo } from "./wav";

const AHEAD_SEC = 5; // keep this much audio queued ahead of the playhead
const PUMP_MS = 100;
const START_LEAD_SEC = 0.08; // stream starts are scheduled this far ahead: the cue and the
// first chunk must reach the worklet before its start frame renders
const CACHE_CHUNKS = 24;
const HEAD_BYTES = [65536, 1 << 20]; // header probes (a big LIST chunk may push "data" out)

export type AudioMode = "none" | "stream" | "decoded";

export class Player {
  readonly ctx: AudioContext;
  readonly transport: Transport;
  private gain: GainNode;
  audioError: string | null = null;
  mode: AudioMode = "none";
  underruns = 0;

  // decoded mode
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  // stream mode
  private url = "";
  private wav: WavInfo | null = null;
  private node: AudioWorkletNode | null = null;
  private chunkFrames = 0;
  private cache = new Map<number, Promise<Float32Array[]>>();
  private gen = 0;
  private nextChunk = 0;
  private inflight = 0;
  private pumpTimer = 0;

  /** `sampleRate`: the mix rate, so streamed frames map 1:1 onto context frames. */
  constructor(duration: number, sampleRate?: number) {
    this.ctx = new AudioContext({ latencyHint: "interactive", ...(sampleRate ? { sampleRate } : {}) });
    const lead = (): number => (this.mode === "stream" ? START_LEAD_SEC : 0);
    this.transport = new Transport(audioContextTime(this.ctx, lead), duration);
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  async load(base: string, audioPath: string): Promise<void> {
    this.url = bundleUrl(base, audioPath);
    try {
      if (/\.wav$/i.test(audioPath) && (await this.tryStream())) return;
      const r = await fetchSameOrigin(this.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this.decodeWhole(r);
    } catch (e) {
      this.audioError = e instanceof Error ? e.message : String(e);
    }
  }

  private async decodeWhole(r: Response): Promise<void> {
    this.buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
    this.mode = "decoded";
  }

  /** Sets up streaming; false = use whole-file decoding instead. */
  private async tryStream(): Promise<boolean> {
    let info: WavInfo | null = null;
    for (const n of HEAD_BYTES) {
      const r = await fetchSameOrigin(this.url, { headers: { Range: `bytes=0-${n - 1}` } });
      if (r.status === 200) {
        await this.decodeWhole(r); // no Range support: we are getting the whole file anyway
        return true;
      }
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const total = Number(/\/(\d+)$/.exec(r.headers.get("Content-Range") ?? "")?.[1]);
      info = parseWavHeader(new Uint8Array(await r.arrayBuffer()), Number.isFinite(total) ? total : undefined);
      if (info) break;
    }
    if (!info || info.sampleRate !== this.ctx.sampleRate || !this.ctx.audioWorklet) return false;
    await this.ctx.audioWorklet.addModule(workletUrl);
    this.node = new AudioWorkletNode(this.ctx, "orchspec-stream", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (ev: MessageEvent<{ underruns: number }>) => {
      this.underruns = ev.data.underruns;
    };
    this.node.connect(this.gain);
    this.wav = info;
    this.chunkFrames = info.sampleRate; // 1 s
    this.mode = "stream";
    void this.chunk(0); // warm the start
    return true;
  }

  get hasAudio(): boolean {
    return this.mode !== "none";
  }

  // ---- stream mode

  private chunk(i: number): Promise<Float32Array[]> {
    let p = this.cache.get(i);
    if (p) {
      this.cache.delete(i); // LRU refresh
    } else {
      const w = this.wav!;
      const a = w.dataOffset + i * this.chunkFrames * w.blockAlign;
      const frames = Math.min(this.chunkFrames, w.frames - i * this.chunkFrames);
      p = fetchSameOrigin(this.url, { headers: { Range: `bytes=${a}-${a + frames * w.blockAlign - 1}` } })
        .then(async (r) => {
          if (r.status !== 206) throw new Error(`audio range: HTTP ${r.status}`);
          return toPlanar(new Uint8Array(await r.arrayBuffer()), w);
        });
      p.catch(() => this.cache.delete(i));
    }
    this.cache.set(i, p);
    while (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value as number);
    return p;
  }

  private post(m: StreamMessage, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(m, transfer);
  }

  private pump(): void {
    const w = this.wav;
    if (!w || !this.transport.isPlaying) return;
    const gen = this.gen;
    const until = Math.min(w.frames, (this.transport.position() + AHEAD_SEC) * w.sampleRate);
    while (this.inflight < 3 && this.nextChunk * this.chunkFrames < until) {
      const i = this.nextChunk++;
      this.inflight++;
      this.chunk(i)
        .then((data) => {
          if (gen !== this.gen) return;
          const copy = data.map((d) => d.slice()); // the cache keeps its own
          this.post({ type: "chunk", gen, start: i * this.chunkFrames, data: copy }, copy.map((d) => d.buffer));
        })
        .catch((e: unknown) => {
          this.audioError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => this.inflight--);
    }
  }

  // ---- both modes

  private startSource(offset: number): void {
    this.stopSource();
    if (this.mode === "stream" && this.wav) {
      const src = Math.round(offset * this.wav.sampleRate);
      this.gen++;
      this.post({ type: "cue", gen: this.gen, srcFrame: src,
        ctxFrame: Math.round(this.transport.anchorTime * this.ctx.sampleRate) });
      this.nextChunk = Math.floor(src / this.chunkFrames);
      this.inflight = 0;
      this.pump();
      this.pumpTimer = window.setInterval(() => this.pump(), PUMP_MS);
      return;
    }
    if (!this.buffer) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.connect(this.gain);
    s.start(this.transport.anchorTime, offset);
    this.source = s;
  }

  private stopSource(): void {
    if (this.mode === "stream") {
      clearInterval(this.pumpTimer);
      this.gen++;
      this.post({ type: "stop", gen: this.gen });
    }
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* already stopped */
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  async play(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
    const offset = this.transport.play();
    this.startSource(offset);
  }

  pause(): void {
    this.transport.pause();
    this.stopSource();
  }

  async toggle(): Promise<void> {
    if (this.transport.isPlaying) this.pause();
    else await this.play();
  }

  seek(t: number): void {
    const offset = this.transport.seek(t);
    if (this.transport.isPlaying) this.startSource(offset);
    else if (this.mode === "stream") void this.chunk(Math.floor((offset * this.ctx.sampleRate) / this.chunkFrames));
  }

  setVolume(v: number): void {
    this.gain.gain.value = v;
  }

  /** Per-frame update; returns the playhead in media seconds. */
  tick(): number {
    if (this.transport.tick()) this.stopSource();
    return this.transport.position();
  }
}
