// verovioCore against the real Verovio toolkit (what the score worker runs).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { VerovioToolkit } from "verovio/esm";
import { elementTimes, layout, notatedId, renderPage, verovioOptions } from "./verovioCore";

const FIXTURE = fileURLToPath(new URL("../test-data/py-score-bundle/score/score.musicxml", import.meta.url));
const OPTS = { scale: 40, widthPx: 1400, heightPx: 900, condense: false };

it("normalizes repeat-expansion ids", () => {
  expect(notatedId("abc-rend2")).toBe("abc");
  expect(notatedId("abc")).toBe("abc");
  expect(verovioOptions({ ...OPTS, condense: true })).toMatchObject({ condense: "auto" });
});

describe.skipIf(!existsSync(FIXTURE))("verovio core", () => {
  let tk: VerovioToolkit;
  beforeAll(async () => {
    const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
      import("verovio/wasm"), import("verovio/esm"),
    ]);
    tk = new VerovioToolkit(await createVerovioModule());
  });

  it("lays out measures in playback order with their pages", () => {
    const lay = layout(tk, OPTS, readFileSync(FIXTURE, "utf-8"));
    expect(lay.measures.map((m) => m.n)).toEqual(["1", "2", "3", "2", "4", "5"]);
    expect(lay.measures.every((m) => m.page >= 1 && m.page <= lay.pageCount)).toBe(true);
    expect(lay.measures[3]!.id).toMatch(/-rend\d+$/); // bar 2, second pass
    // note ids are normalized to notated ids that exist in the SVG
    const ids = lay.events.flatMap((e) => e.on ?? []);
    expect(ids.some((id) => /-rend/.test(id))).toBe(false);
    const svg = renderPage(tk, 1);
    expect(svg).toContain(`id="${ids[0]}"`);
    // staff numbers for part colouring (svgAdditionalAttribute staff@n)
    expect(svg).toMatch(/class="staff"[^>]*data-n="\d+"|data-n="\d+"[^>]*class="staff"/);
    expect(svg).not.toContain("<style");
  });

  it("finds every pass of a repeated bar for click-to-seek", () => {
    const lay = layout(tk, OPTS, readFileSync(FIXTURE, "utf-8"));
    const bar2 = notatedId(lay.measures[1]!.id);
    const times = elementTimes(tk, bar2);
    expect(times.length).toBe(2); // first and second pass
    expect(times[1]! - times[0]!).toBeGreaterThan(3000);
  });

  it("re-lays out with empty staves hidden", () => {
    layout(tk, OPTS, readFileSync(FIXTURE, "utf-8"));
    const lay = layout(tk, { ...OPTS, condense: true });
    expect(lay.measures).toHaveLength(6);
  });
});
