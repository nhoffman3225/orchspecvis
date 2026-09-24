// 3D spectrogram surface: a GRID_COLS x n_bins grid whose vertices are displaced in the
// vertex shader by a heightmap texture holding one page of frames (never a full-resolution
// mesh of the whole piece).

import * as THREE from "three";

export const GRID_COLS = 2048;
export const WIDTH = 2.4; // world units along time
export const DEPTH = 1.2; // world units along pitch

const vertexShader = /* glsl */ `
uniform sampler2D uHeight, uSpan;
uniform float uPageStart, uPageFrames, uWinStart, uWinFrames, uNBins;
uniform float uFloor, uHeightScale, uGapV, uStyle;
out float vH;
out float vV;
out float vGap;
out float vBin;
out float vFrame;
out vec2 vUv;
out vec3 vWorld;

float rawV(float frame, float bin) {
  vec2 st = vec2((clamp(bin, 0.0, uNBins - 1.0) + 0.5) / uNBins,
                 (frame - uPageStart + 0.5) / uPageFrames);
  return texture(uHeight, st).r;
}

float toH(float v) {
  return clamp((v - uFloor) / max(1e-3, 1.0 - uFloor), 0.0, 1.0);
}

void main() {
  float frame = uWinStart + uv.x * max(uWinFrames - 1.0, 1.0);
  float bin = uv.y * (uNBins - 1.0);
  float v = rawV(frame, bin);
  float h = toH(v);
  // spectral gap: quiet cell strictly inside this frame's sounding span (see gaps.ts)
  vec2 span = texture(uSpan, vec2(0.5, (floor(frame) - uPageStart + 0.5) / uPageFrames)).rg;
  float gap = (uGapV >= 0.0 && span.x >= 0.0 && bin > span.x && bin < span.y && v <= uGapV) ? 1.0 : 0.0;
  vec3 p = position;
  p.y = h * uHeightScale;
  // terrain: gaps fill with water up to "sea level" (the gap threshold)
  if (uStyle > 0.5 && uStyle < 1.5 && gap > 0.5) p.y = max(p.y, toH(uGapV) * uHeightScale);
  vH = h;
  vV = v;
  vGap = gap;
  vBin = bin;
  vFrame = frame;
  vUv = uv;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uCmap, uDom, uPalette, uNotes, uPartPal;
uniform float uPageStart, uPageFrames, uNBins, uK, uMode, uGrid, uStyle, uContours, uGapV;
uniform float uNotesOn;
in float vH;
in float vV;
in float vGap;
in float vBin;
in float vFrame;
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;

// anti-aliased line on a periodic coordinate x (lines at integers), width in pixels
float isoline(float x, float width) {
  float d = abs(fract(x - 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, width * fwidth(x), d);
}

void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (n.y < 0.0) n = -n;
  vec3 L = normalize(vec3(-0.4, 1.0, 0.6));
  vec3 c = texture(uCmap, vec2(vH, 0.5)).rgb;
  if (uMode > 0.5) {
    vec2 st = vec2((floor(vBin + 0.5) + 0.5) / uNBins, (floor(vFrame) - uPageStart + 0.5) / uPageFrames);
    float idx = texture(uDom, st).r * 255.0;
    vec3 pc = texture(uPalette, vec2((idx + 0.5) / 256.0, 0.5)).rgb;
    c = pc * (0.25 + 0.95 * vH);
  }
  float midi = 21.0 + vBin / uK;
  float semisToC = abs(fract((midi - 24.0) / 12.0 + 0.5) - 0.5) * 12.0;
  float cLine = uGrid * (1.0 - smoothstep(0.0, 0.12, semisToC));
  vec3 col;
  if (uStyle < 0.5) {
    // "surface": colormapped, lit
    float diffuse = 0.55 + 0.45 * max(dot(n, L), 0.0);
    col = mix(c * diffuse, vec3(0.85), cLine * 0.35);
  } else if (uStyle < 1.5) {
    // "terrain": hillshade + topographic contours (every 1/uContours of the height range,
    // with every 5th an index contour), like a relief map
    float shade = 0.35 + 0.75 * max(dot(n, L), 0.0);
    float lvl = vH * uContours;
    float minor = isoline(lvl, 1.0) * step(0.02, vH);
    float major = isoline(lvl / 5.0, 1.8) * step(0.02, vH);
    col = c * shade;
    col = mix(col, col * 0.35, minor * 0.6);
    col = mix(col, vec3(0.95, 0.93, 0.85), major * 0.55);
    col = mix(col, vec3(0.85), cLine * 0.25);
  } else {
    // "fabric": dark sheet with a glowing coordinate mesh (spacetime-curvature look);
    // mesh lines every semitone along pitch and at a fixed count along time
    float gp = isoline(midi, 1.2);
    float gt = isoline(vUv.x * 96.0, 1.2);
    float g = max(gp, gt);
    float rim = pow(1.0 - abs(n.y), 1.5);
    vec3 glow = mix(vec3(0.25, 0.55, 1.0), c, 0.75);
    col = vec3(0.02, 0.025, 0.05) + glow * (0.08 + 0.25 * vH + 0.4 * rim);
    col += glow * g * (0.35 + 1.1 * vH);
    col = mix(col, vec3(0.9), cLine * 0.3);
  }
  if (vGap > 0.5) {
    float depth = clamp(1.0 - vV / max(uGapV, 1e-3), 0.0, 1.0); // 0 at the shore, 1 = silent
    if (uStyle < 0.5) {
      col = mix(col, vec3(0.15, 0.45, 0.95), 0.55 + 0.3 * depth);
    } else if (uStyle < 1.5) {
      vec3 water = mix(vec3(0.35, 0.65, 0.95), vec3(0.03, 0.12, 0.38), depth);
      float ripple = isoline(depth * 6.0, 1.0) * 0.25;
      col = mix(water, vec3(0.8, 0.9, 1.0), ripple);
    } else {
      col += vec3(1.0, 0.55, 0.15) * (0.25 + 0.5 * depth);
    }
  }
  if (uNotesOn > 0.5) {
    vec2 nst = vec2((floor(vBin + 0.5) + 0.5) / uNBins, (floor(vFrame) - uPageStart + 0.5) / uPageFrames);
    float nid = texture(uNotes, nst).r * 255.0;
    if (nid > 0.5) {
      vec3 pc = texture(uPartPal, vec2((nid + 0.5) / 256.0, 0.5)).rgb;
      col = mix(col, pc, 0.55) + pc * 0.15;
    }
  }
  outColor = vec4(col, 1.0);
}`;

