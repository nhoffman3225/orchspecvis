// orchspec viewer: 3D CQT surface + linked 2D pane + LUFS strip, synced to Web Audio.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadManifest, loadNotes, loadSeries, midiName } from "./bundle";
import { NoteIndex, applyMask, frameSeconds, measureAt, overtones, rasterizeF0, rasterizeNotes } from "./notes";
import { heatFromNotes, heatFromPage, keyLevelsAt, normalizeHeat } from "./heat";
import { PianoView, notesFromF0 } from "./piano";
import { ScoreView } from "./scoreview";
import { HARM_PRESETS, harmSliderValue, snapHarm } from "./presets";
import { frameGaps, frameSpans } from "./gaps";
import { COLORMAPS, colormapLut, cssColor, stemPalette } from "./colormap";
import { fetchSameOrigin, initToken } from "./net";
import { LufsStrip, Pane2D } from "./pane2d";
import { Player } from "./player";
import { GRID_COLS, SURFACE_STYLES, Surface, colsPerBin, type SurfaceStyle } from "./surface";
import { chooseLevel, lodsFor, type TrackId } from "./tiles";
import { PagesClient } from "./pagesclient";
import { FAMILIES, FAMILY_COLORS, KEYS, combineGroups, familyOf, notesGrid, registerLevel, registerStats,
  type Family } from "./registers";
import { RegisterView, type RegisterGroup } from "./registerview";

type Mode = "mix" | "ensemble" | "stems" | "dominant";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $("status");

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}

