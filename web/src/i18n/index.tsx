/**
 * Languages: English (default) plus Turkish bundled; every other language is a separate chunk
 * loaded when chosen (keeps the first load small). The choice is a UI preference kept in
 * localStorage (not personal data); storage failures are ignored. Arabic renders right-to-left.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setLocale } from "../format";
import { en, tr, type StringKey } from "./strings";

export type Lang = "en" | "tr" | "de" | "fr" | "it" | "es" | "pt" | "ru" | "zh" | "ja" | "ko" | "ar" | "hi";

/** Native names; `locale` drives number/date formatting (Latin digits everywhere for amounts). */
export const LANGS: { code: Lang; label: string; locale: string; rtl?: boolean }[] = [
  { code: "en", label: "English", locale: "en-US" },
  { code: "tr", label: "Türkçe", locale: "tr-TR" },
  { code: "de", label: "Deutsch", locale: "de-DE" },
  { code: "fr", label: "Français", locale: "fr-FR" },
  { code: "it", label: "Italiano", locale: "it-IT" },
  { code: "es", label: "Español", locale: "es-ES" },
  { code: "pt", label: "Português", locale: "pt-BR" },
  { code: "ru", label: "Русский", locale: "ru-RU" },
  { code: "zh", label: "中文", locale: "zh-CN" },
  { code: "ja", label: "日本語", locale: "ja-JP" },
  { code: "ko", label: "한국어", locale: "ko-KR" },
  { code: "ar", label: "العربية", locale: "ar-u-nu-latn", rtl: true },
  { code: "hi", label: "हिन्दी", locale: "hi-IN-u-nu-latn" },
];
const CODES = new Set<string>(LANGS.map((l) => l.code));
type Dict = Record<StringKey, string>;

/** Lazy loaders (Vite splits each into its own chunk). */
const LOADERS: Partial<Record<Lang, () => Promise<Dict>>> = {
  de: () => import("./locales/de").then((m) => m.de),
  fr: () => import("./locales/fr").then((m) => m.fr),
  it: () => import("./locales/it").then((m) => m.it),
  es: () => import("./locales/es").then((m) => m.es),
  pt: () => import("./locales/pt").then((m) => m.pt),
  ru: () => import("./locales/ru").then((m) => m.ru),
  zh: () => import("./locales/zh").then((m) => m.zh),
  ja: () => import("./locales/ja").then((m) => m.ja),
  ko: () => import("./locales/ko").then((m) => m.ko),
  ar: () => import("./locales/ar").then((m) => m.ar),
  hi: () => import("./locales/hi").then((m) => m.hi),
};
const loaded: Partial<Record<Lang, Dict>> = { en, tr };
const STORAGE_KEY = "skein.lang";

export function translate(dict: Dict, key: StringKey, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && CODES.has(v)) return v as Lang;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

type T = (key: StringKey, vars?: Record<string, string | number>) => string;
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T; loading: boolean } | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [dict, setDict] = useState<Dict>(() => loaded[initialLang()] ?? en);
  const [loading, setLoading] = useState(false);
  const meta = LANGS.find((l) => l.code === lang)!;
  setLocale(meta.locale);

  // Load the chosen language (English is shown until it arrives).
  useEffect(() => {
    let live = true;
    const have = loaded[lang];
    if (have) {
      setDict(have);
      return;
    }
    setLoading(true);
    LOADERS[lang]?.()
      .then((d) => {
        loaded[lang] = d;
        if (live) setDict(d);
      })
      .catch(() => live && setDict(en))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.rtl ? "rtl" : "ltr";
  }, [lang, meta.rtl]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ lang, setLang, t: ((k, v) => translate(dict, k, v)) as T, loading }), [lang, setLang, dict, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

export type { StringKey };
