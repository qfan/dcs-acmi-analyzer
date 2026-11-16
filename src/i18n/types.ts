import type { en } from "./locales/en.ts";

export type LocaleCode = "en" | "fr" | "zh-CN";
export type LanguagePreference = "auto" | LocaleCode;

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en;
    };
  }
}
