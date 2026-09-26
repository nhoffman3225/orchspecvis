// Orchestration chart of a selected chord (the tutti view's pop-up): a grand staff where
// every section stands in its own block (headed by its name, in its colour), sized from
// its content so nothing collides; the chart grows to fit.
//   "mix" (the default): one notehead per pitch in each section, labelled with its
//     instruments in a label lane beside the notes (bracketed over several notes, a
//     leader line when a label had to move away from them).
//   "split" (split doublings): every instrument in its own sub-column under its name, so
//     each notehead belongs to exactly one instrument.
// Layout is pure (tested); renderChart() returns an SVG string.

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
const SECTION_TITLE: Record<string, string> = {
  strings: "Strings", percussion: "Percussion", woodwinds: "Woodwinds", brass: "Brass",
  keyboards: "Keyboards", voices: "Voices", other: "Other",
};

const ABBR: [RegExp, string][] = [
  [/piccolo/, "picc."], [/alto flute/, "a. fl."], [/flute/, "fl."],
  [/english horn|cor anglais/, "e.h."], [/oboe/, "ob."],
  [/bass clarinet/, "b. cl."], [/clarinet/, "clar."],
  [/contrabassoon|contrafagott/, "cbn."], [/bassoon/, "bn."],
  [/saxophone/, "sax."], [/horn/, "hrn."], [/trumpet|cornet/, "trp."], [/trombone/, "tbn."],
  [/tuba/, "tba."], [/timpani/, "timp."], [/harp/, "hp."], [/celesta/, "cel."],
  [/piano/, "pno."], [/organ/, "org."],
  [/violin/, "vln."], [/viola/, "vla."], [/violoncello|cello/, "vc."], [/contrabass|double bass/, "cb."],
  [/strings/, "str."],
  [/drum|cymbal|triangle|glock|xylo|marimba|vibra|percussion|tam/, "perc."],
];

/** The short name of a part's instrument: "Clarinet (B Flat) 2" -> "clar.". */
export function shortName(p: ChartPart): string {
  const n = `${p.name} ${p.abbreviation ?? ""}`.toLowerCase();
  for (const [re, a] of ABBR) if (re.test(n)) return a;
  const w = (p.abbreviation || p.name).replace(/[\d().]+/g, " ").trim().split(/\s+/)[0] ?? "?";
  return `${w.toLowerCase().slice(0, 5)}.`;
}

/** The part's own label: its instrument and desk/player number ("clar. 2", "vln. I"). */
export function partLabel(p: ChartPart): string {
  const num = /(?:^|\s)(\d+|[IV]{1,4})\s*$/.exec(p.name.replace(/\s*&.*$/, "").trim())?.[1];
  return num ? `${shortName(p)} ${num}` : shortName(p);
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
  midi: number;
  step: number;
  acc: string;
  color: string;
  treble: boolean;
  family: string;
  parts: number[]; // the parts this notehead stands for
}

export interface Label {
  text: string;
  color: string;
  x: number;
  y: number;
  anchor: "start" | "end";
  bracket: { x: number; y0: number; y1: number } | null;
  /** leader lines as polylines [x, y][]: out of the label, along its own gutter, into its notes */
  leaders: [number, number][][];
}

/** A rotated instrument name heading a sub-column ("split" mode). */
export interface Header {
  text: string;
  color: string;
  x: number;
  y: number;
}

export interface Section {
  title: string;
  color: string;
  x0: number;
  x1: number;
}

export interface Chart {
  width: number;
  height: number;
  heads: Head[];
  labels: Label[];
  headers: Header[];
  sections: Section[];
  ledgers: { x0: number; x1: number; y: number }[];
  staves: { top: number; treble: boolean }[];
  left: number;
  right: number;
  /** the G line (treble) and the F line (bass): where the clefs' origins sit */
  gLine: number;
  fLine: number;
}

export const S = 10; // staff space
const HEAD_W = 13;
const ACC_W = 11;
const TREBLE_TOP = 38; // F5
const BASS_TOP = 26; // A3
const CLEF_W = 40;
const SECTION_GAP = 22;
const LABEL_H = 17; // a label pill's height, and the minimum distance between labels
export const HEADER_ANGLE = 55; // degrees, part headers
const TITLE_H = 18; // section title band
const GUTTER = 7; // horizontal room per leader line between the labels and the notes

/** Width of a label in px, estimated (13px bold system-ui). */
export const textW = (t: string): number =>
  [...t].reduce((w, ch) => w + (/[mwMW&]/.test(ch) ? 10 : /[.,il |I]/.test(ch) ? 4 : 7.4), 0);

