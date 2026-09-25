// Playback clock. The AudioContext is the master clock. Sources are scheduled on
// ctx.currentTime; the playhead is read from getOutputTimestamp().contextTime when
// available (the context time of the sample being heard now, i.e. after output latency),
// otherwise currentTime - outputLatency.

export interface TimeSource {
  /** Context seconds of the sample audible right now. */
  now(): number;
  /** Context seconds at which a source started now would begin (ctx.currentTime). */
  scheduleNow(): number;
}

/** `lead()`: seconds to schedule starts ahead of currentTime (time for data to arrive). */
export function audioContextTime(ctx: AudioContext, lead: () => number = () => 0): TimeSource {
  return {
    now(): number {
      const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : undefined;
      if (ts && typeof ts.contextTime === "number" && ts.contextTime > 0) return ts.contextTime;
      return Math.max(0, ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0));
    },
    scheduleNow: () => ctx.currentTime + lead(),
  };
}

/** Pure transport state machine; the audio graph is driven by the Player around it. */
export class Transport {
  private playing = false;
  private offset = 0; // media seconds at `anchor`
  private anchor = 0; // context seconds when playback of `offset` starts

  constructor(
    private src: TimeSource,
    readonly duration: number,
  ) {}

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Context time at which the current offset is (or was) scheduled to start. */
  get anchorTime(): number {
    return this.anchor;
  }

  position(): number {
    if (!this.playing) return this.offset;
    // Before the first scheduled sample becomes audible, stay at the offset.
    const p = this.offset + Math.max(0, this.src.now() - this.anchor);
    return Math.min(p, this.duration);
  }

  /** Starts playback; returns the media offset to start the source at. */
  play(): number {
    if (this.playing) return this.position();
    if (this.offset >= this.duration) this.offset = 0;
    this.anchor = this.src.scheduleNow();
    this.playing = true;
    return this.offset;
  }

  pause(): number {
    this.offset = this.position();
    this.playing = false;
    return this.offset;
  }

  seek(t: number): number {
    this.offset = Math.min(Math.max(0, t), this.duration);
    if (this.playing) this.anchor = this.src.scheduleNow();
    return this.offset;
  }

  /** Called every frame; stops at the end. Returns true if it just ended. */
  tick(): boolean {
    if (this.playing && this.position() >= this.duration) {
      this.offset = this.duration;
      this.playing = false;
      return true;
    }
    return false;
  }
}
