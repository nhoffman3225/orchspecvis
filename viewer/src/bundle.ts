// Session bundle v1 loader. Mirrors src/orchspec/bundle/schema.py and
// docs/bundle-format.md; validation is strict (unknown keys are errors) so drift between
// the Python writer and this reader is caught by the cross-language test.

import { fetchSameOrigin } from "./net";

export const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5] as const;
export const NOTE_COLUMNS = [
  "part", "staff", "voice", "midi", "onset_s", "offset_s", "measure", "beat", "velocity",
  "f0_db", "f0_ok",
] as const;
export type NoteColumn = (typeof NOTE_COLUMNS)[number];

export interface Tile {
  index: number;
  start_frame: number;
  n_frames: number;
  path: string;
}
export interface Lod {
  level: number;
  hop_factor: number;
  n_frames: number;
  tiles: Tile[];
}
export interface Stem {
  id: string;
  index: number;
  name: string;
  source_file: string;
  lods: Lod[];
}
export interface DominantStem {
  none_value: number;
  floor_db: number;
  lods: Lod[];
}
export interface Series {
  name: string;
  unit: string;
  description: string;
  path: string;
  shape: number[];
  dtype: "f32le";
  t0_seconds: number;
  hop_seconds: number;
  row_labels: string[] | null;
}
export interface CqtInfo {
  backend: string;
  k: number;
  filter_scale: number;
  window: string;
  tuning: number;
  frame_convention: "centered";
}
export interface ScorePart {
  index: number;
  id: string;
  name: string;
  instrument: string;
  abbreviation: string;
  staves: number;
  transpose_chromatic: number;
  transpose_octave: number;
  stem_id: string | null;
  stem_match: "name" | "fuzzy" | "order" | "none";
  range_id: string | null;
  range_low: number | null;
  range_high: number | null;
  practical_low: number | null;
  practical_high: number | null;
  latency_sec: number | null;
  snapped: number | null;
}
export interface ScoreMeasure {
  play_index: number;
  number: string;
  start_s: number;
  end_s: number;
  beats: number;
  beat_type: number;
  pass_no: number;
  source_index: number | null;
}
export interface Alignment {
  method: "warp" | "xcorr" | "manual" | "preroll_only";
  offset_sec: number;
  preroll_sec: number;
  confidence: number;
  time_source: "midi" | "score_tempo";
  pitch_agreement: number | null;
  pitch_shift_mode: number | null;
  warnings: string[];
  warp: [number, number][];
  snapped: number | null;
}
export interface ScoreInfo {
  kind: "musicxml" | "midi";
  source_files: string[];
  parts: ScorePart[];
  measures: ScoreMeasure[];
  notes: { path: string; n: number; columns: string[]; dtype: "f32le"; layout: "column_major" };
  alignment: Alignment;
  score_file: string | null;
  reductions: Reduction[]; // v5
}
/** v5: engravable reduction of the score and its note map (JSON). */
export interface Reduction {
  mode: "chords" | "section-chords" | "tutti" | "sections";
  musicxml: string;
  map: string;
}
export interface Manifest {
  schema_version: 1 | 2 | 3 | 4 | 5;
  created_by: string;
  created_at: string;
  sr: number;
  hop: number;
  n_samples: number;
  duration_seconds: number;
  fmin_midi: number;
  bins_per_octave: number;
  n_bins: number;
  n_frames: number;
  db_min: number;
  db_max: number;
  db_reference: "full_scale_sine_per_bin";
  lod_reduce: "max";
  tile_frames: number;
  tile_layout: "frame_major_u8";
  tile_encoding: "raw" | "gzip"; // v4: gzip = one gzip member per tile file
  lods: Lod[];
  audio_path: string;
  audio_sha256: string;
  cqt: CqtInfo;
  offsets: { preroll_sec: number };
  source: {
    kind: "wav" | "session";
    name: string;
    renderer: string | null;
    render_config: Record<string, unknown> | null;
  };
  stems: Stem[];
  dominant: DominantStem | null;
  features: Series[];
  tables: Series[];
  score: ScoreInfo | null;
}

export class BundleError extends Error {}

type Obj = Record<string, unknown>;

