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

/** Wires every foldable group under `root`; `open` forces all open (e.g. ?tools=open).
 * Opening a group closes the others (an accordion keeps the toolbar short); Shift+click
 * opens it alongside them. */
export function initFolds(root: HTMLElement, open = false): void {
  const groups = [...root.querySelectorAll<HTMLElement>(".grp.fold[data-fold]")];
  const set = (grp: HTMLElement, on: boolean): void => {
    setGroupOpen(grp, on);
    remember(grp.dataset.fold!, on);
  };
  for (const grp of groups) {
    setGroupOpen(grp, open || (remembered(grp.dataset.fold!) ?? false));
    grp.querySelector<HTMLButtonElement>(":scope > button.cap")?.addEventListener("click", (e) => {
      const next = !grp.classList.contains("open");
      if (next && !e.shiftKey) for (const g of groups) if (g !== grp && g.classList.contains("open")) set(g, false);
      set(grp, next);
    });
  }
}
