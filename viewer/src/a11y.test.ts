import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast } from "./a11y";

const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf-8");

/** The custom properties of the first block matching `selector`. */
function tokens(selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  const block = css.slice(i, css.indexOf("}", i));
  const hex6 = (h: string): string => (h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h).toLowerCase();
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6}|#[0-9a-f]{3})(?![0-9a-f])/gi)]
    .map((m) => [m[1]!, hex6(m[2]!)]));
}

const base = tokens(":root");
const on = { ...base, ...tokens('html[data-a11y="on"]') };

describe("accessible mode (WCAG 2.2 AA)", () => {
  it("text on every surface reaches 4.5:1", () => {
    for (const surface of ["bg", "panel", "raise"]) {
      for (const text of ["fg", "muted", "yellow", "teal", "pink"]) {
        expect(contrast(on[text]!, on[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("control edges and separators reach 3:1 against their surfaces", () => {
    for (const surface of ["bg", "panel", "raise"]) {
      expect(contrast(on.edge!, on[surface]!), `edge on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("dark text on the accent tags reaches 4.5:1", () => {
    for (const tag of ["yellow", "teal", "pink", "orange", "cobalt"]) {
      expect(contrast(on.ink!, on[tag]!), `ink on ${tag}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("accessible mode raises muted text above the default", () => {
    expect(contrast(on.muted!, on.panel!)).toBeGreaterThan(contrast(base.muted!, base.panel!));
  });
});
