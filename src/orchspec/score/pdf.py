"""Score PDF (e.g. Dorico's condensed full score) as page images plus bar boxes.

A MusicXML export has no condensing, so a PDF of the engraved layout is the way to see
it. Each page is rendered once (PDFium via pypdfium2) to a grayscale PNG stored in the
bundle; bars are found on the image so the viewer can follow playback in the PDF:

- staff lines: pixel rows that are mostly ink; five evenly spaced lines make a staff
- systems: staves joined by barlines — a barline is a pixel column inked through the
  full height of (nearly) every staff of the system; stems and notes never span several
  staves, so they are not mistaken for barlines
- bars: the intervals between consecutive barlines of a system
- bar numbers: the PDF's text layer (Dorico prints bar numbers as text); a number counts
  when it sits just after a barline above the system's top staff, so multi-bar-rest
  counts (centred in the bar) are ignored. Unnumbered bars continue from the previous one.

The PDF is untrusted input: size and page count are limited and only a local path is
accepted (no URLs). PDFium is the engine Chrome uses for PDFs.
"""

from __future__ import annotations

import itertools
import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

MAX_BYTES = 200 * 1024 * 1024
Token = tuple[str, float, float, float, float]  # text, x0, y0, x1, y1 (image pixels)
BarBox = tuple[int, int, int, int, str | None]  # x0, y0, x1, y1, printed number
MAX_PAGES = 400


class PdfScoreError(ValueError):
    pass


@dataclass
class PdfBar:
    page: int  # 0-based
    number: str
    x0: int
    y0: int
    x1: int
    y1: int


@dataclass
class PdfPage:
    path: str  # bundle-relative PNG
    width: int
    height: int


@dataclass
class PdfScore:
    dpi: int
    pages: list[PdfPage] = field(default_factory=list)
    bars: list[PdfBar] = field(default_factory=list)


