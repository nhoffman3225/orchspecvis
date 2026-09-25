// Loading indicators next to slow controls. Each key ("display", "page", "registers", …)
// counts its pending jobs; spinners with data-busy="<key>" show after a short delay
// (quick jobs never flicker) and hide when the count drops to zero.

export type Show = (key: string, on: boolean) => void;

export class Busy {
  private counts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private show: Show, private delayMs = 120) {}

  /** Marks one job under `key` as started; call the returned function when it ends. */
  start(key: string): () => void {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n === 1) this.timers.set(key, setTimeout(() => this.show(key, true), this.delayMs));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      this.counts.set(key, left);
      if (left === 0) {
        clearTimeout(this.timers.get(key));
        this.timers.delete(key);
        this.show(key, false);
      }
    };
  }

  /** Tracks a promise under `key`. */
  while<T>(key: string, p: Promise<T>): Promise<T> {
    const end = this.start(key);
    return p.finally(end);
  }

  pending(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

/** The app-wide instance: toggles `.spin[data-busy="key"]` elements. */
export const busy = new Busy((key, on) => {
  for (const el of document.querySelectorAll<HTMLElement>(`.spin[data-busy="${key}"]`)) el.hidden = !on;
});
