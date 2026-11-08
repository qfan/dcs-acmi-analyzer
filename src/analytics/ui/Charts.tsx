import type { AltitudeUnit, DistanceUnit } from "../../settings/schema.ts";
import { distanceUnitM, distanceUnitName, fmtAlt, fmtDist } from "../../settings/units.ts";
import {
  ALT_RELATION_COLORS,
  ALT_RELATION_LABELS,
  ALT_RELATION_ORDER,
  type AltitudeRelation,
  ASPECT_LABELS,
  ASPECT_ORDER,
  ASPECT_SHORT_LABELS,
  type AspectCategory,
  type ClassificationThresholds,
  type MissileEngagement,
  WEAPON_CLASS_LABELS,
} from "../model.ts";
import type { ConditionCell, QueryResult, RangeBin, WeaponSummary } from "../query.ts";

interface MatrixProps {
  matrix: ConditionCell[][];
  maxCellKills: number;
  maxCellShots: number;
  aspectBreakdown: QueryResult["aspectBreakdown"];
  altitudeBreakdown: QueryResult["altitudeBreakdown"];
  totalKills: number;
  totalShots: number;
  selectedAspects: AspectCategory[];
  selectedAltRelations: AltitudeRelation[];
  distanceUnit: DistanceUnit;
  metric: "kills" | "shots" | "pk";
  onSetMetric: (m: "kills" | "shots" | "pk") => void;
  onToggleCell: (aspect: AspectCategory, altRel: AltitudeRelation) => void;
  onToggleAspect: (aspect: AspectCategory) => void;
  onToggleAltRelation: (altRel: AltitudeRelation) => void;
}

/**
 * 2D Initial Condition Heatmap Matrix:
 * Rows = Launcher–Target Aspect (Head-on, Forward Qtr, Beam, Rear Qtr, Tail-on)
 * Columns = Launcher–Target Altitude Relation (Co-Alt High, Co-Alt Low, High→Low, Low→High)
 */
