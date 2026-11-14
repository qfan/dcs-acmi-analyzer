import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Pin viewer panels to a rail left or right of the map, using the empty space on wide screens.
 *
 * A pinned panel is portalled into its rail, so it stays where it is in the React tree: state shared
 * with its neighbours (the analysis filter, the map focus) keeps working wherever it is shown. Pins
 * are remembered per browser; below RAILS_MIN_WIDTH_PX the rails don't fit, so panels stay in the
 * main column (pins are kept for the next wide window).
 */

export type PinSide = "left" | "right";

/** Narrowest window with room for a rail beside the map column. */
export const RAILS_MIN_WIDTH_PX = 1400;

const PINS_KEY = "acmi-viewer.pinned-panels";

/** Panels in page order: the order they stack in a rail. */
export const PANEL_ORDER = [
  "filters",
  "kills",
  "pilots",
  "shots",
  "analytics",
  "aircraft",
  "weapons",
  "events",
  "recording",
  "types",
  "warnings",
] as const;

export type PanelId = (typeof PANEL_ORDER)[number];

type Pins = Partial<Record<PanelId, PinSide>>;

export function parsePins(raw: string | null): Pins {
  if (!raw) return {};
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: Pins = {};
    for (const id of PANEL_ORDER) {
      const v = (obj as Record<string, unknown>)[id];
      if (v === "left" || v === "right") out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function loadPins(): Pins {
  try {
    return parsePins(localStorage.getItem(PINS_KEY));
  } catch {
    return {};
  }
}

function savePins(pins: Pins): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // Storage blocked: pins last for this page only.
  }
}

function useWideEnough(): boolean {
  const query = `(min-width: ${RAILS_MIN_WIDTH_PX}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return wide;
}

interface PinState {
  pins: Pins;
  setPin: (id: PanelId, side: PinSide | null) => void;
  /** Rails fit in this window. */
  railsOn: boolean;
  rails: Record<PinSide, HTMLElement | null>;
}

const PinContext = createContext<PinState | null>(null);

/**
 * The viewer's three-column layout: left rail, the main column, right rail. Rails take no space
 * until something is pinned to them.
 */
export function PinLayout({ children }: { children: ReactNode }) {
  const [pins, setPins] = useState<Pins>(loadPins);
  const wide = useWideEnough();
  const [left, setLeft] = useState<HTMLElement | null>(null);
  const [right, setRight] = useState<HTMLElement | null>(null);

  const setPin = useCallback((id: PanelId, side: PinSide | null) => {
    setPins((prev) => {
      const next = { ...prev };
      if (side) next[id] = side;
      else delete next[id];
      savePins(next);
      return next;
    });
  }, []);

  const hasLeft = wide && Object.values(pins).includes("left");
  const hasRight = wide && Object.values(pins).includes("right");
  const cls = ["pin-layout", hasLeft ? "has-left" : "", hasRight ? "has-right" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <PinContext.Provider value={{ pins, setPin, railsOn: wide, rails: { left, right } }}>
      <div className={cls}>
        <aside ref={setLeft} className="pin-rail pin-rail-left" aria-label="Panels pinned left" />
        <div className="pin-main">{children}</div>
        <aside ref={setRight} className="pin-rail pin-rail-right" aria-label="Panels pinned right" />
      </div>
    </PinContext.Provider>
  );
}

/**
 * Wrap one panel (usually a `.card`) to give it pin buttons. Outside a PinLayout it renders the
 * panel unchanged.
 */
export function Pinnable({ id, title, children }: { id: PanelId; title: string; children: ReactNode }) {
  const ctx = useContext(PinContext);
  if (!ctx) return <>{children}</>;
  const side = ctx.pins[id] ?? null;
  const rail = side && ctx.railsOn ? ctx.rails[side] : null;

  const button = (to: PinSide) => {
    const active = side === to;
    const label = to === "left" ? "◧ Left" : "Right ◨";
    const tip = !ctx.railsOn
      ? `Pinning needs a window at least ${RAILS_MIN_WIDTH_PX} px wide`
      : active
        ? `Unpin "${title}" back into the main column`
        : `Pin "${title}" to the ${to} of the map`;
    return (
      <button
        type="button"
        className={`pin-btn${active ? " on" : ""}`}
        aria-pressed={active}
        title={tip}
        disabled={!ctx.railsOn}
        onClick={() => ctx.setPin(id, active ? null : to)}
      >
        {active ? `✕ ${to === "left" ? "Left" : "Right"}` : label}
      </button>
    );
  };

  const frame = (
    <div
      className="pinnable"
      // In a rail, keep page order however the panels were pinned.
      style={rail ? { order: PANEL_ORDER.indexOf(id) } : undefined}
      data-pinned={rail ? side : undefined}
    >
      <fieldset className="pin-bar" aria-label={`Pin ${title}`}>
        {button("left")}
        {button("right")}
      </fieldset>
      {children}
    </div>
  );

  return rail ? createPortal(frame, rail) : frame;
}
