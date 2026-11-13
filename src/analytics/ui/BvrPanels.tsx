import { useMemo, useState } from "react";
import type { DistanceUnit } from "../../settings/schema.ts";
import { fmtDist } from "../../settings/units.ts";
import {
  type CohortSplitMode,
  compareCohorts,
  DEFEAT_MODE_COLORS,
  DEFEAT_MODE_LABELS,
  DEFENSE_TYPE_LABELS,
  type NotchGateAnalysis,
  type PilotReport,
  type ShotTacticalMetrics,
} from "../derive.ts";
import type { MissileEngagement } from "../model.ts";
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
  THREAT_TIER_META,
  THREAT_TIER_ORDER,
  type ThreatTierValidation,
} from "../timeline.ts";

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
          {visibleAlerts.map((a, idx) => {
            const sigColor = a.chanceProb < 0.05 ? "#10b981" : a.chanceProb < 0.15 ? "#eab308" : "#94a3b8";
            const sigBg =
              a.chanceProb < 0.05
                ? "rgba(16, 185, 129, 0.15)"
                : a.chanceProb < 0.15
                  ? "rgba(234, 179, 8, 0.15)"
                  : "rgba(148, 163, 184, 0.14)";
            return (
              <div
                key={idx}
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

export function BvrTimelineCard({
  engagements,
  tacticsById,
}: {
  engagements: MissileEngagement[];
  tacticsById: Map<string, ShotTacticalMetrics>;
}) {
  const [table, setTable] = useState<BvrTimelineTable>(() => cloneTimelineTable(DEFAULT_MILSIM_TIMELINE));
  const [strikeFighterAdd2Nm, setStrikeFighterAdd2Nm] = useState(false);
  const [highAltOnly, setHighAltOnly] = useState(false);
  const [priorWeight, setPriorWeight] = useState<number>(8);
  const [showAllPlanningRows, setShowAllPlanningRows] = useState(true);

  const evaluations = useMemo(
    () =>
      evaluateBvrTimeline(engagements, tacticsById, table, {
        strikeFighterAdd2Nm,
        priorWeight,
        highAltOnly,
      }),
    [engagements, tacticsById, table, strikeFighterAdd2Nm, priorWeight, highAltOnly],
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
    setTable(cloneTimelineTable(DEFAULT_MILSIM_TIMELINE));
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
        </div>
      </div>

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
            className="toggle"
            title="Filter to engagements where shooter or target is >= 18,000 ft (closer to the chart's >M0.95 at 35,000' deploy baseline)"
          >
            <input type="checkbox" checked={highAltOnly} onChange={(e) => setHighAltOnly(e.target.checked)} />{" "}
            BVR High-Alt Envelope Only (&ge;18,000 ft)
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
                  const chartDefault = DEFAULT_MILSIM_TIMELINE[tier][row.key];
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
                        Chart: <strong>{chartDefault}</strong> nm · Auto-Fit:{" "}
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
                  0 shots in current selection — using 100% Mil-Sim Chart prior (MAR{" "}
                  {DEFAULT_MILSIM_TIMELINE[tier].marNm} nm, Threat{" "}
                  {DEFAULT_MILSIM_TIMELINE[tier].threatRangeNm} nm).
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
