// LOCAL ONLY: run the viewer checks against `orchspec serve` on a real session.
//   E2E_URL="http://127.0.0.1:<port>/?token=...&bundle=bundle/" PW_CHANNEL=msedge npx playwright test real
import { expect, test } from "@playwright/test";
import { guard } from "./guard";

const URL_ = process.env.E2E_URL;
test.skip(!URL_, "set E2E_URL to an `orchspec serve` URL");

test("real session: score view follows and highlights", async ({ page }) => {
  const g = guard(page, URL_!);
  await page.goto(`${URL_}&view=score&t=30`);
  const host = page.locator("#score-host");
  await expect(host.locator("svg").first()).toBeVisible({ timeout: 150_000 });
  await expect(host.locator("g.playing").first()).toBeAttached({ timeout: 60_000 });
  const n = await host.locator("g.playing").count();
  console.log(`page: ${await page.locator("#score-page").textContent()}, ${n} notes lit, ` +
    `${await page.locator("#score-time").textContent()}`);
  await page.screenshot({ path: "test-results/real-score.png" });
  expect(g.offOrigin).toEqual([]);
  expect(g.errors).toEqual([]);
});
