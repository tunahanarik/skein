/** Web UI text (English only): no dashes in what people read, neutral wording, read only. */
import { describe, expect, it } from "vitest";
import { en } from "./strings.js";

describe("UI strings", () => {
  it("no hyphens or dashes in any UI text (house style); ticker symbols and placeholders excepted", () => {
    const strip = (v: string) => v.replace(/\{[^}]*\}/g, "").replace(/https?:\/\/\S+/g, "");
    for (const [k, v] of Object.entries(en)) {
      const s = strip(v);
      expect([k, /[–—]/.test(s) || /(?<=[^\W\d_])-(?=[^\W\d_])/u.test(s)]).toEqual([k, false]);
    }
  });

  it("no promotional or safety claims (negations allowed)", () => {
    const EN = /\bbest\b|safest|\bsafe\b|(?<!not[ _]|not a |no )guaranteed|risk[ -]?free|(?<!not a |not )recommended/i;
    const clean = (v: string) => v.replace(/“[^”]*”/g, "").replace(/signed or recommended/, "");
    for (const [k, v] of Object.entries(en)) expect([k, EN.test(clean(v))]).toEqual([k, false]);
  });

  it("nothing offers to swap, bridge or send a transaction from Skein (read only)", () => {
    const ACTION = /swap button|swaps are built|swap transactions|bridge here|transaction is sent|can be made from the app/i;
    for (const [k, v] of Object.entries(en)) expect([k, ACTION.test(v)]).toEqual([k, false]);
  });
});
