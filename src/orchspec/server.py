"""`orchspec serve`: minimal, read-only, localhost-only HTTP server (dev mode).

Serves one bundle directory under /bundle/ and the built viewer (viewer/dist) at /.
Hardening (see SECURITY.md): 127.0.0.1 only, random free port, TrustedHost, per-launch
token on every request, no CORS, GET/HEAD only, root confinement.
"""

from __future__ import annotations

import secrets
import socket
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.middleware.trustedhost import TrustedHostMiddleware

from orchspec.bundle.schema import MANIFEST_NAME

LOCALHOST = "127.0.0.1"
TOKEN_HEADER = "X-Orchspec-Token"  # noqa: S105 (header name, not a secret)
TOKEN_COOKIE = "orchspec_token"  # noqa: S105 (cookie name, not a secret)
CSP = (
    "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; "
    "script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; media-src 'self' blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
REPO_VIEWER_DIST = Path(__file__).resolve().parents[2] / "viewer" / "dist"


def safe_join(root: Path, rel: str) -> Path | None:
    """Resolve `rel` under `root`; None if it escapes, is not a file, or is hidden."""
    if "\\" in rel or "\x00" in rel or ":" in rel:
        return None
    parts = [p for p in rel.split("/") if p]
    if any(p in (".", "..") or p.startswith(".") for p in parts):
        return None
    try:
        p = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if not p.is_relative_to(root) or not p.is_file():
        return None
    return p


class _Guard(BaseHTTPMiddleware):
    def __init__(self, app, token: str) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self.token = token

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method not in ("GET", "HEAD"):
            return PlainTextResponse("read-only", status_code=405)
        given = (
            request.headers.get(TOKEN_HEADER)
            or request.query_params.get("token")
            or request.cookies.get(TOKEN_COOKIE)
            or ""
        )
        if not secrets.compare_digest(given.encode(), self.token.encode()):
            return PlainTextResponse("forbidden", status_code=403)
        resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        resp.headers["Cache-Control"] = "no-store"
        if request.query_params.get("token") == self.token:
            resp.set_cookie(TOKEN_COOKIE, self.token, httponly=True, samesite="strict", path="/")
        return resp


def create_app(bundle_root: Path, token: str, viewer_dist: Path | None = None) -> FastAPI:
    root = bundle_root.resolve(strict=True)
    if not (root / MANIFEST_NAME).is_file():
        raise FileNotFoundError(f"{root} is not a bundle (no {MANIFEST_NAME})")
    dist = (viewer_dist or REPO_VIEWER_DIST).resolve()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/bundle/{rel:path}")
    def bundle_file(rel: str) -> Response:
        p = safe_join(root, rel)
        if p is None:
            return PlainTextResponse("not found", status_code=404)
        return FileResponse(p)

    @app.get("/")
    def index(request: Request) -> Response:
        if "bundle" not in request.query_params:
            return RedirectResponse(f"/?token={token}&bundle=bundle/", status_code=307)
        p = safe_join(dist, "index.html") if dist.is_dir() else None
        if p is None:
            return PlainTextResponse(
                "viewer not built: run `npm run build` in viewer/", status_code=404
            )
        return FileResponse(p, media_type="text/html")

    @app.get("/{rel:path}")
    def viewer_file(rel: str) -> Response:
        p = safe_join(dist, rel) if dist.is_dir() else None
        if p is None:
            return PlainTextResponse("not found", status_code=404)
        return FileResponse(p)

    # Order: TrustedHost is outermost (added last), so bad Host -> 400 before token check.
    app.add_middleware(_Guard, token=token)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[LOCALHOST, "localhost"])
    return app


def bind_socket() -> socket.socket:
    """A listening-ready TCP socket on 127.0.0.1 with an OS-chosen free port."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((LOCALHOST, 0))
    s.set_inheritable(True)
    return s


def serve(bundle_root: Path, viewer_dist: Path | None = None) -> None:  # pragma: no cover
    import uvicorn

    token = secrets.token_urlsafe(32)
    app = create_app(bundle_root, token, viewer_dist)
    sock = bind_socket()
    port = sock.getsockname()[1]
    print(f"orchspec serve: http://{LOCALHOST}:{port}/?token={token}&bundle=bundle/", flush=True)
    print("(local only; Ctrl+C to stop)", flush=True)
    config = uvicorn.Config(
        app, log_level="warning", proxy_headers=False, server_header=False, date_header=False
    )
    uvicorn.Server(config).run(sockets=[sock])
