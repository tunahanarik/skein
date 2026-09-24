/**
 * Language: English by default, Turkish on request. The choice is a UI preference kept in
 * localStorage (not personal data); storage failures are ignored.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setLocale } from "../format";
import { en, tr, type StringKey } from "./strings";

export type Lang = "en" | "tr";
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "tr", label: "Türkçe" },
];
const DICTS: Record<Lang, Record<StringKey, string>> = { en, tr };
const STORAGE_KEY = "waypoint.lang";

export function translate(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "en" || v === "tr") return v;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

type T = (key: StringKey, vars?: Record<string, string | number>) => string;
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: T } | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  setLocale(lang === "tr" ? "tr-TR" : "en-US");
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(() => ({ lang, setLang, t: ((k, v) => translate(lang, k, v)) as T }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

export type { StringKey };
