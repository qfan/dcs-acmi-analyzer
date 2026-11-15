/** Phase 1 drills. Each builds a fresh world at the altitude the player picked. */
import { makeJet } from "./aircraft.ts";
import { FT, NM } from "./atmosphere.ts";
import { ScriptedBot } from "./bot.ts";
import type { GameParams } from "./params.ts";
import { launchZone } from "./wez.ts";
import { makeWorld, type World } from "./world.ts";

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  /** What the drill teaches, shown before the start. */
  lesson: string;
  build(params: GameParams, altFt: number, seed: number): World;
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

export const SCENARIOS: Scenario[] = [
  {
    id: "duel",
    title: "Head-on duel",
    summary: "1v1 from 45 nm against a scripted bandit that shoots, cranks and defends.",
    lesson:
      "The bandit fires at about 70% of its maximum range (radar range permitting), cranks 50° to keep supporting its missile, and turns cold when your missile's seeker locks it. Take a good shot, support it to pitbull, and defend his.",
    build(params, altFt, seed) {
      const { w, red } = headOn(params, altFt, seed, 45);
      w.controllers.set(red.id, new ScriptedBot());
      return w;
    },
  },
  {
    id: "defend",
    title: "Defend a long shot",
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
