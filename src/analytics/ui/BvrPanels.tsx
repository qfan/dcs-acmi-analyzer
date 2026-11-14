import { useEffect, useMemo, useRef, useState } from "react";
import type { DistanceUnit } from "../../settings/schema.ts";
import { distanceUnitM, distanceUnitName, fmtDist } from "../../settings/units.ts";
import {
  analyzeSuddenReactions,
  type CohortSplitMode,
  compareCohorts,
  DEFEAT_MODE_COLORS,
  DEFEAT_MODE_LABELS,
  DEFENSE_TYPE_LABELS,
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
import {
  A2A_MISSILE_CLASSES,
  type MissileEngagement,
  WEAPON_CLASS_LABELS,
  type WeaponClass,
} from "../model.ts";
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

const SAMPLE_CONF_BADGE: Record<
  "high" | "moderate" | "low",
  { label: string; color: string; bg: string; title: string }
> = {
  high: {
    label: "High N",
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.14)",
    title: "High statistical power (>= 40 shots, >= 10 kills across >= 2 sorties)",
  },
  moderate: {
    label: "Mod N",
    color: "#eab308",
    bg: "rgba(234, 179, 8, 0.15)",
    title: "Moderate sample size (>= 15 shots, >= 4 kills) — wide confidence intervals",
  },
  low: {
    label: "Low N (Noisy)",
    color: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.15)",
    title: "Small sample size (< 15 shots or < 4 kills) — differences are very likely due to chance",
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
          <h3>DCS Patch &amp; Cohort Comparison ("What Changed in the Last Update?")</h3>
          <p className="muted small matrix-sub">
            Compare weapon reach, head-on max kill range, missile Mach, and Pk across DCS patches or recording
            dates — with <strong>95% confidence intervals</strong> and{" "}
            <strong>p-values adjusted for the number of comparisons (Holm)</strong> to separate real game
            changes from small-sample luck.
          </p>
        </div>
        <div className="chart-controls">
          <label className="small muted">
            Min shots:{" "}
            <select value={minCohortShots} onChange={(e) => setMinCohortShots(Number(e.target.value))}>
              <option value={0}>All cohorts</option>
              <option value={10}>&ge;10 shots</option>
              <option value={25}>&ge;25 shots</option>
            </select>
          </label>
          <label className="toggle small muted">
            <input
              type="checkbox"
              checked={hideNoisyAlerts}
              onChange={(e) => setHideNoisyAlerts(e.target.checked)}
            />{" "}
            Hide noise-level alerts (adjusted p &ge; 0.15)
          </label>
          {splitMode === "dateCutoff" && (
            <label className="small muted">
              Split date:{" "}
              <input
                type="date"
                value={cutoffDate}
                onChange={(e) => setCutoffDate(e.target.value)}
                style={{ width: 135 }}
              />
            </label>
          )}
          <fieldset className="mode-switch" aria-label="Cohort split mode">
            <button
              type="button"
              className={splitMode === "dcsPatch" ? "on" : ""}
              onClick={() => setSplitMode("dcsPatch")}
            >
              By DCS Patch
            </button>
            <button
              type="button"
              className={splitMode === "month" ? "on" : ""}
              onClick={() => setSplitMode("month")}
            >
              By Month
            </button>
            <button
              type="button"
              className={splitMode === "dateCutoff" ? "on" : ""}
              onClick={() => setSplitMode("dateCutoff")}
            >
              Before / After Date
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
                  title={`Two-tailed test (Mann-Whitney U / two-proportion z / order-statistic exceedance), Holm-adjusted for all comparisons shown. ${a.chanceNote}`}
                >
                  {a.chanceProb < 0.05
                    ? `✓ Significant (adj. p=${a.chanceProb.toFixed(3)})`
                    : a.chanceProb < 0.15
                      ? `~ Borderline (adj. p=${a.chanceProb.toFixed(2)})`
                      : `⚠ Consistent with noise (adj. p=${a.chanceProb.toFixed(2)})`}
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
              <th>Cohort &amp; Power</th>
              <th className="num" title="Number of distinct ACMI recordings in this cohort">
                Sorties
              </th>
              <th className="num">Shots</th>
              <th className="num">Kills</th>
              <th className="num" title="Kill probability with Wilson 95% confidence interval">
                Pk (95% CI)
              </th>
              <th className="num" title="BVR shots (>= 10 nm) with Wilson 95% confidence interval">
                BVR (&ge;10 nm)
              </th>
              <th className="num" title="Median launch range with non-parametric 95% confidence interval">
                Med Shot (95% CI)
              </th>
              <th className="num" title="Median kill range with non-parametric 95% confidence interval">
                Med Kill (95% CI)
              </th>
              <th className="num">Max Kill Range</th>
              <th className="num">Head-On Max Kill</th>
              <th className="num" title="Median peak missile Mach with 95% confidence interval">
                Med Peak Mach (95% CI)
              </th>
              <th className="num">50% Notch Gate</th>
              <th
                className="num"
                title="Smallest Holm-adjusted p-value of the tests against the preceding cohort (lower = less likely to be noise)"
              >
                Adj. p vs Prev
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
                        title={confBadge.title}
                      >
                        {confBadge.label}
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
                        title={`Smallest Holm-adjusted two-tailed p-value vs. previous cohort (p = ${c.vsPrevChanceP.toFixed(3)})`}
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
  const nonZeroDefeats = defeatBreakdown.filter((d) => d.count > 0);

  return (
    <div className="charts-two-col">
      {/* Left: Why Missiles Miss (Defeat Modes) */}
      <section className="card analytics-card">
        <div className="card-head">
          <div>
            <h3>Missile Outcome & Defeat Mode Classification</h3>
            <p className="muted small matrix-sub">
              Classifies every shot by terminal energy, CPA miss distance, and target notch/maneuver state.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th>Outcome / Defeat Mode</th>
                <th className="num">Count</th>
                <th className="num">Share</th>
                <th className="num">Med Launch Range</th>
                <th className="num">Med End Mach</th>
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
                    <strong>{DEFEAT_MODE_LABELS[d.mode]}</strong>
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
            <h3>Target Defensive Reaction & Survival Rate</h3>
            <p className="muted small matrix-sub">
              Behavioral defense inferred from post-launch turn rate, missile-LOS aspect, and chaff/flares.
            </p>
          </div>
          {totalKills > 0 && (
            <span className="badge warn" title="Killed with no measurable turn or countermeasure">
              Died unaware: {diedUnawareCount}/{totalKills} (
              {Math.round((diedUnawareCount / totalKills) * 100)}%)
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table className="records">
            <thead>
              <tr>
                <th>Target Defense Action</th>
                <th className="num">Targeted</th>
                <th className="num">Survived</th>
                <th className="num">Killed</th>
                <th className="num">Survival % (95% CI)</th>
                <th className="num">Med Reaction</th>
              </tr>
            </thead>
            <tbody>
              {defenseBreakdown.map((d) => (
                <tr key={d.defense}>
                  <td>
                    <strong>{DEFENSE_TYPE_LABELS[d.defense]}</strong>
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
          <h3>Empirical Notch Gate & Logistic Regression Seeker Analyzer (Fox-1 / Fox-3 / SAM)</h3>
          <p className="muted small matrix-sub">
            Tests whether a pre-defined ±{notchGateDeg}° beam gate explains radar-missile survival, and fits a
            logistic regression curve to auto-detect the empirical 50% survival boundary.
          </p>
        </div>
        <div className="chart-controls">
          <label className="small muted">
            Pre-defined Notch Gate (90° ± Δ°):{" "}
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
          <span className="muted small">Survival Inside ±{notchGateDeg}° Gate</span>
          <strong>
            {notch.inGateSurvivalRate !== null
              ? `${Math.round(notch.inGateSurvivalRate * 100)}% (${notch.inGateSurvived}/${notch.inGateShots})`
              : "–"}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">Survival Outside ±{notchGateDeg}° Gate</span>
          <strong>
            {notch.outGateSurvivalRate !== null
              ? `${Math.round(notch.outGateSurvivalRate * 100)}% (${notch.outGateSurvived}/${notch.outGateShots})`
              : "–"}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">Gate Rule Accuracy / Precision</span>
          <strong>
            {notch.gateAccuracy !== null ? `${Math.round(notch.gateAccuracy * 100)}% acc` : "–"}
            {notch.gatePrecision !== null ? ` · ${Math.round(notch.gatePrecision * 100)}% prec` : ""}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">ML Auto-Detected 50% Beam Gate</span>
          <strong>
            {notch.empiricalBeamGateDeg !== null
              ? `90° ± ${notch.empiricalBeamGateDeg.toFixed(1)}°`
              : "Insufficient data (<4 shots)"}
          </strong>
        </div>
        <div className="notch-kpi-box">
          <span className="muted small">ML 50% Doppler Radial Velocity Gate</span>
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
        aria-label="Empirical survival rate vs degrees off 90 degree beam"
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
                {`${b.label}: ${b.survived}/${b.shots} survived (${b.survivalRate !== null ? Math.round(b.survivalRate * 100) : 0}% observed, ${Math.round(b.fittedProb * 100)}% logistic fit)`}
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
  const [expanded, setExpanded] = useState(false);
  if (pilots.length === 0) return null;
  const visible = expanded ? pilots : pilots.slice(0, 12);

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Pilot BVR Report Card ({pilots.length} pilots)</h3>
          <p className="muted small matrix-sub">
            Offensive shot range, Pk, F-pole, and defensive survival / reaction time. Click a pilot to filter.
          </p>
        </div>
        {pilots.length > 12 && (
          <button type="button" className="secondary small-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show top 12" : `Show all (${pilots.length})`}
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="records">
          <thead>
            <tr>
              <th>Pilot</th>
              <th>Primary Airframe</th>
              <th className="num">Shots (BVR)</th>
              <th className="num">Kills</th>
              <th className="num">Off. Pk</th>
              <th className="num">Med Shot Range</th>
              <th className="num">Med F-Pole</th>
              <th className="num">Med Crank</th>
              <th className="num">Targeted</th>
              <th className="num">Deaths (Unaware)</th>
              <th className="num">Def. Survival</th>
              <th className="num">Med Reaction</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr
                key={p.pilot}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectPilot(p.pilot)}
                title={`Filter engagements to ${p.pilot}`}
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
                    <span className="muted small"> ({p.diedUnawareCount} unaware)</span>
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

const VERDICT_BADGE_STYLE: Record<GateVerdictStatus, { label: string; color: string; bg: string }> = {
  valid: {
    label: "✓ Validated",
    color: "#10b981",
    bg: "rgba(16, 185, 129, 0.14)",
  },
  optimistic: {
    label: "⚠ Unsafe / Optimistic",
    color: "#ef4444",
    bg: "rgba(239, 68, 68, 0.16)",
  },
  conservative: {
    label: "ℹ Conservative",
    color: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.14)",
  },
  "low-data": {
    label: "Prior Anchor (Low N)",
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
      alert(`Kneeboard save failed: ${err instanceof Error ? err.message : err}`),
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
          <h3>Mil-Sim BVR Timeline & MAR Statistical Validator (F/A-18C Kneeboard vs. Empirical ACMI)</h3>
          <p className="muted small matrix-sub">
            Tests the circulated 4-tier BVR Timeline chart (in <strong>nm</strong>) against your loaded ACMI
            recordings. Edit any range gate manually to see how survival &amp; Pk change, or click{" "}
            <strong>Auto-Fit (Chart Prior + ACMI ML)</strong> to derive optimal numbers via logistic
            regression with Bayesian shrinkage to the chart when sample count is small.
          </p>
        </div>
        <div className="chart-controls">
          <button
            type="button"
            className="secondary small-btn"
            title="Copy Empirical Bayes (Chart Prior + Logistic Regression) numbers into the table"
            onClick={applyAutoPosterior}
          >
            Auto-Fit (Chart Prior + ACMI ML)
          </button>
          <button
            type="button"
            className="secondary small-btn"
            title="Copy pure maximum-likelihood ACMI estimates (0 chart prior)"
            onClick={applyPureMle}
          >
            Pure ACMI MLE
          </button>
          <button
            type="button"
            className="secondary small-btn"
            title="Reset all cells to the original F/A-18C BVR Timeline chart numbers"
            onClick={resetToChartDefault}
          >
            Reset to Chart Baseline
          </button>
          <button
            type="button"
            className="small-btn"
            title="Preview the current table as a clean 768×1024 kneeboard PNG (no stats) for in-game use"
            aria-expanded={showKneeboard}
            onClick={() => setShowKneeboard((v) => !v)}
          >
            {showKneeboard ? "Hide Kneeboard PNG" : "Show Kneeboard PNG"}
          </button>
        </div>
      </div>

      {showKneeboard && (
        <div className="kneeboard-preview">
          <canvas ref={kneeboardRef} className="kneeboard-canvas" aria-label="Kneeboard PNG preview" />
          <div className="kneeboard-side small muted">
            <select
              value={kneeboardPlan}
              onChange={(e) => setKneeboardPlan(e.target.value as KneeboardPlan)}
              title="Print every gate, or only the gates one game plan flies through (Skate: out at MOR · Short Skate: out NLT MAR · Banzai: to the merge)"
              aria-label="Kneeboard game plan"
            >
              {KNEEBOARD_PLAN_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p === "all" ? "All gates" : `Plan ${KNEEBOARD_PLANS[p].label}`}
                </option>
              ))}
            </select>
            <select
              value={kneeboardTheme}
              onChange={(e) => setKneeboardTheme(e.target.value as KneeboardTheme)}
              title="Kneeboard color scheme"
              aria-label="Kneeboard color scheme"
            >
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
            <select
              value={gateTimes === "data" && !dataClosure ? "off" : gateTimes}
              onChange={(e) => setGateTimes(e.target.value)}
              title="Print the seconds between consecutive gates (Commit → Tac → Meld → SR → MOR → DR → LSR → MAR) on the kneeboard, at this closure speed"
              aria-label="Gate times on kneeboard"
            >
              <option value="off">No gate times</option>
              <option value="1000">Gate times @ 1000 kt</option>
              <option value={String(DEFAULT_GATE_CLOSURE_KT)}>
                Gate times @ {DEFAULT_GATE_CLOSURE_KT} kt
              </option>
              <option value="1400">Gate times @ 1400 kt</option>
              {dataClosure && (
                <option value="data">
                  Gate times @ {dataClosure.kt} kt (median of {dataClosure.n} hot BVR shots loaded)
                </option>
              )}
            </select>
            <label
              className="toggle"
              title="Round every gate on the image up to a whole nm (decisions happen earlier, never later). Gate times use the rounded values. The table keeps its decimals."
            >
              <input
                type="checkbox"
                checked={kneeboardRoundUp}
                onChange={(e) => setKneeboardRoundUp(e.target.checked)}
              />{" "}
              Round up to whole nm
            </label>
            {kneeboardPlan === "all" && (
              <label
                className="toggle"
                title="Draw a lane per game plan beside the gates: solid = Skate, hatched = Short Skate, double rail = Banzai. Bars mark the gates a plan uses, dots the ones it flies through, a cross bar where it gets out."
              >
                <input
                  type="checkbox"
                  checked={kneeboardLanes}
                  onChange={(e) => setKneeboardLanes(e.target.checked)}
                />{" "}
                Show game-plan lanes
              </label>
            )}
            <button type="button" className="small-btn" onClick={saveKneeboard}>
              Save PNG
            </button>
            <p>
              Updates live: edit cells in the table, use Auto-Fit, or tick Strike Fighter Tactics below, then
              save. 768×1024, saved at 2× resolution. In DCS, put it in{" "}
              <code>Saved Games\DCS\Kneeboard\</code>.
            </p>
          </div>
        </div>
      )}

      {/* Sub-toolbar for Strike Fighter +2nm, High-Alt filter, Prior weight, and row filter */}
      <div className="query-subbar" style={{ marginBottom: 10 }}>
        <div className="checks-inline">
          <label
            className="toggle"
            title="*STRIKE FIGHTER TACTICS ADD 2NM TO SR & MOR (as noted on the F/A-18C timeline chart)"
          >
            <input
              type="checkbox"
              checked={strikeFighterAdd2Nm}
              onChange={(e) => setStrikeFighterAdd2Nm(e.target.checked)}
            />{" "}
            *Strike Fighter Tactics (+2 nm to NLT SR &amp; MOR)
          </label>
          <label
            className="small muted"
            title="Altitude situation. A band keeps only shots launched in it (mean shooter/target altitude) and scales the chart's kinematic gates (THREAT RANGE, NLT SR, MOR, MRAR, DR, LSR, MAR, STERN WEZ) by how far the fitted missiles reach there compared with 35,000 ft. Radar and decision gates stay. The table restarts from the scaled chart."
          >
            Altitude:{" "}
            <select value={altFilter} onChange={(e) => setAltFilter(e.target.value as AltitudeFilter)}>
              <option value="all">All altitudes (chart as printed)</option>
              <option value="hi18">Shooter or target &ge;18,000 ft (chart as printed)</option>
              {ALTITUDE_BAND_ORDER.map((b) => (
                <option key={b} value={b} disabled={!hasUsableModels}>
                  {ALTITUDE_BANDS[b].label}
                  {hasUsableModels
                    ? ", gates scaled"
                    : fitted
                      ? " (needs 25+ good radar shots)"
                      : " (fitting…)"}
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
            Show all 14 kneeboard rows (include OFR/DFR/Commit/Pump/Meld)
          </label>
        </div>

        <div className="threshold-group">
          <label
            className="small muted"
            title="Virtual sample weight k0 given to the Mil-Sim Chart baseline when auto-fitting: posterior = (n * ACMI + k0 * Chart) / (n + k0)"
          >
            Chart Prior Weight (k₀):{" "}
            <select value={priorWeight} onChange={(e) => setPriorWeight(Number(e.target.value))}>
              <option value={0}>k₀ = 0 (100% ACMI Data)</option>
              <option value={4}>k₀ = 4 (Light Prior)</option>
              <option value={8}>k₀ = 8 (Balanced Prior — default)</option>
              <option value={16}>k₀ = 16 (Strong Chart Prior)</option>
            </select>
          </label>
        </div>
      </div>

      {band && bandScales && (
        <p className="small muted" style={{ margin: "0 0 10px" }}>
          <strong>{ALTITUDE_BANDS[band].label}:</strong>{" "}
          {hasScaledGates ? (
            <>
              gates scaled from the chart&apos;s 35,000 ft by fitted reach at{" "}
              {ALTITUDE_BANDS[band].refFt.toLocaleString()} ft —{" "}
              {THREAT_TIER_ORDER.map((tier) => {
                const sc = bandScales[tier];
                if (!sc) return `${tier}: no fitted missile`;
                return `${tier}: head-on ×${sc.hot.toFixed(2)}, no-escape ×${sc.cold.toFixed(2)} (${sc.borrowed ? "borrowed from all fitted missiles" : sc.weapons.join(", ")})`;
              }).join(" · ")}
              . Auto-Fit then blends in the outcomes of shots launched in this band.
            </>
          ) : (
            "no good fitted missile yet (needs 25+ tracked radar shots) — filtering shots only, chart baseline unchanged."
          )}
        </p>
      )}

      <div className="table-wrap">
        <table className="records timeline-table">
          <thead>
            <tr>
              <th>TIMELINE GATE (NM)</th>
              {THREAT_TIER_ORDER.map((tier) => {
                const meta = THREAT_TIER_META[tier];
                const ev = evaluations[tier];
                return (
                  <th key={tier}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong>{meta.title}</strong>
                      <span className="badge info" style={{ fontSize: 10 }}>
                        {ev.shots} shots · {ev.kills} kills
                      </span>
                    </div>
                    <div className="muted small" style={{ fontWeight: 400, marginTop: 2 }}>
                      {meta.chartAircraft}
                    </div>
                    <div className="muted small" style={{ fontWeight: 400, fontSize: 10 }}>
                      {meta.typicalWeapons} · Data wt: {Math.round(ev.dataWeight * 100)}%
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
                        ACMI Tested
                      </span>
                    ) : (
                      <span className="muted small" style={{ fontSize: 10 }}>
                        (Derived)
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
                          aria-label={`${tier} ${row.code} in nautical miles`}
                        />
                        <span className="muted small">
                          nm
                          {row.hasStrikeFighterStar && strikeBonus > 0 ? ` (${val + strikeBonus}* eff)` : ""}
                        </span>

                        {badge && (
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
                            {badge.label}
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
                        {band ? "Scaled chart" : "Chart"}: <strong>{chartDefault}</strong> nm · Auto-Fit:{" "}
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
                <div className="stat-label">{tier} Verdict</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  0 shots in current selection — using 100% {band ? "scaled " : ""}Mil-Sim Chart prior (MAR{" "}
                  {priorTable[tier].marNm} nm, Threat {priorTable[tier].threatRangeNm} nm).
                </div>
              </div>
            );
          }
          return (
            <div key={tier} className="card kpi-card">
              <div className="stat-label">
                {tier} ({ev.shots} shots · {ev.kills} kills)
              </div>
              <div className="small" style={{ marginTop: 4 }}>
                <div>
                  <strong>Max Aero:</strong> {ev.threatRangeNote}
                </div>
                <div style={{ marginTop: 3 }}>
                  <strong>MAR ({table[tier].marNm} nm):</strong> {ev.marNote}
                </div>
                <div style={{ marginTop: 3 }} className="muted">
                  Recommended MAR: <strong>{ev.posteriorColumn.marNm} nm</strong> · MOR:{" "}
                  <strong>{ev.posteriorColumn.morNm} nm</strong>
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
          <h3>Sudden Defensive Reaction Distribution (&ldquo;When Do Targets React?&rdquo;)</h3>
          <span className="muted" style={{ fontSize: 11 }}>
            Tracks targets flying steady for &ge; 4 s after launch before abruptly initiating &ge; 3.8 G /
            &ge; 8 &deg;/s break turns or decoys — measured at missile-to-target (M&rarr;T) range
          </span>
        </div>
        <div className="chart-controls">
          <div className="mode-switch">
            <button
              type="button"
              className={stackMode === "outcome" ? "on" : ""}
              onClick={() => setStackMode("outcome")}
            >
              Outcome
            </button>
            <button
              type="button"
              className={stackMode === "chaff" ? "on" : ""}
              onClick={() => setStackMode("chaff")}
            >
              Chaff
            </button>
          </div>
          <div className="mode-switch" title="Histogram bin width">
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
              All A2A Missiles ({scopeCounts.a2aAll})
            </button>
          )}
          <button
            type="button"
            className={effectiveScope === "A2A-ARH" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-ARH")}
            disabled={scopeCounts.arh === 0}
          >
            All Fox-3 ({scopeCounts.arh})
          </button>
          <button
            type="button"
            className={effectiveScope === "A2A-IR" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-IR")}
            disabled={scopeCounts.ir === 0}
          >
            All Fox-2 ({scopeCounts.ir})
          </button>
          <button
            type="button"
            className={effectiveScope === "A2A-SARH" ? "on" : ""}
            onClick={() => setWeaponScope("A2A-SARH")}
            disabled={scopeCounts.sarh === 0}
          >
            All Fox-1 ({scopeCounts.sarh})
          </button>
          {(scopeCounts.hasNonA2a || scopeCounts.a2aAll === 0) && (
            <button
              type="button"
              className={effectiveScope === "all" ? "on" : ""}
              onClick={() => setWeaponScope("all")}
            >
              All Weapons ({scopeCounts.all})
            </button>
          )}
        </div>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span className="muted">Model (by usage):</span>
          <select
            aria-label="Specific weapon model ranked by usage"
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
            <option value="">All Models in Scope ({baseAnalysis.byWeapon.length})</option>
            {baseAnalysis.byWeapon.map((w) => (
              <option key={w.weaponName} value={`model:${w.weaponName}`}>
                {w.weaponName} — {w.shots} shots ({w.suddenCount} sudden)
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="notch-kpis">
        <div className="notch-kpi-box">
          <div className="notch-kpi-label">Sudden Late Reactions</div>
          <div className="notch-kpi-val">
            {analysis.suddenCount}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              / {analysis.totalAnalyzed} tracked
            </span>
          </div>
          <div className="notch-kpi-sub">
            {analysis.earlyCount} early &middot; {analysis.noReactionCount} unaware
            {analysis.overlapExcludedCount > 0 ? ` · ${analysis.overlapExcludedCount} salvo-deduped` : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">Median M&rarr;T Onset Range</div>
          <div className="notch-kpi-val" style={{ color: "#38bdf8" }}>
            {analysis.medianMissileRangeM != null ? fmtDist(analysis.medianMissileRangeM, distanceUnit) : "—"}
          </div>
          <div className="notch-kpi-sub">
            {analysis.p25MissileRangeM != null && analysis.p75MissileRangeM != null
              ? `IQR ${fmtDist(analysis.p25MissileRangeM, distanceUnit)}–${fmtDist(
                  analysis.p75MissileRangeM,
                  distanceUnit,
                )}`
              : "No sudden reactions"}
            {analysis.medianMissileRangeCi
              ? ` · 95% CI ${fmtDist(analysis.medianMissileRangeCi.lo, distanceUnit)}–${fmtDist(
                  analysis.medianMissileRangeCi.hi,
                  distanceUnit,
                )}`
              : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">Time Left &amp; Peak G</div>
          <div className="notch-kpi-val">
            {analysis.medianTtiS != null ? `${analysis.medianTtiS.toFixed(1)}s` : "—"}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              TTI
            </span>
          </div>
          <div className="notch-kpi-sub">
            Median peak load:{" "}
            <strong>{analysis.medianPeakG != null ? `${analysis.medianPeakG.toFixed(1)} G` : "—"}</strong>
            {analysis.p10MissileRangeM != null && analysis.p90MissileRangeM != null
              ? ` · P10–P90 ${fmtDist(analysis.p10MissileRangeM, distanceUnit)}–${fmtDist(
                  analysis.p90MissileRangeM,
                  distanceUnit,
                )}`
              : ""}
          </div>
        </div>

        <div className="notch-kpi-box">
          <div className="notch-kpi-label">Sudden Defense Survival</div>
          <div className="notch-kpi-val" style={{ color: "#34d399" }}>
            {fmtPctRate(analysis.suddenSurvivalRate)}
            <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
              {" "}
              ({analysis.suddenSurvived}/{analysis.suddenCount})
            </span>
          </div>
          <div className="notch-kpi-sub">
            Chaff {fmtPctRate(analysis.withChaffSurvivalRate)} ({analysis.withChaffSurvived}/
            {analysis.withChaffShots}) vs No chaff {fmtPctRate(analysis.withoutChaffSurvivalRate)} (
            {analysis.withoutChaffSurvived}/{analysis.withoutChaffShots})
            {analysis.noReactionCount > 0 ? ` · Unaware ${fmtPctRate(noReactionSurvRate)}` : ""}
          </div>
        </div>
      </div>

      {analysis.suddenCount === 0 ? (
        <div className="muted" style={{ padding: "12px 0" }}>
          No clean sudden late defensive reactions matched the current filters ({analysis.earlyCount} reacted
          early, {analysis.noReactionCount} stayed non-maneuvering).
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="analytics-svg"
            role="img"
            aria-label="Missile-to-target range distribution at sudden reaction onset"
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
              const tip = `${label}: ${b.count} shots (${b.survived} survived, ${b.kills} killed; ${b.withChaff} w/ chaff, ${b.withoutChaff} no chaff${
                b.medianPeakG != null ? `; med ${b.medianPeakG.toFixed(1)}G` : ""
              })`;

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
                  Med {fmtDist(analysis.medianMissileRangeM, distanceUnit)}
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
              Missile-to-Target Slant Range at Sudden Reaction Onset ({unitName})
            </text>
          </svg>

          <div className="legend-row">
            {stackMode === "outcome" ? (
              <>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#34d399" }} />
                  Survived ({analysis.suddenSurvived})
                </span>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#f87171" }} />
                  Killed ({analysis.suddenKills})
                </span>
              </>
            ) : (
              <>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#60a5fa" }} />
                  With chaff ({analysis.withChaffShots})
                </span>
                <span className="legend-item">
                  <span className="dot" style={{ background: "#f59e0b" }} />
                  Maneuver / no chaff ({analysis.withoutChaffShots})
                </span>
              </>
            )}
            <span className="legend-item">
              <span className="dot" style={{ background: "#38bdf8" }} />
              Median M&rarr;T range
            </span>
          </div>
        </>
      )}

      {weaponRows.length > 0 && (
        <div className={showPatches ? "charts-two-col" : undefined} style={{ marginTop: 12 }}>
          <div className="table-wrap">
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
              By Weapon Ranked by Usage ({weaponRows.length} models &middot; click model to focus)
            </div>
            <table className="records">
              <thead>
                <tr>
                  <th>Weapon</th>
                  <th>Class</th>
                  <th>Shots</th>
                  <th>Sudden</th>
                  <th>Early</th>
                  <th>None</th>
                  <th>Med M&rarr;T</th>
                  <th>IQR</th>
                  <th>Med TTI</th>
                  <th>Med G</th>
                  <th>Sudden Surv</th>
                  <th>Unaware Surv</th>
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
                          title={selected ? "Return to family scope" : "Focus this weapon model"}
                        >
                          {w.weaponName}
                        </button>
                      </td>
                      <td className="muted">{WEAPON_CLASS_LABELS[w.weaponClass]}</td>
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
                By DCS Version (pitbull / seeker reaction range drift)
              </div>
              <table className="records">
                <thead>
                  <tr>
                    <th>DCS Patch</th>
                    <th>Sudden n</th>
                    <th>Med M&rarr;T</th>
                    <th>IQR</th>
                    <th>Med TTI</th>
                    <th>Survival</th>
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
                              title="Toggle DCS patch filter"
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
