import { aspectWords, type Engagement, engagementAt } from "../map/engagement.ts";
import { type MapData, type MapTrack, pilotAt, sampleAt } from "../map/mapData.ts";
import { SECONDARY_COLOR, sideColor } from "../map/render.ts";
import type { Settings } from "../settings/schema.ts";
import { fmtAlt, fmtDist, fmtShortDist, fmtSpeed, fmtVz } from "../settings/units.ts";
import type { FollowMode, PickRole } from "./viewTypes.ts";

interface Props {
  data: MapData;
  t: number;
  primary: MapTrack | undefined;
  secondary: MapTrack | undefined;
  follow: FollowMode;
  setFollow: (f: FollowMode) => void;
  onClear: (role: PickRole) => void;
  onSwap: () => void;
  armSecondary: boolean;
  setArmSecondary: (v: boolean) => void;
  settings: Settings;
}

/** Selected objects, the engagement between them, and camera follow. Overlaid on the map. */
export function SelectionPanel(p: Props) {
  const u = p.settings.units;
  const e = p.primary && p.secondary ? engagementAt(p.data, p.primary, p.secondary, p.t) : null;
  return (
    <div className="map-info sel-panel">
      {p.primary && <ObjectCard {...p} track={p.primary} which="primary" />}
      {p.secondary && <ObjectCard {...p} track={p.secondary} which="secondary" />}
      {p.primary && !p.secondary && (
        <button
          type="button"
          className={`secondary small-btn${p.armSecondary ? " on" : ""}`}
          aria-pressed={p.armSecondary}
          title="Then click another object (or Ctrl+right-click one at any time)"
          onClick={() => p.setArmSecondary(!p.armSecondary)}
        >
          {p.armSecondary ? "Click an object for the secondary…" : "Pick secondary…"}
        </button>
      )}
      {e && <EngagementBlock e={e} u={u} />}
      {p.primary && p.secondary && !e && (
        <p className="muted small">The pair don't both exist at this time.</p>
      )}
      <div className="sel-actions">
        <label className="follow">
          Camera
          <select value={p.follow} onChange={(ev) => p.setFollow(ev.target.value as FollowMode)}>
            <option value="off">Free</option>
            <option value="primary" disabled={!p.primary}>
              Follow primary
            </option>
            <option value="secondary" disabled={!p.secondary}>
              Follow secondary
            </option>
            <option value="pair" disabled={!p.primary || !p.secondary}>
              Follow the pair
            </option>
          </select>
        </label>
        {p.primary && p.secondary && (
          <button type="button" className="link small" title="Swap primary and secondary" onClick={p.onSwap}>
            ⇄ swap
          </button>
        )}
      </div>
    </div>
  );
}

function ObjectCard(props: Props & { track: MapTrack; which: PickRole }) {
  const { track, which: role, data, t } = props;
  const u = props.settings.units;
  const s = sampleAt(data, track, t);
  const pilot = pilotAt(track, t);
  return (
    <div className={`sel-card ${role}`}>
      <div className="map-info-title">
        <span
          className={`role-mark ${role}`}
          style={role === "secondary" ? { borderColor: SECONDARY_COLOR } : undefined}
          title={role === "primary" ? "Primary" : "Secondary"}
        />
        <span className="dot" style={{ background: sideColor(track.side) }} />
        {pilot ? `${pilot} · ` : ""}
        {track.name}
        <button
          type="button"
          className="link close"
          aria-label={`Clear the ${role} selection`}
          onClick={() => props.onClear(role)}
        >
          ×
        </button>
      </div>
      {s ? (
        <>
          <div>
            {fmtAlt(Number.isFinite(s.alt) ? s.alt : null, u.altitude)}
            {Math.abs(s.vz) >= 2
              ? ` · ${s.vz > 0 ? "climbing" : "descending"} ${fmtVz(s.vz, u.altitude)}`
              : ""}
          </div>
          <div>
            {/* True speed along the flight path (ground speed alone misreads vertical manoeuvres). */}
            {fmtSpeed(Math.hypot(s.speed, s.vz), u.speed)} · heading {Math.round(s.hdg)}°
          </div>
        </>
      ) : (
        <div className="muted small">Not present at this time.</div>
      )}
    </div>
  );
}

const deg = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}°` : "–");

function EngagementBlock({ e, u }: { e: Engagement; u: Settings["units"] }) {
  const closing = e.closure >= 0;
  const above = e.altDiff >= 0;
  const rows: [string, string, string][] = [
    [
      "Range",
      `${fmtDist(e.range, u.distance)}${Math.abs(e.altDiff) > 300 ? ` (${fmtDist(e.horizontalRange, u.distance)} horizontal)` : ""}`,
      "Straight-line distance from the primary to the secondary.",
    ],
    [
      "Closure",
      `${fmtSpeed(Math.abs(e.closure), u.speed)} ${closing ? "closing" : "opening"}${
        e.timeToMergeS !== null && e.timeToMergeS < 600 ? ` · merge in ${Math.round(e.timeToMergeS)} s` : ""
      }`,
      "How fast the range is shrinking (closing) or growing (opening).",
    ],
    [
      "Target is",
      `${e.clock} o'clock ${e.elevation === "level" ? "level" : e.elevation}, ${fmtShortDist(Math.abs(e.altDiff), u.altitude)} ${above ? "above" : "below"}`,
      "Where the secondary appears from the primary's cockpit (12 o'clock = nose).",
    ],
    [
      "Off our nose (ATA)",
      deg(e.ataDeg),
      "Antenna train angle: angle between the primary's nose and the line of sight to the secondary. 0° = dead ahead.",
    ],
    [
      "Aspect",
      `${deg(e.aspectDeg)}${aspectWords(e.aspectDeg) ? ` · ${aspectWords(e.aspectDeg)}` : ""}`,
      "Aspect angle: angle from the secondary's tail to the primary. 0° = on its tail, 90° = beam, 180° = nose-on.",
    ],
    [
      "Angle off tail",
      deg(e.angleOffTailDeg),
      "Heading crossing angle: angle between the two flight paths. 0° = same direction, 180° = opposite.",
    ],
    [
      "We're off its nose",
      deg(e.targetAtaDeg),
      "The secondary's ATA: angle between its nose and the primary. Small = it's pointing at us.",
    ],
  ];
  return (
    <dl className="kv compact engagement">
      {rows.map(([k, v, help]) => (
        <div key={k} className="kv-row" title={help}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
