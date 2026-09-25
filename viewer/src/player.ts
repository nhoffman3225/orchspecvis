// Web Audio playback driven by the Transport. The AudioContext exists even when the audio
// file is missing (e.g. the tiny test bundle), so the playhead still runs on its clock.
//
// WAV mixes stream: an AudioWorklet (stream.worklet.ts) plays ~1 s chunks that a feeder
// worker (stream.feeder.ts) fetches with HTTP Range requests a few seconds ahead of the
// play position and posts straight to the worklet — memory stays at a few MB instead of
// the whole decoded file (~460 MB for 20 min of stereo), and a busy main thread cannot
// starve the audio. Anything else (other formats, a server without Range support, a
// sample-rate mismatch) is decoded whole as before.

import { bundleUrl } from "./bundle";
import { Transport, audioContextTime } from "./clock";
import { fetchSameOrigin } from "./net";
import type { FeederRequest } from "./stream.feeder";
import workletUrl from "./stream.worklet.ts?worker&url";
import { parseWavHeader, type WavInfo } from "./wav";

const START_LEAD_SEC = 0.08; // stream starts are scheduled this far ahead: the cue and the
// first chunk must reach the worklet before its start frame renders
const HEAD_BYTES = [65536, 1 << 20]; // header probes (a big LIST chunk may push "data" out)

export type AudioMode = "none" | "stream" | "decoded";

export class Player {
  readonly ctx: AudioContext;
  readonly transport: Transport;
  private gain: GainNode;
  audioError: string | null = null;
  mode: AudioMode = "none";
  underruns = 0;
  streamState = ""; // worklet diagnostics

  // decoded mode
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  // stream mode
  private url = "";
  private wav: WavInfo | null = null;
  private node: AudioWorkletNode | null = null;
  private feeder: Worker | null = null;
  private gen = 0;

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
    this.node.port.onmessage = (ev: MessageEvent<{ underruns: number; state: string; feeder: boolean }>) => {
      this.underruns = ev.data.underruns;
      this.streamState = `${ev.data.state}${ev.data.feeder ? "" : " (no feeder port)"}`;
    };
    this.node.connect(this.gain);
    // feeder worker <-> worklet, directly
    const ch = new MessageChannel();
    this.node.port.postMessage({ feeder: ch.port1 }, [ch.port1]);
    this.feeder = new Worker(new URL("./stream.feeder.ts", import.meta.url), { type: "module" });
    this.feeder.onmessage = (ev: MessageEvent<{ error?: string }>) => {
      if (ev.data.error) this.audioError = ev.data.error;
    };
    this.toFeeder({ type: "init", url: new URL(this.url, location.href).href, search: location.search,
      wav: info, port: ch.port2 }, [ch.port2]);
    this.wav = info;
    this.mode = "stream";
    return true;
  }

  get hasAudio(): boolean {
    return this.mode !== "none";
  }

  // ---- stream mode

  private toFeeder(m: FeederRequest, transfer: Transferable[] = []): void {
    this.feeder?.postMessage(m, transfer);
  }

  // ---- both modes

  private startSource(offset: number): void {
    this.stopSource();
    if (this.mode === "stream" && this.wav) {
      this.toFeeder({ type: "cue", gen: ++this.gen, srcFrame: Math.round(offset * this.wav.sampleRate),
        ctxFrame: Math.round(this.transport.anchorTime * this.ctx.sampleRate) });
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
    if (this.mode === "stream") this.toFeeder({ type: "stop", gen: ++this.gen });
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
    else if (this.mode === "stream") this.toFeeder({ type: "prefetch", srcFrame: Math.round(offset * this.ctx.sampleRate) });
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
