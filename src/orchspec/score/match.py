"""Match score parts (or MIDI tracks) to stems by name, falling back to order."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6"}
TRANSP = re.compile(r"\bin\s+[a-g](?:\s*(?:b|#|flat|sharp))?\b")
# key designations in parentheses: "(B Flat)", "(Bb)", "(E♭)" (after ♭ -> b), "(C)"
KEY_PAREN = re.compile(r"\(\s*[a-g](?:\s*(?:flat|sharp|b|#))?\s*\)")


def normalize(name: str) -> str:
    s = unicodedata.normalize("NFKC", name).replace("♭", "b").replace("♯", "#")
    s = s.casefold()
    s = re.sub(r"^\d{1,3}[_\s.-]+", "", s)  # stem number prefix "01_"
    s = TRANSP.sub(" ", s)  # "in bb", "in f"
    s = KEY_PAREN.sub(" ", s)  # "(b flat)", "(eb)", "(c)"
    s = re.sub(r"[^a-z0-9#]+", " ", s)
    words = [ROMAN.get(w, w) for w in s.split()]
    words = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words]  # violins
    return " ".join(words)


@dataclass(frozen=True)
class Match:
    stem_index: int | None
    method: str  # "name" | "fuzzy" | "order" | "none"


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    return len(sa & sb) / len(sa | sb) if sa | sb else 0.0


def match_parts_to_stems(parts: list[str], stems: list[str]) -> list[Match]:
    """Greedy: exact normalized names, then best token overlap >= 0.5, then (only if the
    counts are equal) remaining parts to remaining stems in order."""
    np_, ns = [normalize(p) for p in parts], [normalize(s) for s in stems]
    out: list[Match | None] = [None] * len(parts)
    free = set(range(len(stems)))
    for i, p in enumerate(np_):
        for j in sorted(free):
            if ns[j] == p:
                out[i] = Match(j, "name")
                free.discard(j)
                break
    pairs = sorted(
        (
            (_jaccard(np_[i], ns[j]), i, j)
            for i in range(len(parts))
            if out[i] is None
            for j in free
        ),
        reverse=True,
    )
    for score, i, j in pairs:
        if score < 0.5:
            break
        if out[i] is None and j in free:
            out[i] = Match(j, "fuzzy")
            free.discard(j)
    rest_p = [i for i in range(len(parts)) if out[i] is None]
    if len(parts) == len(stems) and rest_p:
        for i, j in zip(rest_p, sorted(free), strict=True):
            out[i] = Match(j, "order")
    return [m or Match(None, "none") for m in out]
