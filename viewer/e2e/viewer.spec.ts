import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { guard } from "./guard";

// Written by `uv run pytest tests/test_score_bundle.py` (git-ignored)
const BUNDLE = "/test-data/py-score-bundle/";
const HAVE = existsSync(fileURLToPath(new URL("../test-data/py-score-bundle/manifest.json", import.meta.url)));
test.skip(!HAVE, "run `uv run pytest tests/test_score_bundle.py` first to create the test bundle");

test("loads a score bundle; no off-origin requests (local-only)", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}`);
  await expect(page.locator("#status")).toContainText("frames");
  await expect(page.locator("#status")).toContainText("4 parts");
  await expect(page.locator("#title")).toContainText("4 stems");
  await page.waitForTimeout(1500); // let tiles, audio and features load
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("score view engraves in a worker, highlights sounding notes, seeks on click", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}&view=score&t=1.6`);
  const host = page.locator("#score-host");
  try {
    await expect(host.locator("svg").first()).toBeVisible({ timeout: 45_000 });
  } catch (e) {
    const info = await page.locator("#score-info").textContent();
    const d = await host.evaluate((el) => ({ ...(el as HTMLElement).dataset }));
    // is the worker alive and idle (answers quickly) or stuck in synchronous work?
    const workers = page.workers();
    const alive = await Promise.race([
      workers[0]?.evaluate(() => `worker idle at ${Math.round(performance.now())} ms`) ?? "no worker",
      new Promise<string>((r) => setTimeout(() => r("worker busy (no answer in 5 s)"), 5000)),
    ]);
    throw new Error(`${(e as Error).message}
score-info: ${info}
state: ${JSON.stringify(d)}
workers: ${workers.length}; ${alive}
` +
      `errors: ${g.errors.join(" | ")}`, { cause: e });
  }
  await expect(host.locator("g.playing").first()).toBeAttached();
  await expect(page.locator("#score-page")).toContainText("page 1 /");
  // coloured by part (presentation attribute set by the view)
  expect(await host.locator("g.playing").first().getAttribute("fill")).toMatch(/^rgb|^#/);
  // clicking a note in the last bar seeks there
  await page.locator("#score-follow").uncheck(); // follow keeps scrolling toward the playhead
  const before = await page.locator("#score-time").textContent();
  // click in the middle of the last bar (lands on empty staff space -> bar fallback)
  const bar = host.locator("g.measure").last();
  await bar.scrollIntoViewIfNeeded();
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("#score-time")).not.toHaveText(before ?? "");
  await expect(page.locator("#score-time")).toContainText("m. 5");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("pages are assembled, summed and smoothed in the worker (ensemble)", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}&mode=ensemble&smooth=4`);
  // slow on CI (software WebGL renders every frame while the worker assembles pages)
  test.setTimeout(120_000);
  await expect(page.locator("html")).toHaveAttribute("data-page", /^ensemble:\d+:\d+$/, { timeout: 90_000 });
  await expect(page.locator("html")).toHaveAttribute("data-smoothed", "true");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("streams the mix WAV through the AudioWorklet (Range requests), no underruns", async ({ page, baseURL }) => {
  test.setTimeout(120_000); // CI: software WebGL
  const g = guard(page, baseURL!);
  const ranges: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/audio/mix.wav")) ranges.push(r.headers()["range"] ?? "(none)");
  });
  await page.goto(`/?bundle=${BUNDLE}&t=2`);
  await expect(page.locator("html")).toHaveAttribute("data-audio", "stream");
  const audioTime = (): Promise<number> =>
    page.evaluate(() => (globalThis as { orchspecAudioTime?: () => number }).orchspecAudioTime?.() ?? 0);
  const wall0 = Date.now();
  await page.locator("#play").click();
  const audio0 = await audioTime();
  // a busy main thread must not starve the audio (the feeder worker talks to the worklet
  // directly): block it in 300 ms bursts for ~2.4 s while playing
  await page.evaluate(async () => {
    for (let k = 0; k < 6; k++) {
      const end = performance.now() + 300;
      while (performance.now() < end) { /* busy */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const secs = async (): Promise<number> => {
    const [mm, ss] = ((await page.locator("#time").textContent()) ?? "0:0").split(" / ")[0]!.split(":");
    return Number(mm) * 60 + Number(ss);
  };
  // Some CI runners have no audio device and Chromium's audio clock never starts there;
  // then only the transport-independent checks below apply (verified locally otherwise).
  const clockRuns = await expect.poll(secs, { timeout: 8_000 }).toBeGreaterThan(2.2).then(() => true, () => false);
  if (clockRuns) {
    await expect.poll(secs, { timeout: 15_000 }).toBeGreaterThanOrEqual(5); // playhead advanced 3 s
  } else {
    test.info().annotations.push({ type: "audio-clock", description:
      `audio clock did not start (AudioContext ${await page.locator("html").getAttribute("data-audio-state")})` });
  }
  // Underruns only mean something with a real-time audio clock. CI's fake sink renders in
  // catch-up bursts (clock rate far from 1x); there the count is reported, not asserted.
  const rate = (await audioTime() - audio0) / ((Date.now() - wall0) / 1000);
  await page.locator("#play").click();
  expect(ranges.length).toBeGreaterThan(3);
  expect(ranges.every((r) => r.startsWith("bytes="))).toBe(true); // never the whole file
  const underruns = Number(await page.locator("html").getAttribute("data-underruns"));
  console.log(`audio clock rate ${rate.toFixed(2)}x, ${underruns} underruns`);
  if (clockRuns && rate > 0.7 && rate < 1.4) {
    expect(underruns).toBe(0);
  } else {
    test.info().annotations.push({ type: "audio-clock",
      description: `audio clock rate ${rate.toFixed(2)}x of wall time; ${underruns} underrun quanta (not asserted)` });
  }
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("register view: sections from stem spectra and from the score", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}&view=registers&t=4`);
  await expect(page.locator("#regview")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-registers", /^sound:[1-9]/);
  await page.locator("#reg-src").selectOption("notes");
  await expect(page.locator("html")).toHaveAttribute("data-registers", /^notes:[1-9]/);
  await page.locator("#reg-by").selectOption("each");
  await expect(page.locator("html")).toHaveAttribute("data-registers", "notes:4"); // 4 parts
  // the timeline is drawn (not blank): some pixels differ from the background
  const painted = await page.locator("#regcanvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 60 || d[i + 1]! > 60) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(500);
  // click the left edge of the timeline -> seek near 0
  const box = (await page.locator("#regcanvas").boundingBox())!;
  await page.mouse.click(box.x + 42, box.y + box.height / 2);
  await expect(page.locator("#reg-time")).toContainText("0:00.");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("piano view renders", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}&view=piano&t=3`); // bar 2 starts at ~2.54 s (audio)
  await expect(page.locator("#pianoview")).toBeVisible();
  await expect(page.locator("#piano-time")).toContainText("m. 2");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});
