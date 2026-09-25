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
- **Importing a session**: File › Import Session… (Ctrl/Cmd+I), or
  `orchspec-desktop --import <session folder>`. The app runs the Python analysis CLI
  (`orchspec bundle … --backend auto`) as a subprocess — argument list, no shell, no
  console window — into `Documents/orchspec/bundles`, shows its progress (the viewer polls
  the read-only `app/import.json`), then opens the result. The CLI is `$ORCHSPEC_CLI`, else
  the checkout's `.venv` found above the executable, else `orchspec` on PATH. (Not under
  AppData: the Microsoft Store build of Python redirects AppData writes into a private
  package folder the app cannot see.)

## Build

Prerequisites: Rust via rustup (`rustup default stable`, ≥ 1.88; includes rustfmt and
clippy), Node 24, and on Windows Visual Studio (Community or Build Tools) with the
**Desktop development with C++** workload — it brings the MSVC linker and the Windows
SDK that Rust links against. WebView2 ships with Windows 11. On macOS: Xcode command line
tools.

```bash
npm --prefix ../viewer ci
npm ci
npm run build        # release app: ../target/release/orchspec-desktop.exe (~14 MB)
npm run dev          # debug build + run
npm run installer    # release + NSIS installer (the Tauri CLI downloads NSIS the first time)
```

Open a bundle: pass the folder (`orchspec-desktop.exe "out/Beethoven 5.bundle"`), or use
File › Open Bundle… (Ctrl/Cmd+O; also shown at start). Bundles are made with
`uv run orchspec bundle <session> -o out/ --backend torch` (Beethoven 5 i: ~10 s).

The viewer build is embedded at compile time (`tauri` feature `custom-protocol`), so
rebuild the app after viewer changes. Icons: `npm run icon` regenerates
`src-tauri/icons/` from `icon-source.png`.

Checking the running app from a script: start it with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` (DevTools protocol
on 127.0.0.1 only) and attach Playwright with `chromium.connectOverCDP`.