def write_png_gray(path: Path, img: np.ndarray) -> None:
    """8-bit grayscale PNG (no third-party encoder needed)."""
    h, w = img.shape
    raw = b"".join(b"\x00" + img[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) runs of True."""
    m = np.concatenate([[False], mask, [False]]).astype(np.int8)
    d = np.diff(m)
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist(), strict=True))


def find_staves(ink: np.ndarray, min_fill: float = 0.35) -> list[tuple[int, int, float]]:
    """Staves as (top line y, bottom line y, line spacing) from a boolean ink image."""
    rows = ink.mean(axis=1) >= min_fill
    lines = [(a + b - 1) / 2 for a, b in _runs(rows)]
    staves: list[tuple[int, int, float]] = []
    i = 0
    while i + 4 < len(lines):
        five = lines[i : i + 5]
        gaps = np.diff(five)
        g = float(np.median(gaps))
        if g >= 3 and np.all(np.abs(gaps - g) <= max(1.0, 0.25 * g)):
            staves.append((round(five[0]), round(five[4]), g))
            i += 5
        else:
            i += 1
    return staves


def find_systems(
    ink: np.ndarray, staves: list[tuple[int, int, float]]
) -> list[tuple[list[int], list[int]]]:
    """Systems as (staff indices, barline x positions): consecutive staves that share
    barline columns form a system; barline columns are inked through ~every staff."""
    if not staves:
        return []
    cols_through = []  # per staff: columns inked over the staff's full height
    for top, bottom, _g in staves:
        band = ink[top : bottom + 1]
        cols_through.append(band.mean(axis=0) >= 0.97)
    systems: list[tuple[list[int], list[int]]] = []
    cur = [0]
    for s in range(1, len(staves)):
        # joined if some column is inked from the previous staff's bottom to this top
        prev_bottom, top = staves[s - 1][1], staves[s][0]
        between = ink[prev_bottom : top + 1]
        both = cols_through[s - 1] & cols_through[s]
        joined = bool(np.any(both & (between.mean(axis=0) >= 0.97))) if top > prev_bottom else False
        if joined:
            cur.append(s)
        else:
            systems.append((cur, []))
            cur = [s]
    systems.append((cur, []))
    out = []
    for idx, _ in systems:
        g = float(np.median([staves[i][2] for i in idx]))
        need = max(1, int(np.ceil(0.9 * len(idx))))
        count = np.sum([cols_through[i] for i in idx], axis=0)
        cand = count >= need
        xs = []
        for a, b in _runs(cand):
            x = (a + b - 1) // 2
            if xs and x - xs[-1] <= 0.8 * g:  # thick/thin double barlines -> one
                xs[-1] = x
            else:
                xs.append(x)
        out.append((idx, xs))
    return out


_NUM = re.compile(r"\d+")


def _number_tokens(
    page, scale: float, height_px: int
) -> list[tuple[str, float, float, float, float]]:
    """Numeric text runs on the page as (text, x0, y0, x1, y1) in image pixels."""
    tp = page.get_textpage()
    try:
        n = tp.count_chars()
        out = []
        cur: list[tuple[str, tuple[float, float, float, float]]] = []

        def flush() -> None:
            if cur:
                txt = "".join(c for c, _ in cur)
                x0 = min(b[0] for _, b in cur)
                x1 = max(b[2] for _, b in cur)
                y0 = min(b[1] for _, b in cur)
                y1 = max(b[3] for _, b in cur)
                # PDF y grows upwards; image y downwards
                out.append(
                    (txt, x0 * scale, height_px - y1 * scale, x1 * scale, height_px - y0 * scale)
                )
                cur.clear()

        for i in range(n):
            ch = tp.get_text_range(i, 1)
            if ch.isdigit():
                left, bottom, right, top = tp.get_charbox(i)
                if cur and abs(cur[-1][1][1] - bottom) > 2:  # new line
                    flush()
                cur.append((ch, (left, bottom, right, top)))
            else:
                flush()
        flush()
        return [t for t in out if _NUM.fullmatch(t[0])]
    finally:
        tp.close()


def analyse_page(
    ink: np.ndarray, tokens: list[tuple[str, float, float, float, float]]
) -> list[tuple[int, int, int, int, str | None]]:
    """Bars on one page as (x0, y0, x1, y1, printed number or None), system by system."""
    staves = find_staves(ink)
    bars: list[BarBox] = []
    for idx, xs in find_systems(ink, staves):
        if len(xs) < 2:
            continue
        top = staves[idx[0]][0]
        bottom = staves[idx[-1]][1]
        g = float(np.median([staves[i][2] for i in idx]))
        for a, b in itertools.pairwise(xs):
            num = None
            for txt, tx0, _ty0, _tx1, ty1 in tokens:
                # just right of the barline, above (or at) the top staff
                if a - 0.5 * g <= tx0 <= a + 3.5 * g and top - 5 * g <= ty1 <= top + 0.5 * g:
                    num = txt
                    break
            bars.append((a, top - round(2 * g), b, bottom + round(2 * g), num))
    return bars


def render_pdf(pdf_path: Path, root: Path, rel_dir: str = "score/pdf", dpi: int = 150) -> PdfScore:
    """Render every page to root/rel_dir/page-NNN.png and find the bars."""
    import pypdfium2 as pdfium

    size = pdf_path.stat().st_size
    if size > MAX_BYTES:
        raise PdfScoreError(f"{pdf_path.name}: {size / 1e6:.0f} MB is larger than the limit")
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        if len(doc) > MAX_PAGES:
            raise PdfScoreError(f"{pdf_path.name}: {len(doc)} pages is more than {MAX_PAGES}")
        out = root / rel_dir
        out.mkdir(parents=True, exist_ok=True)
        score = PdfScore(dpi=dpi)
        scale = dpi / 72
        last = 0
        for pi in range(len(doc)):
            page = doc[pi]
            try:
                # the stub says int; PDFium takes any positive scale
                bmp = page.render(scale=scale, grayscale=True)  # pyright: ignore[reportArgumentType]
                img = np.asarray(bmp.to_numpy())
                img = img[:, :, 0] if img.ndim == 3 else img
                img = np.ascontiguousarray(img, dtype=np.uint8)
                rel = f"{rel_dir}/page-{pi + 1:03d}.png"
                write_png_gray(root / rel, img)
                h, w = img.shape
                score.pages.append(PdfPage(path=rel, width=w, height=h))
                tokens = _number_tokens(page, scale, h)
                for x0, y0, x1, y1, num in analyse_page(img < 128, tokens):
                    n = int(num) if num is not None else last + 1
                    last = n
                    score.bars.append(PdfBar(pi, str(n), x0, max(0, y0), x1, min(h, y1)))
            finally:
                page.close()
        return score
    finally:
        doc.close()
