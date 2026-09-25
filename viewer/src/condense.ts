// Condensing a selection of reduced notes (score/reduce.py note map) into
//   - one chord: every distinct sounding pitch, on a grand staff, coloured
//   - its pitch-class set as a scale: unique pitch classes, stemless, ascending from the
//     lowest note's pitch class, in the score's own spelling
// as small MusicXML documents for Verovio. Pure functions (tested in condense.test.ts).

export interface MapNote {
  parts: number[];
  midi: number;
  name: string; // spelled, e.g. "E♭5"
  group: number;
  bar: number;
}

export interface ColoredPitch {
  midi: number;
  name: string;
  color: string; // #rrggbb
  parts: number[];
}

const ACC: Record<string, number> = { "♭": -1, "♯": 1, "𝄫": -2, "𝄪": 2 };
const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LETTERS = "CDEFGAB";

export interface Pitch {
  step: string;
  alter: number;
  octave: number;
}

/** "E♭5" -> {step: "E", alter: -1, octave: 5}. */
export function parsePitch(name: string): Pitch {
  const m = /^([A-G])([♭♯𝄫𝄪]*)(-?\d+)$/u.exec(name);
  if (!m) throw new Error(`unreadable pitch name ${name}`);
  let alter = 0;
  for (const ch of m[2]!) alter += ACC[ch] ?? 0;
  return { step: m[1]!, alter, octave: Number(m[3]) };
}

const pcOf = (p: Pitch): number => (((STEP_PC[p.step]! + p.alter) % 12) + 12) % 12;
const accName = (alter: number): string =>
  alter === -2 ? "𝄫" : alter === -1 ? "♭" : alter === 1 ? "♯" : alter === 2 ? "𝄪" : "";

/** Distinct pitches of the selected notes (first part's colour), low to high. */
export function condense(ids: string[], map: Record<string, MapNote>, colorOf: (parts: number[]) => string): ColoredPitch[] {
  const by = new Map<number, ColoredPitch>();
  for (const id of ids) {
    const n = map[id];
    if (!n) continue;
    const cur = by.get(n.midi);
    if (cur) {
      for (const p of n.parts) if (!cur.parts.includes(p)) cur.parts.push(p);
    } else {
      by.set(n.midi, { midi: n.midi, name: n.name, color: colorOf(n.parts), parts: [...n.parts] });
    }
  }
  return [...by.values()].sort((a, b) => a.midi - b.midi);
}

/**
 * Pitch-class set as a scale: one spelling per pitch class (the most common one in the
 * selection), ascending from the lowest note's pitch class, placed from octave 4 up.
 */
export function pitchClassSet(pitches: ColoredPitch[]): { name: string; pitch: Pitch; color: string }[] {
  if (!pitches.length) return [];
  const spell = new Map<number, Map<string, { n: number; color: string }>>();
  for (const p of pitches) {
    const pp = parsePitch(p.name);
    const key = `${pp.step}${accName(pp.alter)}`;
    const pc = pcOf(pp);
    const m = spell.get(pc) ?? new Map();
    const e = m.get(key) ?? { n: 0, color: p.color };
    e.n++;
    m.set(key, e);
    spell.set(pc, m);
  }
  const root = pcOf(parsePitch(pitches[0]!.name));
  const pcs = [...spell.keys()].sort((a, b) => ((a - root + 12) % 12) - ((b - root + 12) % 12));
  let octave = 4;
  let lastLetter = -1;
  let lastMidi = -Infinity;
  const out: { name: string; pitch: Pitch; color: string }[] = [];
  for (const pc of pcs) {
    const [key, e] = [...spell.get(pc)!.entries()].sort((a, b) => b[1].n - a[1].n)[0]!;
    const step = key[0]!;
    const alter = [...key.slice(1)].reduce((a, ch) => a + (ACC[ch] ?? 0), 0);
    const li = LETTERS.indexOf(step);
    if (lastLetter >= 0 && li <= lastLetter) octave++; // keep ascending on the staff
    let pitch = { step, alter, octave };
    let midi = (pitch.octave + 1) * 12 + STEP_PC[step]! + alter;
    if (midi <= lastMidi) {
      pitch = { ...pitch, octave: pitch.octave + 1 };
      midi += 12;
      octave++;
    }
    lastLetter = li;
    lastMidi = midi;
    out.push({ name: key, pitch, color: e.color });
  }
  return out;
}

