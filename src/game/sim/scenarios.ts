/** Scenarios: fights against the NPC (1v1, 2v2) and drills. Each builds a fresh world. */
import { AI_SKILLS, type AiSkillId, DoctrineBot } from "../ai/doctrine.ts";
import { type Jet, makeJet, type Side } from "./aircraft.ts";
import { FT, NM } from "./atmosphere.ts";
import { ScriptedBot } from "./bot.ts";
import type { GameParams } from "./params.ts";
import { launchZone } from "./wez.ts";
import { makeWorld, type World } from "./world.ts";

/** Who flies what. Drills ignore these (their opponents are scripted). */
export interface ScenarioOptions {
  /** NPC skill on the red side. */
  redSkill: AiSkillId;
  /** null: you fly blue. Otherwise the NPC flies blue too (watch mode: NPC vs NPC). */
  blueAi: AiSkillId | null;
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

/** Two flights facing each other `rangeNm` apart, `n` jets per side spread 5 nm abreast. */
function flights(params: GameParams, altFt: number, seed: number, rangeNm: number, n: number) {
  const w = makeWorld(params, seed);
  const alt = altFt * FT;
  const make = (side: Side, i: number): Jet => {
    const blue = side === "blue";
    const j = makeJet(params.aircraft, {
      id: `${blue ? "B" : "R"}${i + 1}`,
      side,
      callsign: `${blue ? "Viper" : "Bandit"} ${i + 1}`,
      x: (i - (n - 1) / 2) * 5 * NM,
      y: blue ? 0 : rangeNm * NM,
      altM: alt,
      hdgDeg: blue ? 0 : 180,
      mach: MACH,
    });
    j.chaff = Math.max(0, Math.round(params.countermeasures.chaff));
    j.flares = Math.max(0, Math.round(params.countermeasures.flares));
    return j;
  };
  for (let i = 0; i < n; i++) w.jets.push(make("blue", i));
  for (let i = 0; i < n; i++) w.jets.push(make("red", i));
  return w;
}

/** Pre-designates each blue jet onto the matching red jet at start when human-flown. */
function preTargetBlue(w: World): void {
  const blues = w.jets.filter((j) => j.side === "blue");
  const reds = w.jets.filter((j) => j.side === "red");
  for (let i = 0; i < blues.length; i++) {
    const b = blues[i];
    const r = reds[i] ?? reds[0];
    if (b && r) b.targetId = r.id;
  }
}

/** Puts NPC pilots in the jets the options say (multi-ship wingmen split on first merge; singletons randomize). */
function crewNpcs(w: World, opts: ScenarioOptions): void {
  const crew = (side: Side, skill: AiSkillId) => {
    const jets = w.jets.filter((x) => x.side === side);
    let dir: 1 | -1 | null = jets.length > 1 ? (w.rng() < 0.5 ? 1 : -1) : null;
    for (const j of jets) {
      w.controllers.set(j.id, new DoctrineBot(AI_SKILLS[skill], dir));
      if (dir !== null) dir = dir === 1 ? -1 : 1;
    }
  };
  crew("red", opts.redSkill);
  if (opts.blueAi) crew("blue", opts.blueAi);
}

export const SCENARIOS: Scenario[] = [
  {
    id: "duel",
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
    id: "2v2",
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
