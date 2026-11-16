import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { en } from "./locales/en.ts";
import { fr } from "./locales/fr.ts";
import { zhCN } from "./locales/zh-CN.ts";
import type { LanguagePreference, LocaleCode } from "./types.ts";

export type { LanguagePreference, LocaleCode } from "./types.ts";

export const SUPPORTED_LANGUAGES: readonly LocaleCode[] = ["en", "fr", "zh-CN"];
export const LANGUAGE_STORAGE_KEY = "acmi-viewer.language";

/** Map browser/stored language tags (e.g. zh-Hans, zh, fr-CA, en-GB) to supported locales. */
export function normalizeLanguage(raw: string | null | undefined): LocaleCode {
  if (!raw) return "en";
  const lower = raw.trim().toLowerCase();
  if (
    lower === "zh" ||
    lower.startsWith("zh-cn") ||
    lower.startsWith("zh-sg") ||
    lower.startsWith("zh-hans")
  ) {
    return "zh-CN";
  }
  if (lower === "fr" || lower.startsWith("fr-")) return "fr";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  return "en";
}

export function isLocaleCode(v: unknown): v is LocaleCode {
  return typeof v === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(v);
}

/** Detect the best matching supported locale from the browser's language preferences. */
export function detectBrowserLanguage(): LocaleCode {
  if (typeof navigator === "undefined") return "en";
  const candidates =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const tag of candidates) {
    if (!tag) continue;
    const lower = tag.trim().toLowerCase();
    if (
      lower === "zh" ||
      lower.startsWith("zh-cn") ||
      lower.startsWith("zh-sg") ||
      lower.startsWith("zh-hans")
    ) {
      return "zh-CN";
    }
    if (lower === "fr" || lower.startsWith("fr-")) return "fr";
    if (lower === "en" || lower.startsWith("en-")) return "en";
  }
  return "en";
}

/** Read the user's stored language preference ("auto" if none or invalid). */
export function getLanguagePreference(): LanguagePreference {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(LANGUAGE_STORAGE_KEY) : null;
    if (isLocaleCode(stored)) return stored;
  } catch {
    // Storage unavailable (private mode / SSR / restricted environment).
  }
  return "auto";
}

/** Persist a language preference ("auto" clears override and uses browser detection) and apply it. */
export function setLanguagePreference(pref: LanguagePreference): LocaleCode {
  try {
    if (typeof localStorage !== "undefined") {
      if (pref === "auto") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      else localStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
    }
  } catch {
    // Ignore storage errors; still switch language for this session.
  }
  const target = pref === "auto" ? detectBrowserLanguage() : pref;
  void i18n.changeLanguage(target);
  syncDocumentLanguage(target);
  return target;
}

export function syncDocumentLanguage(lng: string = i18n.resolvedLanguage ?? i18n.language ?? "en"): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = normalizeLanguage(lng);
  }
}

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        fr: { translation: fr },
        "zh-CN": { translation: zhCN },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      fallbackLng: "en",
      interpolation: {
        escapeValue: false,
      },
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: [],
        convertDetectedLanguage: (lng: string) => normalizeLanguage(lng),
      },
      react: {
        useSuspense: false,
      },
    });
  syncDocumentLanguage();
  i18n.on("languageChanged", (lng) => syncDocumentLanguage(lng));
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== LANGUAGE_STORAGE_KEY) return;
    const pref = getLanguagePreference();
    const target = pref === "auto" ? detectBrowserLanguage() : pref;
    if (i18n.resolvedLanguage !== target) {
      void i18n.changeLanguage(target);
      syncDocumentLanguage(target);
    }
  });
}

export default i18n;