const esc = (s: string): string => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

function pitchXml(p: Pitch): string {
  return `<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>`;
}

function accidentalXml(p: Pitch): string {
  const a = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" }[p.alter];
  return a && p.alter !== 0 ? `<accidental>${a}</accidental>` : "";
}

const HEAD = '<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">';

/** One whole-note chord on a grand staff (treble >= middle C). */
export function chordXml(pitches: ColoredPitch[], label = ""): string {
  const staves = [1, 2].map((staff) => pitches.filter((p) => (p.midi >= 60) === (staff === 1)));
  const notes = staves.map((list, si) => {
    const staff = si + 1;
    if (!list.length) {
      return `<note><rest/><duration>4</duration><voice>${staff}</voice><type>whole</type><staff>${staff}</staff></note>`;
    }
    return list.map((p, i) => {
      const pp = parsePitch(p.name);
      return `<note color="${esc(p.color)}">${i ? "<chord/>" : ""}${pitchXml(pp)}<duration>4</duration>` +
        `<voice>${staff}</voice><type>whole</type>${accidentalXml(pp)}<staff>${staff}</staff></note>`;
    }).join("");
  });
  return `${HEAD}<part-list><score-part id="C"><part-name>${esc(label)}</part-name></score-part></part-list>` +
    `<part id="C"><measure number="1"><attributes><divisions>1</divisions><key print-object="no"><fifths>0</fifths></key>` +
    `<time print-object="no"><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>` +
    `<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>` +
    `${notes[0]}<backup><duration>4</duration></backup>${notes[1]}` +
    `<barline location="right"><bar-style>light-heavy</bar-style></barline></measure></part></score-partwise>`;
}

/** A pitch-class set as stemless noteheads on a treble staff (like a tone row). */
export function scaleXml(set: { pitch: Pitch; color: string }[], label = ""): string {
  const n = Math.max(1, set.length);
  const notes = set.map((s) =>
    `<note color="${esc(s.color)}">${pitchXml(s.pitch)}<duration>1</duration><voice>1</voice><type>quarter</type>` +
    `${accidentalXml(s.pitch)}<stem>none</stem></note>`).join("");
  return `${HEAD}<part-list><score-part id="S"><part-name>${esc(label)}</part-name></score-part></part-list>` +
    `<part id="S"><measure number="1"><attributes><divisions>1</divisions><key print-object="no"><fifths>0</fifths></key>` +
    `<time print-object="no"><beats>${n}</beats><beat-type>4</beat-type></time>` +
    `<clef><sign>G</sign><line>2</line></clef></attributes>${notes || '<note><rest/><duration>1</duration><voice>1</voice><type>quarter</type></note>'}` +
    `<barline location="right"><bar-style>light-heavy</bar-style></barline></measure></part></score-partwise>`;
}

/**
 * A UI colour made readable as ink on the light score paper: lightness capped at 38 %,
 * saturation at least 55 % (hue kept, so sections stay recognisable).
 */
export function ink(css: string): string {
  const hex = toHex(css);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0;
  const d = mx - mn;
  if (d) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = Math.min(0.38, (mx + mn) / 2);
  const s = Math.max(0.55, d ? d / (1 - Math.abs(mx + mn - 1)) : 0);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = l - c / 2;
  const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[rr, gg, bb].map((v) => Math.round((v + m0) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** "rgb(r,g,b)" or "#rrggbb" -> "#rrggbb" (MusicXML colours). */
export function toHex(css: string): string {
  if (css.startsWith("#")) return css.length === 4 ? `#${[...css.slice(1)].map((c) => c + c).join("")}` : css;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) return "#000000";
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;
}
