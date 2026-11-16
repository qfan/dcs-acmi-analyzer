import { useMemo, useState } from "react";
import { useSettings } from "../../settings/react.ts";
import { distanceUnitM, distanceUnitName, fmtAlt, fmtDist } from "../../settings/units.ts";
import {
  A2A_MISSILE_CLASSES,
  ALT_RELATION_LABELS,
  type AltitudeRelation,
  ASPECT_SHORT_LABELS,
  type AspectCategory,
  DEFAULT_THRESHOLDS,
  type EngagementDomain,
  type FileAnalytics,
  type MissileEngagement,
  QUALITY_FLAG_LABELS,
  WEAPON_CLASS_LABELS,
  WEAPON_CLASS_ORDER,
  type WeaponClass,
} from "../model.ts";
import { type AnalyticsQuery, DEFAULT_QUERY, runAnalyticsQuery } from "../query.ts";
import {
  BvrTimelineCard,
  DefeatAndDefenseCard,
  NotchAnalyzerCard,
  PatchComparisonCard,
  PilotReportCard,
  SuddenReactionCard,
} from "./BvrPanels.tsx";
import {
  AltitudeScatterPlot,
  ConditionMatrix,
  PolarAspectRangePlot,
  RangeDistributionChart,
  WeaponBreakdownCard,
} from "./Charts.tsx";
import { EngagementTable } from "./EngagementTable.tsx";
import { MissileModelsCard, useFittedMissiles } from "./MissilePanels.tsx";

/**
 * Query state and results behind the analytics panels, shared by the multi-file Analytics page and
 * the single-file viewer's "Enable analytics" section.
 */
export function useAnalyticsDashboard(files: FileAnalytics[], initialQuery: AnalyticsQuery = DEFAULT_QUERY) {
  const { settings } = useSettings();
  const units = settings.units;
  const distUnitM = distanceUnitM(units.distance);

  const [query, setQuery] = useState<AnalyticsQuery>(initialQuery);
  const [matrixMetric, setMatrixMetric] = useState<"kills" | "shots" | "pk">("kills");
  const [binStepUnits, setBinStepUnits] = useState<number>(5);
  const [showShotsOverlay, setShowShotsOverlay] = useState(true);
  const [showMissesOnScatter, setShowMissesOnScatter] = useState(false);
  const [selectedEngagementId, setSelectedEngagementId] = useState<string | null>(null);

  const binStepM = binStepUnits * distUnitM;
  const result = useMemo(() => runAnalyticsQuery(files, query, binStepM, 18), [files, query, binStepM]);

  const hasActiveFilters =
    query.aspects.length > 0 ||
    query.altitudeRelations.length > 0 ||
    query.dcsPatches.length > 0 ||
    query.weaponClasses.length > 0 ||
    query.weaponNames.length > 0 ||
    query.shooterSide !== "" ||
    query.shooterAircraft !== "" ||
    query.targetAircraft !== "" ||
    query.searchText.trim() !== "" ||
    query.minRangeM !== null ||
    query.maxRangeM !== null ||
    query.minFileBvrShots > 0 ||
    query.excludeQualityFlags.length > 0 ||
    query.excludeUfoShots ||
    query.includeGuns ||
    !query.excludeFriendlyFire ||
    query.confirmedTargetsOnly ||
    query.minConfidence !== "low";

  return {
    units,
    query,
    setQuery,
    result,
    hasActiveFilters,
    matrixMetric,
    setMatrixMetric,
    binStepUnits,
    setBinStepUnits,
    showShotsOverlay,
    setShowShotsOverlay,
    showMissesOnScatter,
    setShowMissesOnScatter,
    selectedEngagementId,
    setSelectedEngagementId,
  };
}

export type AnalyticsDashboardState = ReturnType<typeof useAnalyticsDashboard>;

export interface AnalyticsPanelsProps {
  dash: AnalyticsDashboardState;
  /**
   * One recording: hide what needs many files (patch comparison, the BVR timeline validator) and
   * the multi-file filters (patch, min BVR shots per file, duplicate copies).
   */
  singleFile?: boolean;
  /** When set, shots get a "Show on map" action (the single-file viewer's map). */
  onShowOnMap?: (e: MissileEngagement) => void;
}

