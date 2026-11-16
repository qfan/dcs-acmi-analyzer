/** Multiplayer: host or join a room, then the lobby (settings, seats, ready, start). */
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AI_SKILL_CHOICES } from "../ai/doctrine.ts";
import type {
  LobbyAction,
  LobbyPlayer,
  LobbySlot,
  LobbyState,
  NetStatus,
  SlotState,
} from "../engine/protocol.ts";
import {
  blockedAsMixedContent,
  isRelayUrl,
  type ProbeResult,
  type RelayInfo,
  relayLabel,
} from "../net/relays.ts";
import { SCENARIOS, scenarioById } from "../sim/scenarios.ts";
import { FightSettings } from "./StartDialog.tsx";

export const TURN_CHOICES = [0, 10, 20, 30] as const;

const CUSTOM = "__custom__";

function probeText(p: ProbeResult | undefined, t: TFunction): string {
  if (!p || p.state === "checking") return t("game.lobby.probeChecking");
  if (p.state === "ok") return t("game.lobby.probeOk", { ms: p.ms ?? "" });
  if (p.state === "busy") return t("game.lobby.probeBusy");
  if (p.state === "disabled") return t("game.lobby.probeDisabled");
  return t("game.lobby.probeUnreachable");
}

export interface ServerPickerProps {
  relays: readonly RelayInfo[];
  recent: readonly string[];
  /** Chosen relay address, or "" for Automatic. */
  selection: string;
  onSelection: (url: string) => void;
  onUseCustom: (url: string) => void;
  onForget: (url: string) => void;
  probes: ReadonlyMap<string, ProbeResult>;
  onRefresh: () => void;
  invite: { room: string; relayUrl: string | null } | null;
}

/** Which relay to use: Automatic, a built-in one, a recent custom one, or a new address. */
function ServerPicker({
  relays,
  recent,
  selection,
  onSelection,
  onUseCustom,
  onForget,
  probes,
  onRefresh,
  invite,
}: ServerPickerProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const isBuiltin = relays.some((r) => r.url === selection);
  const customs = recent.filter((u) => !relays.some((r) => r.url === u));
  const best = relays
    .filter((r) => probes.get(r.url)?.state === "ok")
    .sort((a, b) => (probes.get(a.url)?.ms ?? 1e9) - (probes.get(b.url)?.ms ?? 1e9))[0];
  const autoText = best
    ? t("game.lobby.autoBest", { label: best.label, ms: probes.get(best.url)?.ms ?? "" })
    : [...probes.values()].some((p) => p.state === "checking")
      ? t("game.lobby.autoChecking")
      : t("game.lobby.autoNone");
  const draftOk = isRelayUrl(draft);
  const warnMixed =
    (!!selection && blockedAsMixedContent(selection)) || (draftOk && blockedAsMixedContent(draft));

  return (
    <div className="g-server">
      <div className="g-row">
        <span className="g-label">{t("game.lobby.server")}</span>
        <select
          aria-label={t("game.lobby.relayServerAria")}
          value={editing ? CUSTOM : selection}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setEditing(true);
              setDraft("");
            } else {
              setEditing(false);
              onSelection(e.target.value);
            }
          }}
        >
          <option value="">{autoText}</option>
          {relays.map((r) => (
            <option key={r.url} value={r.url}>
              {r.label} ({probeText(probes.get(r.url), t)})
            </option>
          ))}
          {customs.length > 0 && (
            <optgroup label={t("game.lobby.recentGroup")}>
              {customs.map((u) => (
                <option key={u} value={u}>
                  {u} ({probeText(probes.get(u), t)})
                </option>
              ))}
            </optgroup>
          )}
          <option value={CUSTOM}>{t("game.lobby.customAddress")}</option>
        </select>
        <button type="button" onClick={onRefresh} title={t("game.lobby.refreshServersTitle")}>
          ↻
        </button>
        {selection && !isBuiltin && !editing && (
          <button
            type="button"
            onClick={() => onForget(selection)}
            title={t("game.lobby.forgetAddressTitle")}
          >
            {t("game.lobby.forgetBtn")}
          </button>
        )}
      </div>
      {editing && (
        <div className="g-row">
          <span className="g-label" />
          <input
            type="text"
            className="g-relay-url"
            placeholder="wss://my-relay.example/ws"
            aria-label={t("game.lobby.customRelayAria")}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draftOk) {
                setEditing(false);
                onUseCustom(draft);
              }
            }}
          />
          <button
            type="button"
            disabled={!draftOk}
            onClick={() => {
              setEditing(false);
              onUseCustom(draft);
            }}
          >
            {t("game.lobby.useBtn")}
          </button>
        </div>
      )}
      {editing && draft && !draftOk && <p className="g-error">{t("game.lobby.invalidWsUrl")}</p>}
      {warnMixed && <p className="g-error">{t("game.lobby.mixedContentError")}</p>}
      {invite?.relayUrl && (
        <p className="g-muted">
          {t("game.lobby.inviteRelayNote", {
            room: invite.room,
            relay: relayLabel(invite.relayUrl, relays),
          })}
        </p>
      )}
      <p className="g-muted g-small">{t("game.lobby.relayNote")}</p>
    </div>
  );
}

