import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Busy } from "./busy";

describe("Busy", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("shows only for slow jobs and hides when the last one ends", () => {
    const log: string[] = [];
    const b = new Busy((k, on) => log.push(`${k}:${on}`), 120);
    const quick = b.start("display");
    vi.advanceTimersByTime(50);
    quick();
    vi.advanceTimersByTime(500);
    expect(log).toEqual(["display:false"]); // never shown

    log.length = 0;
    const a = b.start("page");
    const c = b.start("page");
    vi.advanceTimersByTime(130);
    expect(log).toEqual(["page:true"]);
    a();
    a(); // idempotent
    expect(log).toEqual(["page:true"]);
    c();
    expect(log).toEqual(["page:true", "page:false"]);
    expect(b.pending("page")).toBe(0);
  });

  it("tracks promises", async () => {
    const log: string[] = [];
    const b = new Busy((k, on) => log.push(`${k}:${on}`), 10);
    let resolve!: () => void;
    const p = b.while("reg", new Promise<void>((r) => (resolve = r)));
    vi.advanceTimersByTime(20);
    resolve();
    await p;
    expect(log).toEqual(["reg:true", "reg:false"]);
  });
});
