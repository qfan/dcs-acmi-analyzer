import type { TFunction } from "i18next";
import { Fragment, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { RecordingSummary } from "../acmi/summary.ts";
import type { Analysis, Kill, PilotStats } from "../analysis/analyze.ts";
import { settingsStore, useSettings } from "../settings/react.ts";
import type { Settings } from "../settings/schema.ts";
import { fmtAlt, fmtDist, fmtShortDist, fmtSpeed } from "../settings/units.ts";
import { Pinnable } from "./pins.tsx";
import {
  type Clock,
  type Filter,
  formatClock,
  formatElapsed,
  type KillNoteItem,
  type KillRecord,
  killMatches,
  killRecords,
  NO_FILTER,
  type Party,
  partyLabel,
  pilotMatches,
  pilotSides,
  type ShotRecord,
  shotMatches,
  shotRecords,
  timeOfDay,
} from "./records.ts";

const SHOT_LIMIT = 300;

interface Props {
  summary: RecordingSummary;
  analysis: Analysis;
  /** Present when a map is available. */
  onShowOnMap?: (k: Kill) => void;
}

export function AnalysisView({ summary, analysis, onShowOnMap }: Props) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const clock = settings.time.clock;
  const setClock = (c: Clock) => settingsStore.update({ time: { clock: c } });
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const kills = useMemo(() => killRecords(summary, analysis), [summary, analysis]);
  const shots = useMemo(() => shotRecords(summary, analysis), [summary, analysis]);
  const sides = useMemo(() => pilotSides(summary), [summary]);
  const refTime = summary.referenceTime;
  const fmt = (t: number) => formatClock(clock, refTime, t);

  const sideOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of kills) for (const p of [r.victim, r.killer]) if (p?.side) s.add(p.side);
    for (const r of shots) if (r.shooter?.side) s.add(r.shooter.side);
    return [...s].sort();
  }, [kills, shots]);

  const visibleKills = kills.filter((r) => killMatches(r, filter));
  const visibleShots = shots.filter((r) => shotMatches(r, filter));
  const visiblePilots = analysis.pilots.filter((p) => pilotMatches(p, sides.get(p.key) ?? "", filter));
  const filtered = filter.side !== "" || filter.pilot !== "" || filter.text !== "";

  return (
    <>
      <Pinnable id="filters" title={t("analysis.filtersTitle")}>
        <FilterBar
          filter={filter}
          setFilter={setFilter}
          sides={sideOptions}
          pilots={analysis.pilots}
          clock={clock}
          setClock={setClock}
          hasTimeOfDay={timeOfDay(refTime, 0) !== null}
        />
      </Pinnable>

      <Pinnable id="kills" title={t("analysis.killsTitle")}>
        <section className="card">
          <h3>
            {filtered
              ? t("analysis.killsCountFiltered", { visible: visibleKills.length, total: kills.length })
              : t("analysis.killsCount", { count: kills.length })}
          </h3>
          {analysis.scrambled.objects > 0 && (
            <p className="notice">
              {t(
                analysis.scrambled.protectedHeader
                  ? "analysis.scrambledProtected"
                  : "analysis.scrambledUnprotected",
                {
                  objects: analysis.scrambled.objects.toLocaleString(),
                  aircraft: analysis.scrambled.aircraft.toLocaleString(),
                },
              )}
            </p>
          )}
          {kills.length === 0 ? (
            <p className="muted">{t("analysis.nothingDestroyed")}</p>
          ) : visibleKills.length === 0 ? (
            <p className="muted">{t("analysis.noKillsMatch")}</p>
          ) : (
            <KillTable records={visibleKills} fmt={fmt} refTime={refTime} onShowOnMap={onShowOnMap} />
          )}
          <Footnotes analysis={analysis} />
        </section>
      </Pinnable>

      {analysis.pilots.length > 0 && (
        <Pinnable id="pilots" title={t("analysis.pilotsTitle")}>
          <section className="card">
            <h3>{t("analysis.pilotsTitle")}</h3>
            <PilotTable
              pilots={visiblePilots}
              sides={sides}
              selected={filter.pilot}
              onSelect={(key) => setFilter({ ...filter, pilot: filter.pilot === key ? "" : key })}
            />
          </section>
        </Pinnable>
      )}

      {shots.length > 0 && (
        <Pinnable id="shots" title={t("analysis.shotsTitle")}>
          <ShotsTable all={shots} visible={visibleShots} filtered={filtered} fmt={fmt} />
        </Pinnable>
      )}
    </>
  );
}

