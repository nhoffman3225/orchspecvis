// Draggable splitters between panels. Each one sets a CSS length variable on a host
// element (e.g. --pane-h on #app); the layout (style.css) reads it with a default, so a
// panel keeps working without the splitter. Sizes are clamped so no panel collapses,
// double-click resets, arrow keys nudge, and the size is remembered per browser
// (a per-viewer convenience: storage may be unavailable, which only loses the memory).

export interface SplitterOptions {
  /** element whose style carries the variable */
  host: HTMLElement;
  /** CSS custom property, e.g. "--pane-h" */
  prop: string;
  /** "y": a horizontal bar dragged up/down; "x": a vertical bar dragged left/right */
  axis: "x" | "y";
  /** +1 if dragging towards +x / +y grows the panel, -1 if it shrinks it */
  sign: 1 | -1;
  /** allowed size in px, evaluated on every drag (may depend on the window size) */
  min: () => number;
  max: () => number;
  /** localStorage key */
  key: string;
  /** called after every change (e.g. to relayout an engraved score) */
  onChange?: () => void;
  /** the panel's size before any drag (default: the element next to the handle) */
  measure?: () => number;
}

export function clampSize(px: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(px, min), Math.max(min, max)));
}

function load(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function save(key: string, px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(px));
  } catch {
    // storage blocked: the size just is not remembered
  }
}

export class Splitter {
  private size: number | null = null;

  constructor(readonly handle: HTMLElement, private readonly o: SplitterOptions) {
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", o.axis === "y" ? "horizontal" : "vertical");
    handle.tabIndex = 0;
    handle.title = "Drag to resize · double-click to reset";
    const saved = load(o.key);
    if (saved !== null) this.set(saved, false);
    handle.addEventListener("pointerdown", (e) => this.drag(e));
    handle.addEventListener("dblclick", () => this.reset());
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 10;
      const grow = o.axis === "y" ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 };
      const d = grow[e.key as keyof typeof grow];
      if (d === undefined) return;
      e.preventDefault();
      e.stopPropagation(); // arrows also seek playback
      this.set(this.current() + d * o.sign * step);
    });
    // a smaller window can push a remembered size out of range
    addEventListener("resize", () => {
      if (this.size !== null) this.set(this.size, false);
    });
  }

  /** The panel's current size in px (the variable, or the laid-out default). */
  current(): number {
    if (this.size !== null) return this.size;
    const v = parseFloat(getComputedStyle(this.o.host).getPropertyValue(this.o.prop));
    return Number.isFinite(v) ? v : this.o.min();
  }

  set(px: number, remember = true): void {
    this.size = clampSize(px, this.o.min(), this.o.max());
    this.o.host.style.setProperty(this.o.prop, `${this.size}px`);
    if (remember) save(this.o.key, this.size);
    this.o.onChange?.();
  }

  reset(): void {
    this.size = null;
    this.o.host.style.removeProperty(this.o.prop);
    save(this.o.key, null);
    this.o.onChange?.();
  }

  private drag(e: PointerEvent): void {
    if (e.button !== 0) return; // (no preventDefault: it would suppress dblclick = reset)
    const start = this.o.axis === "y" ? e.clientY : e.clientX;
    const from = this.panelSize();
    this.handle.setPointerCapture(e.pointerId);
    this.handle.classList.add("dragging");
    const move = (ev: PointerEvent): void => {
      const d = (this.o.axis === "y" ? ev.clientY : ev.clientX) - start;
      this.set(from + this.o.sign * d, false);
    };
    const up = (): void => {
      this.handle.removeEventListener("pointermove", move);
      this.handle.classList.remove("dragging");
      if (this.size !== null) save(this.o.key, this.size);
    };
    this.handle.addEventListener("pointermove", move);
    this.handle.addEventListener("pointerup", up, { once: true });
    this.handle.addEventListener("pointercancel", up, { once: true });
  }

  /** Measured size of the panel next to the handle (for drags from a CSS default). */
  private panelSize(): number {
    if (this.size !== null) return this.size;
    if (this.o.measure) return this.o.measure();
    const panel = this.o.sign > 0 ? this.handle.previousElementSibling : this.handle.nextElementSibling;
    const r = panel?.getBoundingClientRect();
    return r ? (this.o.axis === "y" ? r.height : r.width) : this.current();
  }
}
