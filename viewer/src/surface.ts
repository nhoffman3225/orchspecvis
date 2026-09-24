// 3D spectrogram surface: a GRID_COLS x n_bins grid whose vertices are displaced in the
// vertex shader by a heightmap texture holding one page of frames (never a full-resolution
// mesh of the whole piece).

import * as THREE from "three";

export const GRID_COLS = 2048;
export const WIDTH = 2.4; // world units along time
export const DEPTH = 1.2; // world units along pitch

const vertexShader = /* glsl */ `
uniform sampler2D uHeight;
uniform float uPageStart, uPageFrames, uWinStart, uWinFrames, uNBins;
uniform float uFloor, uHeightScale;
out float vH;
out float vBin;
out float vFrame;
out vec3 vWorld;
void main() {
  float frame = uWinStart + uv.x * max(uWinFrames - 1.0, 1.0);
  float bin = uv.y * (uNBins - 1.0);
  vec2 st = vec2((bin + 0.5) / uNBins, (frame - uPageStart + 0.5) / uPageFrames);
  float v = texture(uHeight, st).r;
  float h = clamp((v - uFloor) / max(1e-3, 1.0 - uFloor), 0.0, 1.0);
  vec3 p = position;
  p.y = h * uHeightScale;
  vH = h;
  vBin = bin;
  vFrame = frame;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uCmap, uDom, uPalette;
uniform float uPageStart, uPageFrames, uNBins, uK, uMode, uGrid;
in float vH;
in float vBin;
in float vFrame;
in vec3 vWorld;
out vec4 outColor;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (n.y < 0.0) n = -n;
  float diffuse = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 1.0, 0.6))), 0.0);
  vec3 c = texture(uCmap, vec2(vH, 0.5)).rgb;
  if (uMode > 0.5) {
    vec2 st = vec2((floor(vBin + 0.5) + 0.5) / uNBins, (floor(vFrame) - uPageStart + 0.5) / uPageFrames);
    float idx = texture(uDom, st).r * 255.0;
    vec3 pc = texture(uPalette, vec2((idx + 0.5) / 256.0, 0.5)).rgb;
    c = pc * (0.25 + 0.95 * vH);
  }
  // octave lines at every C (MIDI 24, 36, ...): bin -> midi 21 + bin / k
  float midi = 21.0 + vBin / uK;
  float d = abs(fract((midi - 24.0) / 12.0 + 0.5) - 0.5) * 12.0; // semitones to nearest C
  float line = uGrid * (1.0 - smoothstep(0.0, 0.12, d)) * 0.35;
  outColor = vec4(mix(c * diffuse, vec3(0.85), line), 1.0);
}`;

export type SurfaceMode = "db" | "dominant";

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
        idx.set([a, d, b, b, d, e], j);
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

  setGrid(on: boolean): void {
    this.u("uGrid").value = on ? 1 : 0;
  }
}
