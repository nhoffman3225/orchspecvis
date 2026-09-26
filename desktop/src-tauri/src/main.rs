// orchspec desktop (Phase 3b): the viewer build + one local bundle in the system webview.
//
// Everything is served by ONE custom protocol, so the viewer and the bundle share an
// origin (the viewer's same-origin fetch guard and CSP `connect-src 'self'` stay as in
// `orchspec serve`):
//   /bundle/<rel>        -> files of the opened bundle folder (read-only, confined, ranges)
//   /app/import.json     -> progress of a session import (read-only JSON)
//   /app/home.json       -> bundles for the home screen (recent + the bundles folder)
//   POST /app/open|pick|build|import -> native dialogs and actions for the home screen
//                           and the bundle wizard (see app_route)
//   /<anything>          -> the viewer build, embedded at compile time (frontendDist)
// Serving rules live in orchspec-core::serve (tested there). No updater, no telemetry,
// no IPC permissions (no capabilities file): the page reaches Rust only through the
// /app/ routes above, which open native dialogs and act only on paths the user picked in
// them (or bundles the home screen listed). Navigation away from the app origin is refused.
//
// Importing (File > Import Session…): the native folder picker, then the Python analysis
// CLI (`orchspec bundle`, found by orchspec-core::session_import::find_cli) runs as a
// subprocess — argument list, no shell, no console window — into the app's data folder;
// its output lines become the import status the viewer's import screen polls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchspec_core::app::{BuildSpec, assemble_session, list_bundles, load_recents, push_recent};
use orchspec_core::serve::{Reply, route};
use orchspec_core::session_import::{ImportState, ImportStatus, find_cli, looks_like_session};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, RwLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const SCHEME: &str = "orchspec";

/// The opened bundle (canonical path), if any.
struct OpenBundle(RwLock<Option<PathBuf>>);

/// The current (or last) session import.
struct Import(Mutex<ImportStatus>);

/// The running analysis subprocess, killed when the app exits.
struct Running(Mutex<Option<Child>>);

/// Files and folders the user picked in the wizard's dialogs: the only paths a build uses.
struct Picked(Mutex<HashSet<PathBuf>>);

/// Documents/orchspec: visible to the user, and not under AppData (the Microsoft Store
/// build of Python redirects its AppData writes into a private package folder).
fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|d| d.join("orchspec"))
        .map_err(|e| format!("no documents folder: {e}"))
}

fn recents_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recent.json"))
}

/// App origin: WebView2 exposes custom schemes as http://<scheme>.localhost.
fn app_url(query: &str) -> Url {
    let base = if cfg!(windows) { "http://orchspec.localhost/" } else { "orchspec://localhost/" };
    Url::parse(&format!("{base}{query}")).expect("static URL")
}

fn is_app_origin(u: &Url) -> bool {
    if cfg!(windows) {
        u.scheme() == "http" && u.host_str() == Some("orchspec.localhost")
    } else {
        u.scheme() == SCHEME
    }
}

