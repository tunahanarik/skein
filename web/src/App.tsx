import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { shortAddr } from "./format";
import { I18nProvider, LANGS, useI18n, type Lang } from "./i18n";
import { AboutPage } from "./pages/About";
import { AssetPage } from "./pages/Asset";
import { BridgePage } from "./pages/Bridge";
import { ComparePage } from "./pages/Compare";
import { CoveragePage } from "./pages/Coverage";
import { MarketsPage } from "./pages/Markets";
import { Icon, Mark } from "./components/icons";
import { HomePage } from "./pages/Home";
import { WalletPage } from "./pages/Wallet";
import { linkProps, navigate, useRoute } from "./router";
import { AlertsProvider } from "./alerts";
import { FiredBanner } from "./components/AlertForm";
import { WalletPicker } from "./components/WalletPicker";
import { QuickProvider, useQuick } from "./components/market";
import { Avatar, useAssetList } from "./components/common";
import type { AssetListItem } from "./api";
import { useTheme } from "./theme";
import { useWallet, WalletProvider } from "./wallet";

/** Language menu styled like the rest of the site (a native <select> list cannot be themed). */
function LanguagePicker() {
  const { lang, setLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0]!;
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const move = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className="lang-menu" ref={ref}>
      <button className="lang" aria-haspopup="listbox" aria-expanded={open} aria-label={t("shell.language")} onClick={() => setOpen(!open)}>
        <Icon name="globe" size={16} />
        <span className="cur">{current.label}</span>
        <Icon name="chevron" size={14} className="chev" />
      </button>
      {open && (
        <div className="lang-pop" role="listbox" aria-label={t("shell.language")} ref={listRef} onKeyDown={move}>
          {LANGS.map((l) => (
            <button
              key={l.code}
              role="option"
              aria-selected={l.code === lang}
              lang={l.code}
              dir={l.rtl ? "rtl" : undefined}
              onClick={() => {
                setLang(l.code as Lang);
                setOpen(false);
              }}
            >
              <span>{l.label}</span>
              {l.code === lang && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? t("theme.toLight") : t("theme.toDark");
  return (
    <button className="icon-btn" onClick={toggle} aria-label={label} title={label}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
    </button>
  );
}

/** Search one box for an asset (symbol, name or contract) or a wallet address to view. */
function GlobalSearch() {
  const { t } = useI18n();
  const list = useAssetList();
  const w = useWallet();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const s = q.trim().toLowerCase();
  const isAddr = /^0x[0-9a-f]{40}$/.test(s);
  // Exact symbol, then symbol prefix, then name prefix, then a word of the name.
  const rank = (a: AssetListItem) => {
    const sym = a.symbol.toLowerCase();
    const name = a.name.toLowerCase();
    return sym === s || a.address.toLowerCase() === s ? 0 : sym.startsWith(s) ? 1 : name.startsWith(s) ? 2 : name.split(/[\s.,]+/).some((x) => x.startsWith(s)) ? 3 : 9;
  };
  const hits = !s || !list ? [] : list.filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol)).slice(0, 8);
  const walletRow = isAddr && !hits.length;
  const go = (i: number) => {
    const a = hits[i];
    if (a) navigate(`/asset/${encodeURIComponent(a.symbol)}`);
    else if (walletRow && w.usePasted(q.trim())) navigate("/wallet");
    else return;
    setQ("");
    setOpen(false);
  };
  return (
    <div className="gsearch" ref={ref}>
      <Icon name="search" size={18} />
      <input
        placeholder={t("shell.searchAll")}
        aria-label={t("search.label")}
        value={q}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => (setQ(e.target.value.slice(0, 100)), setOpen(true), setHi(0))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, Math.max(0, hits.length - 1))));
          else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
          else if (e.key === "Enter") go(hi);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && s && (
        <div className="gs-pop" role="listbox">
          {hits.map((a, i) => (
            <button key={a.key} role="option" aria-selected={i === hi} className={i === hi ? "on" : undefined} onMouseEnter={() => setHi(i)} onClick={() => go(i)}>
              <Avatar symbol={a.symbol} address={a.address} />
              <span className="s">{a.symbol}</span>
              <span className="n">{a.name.replace(/\s*•\s*Robinhood Token$/i, "")}</span>
            </button>
          ))}
          {walletRow && (
            <button role="option" aria-selected className="on" onClick={() => go(0)}>
              <Icon name="wallet" size={18} />
              <span className="s">{t("shell.viewWallet")}</span>
              <span className="n mono">{shortAddr(q.trim())}</span>
            </button>
          )}
          {!hits.length && !walletRow && <div className="muted small" style={{ padding: 10 }}>{t("markets.empty")}</div>}
        </div>
      )}
    </div>
  );
}

