# rust/ (Phase 3b)

Placeholder. `orchspec-core` will implement, in Rust with PyO3 bindings:

- session bundle read/write exactly per `docs/bundle-format.md` (schema v1),
  byte-identical tiles to the Python writer;
- LOD pyramid construction (time max-pool x2 per level);
- cross-correlation for audio/MIDI offset estimation.

The Python implementation in `src/orchspec/` remains the reference; Rust output is
cross-checked against it in tests.
