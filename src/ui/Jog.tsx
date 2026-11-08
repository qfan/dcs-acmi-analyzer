import { useRef } from "react";
import {
  fmtRate,
  JOG_LATCH_PX,
  JOG_TRAVEL_PX,
  type JogState,
  jogOffset,
  jogRate,
  playRateOf,
  wouldLatch,
} from "./jog.ts";

/** Knob travel inside the pad (px each side of centre), and how far it shows a vertical drag. */
const KNOB_X = 52;
const KNOB_Y = 7;
/** Keyboard step (px of travel) for the arrow keys. */
const KEY_STEP = JOG_TRAVEL_PX / 12;

interface Props {
  /** The press in progress, or null. */
  hold: JogState | null;
  /** The play button's stored speed (0 = not set: real time). */
  speed: number;
  playing: boolean;
  onHold: (s: JogState | null) => void;
  /** Released in the latch zone: play on at this rate, and make it the play button's speed. */
  onLatch: (rate: number) => void;
  /** Set the play button's speed without playing (keyboard; 0 = not set). */
  onSpeed: (rate: number) => void;
}

/**
 * Spring-loaded jog pad (see jog.ts): drag left or right to play backwards or forwards, further for
 * faster; release to stop, or drag up or down before releasing to keep playing at that speed, which
 * also becomes the play button's speed. At rest the knob shows that speed (centred when it's not set,
 * i.e. real time). Pressing while playing picks the knob up where it is, to adjust; a click without
 * dragging stops. Double-click clears the speed back to real time. Arrow keys nudge it, Escape clears it.
 */
export function Jog({ hold, speed, playing, onHold, onLatch, onSpeed }: Props) {
  const drag = useRef<{ x: number; y: number; base: number; id: number } | null>(null);
  // The latest press state, so a release right after a fast move doesn't read a stale render.
  const last = useRef(hold);
  last.current = hold;
  const set = (s: JogState | null) => {
    last.current = s;
    onHold(s);
  };
  const playRate = playRateOf(speed);
  const rate = hold ? jogRate(hold.dx) : playing ? playRate : 0;
  const latching = hold ? wouldLatch(hold) : false;
  // Where the knob rests: the speed it will play at (centre for "not set" while paused).
  const restDx = playing ? jogOffset(playRate) : jogOffset(speed);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    // While playing, pick the knob up where it is (to adjust the speed); otherwise start from the centre.
    const base = playing ? jogOffset(playRate) : 0;
    drag.current = { x: e.clientX, y: e.clientY, base, id: e.pointerId };
    set({ dx: base, dy: 0 });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = Math.max(-JOG_TRAVEL_PX, Math.min(JOG_TRAVEL_PX, d.base + e.clientX - d.x));
    set({ dx, dy: e.clientY - d.y });
  };
  const onPointerUp = () => {
    const d = drag.current;
    const h = last.current;
    drag.current = null;
    if (!d || !h) return;
    last.current = null;
    if (wouldLatch(h)) onLatch(jogRate(h.dx));
    else onHold(null);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
    if (step) {
      e.preventDefault();
      const dx = Math.max(-JOG_TRAVEL_PX, Math.min(JOG_TRAVEL_PX, jogOffset(speed) + step));
      onSpeed(jogRate(dx));
    } else if (e.key === "Escape" || e.key === "0") {
      e.preventDefault();
      onSpeed(0);
    }
  };

  const kx = ((hold ? hold.dx : restDx) / JOG_TRAVEL_PX) * KNOB_X;
  const ky = hold ? Math.max(-1, Math.min(1, hold.dy / JOG_LATCH_PX)) * KNOB_Y : 0;
  const speedText = `${playRate < 0 ? "◀" : "▶"} ${fmtRate(playRate)}`;
  const cls = [
    "jog-pad",
    hold ? "active" : "",
    latching ? "latching" : "",
    !hold && playing ? "playing" : "",
    !hold && !playing && speed !== 0 ? "set" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="jog">
      <div
        className={cls}
        role="slider"
        tabIndex={0}
        aria-label="Jog: drag left or right to play backwards or forwards, further for faster. Release to stop, or drag up or down before releasing to keep that speed. Double-click to reset to real time."
        title={
          "Jog: drag left/right to play back/forward, further = faster (slow motion to 20×).\n" +
          "Release to stop, or drag up or down before releasing to keep that speed;\n" +
          "it also becomes the play button's speed. Click to stop, double-click to reset to real time."
        }
        aria-valuemin={-20}
        aria-valuemax={20}
        aria-valuenow={Math.round(rate * 100) / 100}
        aria-valuetext={
          rate === 0
            ? `stopped, plays at ${speedText}`
            : `${fmtRate(rate)} ${rate < 0 ? "backwards" : "forwards"}`
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          set(null);
        }}
        onDoubleClick={() => onSpeed(0)}
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
      {/* The speed, which also resets it to real time (like double-clicking the pad). */}
      <button
        type="button"
        className={`jog-readout${hold || playing ? "" : " muted"}`}
        title="Reset to real time (1× forward)"
        aria-label={`Play speed ${speedText}. Reset to real time`}
        onClick={() => onSpeed(0)}
      >
        {hold ? (rate === 0 ? "jog" : `${rate < 0 ? "◀" : "▶"} ${fmtRate(rate)}`) : speedText}
        {latching ? <span className="jog-tag">keep</span> : null}
      </button>
    </div>
  );
}
