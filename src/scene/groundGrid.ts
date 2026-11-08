import { type Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3 } from "three";
import { GRID_FADE_FROM_PX, GRID_FADE_TO_PX, GRID_STEPS } from "./frame.ts";

/**
 * The ground plane with its distance grid, drawn in one shader with analytic anti-aliasing.
 *
 * Thin GL lines alias: once a line is thinner than a pixel it either hits a pixel or misses it,
 * so the grid shimmers as the camera moves and lines drop out at random when it stops. Here every
 * pixel works out how much of a line it covers from its distance to the nearest line, measured in
 * screen pixels (via the screen-space derivative fwidth). A line drifting across pixels then fades
 * smoothly from one to the next instead of popping, and each grid fades out where its cells shrink
 * to a few pixels (the far distance and the horizon), which removes moiré. No temporal tricks needed.
 */

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vGround;
void main() {
  // Plane-local position: the plane is centred on a point snapped to the coarsest grid, so local
  // coordinates line up with the grid and stay small (precise) near the camera.
  vGround = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform vec3 uGround;
uniform vec3 uLine;
uniform vec3 uCells;    // fine, medium, coarse cell sizes (metres)
uniform vec3 uStrength; // their line strengths
uniform float uLinePx;  // line width (device pixels)
uniform vec2 uFadePx;   // cell size (device pixels) over which a grid fades in
varying vec2 vGround;

// Coverage (0..1) of this pixel by the lines of one grid.
float gridLevel(vec2 p, float cell, float strength) {
  vec2 uv = p / cell;
  vec2 perPx = max(fwidth(uv), vec2(1e-7));               // cells per pixel, per axis
  vec2 distPx = abs(fract(uv + 0.5) - 0.5) / perPx;        // pixels to the nearest line
  vec2 cover = clamp(uLinePx * 0.5 + 0.5 - distPx, 0.0, 1.0);
  // Per axis, so lines running towards the horizon fade before they crowd together.
  vec2 fade = smoothstep(uFadePx.x, uFadePx.y, 1.0 / perPx);
  return max(cover.x * fade.x, cover.y * fade.y) * strength;
}

void main() {
  #include <logdepthbuf_fragment>
  float a = max(gridLevel(vGround, uCells.x, uStrength.x),
            max(gridLevel(vGround, uCells.y, uStrength.y), gridLevel(vGround, uCells.z, uStrength.z)));
  gl_FragColor = vec4(mix(uGround, uLine, a), 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface GroundGrid {
  material: ShaderMaterial;
  /** Set the grid unit (metres per km or nm) and the device pixel ratio. */
  configure: (unitM: number, pixelRatio: number) => void;
}

export function createGroundGrid(ground: Color, line: Color): GroundGrid {
  const own = {
    uGround: { value: ground.clone() },
    uLine: { value: line.clone() },
    uCells: { value: new Vector3() },
    // The 50-unit lines sit on 10-unit lines; slightly stronger so they read as major lines.
    uStrength: { value: new Vector3(0.14, 0.3, 0.4) },
    uLinePx: { value: 1 },
    uFadePx: { value: new Vector2(GRID_FADE_FROM_PX, GRID_FADE_TO_PX) },
  };
  const material = new ShaderMaterial({
    // Fog uniforms (three fills them in from scene.fog); merge clones them, ours are kept as they are.
    uniforms: { ...UniformsUtils.merge([UniformsLib.fog]), ...own },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    fog: true,
  });
  const configure = (unitM: number, pixelRatio: number) => {
    own.uCells.value.set(GRID_STEPS[0] * unitM, GRID_STEPS[1] * unitM, GRID_STEPS[2] * unitM);
    own.uLinePx.value = Math.max(1, pixelRatio);
    own.uFadePx.value.set(GRID_FADE_FROM_PX * pixelRatio, GRID_FADE_TO_PX * pixelRatio);
  };
  configure(1000, 1);
  return { material, configure };
}
