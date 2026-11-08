import { useEffect, useRef, useState } from "react";
import {
  BoxGeometry,
  type BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type MapData, type MapKind, sampleAt } from "../map/mapData.ts";
import { drawLabels, pick, type ScreenHit, sideColor, type Theme } from "../map/render.ts";
import { buildFrame, type ColorFn, framingCamera, toWorld } from "../scene/frame.ts";
import { readTheme } from "./Map2D.tsx";
import type { ViewProps } from "./viewTypes.ts";

/**
 * GPU 3D view (three.js). Simple symbols, drawn with one instanced draw call per kind and kept at a
 * constant size on screen. Renders on demand, not continuously.
 */

const FOV = 50;
/** On-screen symbol sizes in CSS pixels. */
const PX: Record<MapKind | "kill", number> = {
  air: 20,
  heli: 16,
  weapon: 18,
  ground: 8,
  sea: 16,
  chute: 10,
  bullseye: 26,
  kill: 9,
};
const KILL_FADE_S = 60;
const FINE_GRID_MAX_DIST_M = 60_000;

interface Gl {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  meshes: Record<MapKind, InstancedMesh>;
  killsNew: InstancedMesh;
  killsOld: InstancedMesh;
  trail: LineSegments;
  drops: LineSegments;
  /** The 1 km grid; hidden from far away, where it would only show as a moiré patch. */
  fineGrid: GridHelper;
  theme: Theme;
  dispose: () => void;
}

export default function Scene3D(props: ViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<Gl | null>(null);
  const hitsRef = useRef<ScreenHit[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const renderRef = useRef<() => void>(() => {});
  const [error, setError] = useState<string | null>(null);
  const { data } = props;

  // Create the WebGL scene once per recording.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let gl: Gl;
    try {
      gl = createScene(canvas, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    glRef.current = gl;
    // Development only: lets the scene be inspected from the browser console.
    if (import.meta.env.DEV) (window as unknown as { __scene3d?: Gl }).__scene3d = gl;
    let raf = 0;
    const request = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    renderRef.current = request;
    const frame = () => {
      raf = 0;
      // Damping keeps the camera moving for a few frames after the user lets go.
      if (gl.controls.update()) request();
      // Never below the ground plane.
      if (gl.camera.position.y < 5) gl.camera.position.y = 5;
      draw(gl, propsRef.current, overlayRef.current, hitsRef);
    };
    gl.controls.addEventListener("change", request);
    gl.controls.addEventListener("start", () => propsRef.current.onUserMove());
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      gl.renderer.setSize(w, h, false);
      gl.camera.aspect = w / Math.max(h, 1);
      gl.camera.updateProjectionMatrix();
      const o = overlayRef.current;
      if (o) {
        const dpr = window.devicePixelRatio || 1;
        o.width = Math.round(w * dpr);
        o.height = Math.round(h * dpr);
      }
      request();
    });
    ro.observe(wrap);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.dispose();
      glRef.current = null;
    };
  }, [data]);

  // Redraw when time, options or selection change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these props are read through propsRef when drawing
  useEffect(
    () => renderRef.current(),
    [props.t, props.trailS, props.labels, props.ground, props.selected, props.follow],
  );

  // Follow: move the orbit target with the selected object, keeping the camera's offset.
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !props.follow || props.selected === null) return;
    const tr = data.tracks.find((x) => x.uid === props.selected);
    const s = tr ? sampleAt(data, tr, props.t) : null;
    if (!s) return;
    const next = toWorld(s.x, s.y, s.alt);
    const delta = next.clone().sub(gl.controls.target);
    gl.controls.target.add(delta);
    gl.camera.position.add(delta);
    renderRef.current();
  }, [props.follow, props.selected, props.t, data]);

  // Frame an object requested from the tables: 6 km away, from the south-east, slightly above.
  useEffect(() => {
    const gl = glRef.current;
    const f = props.focus;
    if (!gl || !f) return;
    const tr = data.tracks.find((x) => x.uid === f.uid);
    const s = tr ? sampleAt(data, tr, Math.min(f.time, tr.t1)) : null;
    if (!s) return;
    const target = toWorld(s.x, s.y, s.alt);
    gl.controls.target.copy(target);
    gl.camera.position.copy(target).add(new Vector3(4200, 2500, 4200));
    renderRef.current();
  }, [props.focus, data]);

  // A click (no drag) selects the nearest symbol.
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const r = e.currentTarget.getBoundingClientRect();
    props.onSelect(pick(hitsRef.current, e.clientX - r.left, e.clientY - r.top, 14));
  };

  const frameView = (top: boolean) => {
    const gl = glRef.current;
    if (!gl) return;
    props.onUserMove();
    const { target, position } = framingCamera(data.focus, typicalAltitude(data), FOV);
    gl.controls.target.copy(target);
    if (top) gl.camera.position.set(target.x, target.y + position.distanceTo(target), target.z + 1);
    else gl.camera.position.copy(position);
    renderRef.current();
  };
  const dolly = (factor: number) => {
    const gl = glRef.current;
    if (!gl) return;
    const offset = gl.camera.position.clone().sub(gl.controls.target).multiplyScalar(factor);
    gl.camera.position.copy(gl.controls.target).add(offset);
    renderRef.current();
  };

  if (error)
    return (
      <p className="map-loading notice">
        The 3D view could not start ({error}). Switch to 2D to see the map.
      </p>
    );
  return (
    <div className="map-view" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas scene3d"
        tabIndex={0}
        aria-label="3D view. Drag to orbit, right-drag to pan, scroll to zoom, click an aircraft to select it. Space plays or pauses."
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />
      <canvas ref={overlayRef} className="scene-overlay" />
      <div className="map-zoom">
        <button type="button" className="secondary" aria-label="Zoom in" onClick={() => dolly(1 / 1.6)}>
          +
        </button>
        <button type="button" className="secondary" aria-label="Zoom out" onClick={() => dolly(1.6)}>
          −
        </button>
        <button type="button" className="secondary" title="Frame the action" onClick={() => frameView(false)}>
          Fit
        </button>
        <button
          type="button"
          className="secondary"
          title="Look straight down"
          onClick={() => frameView(true)}
        >
          Top
        </button>
      </div>
    </div>
  );
}