export function MultiplayerTab({
  name,
  onName,
  code,
  onCode,
  status,
  statusMessage,
  onHost,
  onJoin,
  server,
}: {
  name: string;
  onName: (s: string) => void;
  code: string;
  onCode: (s: string) => void;
  status: NetStatus;
  statusMessage: string | null;
  onHost: () => void;
  onJoin: () => void;
  server: ServerPickerProps;
}) {
  const { t } = useTranslation();
  const busy = status === "connecting";
  const codeOk = /^[A-Z2-9]{6}$/.test(code);
  return (
    <div className="g-mp">
      <div className="g-row">
        <span className="g-label">{t("game.lobby.yourName")}</span>
        <input
          type="text"
          className="g-name"
          maxLength={24}
          value={name}
          placeholder={t("game.lobby.callsignPlaceholder")}
          onChange={(e) => onName(e.target.value)}
        />
      </div>
      <div className="g-mp-choices">
        <section className="g-mp-choice">
          <h3>{t("game.lobby.hostTitle")}</h3>
          <p className="g-muted">{t("game.lobby.hostDesc")}</p>
          <button type="button" className="g-primary" disabled={busy || !name.trim()} onClick={onHost}>
            {t("game.lobby.hostBtn")}
          </button>
        </section>
        <section className="g-mp-choice">
          <h3>{t("game.lobby.joinTitle")}</h3>
          <p className="g-muted">{t("game.lobby.joinDesc")}</p>
          <div className="g-join">
            <input
              type="text"
              className="g-code-input"
              maxLength={6}
              value={code}
              placeholder={t("game.lobby.roomCodePlaceholder")}
              aria-label={t("game.lobby.roomCodeAria")}
              onChange={(e) => onCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && codeOk && name.trim()) onJoin();
              }}
            />
            <button
              type="button"
              className="g-primary"
              disabled={busy || !codeOk || !name.trim()}
              onClick={onJoin}
            >
              {t("game.lobby.joinBtn")}
            </button>
          </div>
        </section>
      </div>
      {busy && <p className="g-muted">{t("game.lobby.connecting")}</p>}
      {statusMessage && status !== "connecting" && <p className="g-error">{statusMessage}</p>}
      <ServerPicker {...server} />
    </div>
  );
}

function crewLabel(c: SlotState, t: TFunction): string {
  if (c === "open") return t("game.lobby.crewOpen");
  if (c === "closed") return t("game.lobby.crewClosed");
  if (c === "human") return t("game.lobby.crewHuman");
  return t("game.lobby.crewNpc", { skill: t(`game.skill.${c}`) });
}

