/**
 * UI text. The site is English only; every string lives in ./strings.ts and pages read it through
 * `t()`, so wording stays in one place and placeholders are filled consistently.
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { en, type StringKey } from "./strings";

type Vars = Record<string, string | number>;

export function translate(key: StringKey, vars?: Vars): string {
  const s = en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

type T = (key: StringKey, vars?: Vars) => string;
const Ctx = createContext<{ t: T } | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = "en";
  }, []);
  const value = useMemo(() => ({ t: translate as T }), []);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error("I18nProvider missing");
  return v;
}

export type { StringKey };