/** Thin icon rail on the left (a bottom tab bar on phones). */
function Rail() {
  const { t } = useI18n();
  const route = useRoute();
  const quick = useQuick();
  const from = route.name === "asset" ? route.ref : undefined;
  const on = (...n: string[]) => (n.includes(route.name) ? " on" : "");
  return (
    <aside className="rail" aria-label="Main">
      <a className="rail-brand" {...linkProps("/")} aria-label="Skein">
        <Mark size={24} />
      </a>
      <nav className="rail-nav">
        <a className={`rail-i${on("home", "asset")}`} {...linkProps("/")} aria-current={on("home", "asset") ? "page" : undefined}>
          <Icon name="home" size={21} />
          <span>{t("nav.opps")}</span>
        </a>
        <a className={`rail-i${on("markets", "coverage")}`} {...linkProps("/markets")} aria-current={on("markets", "coverage") ? "page" : undefined}>
          <Icon name="chart" size={21} />
          <span>{t("nav.markets")}</span>
        </a>
        <a className={`rail-i${on("wallet")}`} {...linkProps("/wallet")} aria-current={on("wallet") ? "page" : undefined}>
          <Icon name="wallet" size={21} />
          <span>{t("nav.portfolio")}</span>
        </a>
        <button className="rail-i" onClick={() => quick.open("swap", from)}>
          <Icon name="swap" size={21} />
          <span>{t("quick.swap")}</span>
        </button>
        <button className={`rail-i${on("bridge")}`} onClick={() => quick.open("bridge")}>
          <Icon name="bridge" size={21} />
          <span>{t("quick.bridge")}</span>
        </button>
        <span className="rail-i soon" aria-disabled="true" title={t("nav.rewardsSoon")}>
          <Icon name="gift" size={21} />
          <span>{t("nav.rewards")}</span>
          <span className="soon-tag">{t("nav.soon")}</span>
        </span>
      </nav>
      <div className="rail-foot">
        <ThemeToggle />
      </div>
    </aside>
  );
}

function Header() {
  const { t } = useI18n();
  const w = useWallet();
  return (
    <header className="top">
      <a className="brand top-brand" {...linkProps("/")} aria-label="Skein">
        <Mark size={20} />
        <span>skein</span>
      </a>
      <GlobalSearch />
      <span className="spacer" />
      <LanguagePicker />
      {w.address && w.source === "connected" ? (
        <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
          <a className="pill" {...linkProps("/wallet")} title={w.wallet ? `${w.wallet.name} · ${t("shell.viewing")}` : t("shell.viewing")}>
            {w.wallet?.icon ? <img src={w.wallet.icon} alt="" width={16} height={16} /> : <Icon name="wallet" size={16} />}
            {shortAddr(w.address)}
          </a>
          <button className="icon-btn" onClick={w.clear} title={t("shell.disconnect")} aria-label={t("shell.disconnect")}>
            <Icon name="logout" size={17} />
          </button>
        </span>
      ) : (
        <button className="btn small primary round" onClick={w.openPicker} title={t("shell.readOnlyTitle")}>
          {t("shell.connect")}
        </button>
      )}
    </header>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="bottom">
      <div className="shell">
        <div className="row" style={{ gap: 18, marginBottom: 12 }}>
          <span className="brand small">
            <Mark size={16} />
            <span>skein</span>
          </span>
          <span className="cap-label">Explore · Track · Discover</span>
          <span className="spacer" />
          <a {...linkProps("/bridge")}>{t("nav.bridge")}</a>
          <a {...linkProps("/coverage")}>{t("nav.coverage")}</a>
          <a {...linkProps("/compare")}>{t("nav.compare")}</a>
          <a {...linkProps("/about")}>{t("nav.about")}</a>
        </div>
        <p>{t("footer.p1")}</p>
        <p>{t("footer.p2")}</p>
      </div>
    </footer>
  );
}

function Page() {
  const { t } = useI18n();
  const route = useRoute();
  useEffect(() => {
    const title = route.name === "asset" ? route.ref.slice(0, 16) : t(`title.${route.name}`);
    document.title = `${title} · Skein`;
  }, [route, t]);
  switch (route.name) {
    case "home":
      return <HomePage />;
    case "asset":
      return <AssetPage key={route.ref} assetRef={route.ref} />;
    case "wallet":
      return <WalletPage />;
    case "bridge":
      return <BridgePage />;
    case "coverage":
      return <CoveragePage />;
    case "markets":
      return <MarketsPage />;
    case "about":
      return <AboutPage />;
    case "compare":
      return <ComparePage />;
    default:
      return (
        <div className="empty">
          <h1>{t("notFound.title")}</h1>
          <p>
            <a {...linkProps("/")}>{t("notFound.back")}</a>
          </p>
        </div>
      );
  }
}

export function App() {
  return (
    <I18nProvider>
      <WalletProvider>
        <AlertsProvider>
          <QuickProvider>
            <div className="app">
              <Rail />
              <div className="app-main">
                <Header />
                <main>
                  <div className="shell wide">
                    <FiredBanner />
                    <Page />
                  </div>
                </main>
                <Footer />
              </div>
            </div>
            <WalletPicker />
          </QuickProvider>
        </AlertsProvider>
      </WalletProvider>
    </I18nProvider>
  );
}