function fail(where: string, msg: string): never {
  throw new BundleError(`${where}: ${msg}`);
}
function obj(v: unknown, where: string, keys: string[], optional: string[] = []): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(where, "expected object");
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k) && !optional.includes(k)) fail(where, `unknown field '${k}'`);
  }
  for (const k of keys) if (!(k in o)) fail(where, `missing field '${k}'`);
  return o;
}
function int(v: unknown, where: string, min = 0): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) fail(where, `expected int >= ${min}`);
  return v;
}
function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(where, "expected number");
  return v;
}
function str(v: unknown, where: string): string {
  if (typeof v !== "string") fail(where, "expected string");
  return v;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) fail(where, "expected array");
  return v;
}
export function checkRelPath(p: unknown, where: string): string {
  const s = str(p, where);
  const parts = s.split("/");
  if (!s || s.includes("\\") || s.startsWith("/") || s.includes(":") || parts.includes("..")) {
    fail(where, `bundle path must be relative POSIX inside the bundle: '${s}'`);
  }
  return s;
}

function parseLods(v: unknown, where: string): Lod[] {
  return arr(v, where).map((l, i) => {
    const w = `${where}[${i}]`;
    const o = obj(l, w, ["level", "hop_factor", "n_frames", "tiles"]);
    const level = int(o.level, `${w}.level`);
    const hop_factor = int(o.hop_factor, `${w}.hop_factor`, 1);
    if (hop_factor !== 2 ** level) fail(w, "hop_factor must equal 2**level");
    const n_frames = int(o.n_frames, `${w}.n_frames`, 1);
    let expect = 0;
    const tiles = arr(o.tiles, `${w}.tiles`).map((t, j) => {
      const tw = `${w}.tiles[${j}]`;
      const to = obj(t, tw, ["index", "start_frame", "n_frames", "path"]);
      const tile: Tile = {
        index: int(to.index, `${tw}.index`),
        start_frame: int(to.start_frame, `${tw}.start_frame`),
        n_frames: int(to.n_frames, `${tw}.n_frames`, 1),
        path: checkRelPath(to.path, `${tw}.path`),
      };
      if (tile.index !== j || tile.start_frame !== expect) fail(tw, "tiles must be contiguous");
      expect += tile.n_frames;
      return tile;
    });
    if (expect !== n_frames) fail(w, `tiles cover ${expect} != n_frames`);
    return { level, hop_factor, n_frames, tiles };
  });
}

function parseSeries(v: unknown, where: string): Series[] {
  return arr(v, where).map((s, i) => {
    const w = `${where}[${i}]`;
    const o = obj(s, w, ["name", "unit", "path", "shape", "hop_seconds"], [
      "description", "dtype", "t0_seconds", "row_labels",
    ]);
    if (o.dtype !== undefined && o.dtype !== "f32le") fail(w, "dtype must be f32le");
    const hop = num(o.hop_seconds, `${w}.hop_seconds`);
    if (hop <= 0) fail(w, "hop_seconds must be > 0");
    return {
      name: str(o.name, `${w}.name`),
      unit: str(o.unit, `${w}.unit`),
      description: o.description === undefined ? "" : str(o.description, `${w}.description`),
      path: checkRelPath(o.path, `${w}.path`),
      shape: arr(o.shape, `${w}.shape`).map((x, j) => int(x, `${w}.shape[${j}]`)),
      dtype: "f32le",
      t0_seconds: o.t0_seconds === undefined ? 0 : num(o.t0_seconds, `${w}.t0_seconds`),
      hop_seconds: hop,
      row_labels:
        o.row_labels == null
          ? null
          : arr(o.row_labels, `${w}.row_labels`).map((x, j) => str(x, `${w}.row_labels[${j}]`)),
    };
  });
}

const REQUIRED = [
  "schema_version", "created_by", "created_at", "sr", "hop", "n_samples", "duration_seconds",
  "bins_per_octave", "n_bins", "n_frames", "db_min", "db_max", "tile_frames", "lods",
  "audio_path", "audio_sha256", "cqt", "source",
];
const OPTIONAL = [
  "fmin_midi", "db_reference", "lod_reduce", "tile_layout", "tile_encoding", "offsets", "stems", "dominant",
  "features", "tables", "score",
];

const intOrNull = (v: unknown, w: string): number | null => (v == null ? null : int(v, w, -1e9));
const strList = (v: unknown, w: string): string[] => arr(v, w).map((x, i) => str(x, `${w}[${i}]`));
function oneOf<T extends string>(v: unknown, w: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) fail(w, `must be one of ${allowed.join("|")}`);
  return v as T;
}

