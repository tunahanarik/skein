/** Web UI dictionaries: complete, consistent placeholders, neutral wording in both languages. */
import { describe, expect, it } from "vitest";
import { en, tr } from "../../web/src/i18n/strings.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n dictionaries", () => {
  it("Turkish has exactly the English keys, with the same placeholders", () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect([k, placeholders(tr[k])]).toEqual([k, placeholders(en[k])]);
      expect(tr[k].trim().length).toBeGreaterThan(0);
    }
  });

  it("no promotional or safety claims (negations allowed)", () => {
    const EN = /\bbest\b|safest|\bsafe\b|(?<!not[ _]|not a |no )guaranteed|risk[ -]?free|(?<!not a |not )recommended/i;
    // Quoted terms (There is no “best”) and "Nothing … is executed, signed or recommended" are negations.
    const clean = (v: string) => v.replace(/“[^”]*”/g, "").replace(/signed or recommended/, "");
    for (const [k, v] of Object.entries(en)) expect([k, EN.test(clean(v))]).toEqual([k, false]);
    // Turkish: "en iyi", "güvenli", "risksiz", "önerilen" only with a negation ("değil", "edilmez").
    const TR = /en iyi\b(?!”)|güvenli|risksiz|garantili|(?<!“)önerilen(?! bir tutar değildir)/i;
    for (const [k, v] of Object.entries(tr)) expect([k, TR.test(clean(v))]).toEqual([k, false]);
  });
});
