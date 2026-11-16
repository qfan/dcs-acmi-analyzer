import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getLanguagePreference,
  LANGUAGE_STORAGE_KEY,
  type LanguagePreference,
  SUPPORTED_LANGUAGES,
  setLanguagePreference,
} from "./index.ts";

export function LanguageSelector({
  id,
  className,
  ariaLabel,
}: {
  id?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const { t, i18n } = useTranslation();
  const [pref, setPref] = useState<LanguagePreference>(getLanguagePreference);

  // Keep local state in sync if language preference is changed from another selector or tab.
  useEffect(() => {
    const sync = () => setPref(getLanguagePreference());
    i18n.on("languageChanged", sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key === LANGUAGE_STORAGE_KEY) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      i18n.off("languageChanged", sync);
      window.removeEventListener("storage", onStorage);
    };
  }, [i18n]);

  return (
    <select
      id={id}
      className={className}
      aria-label={ariaLabel ?? t("language.label")}
      value={pref}
      onChange={(e) => {
        const next = e.target.value as LanguagePreference;
        setPref(next);
        setLanguagePreference(next);
      }}
    >
      <option value="auto">{t("language.auto")}</option>
      {SUPPORTED_LANGUAGES.map((code) => (
        <option key={code} value={code}>
          {t(`language.${code}`)}
        </option>
      ))}
    </select>
  );
}
