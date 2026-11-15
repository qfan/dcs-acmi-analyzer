/** Per-browser conveniences: edited parameters, auto-pause settings and the last scenario. */

import { AI_SKILL_CHOICES, type AiSkillChoice } from "../ai/doctrine.ts";
import { type AutoPause, DEFAULT_AUTOPAUSE } from "../engine/session.ts";
import { cloneParams, DEFAULT_PARAMS, type GameParams, mergeParams } from "../sim/params.ts";
import { DEFAULT_OPTIONS, type ScenarioOptions } from "../sim/scenarios.ts";

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

export function loadLast(): { scenarioId: string; altFt: number; options: ScenarioOptions } | null {
  const v = read(LAST_KEY) as {
    scenarioId?: unknown;
    altFt?: unknown;
    options?: Partial<ScenarioOptions>;
  } | null;
  if (!v || typeof v.scenarioId !== "string" || typeof v.altFt !== "number") return null;
  const isSkill = (x: unknown): x is AiSkillChoice =>
    typeof x === "string" && (AI_SKILL_CHOICES as readonly string[]).includes(x);
  const o = v.options ?? {};
  return {
    scenarioId: v.scenarioId,
    altFt: v.altFt,
    options: {
      redSkill: isSkill(o.redSkill) ? o.redSkill : DEFAULT_OPTIONS.redSkill,
      blueAi: isSkill(o.blueAi) ? o.blueAi : null,
    },
  };
}

export function saveLast(scenarioId: string, altFt: number, options: ScenarioOptions): void {
  write(LAST_KEY, { scenarioId, altFt, options });
}

const MP_KEY = "bvr-trainer.mp.v2";
const MP_KEY_V1 = "bvr-trainer.mp.v1";
/** Custom relays remembered in this browser. */
export const MAX_RECENT_RELAYS = 5;

export interface MpPrefs {
  /** The name you play under. */
  name: string;
  /** Chosen relay address, or "" for Automatic. */
  relay: string;
  /** Custom relay addresses used lately, newest first. */
  recent: string[];
}

const isStr = (x: unknown): x is string => typeof x === "string";

export function loadMp(): MpPrefs {
  const v = read(MP_KEY) as { name?: unknown; relay?: unknown; recent?: unknown } | null;
  if (v) {
    return {
      name: isStr(v.name) ? v.name.slice(0, 24) : "",
      relay: isStr(v.relay) ? v.relay : "",
      recent: Array.isArray(v.recent) ? v.recent.filter(isStr).slice(0, MAX_RECENT_RELAYS) : [],
    };
  }
  // Earlier versions kept one relay address next to the name.
  const old = read(MP_KEY_V1) as { name?: unknown; relayUrl?: unknown } | null;
  const url = isStr(old?.relayUrl) ? old.relayUrl : "";
  return { name: isStr(old?.name) ? old.name.slice(0, 24) : "", relay: url, recent: url ? [url] : [] };
}

export function saveMp(p: MpPrefs): void {
  write(MP_KEY, { name: p.name, relay: p.relay, recent: p.recent.slice(0, MAX_RECENT_RELAYS) });
}

/** Puts a custom relay first in the recent list (deduplicated, capped). */
export function withRecent(recent: readonly string[], url: string): string[] {
  return [url, ...recent.filter((r) => r !== url)].slice(0, MAX_RECENT_RELAYS);
}