function parseScorePart(p: unknown, i: number, w0: string): ScorePart {
  const w = `${w0}.parts[${i}]`;
  const o = obj(p, w, ["index", "id", "name", "instrument"], [
    "abbreviation", "staves", "transpose_chromatic", "transpose_octave", "stem_id",
    "stem_match", "range_id", "range_low", "range_high", "practical_low", "practical_high",
    "latency_sec", "snapped",
  ]);
  const index = int(o.index, `${w}.index`);
  if (index !== i) fail(w, "part indices must be 0..n-1 in order");
  return {
    index,
    id: str(o.id, `${w}.id`),
    name: str(o.name, `${w}.name`),
    instrument: str(o.instrument, `${w}.instrument`),
    abbreviation: o.abbreviation === undefined ? "" : str(o.abbreviation, `${w}.abbreviation`),
    staves: o.staves === undefined ? 1 : int(o.staves, `${w}.staves`, 1),
    transpose_chromatic: intOrNull(o.transpose_chromatic, w) ?? 0,
    transpose_octave: intOrNull(o.transpose_octave, w) ?? 0,
    stem_id: o.stem_id == null ? null : str(o.stem_id, `${w}.stem_id`),
    stem_match: o.stem_match === undefined ? "none"
      : oneOf(o.stem_match, `${w}.stem_match`, ["name", "fuzzy", "order", "none"] as const),
    range_id: o.range_id == null ? null : str(o.range_id, `${w}.range_id`),
    range_low: intOrNull(o.range_low, w),
    range_high: intOrNull(o.range_high, w),
    practical_low: intOrNull(o.practical_low, w),
    practical_high: intOrNull(o.practical_high, w),
    latency_sec: o.latency_sec == null ? null : num(o.latency_sec, `${w}.latency_sec`),
    snapped: o.snapped == null ? null : num(o.snapped, `${w}.snapped`),
  };
}

function parseScoreMeasure(v: unknown, i: number, w0: string): ScoreMeasure {
  const w = `${w0}.measures[${i}]`;
  const o = obj(v, w, ["play_index", "number", "start_s", "end_s", "beats", "beat_type"],
    ["pass_no", "source_index"]);
  const play_index = int(o.play_index, `${w}.play_index`);
  if (play_index !== i) fail(w, "measures must be in playback order");
  return {
    play_index,
    number: str(o.number, `${w}.number`),
    start_s: num(o.start_s, `${w}.start_s`),
    end_s: num(o.end_s, `${w}.end_s`),
    beats: int(o.beats, `${w}.beats`),
    beat_type: int(o.beat_type, `${w}.beat_type`),
    pass_no: o.pass_no === undefined ? 1 : int(o.pass_no, `${w}.pass_no`, 1),
    source_index: o.source_index == null ? null : int(o.source_index, `${w}.source_index`),
  };
}

