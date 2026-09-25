# desktop/ — orchspec desktop app (Phase 3b, Tauri 2)

Replaces the dev-only `orchspec serve` for everyday use: the same `viewer/` build in the
system webview (WebView2 on Windows, WKWebView on macOS — hence WebGL2, not WebGPU) and
one local bundle folder.

- **One custom protocol** (`orchspec://localhost/`, on Windows `http://orchspec.localhost/`)
  serves both the embedded viewer build and `/bundle/<file>` from the opened folder, so
  the viewer's same-origin fetch guard and CSP (`connect-src 'self'`) work unchanged.
  Serving rules (GET/HEAD only, paths confined to the bundle, no hidden files, byte
  ranges for streaming playback, the SECURITY.md headers) are in
  `rust/orchspec-core/src/serve.rs` and tested there.
- **No network**: no updater, no telemetry, no remote URLs. No IPC permissions (there is
  no capabilities file), so the page cannot call into Rust. Navigation away from the
  app origin is refused.
- **Opening a bundle**: pass the folder as the first argument, or use File › Open Bundle…
  (Ctrl/Cmd+O; also shown at start). The manifest is validated by orchspec-core first.

## Build

Prerequisites: Rust (stable, ≥ 1.88), Node 24; on Windows the **MSVC C++ build tools**
(Visual Studio Build Tools, "Desktop development with C++") — without them Rust cannot
link; WebView2 ships with Windows 11. On macOS: Xcode command line tools.

```bash
npm --prefix ../viewer ci
npm ci
npm run dev          # builds the viewer, runs the app (debug)
npm run build        # release app + installer (NSIS on Windows, .app/.dmg on macOS)
```

Run with a bundle: `cargo run -p orchspec-desktop -- "out/Beethoven 5.bundle"` (from the
repo root, after building the viewer).

Icons: `npm run icon` regenerates `src-tauri/icons/` from `icon-source.png`.
