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
  no capabilities file). The page reaches Rust only through a few `/app/` routes on the
  same protocol (below). Navigation away from the app origin is refused.
- **Home screen** (`?home=1`, the start page without an argument): open a bundle (native
  folder dialog, or one of the listed bundles: recently opened first, then the bundles
  folder), build one from files (the wizard), or import a session folder. Routes:
  `GET /app/home.json` (the list), `POST /app/open` (a *listed* bundle, or the dialog),
  `POST /app/pick` (a native file dialog per input kind), `POST /app/build` (lays the
  chosen files out as a session in `Documents/orchspec/sessions/<name>`, hard links or
  copies, then imports it; every path must have been picked in a dialog in this run;
  stems are named `NN_<name>` with clashing names made unique, and an existing file is
  never written to, since it may be a hard link to one of the user's originals),
  `POST /app/import`. The pure parts are in `rust/orchspec-core/src/app.rs`, tested.
- **Opening a bundle**: pass the folder as the first argument, from the home screen, or
  with File › Open Bundle… (Ctrl/Cmd+O). The manifest is validated by orchspec-core first.
- **Importing a session**: File › Import Session… (Ctrl/Cmd+I), or
  `orchspec-desktop --import <session folder>`. The app runs the Python analysis CLI
  (`orchspec bundle … --backend auto`) as a subprocess — argument list, no shell, no
  console window — into `Documents/orchspec/bundles`, shows its progress (the viewer polls
  the read-only `app/import.json`), then opens the result. The CLI is `$ORCHSPEC_CLI`, else
  the analysis runtime shipped with the app (`<resources>/python`, see below), else the
  checkout's `.venv` found above the executable, else `orchspec` on PATH. (Not under
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
npm run installer    # release + NSIS installer, analysis from your checkout's .venv
npm run dist         # release + NSIS installer with the bundled analysis runtime (below)
```

### Distributable build (bundled analysis runtime)

`npm run dist` builds an installer that imports sessions without any Python install:
`scripts/build_runtime.py` copies uv's standalone CPython into `desktop/runtime/python`
(git-ignored), installs orchspec and its locked dependencies into it from a PEP 751
`pylock.toml` export of `uv.lock` (exact wheel URLs, hash-checked), precompiles it, checks
every import, and `tauri build --config src-tauri/tauri.dist.conf.json` ships it as
resources. Needs uv in addition to the prerequisites above.

| Variant | Build | Output | Beethoven 5 i import |
|---|---|---|---|
| CPU (Windows/Linux default; published) | `npm run dist` | NSIS installer ~97 MB, ~410 MB installed | ~57 s (numpy/librosa) |
| macOS Apple silicon, MPS torch (published) | `npm run dist` | .dmg | not measured yet |
| NVIDIA GPU, CUDA 13 torch (build it yourself) | `npm run dist:gpu` | portable `dist/orchspec-dev-Windows-gpu-cuda.7z`, ~1.8 GB, ~3.5 GB unpacked | ~13 s (RTX 5070 Ti) |

The GPU build is a portable folder rather than an installer: NSIS installers stop at
2 GB, and it is not published because it sits next to GitHub's 2 GiB per-file limit.
Unpack it anywhere with a normal-length path (Windows 11 opens .7z; the build needs 7-Zip
on PATH) and run `orchspec-desktop.exe`; `python\` beside it is found as the app's
resource folder. Without an NVIDIA driver it falls back to CPU torch.

Precompiled builds come from `.github/workflows/release.yml`: pushing a tag `v*` builds
the Windows installer and the macOS .dmg and attaches them (with SHA-256 sums) to a
draft GitHub Release; "Run workflow" builds them as artifacts only. They are not
code-signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first start.

Open a bundle: pass the folder (`orchspec-desktop.exe "out/Beethoven 5.bundle"`), or use
File › Open Bundle… (Ctrl/Cmd+O; also shown at start). Bundles are made with
`uv run orchspec bundle <session> -o out/ --backend torch` (Beethoven 5 i: ~10 s).

The viewer build is embedded at compile time (`tauri` feature `custom-protocol`), so
rebuild the app after viewer changes. Icons: `npm run icon` regenerates
`src-tauri/icons/` from `icon-source.png`.

Checking the running app from a script: start it with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` (DevTools protocol
on 127.0.0.1 only) and attach Playwright with `chromium.connectOverCDP`.
