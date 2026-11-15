/** Multiplayer: host or join a room, then the lobby (settings, seats, ready, start). */
import { useState } from "react";
import { AI_SKILL_CHOICES, skillChoiceLabel } from "../ai/doctrine.ts";
import type {
  LobbyAction,
  LobbyPlayer,
  LobbySlot,
  LobbyState,
  NetStatus,
  SlotState,
} from "../engine/protocol.ts";
import { SCENARIOS, scenarioById } from "../sim/scenarios.ts";
import { FightSettings } from "./StartDialog.tsx";

export const TURN_CHOICES = [0, 10, 20, 30] as const;

export function MultiplayerTab({
  name,
  onName,
  code,
  onCode,
  relayUrl,
  onRelayUrl,
  status,
  statusMessage,
  onHost,
  onJoin,
}: {
  name: string;
  onName: (s: string) => void;
  code: string;
  onCode: (s: string) => void;
  relayUrl: string;
  onRelayUrl: (s: string) => void;
  status: NetStatus;
  statusMessage: string | null;
  onHost: () => void;
  onJoin: () => void;
}) {
  const busy = status === "connecting";
  const codeOk = /^[A-Z2-9]{6}$/.test(code);
  return (
    <div className="g-mp">
      <div className="g-row">
        <span className="g-label">Your name</span>
        <input
          type="text"
          className="g-name"
          maxLength={24}
          value={name}
          placeholder="Callsign"
          onChange={(e) => onName(e.target.value)}
        />
      </div>
      <div className="g-mp-choices">
        <section className="g-mp-choice">
          <h3>Host a game</h3>
          <p className="g-muted">
            Open a room, share its code, pick the scenario and who flies each jet. Your browser runs the
            fight.
          </p>
          <button type="button" className="g-primary" disabled={busy || !name.trim()} onClick={onHost}>
            Host a game
          </button>
        </section>
        <section className="g-mp-choice">
          <h3>Join a game</h3>
          <p className="g-muted">Enter the code the host gave you, or open their invite link.</p>
          <div className="g-join">
            <input
              type="text"
              className="g-code-input"
              maxLength={6}
              value={code}
              placeholder="ROOM CODE"
              aria-label="Room code"
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
              Join
            </button>
          </div>
        </section>
      </div>
      {busy && <p className="g-muted">Connecting…</p>}
      {statusMessage && status !== "connecting" && <p className="g-error">{statusMessage}</p>}
      <details className="g-advanced">
        <summary>Advanced: relay server</summary>
        <p className="g-muted">
          The relay passes messages between players; it never sees anyone else's address. Change this only to
          use your own relay (LAN, Tailscale or a VM; see game/server in the source).
        </p>
        <input
          type="text"
          className="g-relay-url"
          value={relayUrl}
          spellCheck={false}
          onChange={(e) => onRelayUrl(e.target.value.trim())}
        />
      </details>
    </div>
  );
}

const crewLabel = (c: SlotState): string =>
  c === "open"
    ? "Open (NPC if empty)"
    : c === "closed"
      ? "Closed"
      : c === "human"
        ? "Player"
        : `NPC ${skillChoiceLabel(c)}`;