function parseScore(v: unknown): ScoreInfo {
  const w = "manifest.score";
  const o = obj(v, w, ["kind", "source_files", "parts", "measures", "notes", "alignment"],
    ["score_file", "reductions"]);
  const no = obj(o.notes, `${w}.notes`, ["path", "n", "columns"], ["dtype", "layout"]);
  const columns = strList(no.columns, `${w}.notes.columns`);
  if (columns.join(",") !== NOTE_COLUMNS.join(",")) {
    fail(`${w}.notes.columns`, `must be ${NOTE_COLUMNS.join(",")}`);
  }
  if (no.dtype !== undefined && no.dtype !== "f32le") fail(`${w}.notes.dtype`, "must be f32le");
  if (no.layout !== undefined && no.layout !== "column_major") fail(`${w}.notes.layout`, "must be column_major");
  const aw = `${w}.alignment`;
  const ao = obj(o.alignment, aw, ["method", "offset_sec", "preroll_sec", "confidence", "time_source"],
    ["pitch_agreement", "pitch_shift_mode", "warnings", "warp", "snapped"]);
  return {
    kind: oneOf(o.kind, `${w}.kind`, ["musicxml", "midi"] as const),
    source_files: strList(o.source_files, `${w}.source_files`),
    parts: arr(o.parts, `${w}.parts`).map((p, i) => parseScorePart(p, i, w)),
    measures: arr(o.measures, `${w}.measures`).map((mv, i) => parseScoreMeasure(mv, i, w)),
    notes: {
      path: checkRelPath(no.path, `${w}.notes.path`),
      n: int(no.n, `${w}.notes.n`),
      columns,
      dtype: "f32le",
      layout: "column_major",
    },
    score_file: o.score_file == null ? null : checkRelPath(o.score_file, `${w}.score_file`),
    reductions: o.reductions == null ? [] : arr(o.reductions, `${w}.reductions`).map((rv, i) => {
      const rw = `${w}.reductions[${i}]`;
      const r = obj(rv, rw, ["mode", "musicxml", "map"], []);
      return {
        mode: oneOf(r.mode, `${rw}.mode`, ["chords", "section-chords", "tutti", "sections"] as const),
        musicxml: checkRelPath(r.musicxml, `${rw}.musicxml`),
        map: checkRelPath(r.map, `${rw}.map`),
      };
    }),
    alignment: {
      method: oneOf(ao.method, `${aw}.method`, ["warp", "xcorr", "manual", "preroll_only"] as const),
      offset_sec: num(ao.offset_sec, `${aw}.offset_sec`),
      preroll_sec: num(ao.preroll_sec, `${aw}.preroll_sec`),
      confidence: num(ao.confidence, `${aw}.confidence`),
      time_source: oneOf(ao.time_source, `${aw}.time_source`, ["midi", "score_tempo"] as const),
      pitch_agreement: ao.pitch_agreement == null ? null : num(ao.pitch_agreement, `${aw}.pitch_agreement`),
      pitch_shift_mode: intOrNull(ao.pitch_shift_mode, aw),
      warnings: ao.warnings === undefined ? [] : strList(ao.warnings, `${aw}.warnings`),
      warp: ao.warp === undefined ? [] : arr(ao.warp, `${aw}.warp`).map((pt, i): [number, number] => {
        const a = arr(pt, `${aw}.warp[${i}]`);
        if (a.length !== 2) fail(`${aw}.warp[${i}]`, "expected [score_s, audio_s]");
        return [num(a[0], `${aw}.warp[${i}][0]`), num(a[1], `${aw}.warp[${i}][1]`)];
      }),
      snapped: ao.snapped == null ? null : num(ao.snapped, `${aw}.snapped`),
    },
  };
}

