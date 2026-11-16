import { useTranslation } from "react-i18next";
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
  /** Show the object details and engagement; when collapsed only names and the camera controls show. */
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  settings: Settings;
}

/** Selected objects, the engagement between them, and camera follow. Overlaid on the map. */
export function SelectionPanel(p: Props) {
  const { t } = useTranslation();
  const u = p.settings.units;
  const e = p.expanded && p.primary && p.secondary ? engagementAt(p.data, p.primary, p.secondary, p.t) : null;
  const actions = (
    <div className="sel-actions">
      <label className="follow">
        {t("map.selection.camera")}
        <select value={p.follow} onChange={(ev) => p.setFollow(ev.target.value as FollowMode)}>
          <option value="off">{t("map.selection.followOff")}</option>
          <option value="primary" disabled={!p.primary}>
            {t("map.selection.followPrimary")}
          </option>
          <option value="secondary" disabled={!p.secondary}>
            {t("map.selection.followSecondary")}
          </option>
          <option value="pair" disabled={!p.primary || !p.secondary}>
            {t("map.selection.followPair")}
          </option>
        </select>
      </label>
      {p.primary && p.secondary && (
        <button type="button" className="link small" title={t("map.selection.swapTitle")} onClick={p.onSwap}>
          {t("map.selection.swap")}
        </button>
      )}
      <button
        type="button"
        className="link small sel-toggle"
        aria-expanded={p.expanded}
        title={p.expanded ? t("map.selection.hideTitle") : t("map.selection.showTitle")}
        onClick={() => p.setExpanded(!p.expanded)}
      >
        {p.expanded ? t("map.selection.hide") : t("map.selection.details")}
      </button>
    </div>
  );
  if (!p.expanded)
    return (
      <div className="map-info sel-panel collapsed">
        {p.primary && <ObjectName track={p.primary} which="primary" t={p.t} />}
        {p.secondary && <ObjectName track={p.secondary} which="secondary" t={p.t} />}
        {actions}
      </div>
    );
  return (
    <div className="map-info sel-panel">
      {p.primary && <ObjectCard {...p} track={p.primary} which="primary" />}
      {p.secondary && <ObjectCard {...p} track={p.secondary} which="secondary" />}
      {p.primary && !p.secondary && (
        <button
          type="button"
          className={`secondary small-btn${p.armSecondary ? " on" : ""}`}
          aria-pressed={p.armSecondary}
          title={t("map.selection.pickSecondaryTitle")}
          onClick={() => p.setArmSecondary(!p.armSecondary)}
        >
          {p.armSecondary ? t("map.selection.clickSecondary") : t("map.selection.pickSecondary")}
        </button>
      )}
      {e && <EngagementBlock e={e} u={u} />}
      {p.primary && p.secondary && !e && <p className="muted small">{t("map.selection.pairNotPresent")}</p>}
      {actions}
    </div>
  );
}

/** One line per selected object for the collapsed panel: role mark, side colour, pilot and type. */
function ObjectName({ track, which, t }: { track: MapTrack; which: PickRole; t: number }) {
  const pilot = pilotAt(track, t);
  return (
    <div className="map-info-title sel-name">
      <RoleMark which={which} />
      <span className="dot" style={{ background: sideColor(track.side) }} />
      <span className="sel-name-text">
        {pilot ? `${pilot} · ` : ""}
        {track.name}
      </span>
    </div>
  );
}

function RoleMark({ which }: { which: PickRole }) {
  const { t } = useTranslation();
  return (
    <span
      className={`role-mark ${which}`}
      style={which === "secondary" ? { borderColor: SECONDARY_COLOR } : undefined}
      title={which === "primary" ? t("map.selection.primary") : t("map.selection.secondary")}
    />
  );
}

