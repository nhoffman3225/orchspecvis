// Collapsible toolbar groups: a group marked `.grp.fold[data-fold=name]` shows only its
// caption button until clicked; the body then slides open horizontally (style.css).
// Groups start condensed; the open/closed state is remembered per browser (a
// per-viewer convenience: storage may be unavailable, which only loses the memory).

const KEY = "orchspec.fold.";

function remembered(name: string): boolean | null {
  try {
    const v = localStorage.getItem(KEY + name);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function remember(name: string, open: boolean): void {
  try {
    localStorage.setItem(KEY + name, open ? "1" : "0");
  } catch {
    // storage blocked
  }
}

export function setGroupOpen(grp: HTMLElement, open: boolean): void {
  grp.classList.toggle("open", open);
  const cap = grp.querySelector<HTMLButtonElement>(":scope > button.cap");
  cap?.setAttribute("aria-expanded", String(open));
  const body = grp.querySelector<HTMLElement>(":scope > .grp-body");
  // closed bodies are inert: their controls leave the tab order
  if (body) body.inert = !open;
}

/** Wires every foldable group under `root`; `open` forces all open (e.g. ?tools=open). */
export function initFolds(root: HTMLElement, open = false): void {
  for (const grp of root.querySelectorAll<HTMLElement>(".grp.fold[data-fold]")) {
    const name = grp.dataset.fold!;
    setGroupOpen(grp, open || (remembered(name) ?? false));
    grp.querySelector<HTMLButtonElement>(":scope > button.cap")?.addEventListener("click", () => {
      const next = !grp.classList.contains("open");
      setGroupOpen(grp, next);
      remember(name, next);
    });
  }
}
