import { Fragment, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { Settings } from "../../settings/schema.ts";
import { fmtAlt, fmtDist, fmtShortDist, fmtSpeed } from "../../settings/units.ts";
import { formatElapsed } from "../../ui/records.ts";
import { ALT_RELATION_COLORS, type MissileEngagement, type PlatformSnapshot } from "../model.ts";

interface Props {
  engagements: MissileEngagement[];
  kills: MissileEngagement[];
  units: Settings["units"];
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
  /** When set (single-file viewer), each shot gets a button that jumps the map to its launch. */
  onShowOnMap?: (e: MissileEngagement) => void;
}

type SortKey = "range" | "time" | "shooterAlt" | "targetAlt" | "aspect" | "closure" | "flightTime";

const ROW_LIMIT = 200;

export function EngagementTable({ engagements, kills, units, selectedId, onSelectId, onShowOnMap }: Props) {
  const { t } = useTranslation();
  const [tableScope, setTableScope] = useState<"kills" | "all">("kills");
  const [sortKey, setSortKey] = useState<SortKey>("range");
  const [sortDesc, setSortDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const sourceRows = tableScope === "kills" ? kills : engagements;

  const sortedRows = useMemo(() => {
    const val = (e: MissileEngagement): number => {
      switch (sortKey) {
        case "range":
          return e.initial?.slantRangeM ?? -1;
        case "time":
          return e.launchTime;
        case "shooterAlt":
          return e.shooter?.altM ?? -99999;
        case "targetAlt":
          return e.target?.altM ?? -99999;
        case "aspect":
          return e.initial?.aspectDeg ?? -1;
        case "closure":
          return e.initial?.closureMs ?? -99999;
        case "flightTime":
          return e.flightTimeS ?? -1;
      }
    };
    return [...sourceRows].sort((a, b) => {
      const d = val(a) - val(b);
      return sortDesc ? -d : d;
    });
  }, [sourceRows, sortKey, sortDesc]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc(!sortDesc);
    else {
      setSortKey(k);
      setSortDesc(true);
    }
  };

  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDesc ? " ↓" : " ↑") : "");
  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_LIMIT);

  return (
    <section className="card analytics-card">
      <div className="card-head">
        <div>
          <h3>
            {tableScope === "kills"
              ? t("analytics.table.titleKills", { count: sourceRows.length })
              : t("analytics.table.titleShots", { count: sourceRows.length })}
          </h3>
          <p className="muted small matrix-sub">
            {t("analytics.table.sub")}
            {onShowOnMap && t("analytics.table.subShowOnMap")}
          </p>
        </div>
        <fieldset className="mode-switch" aria-label={t("analytics.table.scopeAria")}>
          <button
            type="button"
            className={tableScope === "kills" ? "on" : ""}
            onClick={() => setTableScope("kills")}
          >
            {t("analytics.table.killsOnly", { count: kills.length })}
          </button>
          <button
            type="button"
            className={tableScope === "all" ? "on" : ""}
            onClick={() => setTableScope("all")}
          >
            {t("analytics.table.allMatchingShots", { count: engagements.length })}
          </button>
        </fieldset>
      </div>

      {sourceRows.length === 0 ? (
        <p className="muted">{t("analytics.table.noMatch")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {onShowOnMap ? <th aria-label={t("analytics.table.showOnMapAria")} /> : null}
                <th>{t("analytics.table.recordingCol")}</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("time")}>
                    {t("analytics.table.launchCol")}
                    {sortArrow("time")}
                  </button>
                </th>
                <th>{t("analytics.table.outcomeCol")}</th>
                <th>{t("analytics.table.weaponCol")}</th>
                <th>{t("analytics.table.launcherCol")}</th>
                <th>{t("analytics.table.targetCol")}</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("range")}>
                    {t("analytics.table.initialRangeCol")}
                    {sortArrow("range")}
                  </button>
                </th>
                <th>{t("analytics.table.altRelationCol")}</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("aspect")}>
                    {t("analytics.table.targetAspectCol")}
                    {sortArrow("aspect")}
                  </button>
                </th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("closure")}>
                    {t("analytics.table.closureCol")}
                    {sortArrow("closure")}
                  </button>
                </th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("flightTime")}>
                    {t("analytics.table.tofCol")}
                    {sortArrow("flightTime")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((e) => {
                const isOpen = selectedId === e.id;
                const ic = e.initial;
                return (
                  <Fragment key={e.id}>
                    <tr
                      className={`clickable${isOpen ? " open selected" : ""}`}
                      onClick={() => onSelectId(isOpen ? null : e.id)}
                    >
                      {onShowOnMap && (
                        <td>
                          <button
                            type="button"
                            className="secondary small-btn"
                            title={t("analytics.table.jumpToMapTitle")}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onShowOnMap(e);
                            }}
                          >
                            {t("analytics.table.mapBtn")}
                          </button>
                        </td>
                      )}
                      <td className="small muted file-cell" title={e.fileName}>
                        <button
                          type="button"
                          className="row-toggle"
                          aria-expanded={isOpen}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onSelectId(isOpen ? null : e.id);
                          }}
                        >
                          {isOpen ? "▾" : "▸"}
                        </button>
                        {e.missionTitle}
                      </td>
                      <td className="num">{formatElapsed(e.launchTime)}</td>
                      <td>
                        <OutcomeBadge e={e} />
                      </td>
                      <td>
                        <strong>{e.weaponName}</strong>
                      </td>
                      <td>
                        <PlatformWho p={e.shooter} units={units} />
                      </td>
                      <td>
                        <PlatformWho p={e.target} units={units} />
                        {e.ufo && e.ufo.shooter + e.ufo.target > 0 && (
                          <span
                            className="badge warn"
                            title={t("analytics.table.ufoTitle", {
                              shooter: e.ufo.shooter,
                              target: e.ufo.target,
                            })}
                          >
                            UFO
                          </span>
                        )}
                        {e.targetSource === "inferred" && (
                          <span className="badge" title={t("analytics.table.inferredTitle")}>
                            {t("analytics.table.inferredBadge")}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <strong>{fmtDist(ic?.slantRangeM ?? null, units.distance)}</strong>
                      </td>
                      <td>
                        {ic ? (
                          <span className="cond-pill">
                            <span
                              className="dot"
                              style={{ background: ALT_RELATION_COLORS[ic.altitudeRelation] }}
                            />
                            {t(`analytics.models.altRelation.${ic.altitudeRelation}`)}
                          </span>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                      <td className="num">
                        {ic ? (
                          <span>
                            {t(`analytics.models.aspectShort.${ic.aspectCategory}`)}{" "}
                            <span className="muted small">({Math.round(ic.aspectDeg)}°)</span>
                          </span>
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="num">{ic ? fmtSpeed(ic.closureMs, units.speed) : "–"}</td>
                      <td className="num">
                        {e.flightTimeS !== null ? `${e.flightTimeS.toFixed(1)} s` : "–"}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="details-row">
                        <td colSpan={onShowOnMap ? 12 : 11}>
                          {onShowOnMap && (
                            <button type="button" className="small-btn" onClick={() => onShowOnMap(e)}>
                              {t("analytics.table.showOnMapBtn")}
                            </button>
                          )}
                          <EngagementDetailsCard e={e} units={units} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!showAll && sortedRows.length > ROW_LIMIT && (
        <button type="button" className="secondary more" onClick={() => setShowAll(true)}>
          {t("analytics.table.showAllRows", { count: sortedRows.length })}
        </button>
      )}
    </section>
  );
}

function OutcomeBadge({ e }: { e: MissileEngagement }) {
  const { t } = useTranslation();
  if (e.isKill) return <span className="badge badge-kill">{t("analytics.table.outcomes.kill")}</span>;
  if (e.outcome === "hit-damaged") {
    return <span className="badge info">{t("analytics.table.outcomes.hit")}</span>;
  }
  if (e.outcome === "intercept") {
    return <span className="badge info">{t("analytics.table.outcomes.intercept")}</span>;
  }
  if (e.outcome === "active") return <span className="badge">{t("analytics.table.outcomes.active")}</span>;
  return <span className="badge">{t("analytics.table.outcomes.miss")}</span>;
}

function PlatformWho({ p, units }: { p: PlatformSnapshot | null; units: Settings["units"] }) {
  const { t } = useTranslation();
  if (!p) return <span className="muted">{t("common.unknown")}</span>;
  const sideCls = `side-bg-${(p.side || "grey").toLowerCase()}`;
  return (
    <span className="who">
      <span className={`dot ${sideCls}`} />
      {p.pilot ? (
        <>
          {p.pilot} <span className="muted">({p.name})</span>
        </>
      ) : (
        p.name
      )}
      {p.altM !== null && <span className="muted small"> · {fmtAlt(p.altM, units.altitude)}</span>}
    </span>
  );
}

function EngagementDetailsCard({ e, units }: { e: MissileEngagement; units: Settings["units"] }) {
  const { t: tr } = useTranslation();
  const ic = e.initial;
  const s = e.shooter;
  const t = e.target;

  return (
    <div className="details engagement-details-grid">
      <div>
        <h4>{tr("analytics.table.details.icSummary")}</h4>
        <dl className="kv compact">
          <dt>{tr("analytics.table.details.recording")}</dt>
          <dd>{e.fileName}</dd>
          <dt>{tr("analytics.table.details.weapon")}</dt>
          <dd>
            <strong>{e.weaponName}</strong> ({tr(`analytics.models.weaponClass.${e.weaponClass}`)})
            {e.isGun ? tr("analytics.table.details.rounds", { count: e.rounds }) : ""}
          </dd>
          <dt>{tr("analytics.table.details.launchOutcome")}</dt>
          <dd>
            {tr("analytics.table.details.launchedAt", { time: formatElapsed(e.launchTime) })}
            {e.killTime !== null
              ? tr("analytics.table.details.destroyedAt", { time: formatElapsed(e.killTime) })
              : ""}
            {e.flightTimeS !== null
              ? tr("analytics.table.details.flightTime", { s: e.flightTimeS.toFixed(1) })
              : ""}
          </dd>
          {ic && (
            <>
              <dt>{tr("analytics.table.details.initialRange")}</dt>
              <dd>
                {tr("analytics.table.details.slantHoriz", {
                  slant: fmtDist(ic.slantRangeM, units.distance),
                  horiz: fmtDist(ic.horizontalRangeM, units.distance),
                })}
                {e.fPoleRangeM !== null
                  ? tr("analytics.table.details.fPole", {
                      dist: fmtDist(e.fPoleRangeM, units.distance),
                    })
                  : ""}
              </dd>
              <dt>{tr("analytics.table.details.altRelation")}</dt>
              <dd>
                <strong>{tr(`analytics.models.altRelation.${ic.altitudeRelation}`)}</strong> ·{" "}
                {tr("analytics.table.details.altDetail", {
                  diff: fmtShortDist(Math.abs(ic.altDiffM), units.altitude),
                  dir:
                    ic.altDiffM >= 0
                      ? tr("analytics.table.details.above")
                      : tr("analytics.table.details.below"),
                  look: `${ic.lookAngleDeg >= 0 ? "+" : ""}${ic.lookAngleDeg.toFixed(1)}`,
                })}
              </dd>
              <dt>{tr("analytics.table.details.targetAspect")}</dt>
              <dd>
                <strong>{tr(`analytics.models.aspect.${ic.aspectCategory}`)}</strong> ·{" "}
                {tr("analytics.table.details.aspectDetail", {
                  deg: Math.round(ic.aspectDeg),
                  hca: Math.round(ic.hcaDeg),
                })}
              </dd>
              <dt>{tr("analytics.table.details.boresightClock")}</dt>
              <dd>
                {tr("analytics.table.details.clockDetail", {
                  clock: ic.clock,
                  sAta: Math.round(ic.shooterAtaDeg),
                  tAta: Math.round(ic.targetAtaDeg),
                })}
              </dd>
              <dt>{tr("analytics.table.details.closureRate")}</dt>
              <dd>
                {fmtSpeed(Math.abs(ic.closureMs), units.speed)}{" "}
                {ic.closureMs >= 0
                  ? tr("analytics.table.details.closing")
                  : tr("analytics.table.details.opening")}
              </dd>
            </>
          )}
          {e.missDistanceM !== null && (
            <>
              <dt>{tr("analytics.table.details.closestApproach")}</dt>
              <dd>{fmtShortDist(e.missDistanceM, units.altitude)}</dd>
            </>
          )}
        </dl>
      </div>

      <div>
        <h4>{tr("analytics.table.details.launcherTargetState")}</h4>
        <dl className="kv compact">
          <dt>{tr("analytics.table.details.launcher")}</dt>
          <dd>
            {s ? (
              <>
                <strong>{s.pilot ? `${s.pilot} (${s.name})` : s.name}</strong> [{s.side}]
                <br />
                {tr("analytics.table.details.altSpeed", {
                  alt: fmtAlt(s.altM, units.altitude),
                  speed: fmtSpeed(s.speedMs, units.speed),
                })}
                {s.mach !== null ? ` (Mach ${s.mach.toFixed(2)})` : ""}
                {s.headingDeg !== null
                  ? tr("analytics.table.details.hdg", { deg: Math.round(s.headingDeg) })
                  : ""}
                {s.pitchDeg !== null
                  ? tr("analytics.table.details.pitch", {
                      deg: `${s.pitchDeg >= 0 ? "+" : ""}${Math.round(s.pitchDeg)}`,
                    })
                  : ""}
              </>
            ) : (
              tr("common.unknown")
            )}
          </dd>
          <dt>{tr("analytics.table.details.target")}</dt>
          <dd>
            {t ? (
              <>
                <strong>{t.pilot ? `${t.pilot} (${t.name})` : t.name}</strong> [{t.side}]
                {e.targetEjected ? tr("analytics.table.details.ejected") : ""}
                <br />
                {tr("analytics.table.details.altSpeed", {
                  alt: fmtAlt(t.altM, units.altitude),
                  speed: fmtSpeed(t.speedMs, units.speed),
                })}
                {t.mach !== null ? ` (Mach ${t.mach.toFixed(2)})` : ""}
                {t.headingDeg !== null
                  ? tr("analytics.table.details.hdg", { deg: Math.round(t.headingDeg) })
                  : ""}
                {t.pitchDeg !== null
                  ? tr("analytics.table.details.pitch", {
                      deg: `${t.pitchDeg >= 0 ? "+" : ""}${Math.round(t.pitchDeg)}`,
                    })
                  : ""}
              </>
            ) : (
              tr("common.unknown")
            )}
          </dd>
          <dt>{tr("analytics.table.details.attribution")}</dt>
          <dd>
            {tr("analytics.table.details.confidence")} <strong>{e.confidence}</strong>
            {tr("analytics.table.details.targetSource")} <strong>{e.targetSource}</strong>
            {e.friendlyFire ? tr("analytics.table.details.friendlyFire") : ""}
          </dd>
          {e.ufo && e.ufo.shooter + e.ufo.target > 0 && (
            <>
              <dt>{tr("analytics.table.details.trackQuality")}</dt>
              <dd>
                <Trans
                  i18nKey="analytics.table.details.ufoSamples"
                  values={{ shooter: e.ufo.shooter, target: e.ufo.target }}
                  components={[<strong key="0" />, <strong key="1" />]}
                />
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
