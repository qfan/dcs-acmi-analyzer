import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  Fog,
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
import { type FitTarget, fitAt } from "../map/fit.ts";
import type { MapKind } from "../map/mapData.ts";
import {
  drawLabels,
  drawSelectionRing,
  drawSightLine,
  pick,
  type ScreenHit,
  sideColor,
  type Theme,
} from "../map/render.ts";
import {
  buildFrame,
  type ColorFn,
  fogRange,
  framingCamera,
  GRID_STEPS,
  snapGridCentre,
  toWorld,
  visibleGridCells,
} from "../scene/frame.ts";
import { createGroundGrid, type GroundGrid } from "../scene/groundGrid.ts";
import { distanceUnitM, distanceUnitName, fmtDist, labelText } from "../settings/units.ts";
import { followTarget } from "./follow.ts";
import { readTheme } from "./Map2D.tsx";
import { useCtrlPick } from "./useCtrlPick.ts";
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
  /** Ground plane, drawn with its distance grid. */
  ground: Mesh;
  groundGrid: GroundGrid;
  theme: Theme;
  dispose: () => void;
}

export default function Scene3D(props: ViewProps) {
  const { t: tr } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<Gl | null>(null);
  const hitsRef = useRef<ScreenHit[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const renderRef = useRef<() => void>(() => {});
  /** Where camera follow last put the orbit centre (null when not following). */
  const followAtRef = useRef<Vector3 | null>(null);
  /** Camera distance follow last set, and the distance the user chose (by zooming) while following. */
  const followDistRef = useRef<{ set: number | null; preferred: number | null }>({
    set: null,
    preferred: null,
  });
  const [error, setError] = useState<string | null>(null);
  const { data } = props;

  // Create the WebGL scene once per recording.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let gl: Gl;
    try {
      // First view: what's alive at the current time (not the selection: that stays where it is).
      const now = propsRef.current;
      gl = createScene(canvas, fitAt(data, now.t, { primary: null, secondary: null }, now.ground));
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
    // Only a pan (right-drag, Shift+drag, two-finger touch) moves the orbit centre off a followed
    // object, so only that ends "follow". Rotating and zooming (towards the centre while following)
    // leave it in place: they just change the preferred viewing angle and distance.
    gl.controls.addEventListener("change", () => {
      const at = followAtRef.current;
      if (!at) return;
      const dist = gl.camera.position.distanceTo(gl.controls.target);
      if (gl.controls.target.distanceTo(at) > Math.max(0.5, dist * 1e-4)) {
        followAtRef.current = null;
        propsRef.current.onUserMove();
      }
    });
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
    [
      props.t,
      props.trailS,
      props.labels,
      props.ground,
      props.primary,
      props.secondary,
      props.follow,
      props.settings,
    ],
  );

  // While following, zoom towards the followed object (zoom-to-cursor would shift the focus point off it).
  useEffect(() => {
    const gl = glRef.current;
    if (gl) gl.controls.zoomToCursor = props.follow === "off";
  }, [props.follow]);

  // Camera follow: move the orbit target with the primary, the secondary, or the pair's midpoint,
  // keeping the camera's offset. For the pair, the camera stays at the distance the user zoomed to,
  // backing off beyond it only while the two would otherwise leave the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new follow mode or selection starts from the current distance
  useEffect(() => {
    followDistRef.current = { set: null, preferred: null };
  }, [props.follow, props.primary, props.secondary]);
  useEffect(() => {
    const gl = glRef.current;
    if (!gl) return;
    const f = followTarget(data, props.t, props.follow, {
      primary: props.primary,
      secondary: props.secondary,
    });
    if (!f) {
      followAtRef.current = null;
      return;
    }
    const next = toWorld(f.x, f.y, f.alt);
    const delta = next.clone().sub(gl.controls.target);
    gl.controls.target.add(delta);
    gl.camera.position.add(delta);
    const offset = gl.camera.position.clone().sub(gl.controls.target);
    const dist = followDistRef.current;
    // A distance other than the one follow last set means the user zoomed: that's the new preference.
    const current = offset.length();
    if (dist.set === null || Math.abs(current - dist.set) > 0.5) dist.preferred = current;
    if (f.basis === "pair") {
      const want = Math.max(dist.preferred ?? current, distanceToShow(f.radius, gl.camera));
      gl.camera.position.copy(gl.controls.target).add(offset.setLength(want));
    }
    dist.set = gl.camera.position.distanceTo(gl.controls.target);
    followAtRef.current = gl.controls.target.clone();
    renderRef.current();
  }, [props.follow, props.primary, props.secondary, props.t, data]);

  // Frame what the tables asked for: the pair if both exist, else the object, from the south-east.
  useEffect(() => {
    const gl = glRef.current;
    const f = props.focus;
    if (!gl || !f) return;
    const pair = fitAt(data, f.time, { primary: f.primary, secondary: f.secondary });
    const one = fitAt(data, f.time, { primary: f.uid, secondary: null });
    const fit = pair.basis === "pair" ? pair : one;
    if (fit.basis === "alive" || fit.basis === "recording") return;
    const target = toWorld(fit.x, fit.y, fit.alt);
    const dist = Math.max(6000, cameraForFit(fit).position.distanceTo(cameraForFit(fit).target));
    gl.controls.target.copy(target);
    gl.camera.position.copy(target).add(new Vector3(1, 0.6, 1).setLength(dist));
    // Not a pan: if following, the follow carries on from here.
    if (followAtRef.current) followAtRef.current = target.clone();
    renderRef.current();
  }, [props.focus, data]);

  useCtrlPick(wrapRef, hitsRef, props.onPick);

  // A plain click (no drag) picks the nearest symbol; Ctrl clicks are handled by useCtrlPick.
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const r = e.currentTarget.getBoundingClientRect();
    props.onPick(pick(hitsRef.current, e.clientX - r.left, e.clientY - r.top, 14), "primary", false);
  };

  // Fit: the pair, the selected object, else what's in the air now (see fitAt). Keeps the current
  // viewing direction; for a single selected object it only ever moves closer.
  const frameView = (top: boolean) => {
    const gl = glRef.current;
    if (!gl) return;
    // Fit re-frames on purpose and ends following; "Top" is just a viewing angle and keeps it.
    if (!top) props.onUserMove();
    const f = fitAt(data, props.t, { primary: props.primary, secondary: props.secondary }, props.ground);
    const { target, position } = cameraForFit(f);
    let dist = position.distanceTo(target);
    const current = gl.camera.position.distanceTo(gl.controls.target);
    if (f.basis === "selected") dist = Math.min(dist, current);
    const dir = gl.camera.position.clone().sub(gl.controls.target).normalize();
    gl.controls.target.copy(target);
    if (top) gl.camera.position.set(target.x, target.y + dist, target.z + 1);
    else gl.camera.position.copy(target).addScaledVector(dir, dist);
    followAtRef.current = top && followAtRef.current ? target.clone() : null;
    renderRef.current();
  };
  const dolly = (factor: number) => {
    const gl = glRef.current;
    if (!gl) return;
    const offset = gl.camera.position.clone().sub(gl.controls.target).multiplyScalar(factor);
    gl.camera.position.copy(gl.controls.target).add(offset);
    renderRef.current();
  };

  if (error) return <p className="map-loading notice">{tr("map.error3d", { error })}</p>;
  return (
    <div className="map-view" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="map-canvas scene3d"
        tabIndex={0}
        aria-label={tr("map.aria3d")}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />
      <canvas ref={overlayRef} className="scene-overlay" />
      <div className="map-zoom">
        <button
          type="button"
          className="secondary"
          aria-label={tr("map.zoomIn")}
          onClick={() => dolly(1 / 1.6)}
        >
          +
        </button>
        <button type="button" className="secondary" aria-label={tr("map.zoomOut")} onClick={() => dolly(1.6)}>
          −
        </button>
        <button
          type="button"
          className="secondary"
          title={
            props.primary !== null && props.secondary !== null
              ? tr("map.fitPair")
              : props.primary !== null || props.secondary !== null
                ? tr("map.fitObject")
                : tr("map.fitAll")
          }
          onClick={() => frameView(false)}
        >
          {tr("map.fit")}
        </button>
        <button
          type="button"
          className="secondary"
          title={tr("map.topTitle")}
          onClick={() => frameView(true)}
        >
          {tr("map.top")}
        </button>
      </div>
    </div>
  );
}

