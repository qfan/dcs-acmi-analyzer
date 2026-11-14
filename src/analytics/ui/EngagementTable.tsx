import { Fragment, useMemo, useState } from "react";
import type { Settings } from "../../settings/schema.ts";
import { fmtAlt, fmtDist, fmtShortDist, fmtSpeed } from "../../settings/units.ts";
import { formatElapsed } from "../../ui/records.ts";
import {
  ALT_RELATION_COLORS,
  ALT_RELATION_LABELS,
  ASPECT_LABELS,
  ASPECT_SHORT_LABELS,
  type MissileEngagement,
  type PlatformSnapshot,
  WEAPON_CLASS_LABELS,
} from "../model.ts";

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
            Matching {tableScope === "kills" ? "Kills" : "Shots"} ({sourceRows.length.toLocaleString()})
          </h3>
          <p className="muted small matrix-sub">
            Click any row to inspect its complete launch-time initial condition geometry.
            {onShowOnMap && " Map jumps to a few seconds before the launch with shooter and target selected."}
          </p>
        </div>
        <fieldset className="mode-switch" aria-label="Table scope">
          <button
            type="button"
            className={tableScope === "kills" ? "on" : ""}
            onClick={() => setTableScope("kills")}
          >
            Kills Only ({kills.length})
          </button>
          <button
            type="button"
            className={tableScope === "all" ? "on" : ""}
            onClick={() => setTableScope("all")}
          >
            All Matching Shots ({engagements.length})
          </button>
        </fieldset>
      </div>

      {sourceRows.length === 0 ? (
        <p className="muted">No engagements match the current filters.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {onShowOnMap ? <th aria-label="Show on map" /> : null}
                <th>Recording</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("time")}>
                    Launch{sortArrow("time")}
                  </button>
                </th>
                <th>Outcome</th>
                <th>Weapon</th>
                <th>Launcher</th>
                <th>Target</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("range")}>
                    Initial Range{sortArrow("range")}
                  </button>
                </th>
                <th>Altitude Relation</th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("aspect")}>
                    Target Aspect{sortArrow("aspect")}
                  </button>
                </th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("closure")}>
                    Closure{sortArrow("closure")}
                  </button>
                </th>
                <th className="num">
                  <button type="button" className="link" onClick={() => toggleSort("flightTime")}>
                    TOF{sortArrow("flightTime")}
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
                            title="Jump the map to this shot"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onShowOnMap(e);
                            }}
                          >
                            Map
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
                            title={`Off-path ("UFO") samples around this shot: shooter ${e.ufo.shooter}, target ${e.ufo.target}. Launch geometry and miss distance may be wrong.`}
                          >
                            UFO
                          </span>
                        )}
                        {e.targetSource === "inferred" && (
                          <span className="badge" title="Target inferred from trajectory / launch cone">
                            inferred
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
                            {ALT_RELATION_LABELS[ic.altitudeRelation]}
                          </span>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                      <td className="num">
                        {ic ? (
                          <span>
                            {ASPECT_SHORT_LABELS[ic.aspectCategory]}{" "}
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
                              Show on map
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
          Show all {sortedRows.length.toLocaleString()} rows
        </button>
      )}
    </section>
  );
}

function OutcomeBadge({ e }: { e: MissileEngagement }) {
  if (e.isKill) return <span className="badge badge-kill">KILL</span>;
  if (e.outcome === "hit-damaged") return <span className="badge info">HIT</span>;
  if (e.outcome === "intercept") return <span className="badge info">INTERCEPT</span>;
  if (e.outcome === "active") return <span className="badge">ACTIVE</span>;
  return <span className="badge">MISS</span>;
}

