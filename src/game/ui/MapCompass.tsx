/** Corner compass rose and map rotation controls for the BVR Trainer canvas. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEG } from "../sim/atmosphere.ts";
import { wrap2Pi } from "../sim/vec.ts";
import { snapRotation, upHeadingDeg } from "./camera.ts";

export interface MapCompassProps {
  rot: number;
  onSetRot: (rot: number) => void;
  onStepRot: (deltaDeg: number) => void;
  onToggleNorth: () => void;
}

const INTERCARDINAL_DEGS = [45, 135, 225, 315] as const;
const CARDINAL_DEGS = [90, 180, 270] as const;

export function MapCompass({ rot, onSetRot, onStepRot, onToggleNorth }: MapCompassProps) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  const dialRef = useRef<HTMLButtonElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);
  const onStepRotRef = useRef(onStepRot);
  onStepRotRef.current = onStepRot;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      onStepRotRef.current((delta > 0 ? 1 : -1) * 15);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const degStr = String(upHeadingDeg(rot)).padStart(3, "0");
  const rotDegExact = rot / DEG;

  const onDialMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const dial = dialRef.current;
    if (!dial) return;
    e.preventDefault();
    const r = dial.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const startX = e.clientX;
    const startY = e.clientY;
    const startAngle = Math.atan2(startX - cx, -(startY - cy));
    const startRot = rot;
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      if (!moved) {
        moved = true;
        suppressClickRef.current = true;
        setDragging(true);
      }
      if (Math.hypot(ev.clientX - cx, ev.clientY - cy) < 2) return;
      const curAngle = Math.atan2(ev.clientX - cx, -(ev.clientY - cy));
      onSetRot(snapRotation(wrap2Pi(startRot - (curAngle - startAngle)), ev.shiftKey));
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      dragCleanupRef.current = null;
    };

    const onUp = () => {
      cleanup();
      if (moved) setDragging(false);
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stop pointer events from reaching the map canvas underneath
    <div
      ref={boxRef}
      className="g-compass"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        ref={dialRef}
        type="button"
        className={dragging ? "g-compass-dial dragging" : "g-compass-dial"}
        aria-label={t("game.app.compass.aria", { deg: degStr })}
        title={t("game.app.compass.dialTitle", { deg: degStr })}
        onMouseDown={onDialMouseDown}
        onClick={(e) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onToggleNorth();
          e.currentTarget.blur();
        }}
      >
        <svg width="48" height="48" viewBox="-24 -24 48 48" aria-hidden="true">
          <circle cx="0" cy="0" r="22" fill="none" stroke="rgba(148, 163, 184, 0.25)" strokeWidth="1" />
          <g transform={`rotate(${(-rotDegExact).toFixed(2)})`}>
            {INTERCARDINAL_DEGS.map((a) => (
              <line
                key={a}
                x1="0"
                y1="-21"
                x2="0"
                y2="-19"
                stroke="rgba(148, 163, 184, 0.45)"
                strokeWidth="1"
                transform={`rotate(${a})`}
              />
            ))}
            {CARDINAL_DEGS.map((a) => (
              <line
                key={a}
                x1="0"
                y1="-21"
                x2="0"
                y2="-17.5"
                stroke="rgba(219, 227, 238, 0.7)"
                strokeWidth="1.2"
                transform={`rotate(${a})`}
              />
            ))}
            <polygon points="0,-11.5 3.8,0 -3.8,0" fill="#ff5a5f" />
            <polygon points="0,11.5 3.8,0 -3.8,0" fill="#e2e8f0" />
            <circle cx="0" cy="0" r="1.8" fill="#0a1018" stroke="#e2e8f0" strokeWidth="0.9" />
            <text
              x="0"
              y="-16.5"
              transform={`rotate(${rotDegExact.toFixed(2)}, 0, -16.5)`}
              fill="#ff5a5f"
              fontSize="8.5"
              fontWeight="700"
              textAnchor="middle"
              dominantBaseline="central"
            >
              N
            </text>
          </g>
        </svg>
      </button>
      <div className="g-compass-bar">
        <button
          type="button"
          className="g-compass-btn"
          aria-label={t("game.app.compass.rotateCcwTitle")}
          title={t("game.app.compass.rotateCcwTitle")}
          onClick={(e) => {
            onStepRot(e.shiftKey ? 15 : 45);
            e.currentTarget.blur();
          }}
        >
          ↺
        </button>
        <button
          type="button"
          className="g-compass-deg"
          title={t("game.app.compass.resetTitle")}
          onClick={(e) => {
            onToggleNorth();
            e.currentTarget.blur();
          }}
        >
          {degStr}°
        </button>
        <button
          type="button"
          className="g-compass-btn"
          aria-label={t("game.app.compass.rotateCwTitle")}
          title={t("game.app.compass.rotateCwTitle")}
          onClick={(e) => {
            onStepRot(e.shiftKey ? -15 : -45);
            e.currentTarget.blur();
          }}
        >
          ↻
        </button>
      </div>
    </div>
  );
}
