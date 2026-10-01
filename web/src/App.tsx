import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { shortAddr } from "./format";
import { I18nProvider, LANGS, useI18n, type Lang } from "./i18n";
import { AboutPage } from "./pages/About";
import { AssetPage } from "./pages/Asset";
import { BridgePage } from "./pages/Bridge";
import { ComparePage } from "./pages/Compare";
import { CoveragePage } from "./pages/Coverage";
import { MarketsPage } from "./pages/Markets";
import { TerminalPage } from "./pages/Terminal";
import { TrackedPage } from "./pages/Tracked";
import { Icon, Mark, Wordmark } from "./components/icons";
import { HomePage } from "./pages/Home";
import { WalletPage } from "./pages/Wallet";
import { linkProps, useRoute } from "./router";
import { AlertsProvider } from "./alerts";
import { FiredBanner } from "./components/AlertForm";
import { WalletPicker } from "./components/WalletPicker";
import { QuickProvider, useMarketQuotes, useQuick } from "./components/market";
import { useLive } from "./live";

/** Registry key of WETH, priced at ETH/USD. */
const WETH_KEY = "4663:0x0bd7d308f8e1639fab988df18a8011f41eacad73";
import { useTheme } from "./theme";
import { useWallet, WalletProvider } from "./wallet";

