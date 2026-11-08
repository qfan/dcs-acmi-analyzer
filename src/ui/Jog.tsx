import { useRef } from "react";
import { fmtRate, JOG_LATCH_PX, JOG_TRAVEL_PX, type JogState, jogRate, wouldLatch } from "./jog.ts";

/** Knob travel inside the pad (px each side of centre), and how far it shows a vertical drag. */
const KNOB_X = 52;
const KNOB_Y = 7;
/** Keyboard step (px of travel) for the arrow keys. */
const KEY_STEP = JOG_TRAVEL_PX / 12;

/**
 * Spring-loaded jog pad (see jog.ts): drag left or right to play backwards or forwards, further for
 * faster; release to stop, or drag up or down before releasing to latch that rate. Pressing a latched
 * pad picks the knob up where it is (to adjust the rate); a click without dragging stops it.
 * Arrow keys nudge a latched rate; Escape or 0 stops.
 */
export function Jog({ value, onChange }: { value: JogState | null; onChange: (s: JogState | null) => void }) {
  const drag = useRef<{ x: number; y: number; base: number; id: number } | null>(null);
  // The latest state, so a release right after a fast move doesn't read a stale render.
  const last = useRef(value);
  last.current = value;
  const set = (s: JogState | null) => {
    last.current = s;
    onChange(s);
  };
  const rate = value ? jogRate(value.dx) : 0;
  const latching = value ? wouldLatch(value) : false;
  const latched = value !== null && !value.holding;

  const release = () => {
    const d = drag.current;
    const v = last.current;
    drag.current = null;
    if (!d || !v) return;
    set(wouldLatch(v) ? { dx: v.dx, dy: 0, holding: false } : null);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const base = value && !value.holding ? value.dx : 0;
    drag.current = { x: e.clientX, y: e.clientY, base, id: e.pointerId };
    set({ dx: base, dy: 0, holding: true });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = Math.max(-JOG_TRAVEL_PX, Math.min(JOG_TRAVEL_PX, d.base + e.clientX - d.x));
    set({ dx, dy: e.clientY - d.y, holding: true });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (step) {
      e.preventDefault();
      const dx = Math.max(-JOG_TRAVEL_PX, Math.min(JOG_TRAVEL_PX, (value?.dx ?? 0) + step));
      set(jogRate(dx) !== 0 ? { dx, dy: 0, holding: false } : null);
    } else if (e.key === "Escape" || e.key === "0") {
      e.preventDefault();
      set(null);
    }
  };

  const kx = ((value?.dx ?? 0) / JOG_TRAVEL_PX) * KNOB_X;
  const ky = value?.holding ? Math.max(-1, Math.min(1, value.dy / JOG_LATCH_PX)) * KNOB_Y : 0;
  const label = rate === 0 ? "stopped" : `${rate < 0 ? "backwards" : "forwards"} ${fmtRate(rate)}`;
  return (
    <div className="jog">
      <div
        className={`jog-pad${value?.holding ? " active" : ""}${latching ? " latching" : ""}${latched ? " latched" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Jog: drag left or right to play backwards or forwards, further for faster. Release to stop, or drag up or down before releasing to keep that speed."
        title={
          "Jog: drag left/right to play back/forward, further = faster (slow motion to 20×).\n" +
          "Release to stop, or drag up or down before releasing to keep that speed.\n" +
          "Click the jog again to stop."
        }
        aria-valuemin={-20}
        aria-valuemax={20}
        aria-valuenow={Math.round(rate * 100) / 100}
        aria-valuetext={latched ? `${label}, latched` : label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={() => {
          drag.current = null;
          set(null);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="jog-end" aria-hidden="true">
          ◀◀
        </span>
        <span className="jog-centre" aria-hidden="true" />
        <span className="jog-end" aria-hidden="true">
          ▶▶
        </span>
        <span className="jog-knob" aria-hidden="true" style={{ transform: `translate(${kx}px, ${ky}px)` }} />
      </div>
      <span className={`jog-readout${rate === 0 ? " muted" : ""}`} aria-hidden="true">
        {rate === 0 ? "jog" : `${rate < 0 ? "◀" : "▶"} ${fmtRate(rate)}`}
        {latched ? (
          <span className="jog-tag">latched</span>
        ) : latching ? (
          <span className="jog-tag">keep</span>
        ) : null}
      </span>
    </div>
  );
}
