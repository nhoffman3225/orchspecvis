// AudioWorklet processor for streaming playback: plays chunks posted by the main thread
// (player.ts) at sample-exact context frames. Logic lives in StreamQueue.

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

class StreamProcessor extends AudioWorkletProcessor {
  private q = new StreamQueue();
  private quanta = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<StreamMessage>) => {
      const m = ev.data;
      if (m.type === "cue") this.q.cue(m.gen, m.srcFrame, m.ctxFrame);
      else if (m.type === "stop") this.q.stop(m.gen);
      else this.q.push(m);
    };
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out) this.q.render(out, currentFrame);
    if (++this.quanta % 64 === 0) this.port.postMessage({ underruns: this.q.underruns });
    return true;
  }
}

registerProcessor("orchspec-stream", StreamProcessor);
