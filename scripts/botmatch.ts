/**
 * Headless NPC-vs-NPC batches for tuning the AI: plays many fights and prints outcome rates.
 *
 *   node scripts/botmatch.ts [--scenario duel|2v2] [--blue normal] [--red normal] [--alt 25000] [--n 40]
 *
 * Every fight uses a different seed, so the same command always prints the same numbers.
 */
import { AI_SKILL_ORDER, type AiSkillId } from "../src/game/ai/doctrine.ts";
import { cloneParams, DEFAULT_PARAMS } from "../src/game/sim/params.ts";
import { scenarioById } from "../src/game/sim/scenarios.ts";
import { step } from "../src/game/sim/world.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

function skill(name: string): AiSkillId {
  if ((AI_SKILL_ORDER as string[]).includes(name)) return name as AiSkillId;
  throw new Error(`Unknown skill "${name}" (use ${AI_SKILL_ORDER.join(", ")})`);
}

const scenario = arg("scenario", "duel");
const blue = skill(arg("blue", "normal"));
const red = skill(arg("red", "normal"));
const altFt = Number(arg("alt", "25000"));
const n = Number(arg("n", "40"));

const counts: Record<string, number> = { win: 0, loss: 0, trade: 0, draw: 0 };
let time = 0;
const shots = { blue: 0, red: 0 };
const kills = { blue: 0, red: 0 };
const started = performance.now();
for (let seed = 1; seed <= n; seed++) {
  const w = scenarioById(scenario).build(cloneParams(DEFAULT_PARAMS), altFt, seed, {
    redSkill: red,
    blueAi: blue,
  });
  while (!w.outcome) step(w);
  counts[w.outcome.kind] = (counts[w.outcome.kind] ?? 0) + 1;
  time += w.t;
  for (const e of w.events) {
    if (e.type === "launch") shots[e.side]++;
    if (e.type === "kill") kills[e.side]++;
  }
}
const pct = (k: number) => `${((100 * k) / n).toFixed(0)}%`;
console.log(`${scenario} at ${altFt.toLocaleString("en-US")} ft, blue ${blue} vs red ${red}, ${n} fights`);
console.log(
  `  blue wins ${pct(counts.win ?? 0)} · red wins ${pct(counts.loss ?? 0)} · trades ${pct(counts.trade ?? 0)} · draws ${pct(counts.draw ?? 0)}`,
);
console.log(
  `  per fight: ${(time / n / 60).toFixed(1)} min · shots blue ${(shots.blue / n).toFixed(1)} red ${(shots.red / n).toFixed(1)} · kills blue ${(kills.blue / n).toFixed(1)} red ${(kills.red / n).toFixed(1)}`,
);
console.log(`  (${((performance.now() - started) / 1000).toFixed(1)} s)`);