export function parseManifest(json: unknown): Manifest {
  const o = obj(json, "manifest", REQUIRED, OPTIONAL);
  if (!(SUPPORTED_VERSIONS as readonly unknown[]).includes(o.schema_version)) {
    fail("manifest.schema_version", `unsupported version ${String(o.schema_version)}`);
  }
  const lit = <T extends string>(k: string, val: T): T => {
    if (o[k] !== undefined && o[k] !== val) fail(`manifest.${k}`, `must be '${val}'`);
    return val;
  };
  const cq = obj(o.cqt, "manifest.cqt", ["backend", "k"], [
    "filter_scale", "window", "tuning", "frame_convention",
  ]);
  const src = obj(o.source, "manifest.source", ["kind", "name"], ["renderer", "render_config"]);
  if (src.kind !== "wav" && src.kind !== "session") fail("manifest.source.kind", "wav|session");
  const off = o.offsets === undefined ? {} : obj(o.offsets, "manifest.offsets", [], ["preroll_sec"]);

  const m: Manifest = {
    schema_version: o.schema_version as 1 | 2 | 3 | 4 | 5,
    created_by: str(o.created_by, "manifest.created_by"),
    created_at: str(o.created_at, "manifest.created_at"),
    sr: int(o.sr, "manifest.sr", 1),
    hop: int(o.hop, "manifest.hop", 1),
    n_samples: int(o.n_samples, "manifest.n_samples", 1),
    duration_seconds: num(o.duration_seconds, "manifest.duration_seconds"),
    fmin_midi: o.fmin_midi === undefined ? 21 : num(o.fmin_midi, "manifest.fmin_midi"),
    bins_per_octave: int(o.bins_per_octave, "manifest.bins_per_octave", 12),
    n_bins: int(o.n_bins, "manifest.n_bins", 1),
    n_frames: int(o.n_frames, "manifest.n_frames", 1),
    db_min: num(o.db_min, "manifest.db_min"),
    db_max: num(o.db_max, "manifest.db_max"),
    db_reference: lit("db_reference", "full_scale_sine_per_bin"),
    lod_reduce: lit("lod_reduce", "max"),
    tile_frames: int(o.tile_frames, "manifest.tile_frames", 1),
    tile_layout: lit("tile_layout", "frame_major_u8"),
    tile_encoding: o.tile_encoding === undefined ? "raw"
      : oneOf(o.tile_encoding, "manifest.tile_encoding", ["raw", "gzip"] as const),
    lods: parseLods(o.lods, "manifest.lods"),
    audio_path: checkRelPath(o.audio_path, "manifest.audio_path"),
    audio_sha256: str(o.audio_sha256, "manifest.audio_sha256"),
    cqt: {
      backend: str(cq.backend, "manifest.cqt.backend"),
      k: int(cq.k, "manifest.cqt.k", 1),
      filter_scale: cq.filter_scale === undefined ? 1 : num(cq.filter_scale, "cqt.filter_scale"),
      window: cq.window === undefined ? "hann" : str(cq.window, "cqt.window"),
      tuning: cq.tuning === undefined ? 0 : num(cq.tuning, "cqt.tuning"),
      frame_convention: "centered",
    },
    offsets: { preroll_sec: off.preroll_sec === undefined ? 0 : num(off.preroll_sec, "offsets") },
    source: {
      kind: src.kind,
      name: str(src.name, "manifest.source.name"),
      renderer: src.renderer == null ? null : str(src.renderer, "manifest.source.renderer"),
      render_config: (src.render_config ?? null) as Record<string, unknown> | null,
    },
    stems:
      o.stems === undefined
        ? []
        : arr(o.stems, "manifest.stems").map((s, i) => {
            const w = `manifest.stems[${i}]`;
            const so = obj(s, w, ["id", "index", "name", "source_file", "lods"]);
            const id = str(so.id, `${w}.id`);
            if (!/^[A-Za-z0-9_.-]+$/.test(id)) fail(`${w}.id`, "invalid characters");
            const index = int(so.index, `${w}.index`);
            if (index !== i || index >= 255) fail(`${w}.index`, "must equal position (< 255)");
            return {
              id,
              index,
              name: str(so.name, `${w}.name`),
              source_file: str(so.source_file, `${w}.source_file`),
              lods: parseLods(so.lods, `${w}.lods`),
            };
          }),
    dominant:
      o.dominant == null
        ? null
        : (() => {
            const d = obj(o.dominant, "manifest.dominant", ["floor_db", "lods"], ["none_value"]);
            return {
              none_value: d.none_value === undefined ? 255 : int(d.none_value, "dominant.none"),
              floor_db: num(d.floor_db, "manifest.dominant.floor_db"),
              lods: parseLods(d.lods, "manifest.dominant.lods"),
            };
          })(),
    features: o.features === undefined ? [] : parseSeries(o.features, "manifest.features"),
    tables: o.tables === undefined ? [] : parseSeries(o.tables, "manifest.tables"),
    score: o.score == null ? null : parseScore(o.score),
  };
  if (m.score && m.schema_version < 2) fail("manifest.score", "requires schema_version 2");
  if (m.score?.reductions.length && m.schema_version < 5) fail("manifest.score.reductions", "requires schema_version 5");
  if (m.tile_encoding !== "raw" && m.schema_version < 4) {
    fail("manifest.tile_encoding", "requires schema_version 4");
  }
  if (m.score) {
    const ids = new Set(m.stems.map((st) => st.id));
    for (const p of m.score.parts) {
      if (p.stem_id !== null && !ids.has(p.stem_id)) {
        fail("manifest.score", `part ${p.name} refers to unknown stem ${p.stem_id}`);
      }
    }
  }

  if (m.bins_per_octave % 12 !== 0) fail("manifest", "bins_per_octave must be a multiple of 12");
  if (m.db_max <= m.db_min) fail("manifest", "db_max must exceed db_min");
  if (m.n_frames !== 1 + Math.floor(m.n_samples / m.hop)) {
    fail("manifest", "n_frames must equal 1 + n_samples // hop (centered frames)");
  }
  if (!/^[0-9a-f]{64}$/.test(m.audio_sha256)) fail("manifest.audio_sha256", "expected sha256 hex");
  const all: [string, Lod[]][] = [["mix", m.lods], ...m.stems.map((s): [string, Lod[]] => [`stem ${s.id}`, s.lods])];
  if (m.dominant) all.push(["dominant", m.dominant.lods]);
  for (const [name, lods] of all) {
    const l0 = lods[0];
    if (!l0 || l0.level !== 0 || l0.n_frames !== m.n_frames) fail(name, "level 0 must span n_frames");
    for (let i = 1; i < lods.length; i++) {
      const prev = lods[i - 1]!, cur = lods[i]!;
      if (cur.level !== prev.level + 1 || cur.n_frames !== Math.ceil(prev.n_frames / 2)) {
        fail(name, `level ${cur.level} frame count wrong`);
      }
    }
    for (const lod of lods) {
      if (lod.tiles.some((t) => t.n_frames > m.tile_frames)) fail(name, "tile larger than tile_frames");
    }
  }
  if (new Set(m.stems.map((s) => s.id)).size !== m.stems.length) fail("manifest", "duplicate stem ids");
  return m;
}