export function LobbyPanel({
  lobby,
  you,
  status,
  onAction,
  onLeave,
  inviteUrl,
}: {
  lobby: LobbyState;
  you: number;
  status: NetStatus;
  onAction: (a: LobbyAction) => void;
  onLeave: () => void;
  inviteUrl: string;
}) {
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
              {mine && " (you)"}
              {player?.host ? " · host" : player?.ready ? " ✓" : " · not ready"}
              {player?.away && " · reconnecting"}
            </>
          ) : isHost ? (
            <select
              value={sl.crew}
              aria-label={`Who flies ${sl.callsign}`}
              onChange={(e) =>
                onAction({ a: "slot-crew", jetId: sl.jetId, crew: e.target.value as SlotState })
              }
            >
              {(["open", ...AI_SKILL_CHOICES, "closed"] as SlotState[]).map((c) => (
                <option key={c} value={c}>
                  {crewLabel(c)}
                </option>
              ))}
            </select>
          ) : (
            <span className="g-muted">{crewLabel(sl.crew)}</span>
          )}
        </span>
        {sl.crew === "open" && !mine && (
          <button type="button" onClick={() => onAction({ a: "take", jetId: sl.jetId })}>
            Take
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="g-lobby">
      <div className="g-room">
        <div>
          <span className="g-label">Room code</span>
          <b className="g-code">{lobby.room}</b>
        </div>
        <button type="button" onClick={copy} title={inviteUrl}>
          {copied ? "Copied" : "Copy invite link"}
        </button>
        <span className={`g-net g-net-${status}`} title={`Relay: ${status}`}>
          ● {status === "connected" ? "connected" : status}
        </span>
      </div>

      <div className="g-row">
        <span className="g-label">Scenario</span>
        {isHost ? (
          <select value={st.scenarioId} onChange={(e) => set({ scenarioId: e.target.value })}>
            {SCENARIOS.filter((s) => s.mp).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        ) : (
          <b>{scenario.title}</b>
        )}
      </div>
      <p className="g-muted g-scn-summary">{scenario.summary}</p>

      <FightSettings
        altFt={st.altFt}
        onAlt={(a) => set({ altFt: a })}
        missiles={st.missiles}
        onMissiles={(n) => set({ missiles: n })}
        fog={st.fog}
        onFog={(on) => set({ fog: on })}
        fogLabels={["Off: each player chooses", "On for everyone"]}
        disabled={!isHost}
      />
      <div className="g-row">
        <span className="g-label">Time</span>
        <div className="g-seg">
          {TURN_CHOICES.map((n) => (
            <button
              type="button"
              key={n}
              disabled={!isHost}
              className={st.turnEveryS === n ? "on" : ""}
              onClick={() => set({ turnEveryS: n })}
              title={
                n
                  ? "The fight pauses every N seconds until everyone presses Play"
                  : "Real time; each player has 5 pauses"
              }
            >
              {n === 0 ? "Real time" : `Turns of ${n} s`}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span className="g-label">Compression</span>
        <label className="g-check">
          <input
            type="checkbox"
            disabled={!isHost}
            checked={st.timeCompression}
            onChange={(e) => set({ timeCompression: e.target.checked })}
          />{" "}
          Host may speed up time for everyone
        </label>
      </div>

      <div className="g-slots">
        {(["blue", "red"] as const).map((side) => (
          <section key={side} className={`g-slot-side g-slot-${side}`}>
            <h3>{side === "blue" ? "Blue" : "Red"}</h3>
            <ul>{lobby.slots.filter((s) => s.side === side).map(slotRow)}</ul>
          </section>
        ))}
      </div>
      {spectators.length > 0 && (
        <p className="g-muted">
          Watching (no jet):{" "}
          {spectators.map((p: LobbyPlayer) => p.name + (p.id === you ? " (you)" : "")).join(", ")}
        </p>
      )}

      <div className="g-row g-end">
        <button type="button" onClick={onLeave}>
          {isHost ? "Close room" : "Leave"}
        </button>
        {mySlot && !isHost && (
          <button type="button" onClick={() => onAction({ a: "release" })}>
            Give up seat
          </button>
        )}
        {isHost ? (
          <>
            <button type="button" onClick={() => onAction({ a: "swap" })} title="Swap blue and red seats">
              Swap sides
            </button>
            <button
              type="button"
              className="g-primary"
              disabled={waiting.length > 0}
              title={
                waiting.length ? `Waiting for ${waiting.map((p) => p.name).join(", ")}` : "Start the fight"
              }
              onClick={() => onAction({ a: "start" })}
            >
              Start
            </button>
          </>
        ) : (
          mySlot && (
            <button
              type="button"
              className={me?.ready ? "" : "g-primary"}
              onClick={() => onAction({ a: "ready", ready: !me?.ready })}
            >
              {me?.ready ? "Not ready" : "Ready"}
            </button>
          )
        )}
      </div>
      {!isHost && <p className="g-muted">The host picks the scenario and starts the fight.</p>}
    </div>
  );
}