/** Language menu styled like the rest of the site (a native <select> list cannot be themed). */
/** English names, shown under each native name so a language can be found by either. */
const LANG_EN: Record<string, string> = { en: "English", tr: "Turkish", de: "German", fr: "French", it: "Italian", es: "Spanish", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic", hi: "Hindi" };

/** Language menu: a two-column grid of code badges with native and English names; arrows move, Enter picks. */
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
  // Two columns: left/right move by one, up/down by a row.
  const move = (e: ReactKeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (!step) return;
    e.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[Math.min(items.length - 1, Math.max(0, i + step))]?.focus();
  };
  return (
    <div className="lang-menu" ref={ref}>
      <button className="lang" aria-haspopup="listbox" aria-expanded={open} aria-label={t("shell.language")} onClick={() => setOpen(!open)}>
        <Icon name="globe" size={16} />
        <span className="cur">{current.code.toUpperCase()}</span>
        <Icon name="chevron" size={14} className="chev" />
      </button>
      {open && (
        <div className="lang-pop lp2" role="dialog" aria-label={t("shell.language")}>
          <div className="lp-head">
            <Icon name="globe" size={14} />
            <span>{t("shell.language")}</span>
            <span className="spacer" />
            <span className="lp-n">{LANGS.length}</span>
          </div>
          <div className="lp-grid" role="listbox" aria-label={t("shell.language")} ref={listRef} onKeyDown={move}>
            {LANGS.map((l) => (
              <button
                key={l.code}
                role="option"
                aria-selected={l.code === lang}
                className={l.code === lang ? "on" : undefined}
                onClick={() => {
                  setLang(l.code as Lang);
                  setOpen(false);
                }}
              >
                <span className="lp-code">{l.code.toUpperCase()}</span>
                <span className="lp-names">
                  <span className="lp-native" lang={l.code} dir={l.rtl ? "rtl" : undefined}>
                    {l.label}
                  </span>
                  <span className="lp-en">{LANG_EN[l.code]}</span>
                </span>
                {l.code === lang && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
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

/** Thin icon rail on the left (a bottom tab bar on phones). */
function Rail() {
  const { t } = useI18n();
  const route = useRoute();
  const on = (...n: string[]) => (n.includes(route.name) ? " on" : "");
  return (
    <aside className="rail" aria-label="Main">
      <a className="rail-brand" {...linkProps("/")} aria-label="Skein">
        <Mark size={30} />
      </a>
      <nav className="rail-nav">
        <a className={`rail-i${on("home", "asset")}`} {...linkProps("/")} aria-current={on("home", "asset") ? "page" : undefined}>
          <Icon name="home" size={21} />
          <span>{t("nav.home")}</span>
        </a>
        <a className={`rail-i${on("terminal")}`} {...linkProps("/terminal")} aria-current={on("terminal") ? "page" : undefined}>
          <Icon name="terminal" size={21} />
          <span>{t("nav.terminal")}</span>
        </a>
        <a className={`rail-i${on("markets", "coverage")}`} {...linkProps("/markets")} aria-current={on("markets", "coverage") ? "page" : undefined}>
          <Icon name="chart" size={21} />
          <span>{t("nav.markets")}</span>
        </a>
        <a className={`rail-i${on("wallet")}`} {...linkProps("/wallet")} aria-current={on("wallet") ? "page" : undefined}>
          <Icon name="wallet" size={21} />
          <span>{t("nav.portfolio")}</span>
        </a>
        <a className={`rail-i${on("tracked")}`} {...linkProps("/tracked")} aria-current={on("tracked") ? "page" : undefined}>
          <Icon name="eye" size={21} />
          <span>{t("nav.tracked")}</span>
        </a>
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

/** Where you are: "skein/ <page>" (the asset symbol on asset pages). */
function Breadcrumb() {
  const { t } = useI18n();
  const route = useRoute();
  const here = route.name === "asset" ? route.ref.toUpperCase() : t(`title.${route.name}`).toLowerCase();
  return (
    <nav className="crumb" aria-label="Breadcrumb">
      <a {...linkProps("/")}>
        skein<span className="sl">/</span>
      </a>
      {route.name !== "home" && <span className="here">{here}</span>}
    </nav>
  );
}

/** Live chain pulse: connection, latest block, ETH price and today's change. */
function ChainPulse() {
  const { t } = useI18n();
  const live = useLive({});
  const quotes = useMarketQuotes();
  const eth = quotes?.get(WETH_KEY);
  return (
    <div className="pulse" aria-label={t("shell.pulse")}>
      <span className={`pd${live.connected ? " on" : ""}`} title={live.connected ? t("home.cmd.live") : ""}>
        ●
      </span>
      {live.block && (
        <span className="pb">
          <span className="k">{t("home.cmd.block")}</span> {Number(live.block).toLocaleString("en-US")}
        </span>
      )}
      {eth?.usd != null && (
        <span className="pe">
          <span className="k">ETH</span> ${Math.round(eth.usd).toLocaleString("en-US")}
          {eth.changePct != null && <span className={eth.changePct >= 0 ? "up" : "down"}>{` ${eth.changePct >= 0 ? "+" : ""}${eth.changePct.toFixed(2)}%`}</span>}
        </span>
      )}
    </div>
  );
}

function Header() {
  const { t } = useI18n();
  const w = useWallet();
  const route = useRoute();
  const quick = useQuick();
  const from = route.name === "asset" ? route.ref : undefined;
  return (
    <header className="top">
      <a className="brand top-brand" {...linkProps("/")} aria-label="Skein">
        <Mark size={30} />
      </a>
      <Breadcrumb />
      <div className="hq">
        <button type="button" onClick={() => quick.open("swap", from)}>
          <Icon name="swap" size={14} /> {t("quick.swap")}
        </button>
        <button type="button" onClick={() => quick.open("bridge")}>
          <Icon name="bridge" size={14} /> {t("quick.bridge")}
        </button>
        {route.name !== "terminal" && (
          <a {...linkProps("/terminal")}>
            <Icon name="terminal" size={14} /> {t("nav.terminal")}
          </a>
        )}
        <span className="hq-pro" aria-disabled="true" title={t("nav.proSoon")}>
          <Icon name="spark" size={14} /> PRO <span className="soon-tag">{t("nav.soon")}</span>
        </span>
      </div>
      <span className="spacer" />
      <ChainPulse />
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
            <Wordmark />
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
    case "terminal":
      return <TerminalPage />;
    case "tracked":
      return <TrackedPage />;
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
