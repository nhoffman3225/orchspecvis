// Desktop app: progress of a session import (File › Import Session…). The app serves the
// status of its analysis subprocess read-only at app/import.json; this screen polls it.
// When the import succeeds the app itself navigates to the new bundle.

import { fetchSameOrigin } from "./net";

export interface ImportStatus {
  state: "idle" | "running" | "done" | "error";
  session: string;
  lines: string[];
  stems_done: number;
  stems_total: number;
  bundle: string | null;
  error: string | null;
}

/** 0..1 progress estimate: the mix (10 %), then stems (to 90 %), then score and writing. */
export function progressOf(s: ImportStatus): number {
  if (s.state === "done") return 1;
  const joined = s.lines.join("\n");
  if (s.stems_total > 0) return 0.1 + 0.8 * (s.stems_done / s.stems_total);
  if (/alignment:|mix:/.test(joined)) return 0.1;
  return 0.02;
}

export function runImportScreen(root: HTMLElement): void {
  const box = document.createElement("section");
  box.id = "importview";
  const h = document.createElement("h2");
  const bar = document.createElement("div");
  bar.className = "import-bar";
  const fill = document.createElement("div");
  bar.append(fill);
  const phase = document.createElement("p");
  phase.className = "import-phase";
  const log = document.createElement("pre");
  const hint = document.createElement("p");
  hint.className = "hint";
  box.append(h, bar, phase, log, hint);
  root.replaceChildren(box);
  h.textContent = "Importing…";
  const tick = async (): Promise<void> => {
    let s: ImportStatus;
    try {
      const r = await fetchSameOrigin(new URL("app/import.json", location.href).href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      s = (await r.json()) as ImportStatus;
    } catch (e) {
      phase.textContent = `import status unavailable (${e instanceof Error ? e.message : String(e)})`;
      hint.textContent = "Importing sessions needs the orchspec desktop app.";
      return;
    }
    h.textContent = `Importing ${s.session || "session"}`;
    fill.style.width = `${Math.round(progressOf(s) * 100)}%`;
    phase.textContent = s.stems_total ? `stems ${s.stems_done} / ${s.stems_total}` : (s.lines.at(-1) ?? "starting…");
    log.textContent = s.lines.slice(-14).join("\n");
    document.documentElement.dataset.import = s.state; // tests
    if (s.state === "error") {
      box.classList.add("failed");
      phase.textContent = `Import failed: ${s.error ?? "unknown error"}`;
      hint.textContent = "File › Import Session… to try again, File › Open Bundle… to open an existing one.";
      return;
    }
    if (s.state === "done") {
      phase.textContent = "Done — opening…";
      return; // the app navigates to the new bundle
    }
    setTimeout(() => void tick(), 400);
  };
  void tick();
}