fn to_response(r: Reply) -> tauri::http::Response<Vec<u8>> {
    let mut b = tauri::http::Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    b.body(r.body).unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// Validates `dir` as a bundle and makes it the open one.
fn open_bundle(app: &AppHandle, dir: PathBuf) -> Result<(), String> {
    let root = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    orchspec_core::open_bundle(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    *app.state::<OpenBundle>().0.write().unwrap() = Some(root.clone());
    if let Some(f) = recents_file(app) {
        let _ = push_recent(&f, &root);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(app_url("?bundle=bundle/"));
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let _ = w.set_title(&format!("orchspec — {name}"));
    }
    Ok(())
}

fn pick_bundle(app: &AppHandle) {
    let handle = app.clone();
    app.dialog().file().set_title("Open an orchspec bundle folder").pick_folder(move |picked| {
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return };
        if let Err(e) = open_bundle(&handle, path) {
            handle
                .dialog()
                .message(e)
                .title("Not an orchspec bundle")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}

fn error_box(app: &AppHandle, title: &str, msg: String) {
    app.dialog().message(msg).title(title).kind(MessageDialogKind::Error).show(|_| {});
}

fn import_session(app: &AppHandle) {
    if app.state::<Import>().0.lock().unwrap().state == ImportState::Running {
        return error_box(app, "Import in progress", "Wait for the current import to finish.".into());
    }
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Import a session folder (mix.wav, stems/, score.musicxml, render.mid)")
        .pick_folder(move |picked| {
            if let Some(dir) = picked.and_then(|p| p.into_path().ok()) {
                start_import(&handle, dir);
            }
        });
}

/// Imports the session folder `dir` into the app's bundles folder, then opens it.
fn start_import(handle: &AppHandle, dir: PathBuf) {
    if handle.state::<Import>().0.lock().unwrap().state == ImportState::Running {
        return error_box(handle, "Import in progress", "Wait for the current import to finish.".into());
    }
    if !looks_like_session(&dir) {
        return error_box(
            handle,
            "Not a session folder",
            format!("{} has no mix.wav and no stems/ (see docs/dorico-session.md).", dir.display()),
        );
    }
    let out = match data_dir(handle) {
        Ok(d) => d.join("bundles"),
        Err(e) => return error_box(handle, "Import failed", e),
    };
    if let Err(e) = std::fs::create_dir_all(&out) {
        return error_box(handle, "Import failed", format!("{}: {e}", out.display()));
    }
    *handle.state::<Import>().0.lock().unwrap() = ImportStatus::start(&dir);
    if let Some(w) = handle.get_webview_window("main") {
        let _ = w.navigate(app_url("?import=1"));
    }
    let h = handle.clone();
    std::thread::spawn(move || run_import(&h, &dir, &out));
}

fn pump_lines<R: Read>(app: &AppHandle, r: R) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    while matches!(reader.read_until(b'\n', &mut buf), Ok(n) if n > 0) {
        app.state::<Import>().0.lock().unwrap().line(&String::from_utf8_lossy(&buf));
        buf.clear();
    }
}

fn run_import(app: &AppHandle, session: &Path, out: &Path) {
    let exe_dir =
        std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let resources = app.path().resource_dir().ok();
    let cli = find_cli(&exe_dir, std::env::var("ORCHSPEC_CLI").ok().as_deref(), resources.as_deref());
    let mut cmd = Command::new(&cli.program);
    if cli.bundled {
        // isolated from any Python the user has installed; numba's JIT cache goes to a
        // writable folder (the install folder is read-only)
        cmd.env("PYTHONNOUSERSITE", "1").env_remove("PYTHONPATH").env_remove("PYTHONHOME");
        if let Ok(cache) = app.path().app_cache_dir() {
            cmd.env("NUMBA_CACHE_DIR", cache.join("numba"));
        }
    }
    cmd.args(&cli.args)
        .arg("bundle")
        .arg(session)
        .arg("-o")
        .arg(out)
        .args(["--backend", "auto", "--overwrite"])
        .env("PYTHONUNBUFFERED", "1") // progress lines as they happen
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let state = app.state::<Import>();
            let mut st = state.0.lock().unwrap();
            st.line(&format!(
                "error: could not start the analysis ({}): {e}. Set ORCHSPEC_CLI to the orchspec executable.",
                cli.program.display()
            ));
            st.finish(false);
            return;
        }
    };
    let mut child = child;
    let err = child.stderr.take();
    let out_pipe = child.stdout.take();
    // kept in state so the app can stop it on exit (the lock is not held while reading)
    *app.state::<Running>().0.lock().unwrap() = Some(child);
    let h = app.clone();
    let t = std::thread::spawn(move || {
        if let Some(e) = err {
            pump_lines(&h, e);
        }
    });
    if let Some(o) = out_pipe {
        pump_lines(app, o);
    }
    let _ = t.join();
    let ok = app
        .state::<Running>()
        .0
        .lock()
        .unwrap()
        .take()
        .and_then(|mut c| c.wait().ok())
        .is_some_and(|s| s.success());
    let bundle = {
        let state = app.state::<Import>();
        let mut st = state.0.lock().unwrap();
        st.finish(ok);
        if st.state == ImportState::Done { st.bundle.clone() } else { None }
    };
    if let Some(b) = bundle
        && let Err(e) = open_bundle(app, PathBuf::from(b))
    {
        let state = app.state::<Import>();
        let mut st = state.0.lock().unwrap();
        st.state = ImportState::Error;
        st.error = Some(e);
    }
}

fn reply_json(v: Value) -> Reply {
    Reply::json(serde_json::to_vec(&v).unwrap_or_default())
}

fn not_ok(e: impl std::fmt::Display) -> Reply {
    reply_json(json!({ "ok": false, "error": e.to_string() }))
}

/// A blocking native dialog for one kind of wizard input (called off the main thread).
fn pick(app: &AppHandle, kind: &str) -> Vec<PathBuf> {
    use orchspec_core::app::{AUDIO_EXT, MIDI_EXT, MUSICXML_EXT, PDF_EXT};
    let d = app.dialog().file();
    let d = match app.get_webview_window("main") {
        Some(w) => d.set_parent(&w),
        None => d,
    };
    let one =
        |p: Option<tauri_plugin_dialog::FilePath>| p.and_then(|p| p.into_path().ok()).into_iter().collect();
    match kind {
        "mix" => one(d.set_title("Choose the mix").add_filter("Audio", AUDIO_EXT).blocking_pick_file()),
        "stems" => d
            .set_title("Choose the stems (one audio file per player)")
            .add_filter("Audio", AUDIO_EXT)
            .blocking_pick_files()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| p.into_path().ok())
            .collect(),
        "musicxml" => one(d
            .set_title("Choose the MusicXML score")
            .add_filter("MusicXML", MUSICXML_EXT)
            .blocking_pick_file()),
        "midi" => {
            one(d.set_title("Choose the MIDI (tempo map)").add_filter("MIDI", MIDI_EXT).blocking_pick_file())
        }
        "pdf" => one(d.set_title("Choose the score PDF").add_filter("PDF", PDF_EXT).blocking_pick_file()),
        _ => vec![],
    }
}

