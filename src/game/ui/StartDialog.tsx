/** The New game dialog: a short header, then Single player and Multiplayer tabs. */
import type { ReactNode } from "react";
import { AI_SKILL_CHOICES, skillChoiceLabel } from "../ai/doctrine.ts";
import { ALTITUDES_FT, SCENARIOS, type ScenarioOptions, scenarioById } from "../sim/scenarios.ts";

export const LOADOUT_MISSILES = [4, 6, 8, 10] as const;

export type StartTab = "single" | "multi";

/** Start altitude, loadout and fog of war: the same controls in single player and the lobby. */
export function FightSettings({
  altFt,
  onAlt,
  missiles,
  onMissiles,
  fog,
  onFog,
  fogLabels = ["Off: see everything", "On: radar and RWR only"],
  disabled = false,
}: {
  altFt: number;
  onAlt: (a: number) => void;
  missiles: number;
  onMissiles: (n: number) => void;
  fog: boolean;
  onFog: (on: boolean) => void;
  fogLabels?: [string, string];
  disabled?: boolean;
}) {
  return (
    <>
      <div className="g-row">
        <span className="g-label">Start altitude</span>
        <div className="g-seg">
          {ALTITUDES_FT.map((a) => (
            <button
              type="button"
              key={a}
              disabled={disabled}
              className={a === altFt ? "on" : ""}
              onClick={() => onAlt(a)}
            >
              {(a / 1000).toFixed(0)}k ft
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">Loadout</span>
        <div className="g-seg">
          {LOADOUT_MISSILES.map((n) => (
            <button
              type="button"
              key={n}
              disabled={disabled}
              className={n === missiles ? "on" : ""}
              onClick={() => onMissiles(n)}
              title="Missiles per jet for both sides"
            >
              {n} missiles
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">Fog of war</span>
        <div className="g-seg">
          <button type="button" disabled={disabled} className={fog ? "" : "on"} onClick={() => onFog(false)}>
            {fogLabels[0]}
          </button>
          <button type="button" disabled={disabled} className={fog ? "on" : ""} onClick={() => onFog(true)}>
            {fogLabels[1]}
          </button>
        </div>
      </div>
    </>
  );
}

export function StartDialog({
  tab,
  onTab,
  onClose,
  single,
  multi,
}: {
  tab: StartTab;
  onTab: (t: StartTab) => void;
  onClose: (() => void) | null;
  single: ReactNode;
  multi: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape does too
    <div className="g-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="g-modal g-start" role="dialog" aria-label="New game">
        <h2>BVR Trainer</h2>
        <p className="g-muted g-intro">
          F/A-18C vs F/A-18C with AIM-120Cs. Altitude matters: thin air up high lets missiles fly much
          further.{" "}
          <span className="g-disclaimer-inline">
            Unofficial training game, simplified values; full notice at the bottom of the side panel.
          </span>
        </p>
        <div className="g-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "single"}
            className={tab === "single" ? "on" : ""}
            onClick={() => onTab("single")}
          >
            Single player
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "multi"}
            className={tab === "multi" ? "on" : ""}
            onClick={() => onTab("multi")}
          >
            Multiplayer
          </button>
        </div>
        <div role="tabpanel">{tab === "single" ? single : multi}</div>
        {onClose && (
          <div className="g-row g-end">
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SinglePlayerTab({
  scenarioId,
  onScenario,
  altFt,
  onAlt,
  missiles,
  onMissiles,
  options,
  onOptions,
  fog,
  onFog,
  onStart,
}: {
  scenarioId: string;
  onScenario: (id: string) => void;
  altFt: number;
  onAlt: (a: number) => void;
  missiles: number;
  onMissiles: (n: number) => void;
  options: ScenarioOptions;
  onOptions: (o: ScenarioOptions) => void;
  fog: boolean;
  onFog: (on: boolean) => void;
  onStart: () => void;
}) {
  const sel = scenarioById(scenarioId);
  return (
    <>
      <div className="g-scenarios">
        {SCENARIOS.filter((s) => !s.mpOnly).map((s) => (
          <label key={s.id} className={`g-scn ${s.id === scenarioId ? "on" : ""}`}>
            <input type="radio" name="scn" checked={s.id === scenarioId} onChange={() => onScenario(s.id)} />
            <b>{s.title}</b>
            <span className="g-muted">{s.summary}</span>
          </label>
        ))}
      </div>
      <p className="g-lesson">{sel.lesson}</p>
      <FightSettings
        altFt={altFt}
        onAlt={onAlt}
        missiles={missiles}
        onMissiles={onMissiles}
        fog={fog}
        onFog={onFog}
      />
      {sel.npc && (
        <>
          <div className="g-row">
            <span className="g-label">Bandits</span>
            <div className="g-seg">
              {AI_SKILL_CHOICES.map((k) => (
                <button
                  type="button"
                  key={k}
                  className={options.redSkill === k ? "on" : ""}
                  onClick={() => onOptions({ ...options, redSkill: k })}
                  title={k === "random" ? "Pick Easy, Normal, or Hard per NPC at spawn time" : undefined}
                >
                  {skillChoiceLabel(k)}
                </button>
              ))}
            </div>
          </div>
          <div className="g-row">
            <span className="g-label">Blue</span>
            <div className="g-seg">
              {!sel.allNpc && (
                <button
                  type="button"
                  className={options.blueAi === null ? "on" : ""}
                  onClick={() => onOptions({ ...options, blueAi: null })}
                >
                  You fly
                </button>
              )}
              {AI_SKILL_CHOICES.map((k) => {
                const activeBlue = sel.allNpc ? (options.blueAi ?? options.redSkill) : options.blueAi;
                return (
                  <button
                    type="button"
                    key={k}
                    className={activeBlue === k ? "on" : ""}
                    onClick={() => onOptions({ ...options, blueAi: k })}
                    title={
                      k === "random"
                        ? "Pick Easy, Normal, or Hard per Blue NPC at spawn time"
                        : "The NPC flies blue too: watch NPC vs NPC"
                    }
                  >
                    NPC {skillChoiceLabel(k)}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      <div className="g-row g-end">
        <button type="button" className="g-primary" onClick={onStart}>
          Start
        </button>
      </div>
    </>
  );
}
