# Security model

orchspec is a **local-only** tool. It analyses audio and score files on your machine and
shows the result in a viewer on your machine. It has no accounts, no cloud features, and
no reason to talk to the network.

## Guarantees

1. **No outbound network at runtime.** The Python core and the viewer never open outbound
   connections: no CDNs, web fonts, analytics, telemetry, crash reporting, or updaters.
   three.js (and later Verovio) are bundled by Vite into `viewer/dist`.
   - Enforced in tests: pytest runs under `pytest-socket` with
     `--disable-socket --allow-hosts=127.0.0.1,localhost`; a vitest check fails if the
     viewer attempts any non-same-origin request, and every Playwright E2E test (real
     browser, incl. the Verovio worker) fails on any off-origin request or page error.
   - Dependency installation (`uv sync`, `npm ci`) obviously uses the network; runtime
     does not.
2. **No downloads from code.** Never call `librosa.example()`, `torch.hub`, dataset
   helpers, or anything that fetches. Loaders take filesystem paths only and reject URLs.
3. **The only listener is 127.0.0.1.** `orchspec serve` (dev-only; replaced by the Tauri
   app in Phase 3b):
   - binds `127.0.0.1` on a random free port;
   - `TrustedHostMiddleware` allows only `127.0.0.1` and `localhost` (DNS-rebinding
     defence);
   - a random per-launch token (`secrets.token_urlsafe(32)`) is required on every request
     (query `?token=`, header `X-Orchspec-Token`, or the HttpOnly SameSite=Strict cookie set
     on first load); otherwise 403;
   - no CORS headers, GET/HEAD only;
   - paths are resolved and anything outside the bundle root (or the viewer dist) is 404;
   - read-only: no endpoint writes to disk.
   The **desktop app** (Tauri 2, `desktop/`) opens no listener at all: the viewer and the
   opened bundle are served through one in-process custom protocol with the same rules
   (GET/HEAD only, root confinement, no hidden files, the CSP and headers below;
   `rust/orchspec-core/src/serve.rs`, tested in `tests/serve.rs`). No updater plugin, no
   capabilities file (the page gets no IPC permissions), navigation off the app origin is
   refused. Bundles are opened from a local folder only (argument or native dialog).
4. **Viewer CSP** (in `viewer/index.html`):
   `default-src 'self'; connect-src 'self'; img-src 'self' blob: data:;
   script-src 'self' 'wasm-unsafe-eval'` (+ `style-src 'self'`, `object-src 'none'`,
   `base-uri 'none'`, `media-src 'self' blob:`).

## Untrusted inputs

Session folders (WAV, MIDI, MusicXML, YAML) and bundles are treated as untrusted.

| Input | Handling |
| --- | --- |
| render.yaml | `yaml.safe_load` + pydantic with `extra="forbid"` |
| MusicXML | `defusedxml`, or `lxml` with `resolve_entities=False, no_network=True` |
| .mxl | zip: reject absolute/`..` member paths, cap member count and total uncompressed size |
| audio | `soundfile` only; no ffmpeg shelling in Phase 1 |
| numpy data | `np.load(..., allow_pickle=False)`; no `pickle`, no `torch.load` of inputs |
| bundle manifest | pydantic model; all paths relative POSIX, no `..`, no absolute, no `:` |
| subprocess (if ever) | `shell=False`, explicit argv, timeout |

## Data hygiene

Real session material lives in git-ignored `session/` and `tests/fixtures/real/`. Tests
use deterministic synthetic fixtures only. Before every push: `git status` and
`git diff --cached --stat`; abort if any audio, session, bundle, or secret file appears.

## Reporting

This is a private project; report issues directly to the repository owner.
