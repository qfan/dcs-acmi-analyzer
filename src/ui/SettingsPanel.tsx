import { useRef, useState } from "react";
import { settingsStore, useSettings } from "../settings/react.ts";
import {
  ALTITUDE_UNITS,
  type AltitudeUnit,
  applyPartial,
  BUILT_IN_PROFILES,
  DISTANCE_UNITS,
  type DistanceUnit,
  type Profile,
  type Settings,
  SPEED_UNITS,
  type SpeedUnit,
  TRAIL_CHOICES,
} from "../settings/schema.ts";
import { exportJson, importJson } from "../settings/store.ts";
import { playRateOf, speedChoices } from "./jog.ts";

const ALT_LABEL: Record<AltitudeUnit, string> = {
  ft: "Feet",
  m: "Metres",
  "ft+m": "Feet, with metres",
  "m+ft": "Metres, with feet",
};
const SPEED_LABEL: Record<SpeedUnit, string> = {
  kt: "Knots",
  kmh: "km/h",
  "kt+kmh": "Knots, with km/h",
  "kmh+kt": "km/h, with knots",
};
const DIST_LABEL: Record<DistanceUnit, string> = {
  nm: "Nautical miles",
  km: "Kilometres",
  "nm+km": "Nautical miles, with km",
  "km+nm": "Kilometres, with nautical miles",
};
const TRAIL_LABEL: Record<number, string> = { 0: "None", 15: "15 s", 60: "1 min", 300: "5 min" };

/** True when applying the profile would change nothing: it's the one in use. */
function matches(p: Profile, s: Settings): boolean {
  return JSON.stringify(applyPartial(s, p.settings)) === JSON.stringify(s);
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings: s, profiles } = useSettings();
  const update = settingsStore.update;
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const r = settingsStore.saveProfile(name);
    if (r.ok) {
      setMessage({ text: `Saved “${name.trim()}”.` });
      setName("");
    } else setMessage({ text: r.error ?? "Could not save.", error: true });
  };

  const doExport = () => {
    const url = URL.createObjectURL(
      new Blob([exportJson(settingsStore.get())], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "acmi-viewer-settings.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doImport = async (file: File) => {
    const r = importJson(await file.text());
    if (!r.ok) {
      setMessage({ text: r.error, error: true });
      return;
    }
    // Keep existing profiles that the file doesn't replace.
    const names = new Set(r.state.profiles.map((p) => p.name));
    const kept = settingsStore.get().profiles.filter((p) => !names.has(p.name));
    settingsStore.replace({ settings: r.state.settings, profiles: [...kept, ...r.state.profiles] });
    setMessage({ text: `Imported settings and ${r.state.profiles.length} profile(s).` });
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>View settings</h2>
        <button type="button" className="link close-x" aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </div>

      <section>
        <h3>Profiles</h3>
        <p className="muted small">
          Quick presets. Built-in ones change units only; your own save everything.
        </p>
        <div className="profile-list">
          {BUILT_IN_PROFILES.map((p) => (
            <button
              key={p.name}
              type="button"
              className={`secondary${matches(p, s) ? " on" : ""}`}
              title={p.description}
              aria-pressed={matches(p, s)}
              onClick={() => settingsStore.applyProfile(p)}
            >
              {p.name}
            </button>
          ))}
        </div>
        {profiles.length > 0 && (
          <ul className="my-profiles">
            {profiles.map((p) => (
              <li key={p.name}>
                <button
                  type="button"
                  className={`secondary${matches(p, s) ? " on" : ""}`}
                  aria-pressed={matches(p, s)}
                  onClick={() => settingsStore.applyProfile(p)}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  className="link muted small"
                  aria-label={`Delete profile ${p.name}`}
                  onClick={() => settingsStore.deleteProfile(p.name)}
                >
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="save-profile"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            type="text"
            placeholder="Name, e.g. MiG-29 sorties"
            maxLength={60}
            value={name}
            aria-label="Profile name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="secondary">
            Save current as profile
          </button>
        </form>
      </section>

      <section>
        <h3>Units</h3>
        <div className="settings-grid">
          <label>
            Altitude
            <select
              value={s.units.altitude}
              onChange={(e) => update({ units: { altitude: e.target.value as AltitudeUnit } })}
            >
              {ALTITUDE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {ALT_LABEL[u]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speed
            <select
              value={s.units.speed}
              onChange={(e) => update({ units: { speed: e.target.value as SpeedUnit } })}
            >
              {SPEED_UNITS.map((u) => (
                <option key={u} value={u}>
                  {SPEED_LABEL[u]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Distance and map grid
            <select
              value={s.units.distance}
              onChange={(e) => update({ units: { distance: e.target.value as DistanceUnit } })}
            >
              {DISTANCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {DIST_LABEL[u]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">
          Vertical speed and miss distances follow the altitude unit (ft/min, or m/s).
        </p>
      </section>

      <section>
        <h3>Map labels</h3>
        <div className="checks">
          <Check label="Show labels" value={s.labels.show} set={(v) => update({ labels: { show: v } })} />
          <Check label="Pilot" value={s.labels.pilot} set={(v) => update({ labels: { pilot: v } })} />
          <Check
            label="Aircraft type"
            value={s.labels.aircraft}
            set={(v) => update({ labels: { aircraft: v } })}
          />
          <Check
            label="Altitude"
            value={s.labels.altitude}
            set={(v) => update({ labels: { altitude: v } })}
          />
          <Check label="Speed" value={s.labels.speed} set={(v) => update({ labels: { speed: v } })} />
        </div>
      </section>

      <section>
        <h3>Map</h3>
        <div className="settings-grid">
          <label>
            View
            <select
              value={s.map.mode}
              onChange={(e) => update({ map: { mode: e.target.value as Settings["map"]["mode"] } })}
            >
              <option value="2d">2D (any device)</option>
              <option value="3d">3D (needs WebGL 2)</option>
            </select>
          </label>
          <label>
            Trails
            <select
              value={s.map.trailS}
              onChange={(e) => update({ map: { trailS: Number(e.target.value) } })}
            >
              {TRAIL_CHOICES.map((t) => (
                <option key={t} value={t}>
                  {TRAIL_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Playback speed
            <select
              value={playRateOf(s.map.playbackSpeed)}
              onChange={(e) => update({ map: { playbackSpeed: Number(e.target.value) } })}
            >
              {speedChoices(s.map.playbackSpeed).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="checks">
          <Check
            label="Ground and sea units"
            value={s.map.groundUnits}
            set={(v) => update({ map: { groundUnits: v } })}
          />
        </div>
      </section>

      <section>
        <h3>Times</h3>
        <div className="settings-grid">
          <label>
            Show times as
            <select
              value={s.time.clock}
              onChange={(e) => update({ time: { clock: e.target.value as Settings["time"]["clock"] } })}
            >
              <option value="elapsed">Time since start</option>
              <option value="timeOfDay">Mission time of day (UTC)</option>
            </select>
          </label>
        </div>
      </section>

      {message && <p className={message.error ? "notice" : "muted small"}>{message.text}</p>}

      <div className="settings-foot">
        <button type="button" className="secondary" onClick={doExport}>
          Export settings…
        </button>
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>
          Import settings…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImport(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            settingsStore.reset();
            setMessage({ text: "Settings reset to defaults. Your profiles are kept." });
          }}
        >
          Reset to defaults
        </button>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="muted small">
        Saved in this browser only. Use Export/Import to take them to another browser.
      </p>
    </div>
  );
}

function Check({ label, value, set }: { label: string; value: boolean; set: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
}
