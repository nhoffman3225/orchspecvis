// Perceptual colormaps as 256-entry RGBA LUTs (polynomial fits of matplotlib's maps,
// after Matt Zucker's public-domain approximations), plus a categorical stem palette.

type Poly = [number, number, number][];

const MAPS: Record<string, Poly> = {
  magma: [
    [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
    [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
    [8.353717279216625, -3.577719514958484, 0.3144679030132573],
    [-27.66873308576866, 14.26473078096533, -13.64921318813922],
    [52.17613981234068, -27.94360607168351, 12.94416944238394],
    [-50.76852536473588, 29.04658282127291, 4.23415299384598],
    [18.65570506591883, -11.48977351997711, -5.601961508734096],
  ],
  viridis: [
    [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
    [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
    [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    [6.228269936347081, 14.17993336680509, 56.69055260068105],
    [4.776384997670288, -13.74514537774601, -65.35303263337234],
    [-5.435455855934631, 4.645852612178535, 26.3124352495832],
  ],
  inferno: [
    [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
    [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
    [11.60249308247187, -3.972853965665698, -15.9423941062914],
    [-41.70399613139459, 17.43639888205313, 44.35414519872813],
    [77.162935699427, -33.40235894210092, -81.80730925738993],
    [-71.31942824499214, 32.62606426397723, 73.20951985803202],
    [25.13112622477341, -12.24266895238567, -23.07032500287172],
  ],
};

export const COLORMAPS = Object.keys(MAPS);

export function colormapLut(name: string): Uint8Array {
  const c = MAPS[name] ?? MAPS.magma!;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    for (let ch = 0; ch < 3; ch++) {
      let v = 0;
      for (let k = c.length - 1; k >= 0; k--) v = v * t + c[k]![ch]!;
      out[i * 4 + ch] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Distinct colors for stem indices (golden-angle hues); index 255 = none (dark grey). */
export function stemPalette(n: number, enabled?: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let r = 60, g = 60, b = 66;
    if (i < n) {
      if (enabled && !enabled(i)) {
        r = g = b = 90;
      } else {
        [r, g, b] = hsl((i * 137.508) % 360, 0.7, 0.55);
      }
    }
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

export function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export function cssColor(lut: Uint8Array, i: number): string {
  return `rgb(${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]})`;
}
