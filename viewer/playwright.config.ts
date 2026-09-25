import { defineConfig } from "@playwright/test";

// E2E: the built viewer against the Python-written test bundle (viewer/test-data, produced by
// `uv run pytest`). Local runs can use an installed browser (PW_CHANNEL=msedge|chrome);
// CI installs Playwright's Chromium. WebGL runs on SwiftShader in headless mode.
const PORT = 5199;

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1400, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  // the production build (what users run), served statically with the test bundles
  webServer: {
    command: `npx vite build && node e2e/static-server.mjs`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
