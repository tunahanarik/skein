/** Web UI dictionaries: complete, consistent placeholders, neutral wording. */
import { describe, expect, it } from "vitest";
import { en, tr } from "../../web/src/i18n/strings.js";
import { ar } from "../../web/src/i18n/locales/ar.js";
import { de } from "../../web/src/i18n/locales/de.js";
import { es } from "../../web/src/i18n/locales/es.js";
import { fr } from "../../web/src/i18n/locales/fr.js";
import { hi } from "../../web/src/i18n/locales/hi.js";
import { it as itDict } from "../../web/src/i18n/locales/it.js";
import { ja } from "../../web/src/i18n/locales/ja.js";
import { ko } from "../../web/src/i18n/locales/ko.js";
import { pt } from "../../web/src/i18n/locales/pt.js";
import { ru } from "../../web/src/i18n/locales/ru.js";
import { zh } from "../../web/src/i18n/locales/zh.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const ALL: Record<string, Record<string, string>> = { tr, de, fr, it: itDict, es, pt, ru, zh, ja, ko, ar, hi };
/** Names that must never be translated. */
const KEEP = ["Waypoint", "Robinhood", "USDG", "Uniswap", "Morpho", "Pendle", "Chainlink", "Blockscout"];

describe("i18n dictionaries", () => {
  for (const [code, dict] of Object.entries(ALL)) {
    it(`${code}: exactly the English keys, same placeholders, nothing empty, names kept`, () => {
      expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[]) {
        expect([k, placeholders(dict[k]!)]).toEqual([k, placeholders(en[k])]);
        expect(dict[k]!.trim().length).toBeGreaterThan(0);
        for (const name of KEEP) if (en[k].includes(name)) expect([k, dict[k]!.includes(name)]).toEqual([k, true]);
      }
    });
  }

  it("no promotional or safety claims in English and Turkish (negations allowed)", () => {
    const EN = /\bbest\b|safest|\bsafe\b|(?<!not[ _]|not a |no )guaranteed|risk[ -]?free|(?<!not a |not )recommended/i;
    const clean = (v: string) => v.replace(/“[^”]*”/g, "").replace(/signed or recommended/, "");
    for (const [k, v] of Object.entries(en)) expect([k, EN.test(clean(v))]).toEqual([k, false]);
    const TR = /en iyi|güvenli|risksiz|garantili|önerilen(?! bir tutar değildir)/i;
    for (const [k, v] of Object.entries(tr)) expect([k, TR.test(clean(v))]).toEqual([k, false]);
  });
});