function PlatformWho({ p, units }: { p: PlatformSnapshot | null; units: Settings["units"] }) {
  if (!p) return <span className="muted">Unknown</span>;
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
  const ic = e.initial;
  const s = e.shooter;
  const t = e.target;

  return (
    <div className="details engagement-details-grid">
      <div>
        <h4>Initial Condition Summary</h4>
        <dl className="kv compact">
          <dt>Recording</dt>
          <dd>{e.fileName}</dd>
          <dt>Weapon</dt>
          <dd>
            <strong>{e.weaponName}</strong> ({WEAPON_CLASS_LABELS[e.weaponClass]})
            {e.isGun ? ` · ${e.rounds} rounds` : ""}
          </dd>
          <dt>Launch → Outcome</dt>
          <dd>
            Launched at {formatElapsed(e.launchTime)}
            {e.killTime !== null ? ` · Target destroyed at ${formatElapsed(e.killTime)}` : ""}
            {e.flightTimeS !== null ? ` (${e.flightTimeS.toFixed(1)} s flight time)` : ""}
          </dd>
          {ic && (
            <>
              <dt>Initial Range</dt>
              <dd>
                <strong>{fmtDist(ic.slantRangeM, units.distance)}</strong> slant (
                {fmtDist(ic.horizontalRangeM, units.distance)} horizontal)
                {e.fPoleRangeM !== null
                  ? ` · F-pole at impact: ${fmtDist(e.fPoleRangeM, units.distance)}`
                  : ""}
              </dd>
              <dt>Altitude Relation</dt>
              <dd>
                <strong>{ALT_RELATION_LABELS[ic.altitudeRelation]}</strong> · Target{" "}
                {fmtShortDist(Math.abs(ic.altDiffM), units.altitude)} {ic.altDiffM >= 0 ? "above" : "below"}{" "}
                shooter (look angle {ic.lookAngleDeg >= 0 ? "+" : ""}
                {ic.lookAngleDeg.toFixed(1)}°)
              </dd>
              <dt>Target Aspect</dt>
              <dd>
                <strong>{ASPECT_LABELS[ic.aspectCategory]}</strong> · {Math.round(ic.aspectDeg)}° aspect (HCA{" "}
                {Math.round(ic.hcaDeg)}°)
              </dd>
              <dt>Boresight & Clock</dt>
              <dd>
                Target at {ic.clock} o&apos;clock · Shooter ATA {Math.round(ic.shooterAtaDeg)}° · Target ATA{" "}
                {Math.round(ic.targetAtaDeg)}°
              </dd>
              <dt>Closure Rate</dt>
              <dd>
                {fmtSpeed(Math.abs(ic.closureMs), units.speed)} {ic.closureMs >= 0 ? "closing" : "opening"}
              </dd>
            </>
          )}
          {e.missDistanceM !== null && (
            <>
              <dt>Closest Approach</dt>
              <dd>{fmtShortDist(e.missDistanceM, units.altitude)}</dd>
            </>
          )}
        </dl>
      </div>

      <div>
        <h4>Launcher & Target State at Launch</h4>
        <dl className="kv compact">
          <dt>Launcher</dt>
          <dd>
            {s ? (
              <>
                <strong>{s.pilot ? `${s.pilot} (${s.name})` : s.name}</strong> [{s.side}]
                <br />
                Alt: {fmtAlt(s.altM, units.altitude)} · Speed: {fmtSpeed(s.speedMs, units.speed)}
                {s.mach !== null ? ` (Mach ${s.mach.toFixed(2)})` : ""}
                {s.headingDeg !== null ? ` · Hdg ${Math.round(s.headingDeg)}°` : ""}
                {s.pitchDeg !== null
                  ? ` · Pitch ${s.pitchDeg >= 0 ? "+" : ""}${Math.round(s.pitchDeg)}°`
                  : ""}
              </>
            ) : (
              "Unknown"
            )}
          </dd>
          <dt>Target</dt>
          <dd>
            {t ? (
              <>
                <strong>{t.pilot ? `${t.pilot} (${t.name})` : t.name}</strong> [{t.side}]
                {e.targetEjected ? " · Pilot ejected" : ""}
                <br />
                Alt: {fmtAlt(t.altM, units.altitude)} · Speed: {fmtSpeed(t.speedMs, units.speed)}
                {t.mach !== null ? ` (Mach ${t.mach.toFixed(2)})` : ""}
                {t.headingDeg !== null ? ` · Hdg ${Math.round(t.headingDeg)}°` : ""}
                {t.pitchDeg !== null
                  ? ` · Pitch ${t.pitchDeg >= 0 ? "+" : ""}${Math.round(t.pitchDeg)}°`
                  : ""}
              </>
            ) : (
              "Unknown"
            )}
          </dd>
          <dt>Attribution</dt>
          <dd>
            Confidence: <strong>{e.confidence}</strong> · Target source: <strong>{e.targetSource}</strong>
            {e.friendlyFire ? " · Friendly Fire" : ""}
          </dd>
          {e.ufo && e.ufo.shooter + e.ufo.target > 0 && (
            <>
              <dt>Track quality</dt>
              <dd>
                Off-path ("UFO") samples from 10 s before launch to 5 s after the shot: shooter{" "}
                <strong>{e.ufo.shooter}</strong> · target <strong>{e.ufo.target}</strong>
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