export type SurfaceMode = "db" | "dominant";
/** Grid columns spanned by one pitch row in world space (for isotropic smoothing). */
export const colsPerBin = (nBins: number): number => (DEPTH / nBins) / (WIDTH / GRID_COLS);
export const SURFACE_STYLES = ["surface", "terrain", "fabric"] as const;
export type SurfaceStyle = (typeof SURFACE_STYLES)[number];

function dataTex(data: Uint8Array, w: number, h: number, format: THREE.PixelFormat, filter: THREE.TextureFilter): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.minFilter = filter;
  t.magFilter = filter as THREE.MagnificationTextureFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class Surface {
  readonly group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private heightTex: THREE.DataTexture;
  private domTex: THREE.DataTexture;
  private cmapTex: THREE.DataTexture;
  private paletteTex: THREE.DataTexture;
  private spanTex: THREE.DataTexture;
  private notesTex: THREE.DataTexture;
  private partPalTex: THREE.DataTexture;
  private playhead: THREE.Mesh;
  private winStart = 0;
  private winFrames = 1;

  constructor(
    readonly nBins: number,
    readonly pageFrames: number,
    k: number,
  ) {
    const geom = new THREE.BufferGeometry();
    const cols = GRID_COLS, rows = nBins;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const u = c / (cols - 1), v = r / (rows - 1);
        pos[i * 3] = (u - 0.5) * WIDTH;
        pos[i * 3 + 2] = (0.5 - v) * DEPTH; // low pitch in front
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
      }
    }
    const idx = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let j = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.set([a, b, d, b, e, d], j); // counter-clockwise seen from above (+y), so top faces are front faces
        j += 6;
      }
    }
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.3, 0), WIDTH);

    this.heightTex = dataTex(new Uint8Array(nBins * pageFrames), nBins, pageFrames, THREE.RedFormat, THREE.LinearFilter);
    this.domTex = dataTex(new Uint8Array(nBins * pageFrames).fill(255), nBins, pageFrames, THREE.RedFormat, THREE.NearestFilter);
    this.cmapTex = dataTex(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.LinearFilter);
    this.paletteTex = dataTex(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.NearestFilter);

    // per-frame sounding span [lo, hi] in bins (float RG, one texel per page frame)
    this.spanTex = new THREE.DataTexture(new Float32Array(pageFrames * 2).fill(-1), 1, pageFrames,
      THREE.RGFormat, THREE.FloatType);
    this.spanTex.minFilter = this.spanTex.magFilter = THREE.NearestFilter;
    this.spanTex.needsUpdate = true;

    this.notesTex = dataTex(new Uint8Array(nBins * pageFrames), nBins, pageFrames, THREE.RedFormat, THREE.NearestFilter);
    this.partPalTex = dataTex(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat, THREE.NearestFilter);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uHeight: { value: this.heightTex },
        uDom: { value: this.domTex },
        uCmap: { value: this.cmapTex },
        uPalette: { value: this.paletteTex },
        uPageStart: { value: 0 },
        uPageFrames: { value: pageFrames },
        uWinStart: { value: 0 },
        uWinFrames: { value: 1 },
        uNBins: { value: nBins },
        uK: { value: k },
        uFloor: { value: 0.25 },
        uHeightScale: { value: 0.45 },
        uMode: { value: 0 },
        uGrid: { value: 1 },
        uStyle: { value: 0 },
        uContours: { value: 20 },
        uSpan: { value: this.spanTex },
        uGapV: { value: -1 },
        uNotes: { value: this.notesTex },
        uPartPal: { value: this.partPalTex },
        uNotesOn: { value: 0 },
      },
    });
    this.group.add(new THREE.Mesh(geom, this.material));

    const ph = new THREE.PlaneGeometry(DEPTH, 0.6);
    ph.rotateY(Math.PI / 2);
    ph.translate(0, 0.3, 0);
    this.playhead = new THREE.Mesh(
      ph,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.group.add(this.playhead);
  }

  private u(name: string): THREE.IUniform {
    return this.material.uniforms[name]!;
  }

  setPage(height: Uint8Array, dominant: Uint8Array | null, pageStart: number): void {
    (this.heightTex.image.data as Uint8Array).set(height.subarray(0, this.nBins * this.pageFrames));
    this.heightTex.needsUpdate = true;
    const dd = this.domTex.image.data as Uint8Array;
    if (dominant) dd.set(dominant.subarray(0, this.nBins * this.pageFrames));
    else dd.fill(255);
    this.domTex.needsUpdate = true;
    this.u("uPageStart").value = pageStart;
  }

  setWindow(start: number, frames: number): void {
    this.winStart = start;
    this.winFrames = frames;
    this.u("uWinStart").value = start;
    this.u("uWinFrames").value = frames;
  }

  /** Playhead in frames of the current level. */
  setPlayhead(frame: number): void {
    const u = (frame - this.winStart) / Math.max(1, this.winFrames - 1);
    this.playhead.visible = u >= 0 && u <= 1;
    this.playhead.position.x = (u - 0.5) * WIDTH;
  }

  setColormap(lut: Uint8Array): void {
    (this.cmapTex.image.data as Uint8Array).set(lut);
    this.cmapTex.needsUpdate = true;
  }

  setPalette(lut: Uint8Array): void {
    (this.paletteTex.image.data as Uint8Array).set(lut);
    this.paletteTex.needsUpdate = true;
  }

  setMode(mode: SurfaceMode): void {
    this.u("uMode").value = mode === "dominant" ? 1 : 0;
  }

  /** floor in 0..1 of the quantized range; values below are flat. */
  setFloor(f: number): void {
    this.u("uFloor").value = f;
  }

  setHeightScale(s: number): void {
    this.u("uHeightScale").value = s;
  }

  /** Note overlay mask for the current page (value = part + 1), or null to hide it. */
  setNotes(mask: Uint8Array | null): void {
    const d = this.notesTex.image.data as Uint8Array;
    if (mask) d.set(mask.subarray(0, this.nBins * this.pageFrames));
    else d.fill(0);
    this.notesTex.needsUpdate = true;
    this.u("uNotesOn").value = mask ? 1 : 0;
  }

  /** 256-entry RGBA palette indexed by part + 1. */
  setPartPalette(lut: Uint8Array): void {
    (this.partPalTex.image.data as Uint8Array).set(lut);
    this.partPalTex.needsUpdate = true;
  }

  /** Per-frame sounding spans for the current page (from gaps.frameSpans). */
  setSpans(spans: Float32Array): void {
    (this.spanTex.image.data as Float32Array).set(spans.subarray(0, this.pageFrames * 2));
    this.spanTex.needsUpdate = true;
  }

  /** Gap threshold as a raw texel value 0..1 (u8 / 255); negative disables gap display. */
  setGap(v: number): void {
    this.u("uGapV").value = v;
  }

  setStyle(style: SurfaceStyle): void {
    this.u("uStyle").value = SURFACE_STYLES.indexOf(style);
  }

  /** Number of contour intervals across the displayed height range (terrain style). */
  setContours(n: number): void {
    this.u("uContours").value = n;
  }

  setGrid(on: boolean): void {
    this.u("uGrid").value = on ? 1 : 0;
  }
}
