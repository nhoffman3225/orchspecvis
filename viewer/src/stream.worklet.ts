// AudioWorklet processor for streaming playback: plays chunks at sample-exact context
// frames. Logic lives in StreamQueue. Two ports:
// - this.port (main thread): the feeder port arrives here once; underrun counts go back
// - feeder (stream.feeder.ts worker, direct): cue/stop/chunks in, play position out
// so audio keeps flowing even when the main thread is busy rendering.

import { StreamQueue, type Chunk } from "./streamqueue";

// AudioWorkletGlobalScope (not in the DOM lib)
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type StreamMessage =
  | { type: "cue"; gen: number; srcFrame: number; ctxFrame: number }
  | { type: "stop"; gen: number }
  | ({ type: "chunk" } & Chunk);

/** Worklet -> feeder: the source frame playing now (for read-ahead). */
export interface PositionMessage {
  gen: number;
  srcFrame: number;
}

const REPORT_EVERY = 16; // render quanta (~43 ms at 48 kHz)

class StreamProcessor extends AudioWorkletProcessor {
  private q = new StreamQueue();
  private quanta = 0;
  private feeder: MessagePort | null = null;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<{ feeder?: MessagePort }>) => {
      if (!ev.data.feeder) return;
      this.feeder = ev.data.feeder;
      this.feeder.onmessage = (e: MessageEvent<StreamMessage>) => {
        const m = e.data;
        if (m.type === "cue") this.q.cue(m.gen, m.srcFrame, m.ctxFrame);
        else if (m.type === "stop") this.q.stop(m.gen);
        else this.q.push(m);
      };
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out) this.q.render(out, currentFrame);
    if (++this.quanta % REPORT_EVERY === 0) {
      const p = this.q.position(currentFrame);
      if (p) this.feeder?.postMessage(p satisfies PositionMessage);
      if (this.quanta % (REPORT_EVERY * 4) === 0) this.port.postMessage({ underruns: this.q.underruns, state: this.q.describe(currentFrame), feeder: !!this.feeder });
    }
    return true;
  }
}

registerProcessor("orchspec-stream", StreamProcessor);
