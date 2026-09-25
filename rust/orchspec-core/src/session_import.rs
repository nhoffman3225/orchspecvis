//! Importing a session from the desktop app: the app runs the Python analysis CLI
//! (`orchspec bundle`) as a subprocess and serves its progress as read-only JSON. This
//! module holds the pure parts: the status record, parsing the CLI's output lines, and
//! locating the CLI. No shell is involved; arguments are passed as a list.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_LINES: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportState {
    #[default]
    Idle,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportStatus {
    pub state: ImportState,
    pub session: String,
    pub lines: Vec<String>,
    pub stems_done: u32,
    pub stems_total: u32,
    pub bundle: Option<String>,
    pub error: Option<String>,
}

impl ImportStatus {
    pub fn start(session: &Path) -> ImportStatus {
        ImportStatus {
            state: ImportState::Running,
            session: session.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ..Default::default()
        }
    }

    /// Takes one line of CLI output: keeps a tail for display and picks out progress
    /// ("stem 3/23: ..."), the result ("wrote <path> (...)") and errors ("error: ...").
    pub fn line(&mut self, raw: &str) {
        let line = raw.trim_end();
        if line.is_empty() {
            return;
        }
        if let Some(rest) = line.strip_prefix("stem ")
            && let Some((frac, _)) = rest.split_once(':')
            && let Some((a, b)) = frac.split_once('/')
            && let (Ok(a), Ok(b)) = (a.trim().parse(), b.trim().parse())
        {
            self.stems_done = a;
            self.stems_total = b;
        }
        if let Some(rest) = line.strip_prefix("wrote ") {
            let path = rest.rsplit_once(" (").map_or(rest, |(p, _)| p);
            self.bundle = Some(path.to_string());
        }
        if let Some(e) = line.strip_prefix("error: ") {
            self.error = Some(e.to_string());
        }
        self.lines.push(line.to_string());
        if self.lines.len() > MAX_LINES {
            self.lines.drain(..self.lines.len() - MAX_LINES);
        }
    }

    /// The process ended with `success`.
    pub fn finish(&mut self, success: bool) {
        if success && self.bundle.is_some() {
            self.state = ImportState::Done;
        } else {
            self.state = ImportState::Error;
            if self.error.is_none() {
                self.error = Some(if success {
                    "the analysis finished without reporting a bundle".into()
                } else {
                    self.lines.last().cloned().unwrap_or_else(|| "the analysis failed".into())
                });
            }
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_else(|_| b"{}".to_vec())
    }
}

/// How to start the analysis CLI: a program and the arguments before `bundle ...`.
#[derive(Debug, Clone, PartialEq)]
pub struct Cli {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The runtime shipped inside the app (scripts/build_runtime.py).
    pub bundled: bool,
}

impl Cli {
    fn exe(program: PathBuf) -> Cli {
        Cli { program, args: Vec::new(), bundled: false }
    }
}

/// The interpreter of the bundled runtime under the app's resource folder.
pub fn runtime_python(resources: &Path) -> PathBuf {
    if cfg!(windows) {
        resources.join("python").join("python.exe")
    } else {
        resources.join("python").join("bin").join("python3")
    }
}

/// The analysis CLI: `$ORCHSPEC_CLI`, else the runtime bundled with the app
/// (`<resources>/python`, run as `python -P -m orchspec.cli`: `-P` keeps the working
/// folder off the import path), else the project's venv found by walking up from `start`
/// (a development checkout: target/release/.. -> repo/.venv), else `orchspec` on PATH.
pub fn find_cli(start: &Path, env: Option<&str>, resources: Option<&Path>) -> Cli {
    if let Some(p) = env.filter(|p| !p.is_empty()) {
        return Cli::exe(PathBuf::from(p));
    }
    if let Some(py) = resources.map(runtime_python).filter(|p| p.is_file()) {
        let args = ["-P", "-m", "orchspec.cli"].map(String::from).to_vec();
        return Cli { program: py, args, bundled: true };
    }
    let rel: &[&str] =
        if cfg!(windows) { &[".venv", "Scripts", "orchspec.exe"] } else { &[".venv", "bin", "orchspec"] };
    let mut dir = Some(start);
    while let Some(d) = dir {
        let mut c = d.to_path_buf();
        c.extend(rel);
        if c.is_file() {
            return Cli::exe(c);
        }
        dir = d.parent();
    }
    Cli::exe(PathBuf::from(if cfg!(windows) { "orchspec.exe" } else { "orchspec" }))
}

/// A session folder must contain mix.wav (docs: session contract).
pub fn looks_like_session(dir: &Path) -> bool {
    dir.join("mix.wav").is_file()
}
