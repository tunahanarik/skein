import { useId, useMemo, useState } from "react";
import { navigate } from "../router";
import { useI18n } from "../i18n";
import { code } from "../text";
import { Avatar, useAssetList } from "./common";

/** Symbol / name / address search over the canonical registry. Opens the asset page. */
export function AssetSearch({ autoFocus }: { autoFocus?: boolean }) {
  const { t } = useI18n();
  const list = useAssetList();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const id = useId();
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !list) return [];
    const score = (a: (typeof list)[number]) => {
      const sym = a.symbol.toLowerCase();
      if (sym === s) return 0;
      if (a.address.toLowerCase() === s) return 0;
      if (sym.startsWith(s)) return 1;
      if (a.name.toLowerCase().startsWith(s)) return 2;
      if (a.name.toLowerCase().includes(s)) return 3;
      return 9;
    };
    return list
      .map((a) => [score(a), a] as const)
      .filter(([sc]) => sc < 9)
      .sort((x, y) => x[0] - y[0] || x[1].symbol.localeCompare(y[1].symbol))
      .slice(0, 8)
      .map(([, a]) => a);
  }, [q, list]);

  // Symbols are display-only; a duplicated symbol is opened by address.
  const refOf = (a: { symbol: string; address: string }) => ((list ?? []).filter((x) => x.symbol === a.symbol).length > 1 ? a.address : a.symbol);
  const go = (ref: string) => {
    setOpen(false);
    setQ("");
    navigate(`/asset/${encodeURIComponent(ref)}`);
  };

  return (
    <div className="search">
      <label htmlFor={id} className="sr-only">
        {t("search.label")}
      </label>
      <input
        id={id}
        className="input"
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={t("search.placeholder")}
        value={q}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={`${id}-list`}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, results.length - 1));
          else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
          else if (e.key === "Enter") {
            const r = results[sel];
            if (r) go(refOf(r));
            else if (/^0x[0-9a-fA-F]{40}$/.test(q.trim())) go(q.trim());
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && results.length > 0 && (
        <div className="panel results" id={`${id}-list`} role="listbox">
          {results.map((a, i) => (
            <div key={a.key} className="result" role="option" aria-selected={i === sel} onMouseDown={() => go(refOf(a))} onMouseEnter={() => setSel(i)}>
              <Avatar symbol={a.symbol} address={a.address} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{a.symbol}</div>
                <div className="small muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.name}
                </div>
              </div>
              <span className="spacer" />
              <span className="tag">{code(t, "type", a.type)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