/// The home screen and wizard routes; None for anything else.
fn app_route(app: &AppHandle, method: &str, path: &str, body: &[u8]) -> Option<Reply> {
    let arg = |k: &str| -> Option<String> {
        serde_json::from_slice::<Value>(body).ok()?.get(k)?.as_str().map(str::to_string)
    };
    let bundles_dir = data_dir(app).map(|d| d.join("bundles"));
    let recents = recents_file(app).map(|f| load_recents(&f)).unwrap_or_default();
    Some(match (method, path) {
        ("GET", "/app/home.json") => {
            let list = bundles_dir.as_ref().map(|d| list_bundles(d, &recents)).unwrap_or_default();
            let state = app.state::<Import>().0.lock().unwrap().state.clone();
            reply_json(json!({
                "bundles": list,
                "bundles_dir": bundles_dir.as_ref().map(|d| d.display().to_string()).ok(),
                "importing": state == ImportState::Running,
            }))
        }
        ("POST", "/app/open") => {
            let chosen = match arg("path") {
                // only a bundle the home screen listed
                Some(p) => {
                    let listed = bundles_dir.as_ref().map(|d| list_bundles(d, &recents)).unwrap_or_default();
                    if !listed.iter().any(|e| e.path == p) {
                        return Some(not_ok("not a listed bundle"));
                    }
                    Some(PathBuf::from(p))
                }
                None => {
                    let d = app.dialog().file().set_title("Open an orchspec bundle folder");
                    let d = match app.get_webview_window("main") {
                        Some(w) => d.set_parent(&w),
                        None => d,
                    };
                    d.blocking_pick_folder().and_then(|p| p.into_path().ok())
                }
            };
            match chosen {
                None => reply_json(json!({ "ok": false, "cancelled": true })),
                Some(dir) => match open_bundle(app, dir) {
                    Ok(()) => reply_json(json!({ "ok": true })),
                    Err(e) => not_ok(e),
                },
            }
        }
        ("POST", "/app/pick") => {
            let paths = pick(app, arg("kind").as_deref().unwrap_or(""));
            app.state::<Picked>().0.lock().unwrap().extend(paths.iter().cloned());
            reply_json(json!({ "paths": paths }))
        }
        ("POST", "/app/build") => {
            let spec: BuildSpec = match serde_json::from_slice(body) {
                Ok(s) => s,
                Err(e) => return Some(not_ok(format!("bad request: {e}"))),
            };
            {
                let state = app.state::<Picked>();
                let picked = state.0.lock().unwrap();
                if let Some(p) = spec.files().into_iter().find(|p| !picked.contains(*p)) {
                    return Some(not_ok(format!("{}: not chosen in this session", p.display())));
                }
            }
            if app.state::<Import>().0.lock().unwrap().state == ImportState::Running {
                return Some(not_ok("an import is already running"));
            }
            let sessions = match data_dir(app) {
                Ok(d) => d.join("sessions"),
                Err(e) => return Some(not_ok(e)),
            };
            match assemble_session(&spec, &sessions) {
                Ok(dir) => {
                    start_import(app, dir);
                    reply_json(json!({ "ok": true }))
                }
                Err(e) => not_ok(e),
            }
        }
        ("POST", "/app/import") => {
            import_session(app);
            reply_json(json!({ "ok": true }))
        }
        (_, p) if p.starts_with("/app/") && p != "/app/import.json" => Reply::text(404, "not found"),
        _ => return None,
    })
}