/** Colour of a doubled pitch in "mix" colouring: the colours averaged in linear light,
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

type Row = { part: number; midi: number; name: string };

/** Places the pitches of one sub-column: seconds side by side, accidentals to the left.
 * Returns the heads (x relative to the sub-column) and the sub-column's width. */
function placeColumn(pitches: { midi: number; name: string; parts: number[] }[]): {
  heads: { dx: number; step: number; acc: string; midi: number; parts: number[] }[]; width: number;
} {
  const sorted = [...pitches].sort((a, b) => a.midi - b.midi);
  const accW = sorted.some((p) => parseName(p.name).acc) ? ACC_W : 0;
  let prevStep = -99;
  let prevShift = false;
  let width = accW + HEAD_W;
  const heads = sorted.map((p) => {
    const { step, acc } = parseName(p.name);
    const shift: boolean = step - prevStep <= 1 && !prevShift; // a second (or unison) above
    prevStep = step;
    prevShift = shift;
    const dx = accW + (shift ? HEAD_W : 0);
    width = Math.max(width, dx + HEAD_W);
    return { dx, step, acc, midi: p.midi, parts: p.parts };
  });
  return { heads, width };
}

/** Mix-mode labels: instruments with exactly the same pitches share one ("fl. & ob."). */
function sectionLabels(famRows: Row[], parts: ChartPart[]): { text: string; midis: number[] }[] {
  const byName = new Map<string, Set<number>>();
  for (const r of famRows) {
    const n = shortName(parts[r.part]!);
    byName.set(n, (byName.get(n) ?? new Set()).add(r.midi));
  }
  const bySet = new Map<string, { names: string[]; midis: number[] }>();
  for (const [n, set] of byName) {
    const midis = [...set].sort((a, b) => a - b);
    const k = midis.join(",");
    const e = bySet.get(k) ?? { names: [], midis };
    e.names.push(n);
    bySet.set(k, e);
  }
  return [...bySet.values()].map((e) => ({ text: e.names.join(" & "), midis: e.midis }));
}

/**
 * Lays out the chart. `colorOf(family)` colours a section. "mix": one notehead per pitch
 * in each section, labelled beside; "split": a sub-column per instrument, named above.
 */
