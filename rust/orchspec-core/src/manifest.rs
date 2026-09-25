//! Bundle manifest, schema versions 1-4 — the Rust mirror of
//! `src/orchspec/bundle/schema.py` and `viewer/src/bundle.ts` (normative text:
//! docs/bundle-format.md). Unknown fields are rejected everywhere, like the Python model.

use serde::{Deserialize, Serialize};
use std::fmt;

pub const MANIFEST_NAME: &str = "manifest.json";
pub const SUPPORTED_VERSIONS: [u32; 4] = [1, 2, 3, 4];
pub const NONE_STEM: u32 = 255;
pub const NOTE_COLUMNS: [&str; 11] = [
    "part", "staff", "voice", "midi", "onset_s", "offset_s", "measure", "beat", "velocity",
    "f0_db", "f0_ok",
];

#[derive(Debug, Clone, PartialEq)]
pub struct ManifestError(pub String);

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid manifest: {}", self.0)
    }
}

impl std::error::Error for ManifestError {}

fn fail<T>(msg: impl Into<String>) -> Result<T, ManifestError> {
    Err(ManifestError(msg.into()))
}

/// Relative POSIX path inside the bundle: no absolute paths, backslashes, `:` or `..`.
pub fn check_rel_path(p: &str) -> Result<(), ManifestError> {
    if p.is_empty()
        || p.contains('\\')
        || p.contains(':')
        || p.starts_with('/')
        || p.split('/').any(|c| c == "..")
    {
        return fail(format!("bundle path must be relative POSIX inside the bundle: {p:?}"));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TileEncoding {
    #[default]
    Raw,
    Gzip,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tile {
    pub index: u32,
    pub start_frame: u64,
    pub n_frames: u64,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lod {
    pub level: u32,
    pub hop_factor: u64,
    pub n_frames: u64,
    pub tiles: Vec<Tile>,
}

impl Lod {
    fn check(&self) -> Result<(), ManifestError> {
        if self.level >= 63 || self.hop_factor != 1u64 << self.level {
            return fail("hop_factor must equal 2**level");
        }
        if self.n_frames < 1 {
            return fail("lod n_frames must be >= 1");
        }
        let mut expect = 0;
        for (i, t) in self.tiles.iter().enumerate() {
            check_rel_path(&t.path)?;
            if t.n_frames < 1 || t.index as usize != i || t.start_frame != expect {
                return fail(format!("level {}: tiles must be contiguous and ordered", self.level));
            }
            expect += t.n_frames;
        }
        if expect != self.n_frames {
            return fail(format!("level {}: tiles cover {expect} != n_frames", self.level));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stem {
    pub id: String,
    pub index: u32,
    pub name: String,
    pub source_file: String,
    pub lods: Vec<Lod>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DominantStem {
    #[serde(default = "none_stem")]
    pub none_value: u32,
    pub floor_db: f64,
    pub lods: Vec<Lod>,
}

fn none_stem() -> u32 {
    NONE_STEM
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Series {
    pub name: String,
    pub unit: String,
    #[serde(default)]
    pub description: String,
    pub path: String,
    pub shape: Vec<u64>,
    #[serde(default = "f32le")]
    pub dtype: String,
    #[serde(default)]
    pub t0_seconds: f64,
    pub hop_seconds: f64,
    #[serde(default)]
    pub row_labels: Option<Vec<String>>,
}

fn f32le() -> String {
    "f32le".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CqtInfo {
    pub backend: String,
    pub k: u32,
    #[serde(default = "one")]
    pub filter_scale: f64,
    #[serde(default = "hann")]
    pub window: String,
    #[serde(default)]
    pub tuning: f64,
    #[serde(default = "centered")]
    pub frame_convention: String,
}

fn one() -> f64 {
    1.0
}
fn hann() -> String {
    "hann".into()
}
fn centered() -> String {
    "centered".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Offsets {
    #[serde(default)]
    pub preroll_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceInfo {
    pub kind: String, // wav | session
    pub name: String,
    #[serde(default)]
    pub renderer: Option<String>,
    #[serde(default)]
    pub render_config: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScorePart {
    pub index: u32,
    pub id: String,
    pub name: String,
    pub instrument: String,
    #[serde(default)]
    pub abbreviation: String,
    #[serde(default = "one_u32")]
    pub staves: u32,
    #[serde(default)]
    pub transpose_chromatic: i32,
    #[serde(default)]
    pub transpose_octave: i32,
    #[serde(default)]
    pub stem_id: Option<String>,
    #[serde(default = "none_str")]
    pub stem_match: String,
    #[serde(default)]
    pub range_id: Option<String>,
    #[serde(default)]
    pub range_low: Option<i32>,
    #[serde(default)]
    pub range_high: Option<i32>,
    #[serde(default)]
    pub practical_low: Option<i32>,
    #[serde(default)]
    pub practical_high: Option<i32>,
    #[serde(default)]
    pub latency_sec: Option<f64>,
    #[serde(default)]
    pub snapped: Option<f64>,
}

fn one_u32() -> u32 {
    1
}
fn none_str() -> String {
    "none".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreMeasure {
    pub play_index: u32,
    pub number: String,
    pub start_s: f64,
    pub end_s: f64,
    pub beats: i32,
    pub beat_type: i32,
    #[serde(default = "one_u32")]
    pub pass_no: u32,
    #[serde(default)]
    pub source_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Alignment {
    pub method: String,
    pub offset_sec: f64,
    pub preroll_sec: f64,
    pub confidence: f64,
    pub time_source: String,
    #[serde(default)]
    pub pitch_agreement: Option<f64>,
    #[serde(default)]
    pub pitch_shift_mode: Option<i32>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub warp: Vec<(f64, f64)>,
    #[serde(default)]
    pub snapped: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotesTable {
    pub path: String,
    pub n: u64,
    pub columns: Vec<String>,
    #[serde(default = "f32le")]
    pub dtype: String,
    #[serde(default = "column_major")]
    pub layout: String,
}

fn column_major() -> String {
    "column_major".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreInfo {
    pub kind: String,
    pub source_files: Vec<String>,
    pub parts: Vec<ScorePart>,
    pub measures: Vec<ScoreMeasure>,
    pub notes: NotesTable,
    pub alignment: Alignment,
    #[serde(default)]
    pub score_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub created_by: String,
    pub created_at: String,
    pub sr: u32,
    pub hop: u32,
    pub n_samples: u64,
    pub duration_seconds: f64,
    #[serde(default = "fmin")]
    pub fmin_midi: f64,
    pub bins_per_octave: u32,
    pub n_bins: u32,
    pub n_frames: u64,
    pub db_min: f64,
    pub db_max: f64,
    #[serde(default = "db_reference")]
    pub db_reference: String,
    #[serde(default = "max")]
    pub lod_reduce: String,
    pub tile_frames: u64,
    #[serde(default = "frame_major")]
    pub tile_layout: String,
    #[serde(default)]
    pub tile_encoding: TileEncoding,
    pub lods: Vec<Lod>,
    pub audio_path: String,
    pub audio_sha256: String,
    pub cqt: CqtInfo,
    #[serde(default)]
    pub offsets: Offsets,
    pub source: SourceInfo,
    #[serde(default)]
    pub stems: Vec<Stem>,
    #[serde(default)]
    pub dominant: Option<DominantStem>,
    #[serde(default)]
    pub features: Vec<Series>,
    #[serde(default)]
    pub tables: Vec<Series>,
    #[serde(default)]
    pub score: Option<ScoreInfo>,
}

fn fmin() -> f64 {
    21.0
}
fn db_reference() -> String {
    "full_scale_sine_per_bin".into()
}
fn max() -> String {
    "max".into()
}
fn frame_major() -> String {
    "frame_major_u8".into()
}

fn one_of(what: &str, v: &str, allowed: &[&str]) -> Result<(), ManifestError> {
    if allowed.contains(&v) { Ok(()) } else { fail(format!("{what} must be one of {}", allowed.join("|"))) }
}

impl Manifest {
    /// Parses and validates `manifest.json` bytes.
    pub fn from_json(bytes: &[u8]) -> Result<Manifest, ManifestError> {
        let m: Manifest = serde_json::from_slice(bytes).map_err(|e| ManifestError(e.to_string()))?;
        m.validate()?;
        Ok(m)
    }

    /// The same consistency rules as schema.py's validators.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if !SUPPORTED_VERSIONS.contains(&self.schema_version) {
            return fail(format!("unsupported version {}", self.schema_version));
        }
        if self.sr == 0 || self.hop == 0 || self.n_samples == 0 || self.n_bins == 0 || self.tile_frames == 0 {
            return fail("sr, hop, n_samples, n_bins and tile_frames must be > 0");
        }
        if !(self.duration_seconds > 0.0) {
            return fail("duration_seconds must be > 0");
        }
        if self.bins_per_octave == 0 || self.bins_per_octave % 12 != 0 {
            return fail("bins_per_octave must be a multiple of 12");
        }
        if self.db_max <= self.db_min {
            return fail("db_max must exceed db_min");
        }
        if self.n_frames != 1 + self.n_samples / self.hop as u64 {
            return fail("n_frames must equal 1 + n_samples // hop (centered frames)");
        }
        one_of("db_reference", &self.db_reference, &["full_scale_sine_per_bin"])?;
        one_of("lod_reduce", &self.lod_reduce, &["max"])?;
        one_of("tile_layout", &self.tile_layout, &["frame_major_u8"])?;
        if self.tile_encoding != TileEncoding::Raw && self.schema_version < 4 {
            return fail("tile_encoding other than raw requires schema_version 4");
        }
        check_rel_path(&self.audio_path)?;
        let hex = self.audio_sha256.len() == 64
            && self.audio_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex {
            return fail("audio_sha256 must be 64 lowercase hex digits");
        }
        if self.cqt.k < 1 {
            return fail("cqt.k must be >= 1");
        }
        one_of("cqt.frame_convention", &self.cqt.frame_convention, &["centered"])?;
        one_of("source.kind", &self.source.kind, &["wav", "session"])?;
        for (name, lods) in self.all_lods() {
            let first = lods.first();
            if first.is_none_or(|l| l.level != 0 || l.n_frames != self.n_frames) {
                return fail(format!("{name}: level 0 must exist and span n_frames"));
            }
            for w in lods.windows(2) {
                if w[1].level != w[0].level + 1 || w[1].n_frames != w[0].n_frames.div_ceil(2) {
                    return fail(format!("{name}: level {} frame count wrong", w[1].level));
                }
            }
            for l in lods {
                l.check()?;
                if l.tiles.iter().any(|t| t.n_frames > self.tile_frames) {
                    return fail(format!("{name}: tile larger than tile_frames"));
                }
            }
        }
        let mut ids: Vec<&str> = self.stems.iter().map(|s| s.id.as_str()).collect();
        for (i, s) in self.stems.iter().enumerate() {
            if s.index as usize != i {
                return fail("stem indices must be 0..n-1 in order");
            }
            if s.index >= NONE_STEM {
                return fail("stem index must be < 255");
            }
            let ok = !s.id.is_empty()
                && s.id.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b));
            if !ok {
                return fail(format!("stem id {:?} has invalid characters", s.id));
            }
        }
        ids.sort_unstable();
        if ids.windows(2).any(|w| w[0] == w[1]) {
            return fail("stem ids must be unique");
        }
        for s in self.features.iter().chain(&self.tables) {
            check_rel_path(&s.path)?;
            one_of("series dtype", &s.dtype, &["f32le"])?;
            if !(s.hop_seconds > 0.0) {
                return fail(format!("{}: hop_seconds must be > 0", s.name));
            }
        }
        if let Some(sc) = &self.score {
            if self.schema_version < 2 {
                return fail("a score section requires schema_version 2");
            }
            one_of("score.kind", &sc.kind, &["musicxml", "midi"])?;
            check_rel_path(&sc.notes.path)?;
            if let Some(f) = &sc.score_file {
                check_rel_path(f)?;
            }
            if sc.parts.iter().enumerate().any(|(i, p)| p.index as usize != i) {
                return fail("score part indices must be 0..n-1 in order");
            }
            if sc.measures.iter().enumerate().any(|(i, m)| m.play_index as usize != i) {
                return fail("score measures must be in playback order");
            }
            if sc.notes.columns.iter().map(String::as_str).ne(NOTE_COLUMNS) {
                return fail(format!("notes columns must be {NOTE_COLUMNS:?}"));
            }
            one_of("score.alignment.method", &sc.alignment.method, &["warp", "xcorr", "manual", "preroll_only"])?;
            one_of("score.alignment.time_source", &sc.alignment.time_source, &["midi", "score_tempo"])?;
            for p in &sc.parts {
                one_of("stem_match", &p.stem_match, &["name", "fuzzy", "order", "none"])?;
                if let Some(id) = &p.stem_id {
                    if !self.stems.iter().any(|s| &s.id == id) {
                        return fail(format!("score part {:?} refers to unknown stem {id:?}", p.name));
                    }
                }
            }
        }
        Ok(())
    }

    /// Every pyramid in the bundle with a label: mix, each stem, dominant.
    pub fn all_lods(&self) -> Vec<(String, &Vec<Lod>)> {
        let mut out = vec![("mix".to_string(), &self.lods)];
        out.extend(self.stems.iter().map(|s| (format!("stem {}", s.id), &s.lods)));
        if let Some(d) = &self.dominant {
            out.push(("dominant".to_string(), &d.lods));
        }
        out
    }

    pub fn k(&self) -> u32 {
        self.bins_per_octave / 12
    }

    pub fn frame_to_seconds(&self, f: f64, level: u32) -> f64 {
        f * self.hop as f64 * (1u64 << level) as f64 / self.sr as f64
    }
}
