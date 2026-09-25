// test_no_network (viewer half): the viewer must never issue a non-local request.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadManifest } from "./bundle";
import { OffOriginError, assertSameOrigin, fetchSameOrigin } from "./net";

const ORIGIN = "http://127.0.0.1:5173/";

describe("network guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks other origins", () => {
    expect(() => assertSameOrigin("https://cdn.example.com/three.js", ORIGIN)).toThrow(OffOriginError);
    expect(() => assertSameOrigin("//evil.example/x", ORIGIN)).toThrow(OffOriginError);
    expect(() => assertSameOrigin("http://127.0.0.1:9999/x", ORIGIN)).toThrow(OffOriginError);
    expect(assertSameOrigin("tiny-bundle/manifest.json", ORIGIN).origin).toBe("http://127.0.0.1:5173");
  });

  it("loader only requests same-origin URLs", async () => {
    const seen: string[] = [];
    vi.stubGlobal("location", { href: ORIGIN });
    vi.stubGlobal("fetch", async (u: URL | string) => {
      seen.push(String(u));
      const body = readFileSync(
        fileURLToPath(new URL("../public/tiny-bundle/manifest.json", import.meta.url)), "utf-8");
      return new Response(body, { status: 200 });
    });
    await loadManifest("./tiny-bundle/");
    expect(seen.length).toBeGreaterThan(0);
    for (const u of seen) expect(new URL(u).origin).toBe("http://127.0.0.1:5173");
    await expect(fetchSameOrigin("https://example.com/")).rejects.toThrow(OffOriginError);
  });

  it("source has no absolute external URLs outside tests", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir, { recursive: true }) as string[];
    for (const f of files) {
      const p = join(dir, f);
      if (statSync(p).isDirectory() || f.endsWith(".test.ts")) continue;
      const text = readFileSync(p, "utf-8");
      // the SVG namespace (inline data: patterns in style.css) is an identifier, never fetched
      const hits = (text.match(/(https?|wss?):\/\/(?!127\.0\.0\.1|localhost)[^\s"'`)]+/g) ?? [])
        .filter((u) => u !== "http://www.w3.org/2000/svg");
      expect(hits, `${f} contains external URLs`).toEqual([]);
    }
  });

  it("index.html carries the strict CSP", () => {
    const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf-8");
    for (const d of [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' blob: data:",
      "script-src 'self' 'wasm-unsafe-eval'",
    ]) {
      expect(html).toContain(d);
    }
    expect(html).not.toMatch(/<script[^>]+src="(https?:)?\/\//);
    expect(html).not.toMatch(/<link[^>]+href="(https?:)?\/\//);
  });
});
