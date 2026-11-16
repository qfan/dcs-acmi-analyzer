import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { DistanceUnit } from "../../settings/schema.ts";
import { distanceUnitM, distanceUnitName, fmtDist } from "../../settings/units.ts";
import {
  analyzeSuddenReactions,
  type CohortSplitMode,
  compareCohorts,
  DEFEAT_MODE_COLORS,
  type NotchGateAnalysis,
  type PilotReport,
  type ShotTacticalMetrics,
  type SuddenReactionRangeBin,
} from "../derive.ts";
import {
  ALTITUDE_BAND_ORDER,
  ALTITUDE_BANDS,
  type AltitudeBand,
  type FittedMissile,
  tierAltitudeScales,
} from "../missileReach.ts";
import { A2A_MISSILE_CLASSES, type MissileEngagement, type WeaponClass } from "../model.ts";
import type { DefeatModeSummary, DefenseTypeSummary } from "../query.ts";
import {
  BVR_TIMELINE_ROWS,
  type BvrThreatTier,
  type BvrTimelineRowKey,
  type BvrTimelineTable,
  cloneTimelineTable,
  DEFAULT_MILSIM_TIMELINE,
  evaluateBvrTimeline,
  type GateVerdictStatus,
  scaleTimelineTable,
  THREAT_TIER_META,
  THREAT_TIER_ORDER,
  type ThreatTierValidation,
} from "../timeline.ts";
import {
  DEFAULT_GATE_CLOSURE_KT,
  KNEEBOARD_PLAN_ORDER,
  KNEEBOARD_PLANS,
  type KneeboardPlan,
  type KneeboardTheme,
  renderKneeboardCanvas,
  saveCanvasPng,
} from "../timelineImage.ts";

const KT_MS = 1852 / 3600;

function timelineTablesEqual(a: BvrTimelineTable, b: BvrTimelineTable): boolean {
  return THREAT_TIER_ORDER.every((tier) => BVR_TIMELINE_ROWS.every((r) => a[tier][r.key] === b[tier][r.key]));
}
/** Fewest hot BVR shots before the loaded data's median closure is offered for gate times. */
const MIN_CLOSURE_SAMPLES = 8;
/** Target aspect at launch at or above this counts as hot (180° = pure head-on). */
const HOT_ASPECT_DEG = 135;

/** Median closure (kt) at launch over hot-aspect BVR missile shots (> 10 nm), or null with too few. */
function medianBvrLaunchClosureKt(engagements: MissileEngagement[]): { kt: number; n: number } | null {
  const xs = engagements
    .filter(
      (e) =>
        e.domain === "A2A" &&
        !e.isGun &&
        e.initial !== null &&
        e.initial.slantRangeM > 10 * 1852 &&
        // target pointing at the shooter: the both-hot geometry the gate times assume
        e.initial.aspectDeg >= HOT_ASPECT_DEG &&
        e.initial.closureMs > 0,
    )
    .map((e) => (e.initial?.closureMs ?? 0) / KT_MS)
    .sort((a, b) => a - b);
  if (xs.length < MIN_CLOSURE_SAMPLES) return null;
  const mid = xs.length >> 1;
  const med = xs.length % 2 ? (xs[mid] ?? 0) : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
  return { kt: Math.round(med / 10) * 10, n: xs.length };
}

const SAMPLE_CONF_BADGE: Record<"high" | "moderate" | "low", { color: string; bg: string }> = {
  high: {
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.14)",
  },
  moderate: {
    color: "#eab308",
    bg: "rgba(234, 179, 8, 0.15)",
  },
  low: {
    color: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.15)",
  },
};

