// Web Worker that feeds the streaming AudioWorklet: reads the mix WAV in 1 s Range chunks
// a few seconds ahead of the play position the worklet reports, and posts them straight
// to the worklet over a MessageChannel. The main thread only sends cue/stop/prefetch, so
// a busy render loop cannot starve the audio.

import { fetchSameOrigin, initToken } from "./net";
import type { PositionMessage, StreamMessage } from "./stream.worklet";
import { toPlanar, type WavInfo } from "./wav";

export type FeederRequest =
  | { type: "init"; url: string; search: string; wav: WavInfo; port: MessagePort }
  | { type: "cue"; gen: number; srcFrame: number; ctxFrame: number }
  | { type: "stop"; gen: number }
  | { type: "prefetch"; srcFrame: number };

const AHEAD_SEC = 5; // keep this much audio queued ahead of the play position
const CACHE_CHUNKS = 24;
const MAX_INFLIGHT = 3;

let url = "";
let wav: WavInfo | null = null;
let port: MessagePort | null = null;
let chunkFrames = 0;
const cache = new Map<number, Promise<Float32Array[]>>();
let gen = 0;
let playing = false;
let nextChunk = 0;
let inflight = 0;
let pos = 0; // source frame playing now (from the worklet), or the cue frame

function chunk(i: number): Promise<Float32Array[]> {
  let p = cache.get(i);
  if (p) {
    cache.delete(i); // LRU refresh
  } else {
    const w = wav!;
    const a = w.dataOffset + i * chunkFrames * w.blockAlign;
    const frames = Math.min(chunkFrames, w.frames - i * chunkFrames);
    p = fetchSameOrigin(url, { headers: { Range: `bytes=${a}-${a + frames * w.blockAlign - 1}` } })
      .then(async (r) => {
        if (r.status !== 206) throw new Error(`audio range: HTTP ${r.status}`);
        return toPlanar(new Uint8Array(await r.arrayBuffer()), w);
      });
    p.catch(() => cache.delete(i));
  }
  cache.set(i, p);
  while (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value as number);
  return p;
}

function pump(): void {
  const w = wav;
  if (!w || !port || !playing) return;
  const g = gen;
  const until = Math.min(w.frames, pos + AHEAD_SEC * w.sampleRate);
  while (inflight < MAX_INFLIGHT && nextChunk * chunkFrames < until) {
    const i = nextChunk++;
    inflight++;
    chunk(i)
      .then((data) => {
        if (g !== gen) return;
        const copy = data.map((d) => d.slice()); // the cache keeps its own
        port!.postMessage({ type: "chunk", gen: g, start: i * chunkFrames, data: copy } satisfies StreamMessage,
          copy.map((d) => d.buffer));
      })
      .catch((e: unknown) => self.postMessage({ error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        if (g !== gen) return; // a cue reset the count; stale fetches do not touch it
        inflight--;
        pump();
      });
  }
}

self.onmessage = (ev: MessageEvent<FeederRequest>) => {
  const m = ev.data;
  if (m.type === "init") {
    url = m.url;
    wav = m.wav;
    chunkFrames = m.wav.sampleRate; // 1 s
    initToken(m.search);
    port = m.port;
    port.onmessage = (e: MessageEvent<PositionMessage>) => {
      if (e.data.gen !== gen) return;
      pos = e.data.srcFrame;
      pump();
    };
    void chunk(0); // warm the start
  } else if (m.type === "cue") {
    gen = m.gen;
    playing = true;
    pos = m.srcFrame;
    nextChunk = Math.floor(m.srcFrame / chunkFrames);
    inflight = 0;
    port?.postMessage(m satisfies StreamMessage);
    pump();
  } else if (m.type === "stop") {
    gen = m.gen;
    playing = false;
    port?.postMessage(m satisfies StreamMessage);
  } else if (wav) {
    void chunk(Math.floor(m.srcFrame / chunkFrames));
  }
};