/** Camera distance at which a sphere of this radius just fits in the camera's view. */
function distanceToShow(radius: number, camera: PerspectiveCamera): number {
  const halfV = (camera.fov * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  return radius / Math.sin(Math.min(halfV, halfH));
}

/** Camera target and position (from the south-east, looking down ~35°) that show a fit target. */
function cameraForFit(f: FitTarget) {
  const box = { minX: f.x - f.radius, maxX: f.x + f.radius, minY: f.y - f.radius, maxY: f.y + f.radius };
  return framingCamera(box, f.alt, FOV);
}

function createScene(canvas: HTMLCanvasElement, initial: FitTarget): Gl {
  const renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const theme = readTheme();
  const scene = new Scene();
  scene.background = new Color(theme.bg);
  const camera = new PerspectiveCamera(FOV, 1, 1, 3_000_000);
  const { target, position } = cameraForFit(initial);
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

  // Ground: a plane at sea level drawn with its anti-aliased distance grid (see groundGrid.ts), kept
  // centred under what the camera looks at (see updateGround()). Fog fades it towards the horizon.
  scene.fog = new Fog(theme.bg, 100_000, 700_000);
  const groundGrid = createGroundGrid(
    new Color(theme.bg).lerp(new Color(theme.gridText), 0.08),
    new Color(theme.gridText),
  );
  // Pushed back a little in depth, so trails and drop lines touching the ground draw over it.
  groundGrid.material.polygonOffset = true;
  groundGrid.material.polygonOffsetFactor = 2;
  groundGrid.material.polygonOffsetUnits = 2;
  const ground = new Mesh(new PlaneGeometry(6_000_000, 6_000_000).rotateX(-Math.PI / 2), groundGrid.material);
  ground.frustumCulled = false;
  scene.add(ground);

  // Aircraft, weapons and trails ignore the fog: they must stay crisp at any distance.
  const lit = new MeshLambertMaterial({ side: DoubleSide, fog: false });
  const flat = new MeshBasicMaterial({ side: DoubleSide, fog: false });
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
  const killsNew = make(new OctahedronGeometry(0.5), new MeshBasicMaterial({ color: 0xf97316, fog: false }));
  const killsOld = make(
    new OctahedronGeometry(0.5),
    new MeshBasicMaterial({ color: 0x9ca3af, transparent: true, opacity: 0.5, fog: false }),
  );

  const lines = (opacity: number) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    g.setAttribute("color", new Float32BufferAttribute(new Float32Array(6), 3));
    const l = new LineSegments(
      g,
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity, fog: false }),
    );
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
    ground,
    groundGrid,
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

  const selectedUids = [p.primary, p.secondary].filter((u): u is number => u !== null);
  const f = buildFrame(
    p.data,
    p.t,
    { trailS: p.trailS, ground: p.ground, primary: p.primary, secondary: p.secondary },
    sideRgb,
  );

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
      const px = PX[kind] * (selectedUids.includes(o.uid) ? 1.5 : 1);
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
  const unitM = distanceUnitM(p.settings.units.distance);
  const gridCells = updateGround(gl, unitM, perPx);
  renderer.render(gl.scene, camera);

  // Labels and click targets, projected to the screen.
  const hits: ScreenHit[] = [];
  const labels: { text: string; x: number; y: number; first: boolean }[] = [];
  const rings: { sx: number; sy: number; role: "primary" | "secondary" }[] = [];
  for (const o of f.objects) {
    if (o.kind === "bullseye") continue;
    tmpV.copy(o.pos).project(camera);
    if (tmpV.z > 1 || tmpV.z < -1) continue; // behind the camera
    const sx = ((tmpV.x + 1) / 2) * w;
    const sy = ((1 - tmpV.y) / 2) * h;
    if (sx < -50 || sy < -50 || sx > w + 50 || sy > h + 50) continue;
    hits.push({ uid: o.uid, sx, sy });
    const role = o.uid === p.primary ? "primary" : o.uid === p.secondary ? "secondary" : null;
    if (role) rings.push({ sx, sy, role });
    if ((p.labels && (o.kind === "air" || o.kind === "heli")) || role) {
      const text = labelText(o.pilot, o.name, o.alt, o.speed, p.settings);
      labels.push({ text, x: sx + 14, y: sy - 12, first: role !== null });
    }
  }
  hitsRef.current = hits;
  // Line of sight between the pair (both in front of the camera), with the slant range.
  const a = f.objects.find((o) => o.uid === p.primary);
  const b = f.objects.find((o) => o.uid === p.secondary);
  const sight = a && b ? { a: toScreenPt(a.pos, camera, w, h), b: toScreenPt(b.pos, camera, w, h) } : null;
  if (overlay) {
    const ctx = overlay.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (a && b && sight?.a && sight.b)
        drawSightLine(
          ctx,
          sight.a,
          sight.b,
          fmtDist(a.pos.distanceTo(b.pos), p.settings.units.distance),
          gl.theme,
        );
      for (const r of rings) drawSelectionRing(ctx, r.sx, r.sy, r.role, gl.theme);
      drawLabels(ctx, labels, gl.theme);
      // Grid spacing note, bottom left (like the 2D map's scale text).
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = gl.theme.gridText;
      // The grid sizes visible where the camera looks, e.g. "grid 1 · 10 · 50 nm".
      const name = distanceUnitName(p.settings.units.distance);
      ctx.fillText(`grid ${gridCells.map((c) => c / unitM).join(" · ")} ${name}`, 12, h - 12);
    }
  }
}

