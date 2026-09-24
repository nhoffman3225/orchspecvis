// The ONLY place the viewer performs network I/O. Everything is same-origin (the local
// `orchspec serve`, the Vite dev server, or later the Tauri custom protocol).

export class OffOriginError extends Error {}

let token: string | null = null;

/** Picks up the per-launch token from `?token=` once (orchspec serve also sets a cookie). */
export function initToken(search: string): void {
  token = new URLSearchParams(search).get("token");
}

export function assertSameOrigin(url: string, base: string): URL {
  const u = new URL(url, base);
  const b = new URL(base);
  if (u.origin !== b.origin) {
    throw new OffOriginError(`blocked non-local request to ${u.origin} (local-only app)`);
  }
  return u;
}

export async function fetchSameOrigin(url: string, init: RequestInit = {}): Promise<Response> {
  const here = globalThis.location?.href;
  if (!here) throw new OffOriginError("no page origin; refusing to fetch");
  const u = assertSameOrigin(url, here);
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Orchspec-Token", token);
  return fetch(u, { ...init, headers, credentials: "same-origin", referrerPolicy: "no-referrer" });
}
