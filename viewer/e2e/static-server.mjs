// Minimal static server for E2E: serves the production build (dist/) at / and the
// Python-written test bundles (test-data/) at /test-data/. 127.0.0.1 only, GET/HEAD only,
// paths confined to those two roots. Test tooling, not part of the app.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const roots = { "/test-data/": resolve(here, "test-data"), "/": resolve(here, "dist") };
const port = Number(process.env.PORT || 5199);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".wav": "audio/wav", ".musicxml": "application/xml",
  ".map": "application/json",
};

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const prefix = Object.keys(roots).find((p) => path.startsWith(p));
  const root = roots[prefix];
  let file = resolve(join(root, path.slice(prefix.length) || "index.html"));
  if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(404).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return void res.writeHead(404).end();
  }
  res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`e2e static server on 127.0.0.1:${port}`));
