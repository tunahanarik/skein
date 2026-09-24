/**
 * Display sanitization for strings read from contracts or third-party APIs. Token metadata is
 * attacker-controlled (anyone can deploy a token), so a symbol is reduced to a conservative
 * character set; everything else is dropped, never interpreted.
 */
import { sanitizeLabel } from "../registry/robinhoodRegistry.js";

/** Letters, digits, space and . _ - + / ( ) only; control/bidi characters removed; bounded. */
export function sanitizeSymbol(s: string | null | undefined, max = 32): string {
  return sanitizeLabel(s ?? "", 200)
    .replace(/[^A-Za-z0-9 ._\-+/()]/g, "")
    .trim()
    .slice(0, max);
}
