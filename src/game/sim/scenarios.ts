/** Scenarios: fights against the NPC (1v1, 2v2) and drills. Each builds a fresh world. */
import {
  AI_SKILL_ORDER,
  AI_SKILLS,
  type AiSkillChoice,
  type AiSkillId,
  DoctrineBot,
} from "../ai/doctrine.ts";
import { type Jet, makeJet, type Side } from "./aircraft.ts";
import { FT, NM } from "./atmosphere.ts";
import { ScriptedBot } from "./bot.ts";
import type { GameParams } from "./params.ts";
import { launchZone } from "./wez.ts";
import { makeWorld, type World } from "./world.ts";

/** Who flies what. Drills ignore these (their opponents are scripted). */
export interface ScenarioOptions {
  /** NPC skill choice on the red side ("random" picks per NPC at spawn time). */
  redSkill: AiSkillChoice;
  /** null: you fly blue. Otherwise the NPC flies blue too (watch mode: NPC vs NPC). */
  blueAi: AiSkillChoice | null;
}

export const DEFAULT_OPTIONS: ScenarioOptions = { redSkill: "normal", blueAi: null };

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  /** What the drill teaches, shown before the start. */
  lesson: string;
  /** Fights against the NPC: skill choices apply, and blue can be flown by the NPC. */
  npc: boolean;
  /** Always flown by NPCs on both sides (infinite demo mode). */
  allNpc?: boolean;
  /** Offered in multiplayer (each jet flown by a player or an NPC). */
  mp?: boolean;
  /** Only offered in multiplayer. */
  mpOnly?: boolean;
  build(params: GameParams, altFt: number, seed: number, opts?: ScenarioOptions): World;
}

export const ALTITUDES_FT = [5000, 15000, 25000, 35000] as const;

const MACH = 0.9;
/** Support drill: the drone turns this far (deg), this long (s) after the first shot at it. */
const SUPPORT_TURN_DEG = 30;
const SUPPORT_TURN_AFTER_S = 10;

function headOn(params: GameParams, altFt: number, seed: number, rangeNm: number, blueMissiles?: number) {
  const w = makeWorld(params, seed);
  const alt = altFt * FT;
  const blue = makeJet(params.aircraft, {
    id: "B1",
    side: "blue",
    callsign: "Viper 1",
    x: 0,
    y: 0,
    altM: alt,
    hdgDeg: 0,
    mach: MACH,
  });
  const red = makeJet(params.aircraft, {
    id: "R1",
    side: "red",
    callsign: "Bandit 1",
    x: 0,
    y: rangeNm * NM,
    altM: alt,
    hdgDeg: 180,
    mach: MACH,
  });
  if (blueMissiles !== undefined) blue.missiles = blueMissiles;
  for (const j of [blue, red]) {
    j.chaff = Math.max(0, Math.round(params.countermeasures.chaff));
    j.flares = Math.max(0, Math.round(params.countermeasures.flares));
  }
  blue.targetId = red.id;
  red.targetId = blue.id;
  w.jets.push(blue, red);
  return { w, blue, red };
}

/** Two flights facing each other `rangeNm` apart, jets on each side spread 5 nm abreast. */
function flights(
  params: GameParams,
  altFt: number,
  seed: number,
  rangeNm: number,
  blueCount: number,
  redCount = blueCount,
) {
  const w = makeWorld(params, seed);
  const alt = altFt * FT;
  const make = (side: Side, i: number, count: number): Jet => {
    const blue = side === "blue";
    const j = makeJet(params.aircraft, {
      id: `${blue ? "B" : "R"}${i + 1}`,
      side,
      callsign: `${blue ? "Viper" : "Bandit"} ${i + 1}`,
      x: (i - (count - 1) / 2) * 5 * NM,
      y: blue ? 0 : rangeNm * NM,
      altM: alt,
      hdgDeg: blue ? 0 : 180,
      mach: MACH,
    });
    j.chaff = Math.max(0, Math.round(params.countermeasures.chaff));
    j.flares = Math.max(0, Math.round(params.countermeasures.flares));
    return j;
  };
  for (let i = 0; i < blueCount; i++) w.jets.push(make("blue", i, blueCount));
  for (let i = 0; i < redCount; i++) w.jets.push(make("red", i, redCount));
  return w;
}

/** Pre-designates each blue jet onto the matching red jet at start when human-flown. */
function preTargetBlue(w: World): void {
  const blues = w.jets.filter((j) => j.side === "blue");
  const reds = w.jets.filter((j) => j.side === "red");
  for (let i = 0; i < blues.length; i++) {
    const b = blues[i];
    const r = reds.length > 0 ? reds[i % reds.length] : undefined;
    if (b && r) b.targetId = r.id;
  }
}

