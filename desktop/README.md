# desktop/ (Phase 3b)

Placeholder for the Tauri 2 desktop app (Windows + macOS) that replaces the dev-only
`orchspec serve`. It will host the same `viewer/` build in the system webview
(WebView2 / WKWebView — hence WebGL2, not WebGPU), serve bundle files through a custom
protocol confined to the opened bundle directory, and keep the viewer CSP from
SECURITY.md. No updater, no telemetry, no network permissions.
