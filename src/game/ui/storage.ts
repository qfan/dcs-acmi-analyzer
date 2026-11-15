/** Per-browser conveniences: edited parameters, auto-pause settings and the last scenario. */
import { cloneParams, DEFAULT_PARAMS, type GameParams, mergeParams } from "../sim/params.ts";
import { type AutoPause, DEFAULT_AUTOPAUSE } from "./session.ts";

const PARAMS_KEY = "bvr-trainer.params.v1";
const AUTOPAUSE_KEY = "bvr-trainer.autopause.v2";
const LAST_KEY = "bvr-trainer.last.v1";

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private window etc.): settings just don't persist.
  }
}

export function loadParams(): GameParams {
  const saved = read(PARAMS_KEY);
  return saved ? mergeParams(saved) : cloneParams(DEFAULT_PARAMS);
}

export function saveParams(p: GameParams | null): void {
  write(PARAMS_KEY, p);
}

export function loadAutoPause(): AutoPause {
  const saved = read(AUTOPAUSE_KEY) as Partial<AutoPause> | null;
  const out = { ...DEFAULT_AUTOPAUSE };
  if (saved && typeof saved === "object")
    for (const k of Object.keys(out) as (keyof AutoPause)[]) {
      const v = saved[k];
      if (typeof v === typeof out[k]) (out as Record<string, unknown>)[k] = v;
    }
  return out;
}

export function saveAutoPause(a: AutoPause): void {
  write(AUTOPAUSE_KEY, a);
}

export function loadLast(): { scenarioId: string; altFt: number } | null {
  const v = read(LAST_KEY) as { scenarioId?: unknown; altFt?: unknown } | null;
  if (v && typeof v.scenarioId === "string" && typeof v.altFt === "number")
    return { scenarioId: v.scenarioId, altFt: v.altFt };
  return null;
}

export function saveLast(scenarioId: string, altFt: number): void {
  write(LAST_KEY, { scenarioId, altFt });
}