const NO_ENGAGEMENTS: MissileEngagement[] = [];

/** Filters, KPIs, charts, cards and the engagement table, in page order. */
export function AnalyticsPanels({ dash, singleFile = false, onShowOnMap }: AnalyticsPanelsProps) {
  const { units, query, setQuery, result, selectedEngagementId, setSelectedEngagementId } = dash;
  // One recording rarely has enough shots per missile to fit, so the viewer skips it.
  const missileFit = useFittedMissiles(singleFile ? NO_ENGAGEMENTS : result.engagements);
  const distUnitName = distanceUnitName(units.distance);
  const distUnitM = distanceUnitM(units.distance);

  const toggleCell = (aspect: AspectCategory, altRel: AltitudeRelation) => {
    const exactMatch =
      query.aspects.length === 1 &&
      query.aspects[0] === aspect &&
      query.altitudeRelations.length === 1 &&
      query.altitudeRelations[0] === altRel;
    if (exactMatch) {
      setQuery({ ...query, aspects: [], altitudeRelations: [] });
    } else {
      setQuery({ ...query, aspects: [aspect], altitudeRelations: [altRel] });
    }
  };

  const toggleAspect = (aspect: AspectCategory) => {
    const exists = query.aspects.includes(aspect);
    const next = exists ? query.aspects.filter((a) => a !== aspect) : [...query.aspects, aspect];
    setQuery({ ...query, aspects: next });
  };

  const toggleAltRelation = (altRel: AltitudeRelation) => {
    const exists = query.altitudeRelations.includes(altRel);
    const next = exists
      ? query.altitudeRelations.filter((r) => r !== altRel)
      : [...query.altitudeRelations, altRel];
    setQuery({ ...query, altitudeRelations: next });
  };

  const toggleWeapon = (weaponName: string) => {
    const exists = query.weaponNames.includes(weaponName);
    const next = exists
      ? query.weaponNames.filter((w) => w !== weaponName)
      : [...query.weaponNames, weaponName];
    setQuery({ ...query, weaponNames: next });
  };

  const togglePatch = (patch: string) => {
    const exists = query.dcsPatches.includes(patch);
    const next = exists ? query.dcsPatches.filter((p) => p !== patch) : [...query.dcsPatches, patch];
    setQuery({ ...query, dcsPatches: next });
  };

  const toggleBinRange = (minM: number, maxM: number) => {
    const same =
      query.minRangeM !== null &&
      query.maxRangeM !== null &&
      Math.abs(query.minRangeM - minM) < 1 &&
      Math.abs(query.maxRangeM - maxM) < 1;
    if (same) {
      setQuery({ ...query, minRangeM: null, maxRangeM: null });
    } else {
      setQuery({ ...query, minRangeM: minM, maxRangeM: maxM });
    }
  };

  const selectEngagement = (id: string) => setSelectedEngagementId(selectedEngagementId === id ? null : id);
  // A double-click first delivers two clicks (select, then deselect), so select explicitly here:
  // the dot stays highlighted while the map jumps to it.
  const showDotOnMap = onShowOnMap
    ? (e: MissileEngagement) => {
        setSelectedEngagementId(e.id);
        onShowOnMap(e);
      }
    : undefined;

  return (
    <>
      <QueryFilterCard
        query={query}
        setQuery={setQuery}
        facets={result.facets}
        distUnitName={distUnitName}
        distUnitM={distUnitM}
        altitudeUnit={units.altitude}
        hasActiveFilters={dash.hasActiveFilters}
        singleFile={singleFile}
      />

      <KpiStrip kpis={result.kpis} distanceUnit={units.distance} />

      <ConditionMatrix
        matrix={result.matrix}
        maxCellKills={result.maxCellKills}
        maxCellShots={result.maxCellShots}
        aspectBreakdown={result.aspectBreakdown}
        altitudeBreakdown={result.altitudeBreakdown}
        totalKills={result.kpis.totalKills}
        totalShots={result.kpis.shotsWithTarget}
        selectedAspects={query.aspects}
        selectedAltRelations={query.altitudeRelations}
        distanceUnit={units.distance}
        metric={dash.matrixMetric}
        onSetMetric={dash.setMatrixMetric}
        onToggleCell={toggleCell}
        onToggleAspect={toggleAspect}
        onToggleAltRelation={toggleAltRelation}
      />

      <RangeDistributionChart
        bins={result.rangeHistogram}
        distanceUnit={units.distance}
        binStepUnits={dash.binStepUnits}
        onChangeBinStepUnits={dash.setBinStepUnits}
        showShotsOverlay={dash.showShotsOverlay}
        onToggleShotsOverlay={dash.setShowShotsOverlay}
        activeRangeFilter={{ minM: query.minRangeM, maxM: query.maxRangeM }}
        onSelectBinRange={toggleBinRange}
      />

      <div className="charts-two-col">
        <PolarAspectRangePlot
          engagements={result.engagements}
          distanceUnit={units.distance}
          showMisses={dash.showMissesOnScatter}
          onToggleShowMisses={dash.setShowMissesOnScatter}
          selectedId={selectedEngagementId}
          onSelectEngagement={selectEngagement}
          onShowOnMap={showDotOnMap}
        />
        <AltitudeScatterPlot
          engagements={result.engagements}
          altitudeUnit={units.altitude}
          distanceUnit={units.distance}
          thresholds={query.thresholds}
          showMisses={dash.showMissesOnScatter}
          selectedId={selectedEngagementId}
          onSelectEngagement={selectEngagement}
          onShowOnMap={showDotOnMap}
        />
      </div>

      {!singleFile && (
        <PatchComparisonCard
          engagements={result.engagements}
          tacticsById={result.tacticsById}
          selectedPatches={query.dcsPatches}
          distanceUnit={units.distance}
          onTogglePatch={togglePatch}
        />
      )}

      <DefeatAndDefenseCard
        defeatBreakdown={result.defeatBreakdown}
        defenseBreakdown={result.defenseBreakdown}
        diedUnawareCount={result.kpis.diedUnawareCount}
        totalKills={result.kpis.totalKills}
        distanceUnit={units.distance}
      />

      <NotchAnalyzerCard
        notch={result.notchAnalysis}
        notchGateDeg={query.notchGateDeg}
        onChangeNotchGateDeg={(deg) => setQuery({ ...query, notchGateDeg: deg })}
      />

      <SuddenReactionCard
        engagements={result.engagements}
        tacticsById={result.tacticsById}
        distanceUnit={units.distance}
        selectedPatches={query.dcsPatches}
        onTogglePatch={singleFile ? undefined : togglePatch}
      />

      {!singleFile && <MissileModelsCard fitted={missileFit.fitted} busy={missileFit.busy} />}

      {!singleFile && (
        <BvrTimelineCard
          engagements={result.engagements}
          tacticsById={result.tacticsById}
          fitted={missileFit.fitted}
        />
      )}

      <WeaponBreakdownCard
        weapons={result.weaponBreakdown}
        selectedWeapons={query.weaponNames}
        distanceUnit={units.distance}
        onToggleWeapon={toggleWeapon}
      />

      <PilotReportCard
        pilots={result.pilotReports}
        distanceUnit={units.distance}
        onSelectPilot={(pilot) =>
          setQuery({
            ...query,
            searchText: query.searchText === pilot ? "" : pilot,
          })
        }
      />

      <EngagementTable
        engagements={result.engagements}
        kills={result.kills}
        units={units}
        selectedId={selectedEngagementId}
        onSelectId={setSelectedEngagementId}
        onShowOnMap={onShowOnMap}
      />
    </>
  );
}