// ---- helpers shared by the viewer -------------------------------------------------

export const k = (m: Manifest): number => m.bins_per_octave / 12;
export const binToMidi = (m: Manifest, b: number): number => m.fmin_midi + b / k(m);
export const midiToBin = (m: Manifest, midi: number): number => (midi - m.fmin_midi) * k(m);
export const frameToSeconds = (m: Manifest, f: number, level = 0): number =>
  (f * m.hop * 2 ** level) / m.sr;
export const secondsToFrame = (m: Manifest, t: number, level = 0): number =>
  (t * m.sr) / (m.hop * 2 ** level);
export const u8ToDb = (m: Manifest, v: number): number =>
  m.db_min + (v * (m.db_max - m.db_min)) / 255;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function midiName(midi: number): string {
  const n = Math.round(midi);
  return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Joins a bundle-relative path onto a base URL (which must end with '/'). */
export function bundleUrl(base: string, rel: string): string {
  return base + checkRelPath(rel, "path").split("/").map(encodeURIComponent).join("/");
}

export async function loadManifest(base: string): Promise<Manifest> {
  const r = await fetchSameOrigin(bundleUrl(base, "manifest.json"));
  if (!r.ok) throw new BundleError(`manifest.json: HTTP ${r.status}`);
  return parseManifest(await r.json());
}

/** Response body -> bytes through the browser's native gzip decoder (no JS inflate). */
export async function gunzip(r: Response): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array(0);
  const out = r.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function loadTile(base: string, m: Manifest, tile: Tile): Promise<Uint8Array> {
  const r = await fetchSameOrigin(bundleUrl(base, tile.path));
  if (!r.ok) throw new BundleError(`${tile.path}: HTTP ${r.status}`);
  const buf = m.tile_encoding === "gzip" ? await gunzip(r) : new Uint8Array(await r.arrayBuffer());
  if (buf.length !== tile.n_frames * m.n_bins) {
    throw new BundleError(`${tile.path}: ${buf.length} bytes, expected ${tile.n_frames * m.n_bins}`);
  }
  return buf;
}

export async function loadSeries(base: string, s: Series): Promise<Float32Array> {
  const r = await fetchSameOrigin(bundleUrl(base, s.path));
  if (!r.ok) throw new BundleError(`${s.path}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  const n = s.shape.reduce((a, b) => a * b, 1);
  if (buf.byteLength !== n * 4) throw new BundleError(`${s.path}: wrong size`);
  // f32le: every supported platform (x86, ARM) is little-endian, so view directly.
  return new Float32Array(buf);
}

export type NotesTable = Record<NoteColumn, Float32Array> & { n: number };

/** Column-major f32le notes table -> one Float32Array view per column. */
export function notesFromBuffer(buf: ArrayBuffer, n: number): NotesTable {
  if (buf.byteLength !== NOTE_COLUMNS.length * n * 4) {
    throw new BundleError(`notes table: ${buf.byteLength} bytes, expected ${NOTE_COLUMNS.length * n * 4}`);
  }
  const out = { n } as NotesTable;
  NOTE_COLUMNS.forEach((c, i) => {
    out[c] = new Float32Array(buf, i * n * 4, n);
  });
  return out;
}

export async function loadNotes(base: string, m: Manifest): Promise<NotesTable | null> {
  if (!m.score) return null;
  const r = await fetchSameOrigin(bundleUrl(base, m.score.notes.path));
  if (!r.ok) throw new BundleError(`${m.score.notes.path}: HTTP ${r.status}`);
  return notesFromBuffer(await r.arrayBuffer(), m.score.notes.n);
}
