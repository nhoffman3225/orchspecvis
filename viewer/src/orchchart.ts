// Orchestration chart of a selected chord (the tutti view's pop-up): a grand staff where
// each section stands in its own column, in its colour, with instrument labels (picc.,
// clar., trp., ...) placed beside their notes, bracketed when a label covers several
// notes and joined by a leader line when it had to move away from them. Doubled pitches
// are either split (a notehead per part, side by side: no colour is blended) or mixed
// (one notehead per pitch, its colour the sections' colours weighted by how many parts
// of each play it). Layout is pure (tested); render() returns an SVG string.

import type { MapNote } from "./condense";

export interface ChartPart {
  name: string;
  abbreviation?: string;
  family: string;
}

export interface ChartNote {
  midi: number;
  name: string; // spelled pitch, e.g. "B♭3"
  parts: number[]; // score part indices
}

/** Section order left to right (strings and percussion first, as in the usual charts). */
export const CHART_ORDER = ["strings", "percussion", "woodwinds", "brass", "keyboards", "voices", "other"];

const ABBR: [RegExp, string][] = [
  [/piccolo/, "picc."], [/alto flute/, "a. fl."], [/flute/, "fl."],
  [/english horn|cor anglais/, "e.h."], [/oboe/, "ob."],
  [/bass clarinet/, "b. cl."], [/clarinet/, "clar."],
  [/contrabassoon|contrafagott/, "cbn."], [/bassoon/, "bn."],
  [/saxophone/, "sax."], [/horn/, "hrn."], [/trumpet|cornet/, "trp."], [/trombone/, "tbn."],
  [/tuba/, "tba."], [/timpani/, "timp."], [/harp/, "hp."], [/celesta/, "cel."],
  [/piano/, "pno."], [/organ/, "org."],
  [/violin|viola|cello|contrabass|double bass|strings/, "str."],
  [/drum|cymbal|triangle|glock|xylo|marimba|vibra|percussion|tam/, "perc."],
];

/** The short label of a part: "Clarinet (B Flat) 2" -> "clar.", every string -> "str.". */
export function shortName(p: ChartPart): string {
  const n = `${p.name} ${p.abbreviation ?? ""}`.toLowerCase();
  for (const [re, a] of ABBR) if (re.test(n)) return a;
  if (p.family === "strings") return "str.";
  const w = (p.abbreviation || p.name).replace(/[\d().]+/g, " ").trim().split(/\s+/)[0] ?? "?";
  return `${w.toLowerCase().slice(0, 5)}.`;
}

const LETTERS = "CDEFGAB";