function FilterBar(props: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  sides: string[];
  pilots: PilotStats[];
  clock: Clock;
  setClock: (c: Clock) => void;
  hasTimeOfDay: boolean;
}) {
  const { t } = useTranslation();
  const { filter, setFilter } = props;
  const active = filter.side !== "" || filter.pilot !== "" || filter.text !== "";
  return (
    <section className="card filter-bar" aria-label={t("analysis.filtersAria")}>
      <label>
        <span>{t("analysis.side")}</span>
        <select value={filter.side} onChange={(e) => setFilter({ ...filter, side: e.target.value })}>
          <option value="">{t("analysis.allSides")}</option>
          {props.sides.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("analysis.pilot")}</span>
        <select value={filter.pilot} onChange={(e) => setFilter({ ...filter, pilot: e.target.value })}>
          <option value="">{t("analysis.everyone")}</option>
          {[...props.pilots]
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((p) => (
              <option key={p.key} value={p.key}>
                {p.key}
              </option>
            ))}
        </select>
      </label>
      <label className="grow">
        <span>{t("analysis.search")}</span>
        <input
          type="search"
          placeholder={t("analysis.searchPlaceholder")}
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
      </label>
      {props.hasTimeOfDay && (
        <label>
          <span>{t("analysis.times")}</span>
          <select value={props.clock} onChange={(e) => props.setClock(e.target.value as Clock)}>
            <option value="elapsed">{t("analysis.sinceStart")}</option>
            <option value="timeOfDay">{t("analysis.missionTimeOfDay")}</option>
          </select>
        </label>
      )}
      {active && (
        <button type="button" className="secondary" onClick={() => setFilter(NO_FILTER)}>
          {t("common.clear")}
        </button>
      )}
    </section>
  );
}

