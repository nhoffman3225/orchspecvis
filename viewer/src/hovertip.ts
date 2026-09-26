// Hover help: any element with a `title` (or `data-tip`) shows a styled tip after a short
// delay, on hover or keyboard focus. The title moves into `data-tip` so the browser's
// own tooltip does not also appear; `aria-description` keeps it for screen readers.

const DELAY_MS = 350;

export function tipText(el: Element): string | null {
  const t = el.getAttribute("title");
  if (t) {
    el.setAttribute("data-tip", t);
    el.setAttribute("aria-description", t);
    el.removeAttribute("title");
  }
  return el.getAttribute("data-tip");
}

/** The nearest element (from `start` up) that carries a tip. */
function carrier(start: EventTarget | null): Element | null {
  let el = start instanceof Element ? start : null;
  while (el) {
    if (el.hasAttribute("title") || el.hasAttribute("data-tip")) return el;
    el = el.parentElement;
  }
  return null;
}

export function initHoverTips(doc: Document = document): void {
  const box = doc.createElement("div");
  box.id = "hovertip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  doc.body.append(box);
  let timer = 0;
  let shownFor: Element | null = null;

  const hide = (): void => {
    clearTimeout(timer);
    box.hidden = true;
    shownFor = null;
  };
  const show = (el: Element): void => {
    const text = tipText(el);
    if (!text) return;
    box.textContent = text;
    box.hidden = false;
    shownFor = el;
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    const x = Math.min(Math.max(4, r.left), vw - w - 4);
    let y = r.bottom + 8;
    if (y + h > vh - 4) y = Math.max(4, r.top - h - 8); // flip above near the bottom
    box.style.left = `${Math.round(x)}px`;
    box.style.top = `${Math.round(y)}px`;
  };
  const arm = (el: Element | null): void => {
    if (el === shownFor) return;
    hide();
    if (!el) return;
    tipText(el); // suppress the native tooltip straight away
    timer = window.setTimeout(() => show(el), DELAY_MS);
  };

  // the tip can be hovered itself without closing (WCAG 1.4.13); Esc dismisses it
  doc.addEventListener("pointerover", (e) => {
    if (e.target instanceof Node && box.contains(e.target)) return;
    arm(carrier(e.target));
  });
  doc.addEventListener("focusin", (e) => {
    if ((e.target as Element).matches?.(":focus-visible")) arm(carrier(e.target));
  });
  doc.addEventListener("pointerdown", hide, true);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  doc.addEventListener("scroll", hide, true);
  doc.addEventListener("pointerleave", hide);
}
