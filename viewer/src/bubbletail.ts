// The chord pop-up's pointer: a wedge from the pop-up's nearest edge to the selected area,
// re-shaped whenever either moves (the pop-up can be dragged and resized).

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Tail {
  base: [[number, number], [number, number]]; // on the pop-up's edge (just inside its border)
  tip: [number, number]; // just short of the selected area
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
}

/** The pointer from pop-up `b` to target `t`, from the edge facing it (the side with the
 * larger gap when the target is diagonal); its base widens with distance. Null when the
 * pop-up covers the target. `inset` puts the base over the pop-up's border. */
export function tailShape(b: Rect, t: Rect, inset = 1, gap = 4): Tail | null {
  if (overlaps(b, t)) return null;
  const gx = t.x0 >= b.x1 ? t.x0 - b.x1 : b.x0 >= t.x1 ? b.x0 - t.x1 : 0;
  const gy = t.y0 >= b.y1 ? t.y0 - b.y1 : b.y0 >= t.y1 ? b.y0 - t.y1 : 0;
  const dist = Math.hypot(gx, gy);
  if (gx >= gy) {
    const right = t.x0 >= b.x1;
    const edge = right ? b.x1 - inset : b.x0 + inset;
    const half = Math.min(clamp(dist * 0.2, 7, 16), (b.y1 - b.y0) / 2 - 4);
    const my = clamp((Math.max(b.y0, t.y0) + Math.min(b.y1, t.y1)) / 2, b.y0 + half + 6, b.y1 - half - 6);
    const ty = clamp(my, t.y0 + 2, t.y1 - 2);
    const tx = right ? t.x0 - gap : t.x1 + gap;
    return { base: [[edge, my - half], [edge, my + half]], tip: [tx, ty] };
  }
  const below = t.y0 >= b.y1;
  const edge = below ? b.y1 - inset : b.y0 + inset;
  const half = Math.min(clamp(dist * 0.2, 7, 16), (b.x1 - b.x0) / 2 - 4);
  const mx = clamp((Math.max(b.x0, t.x0) + Math.min(b.x1, t.x1)) / 2, b.x0 + half + 6, b.x1 - half - 6);
  const tx = clamp(mx, t.x0 + 2, t.x1 - 2);
  const ty = below ? t.y0 - gap : t.y1 + gap;
  return { base: [[mx - half, edge], [mx + half, edge]], tip: [tx, ty] };
}
