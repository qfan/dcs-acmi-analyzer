/** The New game dialog: a short header, then Single player and Multiplayer tabs. */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BVR_TRAINER_VERSION } from "../../acmi/source.ts";
import { LanguageSelector } from "../../i18n/LanguageSelector.tsx";
import { AI_SKILL_CHOICES } from "../ai/doctrine.ts";
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
  fogLabels,
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
  const { t } = useTranslation();
  const resolvedFogLabels = fogLabels ?? [t("game.startDialog.fogOff"), t("game.startDialog.fogOn")];
  return (
    <>
      <div className="g-row">
        <span className="g-label">{t("game.startDialog.startAltitude")}</span>
        <div className="g-seg">
          {ALTITUDES_FT.map((a) => (
            <button
              type="button"
              key={a}
              disabled={disabled}
              className={a === altFt ? "on" : ""}
              onClick={() => onAlt(a)}
            >
              {t("game.startDialog.altKft", { k: (a / 1000).toFixed(0) })}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">{t("game.startDialog.loadout")}</span>
        <div className="g-seg">
          {LOADOUT_MISSILES.map((n) => (
            <button
              type="button"
              key={n}
              disabled={disabled}
              className={n === missiles ? "on" : ""}
              onClick={() => onMissiles(n)}
              title={t("game.startDialog.missilesTitle")}
            >
              {t("game.startDialog.missilesCount", { count: n })}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">{t("game.startDialog.fogOfWar")}</span>
        <div className="g-seg">
          <button type="button" disabled={disabled} className={fog ? "" : "on"} onClick={() => onFog(false)}>
            {resolvedFogLabels[0]}
          </button>
          <button type="button" disabled={disabled} className={fog ? "on" : ""} onClick={() => onFog(true)}>
            {resolvedFogLabels[1]}
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
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Escape does too
    <div className="g-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="g-modal g-start" role="dialog" aria-label={t("game.startDialog.aria")}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <h2>
            {t("game.title")} <span className="g-muted g-version">v{BVR_TRAINER_VERSION}</span>
          </h2>
          <LanguageSelector />
        </div>
        <p className="g-muted g-intro">
          {t("game.startDialog.intro")}{" "}
          <span className="g-disclaimer-inline">{t("game.startDialog.disclaimer")}</span>
        </p>
        <div className="g-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "single"}
            className={tab === "single" ? "on" : ""}
            onClick={() => onTab("single")}
          >
            {t("game.startDialog.singleTab")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "multi"}
            className={tab === "multi" ? "on" : ""}
            onClick={() => onTab("multi")}
          >
            {t("game.startDialog.multiTab")}
          </button>
        </div>
        <div role="tabpanel">{tab === "single" ? single : multi}</div>
        {onClose && (
          <div className="g-row g-end">
            <button type="button" onClick={onClose}>
              {t("common.close")}
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
  const { t } = useTranslation();
  const sel = scenarioById(scenarioId);
  return (
    <>
      <div className="g-scenarios">
        {SCENARIOS.filter((s) => !s.mpOnly).map((s) => (
          <label key={s.id} className={`g-scn ${s.id === scenarioId ? "on" : ""}`}>
            <input type="radio" name="scn" checked={s.id === scenarioId} onChange={() => onScenario(s.id)} />
            <b>{t(`game.scenarios.${s.id}.title`, { defaultValue: s.title })}</b>
            <span className="g-muted">
              {t(`game.scenarios.${s.id}.summary`, { defaultValue: s.summary })}
            </span>
          </label>
        ))}
      </div>
      <p className="g-lesson">{t(`game.scenarios.${sel.id}.lesson`, { defaultValue: sel.lesson })}</p>
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
            <span className="g-label">{t("game.startDialog.bandits")}</span>
            <div className="g-seg">
              {AI_SKILL_CHOICES.map((k) => (
                <button
                  type="button"
                  key={k}
                  className={options.redSkill === k ? "on" : ""}
                  onClick={() => onOptions({ ...options, redSkill: k })}
                  title={k === "random" ? t("game.startDialog.randomRedTitle") : undefined}
                >
                  {t(`game.skill.${k}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="g-row">
            <span className="g-label">{t("game.startDialog.blue")}</span>
            <div className="g-seg">
              {!sel.allNpc && (
                <button
                  type="button"
                  className={options.blueAi === null ? "on" : ""}
                  onClick={() => onOptions({ ...options, blueAi: null })}
                >
                  {t("game.startDialog.youFly")}
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
                        ? t("game.startDialog.randomBlueTitle")
                        : t("game.startDialog.watchNpcTitle")
                    }
                  >
                    {t("game.startDialog.npcSkill", { skill: t(`game.skill.${k}`) })}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      <div className="g-row g-end">
        <button type="button" className="g-primary" onClick={onStart}>
          {t("game.startDialog.startBtn")}
        </button>
      </div>
    </>
  );
}