function KillTable({
  records,
  fmt,
  refTime,
  onShowOnMap,
}: {
  records: KillRecord[];
  fmt: (t: number) => string;
  refTime: string | null;
  onShowOnMap?: (k: Kill) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="num">{t("analysis.timeCol")}</th>
            <th>{t("analysis.lostCol")}</th>
            <th>{t("analysis.killedByCol")}</th>
            <th>{t("analysis.weaponCol")}</th>
            <th>{t("analysis.notesCol")}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const id = `${r.kill.victimUid}:${r.kill.time}`;
            const isOpen = open.has(id);
            return (
              <Fragment key={id}>
                <tr className={`clickable${isOpen ? " open" : ""}`} onClick={() => toggle(id)}>
                  <td className="num">
                    <button
                      type="button"
                      className="row-toggle"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? t("analysis.hideDetailsAria") : t("analysis.showDetailsAria")}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(id);
                      }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    {fmt(r.kill.time)}
                  </td>
                  <td>
                    <Who p={r.victim} />
                  </td>
                  <td>
                    {r.kill.cause === "weapon" ? (
                      <Who p={r.killer} />
                    ) : r.kill.cause === "collision" ? (
                      <>
                        {t("analysis.collisionWith")} <Who p={r.other} />
                      </>
                    ) : (
                      <span className="muted">{t(`analysis.causes.${r.kill.cause}`)}</span>
                    )}
                  </td>
                  <td>{r.weapon}</td>
                  <td>
                    {r.noteItems.map((item) => (
                      <span
                        key={
                          item.kind === "alsoHitBy"
                            ? `alsoHitBy:${item.assists}`
                            : item.kind === "wentDownAfterHit"
                              ? `wentDown:${item.seconds}`
                              : item.kind === "confidence"
                                ? `conf:${item.level}`
                                : item.kind
                        }
                        className={`badge ${noteKind(item)}`}
                      >
                        {noteLabel(item, t)}
                      </span>
                    ))}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="details-row">
                    <td colSpan={5}>
                      <KillDetailsPanel r={r} fmt={fmt} refTime={refTime} onShowOnMap={onShowOnMap} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KillDetailsPanel({
  r,
  fmt,
  refTime,
  onShowOnMap,
}: {
  r: KillRecord;
  fmt: (t: number) => string;
  refTime: string | null;
  onShowOnMap?: (k: Kill) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const u: Settings["units"] = settings.units;
  const k = r.kill;
  const d = k.details;
  const tod = timeOfDay(refTime, k.time);
  const afterHit =
    k.secondsAfterHit !== null && k.secondsAfterHit > 0.5
      ? t("analysis.details.afterHitSuffix", { seconds: k.secondsAfterHit.toFixed(1) })
      : "";
  return (
    <div className="details">
      {onShowOnMap && (
        <button type="button" className="secondary small-btn details-map" onClick={() => onShowOnMap(k)}>
          {t("analysis.showOnMap")}
        </button>
      )}
      <p>
        {k.cause === "weapon" && d ? (
          <Trans
            i18nKey="analysis.details.weaponNarrative"
            values={{
              shooter: partyLabel(r.killer) || t("analysis.details.unknownShooter"),
              weapon: r.weapon,
              launchTime: fmt(d.launchTime),
              launchRange: fmtDist(d.launchRangeM, u.distance),
              victim: partyLabel(r.victim),
              flightTime: d.flightTimeS.toFixed(1),
              missDist: fmtShortDist(d.missDistanceM, u.altitude),
              afterHit,
            }}
            components={[<strong key="0" />, <strong key="1" />]}
          />
        ) : k.cause === "collision" ? (
          <Trans
            i18nKey="analysis.details.collisionNarrative"
            values={{
              victim: partyLabel(r.victim),
              other: partyLabel(r.other),
            }}
            components={[<strong key="0" />, <strong key="1" />]}
          />
        ) : (
          <Trans
            i18nKey="analysis.details.otherNarrative"
            values={{
              victim: partyLabel(r.victim),
              reason: k.ejected ? t("analysis.details.ejectedReason") : t("analysis.details.crashReason"),
            }}
            components={[<strong key="0" />]}
          />
        )}
      </p>
      <dl className="kv compact">
        <dt>{t("analysis.details.timeLabel")}</dt>
        <dd>
          {t("analysis.details.timeValue", {
            elapsed: formatElapsed(k.time),
            tod: tod ? t("analysis.details.todSuffix", { tod }) : "",
          })}
        </dd>
        {d && (
          <>
            <dt>{t("analysis.details.shooterAtLaunch")}</dt>
            <dd>
              {fmtAlt(d.shooterAltM, u.altitude)}, {fmtSpeed(d.shooterSpeedMs, u.speed)}
            </dd>
            <dt>{t("analysis.details.targetAtLaunch")}</dt>
            <dd>
              {fmtAlt(d.victimAltM, u.altitude)}, {fmtSpeed(d.victimSpeedMs, u.speed)}
            </dd>
          </>
        )}
        {r.assists.length > 0 && (
          <>
            <dt>{t("analysis.details.alsoHitBy")}</dt>
            <dd>{r.assists.map(partyLabel).join(", ")}</dd>
          </>
        )}
        <dt>{t("analysis.details.confidence")}</dt>
        <dd>{confidenceText(k, t)}</dd>
        <dt>{t("analysis.details.objectIds")}</dt>
        <dd className="muted">
          {t("analysis.details.objectIdsValue", {
            victimId: r.victim.id,
            killerPart: r.killer ? t("analysis.details.killerIdPart", { killerId: r.killer.id }) : "",
          })}
        </dd>
      </dl>
    </div>
  );
}

function confidenceText(k: KillRecord["kill"], t: TFunction): string {
  if (k.cause !== "weapon")
    return k.confidence === "medium"
      ? t("analysis.details.confOtherMed")
      : t("analysis.details.confOtherLow");
  if (k.confidence === "high") return t("analysis.details.confWeaponHigh");
  if (k.confidence === "medium") return t("analysis.details.confWeaponMed");
  return t("analysis.details.confWeaponLow");
}

function noteKind(item: KillNoteItem): string {
  if (item.kind === "friendlyFire" || item.kind === "confidence") return "warn";
  if (item.kind === "pilotEjected") return "info";
  return "";
}

function noteLabel(item: KillNoteItem, t: TFunction): string {
  switch (item.kind) {
    case "friendlyFire":
      return t("analysis.notes.friendlyFire");
    case "pilotEjected":
      return t("analysis.notes.pilotEjected");
    case "shooterAlreadyDown":
      return t("analysis.notes.shooterAlreadyDown");
    case "wentDownAfterHit":
      return t("analysis.notes.wentDownAfterHit", { seconds: item.seconds });
    case "alsoHitBy":
      return t("analysis.notes.alsoHitBy", { assists: item.assists });
    case "confidence":
      return item.level === "medium"
        ? t("analysis.notes.mediumConfidence")
        : t("analysis.notes.lowConfidence");
  }
}

function PilotTable({
  pilots,
  sides,
  selected,
  onSelect,
}: {
  pilots: PilotStats[];
  sides: Map<string, string>;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (pilots.length === 0) return <p className="muted">{t("analysis.noPilotsMatch")}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("analysis.pilot")}</th>
            <th>{t("analysis.flyingCol")}</th>
            <th className="num" title={t("analysis.killsColTitle")}>
              {t("analysis.killsCol")}
            </th>
            <th className="num">{t("analysis.deathsCol")}</th>
            <th className="num">{t("analysis.shotsCol")}</th>
            <th className="num">{t("analysis.gunBurstsCol")}</th>
            <th className="num" title={t("analysis.hitsColTitle")}>
              {t("analysis.hitsCol")}
            </th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => (
            <tr key={p.key} className={selected === p.key ? "selected" : ""}>
              <td>
                <button
                  type="button"
                  className="link"
                  title={
                    selected === p.key ? t("analysis.showEveryoneTitle") : t("analysis.showOnlyPilotTitle")
                  }
                  onClick={() => onSelect(p.key)}
                >
                  <SideDot side={sides.get(p.key) ?? ""} />
                  {p.key}
                </button>
              </td>
              <td className="muted">{p.aircraft.join(", ")}</td>
              <td className="num">
                <strong>{p.kills}</strong>
                {p.kills > 0 && (
                  <span className="muted small">
                    {" "}
                    ({p.airKills}/{p.groundKills}/{p.seaKills})
                  </span>
                )}
                {p.friendlyKills > 0 && (
                  <span className="badge warn">
                    {t("analysis.friendlyBadge", { count: p.friendlyKills })}
                  </span>
                )}
              </td>
              <td className="num">{p.deaths}</td>
              <td className="num">{p.shots}</td>
              <td className="num">{p.gunBursts}</td>
              <td className="num">{p.hits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShotsTable({
  all,
  visible,
  filtered,
  fmt,
}: {
  all: ShotRecord[];
  visible: ShotRecord[];
  filtered: boolean;
  fmt: (t: number) => string;
}) {
  const { t } = useTranslation();
  const [showGuns, setShowGuns] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (all.length === 0) return null;
  const gunCount = all.filter((s) => s.shot.isGun).length;
  const shown = visible.filter((s) => showGuns || !s.shot.isGun);
  const rows = showAll ? shown : shown.slice(0, SHOT_LIMIT);
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          {t("analysis.shotsHeading", {
            weapons: all.length - gunCount,
            guns: gunCount ? t("analysis.shotsGunsPart", { count: gunCount }) : "",
            shown: filtered ? t("analysis.shotsShownPart", { count: shown.length }) : "",
          })}
        </h3>
        {gunCount > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showGuns} onChange={(e) => setShowGuns(e.target.checked)} />{" "}
            {t("analysis.showGunBursts")}
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted">{t("analysis.noShotsMatch")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">{t("analysis.timeCol")}</th>
                <th>{t("analysis.firedByCol")}</th>
                <th>{t("analysis.weaponCol")}</th>
                <th>{t("analysis.lockedTargetCol")}</th>
                <th>{t("analysis.resultCol")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.shot.weaponUid}>
                  <td className="num">{fmt(r.shot.time)}</td>
                  <td>
                    {r.shooter ? (
                      <>
                        <Who p={r.shooter} />
                        {r.shot.shooter && r.shot.shooter.confidence !== "high" && (
                          <span className="badge warn">
                            {r.shot.shooter.confidence === "medium"
                              ? t("analysis.confidenceBadge.medium")
                              : t("analysis.confidenceBadge.low")}
                          </span>
                        )}
                      </>
                    ) : (
                      <span
                        className="muted"
                        title={r.shot.firstSeenInFlight ? t("analysis.unknownInFlightTitle") : ""}
                      >
                        {r.shot.firstSeenInFlight ? t("analysis.unknownInFlight") : t("common.unknown")}
                      </span>
                    )}
                  </td>
                  <td>
                    {r.weapon}
                    {r.shot.isGun && <span className="muted small"> × {r.shot.rounds}</span>}
                  </td>
                  <td>{r.lockedTarget ? <Who p={r.lockedTarget} /> : ""}</td>
                  <td>
                    {r.shot.outcome === "hit" ? (
                      <>
                        {t("analysis.hitPrefix")}{" "}
                        {r.targets.map((tgt, i) => (
                          <span key={tgt.uid}>
                            {i > 0 && ", "}
                            <Who p={tgt} />
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="muted">
                        {r.shot.outcome === "active" ? t("analysis.stillFlyingAtEnd") : t("analysis.missed")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!showAll && shown.length > SHOT_LIMIT && (
        <button type="button" className="secondary more" onClick={() => setShowAll(true)}>
          {t("analysis.showAll", { count: shown.length })}
        </button>
      )}
    </section>
  );
}

function Footnotes({ analysis }: { analysis: Analysis }) {
  const { t } = useTranslation();
  const rw = analysis.removedWithoutEvidence;
  return (
    <>
      {rw.aircraft + rw.other > 0 && (
        <p className="muted footnote-left">
          {t("analysis.footnotes.removedWithoutEvidence", {
            parts: [
              rw.aircraft ? t("analysis.footnotes.removedAircraft", { count: rw.aircraft }) : "",
              rw.other ? t("analysis.footnotes.removedOther", { count: rw.other }) : "",
            ]
              .filter(Boolean)
              .join(t("analysis.footnotes.andJoiner")),
          })}
        </p>
      )}
      {analysis.massRemovals.length > 0 && (
        <p className="muted footnote-left">
          {t("analysis.footnotes.notCountedAsLosses", {
            parts: analysis.massRemovals
              .map((m) =>
                m.atEnd
                  ? t("analysis.footnotes.massAtEnd", { count: m.count })
                  : t("analysis.footnotes.massAtTime", { count: m.count, time: formatElapsed(m.time) }),
              )
              .join("; "),
          })}
        </p>
      )}
      <p className="muted footnote-left">{t("analysis.footnotes.methodology")}</p>
    </>
  );
}

/** "Pilot (Aircraft)" with a side-coloured dot. */
function Who({ p }: { p: Party | null }) {
  const { t } = useTranslation();
  if (!p) return <span className="muted">{t("common.unknown")}</span>;
  return (
    <span className="who">
      <SideDot side={p.side} />
      {p.pilot ? (
        <>
          {p.pilot} <span className="muted">({p.aircraft})</span>
        </>
      ) : (
        p.aircraft
      )}
    </span>
  );
}

function SideDot({ side }: { side: string }) {
  return <span className={`dot side-bg-${(side || "grey").toLowerCase()}`} />;
}
