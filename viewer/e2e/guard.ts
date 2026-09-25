import type { Page } from "@playwright/test";

/** Records every request that leaves the page's origin, and every page error. */
export function guard(page: Page, origin: string): { offOrigin: string[]; errors: string[] } {
  const offOrigin: string[] = [];
  const errors: string[] = [];
  const allowed = new URL(origin).host;
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "data:" || u.protocol === "blob:") return;
    if (u.host !== allowed) offOrigin.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // resource failures are reported with their URL below instead
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  return { offOrigin, errors };
}