function ObjectCard(props: Props & { track: MapTrack; which: PickRole }) {
  const { t: tr } = useTranslation();
  const { track, which: role, data, t } = props;
  const u = props.settings.units;
  const s = sampleAt(data, track, t);
  const pilot = pilotAt(track, t);
  const roleLabel = role === "primary" ? tr("map.selection.primary") : tr("map.selection.secondary");
  return (
    <div className={`sel-card ${role}`}>
      <div className="map-info-title">
        <RoleMark which={role} />
        <span className="dot" style={{ background: sideColor(track.side) }} />
        {pilot ? `${pilot} · ` : ""}
        {track.name}
        <button
          type="button"
          className="link close"
          aria-label={tr("map.selection.clearSelectionAria", { role: roleLabel })}
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
              ? ` · ${s.vz > 0 ? tr("map.selection.climbing") : tr("map.selection.descending")} ${fmtVz(s.vz, u.altitude)}`
              : ""}
          </div>
          <div>
            {/* True speed along the flight path (ground speed alone misreads vertical manoeuvres). */}
            {fmtSpeed(Math.hypot(s.speed, s.vz), u.speed)} ·{" "}
            {tr("map.selection.heading", { deg: Math.round(s.hdg) })}
          </div>
        </>
      ) : (
        <div className="muted small">{tr("map.selection.notPresent")}</div>
      )}
    </div>
  );
}

const deg = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}°` : "–");

type AspectWordKey = "on its tail" | "rear quarter" | "beam" | "forward quarter" | "head-on";
function isAspectWordKey(w: string): w is AspectWordKey {
  return (
    w === "on its tail" || w === "rear quarter" || w === "beam" || w === "forward quarter" || w === "head-on"
  );
}

function EngagementBlock({ e, u }: { e: Engagement; u: Settings["units"] }) {
  const { t } = useTranslation();
  const closing = e.closure >= 0;
  const above = e.altDiff >= 0;
  const rawAspect = aspectWords(e.aspectDeg);
  const aspectWord = isAspectWordKey(rawAspect) ? t(`map.selection.aspectWords.${rawAspect}`) : "";
  const elevText =
    e.elevation === "high"
      ? t("map.selection.elevHigh")
      : e.elevation === "low"
        ? t("map.selection.elevLow")
        : t("map.selection.elevLevel");
  const rows: [string, string, string][] = [
    [
      t("map.selection.range"),
      Math.abs(e.altDiff) > 300
        ? t("map.selection.rangeHorizontal", {
            dist: fmtDist(e.range, u.distance),
            horiz: fmtDist(e.horizontalRange, u.distance),
          })
        : fmtDist(e.range, u.distance),
      t("map.selection.rangeHelp"),
    ],
    [
      t("map.selection.closure"),
      `${fmtSpeed(Math.abs(e.closure), u.speed)} ${closing ? t("map.selection.closing") : t("map.selection.opening")}${
        e.timeToMergeS !== null && e.timeToMergeS < 600
          ? ` · ${t("map.selection.mergeIn", { s: Math.round(e.timeToMergeS) })}`
          : ""
      }`,
      t("map.selection.closureHelp"),
    ],
    [
      t("map.selection.targetIs"),
      t("map.selection.targetIsValue", {
        clock: e.clock,
        elev: elevText,
        altDiff: fmtShortDist(Math.abs(e.altDiff), u.altitude),
        dir: above ? t("map.selection.above") : t("map.selection.below"),
      }),
      t("map.selection.targetIsHelp"),
    ],
    [t("map.selection.ata"), deg(e.ataDeg), t("map.selection.ataHelp")],
    [
      t("map.selection.aspect"),
      `${deg(e.aspectDeg)}${aspectWord ? ` · ${aspectWord}` : ""}`,
      t("map.selection.aspectHelp"),
    ],
    [t("map.selection.angleOffTail"), deg(e.angleOffTailDeg), t("map.selection.angleOffTailHelp")],
    [t("map.selection.targetAta"), deg(e.targetAtaDeg), t("map.selection.targetAtaHelp")],
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