function QueryFilterCard({
  query,
  setQuery,
  facets,
  distUnitName,
  distUnitM,
  altitudeUnit,
  hasActiveFilters,
  singleFile,
}: {
  query: AnalyticsQuery;
  setQuery: (q: AnalyticsQuery) => void;
  facets: ReturnType<typeof runAnalyticsQuery>["facets"];
  distUnitName: "nm" | "km";
  distUnitM: number;
  altitudeUnit: "ft" | "m" | "ft+m" | "m+ft";
  hasActiveFilters: boolean;
  singleFile: boolean;
}) {
  const domainKey = query.domains.length === 1 ? query.domains[0]! : "ALL";
  const setDomainKey = (v: string) => {
    if (v === "ALL") setQuery({ ...query, domains: [] });
    else setQuery({ ...query, domains: [v as EngagementDomain] });
  };

  const minRangeDisp =
    query.minRangeM !== null ? String(Math.round((query.minRangeM / distUnitM) * 10) / 10) : "";
  const maxRangeDisp =
    query.maxRangeM !== null ? String(Math.round((query.maxRangeM / distUnitM) * 10) / 10) : "";

  const applyRangePreset = (minKm: number | null, maxKm: number | null) => {
    setQuery({
      ...query,
      minRangeM: minKm !== null ? minKm * 1000 : null,
      maxRangeM: maxKm !== null ? maxKm * 1000 : null,
    });
  };

  const isAllA2aMissiles =
    query.weaponClasses.length === A2A_MISSILE_CLASSES.length &&
    A2A_MISSILE_CLASSES.every((c) => query.weaponClasses.includes(c));
  const weaponFamilyValue = isAllA2aMissiles ? "A2A-MISSILES" : (query.weaponClasses[0] ?? "");

  return (
    <section className="card analytics-card query-panel" aria-label="Query filters">
      <div className="query-grid">
        <label>
          <span>Domain</span>
          <select value={domainKey} onChange={(e) => setDomainKey(e.target.value)}>
            <option value="A2A">Air-to-Air (A2A)</option>
            <option value="SAM">Surface-to-Air (SAM)</option>
            <option value="A2G">Air-to-Ground (A2G)</option>
            <option value="ALL">All Domains</option>
          </select>
        </label>

        <label>
          <span>Weapon Family</span>
          <select
            value={weaponFamilyValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "A2A-MISSILES") {
                setQuery({ ...query, weaponClasses: [...A2A_MISSILE_CLASSES] });
              } else {
                setQuery({ ...query, weaponClasses: v ? [v as WeaponClass] : [] });
              }
            }}
          >
            <option value="">All Weapon Families</option>
            <option value="A2A-MISSILES">All A2A Missiles (Fox-1/2/3)</option>
            {WEAPON_CLASS_ORDER.map((wc) => (
              <option key={wc} value={wc}>
                {WEAPON_CLASS_LABELS[wc]}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Specific Weapon</span>
          <select
            value={query.weaponNames[0] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setQuery({ ...query, weaponNames: v ? [v] : [] });
            }}
          >
            <option value="">All Weapons ({facets.weaponCounts.length})</option>
            {facets.weaponCounts.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name} ({w.count})
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Launcher Aircraft</span>
          <select
            value={query.shooterAircraft}
            onChange={(e) => setQuery({ ...query, shooterAircraft: e.target.value })}
          >
            <option value="">All Launchers ({facets.shooterAircraft.length})</option>
            {facets.shooterAircraft.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Target Aircraft</span>
          <select
            value={query.targetAircraft}
            onChange={(e) => setQuery({ ...query, targetAircraft: e.target.value })}
          >
            <option value="">All Targets ({facets.targetAircraft.length})</option>
            {facets.targetAircraft.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        {!singleFile && (
          <label>
            <span>DCS Patch</span>
            <select
              value={query.dcsPatches[0] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setQuery({ ...query, dcsPatches: v ? [v] : [] });
              }}
            >
              <option value="">All Patches ({facets.dcsPatches.length})</option>
              {facets.dcsPatches.map((p) => (
                <option key={p} value={p}>
                  {/^\d/.test(p) ? `DCS ${p}` : p}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span>Launcher Side</span>
          <select
            value={query.shooterSide}
            onChange={(e) => setQuery({ ...query, shooterSide: e.target.value })}
          >
            <option value="">All Sides</option>
            {facets.sides.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Min Range ({distUnitName})</span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="0"
            value={minRangeDisp}
            onChange={(e) => {
              const val = e.target.value.trim();
              setQuery({
                ...query,
                minRangeM: val === "" ? null : Math.max(0, Number(val) * distUnitM),
              });
            }}
          />
        </label>

        <label>
          <span>Max Range ({distUnitName})</span>
          <input
            type="number"
            min={0}
            step="any"
            placeholder="Any"
            value={maxRangeDisp}
            onChange={(e) => {
              const val = e.target.value.trim();
              setQuery({
                ...query,
                maxRangeM: val === "" ? null : Math.max(0, Number(val) * distUnitM),
              });
            }}
          />
        </label>

        <label className="grow">
          <span>Search</span>
          <input
            type="search"
            placeholder="Pilot, aircraft, weapon, mission…"
            value={query.searchText}
            onChange={(e) => setQuery({ ...query, searchText: e.target.value })}
          />
        </label>
      </div>

      {/* Range presets, Threshold controls, and toggles */}
      <div className="query-subbar">
        <div className="preset-group">
          <span className="muted small">Range presets:</span>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(null, null)}>
            All
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(0, 10)}>
            WVR (&le;{fmtDist(10000, altitudeUnit.startsWith("ft") ? "nm" : "km")})
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(10, 35)}>
            Med BVR (10–35 km)
          </button>
          <button type="button" className="secondary small-btn" onClick={() => applyRangePreset(35, null)}>
            Long BVR (&ge;35 km)
          </button>
        </div>

        <div className="threshold-group">
          <label className="small muted">
            Co-Alt band (±Δh):{" "}
            <select
              value={query.thresholds.coAltBandM}
              onChange={(e) =>
                setQuery({
                  ...query,
                  thresholds: { ...query.thresholds, coAltBandM: Number(e.target.value) },
                })
              }
            >
              <option value={500}>±{fmtAlt(500, altitudeUnit)}</option>
              <option value={1000}>±{fmtAlt(1000, altitudeUnit)} (default)</option>
              <option value={1500}>±{fmtAlt(1500, altitudeUnit)}</option>
              <option value={2000}>±{fmtAlt(2000, altitudeUnit)}</option>
            </select>
          </label>

          <label className="small muted">
            High-Alt floor:{" "}
            <select
              value={query.thresholds.highAltFloorM}
              onChange={(e) =>
                setQuery({
                  ...query,
                  thresholds: { ...query.thresholds, highAltFloorM: Number(e.target.value) },
                })
              }
            >
              <option value={4572}>{fmtAlt(4572, altitudeUnit)}</option>
              <option value={6096}>{fmtAlt(6096, altitudeUnit)}</option>
              <option value={7620}>{fmtAlt(7620, altitudeUnit)}</option>
              <option value={9144}>{fmtAlt(9144, altitudeUnit)} (High default)</option>
              <option value={10668}>{fmtAlt(10668, altitudeUnit)}</option>
              <option value={12192}>{fmtAlt(12192, altitudeUnit)} (Ultra-High)</option>
            </select>
          </label>
          {!singleFile && (
            <label
              className="small muted"
              title="Exclude pure dogfight recordings with fewer than N BVR missile shots (>10 nm)"
            >
              Min BVR/file:{" "}
              <select
                value={query.minFileBvrShots}
                onChange={(e) => setQuery({ ...query, minFileBvrShots: Number(e.target.value) })}
              >
                <option value={0}>Any (0+)</option>
                <option value={1}>&ge;1 BVR shot</option>
                <option value={3}>&ge;3 BVR shots</option>
                <option value={5}>&ge;5 BVR shots</option>
              </select>
            </label>
          )}
        </div>

        <div className="checks-inline">
          {!singleFile && (
            <label
              className="toggle"
              title="Automatically ignore duplicate copies of the same recording session"
            >
              <input
                type="checkbox"
                checked={query.deduplicateSessions}
                onChange={(e) => setQuery({ ...query, deduplicateSessions: e.target.checked })}
              />{" "}
              De-dup copies
            </label>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.includeGuns}
              onChange={(e) => setQuery({ ...query, includeGuns: e.target.checked })}
            />{" "}
            Include guns
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.excludeFriendlyFire}
              onChange={(e) => setQuery({ ...query, excludeFriendlyFire: e.target.checked })}
            />{" "}
            Exclude friendly fire
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={query.confirmedTargetsOnly}
              onChange={(e) => setQuery({ ...query, confirmedTargetsOnly: e.target.checked })}
            />{" "}
            Confirmed targets only
          </label>
        </div>
      </div>

      {/* Active filter chips */}
      {hasActiveFilters && (
        <div className="active-filters-bar">
          <span className="muted small">Active filters:</span>
          {query.aspects.map((a) => (
            <button
              key={a}
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, aspects: query.aspects.filter((x) => x !== a) })}
            >
              Aspect: {ASPECT_SHORT_LABELS[a]} ×
            </button>
          ))}
          {query.altitudeRelations.map((r) => (
            <button
              key={r}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  altitudeRelations: query.altitudeRelations.filter((x) => x !== r),
                })
              }
            >
              Altitude: {ALT_RELATION_LABELS[r]} ×
            </button>
          ))}
          {query.weaponNames.map((w) => (
            <button
              key={w}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  weaponNames: query.weaponNames.filter((x) => x !== w),
                })
              }
            >
              Weapon: {w} ×
            </button>
          ))}
          {(query.minRangeM !== null || query.maxRangeM !== null) && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, minRangeM: null, maxRangeM: null })}
            >
              Range: {query.minRangeM !== null ? fmtDist(query.minRangeM, "km") : "0"} –{" "}
              {query.maxRangeM !== null ? fmtDist(query.maxRangeM, "km") : "∞"} ×
            </button>
          )}
          {query.excludeQualityFlags.map((flag) => (
            <button
              key={flag}
              type="button"
              className="filter-chip"
              onClick={() =>
                setQuery({
                  ...query,
                  excludeQualityFlags: query.excludeQualityFlags.filter((x) => x !== flag),
                })
              }
            >
              Excluding: {QUALITY_FLAG_LABELS[flag]} ×
            </button>
          ))}
          {query.excludeUfoShots && (
            <button
              type="button"
              className="filter-chip"
              onClick={() => setQuery({ ...query, excludeUfoShots: false })}
            >
              Excluding: UFO-affected shots ×
            </button>
          )}
          <button
            type="button"
            className="secondary small-btn"
            onClick={() =>
              setQuery({
                ...DEFAULT_QUERY,
                enabledFileIds: query.enabledFileIds,
                includeBvrTrainer: query.includeBvrTrainer,
                thresholds: { ...DEFAULT_THRESHOLDS },
              })
            }
          >
            Reset all filters
          </button>
        </div>
      )}
    </section>
  );
}

