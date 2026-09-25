import { describe, expect, it } from "vitest";
import { StreamQueue } from "./streamqueue";

const ramp = (start: number, n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => start + i);
const quantum = (): Float32Array[] => [new Float32Array(4), new Float32Array(4)];

describe("StreamQueue", () => {
  it("plays source frames at the cued context frame, across chunk borders", () => {
    const q = new StreamQueue();
    q.cue(1, 100, 1000); // source 100 at context 1000
    q.push({ gen: 1, start: 96, data: [ramp(96, 6)] }); // 96..101, mono
    q.push({ gen: 1, start: 102, data: [ramp(102, 6)] });
    const out = quantum();
    q.render(out, 998); // two frames of lead-in before the cue point
    expect(Array.from(out[0]!)).toEqual([0, 0, 100, 101]);
    expect(Array.from(out[1]!)).toEqual([0, 0, 100, 101]); // mono on both outputs
    q.render(out, 1002);
    expect(Array.from(out[0]!)).toEqual([102, 103, 104, 105]);
    expect(q.underruns).toBe(0);
  });

  it("silence after the end of the source is not an underrun", () => {
    const q = new StreamQueue();
    q.cue(1, 0, 0, 6);
    q.push({ gen: 1, start: 0, data: [ramp(0, 6)] });
    const out = quantum();
    q.render(out, 4); // frames 4, 5 real; 6, 7 past the end
    expect(Array.from(out[0]!)).toEqual([4, 5, 0, 0]);
    q.render(out, 8);
    expect(q.underruns).toBe(0);
  });

  it("underruns stay silent without shifting time; stale chunks are ignored", () => {
    const q = new StreamQueue();
    q.cue(1, 0, 0);
    const out = quantum();
    q.render(out, 0);
    expect(q.underruns).toBe(1);
    q.push({ gen: 1, start: 4, data: [ramp(4, 8), ramp(-4, 8)] });
    q.render(out, 4); // data arrived: plays source 4.., not 0..
    expect(Array.from(out[0]!)).toEqual([4, 5, 6, 7]);
    expect(Array.from(out[1]!)).toEqual([-4, -3, -2, -1]);
    q.cue(2, 50, 8); // seek
    q.push({ gen: 1, start: 50, data: [ramp(999, 8)] }); // sent before the seek
    q.render(out, 8);
    expect(Array.from(out[0]!)).toEqual([0, 0, 0, 0]);
    expect(q.position(10)).toEqual({ gen: 2, srcFrame: 52 });
    expect(q.position(0)).toEqual({ gen: 2, srcFrame: 50 }); // before the cue: the cue frame
    q.stop(3);
    expect(q.position(20)).toBeNull();
    q.push({ gen: 3, start: 0, data: [ramp(1, 8)] });
    q.render(out, 12);
    expect(Array.from(out[0]!)).toEqual([0, 0, 0, 0]); // stopped
  });
});
