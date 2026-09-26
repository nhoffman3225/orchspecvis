"""Score PDF rendering and bar detection (score/pdf.py) on a hand-written PDF."""

from pathlib import Path

import numpy as np

from orchspec.score.pdf import (
    MAX_DOC_PIXELS,
    MAX_PAGE_PIXELS,
    MAX_PAGES,
    doc_scale,
    find_staves,
    page_scale,
    render_pdf,
    write_png_gray,
)
from tests.fixtures.make_pdf import make_pdf


def test_bars_numbers_and_decoys(tmp_path: Path) -> None:
    pdf = make_pdf(tmp_path / "score.pdf")
    score = render_pdf(pdf, tmp_path / "b", dpi=150)
    assert len(score.pages) == 1
    page = score.pages[0]
    assert abs(page.width - 612 * 150 / 72) <= 1 and abs(page.height - 400 * 150 / 72) <= 1
    assert (tmp_path / "b" / page.path).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    # 1 2 3 on system 1; the printed "5" restarts system 2; "12" (centred) and the stem
    # are ignored
    assert [b.number for b in score.bars] == ["1", "2", "3", "5", "6", "7"]
    s = 150 / 72
    b1, b2 = score.bars[0], score.bars[1]
    assert abs(b1.x0 - 50 * s) <= 3 and abs(b1.x1 - 230 * s) <= 3
    assert abs(b2.x1 - 400 * s) <= 3
    assert b1.y0 < 60 * s and b1.y1 > 134 * s  # covers both staves
    sys2 = score.bars[3]
    assert sys2.y0 > b1.y1  # second system below the first


def test_staff_detection_ignores_other_rows() -> None:
    ink = np.zeros((200, 300), bool)
    for y in (20, 28, 36, 44, 52):  # a staff, spacing 8
        ink[y, 10:290] = True
    ink[100, 10:290] = True  # a lone long line (e.g. a hairpin): not a staff
    staves = find_staves(ink)
    assert staves == [(20, 52, 8.0)]


def test_png_writer_roundtrip(tmp_path: Path) -> None:
    img = (np.arange(64 * 32) % 256).astype(np.uint8).reshape(32, 64)
    p = tmp_path / "x.png"
    write_png_gray(p, img)
    import zlib

    data = p.read_bytes()
    idat = data[data.index(b"IDAT") + 4 : data.index(b"IEND") - 8]
    raw = zlib.decompress(idat)
    rows = np.frombuffer(raw, np.uint8).reshape(32, 65)
    assert (rows[:, 0] == 0).all()
    assert np.array_equal(rows[:, 1:], img)


def test_page_scale_caps_huge_pages() -> None:
    """A PDF can declare any page size: rendering stays within MAX_PAGE_PIXELS."""
    assert page_scale(612, 792, 150) == 150 / 72  # a normal page keeps its dpi
    s = page_scale(14400, 14400, 150)  # PDF's maximum page size, 200 in square
    assert (14400 * s) ** 2 <= MAX_PAGE_PIXELS * 1.0001


def test_doc_scale_caps_the_whole_document() -> None:
    """MAX_PAGES pages each at the per-page cap would be ~16 GP: all pages shrink together."""
    assert doc_scale([(612, 792)] * 300, 150) == 1.0  # a real score keeps its dpi
    huge = [(14400.0, 14400.0)] * MAX_PAGES
    k = doc_scale(huge, 150)
    total = sum((w * page_scale(w, h, 150) * k) * (h * page_scale(w, h, 150) * k) for w, h in huge)
    assert k < 1 and total <= MAX_DOC_PIXELS * 1.0001
