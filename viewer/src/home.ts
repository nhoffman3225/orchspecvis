// Desktop app home screen (?home=1): the splash with the ways in — open a bundle, build one
// from files (the wizard, ?wizard=1), import a session folder — and the bundles on this
// machine (recently opened first). Native dialogs and the build run in the app, behind
// the read-only home.json and the POST /app/open|pick|build|import routes.

import { fetchSameOrigin } from "./net";

export interface HomeBundle {
  name: string;
  path: string;
  modified: number;
  has_score: boolean;
  recent: boolean;
}

interface HomeInfo {
  bundles: HomeBundle[];
  bundles_dir: string | null;
  importing: boolean;
}

export type PickKind = "musicxml" | "midi" | "stems" | "mix" | "pdf";

export interface Picks {
  musicxml: string | null;
  midi: string | null;
  stems: string[];
  mix: string | null;
  pdf: string | null;
}

/** What the wizard sends to /app/build, or why it cannot yet. */
export function buildRequest(name: string, p: Picks): { body: Record<string, unknown> } | { error: string } {
  if (!p.mix && !p.stems.length) return { error: "Choose the stems, the mix, or both." };
  const body: Record<string, unknown> = { name: name.trim() || suggestName(p), stems: p.stems };
  for (const k of ["mix", "musicxml", "midi", "pdf"] as const) if (p[k]) body[k] = p[k];
  return { body };
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;
const stemOf = (path: string): string => baseName(path).replace(/\.[^.]+$/, "");

/** A bundle name from the files: the score's name, else the stems' or the mix's folder. */
export function suggestName(p: Picks): string {
  if (p.musicxml) return stemOf(p.musicxml);
  const first = p.stems[0] ?? p.mix;
  if (!first) return "Untitled";
  const parts = first.split(/[\\/]/);
  const folder = parts.at(-2) ?? "";
  return (/^stems?$/i.test(folder) ? parts.at(-3) : folder) || stemOf(first);
}

const STEPS: { kind: PickKind; title: string; hint: string; tag: string }[] = [
  { kind: "musicxml", title: "Score (MusicXML)", tag: "Recommended",
    hint: "Notes, parts and bars: the score view, the tutti view and note outlines." },
  { kind: "midi", title: "Tempo MIDI", tag: "Recommended",
    hint: "The MIDI the audio was rendered from: its tempo map lines the notes up with the audio." },
  { kind: "stems", title: "Stems", tag: "Audio",
    hint: "One audio file per player, all the same length. Summed into the mix if you give no mix." },
  { kind: "mix", title: "Mix", tag: "Audio",
    hint: "The full render. Optional when you give stems." },
  { kind: "pdf", title: "Score PDF", tag: "Optional",
    hint: "The engraved layout to read along with (e.g. Dorico's condensed score)." },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

async function post(route: string, body: unknown = {}): Promise<Record<string, unknown>> {
  const r = await fetchSameOrigin(new URL(route, location.href).href, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

function when(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export async function runHomeScreen(root: HTMLElement, params: URLSearchParams): Promise<void> {
  document.title = "orchspec";
  const home = el("section");
  home.id = "home";
  const hero = el("header", "home-hero");
  const mark = el("h1", "home-mark", "orchspecvis");
  mark.title = "Orchestral Spectrum Visualizer";
  hero.append(mark, el("p", "home-tag", "Orchestral Spectrum Visualizer: see how a render fills the pitch spectrum, next to the score that made it."));
  const actions = el("div", "home-actions");
  const status = el("p", "home-status");
  status.setAttribute("role", "status");
  const card = (id: string, icon: string, title: string, sub: string): HTMLButtonElement => {
    const b = el("button", "home-card");
    b.id = id;
    b.type = "button";
    b.append(el("span", "home-card-icon", icon), el("strong", "", title), el("span", "home-card-sub", sub));
    actions.append(b);
    return b;
  };
  const openBtn = card("home-open", "📂", "Open Bundle", "A bundle folder you made before");
  const newBtn = card("home-new", "✦", "New Bundle from Files", "Score, MIDI, stems, mix: build it here");
  const importBtn = card("home-import", "🗂", "Import Session Folder", "A folder laid out as a session");
  const listBox = el("section", "home-list");
  const wizard = el("section", "home-wizard");
  wizard.id = "wizard";
  wizard.hidden = true;
  home.append(hero, actions, status, wizard, listBox);
  root.replaceChildren(home);

  const say = (msg: string, bad = false): void => {
    status.textContent = msg;
    status.classList.toggle("bad", bad);
  };
  const act = async (route: string, body: unknown = {}): Promise<void> => {
    try {
      const r = await post(route, body);
      if (r.ok === false && !r.cancelled) say(String(r.error ?? "failed"), true);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  };
  openBtn.addEventListener("click", () => void act("app/open"));
  importBtn.addEventListener("click", () => void act("app/import"));

  // ---- the bundles on this machine
  let info: HomeInfo;
  try {
    const r = await fetchSameOrigin(new URL("app/home.json", location.href).href);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    info = (await r.json()) as HomeInfo;
  } catch {
    say("The home screen is part of the orchspec desktop app. In a browser, open a bundle with `orchspec serve`.", true);
    for (const b of [openBtn, newBtn, importBtn]) b.disabled = true;
    return;
  }
  const h2 = el("h2", "", "Your Bundles");
  listBox.append(h2);
  if (!info.bundles.length) {
    listBox.append(el("p", "hint", "No bundles yet. Build one from your files, or import a session folder."));
  } else {
    const ul = el("ul");
    for (const b of info.bundles) {
      const li = el("li");
      const btn = el("button", "home-bundle");
      btn.type = "button";
      btn.title = b.path;
      const tags = el("span", "home-tags");
      if (b.recent) tags.append(el("span", "tag recent", "Recent"));
      tags.append(el("span", `tag ${b.has_score ? "score" : "audio"}`, b.has_score ? "Score" : "Audio Only"));
      btn.append(el("strong", "", b.name), tags, el("span", "home-when", when(b.modified)));
      btn.addEventListener("click", () => void act("app/open", { path: b.path }));
      li.append(btn);
      ul.append(li);
    }
    listBox.append(ul);
  }
  if (info.bundles_dir) listBox.append(el("p", "hint", `Saved in ${info.bundles_dir}`));
  if (info.importing) say("An import is running: File › Import Session Folder… shows its progress.");

  // ---- the wizard
  const picks: Picks = { musicxml: null, midi: null, stems: [], mix: null, pdf: null };
  const wh = el("div", "wizard-head");
  const nameIn = el("input");
  nameIn.id = "wizard-name";
  nameIn.placeholder = "Bundle name";
  nameIn.setAttribute("aria-label", "Bundle name");
  const buildBtn = el("button", "wizard-build", "Build Bundle");
  buildBtn.id = "wizard-build";
  buildBtn.type = "button";
  const closeW = el("button", "", "✕ Close");
  closeW.type = "button";
  wh.append(el("h2", "", "New Bundle from Files"), closeW);
  const steps = el("ol", "wizard-steps");
  const shown = new Map<PickKind, HTMLElement>();
  const refresh = (): void => {
    for (const s of STEPS) {
      const out = shown.get(s.kind)!;
      const v = picks[s.kind];
      const files = Array.isArray(v) ? v : v ? [v] : [];
      out.textContent = files.length ? files.map(baseName).join(" · ") : "Not chosen";
      out.classList.toggle("none", !files.length);
      out.parentElement!.classList.toggle("done", files.length > 0);
    }
    if (!nameIn.dataset.edited) nameIn.value = suggestName(picks);
    const req = buildRequest(nameIn.value, picks);
    buildBtn.disabled = "error" in req;
    buildBtn.title = "error" in req ? req.error : "Lay the files out as a session and analyse it";
  };
  for (const s of STEPS) {
    const li = el("li", "wizard-step");
    li.dataset.kind = s.kind;
    const text = el("div", "wizard-text");
    text.append(el("strong", "", s.title), el("span", `tag ${s.tag.toLowerCase()}`, s.tag), el("p", "hint", s.hint));
    const chosen = el("p", "wizard-files");
    shown.set(s.kind, chosen);
    text.append(chosen);
    const choose = el("button", "", s.kind === "stems" ? "Choose Files…" : "Choose…");
    choose.type = "button";
    choose.id = `pick-${s.kind}`;
    const clear = el("button", "", "Clear");
    clear.type = "button";
    choose.addEventListener("click", () => void (async () => {
      try {
        const r = await post("app/pick", { kind: s.kind });
        const paths = (r.paths as string[] | undefined) ?? [];
        if (!paths.length) return; // cancelled
        if (s.kind === "stems") picks.stems = paths;
        else picks[s.kind] = paths[0]!;
        refresh();
      } catch (e) {
        say(e instanceof Error ? e.message : String(e), true);
      }
    })());
    clear.addEventListener("click", () => {
      if (s.kind === "stems") picks.stems = [];
      else picks[s.kind] = null;
      refresh();
    });
    const btns = el("div", "wizard-btns");
    btns.append(choose, clear);
    li.append(text, btns);
    steps.append(li);
  }
  const foot = el("div", "wizard-foot");
  const nameLabel = el("label", "", "Name ");
  nameLabel.append(nameIn);
  foot.append(nameLabel, buildBtn);
  wizard.append(wh, steps, foot);
  nameIn.addEventListener("input", () => {
    nameIn.dataset.edited = nameIn.value ? "1" : "";
    refresh();
  });
  buildBtn.addEventListener("click", () => {
    const req = buildRequest(nameIn.value, picks);
    if ("error" in req) return say(req.error, true);
    say("Building…");
    void act("app/build", req.body); // on success the app shows the import progress
  });
  const showWizard = (on: boolean): void => {
    wizard.hidden = !on;
    listBox.hidden = on;
    actions.classList.toggle("compact", on);
    if (on) nameIn.focus();
  };
  newBtn.addEventListener("click", () => showWizard(true));
  closeW.addEventListener("click", () => showWizard(false));
  refresh();
  if (params.get("wizard") === "1") showWizard(true);
  document.documentElement.dataset.home = "ready"; // tests
}