/** Screen position (CSS px) of a world point, or null when it's behind the camera. */
function toScreenPt(pos: Vector3, camera: PerspectiveCamera, w: number, h: number): [number, number] | null {
  const v = tmpV2.copy(pos).project(camera);
  if (v.z > 1 || v.z < -1) return null;
  return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
}
const tmpV2 = new Vector3();

/**
 * Keep the ground under what the camera looks at, with the grid in the user's km or nm, and set the
 * fog to match the camera distance. The plane's centre snaps to the coarsest grid so the lines stay
 * put in the world as it moves. Returns the grid cell sizes clearly visible there (finest first).
 * `perPx` is world size per CSS pixel at distance 1.
 */
function updateGround(gl: Gl, unitM: number, perPx: number): number[] {
  const d = gl.camera.position.distanceTo(gl.controls.target);
  const target = gl.controls.target;
  const coarse = GRID_STEPS[2] * unitM;
  gl.ground.position.set(snapGridCentre(target.x, coarse), 0, snapGridCentre(target.z, coarse));
  gl.groundGrid.configure(unitM, gl.renderer.getPixelRatio());
  if (gl.scene.fog instanceof Fog) {
    const f = fogRange(d);
    gl.scene.fog.near = f.near;
    gl.scene.fog.far = f.far;
  }
  // Ground size of a pixel at the focus point, measured along the ground (the view is tilted).
  const height = Math.max(gl.camera.position.y - target.y, 1);
  const slant = Math.max(height / Math.max(d, 1), 0.2);
  return visibleGridCells((d * perPx) / slant, unitM);
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