async function main(): Promise<void> {
  initToken(location.search);
  const params = new URLSearchParams(location.search);
  let base = params.get("bundle") ?? (import.meta.env.DEV ? "./tiny-bundle/" : "./bundle/");
  if (!base.endsWith("/")) base += "/";
  const m = await loadManifest(base);
  const pagesWorker = new PagesClient(base, m); // tile fetch/assembly, stem sums, smoothing
  $("title").textContent = `${m.source.name} · ${m.stems.length} stems · k=${m.cqt.k} · ${m.cqt.backend}`;

  // ---- renderer (the one and only WebGL context)
  const canvas = $<HTMLCanvasElement>("gl");
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) throw new Error("WebGL2 is not available in this browser/GPU");
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x0e0f13);
  const maxTex = renderer.capabilities.maxTextureSize;
  const pageFrames = Math.min(4096, maxTex);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
  camera.position.set(-0.3, 1.25, 1.9);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.1, 0);
  controls.enableDamping = true;

  const surface = new Surface(m.n_bins, pageFrames, m.cqt.k);
  scene.add(surface.group);

  const pane = new Pane2D($<HTMLCanvasElement>("cqt2d"), m, $("tip"));
  const pr = /^(\d+)-(\d+)$/.exec(params.get("pitch") ?? ""); // ?pitch=36-84 (MIDI range)
  if (pr) {
    const kk = m.bins_per_octave / 12;
    pane.setPitchRange((Number(pr[1]) - m.fmin_midi) * kk, (Number(pr[2]) + 1 - m.fmin_midi) * kk);
  }
  const strip = new LufsStrip($<HTMLCanvasElement>("lufs"), m.duration_seconds);
  const lufs = m.features.find((f) => f.name === "lufs_short_term");
  if (lufs) strip.setData(await loadSeries(base, lufs), lufs.hop_seconds);

  // ---- score (Phase 2): notes, parts, measures; or per-stem f0 tracks without a score
  const notes = await loadNotes(base, m);
  const nix = notes ? new NoteIndex(notes) : null;
  const f0Series = m.tables.find((t) => t.name === "f0_hz");
  const f0Data = f0Series ? await loadSeries(base, f0Series) : null;
  const parts = m.score?.parts ?? [];

  const player = new Player(m.duration_seconds, m.sr);
  void player.load(base, m.audio_path).then(() => {
    document.documentElement.dataset.audio = player.mode; // stream | decoded | none (tests)
    const syncState = (): void => void (document.documentElement.dataset.audioState = player.ctx.state);
    // read-only probe for tests: the audio clock, live (datasets update only per frame)
    (globalThis as { orchspecAudioTime?: () => number }).orchspecAudioTime = () => player.ctx.currentTime;
    (globalThis as { orchspecStream?: () => string }).orchspecStream = () =>
      `${player.streamState}; ctx ${player.ctx.sampleRate} Hz ${player.ctx.state}; ${player.audioError ?? ""}`;
    player.ctx.addEventListener("statechange", syncState);
    syncState();
    if (player.audioError) status.textContent = `audio unavailable (${player.audioError}); playhead runs silently`;
  });

  // ---- UI state
  const ui = {
    mode: (["mix", "ensemble", "stems", "dominant"].includes(params.get("mode") ?? "") && m.stems.length
      ? params.get("mode") : "mix") as Mode,
    cmap: "magma",
    selected: new Set(m.stems.map((s) => s.id)),
    winSeconds: Math.min(20, m.duration_seconds),
    winStart0: 0, // level-0 frames
    follow: true,
  };
  let lut = colormapLut(ui.cmap);
  const palette = (): Uint8Array =>
    stemPalette(m.stems.length, (i) => ui.selected.has(m.stems[i]!.id));
  surface.setColormap(lut);
  surface.setPalette(palette());

  // part colors: a matched part shares its stem's color; others get further palette entries
  const partPal = stemPalette(m.stems.length + parts.length);
  const partColorIndex = parts.map((p, j) => {
    const si = p.stem_id === null ? -1 : m.stems.findIndex((s) => s.id === p.stem_id);
    return si >= 0 ? si : m.stems.length + j;
  });
  const partLut = new Uint8Array(256 * 4);
  partColorIndex.forEach((ci, part) => partLut.set(partPal.subarray(ci * 4, ci * 4 + 4), (part + 1) * 4));
  surface.setPartPalette(partLut);
  const partColor = (part: number): string => cssColor(partPal, partColorIndex[part] ?? 0);
  const partsVisible = new Set(parts.map((p) => p.index));

  const secToF0 = (t: number): number => (t * m.sr) / m.hop;
  const nLevels = m.lods.length;

  // window choices
  const winSel = $<HTMLSelectElement>("window");
  for (const s of [2, 5, 10, 20, 45, 90, 180, 600]) {
    if (s < m.duration_seconds) winSel.add(new Option(`${s} s`, String(s)));
  }
  winSel.add(new Option("all", String(m.duration_seconds)));
  winSel.value = [...winSel.options].some((o) => o.value === String(ui.winSeconds))
    ? String(ui.winSeconds) : String(m.duration_seconds);
  ui.winSeconds = Number(winSel.value);
  const wParam = params.get("window");
  if (wParam && [...winSel.options].some((o) => o.value === wParam)) {
    winSel.value = wParam;
    ui.winSeconds = Number(wParam);
  }

  const cmapSel = $<HTMLSelectElement>("cmap");
  for (const c of COLORMAPS) cmapSel.add(new Option(c, c));
  cmapSel.value = ui.cmap;

  const modeSel = $<HTMLSelectElement>("mode");
  modeSel.value = ui.mode;
  if (!m.stems.length) {
    for (const o of [...modeSel.options]) if (o.value !== "mix") o.disabled = true;
  } else {
    $("stems").hidden = false;
  }

  // ---- stems list
  const list = $("stem-list");
  const pal0 = stemPalette(m.stems.length);
  m.stems.forEach((s, i) => {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.id = s.id;
    cb.addEventListener("change", () => {
      if (cb.checked) ui.selected.add(s.id);
      else ui.selected.delete(s.id);
      if (ui.mode === "mix") modeSel.value = ui.mode = "stems";
      invalidate();
    });
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = cssColor(pal0, i);
    const name = document.createElement("span");
    name.textContent = s.name;
    name.title = s.source_file;
    li.append(cb, sw, name);
    list.append(li);
  });
  const setAll = (on: boolean): void => {
    for (const cb of list.querySelectorAll<HTMLInputElement>("input")) cb.checked = on;
    ui.selected = new Set(on ? m.stems.map((s) => s.id) : []);
    if (ui.mode === "mix") modeSel.value = ui.mode = "stems";
    invalidate();
  };
  $("stems-all").addEventListener("click", () => setAll(true));
  $("stems-none").addEventListener("click", () => setAll(false));

  // ---- parts list
  let scoreStatus = "";
  const notesBox = $<HTMLInputElement>("notes");
  const fundBox = $<HTMLInputElement>("fund");
  const fundW = $<HTMLSelectElement>("fundw");
  if (params.get("notes") === "0") notesBox.checked = false;
  if (params.get("fund") === "1") fundBox.checked = true;
  if (params.get("fundw")) fundW.value = params.get("fundw")!;
  if (!nix) notesBox.disabled = true;
  if (!nix && !f0Data) fundBox.disabled = true;
  let focus: number | null = parts.find((p) => p.range_low !== null)?.index ?? null;
  if (parts.length) {
    $("stems").hidden = false;
    $("parts-sec").hidden = false;
    const plist = $("part-list");
    const renderFocus = (): void => {
      plist.querySelectorAll("li").forEach((li, i) => li.classList.toggle("focus", i === focus));
    };
    parts.forEach((p) => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        if (cb.checked) partsVisible.add(p.index);
        else partsVisible.delete(p.index);
        void rebuildDisplay();
      });
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = partColor(p.index);
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.name;
      name.title = `${p.instrument}${p.stem_id ? ` · stem ${p.stem_id} (${p.stem_match})` : " · no stem"}`;
      name.addEventListener("click", () => {
        focus = focus === p.index ? null : p.index;
        renderFocus();
        if (pane.score) pane.score.focus = focus;
      });
      const rng = document.createElement("span");
      rng.className = "rng";
      rng.textContent = p.range_low !== null && p.range_high !== null
        ? `${midiName(p.range_low)}–${midiName(p.range_high)}` : "";
      li.append(cb, sw, name, rng);
      plist.append(li);
    });
    renderFocus();
    const setAllParts = (on: boolean): void => {
      plist.querySelectorAll<HTMLInputElement>("input").forEach((cb) => (cb.checked = on));
      partsVisible.clear();
      if (on) parts.forEach((p) => partsVisible.add(p.index));
      void rebuildDisplay();
    };
    $("parts-all").addEventListener("click", () => setAllParts(true));
    $("parts-none").addEventListener("click", () => setAllParts(false));
  }
  // run once everything below is set up (URL-driven initial selections)
  const afterSetup: (() => void)[] = [];

  // ---- sections: quick selection by family (from part and stem names)
  {
    const secBox = $("sections");
    const stemFam = m.stems.map((s) => familyOf(s.name));
    const partFam = parts.map((p) => familyOf(p.instrument || p.name));
    const present = FAMILIES.filter((f) => stemFam.includes(f) || partFam.includes(f));
    const active = new Set<Family>();
    const apply = (): void => {
      const all = active.size === 0;
      ui.selected = new Set(m.stems.filter((_, i) => all || active.has(stemFam[i]!)).map((s) => s.id));
      list.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
        cb.checked = ui.selected.has(cb.dataset.id ?? "");
      });
      if (!all && (ui.mode === "mix" || ui.mode === "ensemble")) modeSel.value = ui.mode = "stems";
      partsVisible.clear();
      parts.forEach((p, i) => {
        if (all || active.has(partFam[i]!)) partsVisible.add(p.index);
      });
      $("part-list").querySelectorAll<HTMLInputElement>("input").forEach((cb, i) => {
        cb.checked = partsVisible.has(parts[i]?.index ?? -1);
      });
      secBox.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
        b.classList.toggle("on", active.has(b.dataset.fam as Family));
      });
      invalidate();
      void rebuildDisplay();
    };
    for (const f of present) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.fam = f;
      b.style.setProperty("--fam", FAMILY_COLORS[f]);
      b.textContent = f;
      b.addEventListener("click", (e) => {
        if (e.ctrlKey || e.shiftKey || e.metaKey) {
          if (active.has(f)) active.delete(f);
          else active.add(f);
        } else if (active.size === 1 && active.has(f)) {
          active.clear(); // clicking the only active section again shows everything
        } else {
          active.clear();
          active.add(f);
        }
        apply();
      });
      secBox.append(b);
    }
    secBox.hidden = present.length < 2;
    for (const f of (params.get("sec") ?? "").split(",")) {
      if (present.includes(f as Family)) active.add(f as Family);
    }
    if (active.size) afterSetup.push(apply);
  }

  if (notes && nix && m.score) {
    pane.score = {
      notes, index: nix, parts, measures: m.score.measures, partColor,
      visible: (p) => partsVisible.has(p), focus, showNotes: notesBox.checked,
    };
    const a = m.score.alignment;
    const warn = a.warnings.length ? ` · ⚠ ${a.warnings.join("; ")}` : "";
    scoreStatus = `score: ${parts.length} parts, ${notes.n} notes · offset ${a.offset_sec.toFixed(3)} s (${a.method}, confidence ${a.confidence.toFixed(2)})${warn} · `;
  }
  notesBox.addEventListener("change", () => {
    if (pane.score) pane.score.showNotes = notesBox.checked;
    void rebuildDisplay();
  });
  fundBox.addEventListener("change", () => void rebuildDisplay());
  fundW.addEventListener("change", () => void rebuildDisplay());
  // overtones back in when loud enough (only meaningful with fundamentals on)
  // slider: 0 = off, 1 = 0 dB, 2 = -1 dB, ... 97 = -96 dB (right lets quieter harmonics in)
  const MAX_HARMONIC = 16;
  const harm = $<HTMLInputElement>("harm");
  if (params.get("harm") !== null && Number.isFinite(Number(params.get("harm")))) {
    harm.value = String(Math.min(97, Math.max(1, 1 - Math.round(Number(params.get("harm"))))));
  }
  const harmDb = (): number | null => (Number(harm.value) === 0 ? null : 1 - Number(harm.value));
  // preset stops: tick marks on the slider, a snap when dragging near one, and a menu
  const presetSel = $<HTMLSelectElement>("harmpreset");
  const ticks = $("harmticks");
  for (const p of HARM_PRESETS) {
    const v = harmSliderValue(p);
    ticks.append(new Option("", String(v)));
    presetSel.add(new Option(p === null ? "off" : `${p} dB`, String(v)));
  }
  presetSel.addEventListener("change", () => {
    if (presetSel.value === "") return;
    harm.value = presetSel.value;
    presetSel.value = "";
    syncHarm();
    void rebuildDisplay();
  });
  const syncHarm = (): void => {
    harm.disabled = !fundBox.checked || fundBox.disabled;
    const hd = harmDb();
    $("harmval").textContent = hd === null ? "off" : `${hd === 0 ? "0" : hd} dB`;
  };
  harm.addEventListener("input", () => {
    harm.value = String(snapHarm(Number(harm.value)));
    syncHarm();
    void rebuildDisplay();
  });
  fundBox.addEventListener("change", syncHarm);
  syncHarm();
  // keyboard heat map
  const heatSel = $<HTMLSelectElement>("heat");
  const tau = $<HTMLInputElement>("tau");
  if (params.get("heat")) heatSel.value = params.get("heat")!;
  if (params.get("tau")) tau.value = params.get("tau")!;
  if (!nix) (heatSel.querySelector('option[value="notes"]') as HTMLOptionElement).disabled = true;
  if (heatSel.value === "notes" && !nix) heatSel.value = "sound";
  const syncTau = (): void => {
    $("tauval").textContent = `${Number(tau.value).toFixed(1)} s`;
  };
  tau.addEventListener("input", syncTau);
  syncTau();

  // ---- paging: assemble a page of `pageFrames` frames at the chosen level
  let page = { level: -1, start: 0, key: "", ready: false };
  let pageGen = 0;
  let dirty = true;
  function invalidate(): void {
    dirty = true;
  }

  function heightTracks(): TrackId[] {
    if (ui.mode === "ensemble") return m.stems.map((s) => `stem:${s.id}` as TrackId);
    if (ui.mode === "stems") return m.stems.filter((s) => ui.selected.has(s.id)).map((s) => `stem:${s.id}` as TrackId);
    return ["mix"];
  }

  async function loadPage(level: number, start: number): Promise<void> {
    const gen = ++pageGen;
    const tracks = heightTracks();
    const { height, dom } = await pagesWorker.page(
      tracks.map((t) => lodsFor(m, t)[level]!),
      ui.mode === "dominant" && m.dominant ? m.dominant.lods[level]! : null,
      start,
      pageFrames,
    );
    if (gen !== pageGen) return; // superseded
    raw = { height, dom, start, level, winFrames: secToF0(ui.winSeconds) / 2 ** level };
    await rebuildDisplay();
    if (gen !== pageGen) return;
    surface.setMode(ui.mode === "dominant" ? "dominant" : "db");
    const pal = palette();
    surface.setPalette(pal);
    page = { level, start, key: pageKey(), ready: true };
    document.documentElement.dataset.page = `${ui.mode}:${level}:${start}`; // tests
  }

  // ---- spectral gaps of whatever is displayed (mix, full ensemble, or selected stems)
  type ShownPage = { height: Uint8Array; dom: Uint8Array | null; start: number; level: number };
  let last: ShownPage | null = null;
  // the unsmoothed page as loaded; `last` is what is displayed (optionally smoothed)
  let raw: (ShownPage & { winFrames: number }) | null = null;
  const smooth = $<HTMLInputElement>("smooth");
  const pSmooth = params.get("smooth");
  if (pSmooth !== null && Number.isFinite(Number(pSmooth))) smooth.value = pSmooth;
  let displayGen = 0;
  async function rebuildDisplay(): Promise<void> {
    if (!raw) return;
    const gen = ++displayGen;
    const r = raw;
    const semis = Number(smooth.value);
    $("smoothval").textContent = semis > 0 ? `${semis} st` : "off";
    // sigma = half the chosen width; time sigma covers the same world distance as pitch
    const sigmaB = (semis * (m.bins_per_octave / 12)) / 2;
    const sigmaF = sigmaB * colsPerBin(m.n_bins) * (raw.winFrames / GRID_COLS);
    const k = m.bins_per_octave / 12;
    const ft = frameSeconds(m, raw.level);
    const inPage = nix ? nix.inRange(raw.start * ft, (raw.start + pageFrames) * ft) : [];
    const visiblePart = (p: number): boolean => partsVisible.has(p);
    // fundamentals only: keep +-width around each sounding note's fundamental
    let src = raw.height;
    if (fundBox.checked && !fundBox.disabled) {
      const wBins = (Number(fundW.value) / 100) * k;
      let mask: Uint8Array | null = null;
      if (notes && nix) {
        mask = rasterizeNotes(notes, inPage, m, raw.level, raw.start, pageFrames, wBins, visiblePart);
      } else if (f0Data && f0Series) {
        const [rows, frames0] = f0Series.shape as [number, number];
        const visibleStem = (r: number): boolean => ui.selected.has(m.stems[r]?.id ?? "");
        mask = rasterizeF0(f0Data, rows, frames0, m, raw.level, raw.start, pageFrames, wBins, visibleStem);
      }
      if (mask) {
        const hdb = harmDb();
        let hmask: Uint8Array | null = null;
        if (hdb !== null) {
          const hs = overtones(MAX_HARMONIC);
          if (notes && nix) {
            hmask = rasterizeNotes(notes, inPage, m, raw.level, raw.start, pageFrames, wBins, visiblePart, hs);
          } else if (f0Data && f0Series) {
            const [rows, frames0] = f0Series.shape as [number, number];
            const visibleStem = (r: number): boolean => ui.selected.has(m.stems[r]?.id ?? "");
            hmask = rasterizeF0(f0Data, rows, frames0, m, raw.level, raw.start, pageFrames, wBins, visibleStem, hs);
          }
        }
        const thr = hdb === null ? 256 : Math.max(0, Math.round(((hdb - m.db_min) * 255) / (m.db_max - m.db_min)));
        src = applyMask(src, mask, hmask, thr);
      }
    }
    heatSrc = { data: src, level: raw.level, start: raw.start };
    const height = await pagesWorker.smooth(src, pageFrames, sigmaB, sigmaF);
    if (gen !== displayGen) return; // a newer rebuild (slider, page) superseded this one
    surface.setPage(height, r.dom, r.start);
    surface.setNotes(notes && nix && notesBox.checked
      ? rasterizeNotes(notes, inPage, m, r.level, r.start, pageFrames, k / 2, visiblePart)
      : null);
    last = { height, dom: r.dom, start: r.start, level: r.level };
    document.documentElement.dataset.smoothed = String(height !== src); // tests
    applyGaps();
  }
  // the filtered (fundamentals/harmonics) but unsmoothed page drives the "sound" heat map
  let heatSrc: { data: Uint8Array; level: number; start: number } | null = null;
  function keyHeat(t: number): Float32Array | null {
    const mode = heatSel.value;
    const tv = Number(tau.value);
    if (mode === "notes" && notes && nix) {
      return normalizeHeat(heatFromNotes(notes, nix, t, tv, (p) => partsVisible.has(p)), "notes", tv);
    }
    if (mode === "sound" && heatSrc) {
      const page = { data: heatSrc.data, nBins: m.n_bins, start: heatSrc.start, frames: pageFrames,
        frameSec: frameSeconds(m, heatSrc.level) };
      return normalizeHeat(heatFromPage(page, m.bins_per_octave / 12, m.fmin_midi, t, tv, m.db_min, m.db_max), "sound", tv);
    }
    return null;
  }
  let smoothPending = false;
  smooth.addEventListener("input", () => {
    if (smoothPending) return;
    smoothPending = true;
    requestAnimationFrame(() => {
      smoothPending = false;
      void rebuildDisplay();
    });
  });
  const gapsBox = $<HTMLInputElement>("gaps");
  const gapDb = $<HTMLInputElement>("gapdb");
  if (params.get("gaps") !== null) {
    gapsBox.checked = true;
    const g = Number(params.get("gaps"));
    if (params.get("gaps") !== "" && Number.isFinite(g)) gapDb.value = String(g);
  }
  const gapThrU8 = (): number => {
    if (!gapsBox.checked) return -1;
    const db = Number(gapDb.value);
    return Math.max(0, Math.min(255, Math.round(((db - m.db_min) * 255) / (m.db_max - m.db_min))));
  };
  function applyGaps(): void {
    $("gapval").textContent = `${gapDb.value} dB`;
    const thr = gapThrU8();
    surface.setGap(thr < 0 ? -1 : thr / 255);
    if (!last) return;
    if (thr >= 0) surface.setSpans(frameSpans(last.height, m.n_bins, pageFrames, thr));
    pane.setPage(last.height, pageFrames, last.start, last.level, lut, last.dom,
      last.dom ? palette() : null, thr);
  }
  gapsBox.addEventListener("change", applyGaps);
  gapDb.addEventListener("input", applyGaps);
  let lastGapText = "";
  function gapReadout(playSec: number): void {
    const thr = gapThrU8();
    let text = "";
    if (thr >= 0 && last) {
      const f = Math.floor(secToF0(playSec) / 2 ** last.level) - last.start;
      if (f >= 0 && f < pageFrames) {
        const row = last.height.subarray(f * m.n_bins, (f + 1) * m.n_bins);
        const g = frameGaps(row, thr, m.bins_per_octave / 12, m.fmin_midi, 2);
        text = g.length
          ? "gaps: " + g.slice(0, 3).map((x) => `${x.label} (${x.semitones.toFixed(0)} st)`).join(", ")
          : "no gaps ≥ 2 st";
      }
    }
    if (text !== lastGapText) $("gapinfo").textContent = lastGapText = text;
  }

  const pageKey = (): string => `${ui.mode}|${[...ui.selected].sort().join(",")}|${ui.cmap}`;

  function updateView(playSec: number): void {
    const winFrames0 = Math.max(8, secToF0(ui.winSeconds));
    const total0 = m.n_frames;
    if (ui.follow && player.transport.isPlaying) {
      ui.winStart0 = secToF0(playSec) - 0.25 * winFrames0;
    }
    ui.winStart0 = Math.min(Math.max(0, ui.winStart0), Math.max(0, total0 - winFrames0));
    const level = chooseLevel(winFrames0, GRID_COLS, nLevels);
    const f = 2 ** level;
    const winStart = ui.winStart0 / f, winFrames = winFrames0 / f;
    const inside = winStart >= page.start && winStart + winFrames <= page.start + pageFrames;
    if (dirty || level !== page.level || !inside || page.key !== pageKey()) {
      if (dirty || level !== page.level || page.key !== pageKey() || page.ready) {
        const margin = Math.max(0, (pageFrames - winFrames) * 0.2);
        const start = Math.max(0, Math.floor(winStart - margin));
        page = { ...page, level, start, ready: false, key: pageKey() };
        dirty = false;
        void loadPage(level, start).catch((e: unknown) => (status.textContent = `tile error: ${String(e)}`));
      }
    }
    surface.setWindow(winStart, winFrames);
    surface.setPlayhead(secToF0(playSec) / f);
    pane.setWindow(winStart, winFrames, level);
    pane.setPlayhead(secToF0(playSec) / f);
    const t0 = (ui.winStart0 * m.hop) / m.sr;
    strip.setView(t0, t0 + ui.winSeconds, playSec);
  }

  // ---- controls
  const playBtn = $<HTMLButtonElement>("play");
  const togglePlay = async (): Promise<void> => {
    await player.toggle();
  };
  playBtn.addEventListener("click", () => void togglePlay());
  const seek = (t: number): void => {
    player.seek(t);
    const winFrames0 = secToF0(ui.winSeconds);
    const f0 = secToF0(t);
    if (f0 < ui.winStart0 || f0 > ui.winStart0 + winFrames0) ui.winStart0 = f0 - 0.25 * winFrames0;
  };
  pane.onSeek = seek;
  const startAt = Number(params.get("t"));
  if (Number.isFinite(startAt) && startAt > 0) seek(startAt);
  strip.onSeek = (t) => {
    seek(t);
    ui.winStart0 = secToF0(t) - 0.5 * secToF0(ui.winSeconds);
  };
  winSel.addEventListener("change", () => {
    const center = ui.winStart0 + secToF0(ui.winSeconds) / 2;
    ui.winSeconds = Number(winSel.value);
    ui.winStart0 = center - secToF0(ui.winSeconds) / 2;
  });
  modeSel.addEventListener("change", () => {
    ui.mode = modeSel.value as Mode;
    invalidate();
  });
  cmapSel.addEventListener("change", () => {
    ui.cmap = cmapSel.value;
    lut = colormapLut(ui.cmap);
    surface.setColormap(lut);
    invalidate();
  });
  const floor = $<HTMLInputElement>("floor");
  const height = $<HTMLInputElement>("height");
  // contours every CONTOUR_DB across the displayed range (floor .. db_max)
  const CONTOUR_DB = 3;
  const applyFloor = (): void => {
    const f = Number(floor.value);
    surface.setFloor(f);
    surface.setContours(((1 - f) * (m.db_max - m.db_min)) / CONTOUR_DB);
  };
  floor.addEventListener("input", applyFloor);
  height.addEventListener("input", () => surface.setHeightScale(Number(height.value)));
  applyFloor();
  surface.setHeightScale(Number(height.value));
  const styleSel = $<HTMLSelectElement>("style");
  const pStyle = params.get("style");
  if (pStyle && (SURFACE_STYLES as readonly string[]).includes(pStyle)) styleSel.value = pStyle;
  const applyStyle = (): void => {
    surface.setStyle(styleSel.value as SurfaceStyle);
  };
  styleSel.addEventListener("change", () => {
    // terrain/fabric read best smoothed; nudge the slider up if it is still at 0
    if (styleSel.value !== "surface" && Number(smooth.value) === 0) {
      smooth.value = "3";
      void rebuildDisplay();
    }
    applyStyle();
  });
  applyStyle();
  $<HTMLInputElement>("follow").addEventListener("change", (e) => (ui.follow = (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>("grid").addEventListener("change", (e) => surface.setGrid((e.target as HTMLInputElement).checked));
  const vol = $<HTMLInputElement>("vol");
  vol.addEventListener("input", () => player.setVolume(Number(vol.value)));
  player.setVolume(Number(vol.value));
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "Space") {
      e.preventDefault();
      void togglePlay();
    } else if (e.code === "ArrowLeft") seek(player.transport.position() - (e.shiftKey ? 1 : 5));
    else if (e.code === "ArrowRight") seek(player.transport.position() + (e.shiftKey ? 1 : 5));
    else if (e.code === "Home") seek(0);
  });

  // ---- about & credits (licence texts: licenses/THIRD-PARTY.txt, same origin)
  const setAbout = (open: boolean): void => {
    $("aboutview").hidden = !open;
  };
  $("aboutbtn").addEventListener("click", () => setAbout(true));
  $("aboutclose").addEventListener("click", () => setAbout(false));
  addEventListener("keydown", (e) => {
    if (e.code === "Escape" && !$("aboutview").hidden) setAbout(false);
  });
  $("about-lic").addEventListener("click", () => {
    const pre = $("about-text");
    pre.hidden = false;
    pre.textContent = "loading…";
    void fetchSameOrigin(new URL("licenses/THIRD-PARTY.txt", location.href).href)
      .then((r) => (r.ok ? r.text() : `HTTP ${r.status}`))
      .then((t) => (pre.textContent = t))
      .catch((e: unknown) => (pre.textContent = String(e)));
  });

  // ---- register distribution view (per section / stem: whole piece + now)
  const regView = new RegisterView($<HTMLCanvasElement>("regcanvas"), (s) => seek(s));
  let regOpen = false;
  const regSrc = $<HTMLSelectElement>("reg-src");
  const regBy = $<HTMLSelectElement>("reg-by");
  const regThr = $<HTMLInputElement>("reg-thr");
  if (!notes) regSrc.querySelector<HTMLOptionElement>('option[value="notes"]')!.disabled = true;
  if (params.get("regsrc") === "notes" && notes) regSrc.value = "notes";
  if (params.get("regby") === "each") regBy.value = "each";
  let regStems: Promise<Uint8Array> | null = null; // per-stem folded grids, fetched once
  const regLevel = registerLevel(m.hop, m.sr, nLevels);
  let regGen = 0;
  const famGroups = (names: string[]): { groupOf: number[]; groups: RegisterGroup[] } => {
    const fams = names.map(familyOf);
    const present = FAMILIES.filter((f) => fams.includes(f));
    return { groupOf: fams.map((f) => present.indexOf(f)),
      groups: present.map((f: Family) => ({ label: f, color: FAMILY_COLORS[f] })) };
  };
  async function buildRegisters(): Promise<void> {
    const gen = ++regGen;
    const thrDb = Number(regThr.value);
    $("reg-thrval").textContent = `${thrDb} dB`;
    const byFamily = regBy.value === "family";
    let grid: Uint8Array, frames: number, frameSec: number, groups: RegisterGroup[], thrU8: number;
    if (regSrc.value === "notes" && notes) {
      frameSec = 0.25;
      frames = Math.ceil(m.duration_seconds / frameSec);
      const fg = famGroups(parts.map((p) => p.instrument || p.name));
      groups = byFamily ? fg.groups : parts.map((p) => ({ label: p.name, color: partColor(p.index) }));
      const groupOfPart = (p: number): number => (!partsVisible.has(p) ? -1 : byFamily ? fg.groupOf[p] ?? -1 : p);
      grid = notesGrid(notes, groupOfPart, groups.length, frames, frameSec);
      thrU8 = 0;
    } else {
      const tracks = m.stems.length ? m.stems.map((s) => s.lods) : [m.lods];
      const names = m.stems.length ? m.stems.map((s) => s.name) : ["mix"];
      regStems ??= pagesWorker.registers(tracks.map((l) => l[regLevel]!));
      const all = await regStems;
      if (gen !== regGen) return;
      frames = tracks[0]![regLevel]!.n_frames;
      frameSec = frameSeconds(m, regLevel);
      const per = names.map((_, i) => all.subarray(i * frames * KEYS, (i + 1) * frames * KEYS));
      const fg = famGroups(names);
      const pal = stemPalette(names.length);
      groups = byFamily ? fg.groups
        : names.map((n, i) => ({ label: n.replace(/^\d+_/, ""), color: cssColor(pal, i) }));
      grid = combineGroups(per, byFamily ? fg.groupOf : names.map((_, i) => i), groups.length, frames);
      thrU8 = Math.max(0, Math.min(254, Math.round(((thrDb - m.db_min) * 255) / (m.db_max - m.db_min))));
    }
    const dbPerStep = regSrc.value === "notes" ? 0 : (m.db_max - m.db_min) / 255;
    const stats = registerStats(grid, groups.length, frames, thrU8, dbPerStep);
    regView.set({ groups, grid, frames, frameSec, stats, thrU8, smoothSec: 2, duration: m.duration_seconds });
    $("reg-info").textContent = `${groups.length} groups · ${frameSec.toFixed(2)} s windows`;
    regThr.disabled = regSrc.value === "notes";
    document.documentElement.dataset.registers = `${regSrc.value}:${groups.length}`; // tests
  }
  const rebuildRegisters = (): void => {
    void buildRegisters().catch((e: unknown) => ($("reg-info").textContent = `error: ${String(e)}`));
  };
  regSrc.addEventListener("change", rebuildRegisters);
  regBy.addEventListener("change", rebuildRegisters);
  regThr.addEventListener("input", rebuildRegisters);
  function setRegisters(open: boolean): void {
    regOpen = open;
    $("regview").hidden = !open;
    if (open) {
      setPiano(false);
      setScore(false);
      rebuildRegisters();
    }
  }
  $("regbtn").addEventListener("click", () => setRegisters(true));
  $("regclose").addEventListener("click", () => setRegisters(false));
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "KeyR") setRegisters(!regOpen);
    else if (e.code === "Escape" && regOpen) setRegisters(false);
  });

  // ---- full-screen piano view (in-moment roll + keyboard + live spectrum)
  const piano = new PianoView($<HTMLCanvasElement>("piano"));
  let pianoOpen = params.get("view") === "piano";
  const pianoEl = $("pianoview");
  const lookahead = $<HTMLInputElement>("lookahead");
  if (params.get("lookahead")) lookahead.value = params.get("lookahead")!;
  const pspec = $<HTMLInputElement>("pspec");
  const keyh = $<HTMLInputElement>("keyh");
  if (params.get("keyh")) keyh.value = params.get("keyh")!;
  // wheel over the roll stretches the time axis (lookahead)
  $("piano").addEventListener("wheel", (e) => {
    e.preventDefault();
    const v = Number(lookahead.value) * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
    lookahead.value = String(Math.min(12, Math.max(1, Math.round(v * 2) / 2)));
    syncLook();
  }, { passive: false });
  // notes for the roll: the score, else notes derived from the per-stem f0 tracks
  let rollNotes = notes;
  let rollIndex = nix;
  let rollColor = partColor;
  let rollVisible = (p: number): boolean => partsVisible.has(p);
  if (!notes && f0Data && f0Series) {
    const [rows, frames0] = f0Series.shape as [number, number];
    rollNotes = notesFromF0(f0Data, rows, frames0, f0Series.hop_seconds);
    rollIndex = new NoteIndex(rollNotes);
    const stemPal = stemPalette(m.stems.length);
    rollColor = (p) => cssColor(stemPal, p);
    rollVisible = (p) => ui.selected.has(m.stems[p]?.id ?? "");
  }
  const setPiano = (open: boolean): void => {
    pianoOpen = open;
    pianoEl.hidden = !open;
    if (open && regOpen) setRegisters(false);
  };
  setPiano(pianoOpen);
  const syncLook = (): void => {
    $("lookval").textContent = `${Number(lookahead.value)} s`;
  };
  lookahead.addEventListener("input", syncLook);
  syncLook();
  $("pianobtn").addEventListener("click", () => setPiano(true));
  $("pianoclose").addEventListener("click", () => setPiano(false));
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "KeyP") setPiano(!pianoOpen);
    else if (e.code === "Escape" && pianoOpen) setPiano(false);
  });
  function drawPiano(t: number): void {
    let levels: Float32Array | null = null;
    if (pspec.checked && heatSrc) {
      levels = keyLevelsAt({ data: heatSrc.data, nBins: m.n_bins, start: heatSrc.start,
        frames: pageFrames, frameSec: frameSeconds(m, heatSrc.level) }, m.bins_per_octave / 12, m.fmin_midi, t);
    }
    piano.draw({
      t, lookahead: Number(lookahead.value), notes: rollNotes, index: rollIndex,
      parts, measures: m.score?.measures ?? [], partColor: rollColor, visible: rollVisible,
      focus: pane.score?.focus ?? null, heat: pane.heat, levels, keyScale: Number(keyh.value),
    });
    const bb = m.score ? measureAt(m.score.measures, t) : null;
    const txt = `${fmt(t)}${bb ? ` · m. ${bb.number}${bb.pass > 1 ? ` (pass ${bb.pass})` : ""} · beat ${bb.beat.toFixed(1)}` : ""}`;
    if ($("piano-time").textContent !== txt) $("piano-time").textContent = txt;
  }

  // ---- engraved score view (Verovio; loaded on first open)
  let scoreOpen = false;
  let scoreView: ScoreView | null = null;
  if (m.score?.score_file) {
    $("scorebtn").hidden = false;
    scoreView = new ScoreView($("score-host"), $("score-info"), base, m, {
      partColor,
      visible: (p) => partsVisible.has(p),
      onSeek: (s) => seek(s),
      now: () => player.transport.position(),
    });
  }
  const setScore = (open: boolean): void => {
    if (open && !scoreView) return;
    scoreOpen = open;
    $("scoreview").hidden = !open;
    if (open) {
      if (regOpen) setRegisters(false);
      setPiano(false);
      void scoreView!.load().catch((e: unknown) => {
        $("score-info").textContent = `score error: ${e instanceof Error ? e.message : String(e)}`;
      });
    }
  };
  $("scorebtn").addEventListener("click", () => setScore(true));
  $("scoreclose").addEventListener("click", () => setScore(false));
  const followBox = $<HTMLInputElement>("score-follow");
  const stepPage = (d: number): void => {
    scoreView?.step(d); // manual paging turns follow off
    followBox.checked = false;
  };
  $("score-prev").addEventListener("click", () => stepPage(-1));
  $("score-next").addEventListener("click", () => stepPage(1));
  $<HTMLInputElement>("score-condense").addEventListener("change", (e) => {
    if (!scoreView) return;
    scoreView.condense = (e.target as HTMLInputElement).checked;
    void scoreView.relayout();
  });
  // zoom = Verovio scale (re-engraves in the worker); wheel steps are coalesced so a fast
  // scroll re-engraves once
  let zoomTimer = 0;
  const zoom = (f: number): void => {
    if (!scoreView) return;
    scoreView.scale = Math.min(150, Math.max(10, Math.round(scoreView.scale * f)));
    $("score-zoom").textContent = `${scoreView.scale} %`;
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => void scoreView?.relayout(), 180);
  };
  $("score-zoomin").addEventListener("click", () => zoom(1.15));
  $("score-zoomout").addEventListener("click", () => zoom(1 / 1.15));
  $("score-host").addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return; // plain wheel scrolls the page
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  addEventListener("keydown", (e) => {
    if (!scoreOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "+" || e.key === "=") zoom(1.15);
    else if (e.key === "-" || e.key === "_") zoom(1 / 1.15);
  });
  if (params.get("zoom") && scoreView) {
    scoreView.scale = Math.min(150, Math.max(10, Number(params.get("zoom")) || 38));
    $("score-zoom").textContent = `${scoreView.scale} %`;
  }
  followBox.addEventListener("change", () => {
    if (scoreView) scoreView.follow = followBox.checked;
  });
  let relayoutTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(relayoutTimer);
    relayoutTimer = window.setTimeout(() => void scoreView?.relayout(), 250);
  });
  addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === "KeyS") setScore(!scoreOpen);
    else if (e.code === "Escape" && scoreOpen) setScore(false);
    else if (scoreOpen && e.code === "PageDown") stepPage(1);
    else if (scoreOpen && e.code === "PageUp") stepPage(-1);
  });
  if (params.get("view") === "score") setScore(true);
  if (params.get("view") === "registers") setRegisters(true);
  for (const f of afterSetup) f();

  // ---- frame loop
  const view = $("view3d");
  const resize = (): void => {
    const w = view.clientWidth, h = view.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(view);
  resize();

  let lastStatus = "";
  renderer.setAnimationLoop(() => {
    const t = player.tick();
    updateView(t);
    gapReadout(t);
    pane.heat = keyHeat(t);
    playBtn.textContent = player.transport.isPlaying ? "❚❚" : "▶";
    const ur = String(player.underruns);
    if (document.documentElement.dataset.underruns !== ur) document.documentElement.dataset.underruns = ur;
    $("time").textContent = `${fmt(t)} / ${fmt(m.duration_seconds)}`;
    if (m.score) {
      const bb = measureAt(m.score.measures, t);
      const txt = bb ? `m. ${bb.number}${bb.pass > 1 ? ` (pass ${bb.pass})` : ""} · beat ${bb.beat.toFixed(1)}` : "";
      if ($("barbeat").textContent !== txt) $("barbeat").textContent = txt;
    }
    if (regOpen) {
      regView.draw(t);
      const rt = `${fmt(t)} / ${fmt(m.duration_seconds)}`;
      if ($("reg-time").textContent !== rt) $("reg-time").textContent = rt;
    } else if (scoreOpen) {
      scoreView?.update(t);
      const bbs = m.score ? measureAt(m.score.measures, t) : null;
      const st = `${fmt(t)}${bbs ? ` · m. ${bbs.number}${bbs.pass > 1 ? ` (pass ${bbs.pass})` : ""} · beat ${bbs.beat.toFixed(1)}` : ""}`;
      if ($("score-time").textContent !== st) $("score-time").textContent = st;
      const pl = scoreView?.pageLabel() ?? "";
      if ($("score-page").textContent !== pl) $("score-page").textContent = pl;
    } else if (pianoOpen) {
      drawPiano(t);
    } else {
      controls.update();
      renderer.render(scene, camera);
    }
    pane.draw();
    strip.draw();
    const s = player.audioError
      ? status.textContent ?? ""
      : `${scoreStatus}${m.n_frames} frames × ${m.n_bins} bins · level ${page.level}${player.hasAudio ? "" : " · loading audio…"}`;
    if (s !== lastStatus) status.textContent = lastStatus = s;
  });
}

main().catch((e: unknown) => {
  status.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