/** Helper to create one jet with default countermeasures and fuel/missile config from params. */
function spawnJet(
  params: GameParams,
  init: {
    id: string;
    side: Side;
    callsign: string;
    x: number;
    y: number;
    altM: number;
    hdgDeg: number;
  },
): Jet {
  const j = makeJet(params.aircraft, { ...init, mach: MACH });
  j.chaff = Math.max(0, Math.round(params.countermeasures.chaff));
  j.flares = Math.max(0, Math.round(params.countermeasures.flares));
  return j;
}

/** Resolves a skill choice to a concrete NPC skill for one spawned jet. */
function pickSkill(w: World, choice: AiSkillChoice): AiSkillId {
  if (choice !== "random") return choice;
  return AI_SKILL_ORDER[Math.floor(w.rng() * AI_SKILL_ORDER.length)] ?? "normal";
}

/** Puts NPC pilots in the jets the options say (multi-ship wingmen split on first merge; singletons randomize). */
function crewNpcs(w: World, opts: ScenarioOptions): void {
  const crew = (side: Side, choice: AiSkillChoice) => {
    const jets = w.jets.filter((x) => x.side === side);
    let dir: 1 | -1 | null = jets.length > 1 ? (w.rng() < 0.5 ? 1 : -1) : null;
    for (const j of jets) {
      w.controllers.set(j.id, new DoctrineBot(AI_SKILLS[pickSkill(w, choice)], dir));
      if (dir !== null) dir = dir === 1 ? -1 : 1;
    }
  };
  crew("red", opts.redSkill);
  if (opts.blueAi) crew("blue", opts.blueAi);
}

interface SpawnSlot {
  side: Side;
  x: number;
  y: number;
  altM: number;
  hdgDeg: number;
  choice: AiSkillChoice;
  dir: 1 | -1;
}

const DEMO_RANGE_NM = 120;
const DEMO_ROW_COLS = 3;
const DEMO_ROW_SPACE_NM = 5;
const DEMO_TRAIL_NM = 20;