fn go_home(app: &AppHandle, query: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(app_url(query));
        let _ = w.set_title("orchspec");
    }
}

fn main() {
    // `orchspec-desktop <bundle>` opens a bundle; `orchspec-desktop --import <session>`
    // imports a session folder
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let cli_import =
        (args.first().is_some_and(|a| a == "--import")).then(|| args.get(1).map(PathBuf::from)).flatten();
    let cli_bundle = if cli_import.is_some() { None } else { args.first().map(PathBuf::from) };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenBundle(RwLock::new(None)))
        .manage(Import(Mutex::new(ImportStatus::default())))
        .manage(Running(Mutex::new(None)))
        .manage(Picked(Mutex::new(HashSet::new())))
        .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // file reads (tiles, audio ranges) off the webview's thread
            std::thread::spawn(move || {
                let root = app.state::<OpenBundle>().0.read().unwrap().clone();
                let assets = app.asset_resolver();
                let viewer = |rel: &str| assets.get(rel.to_string()).map(|a| a.bytes().to_vec());
                let range = request.headers().get("range").and_then(|v| v.to_str().ok());
                let (method, path) = (request.method().as_str(), request.uri().path());
                let reply = if path == "/app/import.json" {
                    Reply::json(app.state::<Import>().0.lock().unwrap().to_json())
                } else if let Some(r) = app_route(&app, method, path, request.body()) {
                    r
                } else {
                    route(method, path, range, root.as_deref(), &viewer)
                };
                responder.respond(to_response(reply));
            });
        })
        .menu(|app| {
            let home = MenuItem::with_id(app, "home", "Home", true, Some("CmdOrCtrl+H"))?;
            let new = MenuItem::with_id(app, "new", "New Bundle from Files…", true, Some("CmdOrCtrl+N"))?;
            let open = MenuItem::with_id(app, "open", "Open Bundle…", true, Some("CmdOrCtrl+O"))?;
            let import =
                MenuItem::with_id(app, "import", "Import Session Folder…", true, Some("CmdOrCtrl+I"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let file = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &home,
                    &new,
                    &open,
                    &import,
                    &reload,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let fullscreen = MenuItem::with_id(app, "fullscreen", "Full Screen", true, Some("F11"))?;
            let view = Submenu::with_items(app, "View", true, &[&fullscreen])?;
            Menu::with_items(app, &[&file, &view])
        })
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "home" => go_home(app, "?home=1"),
            "new" => go_home(app, "?home=1&wizard=1"),
            "open" => pick_bundle(app),
            "import" => import_session(app),
            "reload" => {
                let open = app.state::<OpenBundle>().0.read().unwrap().is_some();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.navigate(app_url(if open { "?bundle=bundle/" } else { "?home=1" }));
                }
            }
            "fullscreen" => {
                if let Some(w) = app.get_webview_window("main") {
                    let on = w.is_fullscreen().unwrap_or(false);
                    let _ = w.set_fullscreen(!on);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            // no bundle given: the home screen (open, recent bundles, or build one)
            let start =
                if cli_bundle.is_some() || cli_import.is_some() { "?bundle=bundle/" } else { "?home=1" };
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url(start)))
                .title("orchspec")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                // no OS file drag-and-drop (unused): tao's RegisterDragDrop panics when
                // the exe sits under a very long path (a portable build unpacked deep)
                .disable_drag_drop_handler()
                .on_navigation(is_app_origin);
            #[cfg(windows)]
            let builder = builder.drag_and_drop(false);
            builder.build()?;
            let handle = app.handle().clone();
            if let Some(dir) = cli_import.clone() {
                start_import(&handle, dir);
                return Ok(());
            }
            if let Some(dir) = cli_bundle.clone()
                && let Err(e) = open_bundle(&handle, dir)
            {
                go_home(&handle, "?home=1");
                handle
                    .dialog()
                    .message(e)
                    .title("Not an orchspec bundle")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building orchspec")
        .run(|app, event| {
            // an import still running when the app closes is stopped, not left behind
            if let RunEvent::Exit = event
                && let Some(mut c) = app.state::<Running>().0.lock().unwrap().take()
            {
                let _ = c.kill();
                let _ = c.wait();
            }
        });
}
