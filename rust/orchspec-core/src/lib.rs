//! orchspec-core: the language-neutral parts of orchspec in Rust (Phase 3b).
//!
//! - [`manifest`]: bundle manifest, schema v1-v4, validated like `schema.py` / `bundle.ts`
//! - [`tiles`]: tile read/write (raw, gzip), LOD pyramid (max-pool), like `dsp/tiles.py`
//! - [`serve`]: read-only local file serving used by the desktop app's custom protocol
//! - [`session_import`]: importing a session from the desktop app (CLI progress, locating it)
//!
//! No network code: bundles are local folders.

pub mod manifest;
pub mod serve;
pub mod session_import;
pub mod tiles;

pub use manifest::{Manifest, ManifestError, TileEncoding};

use std::path::Path;

/// Reads and validates `<bundle>/manifest.json`.
pub fn open_bundle(root: &Path) -> Result<Manifest, Box<dyn std::error::Error>> {
    let bytes = std::fs::read(root.join(manifest::MANIFEST_NAME))?;
    Ok(Manifest::from_json(&bytes)?)
}
