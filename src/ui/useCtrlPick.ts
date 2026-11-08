import { type RefObject, useEffect, useRef } from "react";
import { pick, type ScreenHit } from "../map/render.ts";
import type { PickRole } from "./viewTypes.ts";

/**
 * Ctrl+left click = pick primary, Ctrl+right click = pick secondary (Cmd works as Ctrl on a Mac).
 *
 * Listens in the capture phase on the map's wrapper, so the click is handled before the canvas's own
 * handlers (the 3D orbit controls would otherwise start a pan on right-drag), and suppresses the
 * browser's context menu for Ctrl+right.
 */
export function useCtrlPick(
  wrapRef: RefObject<HTMLElement | null>,
  hitsRef: RefObject<ScreenHit[]>,
  onPick: (uid: number | null, role: PickRole, explicit: boolean) => void,
) {
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const isCtrl = (e: MouseEvent) => e.ctrlKey || e.metaKey;
    const onDown = (e: PointerEvent) => {
      if (!isCtrl(e) || (e.button !== 0 && e.button !== 2)) return;
      const canvas = (e.target as Element | null)?.closest("canvas");
      if (!canvas) return; // only clicks on the map itself, not its buttons or panels
      e.preventDefault();
      e.stopPropagation();
      const r = canvas.getBoundingClientRect();
      const uid = pick(hitsRef.current ?? [], e.clientX - r.left, e.clientY - r.top, 14);
      onPickRef.current(uid, e.button === 2 ? "secondary" : "primary", true);
    };
    const onMenu = (e: MouseEvent) => {
      if (isCtrl(e) && (e.target as Element | null)?.closest("canvas")) e.preventDefault();
    };
    el.addEventListener("pointerdown", onDown, { capture: true });
    el.addEventListener("contextmenu", onMenu, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      el.removeEventListener("contextmenu", onMenu, { capture: true });
    };
  }, [wrapRef, hitsRef]);
}
