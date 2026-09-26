import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ScoreMeasure } from "./bundle";
import { ScoreClock, SoundingTracker, alignMeasures, sanitizeSvg, type VrvMeasure } from "./scoremap";

const meas = (nums: string[], starts: number[]): ScoreMeasure[] =>
  nums.map((number, i) => ({
    play_index: i, number, start_s: starts[i]!, end_s: starts[i + 1] ?? starts[i]! + 2,
    beats: 4, beat_type: 4, pass_no: 1, source_index: i,
  }));

describe("measure alignment", () => {
  it("matches repeated passes in order", () => {
    expect(alignMeasures(["1", "2", "3", "2", "4"], ["1", "2", "3", "2", "4"])).toEqual([0, 1, 2, 3, 4]);
  });
  it("tolerates a missing or extra measure", () => {
    expect(alignMeasures(["1", "2", "3", "4"], ["1", "3", "4"])).toEqual([0, -1, 1, 2]);
    expect(alignMeasures(["1", "2", "3"], ["0", "1", "2", "3"])).toEqual([1, 2, 3]);
  });
});

describe("score clock", () => {
  const ours = meas(["1", "2", "3"], [0.5, 2.5, 4.5]); // audio seconds, 2 s bars
  const vrv: VrvMeasure[] = [
    { id: "a", n: "1", ms: 0 }, { id: "b", n: "2", ms: 1000 }, { id: "c", n: "3", ms: 3000 },
  ];
  const clk = new ScoreClock(ours, vrv, 5000);
  it("interpolates within measures both ways", () => {
    expect(clk.audioToVrv(0.5)).toBe(0);
    expect(clk.audioToVrv(1.5)).toBe(500); // half of bar 1 -> half of Verovio's bar 1
    expect(clk.audioToVrv(3.5)).toBe(2000); // bar 2 is longer in Verovio (tempo differs)
    expect(clk.vrvToAudio(2000)).toBeCloseTo(3.5);
    expect(clk.vrvToAudio(4000)).toBeCloseTo(5.5);
  });
  it("clamps outside the score", () => {
    expect(clk.audioToVrv(0)).toBe(0);
    expect(clk.audioToVrv(99)).toBe(5000);
  });
});

describe("svg sanitizer", () => {
  it("strips styles, scripts, handlers and external links but keeps local refs", () => {
    const dirty = '<?xml version="1.0"?><svg><style>g{fill:red}</style><script>alert(1)</script>' +
      '<g class="note" id="n1" onclick="x()" style="fill:red"><use xlink:href="#E0A4"/>' +
      '<a href="https://evil.example">x</a><foreignObject><div/></foreignObject></g></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<style|<script|onclick|style=|evil\.example|foreignObject|<\?xml/);
    expect(clean).toContain('xlink:href="#E0A4"');
    expect(clean).toContain('class="note" id="n1"');
  });

  it("also strips unquoted values, prefixed script tags and href-rewriting animations", () => {
    const dirty = '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script>' +
      '<SCRIPT src=x.js/><g onload=alert(1) class="a"><a href=javascript:alert(1)>x</a>' +
      '<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" ' +
      'values="javascript:alert(1)"></animate><iframe src="x"></iframe>' +
      "<use href='#E0A4'/><use href=#E0A5 /></g></svg>";
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|onload|javascript|<set|<animate|<iframe/i);
    expect(clean).toContain("href='#E0A4'");
    expect(clean).toContain("href=#E0A5");
    expect(clean).toContain('<g class="a">');
  });

  it("treats a slash as an attribute separator (<a/href=...>)", () => {
    const clean = sanitizeSvg('<svg><a/href=javascript:alert(1)>x</a><image/href="https://x.example/y"/>' +
      '<g/onload=alert(1)/><rect/style="fill:url(https://x.example/z)"/><use/href="#E0A4"/></svg>');
    expect(clean).not.toMatch(/javascript|onload|https:|style/i);
    expect(clean).toContain('<use/href="#E0A4"/>');
  });
});

// Real Verovio on the synthetic score (written by the Python fixtures; skipped if absent)
// the MusicXML copied into the Python-written test bundle (tests/test_score_bundle.py)
const FIXTURE = fileURLToPath(new URL("../test-data/py-score-bundle/score/score.musicxml", import.meta.url));
describe.skipIf(!existsSync(FIXTURE))("verovio integration", () => {
  it("timemap lists measures in playback order with repeats expanded", async () => {
    const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
      import("verovio/wasm"), import("verovio/esm"),
    ]);
    const tk = new VerovioToolkit(await createVerovioModule());
    tk.setOptions({ pageWidth: 2100, adjustPageHeight: true, scale: 40 });
    expect(tk.loadData(readFileSync(FIXTURE, "utf-8"))).toBeTruthy();
    const tm = tk.renderToTimemap({ includeMeasures: true, includeRests: true }) as
      { measureOn?: string; tstamp: number }[];
    const ms = tm.filter((e) => e.measureOn);
    const nums = ms.map((e) => (tk.getElementAttr(e.measureOn!.replace(/-rend\d+$/, "")) as { n?: string }).n);
    expect(nums).toEqual(["1", "2", "3", "2", "4", "5"]);
    // 120 bpm, 4/4: bars 1-3 last 2 s each in Verovio's time base too
    expect(ms.slice(0, 4).map((e) => e.tstamp)).toEqual([0, 2000, 4000, 6000]);
    const svg = sanitizeSvg(tk.renderToSVG(1));
    expect(svg).toContain('class="note"');
    expect(svg).not.toContain("<style");
  });
});


describe("sounding tracker", () => {
  const tr = new SoundingTracker([
    { tstamp: 0, on: ["a", "b"] },
    { tstamp: 500, off: ["a"], on: ["c"] },
    { tstamp: 1000, off: ["b", "c"] },
  ]);
  it("tracks forward, and rebuilds after seeking back", () => {
    expect(tr.at(100).sort()).toEqual(["a", "b"]);
    expect(tr.at(600).sort()).toEqual(["b", "c"]);
    expect(tr.at(1200)).toEqual([]);
    expect(tr.at(250).sort()).toEqual(["a", "b"]); // backward seek
  });
});
