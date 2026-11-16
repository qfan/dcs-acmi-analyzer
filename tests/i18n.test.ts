import { afterEach, describe, expect, it } from "vitest";
import i18n, {
  getLanguagePreference,
  LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
  setLanguagePreference,
} from "../src/i18n/index.ts";
import { en } from "../src/i18n/locales/en.ts";
import { fr } from "../src/i18n/locales/fr.ts";
import { zhCN } from "../src/i18n/locales/zh-CN.ts";

function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...collectKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe("i18n locales and configuration", () => {
  afterEach(() => {
    setLanguagePreference("auto");
  });

  it("keeps en, fr, and zh-CN translation keys in 100% parity", () => {
    const enKeys = collectKeys(en);
    const frKeys = collectKeys(fr);
    const zhKeys = collectKeys(zhCN);

    expect(frKeys).toEqual(enKeys);
    expect(zhKeys).toEqual(enKeys);
  });

  it("normalizes browser language tags to supported locales", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("fr")).toBe("fr");
    expect(normalizeLanguage("fr-CA")).toBe("fr");
    expect(normalizeLanguage("zh")).toBe("zh-CN");
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeLanguage("zh-SG")).toBe("zh-CN");
    expect(normalizeLanguage("ja-JP")).toBe("en");
    expect(normalizeLanguage(null)).toBe("en");
  });

  it("supports auto-detect and forcing a language via preference API", () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    };
    Object.defineProperty(globalThis, "localStorage", { value: mockStorage, configurable: true });

    expect(getLanguagePreference()).toBe("auto");

    setLanguagePreference("fr");
    expect(store.get(LANGUAGE_STORAGE_KEY)).toBe("fr");
    expect(getLanguagePreference()).toBe("fr");
    expect(i18n.resolvedLanguage).toBe("fr");
    expect(i18n.t("viewer.openFile")).toBe("Ouvrir un fichier…");

    setLanguagePreference("zh-CN");
    expect(store.get(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
    expect(getLanguagePreference()).toBe("zh-CN");
    expect(i18n.resolvedLanguage).toBe("zh-CN");
    expect(i18n.t("viewer.openFile")).toBe("打开文件…");

    setLanguagePreference("auto");
    expect(store.has(LANGUAGE_STORAGE_KEY)).toBe(false);
    expect(getLanguagePreference()).toBe("auto");
  });
});
