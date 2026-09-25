import { defineConfig } from "@playwright/test";

// E2E: the viewer against the Python-written test bundle (viewer/test-data, produced by
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
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
