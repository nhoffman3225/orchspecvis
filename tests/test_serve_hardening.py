from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from orchspec.server import TOKEN_HEADER, bind_socket, create_app, safe_join
from tests.fixtures.make_tiny_bundle import build

TOKEN = "t0k3n-for-tests"


@pytest.fixture
def env(tmp_path: Path) -> tuple[TestClient, Path]:
    root = tmp_path / "b.bundle"
    build(root)
    (tmp_path / "secret.txt").write_text("outside the bundle")
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>orchspec</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    client = TestClient(create_app(root, TOKEN, dist), base_url="http://127.0.0.1")
    return client, tmp_path


def _auth() -> dict[str, str]:
    return {TOKEN_HEADER: TOKEN}


def test_requires_token(env) -> None:  # type: ignore[no-untyped-def]
    c, _ = env
    assert c.get("/bundle/manifest.json").status_code == 403
    assert c.get("/bundle/manifest.json", headers={TOKEN_HEADER: "wrong"}).status_code == 403
    assert c.get("/assets/app.js").status_code == 403
    assert c.get("/bundle/manifest.json", headers=_auth()).status_code == 200


def test_query_token_sets_cookie(env) -> None:  # type: ignore[no-untyped-def]
    c, _ = env
    r = c.get(f"/?token={TOKEN}&bundle=bundle/")
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert c.get("/assets/app.js").status_code == 200  # cookie now carried


def test_bad_host_rejected(env) -> None:  # type: ignore[no-untyped-def]
    c, _ = env
    r = c.get("/bundle/manifest.json", headers={**_auth(), "Host": "evil.example"})
    assert r.status_code == 400


@pytest.mark.parametrize(
    "path",
    [
        "/bundle/../secret.txt",
        "/bundle/%2e%2e/secret.txt",
        "/bundle/..%2fsecret.txt",
        "/bundle/..%5csecret.txt",
        "/bundle/tiles/../../secret.txt",
        "/bundle/C:%5cWindows%5cwin.ini",
        "/bundle/%2fetc%2fpasswd",
        "/../secret.txt",
        "/%2e%2e/secret.txt",
    ],
)
def test_path_traversal_404(env, path: str) -> None:  # type: ignore[no-untyped-def]
    c, _ = env
    r = c.get(path, headers=_auth())
    assert r.status_code == 404, (path, r.status_code, r.text[:80])
    assert "outside the bundle" not in r.text


def test_read_only_and_headers(env) -> None:  # type: ignore[no-untyped-def]
    c, _ = env
    assert c.post("/bundle/manifest.json", headers=_auth()).status_code == 405
    assert c.put("/bundle/x", headers=_auth(), content=b"x").status_code == 405
    r = c.get("/bundle/manifest.json", headers={**_auth(), "Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"


def test_safe_join_unit(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "f.txt").write_text("x")
    root = tmp_path.resolve()
    assert safe_join(root, "a/f.txt") == root / "a" / "f.txt"
    for bad in [
        "../x",
        "a/../../x",
        "/etc/passwd",
        "a\\f.txt",
        "C:/x",
        "a/.hidden",
        "a",
        "missing",
    ]:
        assert safe_join(root, bad) is None, bad


def test_bound_to_localhost() -> None:
    s = bind_socket()
    try:
        host, port = s.getsockname()
        assert host == "127.0.0.1" and port > 0
    finally:
        s.close()


def test_cli_serve_missing_bundle_is_a_clear_error(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from orchspec.cli import app

    r = CliRunner().invoke(app, ["serve", str(tmp_path / "nope.bundle")])
    assert r.exit_code == 2
    assert "not a bundle directory" in r.output and "current directory" in r.output
    assert "Traceback" not in r.output
