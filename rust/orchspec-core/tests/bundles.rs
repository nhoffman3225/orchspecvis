//! Cross-language checks against bundles written by the Python writer:
//! - viewer/public/tiny-bundle (committed; raw tiles, schema v4)
//! - viewer/test-data/py-score-bundle (gzip tiles, score; written by
//!   `uv run pytest tests/test_score_bundle.py`, skipped when absent)
//!
//! The manifest validates, every tile decodes to n_frames * n_bins bytes, rebuilding
//! levels 1.. of the mix and each stem from level 0 in Rust reproduces Python's levels
//! byte-for-byte (decoded), and every dominant-stem level equals the argmax over the
//! stems recomputed in Rust.

use orchspec_core::manifest::{Manifest, TileEncoding};
use orchspec_core::open_bundle;
use orchspec_core::tiles::{
    decode_tile, encode_tile, lod_frame_counts, pool_max, pyramid, read_level, write_level,
};
use std::path::{Path, PathBuf};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `v = round_half_even((clamp(db) - db_min) * 255 / range)` (numpy rint), as the writer does.
fn quantize(db: f64, db_min: f64, db_max: f64) -> u8 {
    ((db.clamp(db_min, db_max) - db_min) * 255.0 / (db_max - db_min)).round_ties_even() as u8
}

fn check_bundle(root: &Path) -> Manifest {
    let m = open_bundle(root).unwrap_or_else(|e| panic!("{}: {e}", root.display()));
    let n_bins = m.n_bins as usize;
    // dominant-stem tiles are not pooled: each level is the per-cell argmax over the
    // stems' (pooled) levels, earliest stem on ties, none_value at or below the floor
    if let Some(d) = &m.dominant {
        let floor = quantize(d.floor_db, m.db_min, m.db_max);
        for (lv, dl) in d.lods.iter().enumerate() {
            let got = read_level(root, dl, n_bins, m.tile_encoding).unwrap();
            let stems: Vec<Vec<u8>> = m
                .stems
                .iter()
                .map(|s| read_level(root, &s.lods[lv], n_bins, m.tile_encoding).unwrap())
                .collect();
            let mut best = vec![0u8; got.len()];
            let mut want = vec![d.none_value as u8; got.len()];
            for (si, st) in stems.iter().enumerate() {
                for ((b, w), &v) in best.iter_mut().zip(want.iter_mut()).zip(st) {
                    if v > *b && v > floor {
                        *b = v;
                        *w = si as u8;
                    }
                }
            }
            assert!(got == want, "dominant: level {lv} is not the argmax over the stems");
        }
    }
    for (name, lods) in m.all_lods().into_iter().filter(|(n, _)| n != "dominant") {
        let levels: Vec<Vec<u8>> = lods
            .iter()
            .map(|l| read_level(root, l, n_bins, m.tile_encoding).unwrap_or_else(|e| panic!("{name}: {e}")))
            .collect();
        let rebuilt = pyramid(&levels[0], n_bins, m.tile_frames);
        assert_eq!(rebuilt.len(), levels.len(), "{name}: level count");
        for (i, (a, b)) in rebuilt.iter().zip(&levels).enumerate() {
            assert!(a == b, "{name}: level {i} differs from the Python writer");
        }
    }
    m
}

#[test]
fn tiny_bundle_matches_python() {
    let m = check_bundle(&repo().join("viewer/public/tiny-bundle"));
    assert_eq!(m.tile_encoding, TileEncoding::Raw);
    assert_eq!(m.schema_version, 4);
}

#[test]
fn python_score_bundle_matches_python() {
    let root = repo().join("viewer/test-data/py-score-bundle");
    if !root.join("manifest.json").exists() {
        eprintln!("skipped: run `uv run pytest tests/test_score_bundle.py` first");
        return;
    }
    let m = check_bundle(&root);
    assert_eq!(m.tile_encoding, TileEncoding::Gzip);
    let sc = m.score.as_ref().expect("score section");
    assert_eq!(sc.notes.columns.len(), 11);
    assert!(m.dominant.is_some() && !m.stems.is_empty());
}

#[test]
fn manifest_round_trips_through_serde() {
    let bytes = std::fs::read(repo().join("viewer/public/tiny-bundle/manifest.json")).unwrap();
    let m = Manifest::from_json(&bytes).unwrap();
    let again = Manifest::from_json(serde_json::to_string(&m).unwrap().as_bytes()).unwrap();
    assert_eq!(m, again);
}

fn tiny_json() -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(repo().join("viewer/public/tiny-bundle/manifest.json")).unwrap())
        .unwrap()
}

#[test]
fn rejects_what_python_rejects() {
    type Mutate = fn(&mut serde_json::Value);
    let cases: [(&str, Mutate); 7] = [
        ("traversal", |d| d["audio_path"] = "../x.wav".into()),
        ("absolute", |d| d["audio_path"] = "/etc/passwd".into()),
        ("drive", |d| d["audio_path"] = "C:/x.wav".into()),
        ("unknown field", |d| d["surprise"] = 1.into()),
        ("version", |d| d["schema_version"] = 5.into()),
        ("gzip before v4", |d| {
            d["schema_version"] = 3.into();
            d["tile_encoding"] = "gzip".into();
        }),
        ("frames", |d| d["n_frames"] = (d["n_frames"].as_u64().unwrap() + 1).into()),
    ];
    for (name, mutate) in cases {
        let mut d = tiny_json();
        mutate(&mut d);
        let r = Manifest::from_json(serde_json::to_string(&d).unwrap().as_bytes());
        assert!(r.is_err(), "{name}: accepted");
    }
}

#[test]
fn pyramid_rules() {
    assert_eq!(lod_frame_counts(1000, 64), vec![1000, 500, 250, 125, 63]);
    let a = [1u8, 5, 2, 0, 7];
    assert_eq!(pool_max(&a, 1), vec![5, 2, 7]);
}

#[test]
fn gzip_tiles_round_trip_and_are_reproducible() {
    let raw: Vec<u8> = (0..4096u32).map(|i| (i * 7 % 256) as u8).collect();
    let gz = encode_tile(&raw, TileEncoding::Gzip).unwrap();
    assert_eq!(&gz[..2], &[0x1f, 0x8b]);
    assert_eq!(&gz[4..8], &[0, 0, 0, 0], "mtime must be 0");
    assert_eq!(gz, encode_tile(&raw, TileEncoding::Gzip).unwrap());
    assert_eq!(decode_tile(&gz, TileEncoding::Gzip).unwrap(), raw);

    let dir = std::env::temp_dir().join(format!("orchspec-core-test-{}", std::process::id()));
    let lod = write_level(&dir, "tiles/mix", 0, &raw, 16, 100, TileEncoding::Gzip).unwrap();
    assert_eq!(lod.tiles.len(), 3); // 256 frames of 16 bins in tiles of 100
    assert!(lod.tiles[0].path.ends_with("00000.u8.gz"));
    assert_eq!(read_level(&dir, &lod, 16, TileEncoding::Gzip).unwrap(), raw);
    std::fs::remove_dir_all(&dir).unwrap();
}
