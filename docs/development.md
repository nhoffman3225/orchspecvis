# Development

[architecture.md](architecture.md) explains how the parts fit together; this page
covers setup, day-to-day commands and releases. [CLAUDE.md](../CLAUDE.md) has the
complete command list and the invariants that must hold.

## Setup

Requirements:

- [uv](https://docs.astral.sh/uv/) (Python 3.13 is fetched by uv).
- Node 24.
- For the desktop app and the Rust core:
  - Rust via rustup (stable, ≥ 1.88);
  - on Windows, Visual Studio or Build Tools with the **Desktop development with C++**
    workload;
  - on macOS, the Xcode command-line tools.

```
uv sync --locked --extra dev            # Windows/Linux + NVIDIA: add --extra gpu (CUDA torch)
npm --prefix viewer ci
uv run pytest                           # also writes the fixture bundles viewer tests read
```

## Everyday commands

```
uv run orchspec bundle <session> -o out/ [--backend auto|torch|librosa]
uv run orchspec serve "out/<name>.bundle"    # prints a tokenized http://127.0.0.1:<port>/ URL
npm --prefix viewer run dev                  # Vite dev server (tiny test bundle by default)
npm --prefix desktop run dev                 # desktop app, debug build
```

Production builds of the viewer carry no source maps (they were 20 MB of the 29 MB,
embedded in the desktop app); `SOURCEMAP=1 npm run build` adds them for debugging.

Checks, as CI runs them:

```
uv run ruff check . && uv run ruff format --check . && uv run pyright
uv run pytest -m "not gpu and not slow and not real"
npm --prefix viewer run lint && npm --prefix viewer test && npm --prefix viewer run build
npm --prefix viewer run e2e                  # Playwright; needs `uv run pytest` first
cargo fmt --check && cargo test -p orchspec-core && cargo clippy --all-targets -- -D warnings
cargo deny check                             # Rust supply chain
```

Your own sessions go in `session/` (git-ignored). `uv run pytest -m real` runs the
real-session tests against them.

## Changing the bundle format

1. Bump `SCHEMA_VERSION` in `src/orchspec/bundle/schema.py`.
2. Mirror the change in `viewer/src/bundle.ts` and `rust/orchspec-core/src/manifest.rs`.
   Readers keep accepting older versions.
3. Document the change in [bundle-format.md](bundle-format.md).
4. Run `uv run pytest`, then the viewer and Rust tests: they cross-check bundles written
   by Python.

## Dependencies

New dependencies need approval first; the approved list is in PLAN.md. After adding one,
run `uv run python scripts/credits.py`, which regenerates CREDITS.md and the licence
texts the viewer ships. The supply-chain workflow audits all three ecosystems, and
Dependabot opens weekly grouped updates.

## Desktop builds

Run these in `desktop/`:

| Command | Result |
|---|---|
| `npm run build` | The app only: `target/release/orchspec-desktop.exe`. Imports use your checkout's `.venv`. |
| `npm run dist` | Installer with the bundled analysis runtime, CPU (NSIS on Windows, .dmg on macOS with MPS torch). |
| `npm run dist:gpu` | Windows + NVIDIA: a portable `dist/orchspec-dev-Windows-gpu-cuda.7z` with CUDA torch (needs 7-Zip). |

The runtime is built by `scripts/build_runtime.py`:
1. It copies uv's standalone CPython.
2. It installs orchspec and exactly the locked dependencies from a hash-checked PEP 751
   `pylock.toml` export.
3. It precompiles the code and checks every import.

[desktop/README.md](../desktop/README.md) has sizes, timings and details.

## Releases

1. Update the version in `pyproject.toml`, `desktop/src-tauri/tauri.conf.json`,
   `desktop/src-tauri/Cargo.toml` and `viewer/package.json`.
2. Merge to main, then tag the release and push the tag:

   ```
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. `release.yml` builds the Windows installer and the macOS .dmg and attaches them, with
   SHA-256 sums, to a **draft** GitHub Release. Check the draft, then publish it.

The CUDA build is not published: it is about 1.8 GB even compressed, next to GitHub's
2 GiB per-file limit. GPU users build it with `npm run dist:gpu`.

## Conventions

- Branch per change, small conventional commits, one PR per phase. Never force-push main.
- Keep PLAN.md (roadmap, decisions) and CLAUDE.md (commands, invariants) current.
- Before pushing, check `git status` and `git diff --cached --stat`: no audio, sessions,
  bundles or secrets.
