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
    await expect(host.locator("svg").first()).toBeVisible({ timeout: 150_000 });
  } catch (e) {
    const info = await page.locator("#score-info").textContent();
    const d = await host.evaluate((el) => ({ ...(el as HTMLElement).dataset }));
    throw new Error(`${(e as Error).message}
score-info: ${info}
state: ${JSON.stringify(d)}
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

test("piano view renders", async ({ page, baseURL }) => {
  const g = guard(page, baseURL!);
  await page.goto(`/?bundle=${BUNDLE}&view=piano&t=3`); // bar 2 starts at ~2.54 s (audio)
  await expect(page.locator("#pianoview")).toBeVisible();
  await expect(page.locator("#piano-time")).toContainText("m. 2");
  expect(g.offOrigin).toEqual([]);
  expect(g.errors, g.errors.join(" | ")).toEqual([]);
});
