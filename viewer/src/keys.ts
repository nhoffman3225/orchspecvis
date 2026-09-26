// When a key press is a shortcut rather than input to the focused control. Before, any
// focused input or select swallowed every shortcut, so after clicking a checkbox, slider
// or dropdown the keys seemed dead until something else was clicked.

const TEXT_TYPES = new Set(["text", "search", "number", "email", "url", "password", "tel"]);
const NAV = new Set(["Space", "Enter", "NumpadEnter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Whether `e` should drive the viewer's shortcuts. Text fields keep every key but Esc. A
 * control reached with the keyboard (:focus-visible) keeps the keys it uses (Space, Enter,
 * arrows, Home/End, paging); one merely clicked with the mouse keeps none, so Space still
 * plays after ticking a checkbox. Letters with Ctrl/Alt/Cmd, and held-down repeats of a
 * toggle, are never shortcuts. */
export function isShortcut(e: KeyboardEvent, opts: { repeat?: boolean } = {}): boolean {
  if (e.defaultPrevented) return false;
  const t = e.target instanceof Element ? e.target : null;
  if (e.code === "Escape") return true;
  if (t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return false;
  if (t instanceof HTMLInputElement && TEXT_TYPES.has(t.type)) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.repeat && !opts.repeat) return false;
  const control = t?.closest("input, select, button, [role='separator'], [tabindex]");
  if (control && NAV.has(e.code) && control.matches(":focus-visible")) return false;
  return true;
}

/** Runs a shortcut and stops the focused control from also acting on the key (a clicked
 * slider moving on ←, a checkbox toggling on Space, a dropdown jumping on a letter). */
export function take(e: KeyboardEvent, act: () => void): void {
  e.preventDefault();
  act();
}
