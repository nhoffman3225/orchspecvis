// orchspec viewer: 3D CQT surface + linked 2D pane + LUFS strip, synced to Web Audio.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadManifest, loadSeries } from "./bundle";
import { frameGaps, frameSpans, smoothPage } from "./gaps";
import { COLORMAPS, colormapLut, cssColor, stemPalette } from "./colormap";
import { initToken } from "./net";
import { LufsStrip, Pane2D } from "./pane2d";
import { Player } from "./player";
import { GRID_COLS, SURFACE_STYLES, Surface, colsPerBin, type SurfaceStyle } from "./surface";
import { TileCache, assemblePage, bundleTileLoader, chooseLevel, lodsFor, sumPages, type TrackId } from "./tiles";

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
  const cache = new TileCache(bundleTileLoader(base, m));
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
  const strip = new LufsStrip($<HTMLCanvasElement>("lufs"), m.duration_seconds);
  const lufs = m.features.find((f) => f.name === "lufs_short_term");
  if (lufs) strip.setData(await loadSeries(base, lufs), lufs.hop_seconds);

  const player = new Player(m.duration_seconds);
  void player.load(base, m.audio_path).then(() => {
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
    const pages = await Promise.all(
      tracks.map((t) => assemblePage(cache, lodsFor(m, t)[level]!, m.n_bins, start, pageFrames)),
    );
    const height = pages.length ? sumPages(pages, m.db_min, m.db_max) : new Uint8Array(pageFrames * m.n_bins);
    const dom = ui.mode === "dominant" && m.dominant
      ? await assemblePage(cache, m.dominant.lods[level]!, m.n_bins, start, pageFrames, m.dominant.none_value)
      : null;
    if (gen !== pageGen) return; // superseded
    raw = { height, dom, start, level, winFrames: secToF0(ui.winSeconds) / 2 ** level };
    rebuildDisplay();
    surface.setMode(ui.mode === "dominant" ? "dominant" : "db");
    const pal = palette();
    surface.setPalette(pal);
    page = { level, start, key: pageKey(), ready: true };
  }

  // ---- spectral gaps of whatever is displayed (mix, full ensemble, or selected stems)
  type ShownPage = { height: Uint8Array; dom: Uint8Array | null; start: number; level: number };
  let last: ShownPage | null = null;
  // the unsmoothed page as loaded; `last` is what is displayed (optionally smoothed)
  let raw: (ShownPage & { winFrames: number }) | null = null;
  const smooth = $<HTMLInputElement>("smooth");
  const pSmooth = params.get("smooth");
  if (pSmooth !== null && Number.isFinite(Number(pSmooth))) smooth.value = pSmooth;
  function rebuildDisplay(): void {
    if (!raw) return;
    const semis = Number(smooth.value);
    $("smoothval").textContent = semis > 0 ? `${semis} st` : "off";
    // sigma = half the chosen width; time sigma covers the same world distance as pitch
    const sigmaB = (semis * (m.bins_per_octave / 12)) / 2;
    const sigmaF = sigmaB * colsPerBin(m.n_bins) * (raw.winFrames / GRID_COLS);
    const height = smoothPage(raw.height, m.n_bins, pageFrames, sigmaB, sigmaF, m.db_min, m.db_max);
    surface.setPage(height, raw.dom, raw.start);
    last = { height, dom: raw.dom, start: raw.start, level: raw.level };
    applyGaps();
  }
  let smoothPending = false;
  smooth.addEventListener("input", () => {
    if (smoothPending) return;
    smoothPending = true;
    requestAnimationFrame(() => {
      smoothPending = false;
      rebuildDisplay();
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
      rebuildDisplay();
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
    playBtn.textContent = player.transport.isPlaying ? "❚❚" : "▶";
    $("time").textContent = `${fmt(t)} / ${fmt(m.duration_seconds)}`;
    controls.update();
    renderer.render(scene, camera);
    pane.draw();
    strip.draw();
    const s = player.audioError
      ? status.textContent ?? ""
      : `${m.n_frames} frames × ${m.n_bins} bins · level ${page.level} · ${cache.size} tiles cached${player.hasAudio ? "" : " · loading audio…"}`;
    if (s !== lastStatus) status.textContent = lastStatus = s;
  });
}

main().catch((e: unknown) => {
  status.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
