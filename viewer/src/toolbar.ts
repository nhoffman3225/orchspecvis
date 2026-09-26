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

/** A group wider than its toolbar row wraps its controls instead of clipping them. */
function fitWrap(grp: HTMLElement): void {
  const bar = grp.parentElement;
  grp.classList.remove("wraps");
  if (bar && grp.classList.contains("settled") && grp.scrollWidth > bar.clientWidth - 12) grp.classList.add("wraps");
}

const reducedMotion = (): boolean => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Opens or closes a group; `animate` slides the body between 0 and its measured width. */
export function setGroupOpen(grp: HTMLElement, open: boolean, animate = true): void {
  const cap = grp.querySelector<HTMLButtonElement>(":scope > button.cap");
  cap?.setAttribute("aria-expanded", String(open));
  const body = grp.querySelector<HTMLElement>(":scope > .grp-body");
  if (!body) return;
  body.inert = !open; // closed bodies leave the tab order
  const slide = animate && !reducedMotion();
  if (open) {
    grp.classList.add("open");
    grp.classList.remove("settled");
    if (!slide) {
      body.style.maxWidth = "";
      grp.classList.add("settled");
      fitWrap(grp);
      return;
    }
    body.style.maxWidth = "0px";
    void body.offsetWidth; // start from 0
    // the group takes its final width at once, so the toolbar re-wraps (if it must) at the
    // click and not halfway through the slide
    grp.style.minWidth = `${grp.offsetWidth + body.scrollWidth}px`;
    body.style.maxWidth = `${body.scrollWidth}px`;
    const settle = (): void => {
      clearTimeout(timer);
      body.removeEventListener("transitionend", onEnd);
      grp.style.minWidth = "";
      if (!grp.classList.contains("open")) return;
      body.style.maxWidth = ""; // .settled: its natural width
      grp.classList.add("settled");
      fitWrap(grp);
    };
    const onEnd = (e: TransitionEvent): void => {
      if (e.propertyName === "max-width") settle();
    };
    const timer = setTimeout(settle, 400); // no transitionend (e.g. same width)
    body.addEventListener("transitionend", onEnd);
  } else {
    if (slide) {
      body.style.maxWidth = `${body.offsetWidth}px`; // from where it is now
      grp.classList.remove("settled", "wraps");
      grp.style.minWidth = `${grp.offsetWidth}px`; // keep its place until the slide ends
      void body.offsetWidth;
      const release = (): void => void (grp.style.minWidth = "");
      body.addEventListener("transitionend", release, { once: true });
      setTimeout(release, 400);
    }
    body.style.maxWidth = "0px";
    grp.classList.remove("open", "settled", "wraps");
  }
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
  addEventListener("resize", () => groups.forEach(fitWrap));
  for (const grp of groups) {
    setGroupOpen(grp, open || (remembered(grp.dataset.fold!) ?? false), false);
    grp.querySelector<HTMLButtonElement>(":scope > button.cap")?.addEventListener("click", (e) => {
      const next = !grp.classList.contains("open");
      if (next && !e.shiftKey) for (const g of groups) if (g !== grp && g.classList.contains("open")) set(g, false);
      set(grp, next);
    });
  }
}