function buildInfiniteDemo(
  params: GameParams,
  altFt: number,
  seed: number,
  opts: ScenarioOptions,
  infinite = true,
): World {
  const w = makeWorld(params, seed);
  w.infinite = infinite;
  const altM = altFt * FT;
  const blueChoice = opts.blueAi ?? opts.redSkill;
  const redChoice = opts.redSkill;
  const slots = new Map<string, SpawnSlot>();
  const spawned: Record<Side, number> = { blue: 0, red: 0 };

  const addSide = (side: Side, choice: AiSkillChoice) => {
    const blue = side === "blue";
    const hdgDeg = blue ? 0 : 180;
    let dir: 1 | -1 = w.rng() < 0.5 ? 1 : -1;
    for (let row = 0; row < 2; row++) {
      const y = (blue ? (row === 0 ? 0 : -row * DEMO_TRAIL_NM) : DEMO_RANGE_NM + row * DEMO_TRAIL_NM) * NM;
      for (let col = 0; col < DEMO_ROW_COLS; col++) {
        const x = (col - (DEMO_ROW_COLS - 1) / 2) * DEMO_ROW_SPACE_NM * NM;
        const n = ++spawned[side];
        const id = `${blue ? "B" : "R"}${n}`;
        const callsign = `${blue ? "Viper" : "Bandit"} ${n}`;
        const slot: SpawnSlot = { side, x, y, altM, hdgDeg, choice, dir };
        slots.set(id, slot);
        w.jets.push(spawnJet(params, { id, side, callsign, x, y, altM, hdgDeg }));
        w.controllers.set(id, new DoctrineBot(AI_SKILLS[pickSkill(w, choice)], dir));
        dir = dir === 1 ? -1 : 1;
      }
    }
  };

  addSide("blue", blueChoice);
  addSide("red", redChoice);
  if (!infinite) return w;

  w.respawn = (world, dead) => {
    const slot = slots.get(dead.id);
    if (!slot) return null;
    slots.delete(dead.id);
    const blue = slot.side === "blue";
    const n = ++spawned[slot.side];
    const id = `${blue ? "B" : "R"}${n}`;
    const callsign = `${blue ? "Viper" : "Bandit"} ${n}`;
    slots.set(id, slot);
    return {
      jet: spawnJet(params, {
        id,
        side: slot.side,
        callsign,
        x: slot.x,
        y: slot.y,
        altM: slot.altM,
        hdgDeg: slot.hdgDeg,
      }),
      controller: new DoctrineBot(AI_SKILLS[pickSkill(world, slot.choice)], slot.dir),
    };
  };

  return w;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "duel",
    mp: true,
    title: "Head-on duel",
    summary: "1v1 from 60 nm against the NPC. Pick its skill, or let the NPC fly your jet too and watch.",
    lesson:
      "The NPC flies BVR doctrine from its own radar and RWR only: it commits, shoots inside a fraction of its Rmax, cranks to support its missile, pumps after pitbull (Normal and Hard), and turns cold when an active missile shows on its RWR. It has the same picture you would have with fog of war on.",
    npc: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      const w = flights(params, altFt, seed, 60, 1);
      crewNpcs(w, opts);
      if (!opts.blueAi) preTargetBlue(w);
      return w;
    },
  },
  {
    id: "2v1",
    mp: true,
    title: "Two-ship vs one",
    summary: "2v1 from 60 nm. You fly both blue jets against one bandit, or watch NPC vs NPC.",
    lesson:
      "Two ships against one let you bracket the bandit: split your wingmen to force it to defend one side while the other presses in. Click a jet to select it, Shift+click to add the other, and give orders to both at once.",
    npc: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      const w = flights(params, altFt, seed, 60, 2, 1);
      crewNpcs(w, opts);
      if (!opts.blueAi) preTargetBlue(w);
      return w;
    },
  },
  {
    id: "2v2",
    mp: true,
    title: "Two-ship vs two-ship",
    summary: "2v2 from 60 nm. You fly both blue jets (select one or both), or watch NPC vs NPC.",
    lesson:
      "Each side shares its radar picture. The NPCs sort targets (each wingman takes a different bandit when it can) and crank to opposite sides. Click a jet to select it, Shift+click to add the other, and give orders to both at once.",
    npc: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      const w = flights(params, altFt, seed, 60, 2);
      crewNpcs(w, opts);
      if (!opts.blueAi) preTargetBlue(w);
      return w;
    },
  },
  {
    id: "4v2",
    mp: true,
    title: "Four-ship (2x2) vs two-ship",
    summary:
      "4v2 from 60 nm. Blue has two 2-ship elements (5 nm abreast, second group 20 nm in trail) vs 2 bandits (5 nm abreast).",
    lesson:
      "Lead with the front two-ship to engage and force the bandits defensive while the trailing two-ship 20 nm behind presses the advantage or covers their pump. Click or Shift+click jets to task elements separately.",
    npc: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      const w = makeWorld(params, seed);
      const altM = altFt * FT;
      for (let row = 0; row < 2; row++) {
        const y = row === 0 ? 0 : -row * 20 * NM;
        for (let col = 0; col < 2; col++) {
          const n = row * 2 + col + 1;
          w.jets.push(
            spawnJet(params, {
              id: `B${n}`,
              side: "blue",
              callsign: `Viper ${n}`,
              x: (col - 0.5) * 5 * NM,
              y,
              altM,
              hdgDeg: 0,
            }),
          );
        }
      }
      for (let col = 0; col < 2; col++) {
        const n = col + 1;
        w.jets.push(
          spawnJet(params, {
            id: `R${n}`,
            side: "red",
            callsign: `Bandit ${n}`,
            x: (col - 0.5) * 5 * NM,
            y: 60 * NM,
            altM,
            hdgDeg: 180,
          }),
        );
      }
      crewNpcs(w, opts);
      if (!opts.blueAi) preTargetBlue(w);
      return w;
    },
  },
  {
    id: "infinite",
    title: "6v6 Endless Demo",
    summary:
      "6v6 all-NPC battle from 120 nm in 3x2 waves. Destroyed jets respawn at their initial slot with no end condition.",
    lesson:
      "Both sides spawn in two 3-ship lines (5 nm lateral spacing, 20 nm in trail) separated by 120 nm. Any lost aircraft is replaced at its starting post so the BVR engagement runs indefinitely. ACMI recording is disabled in this mode.",
    npc: true,
    allNpc: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      return buildInfiniteDemo(params, altFt, seed, opts);
    },
  },
  {
    id: "6v6",
    title: "Six-ship vs six-ship",
    summary: "6v6 from 120 nm in two 3-ship lines per side, 20 nm in trail. No respawns.",
    lesson:
      "Each side flies two 3-ship lines 5 nm abreast, the second 20 nm behind the first. Sort targets across the flight, and let the trailing line cover the front line's pump.",
    npc: true,
    mp: true,
    mpOnly: true,
    build(params, altFt, seed, opts = DEFAULT_OPTIONS) {
      return buildInfiniteDemo(params, altFt, seed, opts, false);
    },
  },
  {
    id: "defend",
    title: "Defend a long shot",
    npc: false,
    summary: "The bandit fires at you at once. You have no missiles: survive.",
    lesson:
      "A missile fired near maximum range has little energy to spare. Turning cold early makes it chase you until it runs out of energy; staying hot too long lets it reach you. Try waiting a little longer each time to find the latest safe turn.",
    build(params, altFt, seed) {
      // Start just inside the bandit's Rmax so it shoots straight away.
      const probe = headOn(params, altFt, seed, 40, 0);
      const rmax = launchZone(params.missile, probe.red, probe.blue).rmaxNm;
      const start = Math.max(5, Math.min(params.radar.rangeNm - 1, rmax * 0.95));
      const { w, red } = headOn(params, altFt, seed, start, 0);
      red.missiles = 1;
      w.objective = "survive";
      w.controllers.set(red.id, new ScriptedBot({ fireFracRmax: 1.0, defendOn: null }));
      return w;
    },
  },
  {
    id: "support",
    title: "Support your shot",
    npc: false,
    summary: "A target drone flies at you and turns 30° ten seconds after you shoot. Best at 35,000 ft.",
    lesson:
      "Until pitbull your missile only knows where the target is while your radar still tracks it. At 35,000 ft, shoot from about 30 nm. Keep the drone inside your radar gimbal (crank, don't turn cold) and the missile follows its turn. Turn cold right after the shot and the missile flies to where the drone would have been, and its seeker finds empty sky. From 20 nm it hardly matters: pitbull comes before the error grows.",
    build(params, altFt, seed) {
      const { w, blue, red } = headOn(params, altFt, seed, 38, 2);
      red.callsign = "Drone";
      red.missiles = 0;
      blue.missiles = Math.min(2, params.aircraft.missiles);
      w.controllers.set(
        red.id,
        new ScriptedBot({
          fireFracRmax: null,
          defendOn: null,
          beamAfterLaunchS: SUPPORT_TURN_AFTER_S,
          beamTurnDeg: SUPPORT_TURN_DEG,
        }),
      );
      return w;
    },
  },
];

