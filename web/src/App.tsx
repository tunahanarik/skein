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
import { linkProps, useRoute } from "./router";
import { AlertsProvider } from "./alerts";
import { FiredBanner } from "./components/AlertForm";
import { WalletPicker } from "./components/WalletPicker";
import { QuickProvider, Ticker, useQuick } from "./components/market";
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

function Header() {
  const { t } = useI18n();
  const route = useRoute();
  const w = useWallet();
  const quick = useQuick();
  const is = (...n: string[]) => (n.includes(route.name) ? "active" : undefined);
  const from = route.name === "asset" ? route.ref : undefined;
  return (
    <header className="top">
      <div className="shell">
        <a className="brand" {...linkProps("/")} aria-label="Hoodmap">
          <Mark size={22} />
          <span>hoodmap</span>
        </a>
        <nav className="main" aria-label="Main">
          <a className={is("home", "asset")} {...linkProps("/")}>
            {t("nav.opps")}
          </a>
          <a className={is("markets", "coverage")} {...linkProps("/markets")}>
            {t("nav.markets")}
          </a>
          <a className={is("wallet")} {...linkProps("/wallet")}>
            {t("nav.portfolio")}
          </a>
        </nav>
        <span className="spacer" />
        <div className="quick-actions">
          <button className="qa" onClick={() => quick.open("swap", from)}>
            {t("quick.swap")}
          </button>
          <button className={`qa${route.name === "bridge" ? " on" : ""}`} onClick={() => quick.open("bridge")}>
            {t("quick.bridge")}
          </button>
        </div>
        <ThemeToggle />
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
      </div>
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
            <span>hoodmap</span>
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
    document.title = `${title} · Hoodmap`;
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
          <Header />
          <Ticker />
          <main>
            <div className="shell">
              <FiredBanner />
              <Page />
            </div>
          </main>
          <Footer />
          <WalletPicker />
          </QuickProvider>
        </AlertsProvider>
      </WalletProvider>
    </I18nProvider>
  );
}
