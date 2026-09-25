// orchspec desktop (Phase 3b): the viewer build + one local bundle in the system webview.
//
// Everything is served by ONE custom protocol, so the viewer and the bundle share an
// origin (the viewer's same-origin fetch guard and CSP `connect-src 'self'` stay as in
// `orchspec serve`):
//   /bundle/<rel>        -> files of the opened bundle folder (read-only, confined, ranges)
//   /app/import.json     -> progress of a session import (read-only JSON)
//   /<anything>          -> the viewer build, embedded at compile time (frontendDist)
// Serving rules live in orchspec-core::serve (tested there). No updater, no telemetry,
// no IPC permissions (no capabilities file): the page cannot call into Rust. Navigation
// away from the app origin is refused.
//
// Importing (File > Import Session…): the native folder picker, then the Python analysis
// CLI (`orchspec bundle`, found by orchspec-core::session_import::find_cli) runs as a
// subprocess — argument list, no shell, no console window — into the app's data folder;
// its output lines become the import status the viewer's import screen polls.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchspec_core::serve::{Reply, route};
use orchspec_core::session_import::{ImportState, ImportStatus, find_cli, looks_like_session};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, RwLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const SCHEME: &str = "orchspec";

/// The opened bundle (canonical path), if any.
struct OpenBundle(RwLock<Option<PathBuf>>);

/// The current (or last) session import.
struct Import(Mutex<ImportStatus>);

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
            format!("{} has no mix.wav (see docs/dorico-session.md).", dir.display()),
        );
    }
    // Documents/orchspec/bundles: visible to the user, and not under AppData — the
    // Microsoft Store build of Python redirects its AppData writes into a private package
    // folder the app cannot see
    let out = match handle.path().document_dir().or_else(|_| handle.path().app_data_dir()) {
        Ok(d) => d.join("orchspec").join("bundles"),
        Err(e) => return error_box(handle, "Import failed", format!("no documents folder: {e}")),
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
    let mut child = match cmd.spawn() {
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
    let err = child.stderr.take();
    let h = app.clone();
    let t = std::thread::spawn(move || {
        if let Some(e) = err {
            pump_lines(&h, e);
        }
    });
    if let Some(o) = child.stdout.take() {
        pump_lines(app, o);
    }
    let _ = t.join();
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
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
        .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // file reads (tiles, audio ranges) off the webview's thread
            std::thread::spawn(move || {
                let root = app.state::<OpenBundle>().0.read().unwrap().clone();
                let assets = app.asset_resolver();
                let viewer = |rel: &str| assets.get(rel.to_string()).map(|a| a.bytes().to_vec());
                let range = request.headers().get("range").and_then(|v| v.to_str().ok());
                let reply = if request.uri().path() == "/app/import.json" {
                    Reply::json(app.state::<Import>().0.lock().unwrap().to_json())
                } else {
                    route(request.method().as_str(), request.uri().path(), range, root.as_deref(), &viewer)
                };
                responder.respond(to_response(reply));
            });
        })
        .menu(|app| {
            let open = MenuItem::with_id(app, "open", "Open Bundle…", true, Some("CmdOrCtrl+O"))?;
            let import = MenuItem::with_id(app, "import", "Import Session…", true, Some("CmdOrCtrl+I"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let file = Submenu::with_items(
                app,
                "File",
                true,
                &[
                    &open,
                    &import,
                    &reload,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            Menu::with_items(app, &[&file])
        })
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => pick_bundle(app),
            "import" => import_session(app),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.navigate(app_url("?bundle=bundle/"));
                }
            }
            _ => {}
        })
        .setup(move |app| {
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url("?bundle=bundle/")))
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
            match cli_bundle.clone() {
                Some(dir) => {
                    if let Err(e) = open_bundle(&handle, dir) {
                        handle
                            .dialog()
                            .message(e)
                            .title("Not an orchspec bundle")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                }
                None => pick_bundle(&handle),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running orchspec");
}