export function layoutChart(notes: ChartNote[], parts: ChartPart[], colorOf: (family: string) => string,
  mode: "split" | "mix"): Chart {
  const perPart = mode === "split";
  // one entry per (part, pitch): the same part on the same pitch twice (ties, repeats) is one
  const seen = new Set<string>();
  const rows: Row[] = [];
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

  // --- horizontal: a block per section, each sized from its content
  const placed: Omit<Head, "y">[] = [];
  const headers: Header[] = [];
  const sections: Section[] = [];
  const lanes: { fam: string; notesX: number }[] = [];
  let x = CLEF_W;
  let headerRise = 0; // how far the rotated headers reach above their baseline
  for (const fam of families) {
    const color = colorOf(fam);
    const famRows = rows.filter((r) => famOf(r.part) === fam);
    const x0 = x;
    if (perPart) {
      // a sub-column per instrument, in score order, named above
      const partIds = [...new Set(famRows.map((r) => r.part))].sort((a, b) => a - b);
      for (const p of partIds) {
        const col = placeColumn(famRows.filter((r) => r.part === p).map((r) => ({ midi: r.midi, name: r.name, parts: [p] })));
        const cx = x + 2;
        for (const h of col.heads) {
          placed.push({ x: cx + h.dx, midi: h.midi, step: h.step, acc: h.acc, color, treble: h.midi >= 60, family: fam, parts: h.parts });
        }
        const text = partLabel(parts[p]!);
        const firstHead = Math.min(...col.heads.map((h) => h.dx));
        headers.push({ text, color, x: cx + firstHead + HEAD_W / 2, y: 0 });
        headerRise = Math.max(headerRise, textW(text) * Math.sin((HEADER_ANGLE * Math.PI) / 180) + 4);
        x += col.width + 12;
      }
    } else {
      // a measured label lane, then one notehead per pitch
      const byMidi = new Map<number, Row[]>();
      for (const r of famRows) byMidi.set(r.midi, [...(byMidi.get(r.midi) ?? []), r]);
      const col = placeColumn([...byMidi.values()].map((rs) => ({ midi: rs[0]!.midi, name: rs[0]!.name, parts: rs.map((r) => r.part) })));
      const nLabels = sectionLabels(famRows, parts).length;
      // pill + a gutter per possible leader line + bracket room
      const laneW = Math.max(...sectionLabels(famRows, parts).map((l) => textW(l.text)), 20) + 22 + GUTTER * nLabels;
      const notesX = x + laneW;
      lanes.push({ fam, notesX });
      for (const h of col.heads) {
        placed.push({ x: notesX + h.dx, midi: h.midi, step: h.step, acc: h.acc, color, treble: h.midi >= 60, family: fam, parts: h.parts });
      }
      x = notesX + col.width + 6;
    }
    const title = SECTION_TITLE[fam] ?? fam;
    x = Math.max(x, x0 + textW(title.toUpperCase()) + 10); // the title fits over its block
    sections.push({ title, color, x0, x1: x });
    x += SECTION_GAP;
  }
  const right = x - SECTION_GAP + 8;

  // --- vertical: titles, headers, staves; the chart grows to fit what is placed
  const stepsOf = (treble: boolean): number[] => placed.filter((h) => h.treble === treble).map((h) => h.step);
  const aboveT = Math.max(TREBLE_TOP, ...stepsOf(true)) - TREBLE_TOP;
  const belowB = BASS_TOP - 8 - Math.min(BASS_TOP - 8, ...stepsOf(false));
  const headerBase = TITLE_H + 8 + headerRise; // headers stand on this line
  const trebleTop = headerBase + 10 + (aboveT * S) / 2;
  const bassTop = trebleTop + 4 * S + 3 * S;
  const yOf = (step: number, treble: boolean): number =>
    treble ? trebleTop + ((TREBLE_TOP - step) * S) / 2 : bassTop + ((BASS_TOP - step) * S) / 2;
  const heads: Head[] = placed.map((h) => ({ ...h, y: yOf(h.step, h.treble) }));
  for (const h of headers) h.y = headerBase;

  const ledgers: Chart["ledgers"] = [];
  for (const h of heads) {
    const add = (step: number, treble: boolean): void =>
      void ledgers.push({ x0: h.x - 4, x1: h.x + HEAD_W + 4, y: yOf(step, treble) });
    if (h.treble) {
      for (let s = TREBLE_TOP + 2; s <= h.step; s += 2) add(s, true);
      for (let s = TREBLE_TOP - 10; s >= h.step; s -= 2) add(s, true);
    } else {
      for (let s = BASS_TOP - 10; s >= h.step; s -= 2) add(s, false);
      for (let s = BASS_TOP + 2; s <= h.step; s += 2) add(s, false);
    }
  }

  // --- mix-mode labels: in their lane, spaced apart, bracketed / with a leader line
  const labels: Label[] = [];
  let bottom = bassTop + 4 * S + (belowB * S) / 2;
  for (const lane of lanes) {
    const famRows = rows.filter((r) => famOf(r.part) === lane.fam);
    const color = colorOf(lane.fam);
    const mine = sectionLabels(famRows, parts).map((l) => {
      const noteYs = heads.filter((h) => h.family === lane.fam && l.midis.includes(h.midi)).map((h) => h.y);
      const y0 = Math.min(...noteYs), y1 = Math.max(...noteYs);
      return { text: l.text, y0, y1, noteYs, target: (y0 + y1) / 2 };
    }).sort((a, b) => a.target - b.target);
    // a bracket only where it cannot overlap another label's: interleaved pitch sets
    // (vln. / vla. sharing a range) fan out to each of their notes instead
    const overlaps = (i: number): boolean => mine.some((o, j) => j !== i && o.y0 <= mine[i]!.y1 + 6 && mine[i]!.y0 <= o.y1 + 6);
    const style = mine.map((l, i): "bracket" | "fan" | "line" =>
      l.y1 - l.y0 <= 2 ? "line" : overlaps(i) ? "fan" : "bracket");
    // stack: at least LABEL_H apart, then re-centre each pushed cluster on its notes
    const ys = mine.map((l) => l.target);
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i]!, ys[i - 1]! + LABEL_H);
    for (let i = 0; i < ys.length;) {
      let j = i;
      while (j + 1 < ys.length && ys[j + 1]! - ys[j]! <= LABEL_H + 0.01) j++;
      const disp = ys.slice(i, j + 1).reduce((a, y, k) => a + (y - mine[i + k]!.target), 0) / (j - i + 1);
      const floor = i > 0 ? ys[i - 1]! + LABEL_H - ys[i]! : -Infinity; // stay below the cluster above
      const shift = Math.max(-disp, floor);
      for (let k = i; k <= j; k++) ys[k] = ys[k]! + shift;
      i = j + 1;
    }
    const gutters = GUTTER * mine.length;
    const pillRight = lane.notesX - 10 - gutters;
    // gutter slots, chosen so no two leaders cross: labels moved down take the inner
    // gutters (lower ones further right), labels moved up the outer ones (upper ones
    // further right)
    const movedOf = (i: number): number => ys[i]! - mine[i]!.target; // > 0: moved down
    // a fan always leaves through a gutter, like a label that had to move
    const isMoved = (i: number): boolean => Math.abs(movedOf(i)) > S * 0.6 || style[i] === "fan";
    const down = mine.map((_, i) => i).filter((i) => isMoved(i) && movedOf(i) >= 0);
    const up = mine.map((_, i) => i).filter((i) => isMoved(i) && movedOf(i) < 0);
    const slotOf = new Map<number, number>();
    down.forEach((i, k) => slotOf.set(i, k));
    up.forEach((i, k) => slotOf.set(i, down.length + (up.length - 1 - k)));
    mine.forEach((l, i) => {
      const y = ys[i]!;
      const moved = isMoved(i);
      const bx = lane.notesX - 5;
      const end = style[i] === "bracket" ? bx : lane.notesX - 2;
      const label: Label = {
        text: l.text, color, anchor: "end", y: y + 4, x: pillRight,
        bracket: style[i] === "bracket" ? { x: bx, y0: l.y0 - 4, y1: l.y1 + 4 } : null, leaders: [],
      };
      if (moved) {
        // out of the label, a diagonal in its own gutter, then into the bracket or the note;
        // a fan: from the gutter, a line to each of its notes
        const gx = pillRight + 6 + GUTTER * slotOf.get(i)!;
        const targets = style[i] === "fan" ? l.noteYs : [l.target];
        const [first, ...rest] = targets;
        label.leaders.push([[pillRight + 2, y], [gx, y], [gx + 4, first!], [end, first!]]);
        for (const ty of rest) label.leaders.push([[gx, y], [gx + 4, ty], [end, ty]]);
      } else if (end - pillRight > 6) {
        label.leaders.push([[pillRight + 2, l.target], [end, l.target]]);
      }
      labels.push(label);
      bottom = Math.max(bottom, y + LABEL_H);
    });
  }
  return {
    width: right + 8, height: bottom + 18, heads, labels, headers, sections, ledgers,
    staves: [{ top: trebleTop, treble: true }, { top: bassTop, treble: false }], left: 4, right,
    gLine: yOf(32, true), fLine: yOf(24, false), // G4, F3
  };
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** SMuFL glyphs by code point ("E050" G clef, "E062" F clef, "E260" flat, "E261"
 * natural, "E262" sharp): the id of a glyph already defined in the page (Verovio's
 * engraved score carries them), or null to fall back to text. */
