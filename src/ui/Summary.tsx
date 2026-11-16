import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ObjectSummary } from "../acmi/summary.ts";
import { useSettings } from "../settings/react.ts";
import type { ParseOutcome } from "../worker/client.ts";
import { AnalysisView } from "./AnalysisView.tsx";
import { type MapFocus, MapView } from "./MapView.tsx";
import { PinLayout, Pinnable } from "./pins.tsx";
import { RecordingAnalytics } from "./RecordingAnalytics.tsx";
import { formatClock } from "./records.ts";

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

export function Summary({ name, file, outcome }: { name: string; file: Blob; outcome: ParseOutcome }) {
  const { t } = useTranslation();
  const clock = useSettings().settings.time.clock;
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const r = outcome.summary;
  const refTime = r.referenceTime;
  // Stable between renders so the map's timeline ticks aren't rebuilt needlessly.
  const fmt = useCallback((t: number) => formatClock(clock, refTime, t), [clock, refTime]);
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
    <PinLayout>
      <div className="summary">
        <section className="card">
          <h2>{g.Title || name}</h2>
          <p className="muted file-name">{name}</p>
          <div className="stats">
            <Stat label={t("viewer.summary.duration")} value={formatDuration(duration)} />
            <Stat label={t("viewer.summary.aircraft")} value={aircraft.length.toLocaleString()} />
            <Stat label={t("viewer.summary.weaponsReleased")} value={weapons.length.toLocaleString()} />
            <Stat label={t("viewer.summary.objects")} value={r.objects.length.toLocaleString()} />
            <Stat label={t("viewer.summary.events")} value={r.events.length.toLocaleString()} />
          </div>
          {r.container.incomplete && <p className="notice">{t("viewer.summary.incompleteZip")}</p>}
          {r.truncated && <p className="notice">{t("viewer.summary.truncated")}</p>}
        </section>

        {outcome.map && outcome.map.tracks.length > 0 && (
          <MapView data={outcome.map} fmt={fmt} focus={focus} />
        )}

        {outcome.analysis && (
          <AnalysisView
            summary={r}
            analysis={outcome.analysis}
            onShowOnMap={
              outcome.map
                ? (k) =>
                    // Killer as primary ("ownship"), victim as secondary ("target"): the engagement
                    // panel then reads from the shooter's point of view.
                    setFocus((f) => ({
                      time: k.time,
                      uid: k.victimUid,
                      primary: k.killer?.uid ?? k.victimUid,
                      secondary: k.killer ? k.victimUid : null,
                      seq: (f?.seq ?? 0) + 1,
                    }))
                : undefined
            }
          />
        )}
        <Pinnable id="analytics" title={t("viewer.summary.missileAnalyticsTitle")}>
          <RecordingAnalytics
            file={file}
            name={name}
            onShowOnMap={
              outcome.map
                ? (e) => {
                    // Shooter as primary, target as secondary, like the kill table's "show on map".
                    const shooter = e.shooter?.uid ?? null;
                    const target = e.target?.uid ?? null;
                    setFocus((f) => ({
                      time: e.launchTime,
                      uid: target ?? shooter ?? e.weaponUid,
                      primary: shooter ?? target,
                      secondary: shooter !== null ? target : null,
                      seq: (f?.seq ?? 0) + 1,
                    }));
                  }
                : undefined
            }
          />
        </Pinnable>

        {outcome.analysisError && (
          <section className="card">
            <p className="notice">{t("viewer.summary.analysisFailed", { error: outcome.analysisError })}</p>
          </section>
        )}

        <Pinnable id="aircraft" title={t("viewer.summary.aircraft")}>
          <section className="card">
            <h3>{t("viewer.summary.aircraftCount", { count: aircraft.length })}</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("viewer.summary.pilot")}</th>
                    <th>{t("viewer.summary.type")}</th>
                    <th>{t("viewer.summary.group")}</th>
                    <th>{t("viewer.summary.side")}</th>
                    <th className="num">{t("viewer.summary.appeared")}</th>
                    <th className="num">{t("viewer.summary.gone")}</th>
                  </tr>
                </thead>
                <tbody>
                  {aircraft.map((o) => (
                    <tr key={o.uid}>
                      <td>{o.pilot || <span className="muted">{t("common.ai")}</span>}</td>
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
        </Pinnable>

        {weapons.length > 0 && (
          <Pinnable id="weapons" title={t("viewer.summary.weaponsReleased")}>
            <section className="card">
              <h3>{t("viewer.summary.weaponsReleased")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t("viewer.summary.weapon")}</th>
                    <th>{t("viewer.summary.type")}</th>
                    <th className="num">{t("viewer.summary.count")}</th>
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
            </section>
          </Pinnable>
        )}

        {r.events.length > 0 && (
          <Pinnable id="events" title={t("viewer.summary.eventsTitle")}>
            <section className="card">
              <h3>{t("viewer.summary.eventsCount", { count: r.events.length })}</h3>
              <table>
                <thead>
                  <tr>
                    <th className="num">{t("viewer.summary.time")}</th>
                    <th>{t("viewer.summary.event")}</th>
                    <th>{t("viewer.summary.objectsCol")}</th>
                    <th>{t("viewer.summary.text")}</th>
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
          </Pinnable>
        )}

        <Pinnable id="recording" title={t("viewer.summary.recordingTitle")}>
          <section className="card">
            <h3>{t("viewer.summary.recordingTitle")}</h3>
            <dl className="kv">
              {GLOBAL_ORDER.filter((k) => g[k] !== undefined).map((k) => (
                <Row key={k} k={k} v={g[k] ?? ""} />
              ))}
              {otherGlobals.map((k) => (
                <Row key={k} k={k} v={g[k] ?? ""} />
              ))}
              <Row k={t("viewer.summary.fileFormat")} v={`${r.fileType ?? "?"} ${r.fileVersion ?? ""}`} />
              <Row
                k={t("viewer.summary.container")}
                v={r.container.kind === "zip" ? `zip → ${r.container.entryName ?? "?"}` : r.container.kind}
              />
              <Row
                k={t("viewer.summary.size")}
                v={t("viewer.summary.sizeValue", {
                  raw: formatBytes(r.stats.rawBytes),
                  text: formatBytes(r.stats.textBytes),
                  lines: r.stats.logicalLines.toLocaleString(),
                  frames: r.stats.frames.toLocaleString(),
                })}
              />
              <Row
                k={t("viewer.summary.readIn")}
                v={t("viewer.summary.readInValue", { ms: outcome.elapsedMs.toFixed(0) })}
              />
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
        </Pinnable>

        <Pinnable id="types" title={t("viewer.summary.objectTypesTitle")}>
          <section className="card">
            <h3>{t("viewer.summary.objectTypesTitle")}</h3>
            <table>
              <thead>
                <tr>
                  <th>{t("viewer.summary.type")}</th>
                  <th className="num">{t("viewer.summary.count")}</th>
                </tr>
              </thead>
              <tbody>
                {types.map(([tp, n]) => (
                  <tr key={tp}>
                    <td>{tp}</td>
                    <td className="num">{n.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </Pinnable>

        {warningKinds.length > 0 && (
          <Pinnable id="warnings" title={t("viewer.summary.parserWarningsTitle")}>
            <section className="card">
              <h3>{t("viewer.summary.parserWarningsTitle")}</h3>
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
                            {w.lineNo > 0 && (
                              <span className="muted">
                                {t("viewer.summary.linePrefix", { line: w.lineNo })}
                              </span>
                            )}
                            {w.message}
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          </Pinnable>
        )}
      </div>
    </PinLayout>
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