export function LobbyPanel({
  lobby,
  you,
  status,
  onAction,
  onLeave,
  inviteUrl,
  serverName,
}: {
  lobby: LobbyState;
  you: number;
  status: NetStatus;
  onAction: (a: LobbyAction) => void;
  onLeave: () => void;
  inviteUrl: string;
  /** The relay this room lives on (codes only work there). */
  serverName: string;
}) {
  const { t } = useTranslation();
  const me = lobby.players.find((p) => p.id === you);
  const isHost = !!me?.host;
  const st = lobby.settings;
  const scenario = scenarioById(st.scenarioId);
  const mySlot = lobby.slots.find((s) => s.peer === you);
  const [copied, setCopied] = useState(false);
  const playerName = (id: number | null) => lobby.players.find((p) => p.id === id)?.name ?? "?";
  const set = (patch: Partial<LobbyState["settings"]>) => onAction({ a: "settings", patch });
  const waiting = lobby.players.filter(
    (p) => !p.host && lobby.slots.some((s) => s.peer === p.id) && !p.ready,
  );
  const spectators = lobby.players.filter((p) => !lobby.slots.some((s) => s.peer === p.id));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const slotRow = (sl: LobbySlot) => {
    const mine = sl.peer === you;
    const player = sl.crew === "human" ? lobby.players.find((p) => p.id === sl.peer) : undefined;
    return (
      <li key={sl.jetId} className={`g-slot ${mine ? "mine" : ""}`}>
        <span className="g-slot-call">{sl.callsign}</span>
        <span className="g-slot-who">
          {sl.crew === "human" ? (
            <>
              {playerName(sl.peer)}
              {mine && t("game.lobby.youTag")}
              {player?.host ? t("game.lobby.hostTag") : player?.ready ? " ✓" : t("game.lobby.notReadyTag")}
              {player?.away && t("game.lobby.reconnectingTag")}
            </>
          ) : isHost ? (
            <select
              value={sl.crew}
              aria-label={t("game.lobby.whoFliesAria", { callsign: sl.callsign })}
              onChange={(e) =>
                onAction({ a: "slot-crew", jetId: sl.jetId, crew: e.target.value as SlotState })
              }
            >
              {(["open", ...AI_SKILL_CHOICES, "closed"] as SlotState[]).map((c) => (
                <option key={c} value={c}>
                  {crewLabel(c, t)}
                </option>
              ))}
            </select>
          ) : (
            <span className="g-muted">{crewLabel(sl.crew, t)}</span>
          )}
        </span>
        {sl.crew === "open" && !mine && (
          <button type="button" onClick={() => onAction({ a: "take", jetId: sl.jetId })}>
            {t("game.lobby.takeBtn")}
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="g-lobby">
      <div className="g-room">
        <div>
          <span className="g-label">{t("game.lobby.roomCodeLabel")}</span>
          <b className="g-code">{lobby.room}</b>
        </div>
        <button type="button" onClick={copy} title={inviteUrl}>
          {copied ? t("game.lobby.copiedBtn") : t("game.lobby.copyInviteBtn")}
        </button>
        <span className={`g-net g-net-${status}`} title={t("game.lobby.relayTitle", { status })}>
          ● {status === "connected" ? t("game.lobby.connectedOn", { server: serverName }) : status}
        </span>
      </div>

      <div className="g-row">
        <span className="g-label">{t("game.lobby.scenarioLabel")}</span>
        {isHost ? (
          <select value={st.scenarioId} onChange={(e) => set({ scenarioId: e.target.value })}>
            {SCENARIOS.filter((s) => s.mp).map((s) => (
              <option key={s.id} value={s.id}>
                {t(`game.scenarios.${s.id}.title`, { defaultValue: s.title })}
              </option>
            ))}
          </select>
        ) : (
          <b>{t(`game.scenarios.${scenario.id}.title`, { defaultValue: scenario.title })}</b>
        )}
      </div>
      <p className="g-muted g-scn-summary">
        {t(`game.scenarios.${scenario.id}.summary`, { defaultValue: scenario.summary })}
      </p>

      <FightSettings
        altFt={st.altFt}
        onAlt={(a) => set({ altFt: a })}
        missiles={st.missiles}
        onMissiles={(n) => set({ missiles: n })}
        fog={st.fog}
        onFog={(on) => set({ fog: on })}
        fogLabels={[t("game.lobby.fogOffMp"), t("game.lobby.fogOnMp")]}
        disabled={!isHost}
      />
      <div className="g-row">
        <span className="g-label">{t("game.lobby.timeLabel")}</span>
        <div className="g-seg">
          {TURN_CHOICES.map((n) => (
            <button
              type="button"
              key={n}
              disabled={!isHost}
              className={st.turnEveryS === n ? "on" : ""}
              onClick={() => set({ turnEveryS: n })}
              title={n ? t("game.lobby.turnModeTitle") : t("game.lobby.realTimeTitle")}
            >
              {n === 0 ? t("game.lobby.realTime") : t("game.lobby.turnsOf", { s: n })}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">{t("game.lobby.compressionLabel")}</span>
        <label className="g-check">
          <input
            type="checkbox"
            disabled={!isHost}
            checked={st.timeCompression}
            onChange={(e) => set({ timeCompression: e.target.checked })}
          />{" "}
          {t("game.lobby.compressionCheck")}
        </label>
      </div>

      <div className="g-slots">
        {(["blue", "red"] as const).map((side) => (
          <section key={side} className={`g-slot-side g-slot-${side}`}>
            <h3>{side === "blue" ? t("game.lobby.blueSide") : t("game.lobby.redSide")}</h3>
            <ul>{lobby.slots.filter((s) => s.side === side).map(slotRow)}</ul>
          </section>
        ))}
      </div>
      {spectators.length > 0 && (
        <p className="g-muted">
          {t("game.lobby.watchingLabel")}{" "}
          {spectators
            .map((p: LobbyPlayer) => p.name + (p.id === you ? t("game.lobby.youTag") : ""))
            .join(", ")}
        </p>
      )}

      <div className="g-row g-end">
        <button type="button" onClick={onLeave}>
          {isHost ? t("game.lobby.closeRoomBtn") : t("game.lobby.leaveBtn")}
        </button>
        {mySlot && !isHost && (
          <button type="button" onClick={() => onAction({ a: "release" })}>
            {t("game.lobby.giveUpSeatBtn")}
          </button>
        )}
        {isHost ? (
          <>
            <button
              type="button"
              onClick={() => onAction({ a: "swap" })}
              title={t("game.lobby.swapSidesTitle")}
            >
              {t("game.lobby.swapSidesBtn")}
            </button>
            <button
              type="button"
              className="g-primary"
              disabled={waiting.length > 0}
              title={
                waiting.length
                  ? t("game.lobby.waitingFor", { names: waiting.map((p) => p.name).join(", ") })
                  : t("game.lobby.startFightTitle")
              }
              onClick={() => onAction({ a: "start" })}
            >
              {t("game.startDialog.startBtn")}
            </button>
          </>
        ) : (
          mySlot && (
            <button
              type="button"
              className={me?.ready ? "" : "g-primary"}
              onClick={() => onAction({ a: "ready", ready: !me?.ready })}
            >
              {me?.ready ? t("game.lobby.notReadyBtn") : t("game.lobby.readyBtn")}
            </button>
          )
        )}
      </div>
      {!isHost && <p className="g-muted">{t("game.lobby.guestHint")}</p>}
    </div>
  );
}
