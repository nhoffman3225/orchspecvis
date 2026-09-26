// Accessible mode (WCAG 2.2 AA): higher-contrast text and component edges, larger text
// and targets, no motion or decoration, stronger focus rings (style.css, under
// html[data-a11y="on"]). A per-viewer setting: remembered in this browser when storage
// works, and `?a11y=1` / `?a11y=0` sets it from the URL.

const KEY = "orchspec.a11y";

export function a11yOn(): boolean {
  return document.documentElement.dataset.a11y === "on";
}

export function setA11y(on: boolean): void {
  document.documentElement.dataset.a11y = on ? "on" : "off";
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // storage blocked: the setting lasts for this page
  }
  for (const box of document.querySelectorAll<HTMLInputElement>("input[data-a11y-toggle]")) box.checked = on;
}

/** Applies the remembered (or URL) setting and wires every `input[data-a11y-toggle]`. */
export function initA11y(params: URLSearchParams): void {
  let on = false;
  try {
    on = localStorage.getItem(KEY) === "1";
  } catch {
    // no storage: off unless the URL says so
  }
  if (params.get("a11y") === "1") on = true;
  if (params.get("a11y") === "0") on = false;
  document.documentElement.dataset.a11y = on ? "on" : "off";
  wireA11yToggles();
}

export function wireA11yToggles(root: ParentNode = document): void {
  for (const box of root.querySelectorAll<HTMLInputElement>("input[data-a11y-toggle]")) {
    box.checked = a11yOn();
    if (box.dataset.wired) continue;
    box.dataset.wired = "1";
    box.addEventListener("change", () => setA11y(box.checked));
  }
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

/** WCAG contrast ratio of two #rrggbb colours (1..21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