function KpiStrip({
  kpis,
  distanceUnit,
}: {
  kpis: ReturnType<typeof runAnalyticsQuery>["kpis"];
  distanceUnit: "nm" | "km" | "nm+km" | "km+nm";
}) {
  return (
    <section className="kpi-grid">
      <div className="card kpi-card">
        <div className="stat-label">Matching Kills</div>
        <div className="stat-value">{kpis.totalKills.toLocaleString()}</div>
        <div className="muted small">
          {kpis.pk !== null ? `${Math.round(kpis.pk * 100)}% overall Pk` : "No shots"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Matching Shots</div>
        <div className="stat-value">{kpis.totalShots.toLocaleString()}</div>
        <div className="muted small">
          {kpis.totalHits.toLocaleString()} hits · {kpis.shotsWithTarget.toLocaleString()} with geometry
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Median Initial Kill Range</div>
        <div className="stat-value">{fmtDist(kpis.medianKillRangeM, distanceUnit)}</div>
        <div className="muted small">
          {kpis.p25KillRangeM !== null && kpis.p75KillRangeM !== null
            ? `IQR: ${fmtDist(kpis.p25KillRangeM, distanceUnit)} – ${fmtDist(kpis.p75KillRangeM, distanceUnit)}`
            : "–"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Mean Kill Range & TOF</div>
        <div className="stat-value">{fmtDist(kpis.meanKillRangeM, distanceUnit)}</div>
        <div className="muted small">
          {kpis.medianFlightTimeS !== null
            ? `Median flight time: ${kpis.medianFlightTimeS.toFixed(1)} s`
            : "–"}
        </div>
      </div>

      <div className="card kpi-card">
        <div className="stat-label">Dominant Kill Condition</div>
        <div className="stat-value kpi-cond">
          {kpis.dominantCondition
            ? `${ASPECT_SHORT_LABELS[kpis.dominantCondition.aspect]} · ${ALT_RELATION_LABELS[kpis.dominantCondition.altitudeRelation]}`
            : "–"}
        </div>
        <div className="muted small">
          {kpis.dominantCondition
            ? `${kpis.dominantCondition.kills} kills (${Math.round(kpis.dominantCondition.share * 100)}% of kills)`
            : "No kills in selection"}
        </div>
      </div>
    </section>
  );
}
