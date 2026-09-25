// orchspec desktop (Phase 3b): the viewer build + one local bundle in the system webview.
//
// Everything is served by ONE custom protocol, so the viewer and the bundle share an
// origin (the viewer's same-origin fetch guard and CSP `connect-src 'self'` stay as in
// `orchspec serve`):
//   /bundle/<rel>  -> files of the opened bundle folder (read-only, confined, byte ranges)
//   /<anything>    -> the viewer build, embedded at compile time (frontendDist)
// Serving rules live in orchspec-core::serve (tested there). No updater, no telemetry,
// no IPC permissions (no capabilities file): the page cannot call into Rust. Navigation
// away from the app origin is refused.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use orchspec_core::serve::{Reply, route};
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

const SCHEME: &str = "orchspec";

/// The opened bundle (canonical path), if any.
struct OpenBundle(RwLock<Option<PathBuf>>);

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
            handle.dialog().message(e).title("Not an orchspec bundle").kind(MessageDialogKind::Error).show(|_| {});
        }
    });
}

fn main() {
    let cli_bundle = std::env::args_os().nth(1).map(PathBuf::from);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OpenBundle(RwLock::new(None)))
        .register_asynchronous_uri_scheme_protocol(SCHEME, |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            // file reads (tiles, audio ranges) off the webview's thread
            std::thread::spawn(move || {
                let root = app.state::<OpenBundle>().0.read().unwrap().clone();
                let assets = app.asset_resolver();
                let viewer = |rel: &str| assets.get(rel.to_string()).map(|a| a.bytes().to_vec());
                let range = request.headers().get("range").and_then(|v| v.to_str().ok());
                let reply = route(request.method().as_str(), request.uri().path(), range, root.as_deref(), &viewer);
                responder.respond(to_response(reply));
            });
        })
        .menu(|app| {
            let open = MenuItem::with_id(app, "open", "Open Bundle…", true, Some("CmdOrCtrl+O"))?;
            let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
            let file = Submenu::with_items(app, "File", true, &[
                &open,
                &reload,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;
            Menu::with_items(app, &[&file])
        })
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => pick_bundle(app),
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.navigate(app_url("?bundle=bundle/"));
                }
            }
            _ => {}
        })
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(app_url("?bundle=bundle/")))
                .title("orchspec")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .on_navigation(|u| is_app_origin(u))
                .build()?;
            let handle = app.handle().clone();
            match cli_bundle.clone() {
                Some(dir) => {
                    if let Err(e) = open_bundle(&handle, dir) {
                        handle.dialog().message(e).title("Not an orchspec bundle").kind(MessageDialogKind::Error).show(|_| {});
                    }
                }
                None => pick_bundle(&handle),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running orchspec");
}
