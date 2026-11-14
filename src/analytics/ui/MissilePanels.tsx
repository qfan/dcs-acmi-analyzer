import { useEffect, useState } from "react";
import { FIT_RULES, fitMissileModels, MACH_BANDS } from "../missileFit.ts";
import { buildFittedMissiles, type FittedMissile, LADDER_ALTS_FT } from "../missileReach.ts";
import type { MissileEngagement } from "../model.ts";

/**
 * Fits the missile models after the dashboard has painted (it takes about a second for a few thousand
 * shots), and again whenever the filtered engagements change.
 */
export function useFittedMissiles(engagements: MissileEngagement[]): {
  fitted: FittedMissile[] | null;
  busy: boolean;
} {
  const [state, setState] = useState<{ fitted: FittedMissile[] | null; busy: boolean }>({
    fitted: null,
    busy: true,
  });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ fitted: s.fitted, busy: true }));
    const id = setTimeout(() => {
      const models = fitMissileModels(engagements);
      const fitted = buildFittedMissiles(models, engagements);
      if (!cancelled) setState({ fitted, busy: false });
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [engagements]);
  return state;
}

const COLD = "#0f6e56";
const DANGER = "#3fb58c";
const REACH = "rgba(93, 202, 165, 0.45)";
const LOFT = "#1d9e75";

