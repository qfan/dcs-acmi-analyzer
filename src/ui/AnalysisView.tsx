import { type ReactNode, useState } from "react";
import type { ObjectSummary, RecordingSummary } from "../acmi/summary.ts";
import type { Analysis, Kill, ShooterInfo, Shot } from "../analysis/analyze.ts";

const SHOT_LIMIT = 300;

export function AnalysisView({ summary, analysis }: { summary: RecordingSummary; analysis: Analysis }) {
  const objs = summary.objects;
  const obj = (uid: number | null | undefined): ObjectSummary | null =>
    uid === null || uid === undefined ? null : (objs[uid] ?? null);

  return (
    <>
      <section className="card">
        <h3>Kills and losses ({analysis.kills.length})</h3>
        {analysis.scrambled.objects > 0 && (
          <p className="notice">
            {analysis.scrambled.protectedHeader ? "This is a protected multiplayer recording: the" : "The"}{" "}
            positions of {analysis.scrambled.objects.toLocaleString()} object
            {analysis.scrambled.objects === 1 ? "" : "s"} ({analysis.scrambled.aircraft.toLocaleString()}{" "}
            aircraft) are scrambled in the file, so who shot whom can't be worked out for them. They are left
            out of the kill list below. Only Tacview with the server's key can restore these positions.
          </p>
        )}
        {analysis.kills.length === 0 ? (
          <p className="muted">Nothing was destroyed in this recording.</p>
        ) : (
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
                {analysis.kills.map((k) => (
                  <KillRow key={`${k.victimUid}:${k.time}`} k={k} obj={obj} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {analysis.removedWithoutEvidence.aircraft + analysis.removedWithoutEvidence.other > 0 && (
          <p className="muted footnote-left">
            Also removed without any sign of being hit, colliding or crashing (not counted as losses):{" "}
            {[
              analysis.removedWithoutEvidence.aircraft
                ? `${analysis.removedWithoutEvidence.aircraft} aircraft (player left, despawned, or out of the recorder's view)`
                : "",
              analysis.removedWithoutEvidence.other
                ? `${analysis.removedWithoutEvidence.other} other units`
                : "",
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
                  : `${m.count} objects removed together at ${formatTime(m.time)} (mission script or server reset)`,
              )
              .join("; ")}
            .
          </p>
        )}
        <p className="muted footnote-left">
          These recordings do not say who killed whom, so it is worked out from the data: who launched each
          weapon, and which object it passed closest to when it disappeared.
        </p>
      </section>

      {analysis.pilots.length > 0 && (
        <section className="card">
          <h3>Pilots and units</h3>
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
                {analysis.pilots.map((p) => (
                  <tr key={p.key}>
                    <td>
                      <SideDot coalition={p.coalition} objs={objs} />
                      {p.key}
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
        </section>
      )}

      <ShotsTable shots={analysis.shots} obj={obj} />
    </>
  );
}

function KillRow({ k, obj }: { k: Kill; obj: (uid: number | null | undefined) => ObjectSummary | null }) {
  const victim = obj(k.victimUid);
  const killerObj = k.killer ? obj(k.killer.uid) : null;
  const notes: { text: string; kind?: "warn" | "info" }[] = [];
  if (k.friendly) notes.push({ text: "friendly fire", kind: "warn" });
  if (k.ejected) notes.push({ text: "pilot ejected", kind: "info" });
  if (
    killerObj?.removedAt !== null &&
    killerObj?.removedAt !== undefined &&
    killerObj.removedAt < k.time - 0.05
  )
    notes.push({ text: "shooter already down" });
  if (k.secondsAfterHit !== null && k.secondsAfterHit > 2)
    notes.push({ text: `went down ${k.secondsAfterHit.toFixed(0)} s after the hit` });
  if (k.assists.length)
    notes.push({ text: `also hit by ${k.assists.map((u) => who(obj(u), "")).join(", ")}` });
  if (k.confidence !== "high") notes.push({ text: `${k.confidence} confidence`, kind: "warn" });

  let killedBy: ReactNode;
  let weapon: ReactNode = weaponLabel(k.weaponName, k.isGun);
  if (k.cause === "weapon") killedBy = <Who o={killerObj} pilot={k.killer?.pilot ?? ""} />;
  else if (k.cause === "collision") {
    killedBy = (
      <>
        Collision with <Who o={obj(k.otherUid)} pilot="" />
      </>
    );
    weapon = "";
  } else if (k.cause === "crash") {
    killedBy = <span className="muted">Crashed (no weapon hit found)</span>;
    weapon = "";
  } else {
    killedBy = <span className="muted">Unknown (no weapon hit found)</span>;
    weapon = "";
  }
  return (
    <tr>
      <td className="num">{formatTime(k.time)}</td>
      <td>
        <Who o={victim} pilot={k.victimPilot} />
      </td>
      <td>{killedBy}</td>
      <td>{weapon}</td>
      <td>
        {notes.map((n) => (
          <span key={n.text} className={`badge ${n.kind ?? ""}`}>
            {n.text}
          </span>
        ))}
      </td>
    </tr>
  );
}

function ShotsTable({
  shots,
  obj,
}: {
  shots: Shot[];
  obj: (uid: number | null | undefined) => ObjectSummary | null;
}) {
  const [showGuns, setShowGuns] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const gunCount = shots.filter((s) => s.isGun).length;
  const visible = shots.filter((s) => showGuns || !s.isGun);
  const rows = showAll ? visible : visible.slice(0, SHOT_LIMIT);
  if (shots.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          Shots ({shots.length - gunCount} weapons{gunCount ? `, ${gunCount} gun bursts` : ""})
        </h3>
        {gunCount > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showGuns} onChange={(e) => setShowGuns(e.target.checked)} /> Show
            gun bursts
          </label>
        )}
      </div>
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
            {rows.map((s) => {
              const w = obj(s.weaponUid);
              const targets = [...new Set(s.hits.map((h) => h.targetUid))];
              return (
                <tr key={s.weaponUid}>
                  <td className="num">{formatTime(s.time)}</td>
                  <td>
                    <Shooter s={s.shooter} inFlight={s.firstSeenInFlight} obj={obj} />
                  </td>
                  <td>
                    {weaponLabel(w?.name ?? "", s.isGun)}
                    {s.isGun && <span className="muted small"> × {s.rounds}</span>}
                  </td>
                  <td>{s.lockedTargetUid !== null ? <Who o={obj(s.lockedTargetUid)} pilot="" /> : ""}</td>
                  <td>
                    {s.outcome === "hit" ? (
                      <>
                        Hit{" "}
                        {targets.map((u, i) => (
                          <span key={u}>
                            {i > 0 && ", "}
                            <Who o={obj(u)} pilot="" />
                          </span>
                        ))}
                      </>
                    ) : s.outcome === "active" ? (
                      <span className="muted">Still flying at the end</span>
                    ) : (
                      <span className="muted">Missed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!showAll && visible.length > SHOT_LIMIT && (
        <button type="button" className="secondary more" onClick={() => setShowAll(true)}>
          Show all {visible.length.toLocaleString()}
        </button>
      )}
    </section>
  );
}

function Shooter({
  s,
  inFlight,
  obj,
}: {
  s: ShooterInfo | null;
  inFlight: boolean;
  obj: (uid: number | null | undefined) => ObjectSummary | null;
}) {
  if (!s)
    return (
      <span
        className="muted"
        title={inFlight ? "Fired before the recording started, or out of the recorder's view" : ""}
      >
        {inFlight ? "Unknown (first seen in flight)" : "Unknown"}
      </span>
    );
  return (
    <>
      <Who o={obj(s.uid)} pilot={s.pilot} />
      {s.confidence !== "high" && <span className="badge warn">{s.confidence}</span>}
    </>
  );
}

/** "Pilot (Aircraft)" with a side-coloured dot. */
function Who({ o, pilot }: { o: ObjectSummary | null; pilot: string }) {
  if (!o) return <span className="muted">Unknown</span>;
  const p = pilot || o.pilot;
  return (
    <span className="who">
      <span className={`dot side-bg-${(o.color || "grey").toLowerCase()}`} />
      {p ? (
        <>
          {p} <span className="muted">({o.name})</span>
        </>
      ) : (
        o.name
      )}
    </span>
  );
}

function who(o: ObjectSummary | null, pilot: string): string {
  if (!o) return "unknown";
  const p = pilot || o.pilot;
  return p ? `${p} (${o.name})` : o.name;
}

function SideDot({ coalition, objs }: { coalition: string; objs: ObjectSummary[] }) {
  const color = objs.find((o) => o.coalition === coalition && o.color)?.color ?? "grey";
  return <span className={`dot side-bg-${color.toLowerCase()}`} />;
}

function weaponLabel(name: string, isGun: boolean): string {
  if (!name) return "";
  if (isGun) return `Gun (${name.replace(/^weapons\.shells\./, "").replace(/_/g, " ")})`;
  return name.replace(/_/g, "-");
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