export function PatchComparisonCard({
  engagements,
  tacticsById,
  selectedPatches,
  distanceUnit,
  onTogglePatch,
}: {
  engagements: MissileEngagement[];
  tacticsById: Map<string, ShotTacticalMetrics>;
  selectedPatches: string[];
  distanceUnit: DistanceUnit;
  onTogglePatch: (patch: string) => void;
}) {
  const { t } = useTranslation();
  const [splitMode, setSplitMode] = useState<CohortSplitMode>("dcsPatch");
  const [cutoffDate, setCutoffDate] = useState("2025-03-01");
  const [minCohortShots, setMinCohortShots] = useState<number>(0);
  const [hideNoisyAlerts, setHideNoisyAlerts] = useState<boolean>(false);

  const { cohorts, alerts } = useMemo(
    () => compareCohorts(engagements, tacticsById, splitMode, cutoffDate),
    [engagements, tacticsById, splitMode, cutoffDate],
  );

  const visibleCohorts = cohorts.filter((c) => c.shots >= minCohortShots);
  const visibleAlerts = hideNoisyAlerts ? alerts.filter((a) => a.chanceProb < 0.15) : alerts;

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>{t("analytics.bvr.patch.title")}</h3>
          <p className="muted small matrix-sub">
            <Trans i18nKey="analytics.bvr.patch.sub" components={[<strong key="0" />, <strong key="1" />]} />
          </p>
        </div>
        <div className="chart-controls">
          <label className="small muted">
            {t("analytics.bvr.patch.minShots")}{" "}
            <select value={minCohortShots} onChange={(e) => setMinCohortShots(Number(e.target.value))}>
              <option value={0}>{t("analytics.bvr.patch.allCohorts")}</option>
              <option value={10}>{t("analytics.bvr.patch.geShots", { count: 10 })}</option>
              <option value={25}>{t("analytics.bvr.patch.geShots", { count: 25 })}</option>
            </select>
          </label>
          <label className="toggle small muted">
            <input
              type="checkbox"
              checked={hideNoisyAlerts}
              onChange={(e) => setHideNoisyAlerts(e.target.checked)}
            />{" "}
            {t("analytics.bvr.patch.hideNoisy")}
          </label>
          {splitMode === "dateCutoff" && (
            <label className="small muted">
              {t("analytics.bvr.patch.splitDate")}{" "}
              <input
                type="date"
                value={cutoffDate}
                onChange={(e) => setCutoffDate(e.target.value)}
                style={{ width: 135 }}
              />
            </label>
          )}
          <fieldset className="mode-switch" aria-label={t("analytics.bvr.patch.splitAria")}>
            <button
              type="button"
              className={splitMode === "dcsPatch" ? "on" : ""}
              onClick={() => setSplitMode("dcsPatch")}
            >
              {t("analytics.bvr.patch.byPatch")}
            </button>
            <button
              type="button"
              className={splitMode === "month" ? "on" : ""}
              onClick={() => setSplitMode("month")}
            >
              {t("analytics.bvr.patch.byMonth")}
            </button>
            <button
              type="button"
              className={splitMode === "dateCutoff" ? "on" : ""}
              onClick={() => setSplitMode("dateCutoff")}
            >
              {t("analytics.bvr.patch.byDateCutoff")}
            </button>
          </fieldset>
        </div>
      </div>

      {visibleAlerts.length > 0 && (
        <div className="patch-alerts">
          {visibleAlerts.map((a) => {
            const sigColor = a.chanceProb < 0.05 ? "#10b981" : a.chanceProb < 0.15 ? "#eab308" : "#94a3b8";
            const sigBg =
              a.chanceProb < 0.05
                ? "rgba(16, 185, 129, 0.15)"
                : a.chanceProb < 0.15
                  ? "rgba(234, 179, 8, 0.15)"
                  : "rgba(148, 163, 184, 0.14)";
            return (
              <div
                key={`${a.fromCohort}:${a.toCohort}:${a.summary}`}
                className={`patch-alert-item severity-${a.severity}`}
                style={{
                  opacity: a.chanceProb >= 0.25 ? 0.78 : 1,
                  flexWrap: "wrap",
                }}
              >
                <span className="badge info">
                  {a.fromCohort} → {a.toCohort}
                </span>
                <span>{a.summary}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 11.5,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: sigBg,
                    color: sigColor,
                    fontWeight: 600,
                  }}
                  title={t("analytics.bvr.patch.alertTitle", { note: a.chanceNote })}
                >
                  {a.chanceProb < 0.05
                    ? t("analytics.bvr.patch.sig", { p: a.chanceProb.toFixed(3) })
                    : a.chanceProb < 0.15
                      ? t("analytics.bvr.patch.borderline", { p: a.chanceProb.toFixed(2) })
                      : t("analytics.bvr.patch.noise", { p: a.chanceProb.toFixed(2) })}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="table-wrap">
        <table className="records">
          <thead>
            <tr>
              <th>{t("analytics.bvr.patch.cohortCol")}</th>
              <th className="num" title={t("analytics.bvr.patch.sortiesTitle")}>
                {t("analytics.bvr.patch.sortiesCol")}
              </th>
              <th className="num">{t("analytics.bvr.patch.shotsCol")}</th>
              <th className="num">{t("analytics.bvr.patch.killsCol")}</th>
              <th className="num" title={t("analytics.bvr.patch.pkTitle")}>
                {t("analytics.bvr.patch.pkCol")}
              </th>
              <th className="num" title={t("analytics.bvr.patch.bvrTitle")}>
                {t("analytics.bvr.patch.bvrCol")}
              </th>
              <th className="num" title={t("analytics.bvr.patch.medShotTitle")}>
                {t("analytics.bvr.patch.medShotCol")}
              </th>
              <th className="num" title={t("analytics.bvr.patch.medKillTitle")}>
                {t("analytics.bvr.patch.medKillCol")}
              </th>
              <th className="num">{t("analytics.bvr.patch.maxKillCol")}</th>
              <th className="num">{t("analytics.bvr.patch.headOnMaxCol")}</th>
              <th className="num" title={t("analytics.bvr.patch.medMachTitle")}>
                {t("analytics.bvr.patch.medMachCol")}
              </th>
              <th className="num">{t("analytics.bvr.patch.notchGateCol")}</th>
              <th className="num" title={t("analytics.bvr.patch.adjPTitle")}>
                {t("analytics.bvr.patch.adjPCol")}
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleCohorts.map((c) => {
              const canFilter = splitMode === "dcsPatch" && !c.cohortKey.startsWith("Unknown");
              const isSelected = canFilter && selectedPatches.includes(c.cohortKey);
              const confBadge = SAMPLE_CONF_BADGE[c.sampleConfidence];
              return (
                <tr
                  key={c.cohortKey}
                  className={isSelected ? "selected-row" : ""}
                  style={{ cursor: canFilter ? "pointer" : "default" }}
                  onClick={() => {
                    if (canFilter) onTogglePatch(c.cohortKey);
                  }}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <strong>{c.label}</strong>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 5px",
                          borderRadius: 4,
                          background: confBadge.bg,
                          color: confBadge.color,
                          fontWeight: 600,
                        }}
                        title={t(`analytics.bvr.sampleConf.${c.sampleConfidence}.title`)}
                      >
                        {t(`analytics.bvr.sampleConf.${c.sampleConfidence}.label`)}
                      </span>
                    </div>
                  </td>
                  <td className="num">{c.fileCount}</td>
                  <td className="num">{c.shots}</td>
                  <td className="num">
                    <strong>{c.kills}</strong>
                  </td>
                  <td className="num">
                    {c.pk !== null ? (
                      <>
                        <strong>{Math.round(c.pk * 100)}%</strong>{" "}
                        {c.pkCi && (
                          <span className="muted small">
                            ({Math.round(c.pkCi.lo * 100)}–{Math.round(c.pkCi.hi * 100)}%)
                          </span>
                        )}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="num">
                    {c.bvrKills}/{c.bvrShots}
                    {c.bvrPk !== null ? (
                      <span className="muted small">
                        {" "}
                        ({Math.round(c.bvrPk * 100)}%
                        {c.bvrPkCi
                          ? `, CI ${Math.round(c.bvrPkCi.lo * 100)}–${Math.round(c.bvrPkCi.hi * 100)}%`
                          : ""}
                        )
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="num">
                    <div>{fmtDist(c.medianShotRangeM, distanceUnit)}</div>
                    {c.medianShotRangeCi && (
                      <div className="muted small" style={{ fontSize: 10.5 }}>
                        CI: {fmtDist(c.medianShotRangeCi.lo, distanceUnit)}–
                        {fmtDist(c.medianShotRangeCi.hi, distanceUnit)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <div>{fmtDist(c.medianKillRangeM, distanceUnit)}</div>
                    {c.medianKillRangeCi && (
                      <div className="muted small" style={{ fontSize: 10.5 }}>
                        CI: {fmtDist(c.medianKillRangeCi.lo, distanceUnit)}–
                        {fmtDist(c.medianKillRangeCi.hi, distanceUnit)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <strong>{fmtDist(c.maxKillRangeM, distanceUnit)}</strong>
                  </td>
                  <td className="num">
                    <strong>{fmtDist(c.headOnMaxKillRangeM, distanceUnit)}</strong>
                    {c.headOnShots > 0 && (
                      <span className="muted small">
                        {" "}
                        ({c.headOnKills}/{c.headOnShots})
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <div>{c.medianMaxMach !== null ? `M${c.medianMaxMach.toFixed(2)}` : "–"}</div>
                    {c.medianMaxMachCi && (
                      <div className="muted small" style={{ fontSize: 10.5 }}>
                        CI: M{c.medianMaxMachCi.lo.toFixed(2)}–M{c.medianMaxMachCi.hi.toFixed(2)}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {c.empiricalNotchDeg !== null ? `±${c.empiricalNotchDeg.toFixed(1)}°` : "–"}
                  </td>
                  <td className="num">
                    {c.vsPrevChanceP !== null ? (
                      <span
                        style={{
                          color:
                            c.vsPrevChanceP < 0.05
                              ? "#10b981"
                              : c.vsPrevChanceP < 0.15
                                ? "#eab308"
                                : "var(--muted)",
                          fontWeight: c.vsPrevChanceP < 0.1 ? 600 : 400,
                        }}
                        title={t("analytics.bvr.patch.adjPValTitle", { p: c.vsPrevChanceP.toFixed(3) })}
                      >
                        p={c.vsPrevChanceP.toFixed(2)}
                      </span>
                    ) : (
                      <span className="muted small">–</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DefeatAndDefenseCard({
  defeatBreakdown,
  defenseBreakdown,
  diedUnawareCount,
  totalKills,
  distanceUnit,
}: {
  defeatBreakdown: DefeatModeSummary[];
  defenseBreakdown: DefenseTypeSummary[];
  diedUnawareCount: number;
  totalKills: number;
  distanceUnit: DistanceUnit;
}) {
  const { t } = useTranslation();
  const nonZeroDefeats = defeatBreakdown.filter((d) => d.count > 0);

  return (
    <div className="charts-two-col">
      {/* Left: Why Missiles Miss (Defeat Modes) */}
      <section className="card analytics-card">
        <div className="card-head">
          <div>
            <h3>{t("analytics.bvr.defeat.title")}</h3>
            <p className="muted small matrix-sub">{t("analytics.bvr.defeat.sub")}</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th>{t("analytics.bvr.defeat.modeCol")}</th>
                <th className="num">{t("analytics.bvr.defeat.countCol")}</th>
                <th className="num">{t("analytics.bvr.defeat.shareCol")}</th>
                <th className="num">{t("analytics.bvr.defeat.medRangeCol")}</th>
                <th className="num">{t("analytics.bvr.defeat.medEndMachCol")}</th>
              </tr>
            </thead>
            <tbody>
              {nonZeroDefeats.map((d) => (
                <tr key={d.mode}>
                  <td>
                    <span
                      className="dot"
                      style={{
                        background: DEFEAT_MODE_COLORS[d.mode],
                        marginRight: 6,
                      }}
                    />
                    <strong>{t(`analytics.bvr.defeatMode.${d.mode}`)}</strong>
                  </td>
                  <td className="num">{d.count}</td>
                  <td className="num">{Math.round(d.share * 100)}%</td>
                  <td className="num">{fmtDist(d.medianRangeM, distanceUnit)}</td>
                  <td className="num">{d.medianEndMach !== null ? `M${d.medianEndMach.toFixed(2)}` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Right: Target Defensive Reaction & Survival */}
      <section className="card analytics-card">
        <div className="card-head">
          <div>
            <h3>{t("analytics.bvr.defense.title")}</h3>
            <p className="muted small matrix-sub">{t("analytics.bvr.defense.sub")}</p>
          </div>
          {totalKills > 0 && (
            <span className="badge warn" title={t("analytics.bvr.defense.diedUnawareTitle")}>
              {t("analytics.bvr.defense.diedUnaware", {
                unaware: diedUnawareCount,
                total: totalKills,
                pct: Math.round((diedUnawareCount / totalKills) * 100),
              })}
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th>{t("analytics.bvr.defense.actionCol")}</th>
                <th className="num">{t("analytics.bvr.defense.targetedCol")}</th>
                <th className="num">{t("analytics.bvr.defense.survivedCol")}</th>
                <th className="num">{t("analytics.bvr.defense.killedCol")}</th>
                <th className="num">{t("analytics.bvr.defense.survivalCol")}</th>
                <th className="num">{t("analytics.bvr.defense.medReactionCol")}</th>
              </tr>
            </thead>
            <tbody>
              {defenseBreakdown.map((d) => (
                <tr key={d.defense}>
                  <td>
                    <strong>{t(`analytics.bvr.defenseType.${d.defense}`)}</strong>
                  </td>
                  <td className="num">{d.shots}</td>
                  <td className="num">{d.survived}</td>
                  <td className="num">{d.kills}</td>
                  <td className="num">
                    {d.survivalRate !== null ? (
                      <>
                        <strong>{Math.round(d.survivalRate * 100)}%</strong>{" "}
                        {d.survivalCi && (
                          <span className="muted small">
                            ({Math.round(d.survivalCi.lo * 100)}–{Math.round(d.survivalCi.hi * 100)}%)
                          </span>
                        )}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="num">
                    {d.medianReactionS !== null ? `${d.medianReactionS.toFixed(1)} s` : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function NotchAnalyzerCard({
  notch,
  notchGateDeg,
  onChangeNotchGateDeg,
}: {
  notch: NotchGateAnalysis;
  notchGateDeg: number;
  onChangeNotchGateDeg: (deg: number) => void;
}) {
  const { t } = useTranslation();
  const width = 620;
  const height = 210;
  const padL = 42;
  const padR = 20;
  const padT = 18;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const slotW = plotW / Math.max(1, notch.beamBins.length);
  const barW = Math.min(44, slotW * 0.56);

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>{t("analytics.bvr.notch.title")}</h3>
          <p className="muted small matrix-sub">{t("analytics.bvr.notch.sub", { deg: notchGateDeg })}</p>
        </div>
        <div className="chart-controls">
          <label className="small muted">
            {t("analytics.bvr.notch.sliderLabel")}{" "}
            <input
              type="range"
              min={5}
              max={30}
              step={1}
              value={notchGateDeg}
              onChange={(e) => onChangeNotchGateDeg(Number(e.target.value))}
              style={{ verticalAlign: "middle", width: 110 }}
            />{" "}
            <strong>±{notchGateDeg}°</strong>
          </label>
        </div>
      </div>

      <div className="notch-kpis">
        <div className="notch-kpi-box">
          <span className="muted small">{t("analytics.bvr.notch.inGate", { deg: notchGateDeg })}</span>
          <strong>
            {notch.inGateSurvivalRate !== null
              ? `${Math.round(notch.inGateSurvivalRate * 100)}% (${notch.inGateSurvived}/${notch.inGateShots})`
              : "–"}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">{t("analytics.bvr.notch.outGate", { deg: notchGateDeg })}</span>
          <strong>
            {notch.outGateSurvivalRate !== null
              ? `${Math.round(notch.outGateSurvivalRate * 100)}% (${notch.outGateSurvived}/${notch.outGateShots})`
              : "–"}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">{t("analytics.bvr.notch.accuracy")}</span>
          <strong>
            {notch.gateAccuracy !== null
              ? t("analytics.bvr.notch.accShort", { pct: Math.round(notch.gateAccuracy * 100) })
              : "–"}
            {notch.gatePrecision !== null
              ? t("analytics.bvr.notch.precShort", { pct: Math.round(notch.gatePrecision * 100) })
              : ""}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">{t("analytics.bvr.notch.mlBeamGate")}</span>
          <strong>
            {notch.empiricalBeamGateDeg !== null
              ? `90° ± ${notch.empiricalBeamGateDeg.toFixed(1)}°`
              : t("analytics.bvr.notch.insufficientData")}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">{t("analytics.bvr.notch.mlRadialGate")}</span>
          <strong>
            {notch.empiricalRadialGateMs !== null
              ? `|Vr| ≤ ${Math.round(notch.empiricalRadialGateMs)} m/s (${Math.round(notch.empiricalRadialGateMs * 1.94384)} kt)`
              : "–"}
          </strong>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="analytics-svg"
        role="img"
        aria-label={t("analytics.bvr.notch.svgAria")}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + plotH * (1 - f);
          return (
            <g key={f}>
              <line
                x1={padL}
                x2={width - padR}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={f === 0.5 ? "5 3" : f === 0 ? undefined : "3 3"}
              />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
                {Math.round(f * 100)}%
              </text>
            </g>
          );
        })}

        {notch.beamBins.map((b, i) => {
          const cx = padL + (i + 0.5) * slotW;
          const x = cx - barW / 2;
          const surv = b.survivalRate ?? 0;
          const h = surv * plotH;
          const y = padT + plotH - h;
          const inUserGate = b.maxDeg <= notchGateDeg;
          return (
            <g key={b.label}>
              <title>
                {t("analytics.bvr.notch.barTip", {
                  label: b.label,
                  survived: b.survived,
                  shots: b.shots,
                  obs: b.survivalRate !== null ? Math.round(b.survivalRate * 100) : 0,
                  fit: Math.round(b.fittedProb * 100),
                })}
              </title>
              {b.shots > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={3}
                  fill={inUserGate ? "#eab308" : "#3b82f6"}
                  fillOpacity={0.78}
                />
              )}
              <text x={cx} y={Math.max(padT + 10, y - 5)} textAnchor="middle" fontSize="10" fill="var(--fg)">
                {b.shots > 0 ? `${b.survived}/${b.shots}` : "0"}
              </text>
              <text x={cx} y={height - 14} textAnchor="middle" fontSize="10" fill="var(--muted)">
                {b.label}
              </text>
            </g>
          );
        })}

        {/* Fitted Logistic Regression Curve */}
        {notch.sampleSize >= 4 && (
          <polyline
            fill="none"
            stroke="#10b981"
            strokeWidth={2.2}
            points={notch.beamBins
              .map((b, i) => {
                const cx = padL + (i + 0.5) * slotW;
                const cy = padT + plotH * (1 - b.fittedProb);
                return `${cx},${cy}`;
              })
              .join(" ")}
          />
        )}
      </svg>
    </section>
  );
}

export function PilotReportCard({
  pilots,
  distanceUnit,
  onSelectPilot,
}: {
  pilots: PilotReport[];
  distanceUnit: DistanceUnit;
  onSelectPilot: (pilot: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (pilots.length === 0) return null;
  const visible = expanded ? pilots : pilots.slice(0, 12);

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>{t("analytics.bvr.pilotReport.title", { count: pilots.length })}</h3>
          <p className="muted small matrix-sub">{t("analytics.bvr.pilotReport.sub")}</p>
        </div>
        {pilots.length > 12 && (
          <button type="button" className="secondary small-btn" onClick={() => setExpanded(!expanded)}>
            {expanded
              ? t("analytics.bvr.pilotReport.showTop12")
              : t("analytics.bvr.pilotReport.showAll", { count: pilots.length })}
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="records">
          <thead>
            <tr>
              <th>{t("analytics.bvr.pilotReport.pilotCol")}</th>
              <th>{t("analytics.bvr.pilotReport.airframeCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.shotsCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.killsCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.offPkCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.medShotCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.medFPoleCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.medCrankCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.targetedCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.deathsCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.defSurvCol")}</th>
              <th className="num">{t("analytics.bvr.pilotReport.medReactCol")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr
                key={p.pilot}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectPilot(p.pilot)}
                title={t("analytics.bvr.pilotReport.filterTitle", { pilot: p.pilot })}
              >
                <td>
                  <strong>{p.pilot}</strong>
                </td>
                <td>{p.aircraft || "–"}</td>
                <td className="num">
                  {p.shots} <span className="muted small">({p.bvrShots})</span>
                </td>
                <td className="num">
                  <strong>{p.kills}</strong>
                </td>
                <td className="num">{p.pk !== null ? `${Math.round(p.pk * 100)}%` : "–"}</td>
                <td className="num">{fmtDist(p.medianLaunchRangeM, distanceUnit)}</td>
                <td className="num">{fmtDist(p.medianFPoleM, distanceUnit)}</td>
                <td className="num">
                  {p.medianCrankDeg !== null ? `${Math.round(p.medianCrankDeg)}°` : "–"}
                </td>
                <td className="num">{p.timesTargeted}</td>
                <td className="num">
                  {p.deaths}
                  {p.diedUnawareCount > 0 && (
                    <span className="muted small">
                      {t("analytics.bvr.pilotReport.unawareCount", { count: p.diedUnawareCount })}
                    </span>
                  )}
                </td>
                <td className="num">
                  {p.survivalRate !== null ? `${Math.round(p.survivalRate * 100)}%` : "–"}
                </td>
                <td className="num">
                  {p.medianReactionTimeS !== null ? `${p.medianReactionTimeS.toFixed(1)} s` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const VERDICT_BADGE_STYLE: Record<GateVerdictStatus, { color: string; bg: string }> = {
  valid: {
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.14)",
  },
  optimistic: {
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.16)",
  },
  conservative: {
    color: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.14)",
  },
  "low-data": {
    color: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.12)",
  },
};

function renderCellEmpiricalSubtext(
  rowKey: BvrTimelineRowKey,
  v: ThreatTierValidation,
  currentValNm: number,
  strikeBonus: number,
): {
  statLine: string;
  verdict: GateVerdictStatus | null;
  note: string | null;
  autoValNm: number;
} {
  const autoValNm = v.posteriorColumn[rowKey];
  switch (rowKey) {
    case "threatRangeNm": {
      const statLine =
        v.kills > 0 && v.p95KillRangeNm !== null && v.maxKillRangeNm !== null
          ? `p95 kill: ${v.p95KillRangeNm.toFixed(1)} nm · max: ${v.maxKillRangeNm.toFixed(1)} nm (${v.killsBeyondThreatRange}/${v.kills} kills > ${currentValNm} nm)`
          : "No kills in tier";
      return {
        statLine,
        verdict: v.threatRangeVerdict,
        note: v.threatRangeNote,
        autoValNm,
      };
    }
    case "nltSrNm": {
      const eff = currentValNm + strikeBonus;
      const statLine =
        v.nltSrWindowShots > 0
          ? `@~${eff} nm: ${Math.round((v.nltSrWindowPk ?? 0) * 100)}% Pk · ${Math.round((v.nltSrForcedDefenseRate ?? 0) * 100)}% forced def (n=${v.nltSrWindowShots})`
          : `0 shots near ${eff} nm`;
      return {
        statLine,
        verdict: v.nltSrVerdict,
        note: v.nltSrNote,
        autoValNm,
      };
    }
    case "morNm": {
      const eff = currentValNm + strikeBonus;
      const outStr =
        v.morOutsideSurvivalRate !== null
          ? `≥${eff} nm: ${Math.round(v.morOutsideSurvivalRate * 100)}% surv (${v.morOutsideSurvived}/${v.morOutsideShots})`
          : `≥${eff} nm: 0 drags`;
      const inStr =
        v.morInsideSurvivalRate !== null
          ? `<${eff} nm: ${Math.round(v.morInsideSurvivalRate * 100)}% (${v.morInsideSurvived}/${v.morInsideShots})`
          : "";
      return {
        statLine: inStr ? `${outStr} · ${inStr}` : outStr,
        verdict: v.morVerdict,
        note: v.morNote,
        autoValNm,
      };
    }
    case "drNm": {
      const outStr =
        v.drOutsideSurvivalRate !== null
          ? `≥${currentValNm} nm: ${Math.round(v.drOutsideSurvivalRate * 100)}% surv (${v.drOutsideSurvived}/${v.drOutsideShots})`
          : `≥${currentValNm} nm: 0 notches`;
      const inStr =
        v.drInsideSurvivalRate !== null
          ? `<${currentValNm} nm: ${Math.round(v.drInsideSurvivalRate * 100)}% (${v.drInsideSurvived}/${v.drInsideShots})`
          : "";
      return {
        statLine: inStr ? `${outStr} · ${inStr}` : outStr,
        verdict: v.drVerdict,
        note: v.drNote,
        autoValNm,
      };
    }
    case "lsrNm": {
      const statLine =
        v.lsrBandShots > 0 && v.lsrBandPk !== null
          ? `Band Pk: ${Math.round(v.lsrBandPk * 100)}% (${v.lsrBandKills}/${v.lsrBandShots} shots)`
          : "0 shots in LSR band";
      return {
        statLine,
        verdict: v.lsrBandShots >= 4 ? "valid" : "low-data",
        note: null,
        autoValNm,
      };
    }
    case "marNm": {
      const outStr =
        v.marOutsideSurvivalRate !== null
          ? `≥${currentValNm} nm: ${Math.round(v.marOutsideSurvivalRate * 100)}% surv (${v.marOutsideSurvived}/${v.marOutsideShots})`
          : `≥${currentValNm} nm: –`;
      const inStr =
        v.marInsideSurvivalRate !== null
          ? `<${currentValNm} nm: ${Math.round(v.marInsideSurvivalRate * 100)}% (${v.marInsideSurvived}/${v.marInsideShots})`
          : `<${currentValNm} nm: –`;
      return {
        statLine: `${outStr} · ${inStr}`,
        verdict: v.marVerdict,
        note: v.marNote,
        autoValNm,
      };
    }
    case "sternWezNm": {
      const statLine =
        v.sternInsideShots > 0 && v.sternInsidePk !== null
          ? `≤${currentValNm} nm tail Pk: ${Math.round(v.sternInsidePk * 100)}% (${v.sternInsideKills}/${v.sternInsideShots})`
          : `0 tail shots ≤${currentValNm} nm (${v.sternOutsideShots} outside)`;
      return {
        statLine,
        verdict: v.sternVerdict,
        note: v.sternNote,
        autoValNm,
      };
    }
    default:
      return {
        statLine: `Derived planning offset (Chart: ${DEFAULT_MILSIM_TIMELINE[v.tier][rowKey]} nm)`,
        verdict: null,
        note: null,
        autoValNm,
      };
  }
}

type AltitudeFilter = "all" | "hi18" | AltitudeBand;

export function BvrTimelineCard({
  engagements,
  tacticsById,
  fitted,
}: {
  engagements: MissileEngagement[];
  tacticsById: Map<string, ShotTacticalMetrics>;
  /** Fitted missile models; when present, an altitude band scales the chart's kinematic gates. */
  fitted?: FittedMissile[] | null;
}) {
  const { t } = useTranslation();
  const [table, setTable] = useState<BvrTimelineTable>(() => cloneTimelineTable(DEFAULT_MILSIM_TIMELINE));
  const [strikeFighterAdd2Nm, setStrikeFighterAdd2Nm] = useState(false);
  const [altFilter, setAltFilter] = useState<AltitudeFilter>("all");
  const highAltOnly = altFilter === "hi18";
  const band: AltitudeBand | null = altFilter === "all" || altFilter === "hi18" ? null : altFilter;
  const hasUsableModels = Boolean(fitted?.some((f) => f.model.quality === "good"));
  const bandScales = useMemo(
    () => (band && fitted ? tierAltitudeScales(fitted, band) : null),
    [band, fitted],
  );
  const hasScaledGates = Boolean(bandScales && Object.values(bandScales).some(Boolean));
  /** The chart, with its kinematic gates scaled to the chosen altitude band by the fitted missile reach. */
  const priorTable = useMemo(
    () => (bandScales ? scaleTimelineTable(DEFAULT_MILSIM_TIMELINE, bandScales) : DEFAULT_MILSIM_TIMELINE),
    [bandScales],
  );
  // A new altitude situation starts from its own scaled chart. A refit (the selection changed) only
  // moves the table along if it was still untouched, so hand edits survive filter changes.
  const prevPrior = useRef(priorTable);
  const prevAltFilter = useRef(altFilter);
  useEffect(() => {
    const old = prevPrior.current;
    const situationChanged = prevAltFilter.current !== altFilter;
    prevPrior.current = priorTable;
    prevAltFilter.current = altFilter;
    if (old === priorTable) return;
    setTable((t) => (situationChanged || timelineTablesEqual(t, old) ? cloneTimelineTable(priorTable) : t));
  }, [priorTable, altFilter]);
  const [priorWeight, setPriorWeight] = useState<number>(8);
  const [showAllPlanningRows, setShowAllPlanningRows] = useState(true);
  const [kneeboardTheme, setKneeboardTheme] = useState<KneeboardTheme>("day");
  const [kneeboardPlan, setKneeboardPlan] = useState<KneeboardPlan>("all");
  /** "off", a fixed closure in kt, or "data" for the loaded shots' median launch closure. */
  const [gateTimes, setGateTimes] = useState<string>("off");
  const dataClosure = useMemo(() => medianBvrLaunchClosureKt(engagements), [engagements]);
  const gateClosureKt =
    gateTimes === "off" ? null : gateTimes === "data" ? (dataClosure?.kt ?? null) : Number(gateTimes);

  const [showKneeboard, setShowKneeboard] = useState(false);
  /** Round the image's gates up to whole nm (the table keeps its decimals). */
  const [kneeboardRoundUp, setKneeboardRoundUp] = useState(true);
  const [kneeboardLanes, setKneeboardLanes] = useState(true);
  const [kneeboardArLeft, setKneeboardArLeft] = useState(false);
  const kneeboardRef = useRef<HTMLCanvasElement>(null);

  // Redraw the preview whenever the table or an image option changes, so edits show up live.
  useEffect(() => {
    const canvas = kneeboardRef.current;
    if (!showKneeboard || !canvas) return;
    const isBaseline = timelineTablesEqual(table, priorTable);
    const bandPart = band ? ` · ${ALTITUDE_BANDS[band].label}` : "";
    renderKneeboardCanvas(
      table,
      {
        theme: kneeboardTheme,
        plan: kneeboardPlan,
        strikeFighterAdd2Nm,
        gateTimesClosureKt: gateClosureKt,
        roundUpNm: kneeboardRoundUp,
        planLanes: kneeboardLanes,
        arColumnsLeft: kneeboardArLeft,
        sourceLabel:
          (isBaseline
            ? band && hasScaledGates
              ? "Chart scaled by fitted reach"
              : "Chart baseline"
            : "Custom / ACMI-fitted") + bandPart,
      },
      canvas,
    );
  }, [
    showKneeboard,
    table,
    kneeboardTheme,
    kneeboardPlan,
    strikeFighterAdd2Nm,
    gateClosureKt,
    kneeboardRoundUp,
    kneeboardLanes,
    kneeboardArLeft,
    priorTable,
    band,
    hasScaledGates,
  ]);

  const saveKneeboard = () => {
    const canvas = kneeboardRef.current;
    if (!canvas) return;
    const planPart =
      kneeboardPlan === "all" ? "" : `-${kneeboardPlan.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    void saveCanvasPng(canvas, `bvr-timeline${planPart}-${kneeboardTheme}.png`).catch((err) =>
      alert(
        t("analytics.bvr.timeline.saveFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  };

  const evaluations = useMemo(
    () =>
      evaluateBvrTimeline(engagements, tacticsById, table, {
        strikeFighterAdd2Nm,
        priorWeight,
        highAltOnly,
        priorTable,
        altBandFt: band
          ? { minFt: ALTITUDE_BANDS[band].minFt, maxFt: ALTITUDE_BANDS[band].maxFt }
          : undefined,
      }),
    [engagements, tacticsById, table, strikeFighterAdd2Nm, priorWeight, highAltOnly, priorTable, band],
  );

  const updateCell = (tier: BvrThreatTier, key: BvrTimelineRowKey, val: number) => {
    if (!Number.isFinite(val) || val < 0) return;
    setTable((prev) => ({
      ...prev,
      [tier]: {
        ...prev[tier],
        [key]: val,
      },
    }));
  };

  const applyAutoPosterior = () => {
    setTable({
      "IR/SAR-1": { ...evaluations["IR/SAR-1"].posteriorColumn },
      "SAR-2": { ...evaluations["SAR-2"].posteriorColumn },
      "AR-1": { ...evaluations["AR-1"].posteriorColumn },
      "AR-2": { ...evaluations["AR-2"].posteriorColumn },
    });
  };

  const applyPureMle = () => {
    setTable({
      "IR/SAR-1": { ...evaluations["IR/SAR-1"].mleColumn },
      "SAR-2": { ...evaluations["SAR-2"].mleColumn },
      "AR-1": { ...evaluations["AR-1"].mleColumn },
      "AR-2": { ...evaluations["AR-2"].mleColumn },
    });
  };

  const resetToChartDefault = () => {
    setTable(cloneTimelineTable(priorTable));
  };

  const visibleRows = showAllPlanningRows
    ? BVR_TIMELINE_ROWS
    : BVR_TIMELINE_ROWS.filter((r) => r.directlyTestable);

  const strikeBonus = strikeFighterAdd2Nm ? 2 : 0;

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>{t("analytics.bvr.timeline.title")}</h3>
          <p className="muted small matrix-sub">
            <Trans
              i18nKey="analytics.bvr.timeline.sub"
              components={[<strong key="0" />, <strong key="1" />]}
            />
          </p>
        </div>
        <div className="chart-controls">
          <button
            type="button"
            className="secondary small-btn"
            title={t("analytics.bvr.timeline.autoFitTitle")}
            onClick={applyAutoPosterior}
          >
            {t("analytics.bvr.timeline.autoFitBtn")}
          </button>
          <button
            type="button"
            className="secondary small-btn"
            title={t("analytics.bvr.timeline.pureMleTitle")}
            onClick={applyPureMle}
          >
            {t("analytics.bvr.timeline.pureMleBtn")}
          </button>
          <button
            type="button"
            className="secondary small-btn"
            title={t("analytics.bvr.timeline.resetTitle")}
            onClick={resetToChartDefault}
          >
            {t("analytics.bvr.timeline.resetBtn")}
          </button>
          <button
            type="button"
            className="small-btn"
            title={t("analytics.bvr.timeline.kneeboardTitle")}
            aria-expanded={showKneeboard}
            onClick={() => setShowKneeboard((v) => !v)}
          >
            {showKneeboard
              ? t("analytics.bvr.timeline.hideKneeboard")
              : t("analytics.bvr.timeline.showKneeboard")}
          </button>
        </div>
      </div>

      {showKneeboard && (
        <div className="kneeboard-preview">
          <canvas
            ref={kneeboardRef}
            className="kneeboard-canvas"
            aria-label={t("analytics.bvr.timeline.kneeboardAria")}
          />
          <div className="kneeboard-side small muted">
            <select
              value={kneeboardPlan}
              onChange={(e) => setKneeboardPlan(e.target.value as KneeboardPlan)}
              title={t("analytics.bvr.timeline.planTitle")}
              aria-label={t("analytics.bvr.timeline.planAria")}
            >
              {KNEEBOARD_PLAN_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p === "all"
                    ? t("analytics.bvr.timeline.allGates")
                    : t("analytics.bvr.timeline.planPrefix", { label: KNEEBOARD_PLANS[p].label })}
                </option>
              ))}
            </select>
            <select
              value={kneeboardTheme}
              onChange={(e) => setKneeboardTheme(e.target.value as KneeboardTheme)}
              title={t("analytics.bvr.timeline.themeAria")}
              aria-label={t("analytics.bvr.timeline.themeAria")}
            >
              <option value="day">{t("analytics.bvr.timeline.day")}</option>
              <option value="night">{t("analytics.bvr.timeline.night")}</option>
            </select>
            <select
              value={gateTimes === "data" && !dataClosure ? "off" : gateTimes}
              onChange={(e) => setGateTimes(e.target.value)}
              title={t("analytics.bvr.timeline.gateTimesTitle")}
              aria-label={t("analytics.bvr.timeline.gateTimesAria")}
            >
              <option value="off">{t("analytics.bvr.timeline.noGateTimes")}</option>
              <option value="1000">{t("analytics.bvr.timeline.gateTimesAt", { kt: 1000 })}</option>
              <option value={String(DEFAULT_GATE_CLOSURE_KT)}>
                {t("analytics.bvr.timeline.gateTimesAt", { kt: DEFAULT_GATE_CLOSURE_KT })}
              </option>
              <option value="1400">{t("analytics.bvr.timeline.gateTimesAt", { kt: 1400 })}</option>
              {dataClosure && (
                <option value="data">
                  {t("analytics.bvr.timeline.gateTimesData", { kt: dataClosure.kt, n: dataClosure.n })}
                </option>
              )}
            </select>
            <label className="toggle" title={t("analytics.bvr.timeline.roundUpTitle")}>
              <input
                type="checkbox"
                checked={kneeboardRoundUp}
                onChange={(e) => setKneeboardRoundUp(e.target.checked)}
              />{" "}
              {t("analytics.bvr.timeline.roundUp")}
            </label>
            <label className="toggle" title={t("analytics.bvr.timeline.arLeftTitle")}>
              <input
                type="checkbox"
                checked={kneeboardArLeft}
                onChange={(e) => setKneeboardArLeft(e.target.checked)}
              />{" "}
              {t("analytics.bvr.timeline.arLeft")}
            </label>
            {kneeboardPlan === "all" && (
              <label className="toggle" title={t("analytics.bvr.timeline.showLanesTitle")}>
                <input
                  type="checkbox"
                  checked={kneeboardLanes}
                  onChange={(e) => setKneeboardLanes(e.target.checked)}
                />{" "}
                {t("analytics.bvr.timeline.showLanes")}
              </label>
            )}
            <button type="button" className="small-btn" onClick={saveKneeboard}>
              {t("analytics.bvr.timeline.savePng")}
            </button>
            <p>
              <Trans i18nKey="analytics.bvr.timeline.kneeboardNote" components={[<code key="0" />]} />
            </p>
          </div>
        </div>
      )}

      {/* Sub-toolbar for Strike Fighter +2nm, High-Alt filter, Prior weight, and row filter */}
      <div className="query-subbar" style={{ marginBottom: 10 }}>
        <div className="checks-inline">
          <label className="toggle" title={t("analytics.bvr.timeline.strikeFighterTitle")}>
            <input
              type="checkbox"
              checked={strikeFighterAdd2Nm}
              onChange={(e) => setStrikeFighterAdd2Nm(e.target.checked)}
            />{" "}
            {t("analytics.bvr.timeline.strikeFighter")}
          </label>
          <label className="small muted" title={t("analytics.bvr.timeline.altitudeTitle")}>
            {t("analytics.bvr.timeline.altitude")}{" "}
            <select value={altFilter} onChange={(e) => setAltFilter(e.target.value as AltitudeFilter)}>
              <option value="all">{t("analytics.bvr.timeline.allAltitudes")}</option>
              <option value="hi18">{t("analytics.bvr.timeline.hi18Altitudes")}</option>
              {ALTITUDE_BAND_ORDER.map((b) => (
                <option key={b} value={b} disabled={!hasUsableModels}>
                  {ALTITUDE_BANDS[b].label}
                  {hasUsableModels
                    ? t("analytics.bvr.timeline.gatesScaled")
                    : fitted
                      ? t("analytics.bvr.timeline.needsRadarShots")
                      : t("analytics.bvr.timeline.fitting")}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showAllPlanningRows}
              onChange={(e) => setShowAllPlanningRows(e.target.checked)}
            />{" "}
            {t("analytics.bvr.timeline.showAllRows")}
          </label>
        </div>

        <div className="threshold-group">
          <label className="small muted" title={t("analytics.bvr.timeline.priorWeightTitle")}>
            {t("analytics.bvr.timeline.priorWeight")}{" "}
            <select value={priorWeight} onChange={(e) => setPriorWeight(Number(e.target.value))}>
              <option value={0}>{t("analytics.bvr.timeline.k0Zero")}</option>
              <option value={4}>{t("analytics.bvr.timeline.k0Light")}</option>
              <option value={8}>{t("analytics.bvr.timeline.k0Balanced")}</option>
              <option value={16}>{t("analytics.bvr.timeline.k0Strong")}</option>
            </select>
          </label>
        </div>
      </div>

      {band && bandScales && (
        <p className="small muted" style={{ margin: "0 0 10px" }}>
          <strong>{ALTITUDE_BANDS[band].label}:</strong>{" "}
          {hasScaledGates
            ? t("analytics.bvr.timeline.bandScaledInfo", {
                refFt: ALTITUDE_BANDS[band].refFt.toLocaleString(),
                tiers: THREAT_TIER_ORDER.map((tier) => {
                  const sc = bandScales[tier];
                  if (!sc) return `${tier}: no fitted missile`;
                  return `${tier}: ×${sc.hot.toFixed(2)} / ×${sc.cold.toFixed(2)} (${sc.borrowed ? "all" : sc.weapons.join(", ")})`;
                }).join(" · "),
              })
            : t("analytics.bvr.timeline.bandNoModelInfo")}
        </p>
      )}

      <div className="table-wrap">
        <table className="records timeline-table">
          <thead>
            <tr>
              <th>{t("analytics.bvr.timeline.gateCol")}</th>
              {THREAT_TIER_ORDER.map((tier) => {
                const meta = THREAT_TIER_META[tier];
                const ev = evaluations[tier];
                return (
                  <th key={tier}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong>{meta.title}</strong>
                      <span className="badge info" style={{ fontSize: 10 }}>
                        {t("analytics.bvr.timeline.tierShotsKills", { shots: ev.shots, kills: ev.kills })}
                      </span>
                    </div>
                    <div className="muted small" style={{ fontWeight: 400, marginTop: 2 }}>
                      {meta.chartAircraft}
                    </div>
                    <div className="muted small" style={{ fontWeight: 400, fontSize: 10 }}>
                      {meta.typicalWeapons}
                      {t("analytics.bvr.timeline.dataWeight", { pct: Math.round(ev.dataWeight * 100) })}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr
                key={row.key}
                style={{
                  background: row.directlyTestable ? undefined : "rgba(148, 163, 184, 0.04)",
                }}
              >
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong>
                      {row.code}
                      {row.hasStrikeFighterStar ? "*" : ""}
                    </strong>
                    {row.directlyTestable ? (
                      <span
                        className="badge"
                        style={{
                          fontSize: 9,
                          padding: "1px 5px",
                          background: "rgba(59, 130, 246, 0.16)",
                          color: "#60a5fa",
                        }}
                      >
                        {t("analytics.bvr.timeline.acmiTested")}
                      </span>
                    ) : (
                      <span className="muted small" style={{ fontSize: 10 }}>
                        {t("analytics.bvr.timeline.derived")}
                      </span>
                    )}
                  </div>
                  <div className="muted small" style={{ fontSize: 11, marginTop: 2 }}>
                    {row.description}
                  </div>
                </td>

                {THREAT_TIER_ORDER.map((tier) => {
                  const ev = evaluations[tier];
                  const val = table[tier][row.key];
                  const chartDefault = priorTable[tier][row.key];
                  const cellInfo = renderCellEmpiricalSubtext(
                    row.key,
                    ev,
                    val,
                    row.hasStrikeFighterStar ? strikeBonus : 0,
                  );
                  const diffFromAuto = Math.abs(val - cellInfo.autoValNm);
                  const badge = cellInfo.verdict ? VERDICT_BADGE_STYLE[cellInfo.verdict] : null;

                  return (
                    <td key={tier} style={{ verticalAlign: "top" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <input
                          type="number"
                          step={0.5}
                          min={1}
                          max={120}
                          value={val}
                          onChange={(e) => updateCell(tier, row.key, Number(e.target.value))}
                          style={{
                            width: 64,
                            fontWeight: 700,
                            fontSize: 13,
                            padding: "2px 6px",
                          }}
                          aria-label={t("analytics.bvr.timeline.cellAria", { tier, code: row.code })}
                        />
                        <span className="muted small">
                          nm
                          {row.hasStrikeFighterStar && strikeBonus > 0 ? ` (${val + strikeBonus}* eff)` : ""}
                        </span>

                        {badge && cellInfo.verdict && (
                          <span
                            style={{
                              fontSize: 10,
                              padding: "1px 6px",
                              borderRadius: 4,
                              background: badge.bg,
                              color: badge.color,
                              fontWeight: 600,
                            }}
                            title={cellInfo.note ?? undefined}
                          >
                            {t(`analytics.bvr.timeline.verdict.${cellInfo.verdict}`)}
                          </span>
                        )}
                      </div>

                      <div className="muted small" style={{ fontSize: 11, marginTop: 4 }}>
                        {cellInfo.statLine}
                      </div>

                      <div
                        className="small"
                        style={{
                          fontSize: 10,
                          marginTop: 2,
                          color: row.directlyTestable && diffFromAuto >= 1.5 ? "#eab308" : "var(--muted)",
                        }}
                      >
                        {band
                          ? t("analytics.bvr.timeline.scaledChartLabel")
                          : t("analytics.bvr.timeline.chartLabel")}
                        : <strong>{chartDefault}</strong> nm · {t("analytics.bvr.timeline.autoFitLabel")}:{" "}
                        <strong>{cellInfo.autoValNm.toFixed(1)}</strong> nm
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Key Empirical Findings Banner below the table */}
      <div className="kpi-grid" style={{ marginTop: 12 }}>
        {THREAT_TIER_ORDER.map((tier) => {
          const ev = evaluations[tier];
          if (ev.shots === 0) {
            return (
              <div key={tier} className="card kpi-card">
                <div className="stat-label">{t("analytics.bvr.timeline.verdictTitle", { tier })}</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {t("analytics.bvr.timeline.verdictEmpty", {
                    scaled: band ? t("analytics.bvr.timeline.scaledWord") : "",
                    mar: priorTable[tier].marNm,
                    threat: priorTable[tier].threatRangeNm,
                  })}
                </div>
              </div>
            );
          }
          return (
            <div key={tier} className="card kpi-card">
              <div className="stat-label">
                {tier} ({t("analytics.bvr.timeline.tierShotsKills", { shots: ev.shots, kills: ev.kills })})
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                <div>
                  <strong>{t("analytics.bvr.timeline.maxAero")}</strong> {ev.threatRangeNote}
                </div>
                <div style={{ marginTop: 3 }}>
                  <strong>MAR ({table[tier].marNm} nm):</strong> {ev.marNote}
                </div>
                <div style={{ marginTop: 3 }} className="muted">
                  {t("analytics.bvr.timeline.recommendedMar")} <strong>{ev.posteriorColumn.marNm} nm</strong>{" "}
                  · {t("analytics.bvr.timeline.morLabel")} <strong>{ev.posteriorColumn.morNm} nm</strong>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function fmtPctRate(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

function formatReactionBinLabel(bin: SuddenReactionRangeBin, unitM: number, unitLabel: string): string {
  const lo = Math.round(bin.minM / unitM);
  const hi = Math.round(bin.maxM / unitM);
  return bin.isOverflow ? `${lo}+${unitLabel}` : `${lo}-${hi}${unitLabel}`;
}

function selectVisibleReactionBins(bins: SuddenReactionRangeBin[]): SuddenReactionRangeBin[] {
  if (bins.length <= 8) return bins;
  const regular = bins.filter((b) => !b.isOverflow);
  const overflow = bins.find((b) => b.isOverflow);
  let lastNonEmpty = -1;
  for (let i = 0; i < regular.length; i++) {
    const reg = regular[i];
    if (reg && reg.count > 0) lastNonEmpty = i;
  }
  const keepRegular = Math.min(regular.length, Math.max(8, lastNonEmpty + 2));
  const out = regular.slice(0, keepRegular);
  if (overflow && overflow.count > 0) out.push(overflow);
  return out;
}

type ReactionWeaponScope = "a2a-all" | "all" | "A2A-ARH" | "A2A-IR" | "A2A-SARH" | `model:${string}`;

function formatScopeCounts(engagements: MissileEngagement[]) {
  let all = 0;
  let a2aAll = 0;
  let arh = 0;
  let ir = 0;
  let sarh = 0;
  let hasNonA2a = false;
  for (const e of engagements) {
    if (e.isGun || e.domain === "A2G") continue;
    all++;
    if (A2A_MISSILE_CLASSES.includes(e.weaponClass)) {
      a2aAll++;
      if (e.weaponClass === "A2A-ARH") arh++;
      else if (e.weaponClass === "A2A-IR") ir++;
      else if (e.weaponClass === "A2A-SARH") sarh++;
    } else {
      hasNonA2a = true;
    }
  }
  return { all, a2aAll, arh, ir, sarh, hasNonA2a };
}

function matchesReactionScope(e: MissileEngagement, scope: ReactionWeaponScope): boolean {
  if (e.isGun || e.domain === "A2G") return false;
  if (scope === "all") return true;
  if (scope === "a2a-all") return A2A_MISSILE_CLASSES.includes(e.weaponClass);
  if (scope.startsWith("model:")) return e.weaponName === scope.slice(6);
  return e.weaponClass === (scope as WeaponClass);
}

/**
 * Multi-weapon distribution panel showing when targets suddenly transition
 * from steady/unaware flight into high-G evasive maneuvers or countermeasures
 * (e.g. active radar pitbull RWR warning), with M→T range histogram and breakdown.
 */
export function SuddenReactionCard({
  engagements,
  tacticsById,
  distanceUnit,
  selectedPatches,
  onTogglePatch,
}: {
  engagements: MissileEngagement[];
  tacticsById: Map<string, ShotTacticalMetrics>;
  distanceUnit: DistanceUnit;
  selectedPatches: string[];
  onTogglePatch?: (patch: string) => void;
}) {
  const { t } = useTranslation();
  const unitName = distanceUnitName(distanceUnit);
  const unitM = distanceUnitM(distanceUnit);
  const defaultBin = unitName === "nm" ? 1 : 2;
  const binOptions = unitName === "nm" ? [1, 2, 5] : [2, 5, 10];
  const [binStepUnits, setBinStepUnits] = useState<number>(defaultBin);
  const [stackMode, setStackMode] = useState<"outcome" | "chaff">("outcome");
  const [weaponScope, setWeaponScope] = useState<ReactionWeaponScope>("a2a-all");

  const activeBinUnits = binOptions.includes(binStepUnits) ? binStepUnits : defaultBin;
  const maxUnits = unitName === "nm" ? 24 : 40;

  const scopeCounts = useMemo(() => formatScopeCounts(engagements), [engagements]);

  const baseAnalysis = useMemo(
    () => analyzeSuddenReactions(engagements, tacticsById, activeBinUnits * unitM, maxUnits * unitM),
    [engagements, tacticsById, activeBinUnits, unitM, maxUnits],
  );

  // Fall back cleanly if user changed global filters (e.g. to SAM-only or a different weapon)
  const effectiveScope: ReactionWeaponScope = useMemo(() => {
    if (weaponScope.startsWith("model:")) {
      const targetName = weaponScope.slice(6);
      if (baseAnalysis.byWeapon.some((w) => w.weaponName === targetName)) return weaponScope;
      return scopeCounts.a2aAll > 0 ? "a2a-all" : "all";
    }
    if (weaponScope === "a2a-all" && scopeCounts.a2aAll === 0 && scopeCounts.all > 0) {
      return "all";
    }
    return weaponScope;
  }, [weaponScope, baseAnalysis.byWeapon, scopeCounts.a2aAll, scopeCounts.all]);

  const scopedEngagements = useMemo(
    () =>
      effectiveScope === "all"
        ? engagements
        : engagements.filter((e) => matchesReactionScope(e, effectiveScope)),
    [engagements, effectiveScope],
  );

  const analysis = useMemo(
    () =>
      effectiveScope === "all"
        ? baseAnalysis
        : analyzeSuddenReactions(scopedEngagements, tacticsById, activeBinUnits * unitM, maxUnits * unitM),
    [effectiveScope, baseAnalysis, scopedEngagements, tacticsById, activeBinUnits, unitM, maxUnits],
  );

  const selectedModelName = effectiveScope.startsWith("model:") ? effectiveScope.slice(6) : null;
  const weaponRows = selectedModelName ? baseAnalysis.byWeapon : analysis.byWeapon;
  const visibleBins = useMemo(() => selectVisibleReactionBins(analysis.rangeBins), [analysis.rangeBins]);

  const noReactionSurvRate =
    analysis.noReactionCount > 0 ? analysis.noReactionSurvived / analysis.noReactionCount : null;

  const W = 760;
  const H = 220;
  const margin = { top: 20, right: 16, bottom: 38, left: 40 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;
  const maxCount = Math.max(1, ...visibleBins.map((b) => b.count));
  const yTicks = [...new Set([0, Math.round(maxCount / 2), maxCount])];
  const bandW = visibleBins.length > 0 ? plotW / visibleBins.length : plotW;
  const barW = Math.max(8, bandW - Math.max(4, bandW * 0.24));

  // Locate horizontal pixel coordinate for the median M→T onset range marker
  let medianX: number | null = null;
  if (analysis.medianMissileRangeM != null && visibleBins.length > 0) {
    const medM = analysis.medianMissileRangeM;
    for (let i = 0; i < visibleBins.length; i++) {
      const b = visibleBins[i];
      if (!b) continue;
      if (!b.isOverflow && medM >= b.minM && medM <= b.maxM) {
        const frac = (medM - b.minM) / Math.max(1, b.maxM - b.minM);
        medianX = margin.left + i * bandW + frac * bandW;
        break;
      }
      if (b.isOverflow && medM >= b.minM) {
        medianX = margin.left + i * bandW + bandW * 0.5;
        break;
      }
    }
  }

  const showPatches = analysis.byPatch.length >= 2;
  const resetScope = scopeCounts.a2aAll > 0 ? "a2a-all" : "all";

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>{t("analytics.bvr.reaction.title")}</h3>
          <span className="muted" style={{ fontSize: 11 }}>
            {t("analytics.bvr.reaction.sub")}
          </span>
        </div>
        <div className="chart-controls">
          <div className="mode-switch">
            <button
              type="button"
              className={stackMode === "outcome" ? "on" : ""}
              onClick={() => setStackMode("outcome")}
            >
              {t("analytics.bvr.reaction.outcomeMode")}
            </button>
            <button
              type="button"
              className={stackMode === "chaff" ? "on" : ""}
              onClick={() => setStackMode("chaff")}
            >
              {t("analytics.bvr.reaction.chaffMode")}
            </button>
          </div>
          <div className="mode-switch" title={t("analytics.bvr.reaction.binWidthTitle")}>
            {binOptions.map((step) => (
              <button
                key={step}
                type="button"
                className={activeBinUnits === step ? "on" : ""}
                onClick={() => setBinStepUnits(step)}
              >
                {step}
                {unitName}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="chart-controls"
        style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}
      >
        <div className="mode-switch">
          {scopeCounts.a2aAll > 0 && (
            <button
              type="button"
              className={effectiveScope === "a2a-all" ? "on" : ""}
              onClick={() => setWeaponScope("a2a-all")}
            >
              {t("analytics.bvr.reaction.allA2a", { count: scopeCounts.a2aAll })}
            </button>
          )}
          <button
            type="button"
            className={effectiveScope === "A2A-ARH" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-ARH")}
            disabled={scopeCounts.arh === 0}
          >
            {t("analytics.bvr.reaction.allFox3", { count: scopeCounts.arh })}
          </button>
          <button
            type="button"
            className={effectiveScope === "A2A-IR" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-IR")}
            disabled={scopeCounts.ir === 0}
          >
            {t("analytics.bvr.reaction.allFox2", { count: scopeCounts.ir })}
          </button>
          <button
            type="button"
            className={effectiveScope === "A2A-SARH" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-SARH")}
            disabled={scopeCounts.sarh === 0}
          >
            {t("analytics.bvr.reaction.allFox1", { count: scopeCounts.sarh })}
          </button>
          {(scopeCounts.hasNonA2a || scopeCounts.a2aAll === 0) && (
            <button
              type="button"
              className={effectiveScope === "all" ? "on" : ""}
              onClick={() => setWeaponScope("all")}
            >
              {t("analytics.bvr.reaction.allWeapons", { count: scopeCounts.all })}
            </button>
          )}
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span className="muted">{t("analytics.bvr.reaction.modelByUsage")}</span>
          <select
            aria-label={t("analytics.bvr.reaction.modelSelectAria")}
            value={selectedModelName ? `model:${selectedModelName}` : ""}
            onChange={(e) => {
              const v = e.target.value;
              setWeaponScope(v ? (v as ReactionWeaponScope) : resetScope);
            }}
            style={{
              background: "var(--bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
            }}
          >
            <option value="">
              {t("analytics.bvr.reaction.allModels", { count: baseAnalysis.byWeapon.length })}
            </option>
            {baseAnalysis.byWeapon.map((w) => (
              <option key={w.weaponName} value={`model:${w.weaponName}`}>
                {t("analytics.bvr.reaction.modelOption", {
                  name: w.weaponName,
                  shots: w.shots,
                  sudden: w.suddenCount,
                })}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="notch-kpis">
        <div className="notch-kpi-box">
          <div className="notch-kpi-label">{t("analytics.bvr.reaction.suddenKpi")}</div>
          <div className="notch-kpi-val">
            {analysis.suddenCount}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              {t("analytics.bvr.reaction.trackedSub", { total: analysis.totalAnalyzed })}
            </span>
          </div>
          <div className="notch-kpi-sub">
            {t("analytics.bvr.reaction.earlyUnawareSub", {
              early: analysis.earlyCount,
              unaware: analysis.noReactionCount,
            })}
            {analysis.overlapExcludedCount > 0
              ? t("analytics.bvr.reaction.salvoDeduped", { count: analysis.overlapExcludedCount })
              : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">{t("analytics.bvr.reaction.medianRangeKpi")}</div>
          <div className="notch-kpi-val" style={{ color: "#38bdf8" }}>
            {analysis.medianMissileRangeM != null ? fmtDist(analysis.medianMissileRangeM, distanceUnit) : "—"}
          </div>
          <div className="notch-kpi-sub">
            {analysis.p25MissileRangeM != null && analysis.p75MissileRangeM != null
              ? t("analytics.bvr.reaction.iqrLabel", {
                  p25: fmtDist(analysis.p25MissileRangeM, distanceUnit),
                  p75: fmtDist(analysis.p75MissileRangeM, distanceUnit),
                })
              : t("analytics.bvr.reaction.noSuddenReactions")}
            {analysis.medianMissileRangeCi
              ? t("analytics.bvr.reaction.ciLabel", {
                  lo: fmtDist(analysis.medianMissileRangeCi.lo, distanceUnit),
                  hi: fmtDist(analysis.medianMissileRangeCi.hi, distanceUnit),
                })
              : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">{t("analytics.bvr.reaction.ttiPeakGKpi")}</div>
          <div className="notch-kpi-val">
            {analysis.medianTtiS != null ? `${analysis.medianTtiS.toFixed(1)}s` : "—"}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              TTI
            </span>
          </div>
          <div className="notch-kpi-sub">
            {t("analytics.bvr.reaction.medianPeakLoad")}{" "}
            <strong>{analysis.medianPeakG != null ? `${analysis.medianPeakG.toFixed(1)} G` : "—"}</strong>
            {analysis.p10MissileRangeM != null && analysis.p90MissileRangeM != null
              ? t("analytics.bvr.reaction.p10p90", {
                  p10: fmtDist(analysis.p10MissileRangeM, distanceUnit),
                  p90: fmtDist(analysis.p90MissileRangeM, distanceUnit),
                })
              : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">{t("analytics.bvr.reaction.survivalKpi")}</div>
          <div className="notch-kpi-val" style={{ color: "#34d399" }}>
            {fmtPctRate(analysis.suddenSurvivalRate)}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              ({analysis.suddenSurvived}/{analysis.suddenCount})
            </span>
          </div>
          <div className="notch-kpi-sub">
            {t("analytics.bvr.reaction.chaffVsNoChaff", {
              withRate: fmtPctRate(analysis.withChaffSurvivalRate),
              withSurv: analysis.withChaffSurvived,
              withTotal: analysis.withChaffShots,
              noRate: fmtPctRate(analysis.withoutChaffSurvivalRate),
              noSurv: analysis.withoutChaffSurvived,
              noTotal: analysis.withoutChaffShots,
            })}
            {analysis.noReactionCount > 0
              ? t("analytics.bvr.reaction.unawareSurv", { rate: fmtPctRate(noReactionSurvRate) })
              : ""}
          </div>
        </div>
      </div>

      {analysis.suddenCount === 0 ? (
        <div className="muted" style={{ padding: "12px 0" }}>
          {t("analytics.bvr.reaction.noCleanMatches", {
            early: analysis.earlyCount,
            unaware: analysis.noReactionCount,
          })}
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="analytics-svg"
            role="img"
            aria-label={t("analytics.bvr.reaction.svgAria")}
          >
            {yTicks.map((t) => {
              const y = margin.top + plotH - (t / maxCount) * plotH;
              return (
                <g key={t}>
                  <line
                    x1={margin.left}
                    y1={y}
                    x2={W - margin.right}
                    y2={y}
                    stroke="var(--border)"
                    strokeDasharray="2 3"
                  />
                  <text x={margin.left - 6} y={y + 3} fill="var(--muted)" fontSize={10} textAnchor="end">
                    {t}
                  </text>
                </g>
              );
            })}

            {visibleBins.map((b, idx) => {
              const xCenter = margin.left + idx * bandW + bandW * 0.5;
              const x = xCenter - barW * 0.5;
              const topCount = stackMode === "outcome" ? b.kills : b.withoutChaff;
              const botCount = stackMode === "outcome" ? b.survived : b.withChaff;
              const topColor = stackMode === "outcome" ? "#f87171" : "#f59e0b";
              const botColor = stackMode === "outcome" ? "#34d399" : "#60a5fa";

              const botH = (botCount / maxCount) * plotH;
              const topH = (topCount / maxCount) * plotH;
              const botY = margin.top + plotH - botH;
              const topY = botY - topH;

              const label = formatReactionBinLabel(b, unitM, unitName);
              const tip = t("analytics.bvr.reaction.barTip", {
                label,
                count: b.count,
                survived: b.survived,
                kills: b.kills,
                withChaff: b.withChaff,
                withoutChaff: b.withoutChaff,
                peakG: b.medianPeakG != null ? `; med ${b.medianPeakG.toFixed(1)}G` : "",
              });

              return (
                <g key={b.index}>
                  <title>{tip}</title>
                  {botH > 0 && (
                    <rect
                      x={x}
                      y={botY}
                      width={barW}
                      height={botH}
                      rx={topH === 0 ? 2 : 0}
                      fill={botColor}
                      fillOpacity={0.85}
                    />
                  )}
                  {topH > 0 && (
                    <rect
                      x={x}
                      y={topY}
                      width={barW}
                      height={topH}
                      rx={2}
                      fill={topColor}
                      fillOpacity={0.85}
                    />
                  )}
                  {b.count > 0 && (
                    <text
                      x={xCenter}
                      y={Math.max(margin.top + 10, topY - 4)}
                      fill="var(--text)"
                      fontSize={9.5}
                      textAnchor="middle"
                    >
                      {b.count}
                    </text>
                  )}
                  <text x={xCenter} y={H - 12} fill="var(--muted)" fontSize={9.5} textAnchor="middle">
                    {b.isOverflow
                      ? `${Math.round(b.minM / unitM)}+`
                      : `${Math.round(b.minM / unitM)}–${Math.round(b.maxM / unitM)}`}
                  </text>
                </g>
              );
            })}

            {medianX != null && analysis.medianMissileRangeM != null && (
              <g>
                <line
                  x1={medianX}
                  y1={margin.top}
                  x2={medianX}
                  y2={margin.top + plotH}
                  stroke="#38bdf8"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
                <text
                  x={Math.min(W - margin.right - 4, Math.max(margin.left + 4, medianX + 4))}
                  y={margin.top + 10}
                  fill="#38bdf8"
                  fontSize={10}
                  textAnchor={medianX > W - 110 ? "end" : "start"}
                >
                  {t("analytics.bvr.reaction.medPrefix", {
                    dist: fmtDist(analysis.medianMissileRangeM, distanceUnit),
                  })}
                </text>
              </g>
            )}

            <text
              x={margin.left + plotW * 0.5}
              y={H - 1}
              fill="var(--muted)"
              fontSize={9.5}
              textAnchor="middle"
            >
              {t("analytics.bvr.reaction.xAxis", { unit: unitName })}
            </text>
          </svg>

          <div className="legend-row">
            {stackMode === "outcome" ? (
              <>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#34d399" }} />
                  {t("analytics.bvr.reaction.legendSurvived", { count: analysis.suddenSurvived })}
                </span>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#f87171" }} />
                  {t("analytics.bvr.reaction.legendKilled", { count: analysis.suddenKills })}
                </span>
              </>
            ) : (
              <>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#60a5fa" }} />
                  {t("analytics.bvr.reaction.legendWithChaff", { count: analysis.withChaffShots })}
                </span>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#f59e0b" }} />
                  {t("analytics.bvr.reaction.legendNoChaff", { count: analysis.withoutChaffShots })}
                </span>
              </>
            )}
            <span className="legend-item">
              <span className="dot" style={{ background: "#38bdf8" }} />
              {t("analytics.bvr.reaction.legendMedianRange")}
            </span>
          </div>
        </>
      )}

      {weaponRows.length > 0 && (
        <div className={showPatches ? "charts-two-col" : undefined} style={{ marginTop: 12 }}>
          <div className="table-wrap">
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              {t("analytics.bvr.reaction.byWeaponTitle", { count: weaponRows.length })}
            </div>
            <table className="records">
              <thead>
                <tr>
                  <th>{t("analytics.bvr.reaction.weaponCol")}</th>
                  <th>{t("analytics.bvr.reaction.classCol")}</th>
                  <th>{t("analytics.bvr.reaction.shotsCol")}</th>
                  <th>{t("analytics.bvr.reaction.suddenCol")}</th>
                  <th>{t("analytics.bvr.reaction.earlyCol")}</th>
                  <th>{t("analytics.bvr.reaction.noneCol")}</th>
                  <th>{t("analytics.bvr.reaction.medMtCol")}</th>
                  <th>{t("analytics.bvr.reaction.iqrCol")}</th>
                  <th>{t("analytics.bvr.reaction.medTtiCol")}</th>
                  <th>{t("analytics.bvr.reaction.medGCol")}</th>
                  <th>{t("analytics.bvr.reaction.suddenSurvCol")}</th>
                  <th>{t("analytics.bvr.reaction.unawareSurvCol")}</th>
                </tr>
              </thead>
              <tbody>
                {weaponRows.map((w) => {
                  const selected = selectedModelName === w.weaponName;
                  return (
                    <tr key={w.weaponName} className={selected ? "selected-row" : undefined}>
                      <td>
                        <button
                          type="button"
                          className="quality-toggle"
                          style={
                            selected
                              ? {
                                  borderColor: "var(--accent)",
                                  color: "var(--accent)",
                                  fontWeight: 600,
                                }
                              : { fontWeight: 600 }
                          }
                          onClick={() =>
                            setWeaponScope(
                              selected ? resetScope : (`model:${w.weaponName}` as ReactionWeaponScope),
                            )
                          }
                          title={
                            selected
                              ? t("analytics.bvr.reaction.returnToFamily")
                              : t("analytics.bvr.reaction.focusModel")
                          }
                        >
                          {w.weaponName}
                        </button>
                      </td>
                      <td className="muted">{t(`analytics.models.weaponClass.${w.weaponClass}`)}</td>
                      <td>{w.shots}</td>
                      <td>
                        <strong>{w.suddenCount}</strong>
                      </td>
                      <td className="muted">{w.earlyCount}</td>
                      <td className="muted">{w.noReactionCount}</td>
                      <td>
                        {w.medianMissileRangeM != null ? fmtDist(w.medianMissileRangeM, distanceUnit) : "—"}
                      </td>
                      <td className="muted">
                        {w.p25MissileRangeM != null && w.p75MissileRangeM != null
                          ? `${fmtDist(w.p25MissileRangeM, distanceUnit)}–${fmtDist(
                              w.p75MissileRangeM,
                              distanceUnit,
                            )}`
                          : "—"}
                      </td>
                      <td>{w.medianTtiS != null ? `${w.medianTtiS.toFixed(1)}s` : "—"}</td>
                      <td>{w.medianPeakG != null ? `${w.medianPeakG.toFixed(1)}G` : "—"}</td>
                      <td>{fmtPctRate(w.suddenSurvivalRate)}</td>
                      <td className="muted">{fmtPctRate(w.noReactionSurvivalRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {showPatches && (
            <div className="table-wrap">
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                {t("analytics.bvr.reaction.byPatchTitle")}
              </div>
              <table className="records">
                <thead>
                  <tr>
                    <th>{t("analytics.bvr.reaction.dcsPatchCol")}</th>
                    <th>{t("analytics.bvr.reaction.suddenNCol")}</th>
                    <th>{t("analytics.bvr.reaction.medMtCol")}</th>
                    <th>{t("analytics.bvr.reaction.iqrCol")}</th>
                    <th>{t("analytics.bvr.reaction.medTtiCol")}</th>
                    <th>{t("analytics.bvr.reaction.survivalCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.byPatch.map((p) => {
                    const selected = selectedPatches.includes(p.dcsPatch);
                    const canFilter = onTogglePatch && p.dcsPatch !== "Unknown Version";
                    return (
                      <tr key={p.dcsPatch} className={selected ? "selected-row" : undefined}>
                        <td>
                          {canFilter ? (
                            <button
                              type="button"
                              className="quality-toggle"
                              style={
                                selected
                                  ? {
                                      borderColor: "var(--accent)",
                                      color: "var(--accent)",
                                      fontWeight: 600,
                                    }
                                  : { fontWeight: 600 }
                              }
                              onClick={() => onTogglePatch(p.dcsPatch)}
                              title={t("analytics.bvr.reaction.togglePatchTitle")}
                            >
                              {p.dcsPatch}
                            </button>
                          ) : (
                            <strong>{p.dcsPatch}</strong>
                          )}
                        </td>
                        <td>
                          <strong>{p.suddenCount}</strong>
                        </td>
                        <td>
                          {p.medianMissileRangeM != null ? fmtDist(p.medianMissileRangeM, distanceUnit) : "—"}
                        </td>
                        <td className="muted">
                          {p.p25MissileRangeM != null && p.p75MissileRangeM != null
                            ? `${fmtDist(p.p25MissileRangeM, distanceUnit)}–${fmtDist(
                                p.p75MissileRangeM,
                                distanceUnit,
                              )}`
                            : "—"}
                        </td>
                        <td>{p.medianTtiS != null ? `${p.medianTtiS.toFixed(1)}s` : "—"}</td>
                        <td>
                          {fmtPctRate(p.suddenSurvivalRate)}{" "}
                          <span className="muted">
                            ({p.survived}/{p.suddenCount})
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