export const scenarioById = (id: string): Scenario =>
  SCENARIOS.find((s) => s.id === id) ?? (SCENARIOS[0] as Scenario);

/** Who flies one jet in multiplayer: a player, an NPC of some skill, or nobody (jet removed). */
export type SlotCrew = "human" | AiSkillChoice | "closed";

/** The jets a scenario spawns, for the multiplayer slot list. */
export function scenarioSlots(
  id: string,
  params: GameParams,
): { id: string; side: Side; callsign: string }[] {
  const w = scenarioById(id).build(params, 25000, 1, { redSkill: "normal", blueAi: "normal" });
  return w.jets.map((j) => ({ id: j.id, side: j.side, callsign: j.callsign }));
}

/**
 * Builds a multiplayer fight: the scenario's jets, each crewed as `crew` says (missing entries fly
 * as Normal NPCs). Closed jets are removed. Player jets start pre-targeted on a matching bandit.
 */
export function buildMultiplayer(
  id: string,
  params: GameParams,
  altFt: number,
  seed: number,
  crew: Record<string, SlotCrew>,
): World {
  const w = scenarioById(id).build(params, altFt, seed, { redSkill: "normal", blueAi: "normal" });
  w.jets = w.jets.filter((j) => crew[j.id] !== "closed");
  w.controllers.clear();
  for (const side of ["blue", "red"] as Side[]) {
    const jets = w.jets.filter((j) => j.side === side);
    let dir: 1 | -1 | null = jets.length > 1 ? (w.rng() < 0.5 ? 1 : -1) : null;
    for (const j of jets) {
      const c = crew[j.id] ?? "normal";
      if (c !== "human" && c !== "closed")
        w.controllers.set(j.id, new DoctrineBot(AI_SKILLS[pickSkill(w, c)], dir));
      if (dir !== null) dir = dir === 1 ? -1 : 1;
    }
    const enemies = w.jets.filter((j) => j.side !== side);
    jets.forEach((j, i) => {
      j.targetId =
        crew[j.id] === "human" && enemies.length > 0 ? (enemies[i % enemies.length]?.id ?? null) : null;
    });
  }
  return w;
}

/** Puts a Normal NPC in a jet whose player left the match. */
export function npcTakeover(w: World, jetId: string, skill: AiSkillId = "normal"): void {
  w.controllers.set(jetId, new DoctrineBot(AI_SKILLS[skill], null));
}
