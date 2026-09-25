// Sample-accurate chunk queue behind the streaming AudioWorklet (stream.worklet.ts).
// Pure logic (no Web Audio globals) so it is unit-tested directly.
//
// The main thread says "source frame F plays at context frame A" (cue) and sends planar
// chunks tagged with their absolute source frame. Output frame x (context frame) then
// plays source frame F + (x - A). Missing data is silence, never a shift in time, so the
// audio stays locked to the transport clock even after an underrun.

export interface Chunk {
  gen: number;
  start: number; // absolute source frame of data[c][0]
  data: Float32Array[]; // planar; 1 or 2 channels
}

export class StreamQueue {
  private gen = -1;
  private playing = false;
  private srcAt = 0; // source frame ...
  private ctxAt = 0; // ... that plays at this context frame
  private chunks: Chunk[] = [];
  underruns = 0; // render quanta with missing data while playing

  cue(gen: number, srcFrame: number, ctxFrame: number): void {
    this.gen = gen;
    this.playing = true;
    this.srcAt = srcFrame;
    this.ctxAt = ctxFrame;
    this.chunks = this.chunks.filter((c) => c.gen === gen);
  }

  stop(gen: number): void {
    this.gen = gen;
    this.playing = false;
    this.chunks = [];
  }

  push(c: Chunk): void {
    if (c.gen !== this.gen) return; // stale (sent before a seek)
    this.chunks.push(c);
    this.chunks.sort((a, b) => a.start - b.start);
  }

  /** Fills `out` (planar, e.g. 2 x 128) for the render quantum starting at `ctxFrame`. */
  render(out: Float32Array[], ctxFrame: number): void {
    for (const o of out) o.fill(0);
    const len = out[0]?.length ?? 0;
    if (!this.playing || !len) return;
    const src0 = this.srcAt + (ctxFrame - this.ctxAt);
    // drop chunks that ended before this quantum
    while (this.chunks.length && this.chunks[0]!.start + this.chunks[0]!.data[0]!.length <= src0) {
      this.chunks.shift();
    }
    let filled = 0;
    for (const c of this.chunks) {
      const n = c.data[0]!.length;
      const a = Math.max(src0, c.start, this.srcAt); // nothing before the cue point
      const b = Math.min(src0 + len, c.start + n);
      if (b <= a) continue;
      for (let ch = 0; ch < out.length; ch++) {
        const src = c.data[Math.min(ch, c.data.length - 1)]!; // mono -> both outputs
        out[ch]!.set(src.subarray(a - c.start, b - c.start), a - src0);
      }
      filled += b - a;
    }
    // before the cue point (scheduled start) silence is expected, not an underrun
    const expected = Math.max(0, Math.min(len, src0 + len - this.srcAt));
    if (filled < expected) this.underruns++;
  }
}
