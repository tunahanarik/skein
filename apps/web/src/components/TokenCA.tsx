import { useEffect, useState } from "react";
import { EXPLORER, shortAddr } from "../format";
import { useI18n } from "../i18n";
import { SKN } from "../token";
import { Icon } from "./icons";

const TOKEN_URL = `${EXPLORER}/token/${SKN.address}`;

/** Clipboard API first; in-app browsers (X, Telegram) that refuse it still allow the older selection copy. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/** Copies the $SKN contract address; `done` stays true for a moment so the button can say so. */
function useCopy(): [boolean, () => void] {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(id);
  }, [done]);
  const copy = () => {
    void writeClipboard(SKN.address).then((ok) => ok && setDone(true));
  };
  return [done, copy];
}

function CopyButton({ className }: { className: string }) {
  const { t } = useI18n();
  const [done, copy] = useCopy();
  const label = done ? t("ca.copied") : t("ca.copy");
  return (
    <button type="button" className={`${className}${done ? " done" : ""}`} onClick={copy} aria-label={label} title={label}>
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}

/** Header chip: "$SKN 0x825b…b5ea" with a copy button (the address is hidden on phones). */
export function TokenChip() {
  const { t } = useI18n();
  return (
    <span className="ca" title={t("ca.title", { s: SKN.symbol })}>
      <a className="ca-sym" href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
        ${SKN.symbol}
      </a>
      <span className="ca-addr">{shortAddr(SKN.address)}</span>
      <CopyButton className="ca-copy" />
    </span>
  );
}

/** Footer line with the full address, a copy button and the explorer link. */
export function TokenLine() {
  const { t } = useI18n();
  return (
    <div className="ca-line">
      <span className="cap-label">{t("ca.label", { s: SKN.symbol })}</span>
      <code>{SKN.address}</code>
      <CopyButton className="ca-copy" />
      <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
        {t("misc.explorer")} ↗
      </a>
    </div>
  );
}
