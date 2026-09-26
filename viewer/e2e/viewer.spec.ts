import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { guard } from "./guard";

// Written by `uv run pytest tests/test_score_bundle.py` (git-ignored)
const BUNDLE = "/test-data/py-score-bundle/";
// 15 fps: WebGL runs in software here; full-rate redraws starve slow CI runners
const Q = `bundle=${BUNDLE}&fps=15`;
const HAVE = existsSync(fileURLToPath(new URL("../test-data/py-score-bundle/manifest.json", import.meta.url)));
test.skip(!HAVE, "run `uv run pytest tests/test_score_bundle.py` first to create the test bundle");

test("loads a score bundle; no off-origin requests (local-only)", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}`);
  await expect(page.locator("#status")).toContainText("frames");
  await expect(page.locator("#status")).toContainText("4 parts");
  await expect(page.locator("#title")).toContainText("4 stems");
  await page.waitForTimeout(1500); // let tiles, audio and features load
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("score view engraves in a worker, highlights sounding notes, seeks on click", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=score&t=1.6`);
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
  await expect(host.locator(".score-line")).toBeVisible(); // playhead through the system
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
  // zoom: + key and Ctrl+wheel re-engrave, keeping the page with the playhead
  await page.keyboard.press("+");
  await expect(page.locator("#score-zoom")).toHaveText("44 %");
  await host.hover();
  await page.mouse.wheel(0, 100); // plain wheel: scroll only
  await expect(page.locator("#score-zoom")).toHaveText("44 %");
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await expect(page.locator("#score-zoom")).toHaveText("40 %");
  await expect(host.locator("svg").first()).toBeVisible();
  await expect(page.locator("#score-page")).toContainText("page 1 /");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("pages are assembled, summed and smoothed in the worker (ensemble)", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&mode=ensemble&smooth=4`);
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
  await page.goto(`/?${Q}&t=2`);
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
  const stream = await page.evaluate(() => (globalThis as { orchspecStream?: () => string }).orchspecStream?.() ?? "");
  console.log(`audio clock rate ${rate.toFixed(2)}x, ${underruns} underruns; ${stream}; ${ranges.length} ranges`);
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
  await page.goto(`/?${Q}&view=registers&t=4`);
  await expect(page.locator("#regview")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-registers", /^sound:[1-9]/);
  await page.locator("#reg-src").selectOption("notes");
  await expect(page.locator("html")).toHaveAttribute("data-registers", /^notes:[1-9]/);
  await page.locator("#reg-src").selectOption("sound");
  await page.locator("#reg-partials").selectOption("dots"); // partials patterned, fundamentals solid
  await page.locator("#reg-axis").selectOption("both");
  await expect(page.locator("html")).toHaveAttribute("data-registers", /^sound:[1-9]/);
  // by section, the score's fundamentals are drawn solid (regression: family key match)
  await expect.poll(async () => Number(await page.locator("#regcanvas").getAttribute("data-fund-bars")))
    .toBeGreaterThan(0);
  await page.locator("#reg-src").selectOption("notes");
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
  await page.mouse.click(box.x + 60, box.y + box.height / 2); // just right of the pitch axis
  await expect(page.locator("#reg-time")).toContainText("0:00.");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("credits: shipped projects and full licence texts, same origin", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}`);
  await page.locator("#aboutbtn").click();
  await expect(page.locator("#about-body")).toContainText("Verovio");
  await page.locator("#about-lic").click();
  await expect(page.locator("#about-text")).toContainText("GNU LESSER GENERAL PUBLIC LICENSE");
  await expect(page.locator("#about-text")).toContainText("orchspec — MIT License");
  await page.keyboard.press("Escape");
  await expect(page.locator("#aboutview")).toBeHidden();
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("section buttons select stems and parts by family", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}`);
  const sec = page.locator("#sections button");
  await expect(sec).toHaveText(["woodwinds", "keyboards", "strings"]);
  await sec.filter({ hasText: "woodwinds" }).click(); // flute + clarinet
  await expect(page.locator("#mode")).toHaveValue("stems");
  await expect(page.locator("#part-list input:checked")).toHaveCount(2);
  await sec.filter({ hasText: "strings" }).click({ modifiers: ["Control"] }); // + bass
  await expect(page.locator("#part-list input:checked")).toHaveCount(3);
  await sec.filter({ hasText: "woodwinds" }).click({ modifiers: ["Control"] }); // - woodwinds
  await expect(page.locator("#part-list input:checked")).toHaveCount(1);
  await sec.filter({ hasText: "strings" }).click({ modifiers: ["Control"] }); // none active: all
  await expect(page.locator("#part-list input:checked")).toHaveCount(4);
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("tutti: chord per bar / per beat; a bar condenses into a chord and its pitch set", async ({ page, baseURL }) => {
  test.setTimeout(120_000); // Verovio engraving on CI
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=tutti&t=3`);
  const host = page.locator("#tutti-score");
  await expect(host.locator("svg").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator("#tutti-mode")).toHaveValue("chords");
  await expect(host.locator("g.note[fill]").first()).toBeAttached(); // coloured by section
  const bars = host.locator("g.measure");
  const box = (await bars.nth(1).boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + 8); // inside bar 2, above the notes
  await expect(page.locator("#tutti-chord > svg")).toBeVisible();
  await expect(page.locator("#tutti-scale > svg")).toBeVisible();
  await expect(page.locator("#tutti-sel h3")).toContainText("m. 2");
  const one = Number(await page.locator("html").getAttribute("data-tutti-sel"));
  expect(one).toBeGreaterThan(0);
  const box2 = (await bars.nth(2).boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.click(box2.x + box2.width * 0.6, box2.y + 8);
  await page.keyboard.up("Shift");
  await expect(page.locator("#tutti-sel h3")).toContainText("m. 2–3");
  await page.selectOption("#tutti-color", "part"); // recolours, keeps the selection
  await expect(page.locator("#tutti-sel h3")).toContainText("m. 2–3");
  await page.keyboard.press("Escape"); // clears
  await expect(page.locator("#tutti-sel h3")).toHaveCount(0);
  // only chord-per-bar / chord-per-beat reductions are offered (no full rhythm)
  await expect(page.locator("#tutti-mode option")).toHaveText([
    "One Chord per Bar", "One Chord per Beat", "Per Bar, by Section", "Per Beat, by Section",
  ]);
  const heads = async (): Promise<number> => host.locator("g.note").count();
  const perBar = await heads();
  await page.selectOption("#tutti-mode", "beat-chords");
  await expect.poll(heads, { timeout: 60_000 }).toBeGreaterThan(perBar); // held notes repeat per beat
  await page.keyboard.press("Escape"); // closes
  await expect(page.locator("#tuttiview")).toBeHidden();
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("score PDF: page image follows playback with the current bar and a playhead", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=score&scoresrc=pdf&t=3`); // bar 2
  const pdf = page.locator("#score-pdf");
  await expect(pdf.locator("img")).toBeVisible();
  await expect(pdf).toHaveAttribute("data-pdf-bar", "2");
  await expect(pdf.locator(".pdf-bar")).toBeVisible();
  await expect(pdf.locator(".score-line")).toBeVisible();
  await expect(page.locator("#score-page")).toHaveText("page 1 / 1");
  // switch to the engraved MusicXML and back
  await page.locator("#score-src").selectOption("xml");
  await expect(page.locator("#score-host svg").first()).toBeVisible({ timeout: 90_000 });
  await page.locator("#score-src").selectOption("pdf");
  await expect(pdf.locator("img")).toBeVisible();
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("piano view renders", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=piano&t=3`); // bar 2 starts at ~2.54 s (audio)
  await expect(page.locator("#pianoview")).toBeVisible();
  await expect(page.locator("#piano-time")).toContainText("m. 2");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("views dock below the toolbar; panels resize by dragging and remember it", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.setViewportSize({ width: 1280, height: 800 }); // room for the splitter limits
  await page.goto(`/?${Q}&view=registers`);
  const view = page.locator("#regview");
  await expect(view).toBeVisible();
  // the toolbar stays reachable while a view is open
  const bar = (await page.locator("#bar").boundingBox())!;
  const top0 = (await view.boundingBox())!.y;
  expect(top0).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveText("❚❚");
  await page.locator("#play").click();
  // drag the view's top edge down: the spectrogram above shows again
  const h = (await page.locator("#split-view").boundingBox())!;
  await page.mouse.move(400, h.y + 2);
  await page.mouse.down();
  await page.mouse.move(400, h.y + 150, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await view.boundingBox())!.y).toBeGreaterThan(top0 + 100);
  await page.keyboard.press("Escape");
  await expect(page.locator("#split-view")).toBeHidden();
  // the 2D pane splitter; the size survives a reload
  const pane = page.locator("#pane");
  const ph = (await pane.boundingBox())!.height;
  const s = (await page.locator("#split-pane").boundingBox())!;
  await page.mouse.move(400, s.y + 2);
  await page.mouse.down();
  await page.mouse.move(400, s.y - 60, { steps: 4 });
  await page.mouse.up();
  // (clamped so the 3D view keeps 120 px: in this small viewport the gain is limited)
  await expect.poll(async () => (await pane.boundingBox())!.height).toBeGreaterThan(ph + 20);
  const grown = (await pane.boundingBox())!.height;
  await page.goto(`/?${Q}`); // reload (without view=registers, which would cover the pane)
  await expect.poll(async () => Math.round((await pane.boundingBox())!.height)).toBe(Math.round(grown));
  const sp = (await page.locator("#split-pane").boundingBox())!;
  await page.mouse.dblclick(400, sp.y + sp.height / 2); // reset
  await expect.poll(async () => Math.round((await pane.boundingBox())!.height)).toBe(Math.round(ph));
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("toolbar groups fold open; hover tips; the help view lists every control", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/?${Q}`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?${Q}`);
  const spectrum = page.locator('.grp[data-fold="spectrum"]');
  const cap = spectrum.locator("button.cap");
  await expect(cap).toHaveAttribute("aria-expanded", "false"); // condensed by default
  await expect(page.locator("#mode")).not.toBeInViewport();
  await cap.click();
  await expect(cap).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#mode")).toBeInViewport();
  await page.goto(`/?${Q}`); // remembered
  await expect(cap).toHaveAttribute("aria-expanded", "true");
  // accordion: opening Surface folds Spectrum; Shift+click keeps others open
  const surface = page.locator('.grp[data-fold="surface"] button.cap');
  await surface.click();
  await expect(surface).toHaveAttribute("aria-expanded", "true");
  await expect(cap).toHaveAttribute("aria-expanded", "false");
  await cap.click({ modifiers: ["Shift"] });
  await expect(cap).toHaveAttribute("aria-expanded", "true");
  await expect(surface).toHaveAttribute("aria-expanded", "true");
  // the harmonics presets follow the slider: disabled while fundamentals are off
  await expect(page.locator("#harmpreset")).toBeDisabled();
  // hover help instead of the browser's title tooltip
  await page.waitForTimeout(400); // let the groups finish sliding open
  await page.locator("#mode").hover();
  await expect(page.locator("#hovertip")).toBeVisible();
  await expect(page.locator("#hovertip")).toContainText("What the spectrum shows");
  // help view: H opens it (docked below the toolbar), with a row for each control
  await page.mouse.move(5, 790);
  await page.keyboard.press("KeyH");
  await expect(page.locator("#helpview")).toBeVisible();
  await expect(page.locator("#help-ref")).toContainText("Fundamentals ±");
  await expect(page.locator("#help-ref")).toContainText("Colour map for loudness");
  expect(await page.locator("#help-ref td").count()).toBeGreaterThan(30);
  await page.keyboard.press("KeyR"); // another view replaces help
  await expect(page.locator("#helpview")).toBeHidden();
  await expect(page.locator("#regview")).toBeVisible();
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});

