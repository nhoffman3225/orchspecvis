use orchspec_core::session_import::{ImportState, ImportStatus, find_cli, looks_like_session};
use std::fs;

#[test]
fn parses_progress_result_and_errors() {
    let mut s = ImportStatus::start(std::path::Path::new("C:/sessions/Beethoven 5"));
    assert_eq!(s.session, "Beethoven 5");
    s.line("mix: 372.8 s, 2 ch\n");
    s.line("stem 3/23: 03_Oboe-1");
    assert_eq!((s.stems_done, s.stems_total), (3, 23));
    s.line("wrote C:\\app\\bundles\\Beethoven 5.bundle (34954 frames x 264 bins, 23 stems; load 1.8s)");
    assert_eq!(s.bundle.as_deref(), Some("C:\\app\\bundles\\Beethoven 5.bundle"));
    s.finish(true);
    assert_eq!(s.state, ImportState::Done);
    let json = String::from_utf8(s.to_json()).unwrap();
    assert!(json.contains("\"state\":\"done\""));

    let mut e = ImportStatus::start(std::path::Path::new("x"));
    e.line("error: session x: no mix.wav found (required)");
    e.finish(false);
    assert_eq!(e.state, ImportState::Error);
    assert_eq!(e.error.as_deref(), Some("session x: no mix.wav found (required)"));

    let mut long = ImportStatus::start(std::path::Path::new("x"));
    for i in 0..500 {
        long.line(&format!("line {i}"));
    }
    assert_eq!(long.lines.len(), 200);
    assert_eq!(long.lines[0], "line 300");
    long.finish(true); // no "wrote" line
    assert_eq!(long.state, ImportState::Error);
}

#[test]
fn finds_the_cli_in_a_checkout_venv() {
    let base = std::env::temp_dir().join(format!("orchspec-cli-{}", std::process::id()));
    let bin = if cfg!(windows) { base.join(".venv/Scripts") } else { base.join(".venv/bin") };
    fs::create_dir_all(&bin).unwrap();
    let exe = bin.join(if cfg!(windows) { "orchspec.exe" } else { "orchspec" });
    fs::write(&exe, b"").unwrap();
    let deep = base.join("target/release");
    fs::create_dir_all(&deep).unwrap();
    assert_eq!(find_cli(&deep, None), exe);
    assert_eq!(
        find_cli(&deep, Some("D:/tools/orchspec.exe")),
        std::path::PathBuf::from("D:/tools/orchspec.exe")
    );
    fs::write(base.join("mix.wav"), b"RIFF").unwrap();
    assert!(looks_like_session(&base));
    assert!(!looks_like_session(&deep));
    fs::remove_dir_all(&base).unwrap();
}
