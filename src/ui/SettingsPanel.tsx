import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSelector } from "../i18n/LanguageSelector.tsx";
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

/** True when applying the profile would change nothing: it's the one in use. */
function matches(p: Profile, s: Settings): boolean {
  return JSON.stringify(applyPartial(s, p.settings)) === JSON.stringify(s);
}

type BuiltInProfileKey = "NATO / Western" | "Russian / Eastern" | "Mixed (both units)";

function isBuiltInKey(name: string): name is BuiltInProfileKey {
  return name === "NATO / Western" || name === "Russian / Eastern" || name === "Mixed (both units)";
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { settings: s, profiles } = useSettings();
  const update = settingsStore.update;
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const r = settingsStore.saveProfile(name);
    if (r.ok) {
      setMessage({ text: t("settings.savedProfileMsg", { name: name.trim() }) });
      setName("");
    } else {
      const text = r.errorCode
        ? t(`settings.errors.${r.errorCode}`)
        : (r.error ?? t("settings.couldNotSave"));
      setMessage({ text, error: true });
    }
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
      setMessage({ text: t(`settings.errors.${r.errorCode}`), error: true });
      return;
    }
    // Keep existing profiles that the file doesn't replace.
    const names = new Set(r.state.profiles.map((p) => p.name));
    const kept = settingsStore.get().profiles.filter((p) => !names.has(p.name));
    settingsStore.replace({ settings: r.state.settings, profiles: [...kept, ...r.state.profiles] });
    setMessage({ text: t("settings.importedMsg", { count: r.state.profiles.length }) });
  };

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>{t("settings.title")}</h2>
        <button type="button" className="link close-x" aria-label={t("settings.closeAria")} onClick={onClose}>
          ×
        </button>
      </div>

      <section>
        <h3>{t("settings.languageSection")}</h3>
        <div className="settings-grid">
          <label htmlFor="settings-language-select">
            {t("language.label")}
            <LanguageSelector id="settings-language-select" />
          </label>
        </div>
        <p className="muted small">{t("language.hint")}</p>
      </section>

      <section>
        <h3>{t("settings.profilesSection")}</h3>
        <p className="muted small">{t("settings.profilesHelp")}</p>
        <div className="profile-list">
          {BUILT_IN_PROFILES.map((p) => {
            const label = isBuiltInKey(p.name) ? t(`settings.builtInProfiles.${p.name}.name`) : p.name;
            const desc = isBuiltInKey(p.name)
              ? t(`settings.builtInProfiles.${p.name}.description`)
              : p.description;
            return (
              <button
                key={p.name}
                type="button"
                className={`secondary${matches(p, s) ? " on" : ""}`}
                title={desc}
                aria-pressed={matches(p, s)}
                onClick={() => settingsStore.applyProfile(p)}
              >
                {label}
              </button>
            );
          })}
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
                  aria-label={t("settings.deleteProfileAria", { name: p.name })}
                  onClick={() => settingsStore.deleteProfile(p.name)}
                >
                  {t("settings.deleteProfile")}
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
            placeholder={t("settings.profilePlaceholder")}
            maxLength={60}
            value={name}
            aria-label={t("settings.profileNameAria")}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="secondary">
            {t("settings.saveProfileBtn")}
          </button>
        </form>
      </section>

      <section>
        <h3>{t("settings.unitsSection")}</h3>
        <div className="settings-grid">
          <label>
            {t("settings.altitude")}
            <select
              value={s.units.altitude}
              onChange={(e) => update({ units: { altitude: e.target.value as AltitudeUnit } })}
            >
              {ALTITUDE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`settings.altUnit.${u}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("settings.speed")}
            <select
              value={s.units.speed}
              onChange={(e) => update({ units: { speed: e.target.value as SpeedUnit } })}
            >
              {SPEED_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`settings.speedUnit.${u}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("settings.distanceAndGrid")}
            <select
              value={s.units.distance}
              onChange={(e) => update({ units: { distance: e.target.value as DistanceUnit } })}
            >
              {DISTANCE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`settings.distUnit.${u}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted small">{t("settings.unitsHelp")}</p>
      </section>

      <section>
        <h3>{t("settings.mapLabelsSection")}</h3>
        <div className="checks">
          <Check
            label={t("settings.showLabels")}
            value={s.labels.show}
            set={(v) => update({ labels: { show: v } })}
          />
          <Check
            label={t("settings.pilot")}
            value={s.labels.pilot}
            set={(v) => update({ labels: { pilot: v } })}
          />
          <Check
            label={t("settings.aircraftType")}
            value={s.labels.aircraft}
            set={(v) => update({ labels: { aircraft: v } })}
          />
          <Check
            label={t("settings.altitude")}
            value={s.labels.altitude}
            set={(v) => update({ labels: { altitude: v } })}
          />
          <Check
            label={t("settings.speed")}
            value={s.labels.speed}
            set={(v) => update({ labels: { speed: v } })}
          />
        </div>
      </section>

      <section>
        <h3>{t("settings.mapSection")}</h3>
        <div className="settings-grid">
          <label>
            {t("settings.view")}
            <select
              value={s.map.mode}
              onChange={(e) => update({ map: { mode: e.target.value as Settings["map"]["mode"] } })}
            >
              <option value="2d">{t("settings.view2d")}</option>
              <option value="3d">{t("settings.view3d")}</option>
            </select>
          </label>
          <label>
            {t("settings.trails")}
            <select
              value={s.map.trailS}
              onChange={(e) => update({ map: { trailS: Number(e.target.value) } })}
            >
              {TRAIL_CHOICES.map((tr) => (
                <option key={tr} value={tr}>
                  {t(`settings.trail.${tr}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("settings.playbackSpeed")}
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
            label={t("settings.groundAndSea")}
            value={s.map.groundUnits}
            set={(v) => update({ map: { groundUnits: v } })}
          />
        </div>
      </section>

      <section>
        <h3>{t("settings.timesSection")}</h3>
        <div className="settings-grid">
          <label>
            {t("settings.showTimesAs")}
            <select
              value={s.time.clock}
              onChange={(e) => update({ time: { clock: e.target.value as Settings["time"]["clock"] } })}
            >
              <option value="elapsed">{t("settings.timeElapsed")}</option>
              <option value="timeOfDay">{t("settings.timeOfDay")}</option>
            </select>
          </label>
        </div>
      </section>

      {message && <p className={message.error ? "notice" : "muted small"}>{message.text}</p>}

      <div className="settings-foot">
        <button type="button" className="secondary" onClick={doExport}>
          {t("settings.exportBtn")}
        </button>
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()}>
          {t("settings.importBtn")}
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
            setMessage({ text: t("settings.resetMsg") });
          }}
        >
          {t("settings.resetBtn")}
        </button>
        <button type="button" onClick={onClose}>
          {t("common.done")}
        </button>
      </div>
      <p className="muted small">{t("settings.browserOnlyNote")}</p>
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
