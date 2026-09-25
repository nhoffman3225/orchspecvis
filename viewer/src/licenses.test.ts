import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// viewer/public/licenses/THIRD-PARTY.txt ships with every build (shown under "credits").
// Regenerate with `uv run python scripts/credits.py` after changing shipped dependencies.
const text = readFileSync(new URL("../public/licenses/THIRD-PARTY.txt", import.meta.url), "utf-8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  dependencies: Record<string, string>;
};

describe("shipped licence texts", () => {
  it("covers orchspec and every runtime dependency at its current version", () => {
    expect(text).toContain("orchspec — MIT License");
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(text, `${name} ${version} missing: run scripts/credits.py`).toContain(`${name} ${version} — `);
    }
  });

  it("includes the full LGPL-3.0 and GPL-3.0 texts (Verovio is LGPL-3.0-or-later)", () => {
    expect(text).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(text).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(text).toContain("END OF TERMS AND CONDITIONS");
  });
});
