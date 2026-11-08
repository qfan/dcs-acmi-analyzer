import type { ObjectSummary } from "../acmi/summary.ts";
import type { ParseOutcome } from "../worker/client.ts";

const GLOBAL_ORDER = [
  "Title",
  "Category",
  "DataSource",
  "DataRecorder",
  "Author",
  "ReferenceTime",
  "RecordingTime",
  "Theater",
  "ReferenceLongitude",
  "ReferenceLatitude",
];
const LONG_TEXT = new Set(["Briefing", "Debriefing", "Comments"]);

const isAircraft = (o: ObjectSummary) =>
  o.tags.includes("Air") && (o.tags.includes("FixedWing") || o.tags.includes("Rotorcraft"));
const isWeapon = (o: ObjectSummary) => o.tags.includes("Weapon");

export function Summary({ name, outcome }: { name: string; outcome: ParseOutcome }) {
  const r = outcome.summary;
  const g = r.globals;
  const duration = r.timeEnd - r.timeStart;
  const otherGlobals = Object.keys(g)
    .filter((k) => !GLOBAL_ORDER.includes(k) && !LONG_TEXT.has(k))
    .sort();

  const aircraft = r.objects.filter(isAircraft);
  const weapons = r.objects.filter(isWeapon);
  const weaponCounts = countBy(weapons, (o) => `${o.name || "(unnamed)"}\u0000${o.type}`);
  const types = [...countBy(r.objects, (o) => o.type || "(no type)")].sort((a, b) => b[1] - a[1]);
  const warningKinds = Object.entries(r.warningCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  return (
    <div className="summary">
      <section className="card">
        <h2>{g.Title || name}</h2>
        <p className="muted file-name">{name}</p>
        <div className="stats">
          <Stat label="Duration" value={formatDuration(duration)} />
          <Stat label="Aircraft" value={aircraft.length.toLocaleString()} />
          <Stat label="Weapons released" value={weapons.length.toLocaleString()} />
          <Stat label="Objects" value={r.objects.length.toLocaleString()} />
          <Stat label="Events" value={r.events.length.toLocaleString()} />
        </div>
        {r.container.incomplete && (
          <p className="notice">
            This zip archive was never finished (the recording was probably interrupted). The data that was
            there has been recovered.
          </p>
        )}
        {r.truncated && (
          <p className="notice">
            This recording appears unfinished: the file ends partway through a line. Everything before that
            point was read.
          </p>
        )}
      </section>

      <section className="card">
        <h3>Aircraft ({aircraft.length})</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pilot</th>
                <th>Type</th>
                <th>Group</th>
                <th>Side</th>
                <th className="num">Appeared</th>
                <th className="num">Gone</th>
              </tr>
            </thead>
            <tbody>
              {aircraft.map((o) => (
                <tr key={o.uid}>
                  <td>{o.pilot || <span className="muted">AI</span>}</td>
                  <td>{o.name}</td>
                  <td>{o.group}</td>
                  <td>
                    <span className={`side side-${o.color.toLowerCase()}`}>{o.color || o.coalition}</span>
                  </td>
                  <td className="num">{formatDuration(o.createdAt)}</td>
                  <td className="num">{o.removedAt === null ? "–" : formatDuration(o.removedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {weapons.length > 0 && (
        <section className="card">
          <h3>Weapons released</h3>
          <table>
            <thead>
              <tr>
                <th>Weapon</th>
                <th>Type</th>
                <th className="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {[...weaponCounts]
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => {
                  const [wName, wType] = k.split("\u0000");
                  return (
                    <tr key={k}>
                      <td>{wName}</td>
                      <td className="muted">{wType}</td>
                      <td className="num">{n}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p className="muted footnote-left">
            Who fired each weapon and what it hit is not recorded in these files; that analysis comes next.
          </p>
        </section>
      )}

      {r.events.length > 0 && (
        <section className="card">
          <h3>Events ({r.events.length})</h3>
          <table>
            <thead>
              <tr>
                <th className="num">Time</th>
                <th>Event</th>
                <th>Objects</th>
                <th>Text</th>
              </tr>
            </thead>
            <tbody>
              {r.events.slice(0, 500).map((e) => (
                <tr key={`${e.lineNo}:${e.raw}`}>
                  <td className="num">{formatDuration(e.time)}</td>
                  <td>{e.type}</td>
                  <td>{e.objectIds.join(", ")}</td>
                  <td>{e.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h3>Recording</h3>
        <dl className="kv">
          {GLOBAL_ORDER.filter((k) => g[k] !== undefined).map((k) => (
            <Row key={k} k={k} v={g[k] ?? ""} />
          ))}
          {otherGlobals.map((k) => (
            <Row key={k} k={k} v={g[k] ?? ""} />
          ))}
          <Row k="File format" v={`${r.fileType ?? "?"} ${r.fileVersion ?? ""}`} />
          <Row
            k="Container"
            v={r.container.kind === "zip" ? `zip → ${r.container.entryName ?? "?"}` : r.container.kind}
          />
          <Row
            k="Size"
            v={`${formatBytes(r.stats.rawBytes)} on disk, ${formatBytes(r.stats.textBytes)} text, ${r.stats.logicalLines.toLocaleString()} lines, ${r.stats.frames.toLocaleString()} time frames`}
          />
          <Row k="Read in" v={`${outcome.elapsedMs.toFixed(0)} ms`} />
        </dl>
        {[...LONG_TEXT]
          .filter((k) => g[k])
          .map((k) => (
            <details key={k}>
              <summary>{k}</summary>
              <p className="long-text">{g[k]}</p>
            </details>
          ))}
      </section>

      <section className="card">
        <h3>Object types</h3>
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {types.map(([t, n]) => (
              <tr key={t}>
                <td>{t}</td>
                <td className="num">{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {warningKinds.length > 0 && (
        <section className="card">
          <h3>Parser warnings</h3>
          <ul className="warnings">
            {warningKinds.map(([kind, n]) => (
              <li key={kind}>
                <strong>{kind}</strong> × {n}
                <ul>
                  {r.warnings
                    .filter((w) => w.kind === kind)
                    .slice(0, 5)
                    .map((w) => (
                      <li key={`${w.lineNo}:${w.message}`}>
                        {w.lineNo > 0 && <span className="muted">line {w.lineNo}: </span>}
                        {w.message}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