/** Median altitude of aircraft samples (camera target height for the initial view). */
function typicalAltitude(d: MapData): number {
  const alts: number[] = [];
  for (const tr of d.tracks) {
    if (tr.kind !== "air" && tr.kind !== "heli") continue;
    for (let i = 0; i < tr.count; i += 20) {
      const a = d.alt[tr.start + i] as number;
      if (Number.isFinite(a)) alts.push(a);
    }
  }
  alts.sort((a, b) => a - b);
  return alts.length ? (alts[Math.floor(alts.length / 2)] as number) : 3000;
}

function createScene(canvas: HTMLCanvasElement, data: MapData): Gl {
  const renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const theme = readTheme();
  const scene = new Scene();
  scene.background = new Color(theme.bg);
  const camera = new PerspectiveCamera(FOV, 1, 1, 3_000_000);
  const { target, position } = framingCamera(data.focus, typicalAltitude(data), FOV);
  camera.position.copy(position);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 30;
  controls.maxDistance = 1_500_000;

  scene.add(new HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new DirectionalLight(0xffffff, 1.2);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);

  // Ground: a plane at sea level with a 10 km grid over the theatre and a 1 km grid near the action.
  const groundColor = new Color(theme.bg).lerp(new Color(theme.gridText), 0.08);
  const groundMat = new MeshBasicMaterial({
    color: groundColor,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const ground = new Mesh(new PlaneGeometry(3_000_000, 3_000_000).rotateX(-Math.PI / 2), groundMat);
  scene.add(ground);
  const cx = (data.focus.minX + data.focus.maxX) / 2;
  const cz = -(data.focus.minY + data.focus.maxY) / 2;
  const gridColor = new Color(theme.gridText);
  const grids = [
    new GridHelper(2_000_000, 200, gridColor, gridColor),
    new GridHelper(200_000, 200, gridColor, gridColor),
  ];
  grids.forEach((g, i) => {
    g.position.set(Math.round(cx / 10000) * 10000, 0, Math.round(cz / 10000) * 10000);
    const mats = Array.isArray(g.material) ? g.material : [g.material];
    for (const m of mats) {
      m.transparent = true;
      m.opacity = i === 0 ? 0.22 : 0.1;
      m.depthWrite = false;
    }
    scene.add(g);
  });

  const lit = new MeshLambertMaterial({ side: DoubleSide });
  const flat = new MeshBasicMaterial({ side: DoubleSide });
  const make = (geo: BufferGeometry, mat: MeshBasicMaterial | MeshLambertMaterial) => {
    const m = new InstancedMesh(geo, mat, 1);
    m.count = 0;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  };
  const meshes: Record<MapKind, InstancedMesh> = {
    air: make(deltaGeometry(), lit),
    heli: make(deltaGeometry(0.8), lit),
    // A rod about 1/5 as thick as it is long, so it stays visible at its on-screen size.
    weapon: make(new CylinderGeometry(0.1, 0.1, 1, 8).rotateX(Math.PI / 2), flat),
    ground: make(new BoxGeometry(0.6, 0.35, 0.6), lit),
    sea: make(new BoxGeometry(0.35, 0.25, 1), lit),
    chute: make(new ConeGeometry(0.5, 0.45, 10, 1, true), lit),
    bullseye: make(new RingGeometry(0.42, 0.5, 40).rotateX(-Math.PI / 2), flat),
  };
  const killsNew = make(new OctahedronGeometry(0.5), new MeshBasicMaterial({ color: 0xf97316 }));
  const killsOld = make(
    new OctahedronGeometry(0.5),
    new MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5 }),
  );

  const lines = (opacity: number) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    g.setAttribute("color", new Float32BufferAttribute(new Float32Array(6), 3));
    const l = new LineSegments(g, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity }));
    l.frustumCulled = false;
    scene.add(l);
    return l;
  };
  const trail = lines(0.8);
  const drops = lines(0.25);

  return {
    renderer,
    scene,
    camera,
    controls,
    meshes,
    killsNew,
    killsOld,
    trail,
    drops,
    fineGrid: grids[1] as GridHelper,
    theme,
    dispose: () => {
      controls.dispose();
      scene.traverse((o) => {
        const m = o as Mesh;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) for (const x of mat) x.dispose();
        else mat?.dispose();
      });
      renderer.dispose();
    },
  };
}

