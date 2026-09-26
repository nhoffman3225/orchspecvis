use orchspec_core::app::{BuildSpec, assemble_session, list_bundles, load_recents, push_recent, safe_name};
use std::fs;
use std::path::{Path, PathBuf};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("orchspec-app-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn touch(p: &Path, body: &[u8]) -> PathBuf {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
    p.to_path_buf()
}

#[test]
fn assembles_a_session_from_chosen_files() {
    let d = tmp("assemble");
    let src = d.join("src");
    let spec = BuildSpec {
        name: "My Piece: take 2".into(),
        mix: None,
        stems: vec![touch(&src.join("Flute 1.wav"), b"A"), touch(&src.join("07_Oboe.WAV"), b"B")],
        musicxml: Some(touch(&src.join("full score.mxl"), b"X")),
        midi: Some(touch(&src.join("render.midi"), b"M")),
        pdf: Some(touch(&src.join("condensed.pdf"), b"P")),
    };
    let out = assemble_session(&spec, &d.join("sessions")).unwrap();
    assert_eq!(out.file_name().unwrap(), "My Piece_ take 2");
    let mut names: Vec<String> = walk(&out);
    names.sort();
    assert_eq!(names, ["render.mid", "score.mxl", "score.pdf", "stems/01_Flute 1.wav", "stems/07_Oboe.wav"]);
    assert_eq!(fs::read(out.join("stems/07_Oboe.wav")).unwrap(), b"B");
    // building again replaces the app's earlier folder of that name
    let spec2 = BuildSpec { mix: Some(touch(&src.join("mix.flac"), b"F")), stems: vec![], ..spec };
    let out2 = assemble_session(&spec2, &d.join("sessions")).unwrap();
    assert_eq!(out2, out);
    assert!(out.join("mix.flac").is_file() && !out.join("stems").exists());
    fs::remove_dir_all(&d).unwrap();
}

fn walk(dir: &Path) -> Vec<String> {
    let mut v = vec![];
    for e in fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            for s in walk(&p) {
                v.push(format!("{}/{s}", p.file_name().unwrap().to_string_lossy()));
            }
        } else {
            v.push(p.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    v
}

#[test]
fn rejects_incomplete_or_wrong_files() {
    let d = tmp("reject");
    let none = BuildSpec { name: "x".into(), ..Default::default() };
    assert!(assemble_session(&none, &d).unwrap_err().contains("mix, the stems"));
    let wrong =
        BuildSpec { name: "x".into(), mix: Some(touch(&d.join("notes.txt"), b"")), ..Default::default() };
    assert!(assemble_session(&wrong, &d).unwrap_err().contains("not an audio file"));
    let missing = BuildSpec { name: "x".into(), mix: Some(d.join("gone.wav")), ..Default::default() };
    assert!(assemble_session(&missing, &d).unwrap_err().contains("not found"));
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn safe_names() {
    assert_eq!(safe_name("  ../..\\evil/name "), "_.._evil_name");
    assert_eq!(safe_name(""), "Untitled");
    assert_eq!(safe_name("Beethoven 5 (i)"), "Beethoven 5 (i)");
}

#[test]
fn lists_recent_then_newest_bundles() {
    let d = tmp("list");
    let folder = d.join("bundles");
    let a = folder.join("A.bundle");
    let b = folder.join("B.bundle");
    let elsewhere = d.join("elsewhere").join("C.bundle");
    touch(&a.join("manifest.json"), br#"{"score": null}"#);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    touch(&b.join("manifest.json"), br#"{"score": {"kind": "musicxml"}}"#);
    touch(&elsewhere.join("manifest.json"), b"{}");
    fs::create_dir_all(folder.join("not-a-bundle")).unwrap();
    let recents_file = d.join("cfg").join("recent.json");
    push_recent(&recents_file, &a).unwrap();
    push_recent(&recents_file, &elsewhere).unwrap();
    push_recent(&recents_file, &d.join("deleted.bundle")).unwrap();
    let recents = load_recents(&recents_file);
    assert_eq!(recents.len(), 3);
    let list = list_bundles(&folder, &recents);
    let names: Vec<(&str, bool, bool)> =
        list.iter().map(|e| (e.name.as_str(), e.recent, e.has_score)).collect();
    // recents in order (the deleted one skipped), then the rest of the folder, newest first
    assert_eq!(names, [("C", true, false), ("A", true, false), ("B", false, true)]);
    fs::remove_dir_all(&d).unwrap();
}
