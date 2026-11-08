import { Fragment, useMemo, useState } from "react";
import type { RecordingSummary } from "../acmi/summary.ts";
import type { Analysis, Kill, PilotStats } from "../analysis/analyze.ts";
import { settingsStore, useSettings } from "../settings/react.ts";
import type { Settings } from "../settings/schema.ts";
import { fmtAlt, fmtDist, fmtShortDist, fmtSpeed } from "../settings/units.ts";
import {
  type Clock,
  type Filter,
  formatClock,
  formatElapsed,
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
      <FilterBar
        filter={filter}
        setFilter={setFilter}
        sides={sideOptions}
        pilots={analysis.pilots}
        clock={clock}
        setClock={setClock}
        hasTimeOfDay={timeOfDay(refTime, 0) !== null}
      />

      <section className="card">
        <h3>Kills and losses ({filtered ? `${visibleKills.length} of ${kills.length}` : kills.length})</h3>
        {analysis.scrambled.objects > 0 && (
          <p className="notice">
            {analysis.scrambled.protectedHeader ? "This is a protected multiplayer recording: the" : "The"}{" "}
            positions of {analysis.scrambled.objects.toLocaleString()} object
            {analysis.scrambled.objects === 1 ? "" : "s"} ({analysis.scrambled.aircraft.toLocaleString()}{" "}
            aircraft) are scrambled in the file, so who shot whom can't be worked out for them. They are left
            out of the kill list below. Only Tacview with the server's key can restore these positions.
          </p>
        )}
        {kills.length === 0 ? (
          <p className="muted">Nothing was destroyed in this recording.</p>
        ) : visibleKills.length === 0 ? (
          <p className="muted">No kills match the filter.</p>
        ) : (
          <KillTable records={visibleKills} fmt={fmt} refTime={refTime} onShowOnMap={onShowOnMap} />
        )}
        <Footnotes analysis={analysis} />
      </section>

      {analysis.pilots.length > 0 && (
        <section className="card">
          <h3>Pilots and units</h3>
          <PilotTable
            pilots={visiblePilots}
            sides={sides}
            selected={filter.pilot}
            onSelect={(key) => setFilter({ ...filter, pilot: filter.pilot === key ? "" : key })}
          />
        </section>
      )}

      <ShotsTable all={shots} visible={visibleShots} filtered={filtered} fmt={fmt} />
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
  const { filter, setFilter } = props;
  const active = filter.side !== "" || filter.pilot !== "" || filter.text !== "";
  return (
    <section className="card filter-bar" aria-label="Filters">
      <label>
        <span>Side</span>
        <select value={filter.side} onChange={(e) => setFilter({ ...filter, side: e.target.value })}>
          <option value="">All sides</option>
          {props.sides.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Pilot</span>
        <select value={filter.pilot} onChange={(e) => setFilter({ ...filter, pilot: e.target.value })}>
          <option value="">Everyone</option>
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
        <span>Search</span>
        <input
          type="search"
          placeholder="Pilot, aircraft, weapon…"
          value={filter.text}
          onChange={(e) => setFilter({ ...filter, text: e.target.value })}
        />
      </label>
      {props.hasTimeOfDay && (
        <label>
          <span>Times</span>
          <select value={props.clock} onChange={(e) => props.setClock(e.target.value as Clock)}>
            <option value="elapsed">Since start</option>
            <option value="timeOfDay">Mission time of day</option>
          </select>
        </label>
      )}
      {active && (
        <button type="button" className="secondary" onClick={() => setFilter(NO_FILTER)}>
          Clear
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
            <th className="num">Time</th>
            <th>Lost</th>
            <th>Killed by</th>
            <th>Weapon</th>
            <th>Notes</th>
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
                      aria-label={isOpen ? "Hide details" : "Show details"}
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
                        Collision with <Who p={r.other} />
                      </>
                    ) : (
                      <span className="muted">{r.cause}</span>
                    )}
                  </td>
                  <td>{r.weapon}</td>
                  <td>
                    {r.notes.map((n) => (
                      <span key={n} className={`badge ${noteKind(n)}`}>
                        {n}
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
  const { settings } = useSettings();
  const u: Settings["units"] = settings.units;
  const k = r.kill;
  const d = k.details;
  const tod = timeOfDay(refTime, k.time);
  return (
    <div className="details">
      {onShowOnMap && (
        <button type="button" className="secondary small-btn details-map" onClick={() => onShowOnMap(k)}>
          Show on map
        </button>
      )}
      <p>
        {k.cause === "weapon" && d ? (
          <>
            <strong>{partyLabel(r.killer) || "An unknown shooter"}</strong> fired {article(r.weapon)}{" "}
            <strong>{r.weapon}</strong> at {fmt(d.launchTime)} from {fmtDist(d.launchRangeM, u.distance)}. It
            reached <strong>{partyLabel(r.victim)}</strong> {d.flightTimeS.toFixed(1)} s later, passing within{" "}
            {fmtShortDist(d.missDistanceM, u.altitude)}
            {k.secondsAfterHit !== null && k.secondsAfterHit > 0.5
              ? `, and the target went down ${k.secondsAfterHit.toFixed(1)} s after that`
              : ""}
            .
          </>
        ) : k.cause === "collision" ? (
          <>
            <strong>{partyLabel(r.victim)}</strong> and <strong>{partyLabel(r.other)}</strong> disappeared
            within a second of each other, less than 100 m apart, with no weapon nearby.
          </>
        ) : (
          <>
            <strong>{partyLabel(r.victim)}</strong> disappeared with no weapon nearby,{" "}
            {k.ejected ? "and the pilot ejected" : "while descending fast or at ground level"}.
          </>
        )}
      </p>
      <dl className="kv compact">
        <dt>Time</dt>
        <dd>
          {formatElapsed(k.time)} after start{tod ? ` · ${tod} UTC mission time` : ""}
        </dd>
        {d && (
          <>
            <dt>Shooter at launch</dt>
            <dd>
              {fmtAlt(d.shooterAltM, u.altitude)}, {fmtSpeed(d.shooterSpeedMs, u.speed)}
            </dd>
            <dt>Target at launch</dt>
            <dd>
              {fmtAlt(d.victimAltM, u.altitude)}, {fmtSpeed(d.victimSpeedMs, u.speed)}
            </dd>
          </>
        )}
        {r.assists.length > 0 && (
          <>
            <dt>Also hit by</dt>
            <dd>{r.assists.map(partyLabel).join(", ")}</dd>
          </>
        )}
        <dt>Confidence</dt>
        <dd>{confidenceText(k)}</dd>
        <dt>Object IDs</dt>
        <dd className="muted">
          lost {r.victim.id}
          {r.killer ? ` · shooter ${r.killer.id}` : ""}
        </dd>
      </dl>
    </div>
  );
}

function confidenceText(k: KillRecord["kill"]): string {
  if (k.cause !== "weapon")
    return k.confidence === "medium"
      ? "Medium: clear physical evidence (ejection, ground level, or another aircraft lost at the same spot)."
      : "Low: the aircraft was descending fast, but there is no other evidence.";
  if (k.confidence === "high")
    return "High: the shooter was right next to the weapon at launch, and the target went down within 2 s of the hit.";
  if (k.confidence === "medium")
    return "Medium: the target went down some seconds after the hit, or the shooter is less certain.";
  return "Low: a long time passed between the hit and the loss, or the shooter is uncertain.";
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function noteKind(n: string): string {
  if (n === "friendly fire" || n.endsWith("confidence")) return "warn";
  if (n === "pilot ejected") return "info";
  return "";
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
  if (pilots.length === 0) return <p className="muted">No pilots match the filter.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pilot</th>
            <th>Flying</th>
            <th className="num" title="Air / ground / sea">
              Kills
            </th>
            <th className="num">Deaths</th>
            <th className="num">Shots</th>
            <th className="num">Gun bursts</th>
            <th className="num" title="Shots and gun bursts that hit something">
              Hits
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
                  title={selected === p.key ? "Show everyone" : "Show only this pilot"}
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
                {p.friendlyKills > 0 && <span className="badge warn">{p.friendlyKills} friendly</span>}
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
          Shots ({all.length - gunCount} weapons{gunCount ? `, ${gunCount} gun bursts` : ""}
          {filtered ? `; ${shown.length} shown` : ""})
        </h3>
        {gunCount > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showGuns} onChange={(e) => setShowGuns(e.target.checked)} /> Show
            gun bursts
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="muted">No shots match the filter.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">Time</th>
                <th>Fired by</th>
                <th>Weapon</th>
                <th>Locked target</th>
                <th>Result</th>
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
                          <span className="badge warn">{r.shot.shooter.confidence}</span>
                        )}
                      </>
                    ) : (
                      <span
                        className="muted"
                        title={
                          r.shot.firstSeenInFlight
                            ? "Fired before the recording started, or out of the recorder's view"
                            : ""
                        }
                      >
                        {r.shot.firstSeenInFlight ? "Unknown (first seen in flight)" : "Unknown"}
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
                        Hit{" "}
                        {r.targets.map((t, i) => (
                          <span key={t.uid}>
                            {i > 0 && ", "}
                            <Who p={t} />
                          </span>
                        ))}
                      </>
                    ) : (
                      <span className="muted">{r.result}</span>
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
          Show all {shown.length.toLocaleString()}
        </button>
      )}
    </section>
  );
}

function Footnotes({ analysis }: { analysis: Analysis }) {
  const rw = analysis.removedWithoutEvidence;
  return (
    <>
      {rw.aircraft + rw.other > 0 && (
        <p className="muted footnote-left">
          Also removed without any sign of being hit, colliding or crashing (not counted as losses):{" "}
          {[
            rw.aircraft
              ? `${rw.aircraft} aircraft (player left, despawned, or out of the recorder's view)`
              : "",
            rw.other ? `${rw.other} other units` : "",
          ]
            .filter(Boolean)
            .join(" and ")}
          .
        </p>
      )}
      {analysis.massRemovals.length > 0 && (
        <p className="muted footnote-left">
          Not counted as losses:{" "}
          {analysis.massRemovals
            .map((m) =>
              m.atEnd
                ? `${m.count} object${m.count === 1 ? "" : "s"} removed when the recording ended`
                : `${m.count} objects removed together at ${formatElapsed(m.time)} (mission script or server reset)`,
            )
            .join("; ")}
          .
        </p>
      )}
      <p className="muted footnote-left">
        These recordings do not say who killed whom, so it is worked out from the data: who launched each
        weapon, and which object it passed closest to when it disappeared. Click a row for details.
      </p>
    </>
  );
}

/** "Pilot (Aircraft)" with a side-coloured dot. */
function Who({ p }: { p: Party | null }) {
  if (!p) return <span className="muted">Unknown</span>;
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
