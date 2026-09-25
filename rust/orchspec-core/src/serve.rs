//! Read-only local file serving for the desktop app's custom protocol — the same rules as
//! `orchspec serve` (src/orchspec/server.py): GET/HEAD only, paths confined to the root,
//! no hidden files, single byte ranges (streaming playback), the viewer CSP on every
//! response. Pure std; the Tauri shell only adapts these to its request/response types.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Identical to server.py's CSP (SECURITY.md).
pub const CSP: &str = "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; \
script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; media-src 'self' blob:; \
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Headers added to every response (besides Content-Type / ranges).
pub const SECURITY_HEADERS: [(&str, &str); 5] = [
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Cache-Control", "no-store"),
];

/// Percent-decodes a URL path (UTF-8). None for malformed escapes or invalid UTF-8.
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Resolves `rel` (already percent-decoded) under `root`; None if it escapes, is hidden,
/// or is not an existing file. `root` must be canonical (see `canonical_root`).
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.contains('\\') || rel.contains('\0') || rel.contains(':') {
        return None;
    }
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == "." || *p == ".." || p.starts_with('.')) {
        return None;
    }
    let mut p = root.to_path_buf();
    p.extend(&parts);
    let real = p.canonicalize().ok()?; // resolves symlinks: a link out of the root fails below
    (real.starts_with(root) && real.is_file()).then_some(real)
}

pub fn canonical_root(p: &Path) -> io::Result<PathBuf> {
    p.canonicalize()
}

pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "musicxml" | "xml" => "application/xml",
        _ => "application/octet-stream", // tiles (.u8, .u8.gz: opaque, no Content-Encoding)
    }
}

/// A Range header that cannot be satisfied (HTTP 416).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsatisfiable;

/// A single `bytes=` range -> inclusive (start, end), clamped to `size`.
/// Ok(None): no/unsupported Range header (serve the whole file).
pub fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, Unsatisfiable> {
    let Some(h) = header else { return Ok(None) };
    let Some(spec) = h.trim().strip_prefix("bytes=") else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None); // multi-range: not supported, whole file (allowed by RFC 9110)
    }
    let (a, b) = spec.split_once('-').ok_or(Unsatisfiable)?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return Err(Unsatisfiable),
        ("", n) => {
            let n: u64 = n.parse().map_err(|_| Unsatisfiable)?;
            (size.saturating_sub(n), size.saturating_sub(1))
        }
        (s, "") => (s.parse().map_err(|_| Unsatisfiable)?, size.saturating_sub(1)),
        (s, e) => (s.parse().map_err(|_| Unsatisfiable)?, e.parse::<u64>().map_err(|_| Unsatisfiable)?.min(size.saturating_sub(1))),
    };
    if size == 0 || start > end || start >= size {
        return Err(Unsatisfiable);
    }
    Ok(Some((start, end)))
}

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    fn new(status: u16, content_type: &str, body: Vec<u8>) -> Reply {
        let mut headers: Vec<(String, String)> =
            SECURITY_HEADERS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        headers.push(("Content-Type".into(), content_type.into()));
        Reply { status, headers, body }
    }

    pub fn text(status: u16, msg: &str) -> Reply {
        Reply::new(status, "text/plain; charset=utf-8", msg.as_bytes().to_vec())
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Serves one file (whole or one byte range). `head`: headers only.
pub fn serve_file(path: &Path, range: Option<&str>, head: bool) -> io::Result<Reply> {
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let ctype = content_type(path);
    match parse_range(range, size) {
        Err(Unsatisfiable) => {
            let mut r = Reply::text(416, "range not satisfiable");
            r.headers.push(("Content-Range".into(), format!("bytes */{size}")));
            Ok(r)
        }
        Ok(Some((start, end))) => {
            let len = end - start + 1;
            let mut body = Vec::new();
            if !head {
                f.seek(SeekFrom::Start(start))?;
                f.take(len).read_to_end(&mut body)?;
            }
            let mut r = Reply::new(206, ctype, body);
            r.headers.push(("Content-Range".into(), format!("bytes {start}-{end}/{size}")));
            r.headers.push(("Accept-Ranges".into(), "bytes".into()));
            Ok(r)
        }
        Ok(None) => {
            let mut body = Vec::new();
            if !head {
                f.read_to_end(&mut body)?;
            }
            let mut r = Reply::new(200, ctype, body);
            r.headers.push(("Accept-Ranges".into(), "bytes".into()));
            Ok(r)
        }
    }
}

/// Routes a request path: `/bundle/<rel>` -> the opened bundle; anything else -> the viewer
/// (via `viewer`, which returns the asset bytes for a path like "index.html").
pub fn route(
    method: &str,
    path: &str,
    range: Option<&str>,
    bundle_root: Option<&Path>,
    viewer: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Reply {
    let head = method.eq_ignore_ascii_case("HEAD");
    if !head && !method.eq_ignore_ascii_case("GET") {
        return Reply::text(405, "read-only");
    }
    let Some(path) = percent_decode(path) else { return Reply::text(400, "bad path") };
    if let Some(rel) = path.strip_prefix("/bundle/") {
        let Some(root) = bundle_root else { return Reply::text(404, "no bundle open") };
        return match safe_join(root, rel) {
            Some(p) => serve_file(&p, range, head).unwrap_or_else(|_| Reply::text(500, "read error")),
            None => Reply::text(404, "not found"),
        };
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split('/').any(|p| p == ".." || p.starts_with('.')) || rel.contains('\\') || rel.contains(':') {
        return Reply::text(404, "not found");
    }
    match viewer(rel) {
        Some(body) => {
            let mut r = Reply::new(200, content_type(Path::new(rel)), if head { Vec::new() } else { body });
            r.headers.push(("Accept-Ranges".into(), "none".into()));
            r
        }
        None => Reply::text(404, "not found"),
    }
}
