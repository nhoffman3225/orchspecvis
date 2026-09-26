//! The desktop app's home screen and bundle wizard, the pure parts: listing bundles (the
//! bundles folder plus recently opened ones), the recents file, and assembling a session
//! folder from files the user chose (hard links where possible, else copies).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_RECENT: usize = 10;
const MAX_LISTED: usize = 40;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BundleEntry {
    pub name: String,
    pub path: String,
    /// last change, seconds since 1970
    pub modified: u64,
    pub has_score: bool,
    pub recent: bool,
}

fn entry(dir: &Path, recent: bool) -> Option<BundleEntry> {
    let manifest = dir.join("manifest.json");
    let meta = fs::metadata(&manifest).ok()?;
    let has_score = fs::read(&manifest)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v.get("score").is_some_and(|s| !s.is_null()));
    let name = dir.file_name()?.to_string_lossy().trim_end_matches(".bundle").to_string();
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some(BundleEntry { name, path: dir.to_string_lossy().into_owned(), modified, has_score, recent })
}

/// Recently opened bundles first (in order), then the other bundles in `folder`, newest
/// first; only folders that still hold a manifest.json.
pub fn list_bundles(folder: &Path, recents: &[PathBuf]) -> Vec<BundleEntry> {
    let mut out: Vec<BundleEntry> = recents.iter().filter_map(|p| entry(p, true)).collect();
    let mut rest: Vec<BundleEntry> = fs::read_dir(folder)
        .map(|rd| rd.flatten().filter_map(|e| entry(&e.path(), false)).collect())
        .unwrap_or_default();
    rest.sort_by_key(|e| std::cmp::Reverse(e.modified));
    for e in rest {
        if !out.iter().any(|o| same_path(&o.path, &e.path)) {
            out.push(e);
        }
    }
    out.truncate(MAX_LISTED);
    out
}

fn same_path(a: &str, b: &str) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

pub fn load_recents(file: &Path) -> Vec<PathBuf> {
    fs::read(file).ok().and_then(|b| serde_json::from_slice::<Vec<PathBuf>>(&b).ok()).unwrap_or_default()
}

/// Puts `bundle` first in the recents file (at most MAX_RECENT entries).
pub fn push_recent(file: &Path, bundle: &Path) -> std::io::Result<()> {
    let mut list = load_recents(file);
    list.retain(|p| p != bundle);
    list.insert(0, bundle.to_path_buf());
    list.truncate(MAX_RECENT);
    if let Some(d) = file.parent() {
        fs::create_dir_all(d)?;
    }
    fs::write(file, serde_json::to_vec_pretty(&list).unwrap_or_default())
}

/// What the wizard builds a session from; every path must be one the user picked.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildSpec {
    pub name: String,
    pub mix: Option<PathBuf>,
    #[serde(default)]
    pub stems: Vec<PathBuf>,
    pub musicxml: Option<PathBuf>,
    pub midi: Option<PathBuf>,
    pub pdf: Option<PathBuf>,
}

pub const AUDIO_EXT: &[&str] = &["wav", "flac", "aif", "aiff"];
pub const MUSICXML_EXT: &[&str] = &["musicxml", "xml", "mxl"];
pub const MIDI_EXT: &[&str] = &["mid", "midi"];
pub const PDF_EXT: &[&str] = &["pdf"];

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn has_ext(p: &Path, allowed: &[&str]) -> bool {
    allowed.contains(&ext_of(p).as_str())
}

/// A folder name from free text: letters, digits, space, `-_.()`; no leading dots.
pub fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.()".contains(c) { c } else { '_' })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .chars()
        .take(80)
        .collect();
    if cleaned.is_empty() { "Untitled".into() } else { cleaned }
}

impl BuildSpec {
    pub fn files(&self) -> Vec<&Path> {
        let mut v: Vec<&Path> = self.stems.iter().map(PathBuf::as_path).collect();
        v.extend(
            [&self.mix, &self.musicxml, &self.midi, &self.pdf].into_iter().flatten().map(PathBuf::as_path),
        );
        v
    }

    pub fn check(&self) -> Result<(), String> {
        if self.mix.is_none() && self.stems.is_empty() {
            return Err("choose the mix, the stems, or both".into());
        }
        let bad = |p: &Path, what: &str| format!("{}: not {what}", p.display());
        for p in self.mix.iter().chain(&self.stems) {
            if !has_ext(p, AUDIO_EXT) {
                return Err(bad(p, "an audio file (wav, flac, aiff)"));
            }
        }
        if let Some(p) = &self.musicxml
            && !has_ext(p, MUSICXML_EXT)
        {
            return Err(bad(p, "a MusicXML file"));
        }
        if let Some(p) = &self.midi
            && !has_ext(p, MIDI_EXT)
        {
            return Err(bad(p, "a MIDI file"));
        }
        if let Some(p) = &self.pdf
            && !has_ext(p, PDF_EXT)
        {
            return Err(bad(p, "a PDF"));
        }
        for p in self.files() {
            if !p.is_file() {
                return Err(format!("{}: file not found", p.display()));
            }
        }
        Ok(())
    }
}

/// Hard link (instant, no extra space) or, across drives, a copy.
fn place(src: &Path, dst: &Path) -> Result<(), String> {
    fs::hard_link(src, dst)
        .or_else(|_| fs::copy(src, dst).map(|_| ()))
        .map_err(|e| format!("{} -> {}: {e}", src.display(), dst.display()))
}

/// The stem file name: `NN_<name>.<ext>`, keeping an existing `NN_` prefix.
fn stem_name(i: usize, src: &Path) -> String {
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let numbered =
        stem.len() > 3 && stem.as_bytes()[..2].iter().all(u8::is_ascii_digit) && &stem[2..3] == "_";
    let base = if numbered { safe_name(&stem) } else { format!("{:02}_{}", i + 1, safe_name(&stem)) };
    format!("{base}.{}", ext_of(src))
}

/// Lays out the chosen files as a session folder `parent/<name>` (replacing an earlier
/// one of that name: the folder belongs to the app) and returns it.
pub fn assemble_session(spec: &BuildSpec, parent: &Path) -> Result<PathBuf, String> {
    spec.check()?;
    let dir = parent.join(safe_name(&spec.name));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if let Some(m) = &spec.mix {
        place(m, &dir.join(format!("mix.{}", ext_of(m))))?;
    }
    if !spec.stems.is_empty() {
        let sd = dir.join("stems");
        fs::create_dir_all(&sd).map_err(|e| format!("{}: {e}", sd.display()))?;
        for (i, s) in spec.stems.iter().enumerate() {
            place(s, &sd.join(stem_name(i, s)))?;
        }
    }
    if let Some(x) = &spec.musicxml {
        let name = if ext_of(x) == "mxl" { "score.mxl" } else { "score.musicxml" };
        place(x, &dir.join(name))?;
    }
    if let Some(m) = &spec.midi {
        place(m, &dir.join("render.mid"))?;
    }
    if let Some(p) = &spec.pdf {
        place(p, &dir.join("score.pdf"))?;
    }
    Ok(dir)
}
