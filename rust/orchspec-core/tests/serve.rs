//! The desktop protocol's serving rules (mirrors tests/test_serve_hardening.py).

use orchspec_core::serve::{CSP, parse_range, percent_decode, route, safe_join};
use std::fs;
use std::path::PathBuf;

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(tag: &str) -> (TempDir, PathBuf) {
    let base = std::env::temp_dir().join(format!("orchspec-serve-{tag}-{}", std::process::id()));
    let root = base.join("b.bundle");
    fs::create_dir_all(root.join("tiles")).unwrap();
    fs::write(root.join("manifest.json"), b"{}").unwrap();
    fs::write(root.join("a.bin"), (0u8..200).collect::<Vec<_>>()).unwrap();
    fs::write(root.join("tiles/t.u8.gz"), [0x1f, 0x8b, 8, 0]).unwrap();
    fs::write(root.join(".hidden"), b"x").unwrap();
    fs::write(base.join("secret.txt"), b"outside").unwrap();
    let canon = root.canonicalize().unwrap();
    (TempDir(base), canon)
}

fn viewer(rel: &str) -> Option<Vec<u8>> {
    match rel {
        "index.html" => Some(b"<!doctype html>".to_vec()),
        "assets/app.js" => Some(b"console.log(1)".to_vec()),
        _ => None,
    }
}

#[test]
fn confines_paths_to_the_bundle() {
    let (_t, root) = fixture("confine");
    assert!(safe_join(&root, "a.bin").is_some());
    for bad in ["../secret.txt", "tiles/../../secret.txt", ".hidden", "..\\secret.txt", "C:/Windows/win.ini", "nope", "tiles"] {
        assert!(safe_join(&root, bad).is_none(), "{bad}");
    }
    let r = route("GET", "/bundle/%2E%2E/secret.txt", None, Some(&root), &viewer);
    assert_eq!(r.status, 404);
}

#[test]
fn serves_bundle_and_viewer_with_security_headers() {
    let (_t, root) = fixture("headers");
    let r = route("GET", "/bundle/manifest.json", None, Some(&root), &viewer);
    assert_eq!((r.status, r.body.as_slice()), (200, b"{}".as_slice()));
    assert_eq!(r.header("content-security-policy"), Some(CSP));
    assert_eq!(r.header("x-content-type-options"), Some("nosniff"));
    let g = route("GET", "/bundle/tiles/t.u8.gz", None, Some(&root), &viewer);
    assert_eq!(g.header("content-type"), Some("application/octet-stream"));
    assert!(g.header("content-encoding").is_none(), "gzip tiles are opaque bytes");
    let i = route("GET", "/", None, Some(&root), &viewer);
    assert_eq!((i.status, i.header("content-type")), (200, Some("text/html; charset=utf-8")));
    assert_eq!(route("GET", "/assets/app.js", None, None, &viewer).status, 200);
    assert_eq!(route("GET", "/bundle/a.bin", None, None, &viewer).status, 404); // nothing open
    assert_eq!(route("POST", "/bundle/a.bin", None, Some(&root), &viewer).status, 405);
    assert_eq!(route("GET", "/.env", None, Some(&root), &viewer).status, 404);
}

#[test]
fn byte_ranges() {
    let (_t, root) = fixture("ranges");
    let r = route("GET", "/bundle/a.bin", Some("bytes=10-19"), Some(&root), &viewer);
    assert_eq!(r.status, 206);
    assert_eq!(r.body, (10u8..20).collect::<Vec<_>>());
    assert_eq!(r.header("content-range"), Some("bytes 10-19/200"));
    let tail = route("GET", "/bundle/a.bin", Some("bytes=-5"), Some(&root), &viewer);
    assert_eq!(tail.body, (195u8..200).collect::<Vec<_>>());
    assert_eq!(route("GET", "/bundle/a.bin", Some("bytes=500-"), Some(&root), &viewer).status, 416);
    assert_eq!(parse_range(Some("bytes=0-99999"), 200), Ok(Some((0, 199))));
    assert_eq!(parse_range(Some("items=0-1"), 200), Ok(None));
    assert_eq!(parse_range(Some("bytes=0-1,5-6"), 200), Ok(None));
}

#[test]
fn percent_decoding() {
    assert_eq!(percent_decode("/bundle/My%20Session/x").as_deref(), Some("/bundle/My Session/x"));
    assert_eq!(percent_decode("/bad%2"), None);
    assert_eq!(percent_decode("/bad%zz"), None);
}