/** A flat delta with a small fin: nose along −Z, wings along X, fin up along +Y. */
function deltaGeometry(size = 1): BufferGeometry {
  const s = size;
  const v = [
    // wing (XZ plane)
    0,
    0,
    -0.6 * s,
    -0.45 * s,
    0,
    0.45 * s,
    0.45 * s,
    0,
    0.45 * s,
    // fin (YZ plane)
    0,
    0,
    0.05 * s,
    0,
    0.28 * s,
    0.45 * s,
    0,
    0,
    0.45 * s,
  ];
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

const tmpSize = new Vector2();
const tmpM = new Matrix4();
const tmpS = new Vector3();
const tmpV = new Vector3();
const tmpC = new Color();
const noRot = new Quaternion();
const WHITE = new Color(1, 1, 1);
const colorCache = new Map<string, [number, number, number]>();
const sideRgb: ColorFn = (side) => {
  let c = colorCache.get(side);
  if (!c) {
    tmpC.set(sideColor(side));
    c = [tmpC.r, tmpC.g, tmpC.b];
    colorCache.set(side, c);
  }
  return c;
};

function draw(gl: Gl, p: ViewProps, overlay: HTMLCanvasElement | null, hitsRef: { current: ScreenHit[] }) {
  const { camera, renderer } = gl;
  const size = renderer.getSize(tmpSize);
  const w = size.x;
  const h = size.y;
  // World units per CSS pixel at distance 1, for constant on-screen symbol size.
  const perPx = (2 * Math.tan((camera.fov * Math.PI) / 180 / 2)) / Math.max(h, 1);
  const scaleAt = (pos: Vector3, px: number) => camera.position.distanceTo(pos) * perPx * px;

  const f = buildFrame(p.data, p.t, { trailS: p.trailS, ground: p.ground, selected: p.selected }, sideRgb);

  // Symbols, one instanced mesh per kind.
  const byKind: Record<string, typeof f.objects> = {};
  for (const o of f.objects) {
    const list = byKind[o.kind];
    if (list) list.push(o);
    else byKind[o.kind] = [o];
  }
  for (const kind of Object.keys(gl.meshes) as MapKind[]) {
    const list = byKind[kind] ?? [];
    const mesh = ensureCapacity(gl, kind, list.length);
    list.forEach((o, i) => {
      const px = PX[kind] * (o.uid === p.selected ? 1.5 : 1);
      const s = scaleAt(o.pos, px);
      const rot = kind === "ground" || kind === "chute" || kind === "bullseye" ? noRot : o.rot;
      tmpM.compose(kind === "bullseye" ? tmpV.set(o.pos.x, 1, o.pos.z) : o.pos, rot, tmpS.set(s, s, s));
      mesh.setMatrixAt(i, tmpM);
      const [r, g, b] = sideRgb(o.side);
      tmpC.setRGB(r, g, b);
      // Missiles in a lighter shade so they stand out against their own (side-coloured) trail.
      if (kind === "weapon") tmpC.lerp(WHITE, 0.55);
      mesh.setColorAt(i, tmpC);
    });
    mesh.count = list.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // Kill markers where victims went down: bright for a minute, then dim.
  const fresh = p.data.kills.filter((k) => k.time <= p.t && p.t - k.time <= KILL_FADE_S);
  const old = p.data.kills.filter((k) => p.t - k.time > KILL_FADE_S);
  for (const [mesh, list] of [
    [gl.killsNew, fresh],
    [gl.killsOld, old],
  ] as const) {
    const m = growKills(gl, mesh, list.length);
    list.forEach((k, i) => {
      const pos = toWorld(k.x, k.y, k.alt, tmpV);
      const s = scaleAt(pos, PX.kill);
      tmpM.compose(pos, noRot, tmpS.set(s, s, s));
      m.setMatrixAt(i, tmpM);
    });
    m.count = list.length;
    m.instanceMatrix.needsUpdate = true;
  }

  setLines(gl.trail, f.trail);
  setLines(gl.drops, f.drops);
  gl.fineGrid.visible = camera.position.distanceTo(gl.controls.target) < FINE_GRID_MAX_DIST_M;
  renderer.render(gl.scene, camera);

  // Labels and click targets, projected to the screen.
  const hits: ScreenHit[] = [];
  const labels: { text: string; x: number; y: number; first: boolean }[] = [];
  const cam = camera.position;
  for (const o of f.objects) {
    if (o.kind === "bullseye") continue;
    tmpV.copy(o.pos).project(camera);
    if (tmpV.z > 1 || tmpV.z < -1) continue; // behind the camera
    const sx = ((tmpV.x + 1) / 2) * w;
    const sy = ((1 - tmpV.y) / 2) * h;
    if (sx < -50 || sy < -50 || sx > w + 50 || sy > h + 50) continue;
    hits.push({ uid: o.uid, sx, sy });
    const selected = o.uid === p.selected;
    if ((p.labels && (o.kind === "air" || o.kind === "heli")) || selected) {
      const altFt = `${Math.round((o.alt * 3.28084) / 100) / 10}k ft`;
      const km = cam.distanceTo(o.pos) / 1000;
      labels.push({
        text: `${o.label} · ${altFt}${selected ? ` · ${km.toFixed(1)} km away` : ""}`,
        x: sx + 12,
        y: sy - 10,
        first: selected,
      });
    }
  }
  hitsRef.current = hits;
  if (overlay) {
    const ctx = overlay.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawLabels(ctx, labels, gl.theme);
    }
  }
}

function ensureCapacity(gl: Gl, kind: MapKind, n: number): InstancedMesh {
  const mesh = gl.meshes[kind];
  if (n <= mesh.instanceMatrix.count) return mesh;
  const bigger = new InstancedMesh(mesh.geometry, mesh.material, Math.max(16, 2 ** Math.ceil(Math.log2(n))));
  bigger.frustumCulled = false;
  gl.scene.remove(mesh);
  mesh.dispose();
  gl.scene.add(bigger);
  gl.meshes[kind] = bigger;
  return bigger;
}

function growKills(gl: Gl, mesh: InstancedMesh, n: number): InstancedMesh {
  if (n <= mesh.instanceMatrix.count) return mesh;
  const bigger = new InstancedMesh(mesh.geometry, mesh.material, Math.max(16, 2 ** Math.ceil(Math.log2(n))));
  bigger.frustumCulled = false;
  gl.scene.remove(mesh);
  mesh.dispose();
  gl.scene.add(bigger);
  if (mesh === gl.killsNew) gl.killsNew = bigger;
  else gl.killsOld = bigger;
  return bigger;
}

function setLines(l: LineSegments, seg: { positions: Float32Array; colors: Float32Array; count: number }) {
  const g = l.geometry;
  const pos = g.getAttribute("position") as BufferAttribute;
  if (seg.positions.length > pos.array.length) {
    const cap = 2 ** Math.ceil(Math.log2(seg.positions.length));
    g.setAttribute("position", new Float32BufferAttribute(new Float32Array(cap), 3));
    g.setAttribute("color", new Float32BufferAttribute(new Float32Array(cap), 3));
  }
  const p = g.getAttribute("position") as BufferAttribute;
  const c = g.getAttribute("color") as BufferAttribute;
  (p.array as Float32Array).set(seg.positions);
  (c.array as Float32Array).set(seg.colors);
  p.needsUpdate = true;
  c.needsUpdate = true;
  g.setDrawRange(0, seg.count);
}