/** Diatonic step (octave * 7 + letter) and accidental of a spelled pitch name. */
export function parseName(name: string): { step: number; acc: string } {
  const m = /^([A-G])([♭♯𝄫𝄪b#]*)(-?\d+)$/u.exec(name.trim());
  if (!m) return { step: 28, acc: "" };
  const acc = m[2]!.replace(/b/g, "♭").replace(/#/g, "♯");
  return { step: Number(m[3]) * 7 + LETTERS.indexOf(m[1]!), acc };
}

export interface Head {
  x: number;
  y: number;
  step: number;
  acc: string;
  color: string;
  treble: boolean;
  family: string;
  label: string;
}

export interface Label {
  text: string;
  color: string;
  x: number;
  y: number;
  anchor: "start" | "end";
  bracket: { x: number; y0: number; y1: number } | null;
  leaders: { x0: number; y0: number; x1: number; y1: number }[];
}

export interface Chart {
  width: number;
  height: number;
  heads: Head[];
  labels: Label[];
  ledgers: { x0: number; x1: number; y: number }[];
  staves: { top: number; treble: boolean }[];
  left: number;
  right: number;
}

export const S = 10; // staff space
const HEAD_W = 13;
const TREBLE_TOP = 38; // F5
const BASS_TOP = 26; // A3

/** Colour of a doubled pitch in "mix" mode: the colours averaged in linear light,
 * weighted (e.g. by how many parts of each section play it). */
export function mixColors(colors: string[], weights: number[]): string {
  const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const gam = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  let r = 0, g = 0, b = 0, tot = 0;
  colors.forEach((c, i) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return;
    const n = parseInt(m[1]!, 16);
    const w = weights[i] ?? 1;
    r += lin(((n >> 16) & 255) / 255) * w;
    g += lin(((n >> 8) & 255) / 255) * w;
    b += lin((n & 255) / 255) * w;
    tot += w;
  });
  if (!tot) return colors[0] ?? "#000000";
  const h = (v: number): string => Math.round(gam(v / tot) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Lays out the chart. `colorOf(family)` colours a section; in "mix" mode doubled pitches
 * blend those colours, weighted by the number of parts of each section on the pitch.
 */
export function layoutChart(notes: ChartNote[], parts: ChartPart[], colorOf: (family: string) => string,
  mode: "split" | "mix"): Chart {
  // one entry per (part, pitch): the same part on the same pitch twice (ties, repeats) is one
  const seen = new Set<string>();
  const rows: { part: number; midi: number; name: string }[] = [];
  for (const n of notes) {
    for (const p of n.parts) {
      const k = `${p}:${n.midi}`;
      if (seen.has(k) || !parts[p]) continue;
      seen.add(k);
      rows.push({ part: p, midi: n.midi, name: n.name });
    }
  }
  const famOf = (p: number): string => parts[p]!.family;
  const families = CHART_ORDER.filter((f) => rows.some((r) => famOf(r.part) === f));
  for (const r of rows) if (!families.includes(famOf(r.part))) families.push(famOf(r.part));

  // columns: split = sections in pairs (left family labels left, right family labels right);
  // mix = one column for everything
  const LABEL_W = 70, COL_GAP = 26;
  const heads: Head[] = [];
  type Lane = { family: string | null; side: "start" | "end"; x0: number; x1: number };
  const lanes: Lane[] = [];
  let x = 16;
  const sideOf = new Map<string, "start" | "end">();
  const laneFams: (string | null)[][] = mode === "mix" ? [[null]]
    : families.reduce<string[][]>((acc, f, i) => (i % 2 ? acc[acc.length - 1]!.push(f) : acc.push([f]), acc), []);
  for (const col of laneFams) {
    x += LABEL_W; // room for the left labels
    for (let j = 0; j < col.length; j++) {
      const fam = col[j]!;
      const side = j === 0 ? "end" : "start"; // text-anchor: left labels end at the notes
      if (fam) sideOf.set(fam, side);
      const inLane = rows.filter((r) => fam === null || famOf(r.part) === fam);
      // noteheads: split = one per part on each pitch; mix = one per pitch
      const byMidi = new Map<number, typeof rows>();
      for (const r of inLane) byMidi.set(r.midi, [...(byMidi.get(r.midi) ?? []), r]);
      const midis = [...byMidi.keys()].sort((a, b) => a - b);
      let maxW = HEAD_W;
      let prevStep = -99;
      let prevShift = false;
      for (const m of midis) {
        const rs = byMidi.get(m)!;
        const { step, acc } = parseName(rs[0]!.name);
        const treble = m >= 60;
        // a second above the previous notehead sits to its right (as in engraving)
        const shift: boolean = step - prevStep === 1 && !prevShift;
        prevStep = step;
        prevShift = shift;
        const group = mode === "mix" ? [rs] : (famOf(rs[0]!.part) === "strings" ? [rs] : rs.map((r) => [r]));
        group.forEach((g, k) => {
          const fams = [...new Set(g.map((r) => famOf(r.part)))];
          const color = mode === "mix" && fams.length > 1
            ? mixColors(fams.map(colorOf), fams.map((f) => g.filter((r) => famOf(r.part) === f).length))
            : colorOf(famOf(g[0]!.part));
          const hx = x + (shift ? HEAD_W : 0) + k * (HEAD_W + 1);
          maxW = Math.max(maxW, hx - x + HEAD_W);
          for (const fam of mode === "mix" ? fams : [famOf(g[0]!.part)]) {
            heads.push({ x: hx, y: 0, step, acc, color, treble, family: fam,
              label: shortName(parts[g.find((r) => famOf(r.part) === fam)!.part]!) });
          }
        });
      }
      lanes.push({ family: fam, side, x0: x, x1: x + maxW });
      x += maxW + (j === 0 && col.length > 1 ? 10 : 0);
    }
    x += LABEL_W + COL_GAP;
  }
  // vertical placement: staves, then every head's y
  const stepsT = heads.filter((h) => h.treble).map((h) => h.step);
  const stepsB = heads.filter((h) => !h.treble).map((h) => h.step);
  const aboveT = Math.max(TREBLE_TOP, ...stepsT) - TREBLE_TOP; // steps above the treble top line
  const belowB = BASS_TOP - 8 - Math.min(BASS_TOP - 8, ...stepsB); // steps below the bass bottom line
  const trebleTop = 18 + (aboveT * S) / 2;
  const bassTop = trebleTop + 4 * S + 3 * S;
  const yOf = (step: number, treble: boolean): number =>
    treble ? trebleTop + ((TREBLE_TOP - step) * S) / 2 : bassTop + ((BASS_TOP - step) * S) / 2;
  for (const h of heads) h.y = yOf(h.step, h.treble);
  const height = bassTop + 4 * S + (belowB * S) / 2 + 22;
  // ledger lines
  const ledgers: Chart["ledgers"] = [];
  for (const h of heads) {
    const add = (step: number, treble: boolean): void =>
      void ledgers.push({ x0: h.x - 4, x1: h.x + HEAD_W + 4, y: yOf(step, treble) });
    if (h.treble) {
      for (let s = TREBLE_TOP + 2; s <= h.step; s += 2) add(s, true);
      for (let s = TREBLE_TOP - 10; s >= h.step; s -= 2) add(s, true); // C4 and below
    } else {
      for (let s = BASS_TOP - 10; s >= h.step; s -= 2) add(s, false);
      for (let s = BASS_TOP + 2; s <= h.step; s += 2) add(s, false);
    }
  }
  // labels: parts of a section with the same pitches share a label ("fl. & ob.")
  const labels: Label[] = [];
  for (const lane of lanes) {
    const fams = lane.family ? [lane.family] : families;
    for (const fam of fams) {
      const side = lane.family ? lane.side : sideOf.get(fam) ?? (fams.indexOf(fam) % 2 ? "start" : "end");
      const mine = heads.filter((h) => h.family === fam && h.x >= lane.x0 - 1 && h.x <= lane.x1);
      const byLabel = new Map<string, Head[]>();
      for (const h of mine) byLabel.set(h.label, [...(byLabel.get(h.label) ?? []), h]);
      const sig = (hs: Head[]): string => [...new Set(hs.map((h) => h.step))].sort().join(",");
      const merged = new Map<string, { texts: string[]; heads: Head[] }>();
      for (const [text, hs] of byLabel) {
        const k = sig(hs);
        const e = merged.get(k) ?? { texts: [], heads: [] };
        e.texts.push(text);
        e.heads.push(...hs);
        merged.set(k, e);
      }
      for (const { texts, heads: hs } of merged.values()) {
        const ys = hs.map((h) => h.y);
        const y0 = Math.min(...ys), y1 = Math.max(...ys);
        // left of the notes, keep clear of their accidentals
        const accW = side === "end" && mine.some((h) => h.acc && h.x <= lane.x0 + 1) ? 11 : 0;
        const lx = side === "end" ? lane.x0 - 12 - accW : lane.x1 + 12;
        labels.push({ text: texts.join(" & "), color: colorOf(fam), x: lx, y: (y0 + y1) / 2 + 4, anchor: side,
          bracket: y1 - y0 > 2 ? { x: side === "end" ? lane.x0 - 6 - accW : lane.x1 + 6, y0: y0 - 4, y1: y1 + 4 } : null,
          leaders: [] });
      }
    }
  }
  // labels on one side of one lane must not overlap: push apart, then draw leaders
  // (grouped by lane and side, not exact x: accidental room shifts some labels)
  const groups = new Map<string, Label[]>();
  for (const l of labels) {
    const lane = lanes.findIndex((ln) => (l.anchor === "end" ? l.x < ln.x0 : l.x > ln.x1) &&
      Math.abs((l.anchor === "end" ? ln.x0 : ln.x1) - l.x) < 40);
    const k = `${lane}:${l.anchor}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  for (const ls of groups.values()) {
    // one column of labels: align on the outermost, then space them out vertically
    const edge = ls[0]!.anchor === "end" ? Math.min(...ls.map((l) => l.x)) : Math.max(...ls.map((l) => l.x));
    for (const l of ls) l.x = edge;
    ls.sort((a, b) => a.y - b.y);
    const target = ls.map((l) => l.y);
    for (let i = 1; i < ls.length; i++) ls[i]!.y = Math.max(ls[i]!.y, ls[i - 1]!.y + 13);
    ls.forEach((l, i) => {
      if (Math.abs(l.y - target[i]!) > S * 0.6) {
        // moved away from its notes: shift it out and draw a line back to them
        const tipX = l.bracket ? l.bracket.x : l.anchor === "end" ? l.x + 10 : l.x - 10;
        l.x += l.anchor === "end" ? -14 : 14;
        l.leaders.push({ x0: l.anchor === "end" ? l.x + 3 : l.x - 3, y0: l.y - 4, x1: tipX, y1: target[i]! - 4 });
      }
    });
  }
  return {
    width: Math.max(x - COL_GAP + 8, 160), height, heads, labels, ledgers,
    staves: [{ top: trebleTop, treble: true }, { top: bassTop, treble: false }], left: 4, right: x - COL_GAP,
  };
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The chart as an SVG string (no scripts, no external references). */
export function renderChart(c: Chart, ink = "#1b1b1b"): string {
  const o: string[] = [];
  o.push(`<svg viewBox="0 0 ${c.width} ${c.height}" width="${c.width}" height="${c.height}" role="img" aria-label="Orchestration chart">`);
  for (const st of c.staves) {
    for (let i = 0; i < 5; i++) o.push(`<line x1="${c.left}" x2="${c.right}" y1="${st.top + i * S}" y2="${st.top + i * S}" stroke="${ink}" stroke-width="1"/>`);
  }
  const t = c.staves[0]!, b = c.staves[1]!;
  o.push(`<line x1="${c.left}" x2="${c.left}" y1="${t.top}" y2="${b.top + 4 * S}" stroke="${ink}" stroke-width="1.5"/>`);
  o.push(`<text x="${c.left + 4}" y="${t.top + 3.6 * S}" font-size="${4.4 * S}" fill="${ink}" font-family="Bravura Text, Noto Music, Segoe UI Symbol, serif">𝄞</text>`);
  o.push(`<text x="${c.left + 4}" y="${b.top + 2.6 * S}" font-size="${3.2 * S}" fill="${ink}" font-family="Bravura Text, Noto Music, Segoe UI Symbol, serif">𝄢</text>`);
  for (const l of c.ledgers) o.push(`<line x1="${l.x0}" x2="${l.x1}" y1="${l.y}" y2="${l.y}" stroke="${ink}" stroke-width="1"/>`);
  for (const h of c.heads) {
    // a whole note: an open, tilted oval in the section colour
    o.push(`<ellipse cx="${h.x + HEAD_W / 2}" cy="${h.y}" rx="${HEAD_W / 2 - 1}" ry="${S / 2 - 0.6}" fill="none" stroke="${h.color}" stroke-width="2.6" transform="rotate(-18 ${h.x + HEAD_W / 2} ${h.y})"/>`);
    if (h.acc) o.push(`<text x="${h.x - 2}" y="${h.y + 4}" font-size="13" text-anchor="end" fill="${h.color}">${esc(h.acc)}</text>`);
  }
  for (const l of c.labels) {
    if (l.bracket) {
      const d = l.anchor === "end" ? 4 : -4;
      o.push(`<path d="M${l.bracket.x + d} ${l.bracket.y0} H${l.bracket.x} V${l.bracket.y1} H${l.bracket.x + d}" fill="none" stroke="${l.color}" stroke-width="1.6"/>`);
    }
    for (const s of l.leaders) o.push(`<line x1="${s.x0}" y1="${s.y0}" x2="${s.x1}" y2="${s.y1}" stroke="${l.color}" stroke-width="1.4"/>`);
    o.push(`<text x="${l.x}" y="${l.y}" font-size="13" font-weight="600" text-anchor="${l.anchor}" fill="${l.color}" font-family="system-ui, sans-serif">${esc(l.text)}</text>`);
  }
  o.push("</svg>");
  return o.join("");
}

/** The chart's notes from a selection in a reduction's note map. */
export function chartNotes(ids: string[], map: Record<string, MapNote>): ChartNote[] {
  return ids.map((id) => map[id]).filter((n): n is MapNote => !!n).map((n) => ({ midi: n.midi, name: n.name, parts: n.parts }));
}