test("home screen (desktop): bundles list and the from-files wizard", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.route("**/app/home.json", (r) => r.fulfill({ json: {
    bundles: [
      { name: "Beethoven 5", path: "C:/b/Beethoven 5.bundle", modified: 1790000000, has_score: true, recent: true },
      { name: "Sketch", path: "C:/b/Sketch.bundle", modified: 1780000000, has_score: false, recent: false },
    ],
    bundles_dir: "C:/b", importing: false,
  } }));
  const picked: Record<string, string[]> = {
    musicxml: ["D:/Renders/Bolero/Bolero.musicxml"], midi: ["D:/Renders/Bolero/render.mid"],
    stems: ["D:/Renders/Bolero/stems/01_Flute.wav", "D:/Renders/Bolero/stems/02_Snare.wav"],
  };
  await page.route("**/app/pick", async (r) => {
    const kind = (r.request().postDataJSON() as { kind: string }).kind;
    await r.fulfill({ json: { paths: picked[kind] ?? [] } });
  });
  let built: unknown = null;
  await page.route("**/app/build", async (r) => {
    built = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  let opened: unknown = null;
  await page.route("**/app/open", async (r) => {
    opened = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto("/?home=1");
  await expect(page.locator("html")).toHaveAttribute("data-home", "ready");
  await expect(page.locator(".home-bundle")).toHaveCount(2);
  await expect(page.locator(".home-bundle").first()).toContainText("Recent");
  await page.locator(".home-bundle").first().click();
  await expect.poll(() => opened).toEqual({ path: "C:/b/Beethoven 5.bundle" });
  // the wizard: nothing to build until there is audio
  await page.locator("#home-new").click();
  await expect(page.locator("#wizard")).toBeVisible();
  await expect(page.locator("#wizard-build")).toBeDisabled();
  await page.locator("#pick-musicxml").click();
  await page.locator("#pick-midi").click();
  await expect(page.locator("#wizard-build")).toBeDisabled();
  await expect(page.locator(".wizard-summary li.on")).toContainText(["Engraved score view", "Tutti view"]);
  await expect(page.locator(".wizard-summary li.off").first()).toContainText("Spectrum and playback");
  await page.locator("#pick-stems").click();
  await expect(page.locator(".wizard-summary li.on").first()).toContainText("Spectrum and playback");
  await expect(page.locator('[data-kind="pdf"] .wizard-without')).toContainText("no score PDF view");
  await expect(page.locator('[data-kind="stems"] .wizard-files')).toHaveText("01_Flute.wav · 02_Snare.wav");
  await expect(page.locator("#wizard-name")).toHaveValue("Bolero");
  await expect(page.locator("#wizard-build")).toBeEnabled();
  await page.locator("#wizard-build").click();
  await expect.poll(() => built).toEqual({
    name: "Bolero", stems: picked.stems, musicxml: picked.musicxml![0], midi: picked.midi![0],
  });
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});


test("views the bundle cannot show are marked unavailable and say why", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto("/?bundle=tiny-bundle/&fps=15"); // no score
  // (its audio is git-ignored, so on CI the status line reports "audio unavailable")
  for (const id of ["#scorebtn", "#tuttibtn"]) {
    await expect(page.locator(id)).toBeVisible();
    await expect(page.locator(id)).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("KeyS");
  await expect(page.locator("#scoreview")).toBeHidden();
  await expect(page.locator("#status")).toContainText("needs a MusicXML score or a score PDF");
  await page.locator("#tuttibtn").click({ force: true }); // Playwright waits on aria-disabled; a user can click
  await expect(page.locator("#tuttiview")).toBeHidden();
  await expect(page.locator("#status")).toContainText("tutti view needs a MusicXML score");
  await page.locator("#scorebtn").hover();
  await expect(page.locator("#hovertip")).toContainText("needs a MusicXML score");
  expect(g.offOrigin).toEqual([]);
  const errors = g.errors.filter((e) => !/^HTTP 404 \/tiny-bundle\/audio\//.test(e)); // not committed
  expect(errors, errors.join(" | ")).toEqual([]);
});


test("tutti: a box selection opens the orchestration chart; doublings split or mixed", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=tutti&t=3`);
  const host = page.locator("#tutti-score");
  await expect(host.locator("svg").first()).toBeVisible({ timeout: 90_000 });
  const bar = (await host.locator("g.measure").nth(1).boundingBox())!;
  await page.mouse.move(bar.x + 2, bar.y - 10);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width - 2, bar.y + bar.height + 10, { steps: 5 });
  await page.mouse.up();
  const bubble = page.locator("#tutti-bubble");
  await expect(bubble).toBeVisible();
  await expect(page.locator("#tutti-bubble-title")).toContainText("m. 2");
  await expect(page.locator("#tutti-bubble-chart svg text").first()).toBeVisible(); // labels
  const mixed = Number(await page.locator("html").getAttribute("data-tutti-bubble"));
  expect(mixed).toBeGreaterThan(0);
  await page.locator("#tutti-split").check(); // re-drawn split
  await expect(page.locator("html")).toHaveAttribute("data-tutti-bubble", /^[1-9]/);
  await page.keyboard.press("Escape"); // closes the pop-up first
  await expect(bubble).toBeHidden();
  await expect(page.locator("#tuttiview")).toBeVisible();
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});


test("accessible mode (WCAG): toggled from Help, remembered, larger targets", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?${Q}&view=help`);
  await page.evaluate(() => localStorage.removeItem("orchspec.a11y"));
  await page.goto(`/?${Q}&view=help`);
  await expect(page.locator("html")).toHaveAttribute("data-a11y", "off");
  const box = page.locator("#help-bar input[data-a11y-toggle]");
  await box.check();
  await expect(page.locator("html")).toHaveAttribute("data-a11y", "on");
  await page.goto(`/?${Q}`); // remembered
  await expect(page.locator("html")).toHaveAttribute("data-a11y", "on");
  const h = (await page.locator("#play").boundingBox())!.height;
  expect(h).toBeGreaterThanOrEqual(24); // WCAG 2.5.8 target size
  expect(await page.locator("#bar .cap").first().evaluate((e) => getComputedStyle(e).transform)).toBe("none");
  await page.goto(`/?${Q}&a11y=0`); // the URL wins
  await expect(page.locator("html")).toHaveAttribute("data-a11y", "off");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});