export function ConditionMatrix({
  matrix,
  maxCellKills,
  maxCellShots,
  aspectBreakdown,
  altitudeBreakdown,
  totalKills,
  totalShots,
  selectedAspects,
  selectedAltRelations,
  distanceUnit,
  metric,
  onSetMetric,
  onToggleCell,
  onToggleAspect,
  onToggleAltRelation,
}: MatrixProps) {
  const isCellActive = (asp: AspectCategory, alt: AltitudeRelation) => {
    const aMatch = selectedAspects.length === 0 || selectedAspects.includes(asp);
    const rMatch = selectedAltRelations.length === 0 || selectedAltRelations.includes(alt);
    return (selectedAspects.length > 0 || selectedAltRelations.length > 0) && aMatch && rMatch;
  };

  const cellHeat = (cell: ConditionCell): number => {
    if (metric === "kills") return maxCellKills > 0 ? cell.kills / maxCellKills : 0;
    if (metric === "shots") return maxCellShots > 0 ? cell.shots / maxCellShots : 0;
    return cell.pk ?? 0;
  };

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Initial Condition Distribution Matrix (Aspect × Altitude Relation)</h3>
          <p className="muted small matrix-sub">
            Click any cell, row, or column to filter by launcher–target initial condition.
          </p>
        </div>
        <fieldset className="mode-switch" aria-label="Matrix color metric">
          <button
            type="button"
            className={metric === "kills" ? "on" : ""}
            onClick={() => onSetMetric("kills")}
          >
            Kills
          </button>
          <button
            type="button"
            className={metric === "shots" ? "on" : ""}
            onClick={() => onSetMetric("shots")}
          >
            Shots
          </button>
          <button
            type="button"
            className={metric === "pk" ? "on" : ""}
            onClick={() => onSetMetric("pk")}
          >
            Pk %
          </button>
        </fieldset>
      </div>

      <div className="table-wrap">
        <table className="matrix-table">
          <thead>
            <tr>
              <th>Target Aspect \ Altitude Relation</th>
              {ALT_RELATION_ORDER.map((alt) => {
                const active = selectedAltRelations.includes(alt);
                return (
                  <th key={alt} className="matrix-col-head">
                    <button
                      type="button"
                      className={`matrix-head-btn${active ? " active" : ""}`}
                      onClick={() => onToggleAltRelation(alt)}
                      title="Filter by this altitude relation"
                    >
                      <span className="dot" style={{ background: ALT_RELATION_COLORS[alt] }} />
                      {ALT_RELATION_LABELS[alt]}
                    </button>
                  </th>
                );
              })}
              <th className="num">Row Total</th>
            </tr>
          </thead>
          <tbody>
            {ASPECT_ORDER.map((asp, rIdx) => {
              const row = matrix[rIdx] ?? [];
              const rowSum = aspectBreakdown[rIdx];
              const rowActive = selectedAspects.includes(asp);
              return (
                <tr key={asp}>
                  <th scope="row" className="matrix-row-head">
                    <button
                      type="button"
                      className={`matrix-head-btn${rowActive ? " active" : ""}`}
                      onClick={() => onToggleAspect(asp)}
                      title="Filter by this target aspect"
                    >
                      {ASPECT_LABELS[asp]}
                    </button>
                  </th>
                  {row.map((cell) => {
                    const heat = cellHeat(cell);
                    const active = isCellActive(cell.aspect, cell.altitudeRelation);
                    const bgAlpha = cell.shots > 0 ? Math.round(8 + heat * 36) : 0;
                    return (
                      <td
                        key={cell.altitudeRelation}
                        className={`matrix-cell${active ? " selected" : ""}${cell.shots === 0 ? " empty-cell" : ""}`}
                        style={
                          bgAlpha > 0
                            ? {
                                background: `color-mix(in srgb, var(--accent) ${bgAlpha}%, transparent)`,
                              }
                            : undefined
                        }
                        onClick={() => onToggleCell(cell.aspect, cell.altitudeRelation)}
                      >
                        <div className="cell-main">
                          {metric === "kills" && (
                            <>
                              <span className="cell-big">{cell.kills}</span>
                              <span className="cell-unit">
                                kill{cell.kills === 1 ? "" : "s"}
                                {cell.kills > 0 ? ` (${Math.round(cell.killShare * 100)}%)` : ""}
                              </span>
                            </>
                          )}
                          {metric === "shots" && (
                            <>
                              <span className="cell-big">{cell.shots}</span>
                              <span className="cell-unit">
                                shot{cell.shots === 1 ? "" : "s"} ({cell.kills} kill
                                {cell.kills === 1 ? "" : "s"})
                              </span>
                            </>
                          )}
                          {metric === "pk" && (
                            <>
                              <span className="cell-big">
                                {cell.pk !== null ? `${Math.round(cell.pk * 100)}%` : "–"}
                              </span>
                              <span className="cell-unit">
                                {cell.kills}/{cell.shots} kills
                              </span>
                            </>
                          )}
                        </div>
                        {cell.shots > 0 && (
                          <div className="cell-sub muted small">
                            <span>
                              {cell.kills}/{cell.shots} ({Math.round((cell.pk ?? 0) * 100)}% Pk)
                            </span>
                            {cell.medianKillRangeM !== null && (
                              <span> · med {fmtDist(cell.medianKillRangeM, distanceUnit)}</span>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td className="num matrix-total-cell">
                    {rowSum && (
                      <>
                        <div>
                          <strong>{rowSum.kills}</strong> kills{" "}
                          <span className="muted small">({Math.round(rowSum.killShare * 100)}%)</span>
                        </div>
                        <div className="muted small">
                          {rowSum.shots} shots · {rowSum.pk !== null ? `${Math.round(rowSum.pk * 100)}% Pk` : "–"}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="matrix-foot-row">
              <th>Column Total</th>
              {altitudeBreakdown.map((col) => (
                <td key={col.key} className="matrix-total-cell">
                  <div>
                    <strong>{col.kills}</strong> kills{" "}
                    <span className="muted small">({Math.round(col.killShare * 100)}%)</span>
                  </div>
                  <div className="muted small">
                    {col.shots} shots · {col.pk !== null ? `${Math.round(col.pk * 100)}% Pk` : "–"}
                    {col.medianKillRangeM !== null
                      ? ` · med ${fmtDist(col.medianKillRangeM, distanceUnit)}`
                      : ""}
                  </div>
                </td>
              ))}
              <td className="num matrix-total-cell">
                <div>
                  <strong>{totalKills}</strong> kills
                </div>
                <div className="muted small">
                  {totalShots} shots · {totalShots > 0 ? `${Math.round((totalKills / totalShots) * 100)}% Pk` : "–"}
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

interface RangeChartProps {
  bins: RangeBin[];
  distanceUnit: DistanceUnit;
  binStepUnits: number;
  onChangeBinStepUnits: (step: number) => void;
  showShotsOverlay: boolean;
  onToggleShotsOverlay: (v: boolean) => void;
  activeRangeFilter: { minM: number | null; maxM: number | null };
  onSelectBinRange: (minM: number, maxM: number) => void;
}

/**
 * Interactive SVG Histogram of Initial Launcher–Target Distance,
 * stacked by Altitude Relation with optional Shots & Pk overlay.
 */
export function RangeDistributionChart({
  bins,
  distanceUnit,
  binStepUnits,
  onChangeBinStepUnits,
  showShotsOverlay,
  onToggleShotsOverlay,
  activeRangeFilter,
  onSelectBinRange,
}: RangeChartProps) {
  const unitName = distanceUnitName(distanceUnit);
  const unitM = distanceUnitM(distanceUnit);

  // Trim trailing empty bins while keeping at least 8 bins
  let lastNonEmpty = 7;
  bins.forEach((b, i) => {
    if (b.shots > 0 || b.kills > 0) lastNonEmpty = Math.max(lastNonEmpty, i + 1);
  });
  const visibleBins = bins.slice(0, Math.min(bins.length, lastNonEmpty + 1));

  const maxCount = Math.max(
    1,
    ...visibleBins.map((b) => (showShotsOverlay ? Math.max(b.shots, b.kills) : b.kills)),
  );

  const width = 680;
  const height = 250;
  const padL = 40;
  const padR = 20;
  const padT = 18;
  const padB = 42;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const slotW = plotW / Math.max(1, visibleBins.length);
  const barW = Math.max(10, Math.min(38, slotW * 0.68));

  const stepOptions = unitName === "nm" ? [1, 2, 5, 10] : [2, 5, 10, 15];

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Initial Distance Distribution (Launcher ↔ Target at Launch)</h3>
          <p className="muted small matrix-sub">
            Stacked by altitude relation. Click a distance bar to filter to that range bracket.
          </p>
        </div>
        <div className="chart-controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showShotsOverlay}
              onChange={(e) => onToggleShotsOverlay(e.target.checked)}
            />{" "}
            Show total shots & Pk
          </label>
          <label className="small muted">
            Bin size:{" "}
            <select
              value={binStepUnits}
              onChange={(e) => onChangeBinStepUnits(Number(e.target.value))}
            >
              {stepOptions.map((s) => (
                <option key={s} value={s}>
                  {s} {unitName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="analytics-svg"
        role="img"
        aria-label="Histogram of initial distance between launcher and target"
      >
        {/* Horizontal Y grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const val = Math.round(maxCount * f);
          const y = padT + plotH * (1 - (maxCount > 0 ? val / maxCount : 0));
          return (
            <g key={f}>
              <line
                x1={padL}
                x2={width - padR}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray={f === 0 ? undefined : "3 3"}
              />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                {val}
              </text>
            </g>
          );
        })}

        {visibleBins.map((b, i) => {
          const cx = padL + (i + 0.5) * slotW;
          const x = cx - barW / 2;
          const isSelected =
            activeRangeFilter.minM !== null &&
            activeRangeFilter.maxM !== null &&
            Math.abs(activeRangeFilter.minM - b.minM) < 1 &&
            Math.abs(activeRangeFilter.maxM - b.maxM) < 1;

          // Stack altitude relations from bottom to top
          let yCursor = padT + plotH;
          const segments = ALT_RELATION_ORDER.map((alt) => {
            const count = b.killsByAlt[alt] ?? 0;
            const h = (count / maxCount) * plotH;
            yCursor -= h;
            return { alt, count, y: yCursor, h };
          });

          const shotH = (b.shots / maxCount) * plotH;
          const shotY = padT + plotH - shotH;
          const loLabel = Math.round(b.minM / unitM);
          const hiLabel = Math.round(b.maxM / unitM);

          return (
            <g
              key={b.index}
              className="hist-bar-group"
              onClick={() => onSelectBinRange(b.minM, b.maxM)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {`${loLabel}–${hiLabel} ${unitName}: ${b.kills} kills / ${b.shots} shots${b.pk !== null ? ` (${Math.round(b.pk * 100)}% Pk)` : ""}`}
              </title>
              {isSelected && (
                <rect
                  x={cx - slotW * 0.46}
                  y={padT}
                  width={slotW * 0.92}
                  height={plotH}
                  rx={4}
                  fill="color-mix(in srgb, var(--accent) 14%, transparent)"
                  stroke="var(--accent)"
                />
              )}
              {showShotsOverlay && b.shots > 0 && (
                <rect
                  x={x - 3}
                  y={shotY}
                  width={barW + 6}
                  height={shotH}
                  rx={2}
                  fill="color-mix(in srgb, var(--muted) 22%, transparent)"
                  stroke="var(--border)"
                />
              )}
              {segments.map(
                (seg) =>
                  seg.h > 0 && (
                    <rect
                      key={seg.alt}
                      x={x}
                      y={seg.y}
                      width={barW}
                      height={seg.h}
                      fill={ALT_RELATION_COLORS[seg.alt]}
                    />
                  ),
              )}
              {b.kills > 0 && (
                <text
                  x={cx}
                  y={Math.max(11, padT + plotH - (b.kills / maxCount) * plotH - 4)}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="600"
                  fill="var(--text)"
                >
                  {b.kills}
                </text>
              )}
              {showShotsOverlay && b.pk !== null && b.shots > 0 && (
                <text
                  x={cx}
                  y={Math.max(11, shotY - (b.kills === b.shots ? 15 : 4))}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="var(--muted)"
                >
                  {Math.round(b.pk * 100)}%
                </text>
              )}
              <text
                x={cx}
                y={padT + plotH + 16}
                textAnchor="middle"
                fontSize="10.5"
                fill="var(--muted)"
              >
                {loLabel}–{hiLabel}
              </text>
            </g>
          );
        })}

        <text
          x={padL + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          fontSize="11.5"
          fill="var(--muted)"
        >
          Initial Slant Range ({unitName})
        </text>
      </svg>

      <div className="legend-row">
        {ALT_RELATION_ORDER.map((alt) => (
          <span key={alt} className="legend-item">
            <span className="dot" style={{ background: ALT_RELATION_COLORS[alt] }} />
            {ALT_RELATION_LABELS[alt]}
          </span>
        ))}
        {showShotsOverlay && (
          <span className="legend-item">
            <span
              className="dot"
              style={{
                background: "color-mix(in srgb, var(--muted) 35%, transparent)",
                border: "1px solid var(--border)",
              }}
            />
            Total Shots (outer bar)
          </span>
        )}
      </div>
    </section>
  );
}

interface PolarPlotProps {
  engagements: MissileEngagement[];
  distanceUnit: DistanceUnit;
  showMisses: boolean;
  onToggleShowMisses: (v: boolean) => void;
  selectedId: string | null;
  onSelectEngagement: (id: string) => void;
}

/**
 * Polar Aspect & Range Diagram:
 * - Angle: Target Aspect (180° Head-on at top, 90° Beam left/right, 0° Tail-on at bottom).
 *   Left vs right side uses relative bearing / clock so engagements spread symmetrically.
 * - Radius: Initial Slant Range at launch.
 */
export function PolarAspectRangePlot({
  engagements,
  distanceUnit,
  showMisses,
  onToggleShowMisses,
  selectedId,
  onSelectEngagement,
}: PolarPlotProps) {
  const unitName = distanceUnitName(distanceUnit);
  const unitM = distanceUnitM(distanceUnit);
  const withGeom = engagements.filter((e) => e.initial !== null && (showMisses || e.isKill));

  const maxRangeM = Math.max(
    10 * unitM,
    ...withGeom.map((e) => e.initial!.slantRangeM),
  );
  // Snap outer ring to a clean multiple of 5 or 10 units
  const maxUnits = Math.ceil(maxRangeM / unitM / 5) * 5;
  const outerM = maxUnits * unitM;

  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size / 2 - 36;

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Target Aspect vs. Initial Range (Polar Plot)</h3>
          <p className="muted small matrix-sub">
            180° Head-on (top) → 90° Beam → 0° Tail-on (bottom). Radius = launch range.
          </p>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showMisses}
            onChange={(e) => onToggleShowMisses(e.target.checked)}
          />{" "}
          Plot non-kill shots
        </label>
      </div>

      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="analytics-svg polar-svg"
        role="img"
        aria-label="Polar plot of target aspect angle and initial range"
      >
        {/* Range rings */}
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const r = maxR * f;
          const labelVal = Math.round(maxUnits * f * 10) / 10;
          return (
            <g key={f}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="var(--border)"
                strokeDasharray={f < 1 ? "3 3" : undefined}
              />
              <text x={cx + 4} y={cy - r + 11} fontSize="9.5" fill="var(--muted)">
                {labelVal} {unitName}
              </text>
            </g>
          );
        })}

        {/* Aspect sector boundary lines: 150°, 120°, 60°, 30° on both sides */}
        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
          const rad = ((180 - deg) * Math.PI) / 180;
          const x2 = cx + maxR * Math.sin(rad);
          const y2 = cy + maxR * Math.cos(rad);
          return (
            <line
              key={deg}
              x1={cx}
              y1={cy}
              x2={x2}
              y2={y2}
              stroke="var(--border)"
              strokeOpacity={deg % 90 === 0 ? 0.9 : 0.45}
            />
          );
        })}

        {/* Cardinal aspect labels */}
        <text x={cx} y={16} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">
          180° Head-on (Hot)
        </text>
        <text x={cx} y={size - 8} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">
          0° Tail-on (Cold)
        </text>
        <text x={size - 6} y={cy + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)">
          90° Beam
        </text>
        <text x={6} y={cy + 4} textAnchor="start" fontSize="10.5" fill="var(--muted)">
          90° Beam
        </text>

        {/* Points */}
        {withGeom.map((e, idx) => {
          const ic = e.initial!;
          const rNorm = Math.min(1, ic.slantRangeM / outerM);
          const rPx = rNorm * maxR;
          // Spread left/right deterministically by clock or index so symmetric aspects don't overlap
          const sign = ic.clock > 6 ? -1 : ic.clock < 6 ? 1 : idx % 2 === 0 ? 1 : -1;
          // Top = 180° aspect, bottom = 0° aspect
          const thetaFromTop = ((180 - ic.aspectDeg) * Math.PI) / 180;
          const px = cx + sign * rPx * Math.sin(thetaFromTop);
          const py = cy - rPx * Math.cos(thetaFromTop);
          const color = ALT_RELATION_COLORS[ic.altitudeRelation];
          const isSelected = e.id === selectedId;

          return (
            <g
              key={e.id}
              onClick={() => onSelectEngagement(e.id)}
              style={{ cursor: "pointer" }}
            >
              <title>
                {`${e.weaponName} (${e.isKill ? "KILL" : e.outcome}) — ${ASPECT_SHORT_LABELS[ic.aspectCategory]} (${Math.round(ic.aspectDeg)}°), ${ALT_RELATION_LABELS[ic.altitudeRelation]}, Range ${fmtDist(ic.slantRangeM, distanceUnit)}`}
              </title>
              {isSelected && (
                <circle
                  cx={px}
                  cy={py}
                  r={9}
                  fill="none"
                  stroke="var(--text)"
                  strokeWidth={2}
                />
              )}
              {e.isKill ? (
                <circle
                  cx={px}
                  cy={py}
                  r={5.5}
                  fill={color}
                  stroke="var(--surface)"
                  strokeWidth={1.5}
                />
              ) : (
                <circle
                  cx={px}
                  cy={py}
                  r={4}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.8}
                  opacity={0.75}
                />
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}

interface AltPlotProps {
  engagements: MissileEngagement[];
  altitudeUnit: AltitudeUnit;
  distanceUnit: DistanceUnit;
  thresholds: ClassificationThresholds;
  showMisses: boolean;
  selectedId: string | null;
  onSelectEngagement: (id: string) => void;
}

/**
 * Shooter Altitude vs. Target Altitude Scatter Plot at Launch:
 * Shows the diagonal Co-Altitude corridor, High-Altitude floor, High→Low (below diagonal),
 * and Low→High (above diagonal).
 */
export function AltitudeScatterPlot({
  engagements,
  altitudeUnit,
  distanceUnit,
  thresholds,
  showMisses,
  selectedId,
  onSelectEngagement,
}: AltPlotProps) {
  const isFeet = altitudeUnit.startsWith("ft");
  const kAlt = isFeet ? 3.28084 : 1;
  const altUnitLabel = isFeet ? "ft" : "m";

  const pts = engagements.filter(
    (e) =>
      e.initial !== null &&
      e.shooter?.altM !== null &&
      e.shooter?.altM !== undefined &&
      e.target?.altM !== null &&
      e.target?.altM !== undefined &&
      (showMisses || e.isKill),
  );

  const maxAltM = Math.max(
    12000,
    ...pts.map((e) => Math.max(e.shooter?.altM ?? 0, e.target?.altM ?? 0) * 1.1),
  );

  const width = 340;
  const height = 300;
  const padL = 52;
  const padR = 16;
  const padT = 18;
  const padB = 38;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const toX = (altM: number) => padL + Math.max(0, Math.min(1, altM / maxAltM)) * plotW;
  const toY = (altM: number) => padT + (1 - Math.max(0, Math.min(1, altM / maxAltM))) * plotH;

  const bandFrac = thresholds.coAltBandM / maxAltM;
  const highFloorY = toY(thresholds.highAltFloorM);
  const highFloorX = toX(thresholds.highAltFloorM);

  // Polygon for Co-Altitude corridor (|y - x| <= coAltBandM)
  const bM = thresholds.coAltBandM;
  const polyPts = [
    [0, 0],
    [0, Math.min(maxAltM, bM)],
    [Math.max(0, maxAltM - bM), maxAltM],
    [maxAltM, maxAltM],
    [maxAltM, Math.max(0, maxAltM - bM)],
    [Math.min(maxAltM, bM), 0],
  ]
    .map(([ax, ay]) => `${toX(ax!).toFixed(1)},${toY(ay!).toFixed(1)}`)
    .join(" ");

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Launcher vs. Target Altitude at Launch</h3>
          <p className="muted small matrix-sub">
            Diagonal band = Co-Altitude (±{fmtAlt(thresholds.coAltBandM, altitudeUnit)}). Below diagonal =
            High→Low; above = Low→High.
          </p>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="analytics-svg"
        role="img"
        aria-label="Scatter plot of shooter altitude versus target altitude at launch"
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const mVal = maxAltM * f;
          const x = toX(mVal);
          const y = toY(mVal);
          const disp = isFeet ? `${Math.round((mVal * kAlt) / 1000)}k` : `${(mVal / 1000).toFixed(0)}k`;
          return (
            <g key={f}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
              <line x1={x} x2={x} y1={padT} y2={padT + plotH} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--muted)">
                {disp}
              </text>
              <text x={x} y={padT + plotH + 14} textAnchor="middle" fontSize="10" fill="var(--muted)">
                {disp}
              </text>
            </g>
          );
        })}

        {/* Co-altitude shaded corridor */}
        {bandFrac > 0 && (
          <polygon
            points={polyPts}
            fill="color-mix(in srgb, var(--accent) 10%, transparent)"
            stroke="var(--border)"
          />
        )}

        {/* Exact equal-altitude diagonal */}
        <line
          x1={toX(0)}
          y1={toY(0)}
          x2={toX(maxAltM)}
          y2={toY(maxAltM)}
          stroke="var(--muted)"
          strokeDasharray="4 4"
        />

        {/* High-altitude floor marker */}
        {thresholds.highAltFloorM < maxAltM && (
          <line
            x1={highFloorX}
            y1={highFloorY}
            x2={toX(maxAltM)}
            y2={highFloorY}
            stroke="#3b82f6"
            strokeDasharray="2 3"
            opacity={0.6}
          />
        )}

        {/* Region labels */}
        <text x={padL + 8} y={padT + 16} fontSize="10" fill="#ec4899" fontWeight="600">
          Low → High (Look-up)
        </text>
        <text
          x={width - padR - 8}
          y={padT + plotH - 8}
          textAnchor="end"
          fontSize="10"
          fill="#f59e0b"
          fontWeight="600"
        >
          High → Low (Look-down)
        </text>

        {/* Points */}
        {pts.map((e) => {
          const ic = e.initial!;
          const sx = toX(e.shooter!.altM!);
          const sy = toY(e.target!.altM!);
          const color = ALT_RELATION_COLORS[ic.altitudeRelation];
          const isSelected = e.id === selectedId;
          return (
            <g key={e.id} onClick={() => onSelectEngagement(e.id)} style={{ cursor: "pointer" }}>
              <title>
                {`${e.weaponName} (${e.isKill ? "KILL" : e.outcome}) — Shooter ${fmtAlt(e.shooter!.altM, altitudeUnit)} → Target ${fmtAlt(e.target!.altM, altitudeUnit)} (${ALT_RELATION_LABELS[ic.altitudeRelation]}), Range ${fmtDist(ic.slantRangeM, distanceUnit)}`}
              </title>
              {isSelected && <circle cx={sx} cy={sy} r={9} fill="none" stroke="var(--text)" strokeWidth={2} />}
              {e.isKill ? (
                <circle cx={sx} cy={sy} r={5.5} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
              ) : (
                <circle
                  cx={sx}
                  cy={sy}
                  r={4}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.8}
                  opacity={0.75}
                />
              )}
            </g>
          );
        })}

        <text
          x={padL + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          fontSize="11"
          fill="var(--muted)"
        >
          Shooter Altitude at Launch ({altUnitLabel})
        </text>
        <text
          x={14}
          y={padT + plotH / 2}
          textAnchor="middle"
          fontSize="11"
          fill="var(--muted)"
          transform={`rotate(-90 14 ${padT + plotH / 2})`}
        >
          Target Altitude ({altUnitLabel})
        </text>
      </svg>
    </section>
  );
}

interface WeaponBreakdownProps {
  weapons: WeaponSummary[];
  selectedWeapons: string[];
  distanceUnit: DistanceUnit;
  onToggleWeapon: (weaponName: string) => void;
}

export function WeaponBreakdownCard({
  weapons,
  selectedWeapons,
  distanceUnit,
  onToggleWeapon,
}: WeaponBreakdownProps) {
  if (weapons.length === 0) return null;
  const maxShots = Math.max(1, ...weapons.map((w) => Math.max(w.shots, w.kills)));

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>Kills & Launch Range by Weapon</h3>
          <p className="muted small matrix-sub">Click a weapon row to filter the query to that weapon.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="weapon-table">
          <thead>
            <tr>
              <th>Weapon</th>
              <th>Class</th>
              <th className="num">Kills</th>
              <th className="num">Shots</th>
              <th className="num">Pk</th>
              <th>Distribution</th>
              <th className="num">Median Kill Range</th>
              <th className="num">Min – Max Range</th>
            </tr>
          </thead>
          <tbody>
            {weapons.map((w) => {
              const active = selectedWeapons.includes(w.weaponName);
              const killPct = (w.kills / maxShots) * 100;
              const shotPct = (w.shots / maxShots) * 100;
              return (
                <tr
                  key={w.weaponName}
                  className={`clickable${active ? " selected" : ""}`}
                  onClick={() => onToggleWeapon(w.weaponName)}
                >
                  <td>
                    <strong>{w.weaponName}</strong>
                  </td>
                  <td>
                    <span className="badge">{WEAPON_CLASS_LABELS[w.weaponClass]}</span>
                  </td>
                  <td className="num">
                    <strong>{w.kills}</strong>
                  </td>
                  <td className="num">{w.shots}</td>
                  <td className="num">{w.pk !== null ? `${Math.round(w.pk * 100)}%` : "–"}</td>
                  <td className="bar-cell">
                    <div className="inline-bar-track">
                      <div className="inline-bar-shots" style={{ width: `${shotPct}%` }} />
                      <div className="inline-bar-kills" style={{ width: `${killPct}%` }} />
                    </div>
                  </td>
                  <td className="num">{fmtDist(w.medianKillRangeM, distanceUnit)}</td>
                  <td className="num muted small">
                    {w.minKillRangeM !== null && w.maxKillRangeM !== null
                      ? `${fmtDist(w.minKillRangeM, distanceUnit)} – ${fmtDist(w.maxKillRangeM, distanceUnit)}`
                      : "–"}
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
