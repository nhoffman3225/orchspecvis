// Phase 0 skeleton: load a bundle manifest + level-0 tiles and show them as a flat,
// colored surface. Phase 1 replaces this with the heightmap viewer.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { loadManifest, loadTile } from "./bundle";
import { initToken } from "./net";

const status = document.getElementById("status")!;
const canvas = document.getElementById("gl") as HTMLCanvasElement;

async function main(): Promise<void> {
  initToken(location.search);
  const base = new URLSearchParams(location.search).get("bundle") ?? "./tiny-bundle/";
  const m = await loadManifest(base.endsWith("/") ? base : base + "/");
  const l0 = m.lods[0]!;
  const data = new Uint8Array(l0.n_frames * m.n_bins);
  for (const t of l0.tiles) data.set(await loadTile(base, m, t), t.start_frame * m.n_bins);

  // frame-major bytes -> texture with width = n_bins, height = n_frames
  const tex = new THREE.DataTexture(data, m.n_bins, l0.n_frames, THREE.RedFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;

  if (!canvas.getContext("webgl2")) throw new Error("WebGL2 is not available in this browser/GPU");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 1.4, 1.6);
  const controls = new OrbitControls(camera, canvas);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: tex } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    // uv.x = time -> texture row (t), uv.y = pitch -> texture column (s)
    fragmentShader: `uniform sampler2D uTex; varying vec2 vUv; void main(){
      float v = texture2D(uTex, vec2(vUv.y, vUv.x)).r;
      gl_FragColor = vec4(v, v*v, 0.35 + 0.5*v, 1.0); }`,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 1, 1, 1), mat);
  plane.rotation.x = -Math.PI / 2;
  scene.add(plane);

  const resize = (): void => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
  };
  addEventListener("resize", resize);
  resize();
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  status.textContent = `${m.source.name}: ${m.n_frames} frames x ${m.n_bins} bins, ${m.duration_seconds.toFixed(2)} s`;
}

main().catch((e: unknown) => {
  status.textContent = `error: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
