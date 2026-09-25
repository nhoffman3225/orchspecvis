"""A tiny hand-written score PDF for tests/test_pdf_score.py (no PDF library needed).

Page 612 x 400 pt: two systems of two staves (line spacing 6 pt), barlines through
both staves of each system. Printed bar numbers: "1" at the start of system 1 and "5" at
the start of system 2 (bars 4 missing: a jump like after a multi-bar rest). Decoys: a
centred "12" above bar 2 (a multi-rest count, must be ignored) and a stem in bar 1
(must not be taken for a barline).

Expected bars: 1 2 3 (system 1), 5 6 7 (system 2).
"""

from __future__ import annotations

from pathlib import Path

W, H = 612, 400
SYSTEMS = [
    # (top y of each staff (from the top of the page), barline x positions)
    ((60, 110), (50, 230, 400, 570)),
    ((200, 250), (50, 250, 450, 570)),
]
NUMBERS = [("1", 54, 50), ("5", 54, 190)]  # (text, x, baseline y from top)
DECOYS = [("12", 310, 50)]
STEM = (120, 62, 120, 83)  # inside staff 1 of system 1, shorter than the staff


def _content() -> bytes:
    ops = ["1 w"]

    def line(x0: float, y0: float, x1: float, y1: float) -> None:
        ops.append(f"{x0} {H - y0} m {x1} {H - y1} l S")

    for staves, bars in SYSTEMS:
        for top in staves:
            for k in range(5):
                line(bars[0], top + 6 * k, bars[-1], top + 6 * k)
        for x in bars:
            line(x, staves[0], x, staves[-1] + 24)
    line(*STEM)
    for txt, x, y in NUMBERS + DECOYS:
        ops.append(f"BT /F1 9 Tf {x} {H - y} Td ({txt}) Tj ET")
    return "\n".join(ops).encode("ascii")


def make_pdf(path: Path) -> Path:
    content = _content()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] "
        f"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".encode("ascii"),
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))
    return path
