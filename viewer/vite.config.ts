import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Production CSP lives in index.html. Vite's dev server injects <style> tags for CSS
// HMR, so only in `serve` mode we additionally allow inline styles.
function devCsp(): Plugin {
  return {
    name: "orchspec-dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [devCsp()],
  server: { host: "127.0.0.1", strictPort: false },
  // the Verovio wasm module (~8 MB) is its own lazily loaded chunk
  // no source maps in shipped builds (20 MB of the 29 MB, embedded in the desktop app);
  // SOURCEMAP=1 npm run build to debug a production build
  build: { target: "es2022", sourcemap: process.env.SOURCEMAP === "1", chunkSizeWarningLimit: 9000 },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