function ReachLadder({ f }: { f: FittedMissile }) {
  const W = 640;
  const X0 = 70;
  const X1 = W - 14;
  const rowH = 44;
  const rows = [...f.ladder].reverse();
  const max = Math.max(
    40,
    Math.ceil(Math.max(...rows.map((r) => Math.max(r.hotLoftNm, r.hotDirectNm))) / 10) * 10,
  );
  const fx = (nm: number) => X0 + (Math.min(nm, max) / max) * (X1 - X0);
  const H = rows.length * rowH + 26;
  const ticks: number[] = [];
  for (let n = 0; n <= max; n += max > 60 ? 20 : 10) ticks.push(n);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`${f.model.weapon} reach by altitude`}
      style={{ maxWidth: W }}
    >
      {ticks.map((n) => (
        <g key={n}>
          <line x1={fx(n)} x2={fx(n)} y1={2} y2={H - 22} stroke="currentColor" strokeOpacity={0.12} />
          <text x={fx(n)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
            {n} nm
          </text>
        </g>
      ))}
      {rows.map((r, i) => {
        const y = 6 + i * rowH;
        const hot = r.dangerousHotDirectNm;
        const loft = Math.max(r.hotLoftNm, r.hotDirectNm);
        return (
          <g key={r.altFt}>
            <text x={X0 - 8} y={y + 19} textAnchor="end" fontSize={11} fill="var(--muted)">
              {r.altFt / 1000}k ft
            </text>
            {loft > r.hotDirectNm + 0.5 && (
              <rect
                x={fx(r.hotDirectNm)}
                y={y + 4}
                width={fx(loft) - fx(r.hotDirectNm)}
                height={24}
                fill="none"
                stroke={LOFT}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                rx={3}
              />
            )}
            <rect x={X0} y={y + 4} width={fx(r.hotDirectNm) - X0} height={24} fill={REACH} rx={3} />
            <rect x={X0} y={y + 4} width={fx(hot) - X0} height={24} fill={DANGER} rx={3} />
            <rect x={X0} y={y + 4} width={fx(r.coldNm) - X0} height={24} fill={COLD} rx={3} />
            {fx(r.coldNm) - X0 > 26 && (
              <text x={fx(r.coldNm) - 5} y={y + 20} textAnchor="end" fontSize={11} fill="#e1f5ee">
                {Math.round(r.coldNm)}
              </text>
            )}
            {fx(hot) - fx(r.coldNm) > 24 && (
              <text x={fx(hot) - 5} y={y + 20} textAnchor="end" fontSize={11} fill="#04342c">
                {Math.round(hot)}
              </text>
            )}
            <text x={Math.min(fx(loft) + 5, X1 - 30)} y={y + 20} fontSize={11} fill="var(--muted)">
              {Math.round(loft)}
              {loft >= max ? "+" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

const fmtCd = (c: number) => (c * 1e5).toFixed(1);

export function MissileModelsCard({ fitted, busy }: { fitted: FittedMissile[] | null; busy: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = fitted ?? [];
  const cur =
    list.find((f) => f.model.weapon === selected) ?? list.find((f) => f.model.quality === "good") ?? list[0];

  return (
    <section className="card analytics-card" aria-label="Missile flyout models">
      <div className="card-head">
        <div>
          <h3>Missile flyout models (fitted from these recordings)</h3>
          <p className="muted small matrix-sub">
            Drag, motor and loft habit measured from every tracked radar-missile flyout in the current
            selection, then flown in a simple side-view sim (both jets M0.9, same altitude) to find how far
            each missile reaches at each altitude. Kinematics only: no radar, notch or chaff.
            {busy && " Fitting…"}
          </p>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="muted small">
          {busy
            ? "Fitting missile models…"
            : `No missile has ${FIT_RULES.minShots}+ tracked radar-missile shots in this selection yet.`}
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="records">
              <thead>
                <tr>
                  <th>Missile</th>
                  <th title="Tracked shots used for the fit, and kills among them">Shots · kills</th>
                  <th title="Boost until peak speed; a sustain motor keeps pushing until 'motor off'">
                    Motor
                  </th>
                  <th>Peak</th>
                  <th
                    title={`Drag per Mach band (×1e-5 per m): ${MACH_BANDS.slice(0, -1)
                      .map((m, i) => `M${m}–${MACH_BANDS[i + 1]}`)
                      .join(", ")}`}
                  >
                    Drag M1.2–1.6
                  </th>
                  <th title="Climb above launch altitude (median) by launch range">Loft</th>
                  <th title="Replays each coast along its real path with the fitted model; median error of the end speed">
                    Fit error
                  </th>
                  <th>
                    No-escape at
                    <br />
                    35k / 15k / 5k ft
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => {
                  const m = f.model;
                  const at = (ft: number) => f.ladder.find((r) => r.altFt === ft)?.coldNm;
                  const isCur = cur?.model.weapon === m.weapon;
                  return (
                    <tr
                      key={m.weapon}
                      onClick={() => setSelected(m.weapon)}
                      style={{ cursor: "pointer", background: isCur ? "rgba(59,130,246,0.10)" : undefined }}
                      title={m.rawNames.join(", ")}
                    >
                      <td>
                        <strong>{m.weapon}</strong>
                        {f.tier && <span className="muted small"> · {f.tier}</span>}
                        {m.quality === "suspect" && (
                          <span
                            className="badge warn"
                            title={m.qualityNote ?? undefined}
                            style={{ marginLeft: 6 }}
                          >
                            suspect
                          </span>
                        )}
                      </td>
                      <td>
                        {m.shots} · {m.kills}
                      </td>
                      <td>
                        {m.boostS.toFixed(1)} s
                        {m.motorEndS > m.boostS + 1 && (
                          <span className="muted small"> + sustain to {m.motorEndS} s</span>
                        )}
                      </td>
                      <td>M{m.peakMach.toFixed(1)}</td>
                      <td title={m.cd.map(fmtCd).join(" / ")}>{fmtCd(m.cd[2] ?? 0)}</td>
                      <td className="small">
                        {m.lofts
                          ? m.loft
                              .filter((b) => b.shots >= FIT_RULES.minLoftBinShots)
                              .map((b) => `${b.label} nm: +${Math.round(b.medianGainFt / 1000)}k`)
                              .join(" · ")
                          : "No"}
                      </td>
                      <td
                        title={`90% within M${m.replay.p90Mach.toFixed(2)}; single-drag model: M${m.replay.flatDragMedianMach.toFixed(2)}`}
                      >
                        M{m.replay.medianMach.toFixed(2)}
                      </td>
                      <td>{[35000, 15000, 5000].map((ft) => Math.round(at(ft) ?? 0)).join(" / ")} nm</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cur && (
            <div style={{ marginTop: 12 }}>
              <div className="small" style={{ marginBottom: 4 }}>
                <strong>{cur.model.weapon}</strong> reach by altitude ({LADDER_ALTS_FT.length} altitudes;
                click a row above to switch)
              </div>
              <div
                className="small muted"
                style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 4 }}
              >
                <span>
                  <span style={{ display: "inline-block", width: 12, height: 10, background: COLD }} /> No
                  escape: target turns cold at launch
                </span>
                <span>
                  <span style={{ display: "inline-block", width: 12, height: 10, background: DANGER }} />{" "}
                  Dangerous head-on (arrives M{FIT_RULES.dangerousMach}+)
                </span>
                <span>
                  <span style={{ display: "inline-block", width: 12, height: 10, background: REACH }} />{" "}
                  Reaches you head-on (M{cur.model.reachMach.toFixed(1)}+, slowest 10% of kills)
                </span>
                <span>
                  <span
                    style={{ display: "inline-block", width: 12, height: 10, border: `1.5px dashed ${LOFT}` }}
                  />{" "}
                  Extra from loft
                </span>
              </div>
              <ReachLadder f={cur} />
              {cur.model.quality === "suspect" && <p className="small muted">{cur.model.qualityNote}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
