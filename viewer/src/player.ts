// Web Audio playback driven by the Transport. The AudioContext exists even when the audio
// file is missing (e.g. the tiny test bundle), so the playhead still runs on its clock.

import { bundleUrl } from "./bundle";
import { Transport, audioContextTime } from "./clock";
import { fetchSameOrigin } from "./net";

export class Player {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  readonly transport: Transport;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain = this.ctx.createGain();
  audioError: string | null = null;

  constructor(duration: number) {
    this.transport = new Transport(audioContextTime(this.ctx), duration);
    this.gain.connect(this.ctx.destination);
  }

  async load(base: string, audioPath: string): Promise<void> {
    try {
      const r = await fetchSameOrigin(bundleUrl(base, audioPath));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
    } catch (e) {
      this.audioError = e instanceof Error ? e.message : String(e);
    }
  }

  get hasAudio(): boolean {
    return this.buffer !== null;
  }

  private startSource(offset: number): void {
    this.stopSource();
    if (!this.buffer) return;
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.connect(this.gain);
    s.start(this.transport.anchorTime, offset);
    this.source = s;
  }

  private stopSource(): void {
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