export type GlyphLookup = (code: string) => string | null;

const ACC_GLYPH: Record<string, string> = { "♭": "E260", "♮": "E261", "♯": "E262", "𝄫": "E264", "𝄪": "E263" };
const PAPER = "#fbf8f1";

/** The chart as an SVG string (no scripts, no external references). */
export function renderChart(c: Chart, ink = "#1b1b1b", glyph: GlyphLookup = () => null): string {
  // SMuFL: 1 em = 4 staff spaces = 1000 glyph units, so one staff space is 250 units
  const use = (code: string, x: number, y: number, fill: string): string | null => {
    const id = code ? glyph(code) : null;
    return id ? `<use href="#${esc(id)}" transform="translate(${x} ${y}) scale(${S / 250})" fill="${fill}"/>` : null;
  };
  const o: string[] = [];
  o.push(`<svg viewBox="0 0 ${c.width} ${c.height}" width="${c.width}" height="${c.height}" role="img" aria-label="Orchestration chart">`);
  // section titles over their blocks, with a rule in the section colour
  for (const s of c.sections) {
    o.push(`<text x="${s.x0}" y="13" font-size="11" font-weight="900" letter-spacing="0.06em" fill="${s.color}" font-family="system-ui, sans-serif">${esc(s.title.toUpperCase())}</text>`);
    o.push(`<line x1="${s.x0}" x2="${s.x1}" y1="18" y2="18" stroke="${s.color}" stroke-width="2.5"/>`);
  }
  for (const st of c.staves) {
    for (let i = 0; i < 5; i++) o.push(`<line x1="${c.left}" x2="${c.right}" y1="${st.top + i * S}" y2="${st.top + i * S}" stroke="${ink}" stroke-width="1"/>`);
  }
  const t = c.staves[0]!, b = c.staves[1]!;
  o.push(`<line x1="${c.left}" x2="${c.left}" y1="${t.top}" y2="${b.top + 4 * S}" stroke="${ink}" stroke-width="1.5"/>`);
  // clefs: the engraved glyphs on their lines (G clef on G4, F clef on F3), else text
  o.push(use("E050", c.left + 6, c.gLine, ink)
    ?? `<text x="${c.left + 4}" y="${t.top + 3.6 * S}" font-size="${4.4 * S}" fill="${ink}" font-family="Bravura Text, Noto Music, Segoe UI Symbol, serif">𝄞</text>`);
  o.push(use("E062", c.left + 6, c.fLine, ink)
    ?? `<text x="${c.left + 4}" y="${b.top + 2.6 * S}" font-size="${3.2 * S}" fill="${ink}" font-family="Bravura Text, Noto Music, Segoe UI Symbol, serif">𝄢</text>`);
  // a faint dashed divider between section blocks, through both staves
  for (const s of c.sections.slice(1)) {
    const sx = s.x0 - SECTION_GAP / 2;
    o.push(`<line x1="${sx}" x2="${sx}" y1="${t.top - 6}" y2="${b.top + 4 * S + 6}" stroke="${ink}" stroke-opacity="0.3" stroke-dasharray="3 3"/>`);
  }
  for (const l of c.ledgers) o.push(`<line x1="${l.x0}" x2="${l.x1}" y1="${l.y}" y2="${l.y}" stroke="${ink}" stroke-width="1"/>`);
  // part headers: the instrument's name over its sub-column, a guide line to the staff
  for (const h of c.headers) {
    o.push(`<line x1="${h.x}" x2="${h.x}" y1="${h.y + 3}" y2="${t.top - 3}" stroke="${h.color}" stroke-opacity="0.5" stroke-width="1"/>`);
    o.push(`<text transform="translate(${h.x} ${h.y}) rotate(-${HEADER_ANGLE})" font-size="12" font-weight="700" fill="${h.color}" font-family="system-ui, sans-serif">${esc(h.text)}</text>`);
  }
  for (const h of c.heads) {
    // a whole note: an open, tilted oval in the section colour
    o.push(`<ellipse cx="${h.x + HEAD_W / 2}" cy="${h.y}" rx="${HEAD_W / 2 - 1}" ry="${S / 2 - 0.6}" fill="none" stroke="${h.color}" stroke-width="2.6" transform="rotate(-18 ${h.x + HEAD_W / 2} ${h.y})"/>`);
    if (h.acc) {
      o.push(use(ACC_GLYPH[h.acc] ?? "", h.x - 1.1 * S, h.y, h.color)
        ?? `<text x="${h.x - 2}" y="${h.y + 4}" font-size="13" text-anchor="end" fill="${h.color}">${esc(h.acc)}</text>`);
    }
  }
  for (const l of c.labels) {
    if (l.bracket) {
      o.push(`<path d="M${l.bracket.x + 4} ${l.bracket.y0} H${l.bracket.x} V${l.bracket.y1} H${l.bracket.x + 4}" fill="none" stroke="${l.color}" stroke-width="1.6"/>`);
    }
    for (const pts of l.leaders) {
      o.push(`<polyline points="${pts.map(([px, py]) => `${px},${py}`).join(" ")}" fill="none" stroke="${l.color}" stroke-width="1.4" stroke-linejoin="round"/>`);
    }
    // a light pill behind the label keeps it readable over staff lines and noteheads
    const w = textW(l.text) + 8;
    const rx = l.anchor === "end" ? l.x - w + 4 : l.x - 4;
    o.push(`<rect x="${rx}" y="${l.y - 12}" width="${w}" height="16" rx="3" fill="${PAPER}" fill-opacity="0.95" stroke="${l.color}" stroke-width="1"/>`);
    o.push(`<text x="${l.x}" y="${l.y}" font-size="13" font-weight="600" text-anchor="${l.anchor}" fill="${l.color}" font-family="system-ui, sans-serif">${esc(l.text)}</text>`);
  }
  o.push("</svg>");
  return o.join("");
}

/** The chart's notes from a selection in a reduction's note map. */
export function chartNotes(ids: string[], map: Record<string, MapNote>): ChartNote[] {
  return ids.map((id) => map[id]).filter((n): n is MapNote => !!n).map((n) => ({ midi: n.midi, name: n.name, parts: n.parts }));
}
